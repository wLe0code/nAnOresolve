'use strict';
// Exportación: FFmpeg decodifica los originales a fotogramas/PCM sin comprimir, la interfaz
// los compone (exactamente igual que la vista previa) y FFmpeg codifica el resultado final.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { binaries, capabilities, run } = require('./ffmpeg');
const { guessMatrix, tonemapChain } = require('./media');

const sessions = new Map();
const decoders = new Map();
let nextSession = 1;
let nextDecoder = 1;

const SAMPLE_RATE = 48000;

function fpsString(fps) {
  const ntsc = [
    [23.976, '24000/1001'],
    [29.97, '30000/1001'],
    [59.94, '60000/1001'],
    [119.88, '120000/1001'],
  ];
  for (const [v, s] of ntsc) if (Math.abs(fps - v) < 0.01) return s;
  return String(Math.round(fps * 1000) / 1000);
}

/** Lector con contrapresión sobre la salida de un proceso (fotogramas o PCM). */
class StreamReader {
  constructor(stream, highWater) {
    this.stream = stream;
    this.highWater = highWater;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.waiter = null;
    stream.on('data', (c) => {
      this.chunks.push(c);
      this.buffered += c.length;
      if (this.buffered >= this.highWater) stream.pause();
      this._wake();
    });
    const end = () => {
      this.ended = true;
      this._wake();
    };
    stream.on('end', end);
    stream.on('close', end);
    stream.on('error', end);
  }

  _wake() {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  _wait() {
    return new Promise((r) => {
      this.waiter = r;
    });
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const need = n - off;
      if (c.length <= need) {
        c.copy(out, off);
        off += c.length;
        this.chunks.shift();
      } else {
        c.copy(out, off, 0, need);
        this.chunks[0] = c.subarray(need);
        off += need;
      }
    }
    this.buffered -= n;
    if (this.buffered < this.highWater && !this.ended) this.stream.resume();
    return out;
  }

  /** Lee exactamente n bytes, o null si el flujo terminó antes. */
  async readExact(n) {
    while (this.buffered < n) {
      if (this.ended) return null;
      await this._wait();
    }
    return this._take(n);
  }

  /** Lee hasta max bytes (múltiplo de align), o null al final del flujo. */
  async readUpTo(max, align) {
    while (this.buffered < align) {
      if (this.ended) return null;
      await this._wait();
    }
    let n = Math.min(max, this.buffered);
    n -= n % align;
    return this._take(n);
  }
}

function getSession(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('La exportación ya no está activa');
  if (s.failed) throw s.failed;
  return s;
}

const QUALITY = {
  // crf x264, crf x265, crf vp9, perfil prores, q mpeg4, kbps audio
  max: { x264: 14, x265: 16, vp9: 16, prores: 3, mpeg4: 2, audio: 320 },
  high: { x264: 18, x265: 20, vp9: 24, prores: 3, mpeg4: 3, audio: 256 },
  medium: { x264: 22, x265: 25, vp9: 31, prores: 2, mpeg4: 5, audio: 192 },
  low: { x264: 27, x265: 30, vp9: 37, prores: 1, mpeg4: 8, audio: 128 },
};

const SPEED = { fast: 'veryfast', balanced: 'medium', slow: 'slow' };

// ------------------------------------------------- codificación por GPU ----

// Codificadores por hardware, por orden de preferencia. Solo se ofrecen los que de verdad
// funcionan en este equipo (se comprueba codificando unos fotogramas de prueba).
const HW_CANDIDATES = {
  h264: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'],
  hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox'],
};
const HW_VENDOR = { nvenc: 'NVIDIA', qsv: 'Intel', amf: 'AMD', videotoolbox: 'Apple' };
const HW_FAMILY = { 'mp4-h264': 'h264', 'mkv-h264': 'h264', 'mp4-h265': 'hevc' };
const HW_QUALITY = { max: 16, high: 20, medium: 24, low: 29 };

const hwKind = (enc) => enc.split('_').slice(1).join('_');

/** Argumentos de un codificador por hardware a calidad constante. */
function hwEncoderArgs(enc, opts) {
  const kind = hwKind(enc);
  const hevc = enc.startsWith('hevc');
  const q = (HW_QUALITY[opts.quality] || HW_QUALITY.high) + (hevc ? 2 : 0);
  const a = ['-c:v', enc];
  if (kind === 'nvenc') {
    a.push('-preset', { fast: 'p3', balanced: 'p5', slow: 'p7' }[opts.speed] || 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0');
  } else if (kind === 'qsv') {
    a.push('-preset', { fast: 'veryfast', balanced: 'medium', slow: 'veryslow' }[opts.speed] || 'medium', '-global_quality', String(q));
  } else if (kind === 'amf') {
    a.push('-usage', 'transcoding', '-quality', { fast: 'speed', balanced: 'balanced', slow: 'quality' }[opts.speed] || 'balanced', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q + 1), '-qp_b', String(q + 3));
  } else {
    a.push('-q:v', String(Math.max(20, Math.min(90, 100 - q * 2))));
  }
  if (!hevc) a.push('-profile:v', 'high');
  else a.push('-tag:v', 'hvc1');
  // Algunos codificadores por hardware no escriben el espacio de color: se anota en el propio flujo.
  a.push('-bsf:v', `${hevc ? 'hevc' : 'h264'}_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0`);
  return a;
}

async function hwWorks(enc, width, height, opts) {
  const { ffmpeg } = binaries();
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=${width}x${height}:r=30:d=0.2`, '-vf', 'format=nv12', ...hwEncoderArgs(enc, opts), '-f', 'null', '-'];
  try {
    const r = await run(ffmpeg, args);
    return r.code === 0;
  } catch {
    return false;
  }
}

let hwPromise = null;
/** Codificadores por GPU utilizables: { h264, hevc, label } (null si no hay). */
function hwEncoders() {
  if (!hwPromise) {
    hwPromise = (async () => {
      const caps = await capabilities();
      const out = { h264: null, hevc: null, label: '' };
      for (const family of ['h264', 'hevc']) {
        for (const enc of HW_CANDIDATES[family]) {
          if (caps.encoders.has(enc) && (await hwWorks(enc, 640, 360, { quality: 'high', speed: 'balanced' }))) {
            out[family] = enc;
            break;
          }
        }
      }
      const any = out.h264 || out.hevc;
      if (any) out.label = HW_VENDOR[hwKind(any)] || 'GPU';
      return out;
    })();
  }
  return hwPromise;
}

function videoEncoderArgs(opts, audioPath, hwEnc) {
  const q = QUALITY[opts.quality] || QUALITY.high;
  const preset = SPEED[opts.speed] || SPEED.balanced;
  const a = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats'];
  // La interfaz entrega RGBA o, en la ruta rápida, NV12 ya convertido a BT.709 de rango limitado.
  const nv12 = opts.pixFmt === 'nv12';
  a.push('-f', 'rawvideo', '-pix_fmt', nv12 ? 'nv12' : 'rgba');
  if (nv12) a.push('-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  a.push('-s', `${opts.width}x${opts.height}`, '-r', fpsString(opts.fps), '-i', 'pipe:0');
  if (audioPath) a.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', audioPath);
  a.push('-map', '0:v:0');
  if (audioPath) a.push('-map', '1:a:0');

  const toYuv = (fmt) => (nv12 ? `format=${fmt}` : `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${fmt}`);
  const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  const audio = (codec, extra = []) => (audioPath ? ['-c:a', codec, ...extra] : []);

  if (hwEnc) {
    a.push('-vf', toYuv('nv12'), ...hwEncoderArgs(hwEnc, opts), ...tags);
    if (opts.format === 'mkv-h264') a.push(...audio('flac'));
    else a.push(...audio('aac', ['-b:a', `${q.audio}k`]), '-movflags', '+faststart');
    a.push('-metadata', 'comment=Creado con nAnOresolve', opts.outPath);
    return a;
  }

  switch (opts.format) {
    case 'mp4-h265':
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'libx265', '-preset', preset, '-crf', String(q.x265), '-tag:v', 'hvc1', '-x265-params', 'log-level=error', ...tags);
      a.push(...audio('aac', ['-b:a', `${q.audio}k`]), '-movflags', '+faststart');
      break;
    case 'mov-prores':
      a.push('-vf', toYuv('yuv422p10le'), '-c:v', 'prores_ks', '-profile:v', String(q.prores), '-vendor', 'apl0', ...tags);
      a.push(...audio('pcm_s24le'));
      break;
    case 'mkv-h264':
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'libx264', '-preset', preset, '-crf', String(q.x264), '-profile:v', 'high', ...tags);
      a.push(...audio('flac'));
      break;
    case 'webm-vp9':
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'libvpx-vp9', '-crf', String(q.vp9), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', preset === 'slow' ? '1' : preset === 'medium' ? '2' : '4', ...tags);
      a.push(...audio('libopus', ['-b:a', `${Math.min(q.audio, 256)}k`]));
      break;
    case 'avi-mpeg4':
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'mpeg4', '-q:v', String(q.mpeg4), '-vtag', 'xvid');
      a.push(...audio('libmp3lame', ['-b:a', `${q.audio}k`]));
      break;
    case 'mp4-h264':
    default:
      a.push('-vf', toYuv('yuv420p'), '-c:v', 'libx264', '-preset', preset, '-crf', String(q.x264), '-profile:v', 'high', ...tags);
      a.push(...audio('aac', ['-b:a', `${q.audio}k`]), '-movflags', '+faststart');
      break;
  }
  a.push('-metadata', 'comment=Creado con nAnOresolve', opts.outPath);
  return a;
}

function audioOnlyArgs(opts, audioPath) {
  const q = QUALITY[opts.quality] || QUALITY.high;
  const a = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', audioPath];
  if (opts.format === 'wav') a.push('-c:a', 'pcm_s24le');
  else a.push('-c:a', 'libmp3lame', '-b:a', `${q.audio}k`);
  a.push(opts.outPath);
  return a;
}

/** Inicia una exportación. Devuelve el identificador de sesión. */
async function begin(opts) {
  const id = nextSession++;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nanoresolve-export-'));
  const s = {
    id,
    opts,
    tmpDir,
    audioPath: null,
    audioStream: null,
    encoder: null,
    encoderDone: null,
    encoderErr: '',
    failed: null,
    decoders: new Set(),
  };
  sessions.set(id, s);
  return { id };
}

/** Añade PCM (float32 estéreo entrelazado, 48 kHz) a la mezcla de audio. */
function audioWrite(id, bytes) {
  const s = getSession(id);
  if (!s.audioStream) {
    s.audioPath = path.join(s.tmpDir, 'audio.f32');
    s.audioStream = fs.createWriteStream(s.audioPath);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Promise((resolve, reject) => {
    s.audioStream.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

async function closeAudio(s) {
  if (!s.audioStream) return;
  const stream = s.audioStream;
  s.audioStream = null;
  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });
}

/** Arranca el codificador de video (la mezcla de audio ya debe estar escrita). */
async function startEncoder(id) {
  const s = getSession(id);
  await closeAudio(s);
  const { ffmpeg } = binaries();
  // Codificación por GPU si se pidió, existe para este formato y funciona a esta resolución;
  // si no, se usa el procesador sin interrumpir la exportación.
  let hwEnc = null;
  const family = HW_FAMILY[s.opts.format];
  if (s.opts.hw && family) {
    const hw = await hwEncoders();
    if (hw[family] && (await hwWorks(hw[family], s.opts.width, s.opts.height, s.opts))) hwEnc = hw[family];
  }
  s.encoderName = hwEnc || 'software';
  const args = videoEncoderArgs(s.opts, s.audioPath, hwEnc);
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  s.encoder = child;
  child.stderr.on('data', (c) => {
    s.encoderErr = (s.encoderErr + c.toString('utf8')).slice(-6000);
  });
  child.stdin.on('error', (e) => {
    if (!s.failed) s.failed = new Error(s.encoderErr.trim() || e.message);
  });
  s.encoderDone = new Promise((resolve) => {
    child.on('error', (e) => {
      s.failed = s.failed || e;
      resolve(-1);
    });
    child.on('close', (code) => {
      if (code !== 0 && !s.failed && !s.cancelled) s.failed = new Error(s.encoderErr.trim() || `El codificador terminó con código ${code}`);
      resolve(code);
    });
  });
  return { hw: !!hwEnc, encoder: s.encoderName, fallback: !!s.opts.hw && !hwEnc };
}

/** Envía un fotograma RGBA ya compuesto al codificador. */
function writeFrame(id, bytes) {
  const s = getSession(id);
  if (!s.encoder) throw new Error('El codificador no está iniciado');
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Promise((resolve, reject) => {
    const stdin = s.encoder.stdin;
    if (stdin.destroyed || !stdin.writable) return reject(s.failed || new Error(s.encoderErr.trim() || 'El codificador se cerró'));
    const ok = stdin.write(buf, (err) => {
      if (err) reject(s.failed || err);
    });
    if (ok) resolve();
    else {
      const onDrain = () => {
        stdin.off('close', onClose);
        resolve();
      };
      const onClose = () => {
        stdin.off('drain', onDrain);
        reject(s.failed || new Error(s.encoderErr.trim() || 'El codificador se cerró'));
      };
      stdin.once('drain', onDrain);
      stdin.once('close', onClose);
    }
  });
}

/** Abre un decodificador de video que entrega fotogramas RGBA al ritmo del proyecto. */
async function openVideoDecoder(id, p) {
  const s = getSession(id);
  const caps = await capabilities();
  const { ffmpeg } = binaries();
  const info = p.media;
  const vf = [];
  if (info.interlaced) vf.push('yadif=0:-1:0');
  if (info.hdr && caps.filters.has('zscale') && caps.filters.has('tonemap')) vf.push(tonemapChain(info));
  // Cambio de velocidad: se reescala el tiempo y el filtro fps repite o descarta fotogramas.
  const speed = p.speed > 0 ? p.speed : 1;
  if (Math.abs(speed - 1) > 1e-6) vf.push(`setpts=PTS/${speed}`);
  vf.push(`fps=${fpsString(p.fps)}:start_time=0`);
  const matrix = guessMatrix(info);
  let pixFmt;
  let frameSize;
  if (p.yuv) {
    // Ruta rápida: se entrega YUV 4:2:0 de 8 bits y rango limitado sin tocar la matriz de color;
    // la conversión a RGB la hace el compositor en la tarjeta gráfica.
    vf.push(`scale=${p.width}:${p.height}:flags=lanczos+accurate_rnd:out_range=tv`);
    pixFmt = 'nv12';
    frameSize = p.width * p.height * 1.5;
  } else {
    vf.push(`scale=${p.width}:${p.height}:flags=lanczos+accurate_rnd+full_chroma_int${matrix ? `:in_color_matrix=${matrix}` : ''}`);
    pixFmt = p.alpha ? 'rgba' : 'rgb24';
    frameSize = p.width * p.height * (p.alpha ? 4 : 3);
  }
  vf.push('setsar=1');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-ss', String(Math.max(0, p.ss)), '-i', info.path, '-map', `0:${info.videoIndex}`, '-an', '-sn', '-dn', '-vf', vf.join(','), '-f', 'rawvideo', '-pix_fmt', pixFmt, 'pipe:1'];
  return openDecoder(s, ffmpeg, args, frameSize * 3, { frameSize });
}

/**
 * Filtros de audio para un cambio de velocidad. Conservando el tono se estira el tiempo
 * (atempo); sin conservarlo se reproduce más rápido o más lento, como una cinta.
 */
function speedFilters(speed, keepPitch) {
  if (!(speed > 0) || Math.abs(speed - 1) < 1e-6) return [];
  if (!keepPitch) return [`aresample=${SAMPLE_RATE}`, `asetrate=${Math.round(SAMPLE_RATE * speed)}`, `aresample=${SAMPLE_RATE}`];
  // Un solo atempo cubre de 0,5× a 100× (encadenar varios acumula error de duración).
  const out = [];
  let s = speed;
  while (s < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

/** Abre un decodificador de audio que entrega PCM float32 estéreo a 48 kHz. */
async function openAudioDecoder(id, p) {
  const s = getSession(id);
  const { ffmpeg } = binaries();
  const info = p.media;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-ss', String(Math.max(0, p.ss)), '-i', info.path, '-map', `0:${info.audioIndex}`, '-vn', '-sn', '-dn'];
  if (p.duration > 0) args.push('-t', String(p.duration));
  const af = [];
  // Mono -> estéreo sin atenuar (igual que hace la vista previa); el resto usa la mezcla estándar.
  if (info.channels === 1) af.push('pan=stereo|c0=c0|c1=c0');
  af.push(...speedFilters(p.speed, p.pitch !== false));
  if (af.length) args.push('-af', af.join(','));
  args.push('-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
  return openDecoder(s, ffmpeg, args, SAMPLE_RATE * 8 * 4, {});
}

function openDecoder(s, bin, args, highWater, extra) {
  const child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const decId = nextDecoder++;
  const d = { id: decId, child, reader: new StreamReader(child.stdout, highWater), err: '', session: s, ...extra };
  child.stderr.on('data', (c) => {
    d.err = (d.err + c.toString('utf8')).slice(-3000);
  });
  child.on('error', (e) => {
    d.err += e.message;
  });
  decoders.set(decId, d);
  s.decoders.add(decId);
  return decId;
}

async function readFrame(decId) {
  const d = decoders.get(decId);
  if (!d) return null;
  return d.reader.readExact(d.frameSize);
}

async function readAudio(decId, maxBytes) {
  const d = decoders.get(decId);
  if (!d) return null;
  return d.reader.readUpTo(maxBytes, 8);
}

/** Cierra un decodificador. Devuelve el texto de error que haya dejado, si lo hay. */
function closeDecoder(decId) {
  const d = decoders.get(decId);
  if (!d) return '';
  decoders.delete(decId);
  d.session.decoders.delete(decId);
  try {
    d.child.stdout.destroy();
    d.child.kill();
  } catch {
    /* ya terminó */
  }
  return d.err.trim();
}

async function cleanup(s) {
  for (const decId of [...s.decoders]) closeDecoder(decId);
  sessions.delete(s.id);
  await fs.promises.rm(s.tmpDir, { recursive: true, force: true }).catch(() => {});
}

/** Termina la exportación y devuelve { path, size }. */
async function finish(id) {
  const s = getSession(id);
  try {
    if (s.opts.audioOnly) {
      await closeAudio(s);
      if (!s.audioPath) throw new Error('El proyecto no tiene audio para exportar');
      const { ffmpeg } = binaries();
      const res = await run(ffmpeg, audioOnlyArgs(s.opts, s.audioPath));
      if (res.code !== 0) throw new Error(res.stderr.trim() || 'No se pudo codificar el audio');
    } else {
      if (!s.encoder) throw new Error('El codificador no está iniciado');
      s.encoder.stdin.end();
      await s.encoderDone;
      if (s.failed) throw s.failed;
    }
    const st = await fs.promises.stat(s.opts.outPath);
    return { path: s.opts.outPath, size: st.size };
  } finally {
    await cleanup(s);
  }
}

/** Cancela la exportación y elimina el archivo parcial. */
async function cancel(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.cancelled = true;
  if (s.encoder) {
    try {
      s.encoder.stdin.destroy();
      s.encoder.kill();
    } catch {
      /* ya terminó */
    }
    await s.encoderDone;
  }
  await closeAudio(s).catch(() => {});
  await cleanup(s);
  await fs.promises.rm(s.opts.outPath, { force: true }).catch(() => {});
  return true;
}

async function cancelAll() {
  await Promise.all([...sessions.keys()].map((id) => cancel(id)));
}

module.exports = { hwEncoders, begin, audioWrite, startEncoder, writeFrame, openVideoDecoder, openAudioDecoder, readFrame, readAudio, closeDecoder, finish, cancel, cancelAll, SAMPLE_RATE };
