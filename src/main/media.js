'use strict';
// Preparación de medios: proxys de vista previa, formas de onda y grabaciones.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { binaries, capabilities } = require('./ffmpeg');

// Conversión HDR (PQ/HLG) -> SDR Rec.709. La vista previa y la exportación usan la misma cadena,
// con los ajustes que el usuario haya elegido para ese archivo (info.tonemap).
const TONEMAP_CURVES = ['hable', 'mobius', 'reinhard', 'clip'];

function tonemapSettings(info) {
  const t = (info && info.tonemap) || {};
  const curve = TONEMAP_CURVES.includes(t.curve) ? t.curve : 'hable';
  const brightness = Math.max(-2, Math.min(2, Number(t.brightness) || 0));
  return { curve, brightness: Math.round(brightness * 10) / 10 };
}

function tonemapChain(info) {
  const { curve, brightness } = tonemapSettings(info);
  // Brillo en pasos de exposición: bajar el pico nominal aclara la imagen.
  const npl = Math.round(100 / Math.pow(2, brightness));
  return `zscale=t=linear:npl=${npl},format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=${curve}:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`;
}

function cacheKey(info, salt) {
  return crypto.createHash('sha1').update(`${info.path}|${info.size}|${info.mtimeMs}|${salt}`).digest('hex');
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

async function exists(file) {
  try {
    const st = await fs.promises.stat(file);
    return st.size > 0;
  } catch {
    return false;
  }
}

/** Matriz de color de entrada cuando el archivo no la declara (misma heurística que Chromium). */
function guessMatrix(info) {
  if (info.colorSpace) return '';
  // VP9 sin etiquetar se muestra siempre como BT.709, sea cual sea su tamaño (medido en la vista previa).
  if (info.videoCodec === 'vp9') return 'bt709';
  return info.height > 576 || info.width >= 1280 ? 'bt709' : 'smpte170m';
}

// ---------------------------------------------------------------- proxys ----

let proxyChain = Promise.resolve();
const activeProxies = new Set();

/**
 * Genera (o reutiliza) un archivo de vista previa reproducible por el motor de la app.
 * El archivo original nunca se toca: la exportación siempre lee el original.
 */
function ensureProxy(info, cacheDir, onProgress, opts = {}) {
  const job = proxyChain.then(() => buildProxy(info, cacheDir, onProgress, opts));
  proxyChain = job.catch(() => {});
  return job;
}

async function buildProxy(info, cacheDir, onProgress, opts = {}) {
  const dir = path.join(cacheDir, 'proxy');
  await fs.promises.mkdir(dir, { recursive: true });
  // Copia ligera: la imagen ya es reproducible y solo hay que convertir el audio (segundos en
  // vez de minutos). Si luego no se reproduce bien, la interfaz pide la copia completa.
  const light = info.type === 'video' && info.videoNative && info.hasAudio && !opts.full;
  const ext = info.type === 'video' ? (light && !info.mp4Family ? 'mkv' : 'mp4') : info.type === 'audio' ? 'm4a' : 'png';
  const tm = tonemapSettings(info);
  const salt = light ? 'proxy-v3-light' : `proxy-v3${info.hdr ? `|${tm.curve}|${tm.brightness}` : ''}`;
  const out = path.join(dir, `${cacheKey(info, salt)}.${ext}`);
  if (await exists(out)) return out;
  const tmp = path.join(dir, `${cacheKey(info, salt)}.part.${ext}`);
  const caps = await capabilities();
  const { ffmpeg } = binaries();

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', info.path];
  if (info.type === 'image') {
    args.push('-frames:v', '1', '-vf', 'format=rgba', tmp);
  } else if (info.type === 'audio') {
    args.push('-map', `0:${info.audioIndex}`, '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', tmp);
  } else if (light) {
    args.push('-map', `0:${info.videoIndex}`, '-map', `0:${info.audioIndex}`, '-sn', '-dn', '-c:v', 'copy');
    if (info.mp4Family) args.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart');
    else args.push('-c:a', 'libopus', '-b:a', '192k', '-ac', '2', '-ar', '48000');
    args.push('-max_muxing_queue_size', '2048', tmp);
  } else {
    const scale = Math.min(1, 1280 / Math.max(info.width, info.height));
    const pw = even(info.width * scale);
    const ph = even(info.height * scale);
    const vf = [];
    if (info.interlaced) vf.push('yadif=0:-1:0');
    if (info.hdr && caps.filters.has('zscale') && caps.filters.has('tonemap')) vf.push(tonemapChain(info));
    if (info.fps > 62) vf.push('fps=60');
    vf.push(`scale=${pw}:${ph}:flags=bicubic`, 'setsar=1', 'format=yuv420p');
    args.push('-map', `0:${info.videoIndex}`);
    if (info.hasAudio) args.push('-map', `0:${info.audioIndex}`);
    args.push('-sn', '-dn', '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-g', '15', '-pix_fmt', 'yuv420p');
    if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
    args.push('-max_muxing_queue_size', '2048', '-movflags', '+faststart', tmp);
  }

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeProxies.add(child);
    let err = '';
    child.stdout.on('data', (c) => {
      const all = c.toString('utf8').match(/out_time_(?:us|ms)=(\d+)/g);
      if (all && onProgress && info.duration > 0) {
        const t = Number(all[all.length - 1].split('=')[1]) / 1e6;
        onProgress(Math.max(0, Math.min(1, t / info.duration)));
      }
    });
    child.stderr.on('data', (c) => {
      err = (err + c.toString('utf8')).slice(-4000);
    });
    child.on('error', (e) => {
      activeProxies.delete(child);
      reject(e);
    });
    child.on('close', (code) => {
      activeProxies.delete(child);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `FFmpeg terminó con código ${code}`));
    });
  }).catch(async (e) => {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw e;
  });

  await fs.promises.rename(tmp, out);
  return out;
}

function killProxies() {
  for (const c of activeProxies) {
    try {
      c.kill();
    } catch {
      /* ya terminó */
    }
  }
}

// --------------------------------------------------------- formas de onda ----

const PEAKS_PER_SECOND = 50;
const PEAK_RATE = 8000;

/** Devuelve picos de amplitud (0-255, 50 por segundo) del audio del archivo. */
async function computePeaks(info, cacheDir) {
  if (!info.hasAudio) return null;
  const dir = path.join(cacheDir, 'peaks');
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${cacheKey(info, 'peaks-v1')}.bin`);
  if (await exists(file)) return fs.promises.readFile(file);

  const { ffmpeg } = binaries();
  const step = PEAK_RATE / PEAKS_PER_SECOND; // muestras por pico
  const peaks = [];
  let leftover = null;
  let count = 0;
  let peak = 0;
  const args = ['-hide_banner', '-loglevel', 'error', '-i', info.path, '-map', `0:${info.audioIndex}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(PEAK_RATE), '-f', 's16le', 'pipe:1'];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk) => {
      let buf = chunk;
      if (leftover) {
        buf = Buffer.concat([leftover, chunk]);
        leftover = null;
      }
      const n = buf.length >> 1;
      for (let i = 0; i < n; i++) {
        const v = Math.abs(buf.readInt16LE(i * 2));
        if (v > peak) peak = v;
        if (++count >= step) {
          peaks.push(Math.min(255, Math.round((peak / 32768) * 255)));
          count = 0;
          peak = 0;
        }
      }
      if (buf.length & 1) leftover = buf.subarray(buf.length - 1);
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });
  if (count > 0) peaks.push(Math.min(255, Math.round((peak / 32768) * 255)));
  const out = Buffer.from(peaks);
  await fs.promises.writeFile(file, out).catch(() => {});
  return out;
}

// ------------------------------------------------------------ grabaciones ----

/** Guarda una grabación de micrófono (WAV) y devuelve su ruta. */
async function saveRecording(dir, bytes, name) {
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = String(name || 'Voz').replace(/[^\w\- áéíóúñÁÉÍÓÚÑ]/g, '_').slice(0, 60) || 'Voz';
  let file = path.join(dir, `${safe}.wav`);
  let i = 2;
  while (await exists(file)) file = path.join(dir, `${safe} (${i++}).wav`);
  await fs.promises.writeFile(file, Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength));
  return file;
}

module.exports = { ensureProxy, killProxies, computePeaks, saveRecording, guessMatrix, tonemapChain, PEAKS_PER_SECOND };
