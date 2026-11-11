// Motor de vista previa: reloj de reproducción, elementos de video/audio sincronizados con la
// línea temporal, mezcla de audio en tiempo real y dibujo de cada fotograma con el compositor.

import { state, on, emit, setPlayhead } from '../core/store.js';
import { clamp } from '../core/util.js';
import { mediaById, trackById, projectDuration, mediaWindow, audioGainAt, clipHasAudio, sourceTime, snapFrame } from '../core/model.js';
import { buildScene } from '../render/scene.js';
import { Compositor } from '../render/compositor.js';
import { rt, previewUrl } from '../media/library.js';
import { buildFx, buildMaster } from './audiograph.js';

const MAX_SLOTS = 10;
const LOOKAHEAD = 1.5; // segundos de antelación para preparar el siguiente clip

class Engine {
  constructor() {
    this.playing = false;
    this.raf = 0;
    this.slots = new Map(); // clipId -> slot
    this.pool = []; // slots libres
    this.slotSeq = 0;
    this.scene = null;
    this.tick = this.tick.bind(this);
  }

  init(canvas) {
    this.canvas = canvas;
    this.compositor = new Compositor(canvas, { preserve: true, onLost: () => emit('gl-lost') });

    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.master = buildMaster(this.ctx);
    this.outGain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.output.connect(this.outGain);
    this.outGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.meterBuf = new Float32Array(this.analyser.fftSize);

    on('playhead', (opts) => {
      if (opts && opts.fromEngine) return;
      if (this.playing) this.anchor(state.playhead);
      this.requestRender();
    });
    on('project', (info) => {
      if (info && info.load) this.reset();
      this.requestRender();
    });
    on('media', () => this.requestRender());
    this.requestRender();
  }

  // ------------------------------------------------------------ transporte ----

  anchor(t) {
    this.startT = t;
    this.startNow = performance.now();
  }

  play() {
    if (this.playing || !state.project) return;
    const dur = projectDuration(state.project);
    if (dur <= 0) return;
    if (state.playhead >= dur - 1e-3) setPlayhead(0, { fromEngine: true });
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    this.playing = true;
    state.playing = true;
    this.anchor(state.playhead);
    emit('ui', ['playing']);
    this.requestRender();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    state.playing = false;
    setPlayhead(snapFrame(state.project, state.playhead), { fromEngine: true });
    emit('ui', ['playing']);
    this.requestRender();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t) {
    setPlayhead(clamp(t, 0, Math.max(0, projectDuration(state.project))));
  }

  step(frames) {
    if (this.playing) this.pause();
    const p = state.project;
    const t = snapFrame(p, state.playhead) + frames / p.settings.fps;
    setPlayhead(clamp(t, 0, Math.max(projectDuration(p), 0)));
  }

  /** Silencia la salida (por ejemplo, al grabar voz sin auriculares). */
  setOutputMuted(muted) {
    this.outGain.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.01);
  }

  /** Nivel de pico actual de la mezcla (0..1). */
  level() {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) peak = Math.max(peak, Math.abs(this.meterBuf[i]));
    return peak;
  }

  // ---------------------------------------------------------------- bucle ----

  requestRender() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  tick() {
    this.raf = 0;
    if (!state.project || !this.compositor) return;
    let t = state.playhead;
    if (this.playing) {
      t = this.startT + (performance.now() - this.startNow) / 1000;
      const dur = projectDuration(state.project);
      if (t >= dur) {
        t = dur;
        this.playing = false;
        state.playing = false;
        setPlayhead(t, { fromEngine: true });
        emit('ui', ['playing']);
      } else {
        setPlayhead(t, { fromEngine: true });
      }
    }
    this.sync(t);
    this.scene = buildScene(state.project, t);
    this.compositor.render(this.scene, this);
    emit('frame', this.scene);
    if (this.playing) this.raf = requestAnimationFrame(this.tick);
  }

  resize(w, h) {
    if (!this.compositor) return;
    this.compositor.setSize(w, h);
    this.requestRender();
  }

  // ------------------------------------------------- elementos de medios ----

  makeSlot(media, kind) {
    const isVideo = kind === 'video';
    const el = document.createElement(isVideo ? 'video' : 'audio');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = previewUrl(media);
    const slot = {
      key: `slot:${++this.slotSeq}`,
      el,
      kind,
      mediaId: media.id,
      clipId: null,
      version: 0,
      seeking: false,
      seekAt: 0,
      seekCost: 0,
      tries: 0,
      resyncAt: 0,
      pending: null,
      stale: false,
      node: null,
      gain: null,
      fx: null,
      fxId: undefined,
      dead: false,
    };
    el.addEventListener('seeked', () => {
      if (slot.seeking && slot.seekAt) {
        const cost = clamp((performance.now() - slot.seekAt) / 1000, 0.005, 0.5);
        slot.seekCost = slot.seekCost ? slot.seekCost * 0.5 + cost * 0.5 : cost;
      }
      slot.seeking = false;
      slot.stale = false;
      slot.version++;
      if (slot.pending !== null) {
        const p = slot.pending;
        slot.pending = null;
        this.seekSlot(slot, p, 0.001);
      }
      this.requestRender();
    });
    el.addEventListener('loadedmetadata', () => {
      if (slot.pending !== null) {
        const p = slot.pending;
        slot.pending = null;
        this.seekSlot(slot, p, 0.001);
      }
    });
    el.addEventListener('loadeddata', () => {
      slot.version++;
      this.requestRender();
    });
    if (isVideo && el.requestVideoFrameCallback) {
      const onFrame = () => {
        if (slot.dead) return;
        slot.version++;
        if (!this.playing) this.requestRender();
        el.requestVideoFrameCallback(onFrame);
      };
      el.requestVideoFrameCallback(onFrame);
    }
    if (media.hasAudio) {
      slot.node = this.ctx.createMediaElementSource(el);
      slot.gain = this.ctx.createGain();
      slot.gain.gain.value = 0;
      slot.gain.connect(this.master.input);
    }
    return slot;
  }

  rewire(slot, fxId) {
    try {
      slot.node.disconnect();
      if (slot.fx) slot.fx.output.disconnect();
    } catch {
      /* ya desconectado */
    }
    slot.fx = buildFx(this.ctx, fxId);
    slot.node.connect(slot.fx.input);
    slot.fx.output.connect(slot.gain);
    slot.fxId = fxId;
  }

  destroy(slot) {
    slot.dead = true;
    try {
      slot.el.pause();
      if (slot.node) slot.node.disconnect();
      if (slot.fx) slot.fx.output.disconnect();
      if (slot.gain) slot.gain.disconnect();
      slot.el.removeAttribute('src');
      slot.el.load();
    } catch {
      /* sin efecto */
    }
    this.compositor.dropTexture(slot.key);
  }

  reset() {
    for (const slot of this.slots.values()) this.destroy(slot);
    for (const slot of this.pool) this.destroy(slot);
    this.slots.clear();
    this.pool = [];
    if (this.playing) {
      this.playing = false;
      state.playing = false;
      emit('ui', ['playing']);
    }
  }

  seekSlot(slot, target, tol) {
    const el = slot.el;
    if (el.readyState < 1) {
      slot.pending = target;
      return;
    }
    if (slot.seeking) {
      if (performance.now() - slot.seekAt < 3000) {
        slot.pending = target;
        return;
      }
      slot.seeking = false;
    }
    if (Math.abs(el.currentTime - target) <= tol) {
      slot.stale = false;
      return;
    }
    slot.seeking = true;
    slot.seekAt = performance.now();
    try {
      el.currentTime = target;
    } catch {
      slot.seeking = false;
    }
  }

  acquire(media, ts, kind) {
    let best = -1;
    let bestD = Infinity;
    this.pool.forEach((s, i) => {
      if (s.mediaId !== media.id || s.kind !== kind) return;
      const d = Math.abs(s.el.currentTime - ts);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0) {
      const s = this.pool.splice(best, 1)[0];
      if (bestD > 0.06) s.stale = true;
      return s;
    }
    return this.makeSlot(media, kind);
  }

  /** Asigna elementos de medios a los clips activos (o a punto de empezar) y los sincroniza. */
  sync(t) {
    const project = state.project;
    const playing = this.playing;
    const look = playing ? LOOKAHEAD : 0;
    const needed = new Map();
    for (const clip of project.clips) {
      if (clip.type !== 'video' && clip.type !== 'audio') continue;
      const media = mediaById(project, clip.mediaId);
      if (!media || rt(media.id).status !== 'ready') continue;
      const [ws, we] = mediaWindow(project, clip);
      if (t < ws - look || t >= we - 1e-6) continue;
      needed.set(clip.id, { clip, media, active: t >= ws - 1e-6, ts: sourceTime(clip, Math.max(t, ws)) });
    }

    for (const [id, slot] of this.slots) {
      if (!needed.has(id) || slot.mediaId !== needed.get(id).media.id) {
        this.slots.delete(id);
        slot.clipId = null;
        this.pool.push(slot);
      }
    }
    for (const [id, n] of needed) {
      let slot = this.slots.get(id);
      if (!slot) {
        slot = this.acquire(n.media, n.ts, n.clip.type === 'audio' ? 'audio' : 'video');
        slot.clipId = id;
        this.slots.set(id, slot);
      }
      this.drive(slot, n, t, playing);
    }
    for (const slot of this.pool) {
      if (!slot.el.paused) slot.el.pause();
      if (slot.gain) slot.gain.gain.value = 0;
    }
    while (this.slots.size + this.pool.length > MAX_SLOTS && this.pool.length) this.destroy(this.pool.shift());
  }

  drive(slot, n, t, playing) {
    const { clip, media } = n;
    const el = slot.el;
    const project = state.project;
    if (slot.node && slot.fxId !== (clip.audioFx || null)) this.rewire(slot, clip.audioFx || null);

    const maxT = Math.max(0, media.duration - 0.02);
    const target = clamp(n.ts, 0, maxT);
    const canPlay = playing && n.active && n.ts >= -1e-3 && n.ts < media.duration - 0.02;
    if (canPlay) {
      const diff = Math.abs(el.currentTime - target);
      const now = performance.now();
      // Al buscar se apunta un poco por delante: lo que tarda de media ese elemento en reposicionarse.
      const ahead = Math.min(target + (slot.seekCost || 0.04), maxT);
      if (el.paused) {
        if (slot.seeking) {
          /* se reproducirá en cuanto termine de reposicionarse */
        } else if (diff > 0.08 && slot.tries < 3) {
          slot.tries++;
          this.seekSlot(slot, ahead, 0);
        } else {
          slot.tries = 0;
          el.play().catch(() => {});
        }
      } else if (diff > 0.2 && !slot.seeking && now - slot.resyncAt > 500) {
        slot.resyncAt = now;
        this.seekSlot(slot, ahead, 0);
      }
      slot.version++;
    } else {
      slot.tries = 0;
      if (!el.paused) el.pause();
      this.seekSlot(slot, target, playing ? 0.05 : 0.5 / (media.fps || 30));
    }

    if (slot.gain) {
      const g = canPlay && clipHasAudio(project, clip) ? audioGainAt(project, clip, t) : 0;
      slot.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.012);
    }
  }

  /** Fuente de imagen de una capa para el compositor. */
  sourceFor(layer) {
    const project = state.project;
    const media = mediaById(project, layer.clip.mediaId);
    if (!media) return null;
    if (layer.kind === 'image') {
      const bmp = rt(media.id).bitmap;
      if (!bmp) return null;
      return { key: `img:${media.id}`, version: 1, ready: true, el: bmp, width: bmp.width, height: bmp.height };
    }
    const track = trackById(project, layer.clip.trackId);
    if (track && track.hidden) return null;
    const slot = this.slots.get(layer.clip.id);
    if (!slot || slot.stale) return null;
    const el = slot.el;
    const ready = el.readyState >= 2 && el.videoWidth > 0;
    return { key: slot.key, version: slot.version, ready, el, width: el.videoWidth, height: el.videoHeight };
  }
}

export const engine = new Engine();
