'use strict';
// Acceso a los binarios de FFmpeg/FFprobe incluidos con la app y análisis de archivos.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Dentro de un paquete .asar los binarios viven en app.asar.unpacked.
function unpackedPath(p) {
  return p ? p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1') : p;
}

let bins = null;
function binaries() {
  if (!bins) {
    bins = {
      ffmpeg: process.env.NANO_FFMPEG || unpackedPath(require('ffmpeg-static')),
      ffprobe: process.env.NANO_FFPROBE || unpackedPath(require('@ffprobe-installer/ffprobe').path),
    };
  }
  return bins;
}

/** Ejecuta un binario y devuelve { code, stdout (Buffer), stderr (string) }. */
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outLen = 0;
    let err = '';
    const max = opts.maxBuffer || 256 * 1024 * 1024;
    child.stdout.on('data', (c) => {
      if (opts.onStdout) opts.onStdout(c);
      else {
        outLen += c.length;
        if (outLen <= max) out.push(c);
      }
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      err += s;
      if (err.length > 20000) err = err.slice(-20000);
      if (opts.onStderr) opts.onStderr(s);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr: err }));
    if (opts.register) opts.register(child);
  });
}

let capsPromise = null;
/** Filtros y codificadores disponibles en el FFmpeg incluido. */
function capabilities() {
  if (!capsPromise) {
    capsPromise = (async () => {
      const { ffmpeg } = binaries();
      const names = (text) => {
        const set = new Set();
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*[A-Z.|]{2,8}\s+([a-z0-9_]+)\s/i.exec(line);
          if (m) set.add(m[1]);
        }
        return set;
      };
      const [f, e, v] = await Promise.all([
        run(ffmpeg, ['-hide_banner', '-filters']),
        run(ffmpeg, ['-hide_banner', '-encoders']),
        run(ffmpeg, ['-hide_banner', '-version']),
      ]);
      const version = (/ffmpeg version (\S+)/.exec(v.stdout.toString('utf8')) || [])[1] || '?';
      return { filters: names(f.stdout.toString('utf8')), encoders: names(e.stdout.toString('utf8')), version };
    })();
  }
  return capsPromise;
}

const BROWSER_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.jfif', '.webp', '.bmp', '.avif']);
const IMAGE_EXT = new Set([...BROWSER_IMAGE_EXT, '.tif', '.tiff', '.tga', '.heic', '.heif', '.jp2', '.dds', '.exr', '.psd']);

// Códecs que el motor de vista previa (Chromium) reproduce de forma nativa.
const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const NATIVE_PCM = new Set(['pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']);

function parseRatio(s) {
  if (!s) return 0;
  const [a, b] = String(s).split('/').map(Number);
  if (b === undefined) return Number.isFinite(a) ? a : 0;
  if (!b) return 0;
  return a / b;
}

function rotationOf(stream) {
  let rot = 0;
  if (stream.tags && stream.tags.rotate) rot = Number(stream.tags.rotate) || 0;
  for (const sd of stream.side_data_list || []) {
    if (sd.rotation !== undefined && sd.rotation !== null) rot = Number(sd.rotation) || 0;
  }
  rot = ((Math.round(rot) % 360) + 360) % 360;
  return rot;
}

function bitDepthOf(stream) {
  const m = /(?:p|gray|a)(\d\d)(?:le|be)?$/.exec(stream.pix_fmt || '');
  if (m) return Number(m[1]);
  const raw = Number(stream.bits_per_raw_sample);
  return raw > 0 ? raw : 8;
}

/** Mide la duración decodificando paquetes (para archivos sin duración en cabecera). */
async function measureDuration(file) {
  const { ffmpeg } = binaries();
  let last = 0;
  await run(ffmpeg, ['-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', '0', '-c', 'copy', '-f', 'null', '-'], {
    onStdout: (c) => {
      const all = c.toString('utf8').match(/out_time_(?:us|ms)=(\d+)/g);
      if (all) {
        const v = Number(all[all.length - 1].split('=')[1]) / 1e6;
        if (v > last) last = v;
      }
    },
  });
  return last;
}

/** Analiza un archivo y devuelve la información que necesita el editor. */
async function probe(file) {
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error('No es un archivo');
  const ext = path.extname(file).toLowerCase();
  const base = {
    path: file,
    name: path.basename(file),
    ext,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };

  const { ffprobe } = binaries();
  const res = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  let data = null;
  if (res.code === 0) {
    try {
      data = JSON.parse(res.stdout.toString('utf8'));
    } catch {
      data = null;
    }
  }

  if (IMAGE_EXT.has(ext)) {
    const s = data && (data.streams || []).find((x) => x.codec_type === 'video');
    if (!s && !BROWSER_IMAGE_EXT.has(ext)) throw new Error('No se pudo leer la imagen');
    return {
      ...base,
      type: 'image',
      duration: 0,
      width: s ? s.width : 0,
      height: s ? s.height : 0,
      hasAudio: false,
      hasAlpha: s ? /^(yuva|rgba|bgra|argb|abgr|gbrap|ya|pal8)/.test(s.pix_fmt || '') : true,
      nativeHint: BROWSER_IMAGE_EXT.has(ext),
    };
  }

  if (!data || !data.streams || !data.streams.length) {
    throw new Error('Formato no reconocido');
  }

  const streams = data.streams;
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v && !a) throw new Error('El archivo no contiene video ni audio');

  const format = data.format || {};
  let duration = parseFloat(format.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    const ds = [v, a].filter(Boolean).map((s) => parseFloat(s.duration)).filter((d) => Number.isFinite(d) && d > 0);
    duration = ds.length ? Math.max(...ds) : 0;
  }
  if (!duration) duration = await measureDuration(file);
  if (!duration) throw new Error('No se pudo determinar la duración');

  const container = String(format.format_name || '');
  const containerOk = /(^|,)(mov|mp4|m4a|matroska|webm|ogg|wav|mp3|flac|aac)(,|$)/.test(container);
  const isMp4Family = /(^|,)(mov|mp4|m4a)(,|$)/.test(container);
  const isWav = /(^|,)wav(,|$)/.test(container);

  const info = { ...base, type: v ? 'video' : 'audio', duration, container, bitrate: Number(format.bit_rate) || 0 };

  let videoOk = true;
  if (v) {
    const rotation = rotationOf(v);
    const sar = parseRatio(String(v.sample_aspect_ratio || '1:1').replace(':', '/')) || 1;
    let w = Math.max(2, Math.round((v.width || 0) * sar));
    let h = v.height || 0;
    if (rotation === 90 || rotation === 270) [w, h] = [h, w];
    let fps = parseRatio(v.avg_frame_rate);
    if (!fps || fps > 1000) fps = parseRatio(v.r_frame_rate);
    if (!fps || fps > 1000) fps = 30;
    const bitDepth = bitDepthOf(v);
    const hdr = v.color_transfer === 'smpte2084' || v.color_transfer === 'arib-std-b67';
    const interlaced = ['tt', 'bb', 'tb', 'bt'].includes(v.field_order);
    Object.assign(info, {
      width: w,
      height: h,
      fps,
      rotation,
      videoCodec: v.codec_name,
      videoIndex: v.index,
      pixFmt: v.pix_fmt || '',
      bitDepth,
      hdr,
      interlaced,
      hasAlpha: /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(v.pix_fmt || ''),
      colorSpace: v.color_space && v.color_space !== 'unknown' ? v.color_space : '',
    });
    const is420 = /^yuvj?420p/.test(v.pix_fmt || '');
    videoOk = NATIVE_VIDEO.has(v.codec_name) && !hdr && !interlaced && (v.codec_name !== 'h264' || (is420 && bitDepth === 8));
  }

  let audioOk = true;
  info.hasAudio = !!a;
  if (a) {
    Object.assign(info, {
      audioCodec: a.codec_name,
      audioIndex: a.index,
      channels: a.channels || 2,
      sampleRate: Number(a.sample_rate) || 48000,
    });
    audioOk = NATIVE_AUDIO.has(a.codec_name) || (isWav && NATIVE_PCM.has(a.codec_name));
    if (isMp4Family && a.codec_name === 'vorbis') audioOk = false;
    // El sonido envolvente (5.1, 7.1…) se pasa siempre a estéreo con FFmpeg, igual que al exportar:
    // así la vista previa y el archivo final suenan idénticos.
    if (info.channels > 2) audioOk = false;
  }

  info.nativeHint = containerOk && videoOk && audioOk;
  // La imagen se puede reproducir tal cual aunque el audio no: basta una copia ligera que solo
  // convierte el sonido.
  info.videoNative = !!v && containerOk && videoOk;
  info.mp4Family = isMp4Family;
  return info;
}

module.exports = { binaries, run, probe, capabilities, IMAGE_EXT, BROWSER_IMAGE_EXT };
