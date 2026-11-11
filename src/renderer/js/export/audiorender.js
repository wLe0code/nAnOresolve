// Mezcla de audio para la exportación: usa las mismas cadenas que la vista previa, pero sobre
// un OfflineAudioContext y con el audio original decodificado por FFmpeg. Se renderiza por
// tramos para que proyectos largos no agoten la memoria.

import * as M from '../core/model.js';
import { rt } from '../media/library.js';
import { buildFx, buildMaster, FX_PREROLL } from '../playback/audiograph.js';

const SR = 48000;
const CHUNK = 30; // segundos por tramo
const KEEP = (FX_PREROLL + 1) * SR;

/** Clips que aportan sonido a la mezcla. */
export function audibleClips(project) {
  return project.clips.filter((c) => {
    if (!M.clipHasAudio(project, c) || c.muted) return false;
    const track = M.trackById(project, c.trackId);
    if (!track || track.muted) return false;
    const media = M.mediaById(project, c.mediaId);
    return !!media && media.hasAudio && rt(media.id).status !== 'offline';
  });
}

/** Lector secuencial de PCM (float32 estéreo) del audio de un medio, con memoria de los últimos segundos. */
class PcmStream {
  constructor(sessionId, media, t0) {
    this.sessionId = sessionId;
    this.media = media;
    this.t0 = t0; // tiempo de origen de la muestra 0
    this.base = 0; // índice (en fotogramas de audio) del inicio de `data`
    this.data = new Float32Array(0);
    this.decId = null;
    this.eof = false;
  }

  async fill(untilFrame) {
    if (this.decId === null && !this.eof) {
      this.decId = await window.nano.exportOpenAudioDecoder(this.sessionId, { media: this.media, ss: this.t0, duration: 0 });
    }
    const parts = [];
    let have = this.base + this.data.length / 2;
    while (have < untilFrame && !this.eof) {
      const bytes = await window.nano.exportReadAudio(this.decId, 1 << 21);
      if (!bytes || !bytes.byteLength) {
        this.eof = true;
        break;
      }
      const f32 = bytes.byteOffset % 4 === 0 ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2) : new Float32Array(bytes.slice().buffer);
      parts.push(f32);
      have += f32.length / 2;
    }
    if (parts.length) {
      const total = parts.reduce((n, p) => n + p.length, this.data.length);
      const merged = new Float32Array(total);
      merged.set(this.data, 0);
      let off = this.data.length;
      for (const p of parts) {
        merged.set(p, off);
        off += p.length;
      }
      this.data = merged;
    }
  }

  /** PCM entrelazado del tramo de origen [a, b) (puede venir más corto al final del archivo). */
  async read(a, b) {
    const fa = Math.max(0, Math.round((a - this.t0) * SR));
    const fb = Math.max(fa, Math.round((b - this.t0) * SR));
    await this.fill(fb);
    const end = Math.min(fb, this.base + this.data.length / 2);
    const start = Math.max(fa, this.base);
    const out = end > start ? this.data.slice((start - this.base) * 2, (end - this.base) * 2) : new Float32Array(0);
    // Conserva solo lo necesario para el solapamiento del siguiente tramo.
    const drop = Math.min(end - KEEP, this.base + this.data.length / 2) - this.base;
    if (drop > SR) {
      this.data = this.data.slice(drop * 2);
      this.base += drop;
    }
    return { pcm: out, skipped: (start - fa) / SR };
  }

  close() {
    if (this.decId !== null) window.nano.exportCloseDecoder(this.decId);
    this.decId = null;
  }
}

/** Renderiza la mezcla del tramo [start, end) del proyecto y la envía al proceso principal. */
export async function renderAudio(project, sessionId, start, end, onProgress, ctl) {
  const items = audibleClips(project).map((clip) => ({ clip, media: M.mediaById(project, clip.mediaId), win: M.audioWindow(project, clip), stream: null }));
  const totalFrames = Math.max(1, Math.round((end - start) * SR));
  const chunkFrames = CHUNK * SR;
  let done = 0;
  try {
    for (let c0 = 0; c0 < totalFrames; c0 += chunkFrames) {
      if (ctl.cancelled) throw new Error('cancelled');
      const len = Math.min(chunkFrames, totalFrames - c0);
      const pre = Math.min(c0, FX_PREROLL * SR);
      const T0 = start + (c0 - pre) / SR; // instante de la línea temporal en el tiempo 0 del contexto
      const T1 = start + (c0 + len) / SR;
      const ctx = new OfflineAudioContext(2, pre + len, SR);
      const master = buildMaster(ctx);
      master.output.connect(ctx.destination);

      for (const item of items) {
        const { clip, win } = item;
        if (win[1] <= T0 || win[0] >= T1) {
          if (win[1] <= T0 && item.stream) {
            item.stream.close();
            item.stream = null;
          }
          continue;
        }
        const a = Math.max(win[0], T0);
        const b = Math.min(win[1], T1);
        const srcA = M.sourceTime(clip, a);
        const srcB = M.sourceTime(clip, b);
        const sA = Math.max(0, srcA);
        if (srcB - sA < 1 / SR) continue;
        if (!item.stream) item.stream = new PcmStream(sessionId, item.media, sA);
        const { pcm, skipped } = await item.stream.read(sA, srcB);
        const frames = pcm.length >> 1;
        if (frames < 2) continue;

        const buffer = ctx.createBuffer(2, frames, SR);
        const L = buffer.getChannelData(0);
        const R = buffer.getChannelData(1);
        for (let i = 0; i < frames; i++) {
          L[i] = pcm[i * 2];
          R[i] = pcm[i * 2 + 1];
        }
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const fx = buildFx(ctx, clip.audioFx);
        const gain = ctx.createGain();
        src.connect(fx.input);
        fx.output.connect(gain);
        gain.connect(master.input);

        const when = Math.max(0, a + (sA - srcA) + skipped - T0);
        const dur = frames / SR;
        const n = Math.max(2, Math.ceil(dur * 200) + 1);
        const curve = new Float32Array(n);
        for (let i = 0; i < n; i++) curve[i] = M.audioGainAt(project, clip, T0 + when + (i / (n - 1)) * dur);
        gain.gain.setValueAtTime(curve[0], 0);
        try {
          gain.gain.setValueCurveAtTime(curve, when, dur);
        } catch {
          gain.gain.setValueAtTime(curve[Math.floor(n / 2)], when);
        }
        src.start(when);
      }

      const rendered = await ctx.startRendering();
      const L = rendered.getChannelData(0);
      const R = rendered.getChannelData(1);
      const out = new Float32Array(len * 2);
      for (let i = 0; i < len; i++) {
        out[i * 2] = L[pre + i];
        out[i * 2 + 1] = R[pre + i];
      }
      await window.nano.exportAudioWrite(sessionId, new Uint8Array(out.buffer));
      done += len;
      onProgress(done / totalFrames);
    }
  } finally {
    for (const item of items) if (item.stream) item.stream.close();
  }
}
