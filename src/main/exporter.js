'use strict';
// Exportación: FFmpeg decodifica los originales a fotogramas/PCM sin comprimir, la interfaz
// los compone (exactamente igual que la vista previa) y FFmpeg codifica el resultado final.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { binaries, capabilities, run } = require('./ffmpeg');
const { guessMatrix, TONEMAP_CHAIN } = require('./media');

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

function videoEncoderArgs(opts, audioPath) {
  const q = QUALITY[opts.quality] || QUALITY.high;
  const preset = SPEED[opts.speed] || SPEED.balanced;
  const a = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats'];
  a.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${opts.width}x${opts.height}`, '-r', fpsString(opts.fps), '-i', 'pipe:0');
  if (audioPath) a.push('-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', audioPath);
  a.push('-map', '0:v:0');
  if (audioPath) a.push('-map', '1:a:0');

  const toYuv = (fmt) => `scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=${fmt}`;
  const tags = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
  const audio = (codec, extra = []) => (audioPath ? ['-c:a', codec, ...extra] : []);

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
  const args = videoEncoderArgs(s.opts, s.audioPath);
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
  return true;
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
  if (info.hdr && caps.filters.has('zscale') && caps.filters.has('tonemap')) vf.push(TONEMAP_CHAIN);
  vf.push(`fps=${fpsString(p.fps)}:start_time=0`);
  const matrix = guessMatrix(info);
  vf.push(`scale=${p.width}:${p.height}:flags=lanczos+accurate_rnd+full_chroma_int${matrix ? `:in_color_matrix=${matrix}` : ''}`);
  vf.push('setsar=1');
  const channels = p.alpha ? 4 : 3;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-ss', String(Math.max(0, p.ss)), '-i', info.path, '-map', `0:${info.videoIndex}`, '-an', '-sn', '-dn', '-vf', vf.join(','), '-f', 'rawvideo', '-pix_fmt', channels === 4 ? 'rgba' : 'rgb24', 'pipe:1'];
  const frameSize = p.width * p.height * channels;
  return openDecoder(s, ffmpeg, args, frameSize * 3, { frameSize });
}

/** Abre un decodificador de audio que entrega PCM float32 estéreo a 48 kHz. */
async function openAudioDecoder(id, p) {
  const s = getSession(id);
  const { ffmpeg } = binaries();
  const info = p.media;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-ss', String(Math.max(0, p.ss)), '-i', info.path, '-map', `0:${info.audioIndex}`, '-vn', '-sn', '-dn'];
  if (p.duration > 0) args.push('-t', String(p.duration));
  // Mono -> estéreo sin atenuar (igual que hace la vista previa); el resto usa la mezcla estándar.
  if (info.channels === 1) args.push('-af', 'pan=stereo|c0=c0|c1=c0');
  else args.push('-ac', '2');
  args.push('-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1');
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

module.exports = { begin, audioWrite, startEncoder, writeFrame, openVideoDecoder, openAudioDecoder, readFrame, readAudio, closeDecoder, finish, cancel, cancelAll, SAMPLE_RATE };
