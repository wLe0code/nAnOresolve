// Acciones de edición: cada una aplica un cambio al proyecto como un paso de deshacer.

import { state, mutate, select, setUI, setPlayhead, removedMedia, selectedClips } from './store.js';
import * as M from './model.js';
import { clamp, deepClone, EPS } from './util.js';
import { setProp, setKey, hasKeys, toggleKey, clearKeys, neighborKey } from './keyframes.js';
import { colorFromPreset, COLOR_DEFAULT, effectById, TEXT_PRESETS, DEFAULT_TRANSITION_DURATION, FRAME_RATES } from './presets.js';
import { MAX_CENSORS } from '../render/shaders.js';
import { toast } from '../ui/widgets.js';

/** Tiempo de origen del clip bajo el cursor (limitado al tramo visible del clip). */
export function clipTs(clip, t = state.playhead) {
  return clamp(M.sourceTime(clip, t), clip.in, clip.in + clip.duration);
}

export const tsToTimeline = (clip, ts) => clip.start + (ts - clip.in);

const isLocked = (p, clip) => !!M.trackById(p, clip.trackId)?.locked;
const fpsLabel = (fps) => (Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/, ''));

function matchProject(p, media) {
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  p.settings.width = even(media.width);
  p.settings.height = even(media.height);
  const raw = media.fps || 30;
  p.settings.fps = FRAME_RATES.find((r) => Math.abs(r - raw) < 0.02) || clamp(Math.round(raw * 1000) / 1000, 1, 120);
  p.settings.matched = true;
  toast(`Proyecto ajustado al video: ${p.settings.width}×${p.settings.height} · ${fpsLabel(p.settings.fps)} fps`);
}

// ------------------------------------------------------------------- clips ----

/** Añade un medio a la línea temporal. Sin `start`, lo coloca al final de la pista. */
export function addMediaToTimeline(media, opts = {}) {
  const clip = mutate('Añadir clip', (p) => {
    const kind = M.kindOf(media.type);
    if (media.type === 'video' && !p.settings.matched && !p.clips.some((c) => c.type === 'video')) matchProject(p, media);
    let track = opts.trackId ? M.trackById(p, opts.trackId) : null;
    const explicit = !!track && track.kind === kind && !track.locked;
    if (!explicit) {
      const candidates = p.tracks.filter((t) => t.kind === kind && !t.locked);
      track = (kind === 'video' ? candidates[candidates.length - 1] : candidates[0]) || M.addTrack(p, kind);
    }
    const c = M.makeMediaClip(p, media, track.id, 0);
    let desired = M.trackEnd(p, track.id);
    if (opts.start !== undefined) {
      desired = M.snapFrame(p, Math.max(0, opts.start));
      // Sin pista elegida: si ese punto está ocupado, se usa otra pista libre (o una nueva).
      if (!explicit && !M.rangeIsFree(p, track.id, desired, c.duration)) {
        track = M.findFreeTrack(p, kind, desired, c.duration) || M.addTrack(p, kind);
        c.trackId = track.id;
      }
    }
    c.start = M.snapFrame(p, M.resolveStart(p, track.id, desired, c.duration));
    p.clips.push(c);
    return c;
  });
  if (opts.select !== false) select(clip.id);
  return clip;
}

export function addText(presetId, opts = {}) {
  const preset = TEXT_PRESETS.find((t) => t.id === presetId) || TEXT_PRESETS[0];
  const clip = mutate('Añadir texto', (p) => {
    const dur = 4;
    let start = M.snapFrame(p, Math.max(0, opts.start ?? state.playhead));
    let track = opts.trackId ? M.trackById(p, opts.trackId) : null;
    if (track && track.kind === 'video' && !track.locked) {
      start = M.snapFrame(p, M.resolveStart(p, track.id, start, dur));
    } else {
      track = M.findFreeTrack(p, 'video', start, dur, { skipMain: true }) || M.addTrack(p, 'video');
    }
    const c = M.makeTextClip(p, preset, track.id, start);
    p.clips.push(c);
    return c;
  });
  select(clip.id);
  return clip;
}

/** Corta en el cursor los clips seleccionados (o, si no hay selección, todos los que cruza). */
export function splitAtPlayhead() {
  const p = state.project;
  const t = M.snapFrame(p, state.playhead);
  const inside = (c) => t > c.start + EPS && t < M.clipEnd(c) - EPS && !isLocked(p, c);
  let targets = selectedClips().filter(inside);
  if (!targets.length) targets = p.clips.filter(inside);
  if (!targets.length) {
    toast('Coloca el cursor sobre un clip para cortarlo');
    return 0;
  }
  mutate('Cortar', (proj) => {
    for (const c of targets) M.splitClip(proj, c, t);
  });
  return targets.length;
}

export function splitClipAt(clipId, t) {
  return mutate('Cortar', (p) => {
    const c = M.clipById(p, clipId);
    return c && !isLocked(p, c) ? M.splitClip(p, c, t) : null;
  });
}

export function splitAllAt(t) {
  return mutate('Cortar todas las pistas', (p) => {
    let n = 0;
    for (const c of [...p.clips]) if (!isLocked(p, c) && M.splitClip(p, c, t)) n++;
    return n;
  });
}

/** Elimina la selección. En la pista principal, con "cerrar huecos" activo, el resto se recorre. */
export function deleteSelection(opts = {}) {
  const p0 = state.project;
  const clips = selectedClips().filter((c) => !isLocked(p0, c));
  if (!clips.length) return;
  const ripple = opts.ripple ?? state.ripple;
  const skippedNames = new Set();
  mutate('Eliminar', (p) => {
    const main = M.mainTrack(p);
    for (const c of [...clips].sort((a, b) => b.start - a.start)) {
      const i = p.clips.findIndex((x) => x.id === c.id);
      if (i < 0) continue;
      p.clips.splice(i, 1);
      if (ripple && main && c.trackId === main.id) {
        for (const t of M.rippleShift(p, M.clipEnd(c), -c.duration)) skippedNames.add(t.name);
      }
    }
  });
  select([]);
  if (skippedNames.size) toast(`No se recorrió ${[...skippedNames].join(', ')}: un clip cruza el corte`);
}

export function duplicateSelection() {
  const clips = selectedClips();
  if (!clips.length) return;
  const ids = mutate('Duplicar', (p) => {
    const out = [];
    for (const c of clips) {
      const copy = M.cloneClip(c);
      copy.start = M.snapFrame(p, M.resolveStart(p, c.trackId, M.clipEnd(c), c.duration));
      p.clips.push(copy);
      out.push(copy.id);
    }
    return out;
  });
  select(ids);
}

let clipboard = null;

export function copySelection() {
  const clips = selectedClips();
  if (!clips.length) return false;
  const p = state.project;
  const t0 = Math.min(...clips.map((c) => c.start));
  clipboard = clips.map((c) => {
    const kind = M.kindOf(c.type);
    return { clip: deepClone(c), offset: c.start - t0, kind, trackIndex: p.tracks.filter((t) => t.kind === kind).findIndex((t) => t.id === c.trackId) };
  });
  toast(clips.length === 1 ? 'Clip copiado' : `${clips.length} clips copiados`);
  return true;
}

export function pasteAtPlayhead() {
  if (!clipboard) return;
  const ids = mutate('Pegar', (p) => {
    const out = [];
    const t0 = M.snapFrame(p, state.playhead);
    for (const item of clipboard) {
      if (item.clip.mediaId && !M.mediaById(p, item.clip.mediaId)) continue;
      const c = M.cloneClip(item.clip);
      const start = t0 + item.offset;
      const same = p.tracks.filter((t) => t.kind === item.kind);
      let track = same[item.trackIndex];
      if (!track || track.locked || !M.rangeIsFree(p, track.id, start, c.duration)) {
        track = M.findFreeTrack(p, item.kind, start, c.duration) || M.addTrack(p, item.kind);
      }
      c.trackId = track.id;
      c.start = start;
      p.clips.push(c);
      out.push(c.id);
    }
    return out;
  });
  if (ids.length) select(ids);
}

export function selectAll() {
  select(state.project.clips.map((c) => c.id));
}

/** Salta al corte anterior o siguiente. */
export function jumpEdit(dir) {
  const p = state.project;
  const pts = new Set([0]);
  for (const c of p.clips) {
    pts.add(Math.round(c.start * 1e4) / 1e4);
    pts.add(Math.round(M.clipEnd(c) * 1e4) / 1e4);
  }
  const sorted = [...pts].sort((a, b) => a - b);
  const t = state.playhead;
  const target = dir > 0 ? sorted.find((x) => x > t + 1e-3) : [...sorted].reverse().find((x) => x < t - 1e-3);
  if (target !== undefined) setPlayhead(target);
}

/** Separa el audio de un clip de video en un clip propio. */
export function detachAudio(clip) {
  const p0 = state.project;
  if (clip.type !== 'video' || !M.clipHasAudio(p0, clip)) return;
  const audio = mutate('Separar audio', (p) => {
    const track = M.findFreeTrack(p, 'audio', clip.start, clip.duration) || M.addTrack(p, 'audio');
    const a = {
      id: `c_${Math.random().toString(36).slice(2, 10)}a`,
      trackId: track.id,
      type: 'audio',
      mediaId: clip.mediaId,
      name: clip.name,
      start: clip.start,
      in: clip.in,
      duration: clip.duration,
      volume: clip.volume,
      muted: clip.muted,
      audioFadeIn: clip.audioFadeIn,
      audioFadeOut: clip.audioFadeOut,
      audioFx: clip.audioFx,
      audioTransIn: null,
      kf: clip.kf.volume ? { volume: deepClone(clip.kf.volume) } : {},
    };
    clip.audioDetached = true;
    p.clips.push(a);
    return a;
  });
  select(audio.id);
}

// ------------------------------------------------------------------ pistas ----

function renumber(p) {
  const v = M.videoTracks(p);
  v.forEach((t, i) => (t.name = `V${v.length - i}`));
  M.audioTracks(p).forEach((t, i) => (t.name = `A${i + 1}`));
}

export function addTrack(kind) {
  return mutate('Añadir pista', (p) => {
    const t = M.addTrack(p, kind);
    renumber(p);
    return t;
  });
}

export function removeTrack(trackId) {
  const p0 = state.project;
  const track = M.trackById(p0, trackId);
  if (!track) return;
  if (p0.tracks.filter((t) => t.kind === track.kind).length <= 1) {
    toast('Debe quedar al menos una pista de cada tipo');
    return;
  }
  mutate('Eliminar pista', (p) => {
    p.clips = p.clips.filter((c) => c.trackId !== trackId);
    p.tracks = p.tracks.filter((t) => t.id !== trackId);
    renumber(p);
  });
}

export function toggleTrack(trackId, flag) {
  mutate('Pista', (p) => {
    const t = M.trackById(p, trackId);
    if (t) t[flag] = !t[flag];
  });
}

// ------------------------------------------------------------- propiedades ----

/** Asigna una propiedad animable: si tiene keyframes, crea o actualiza el del cursor. */
export function setClipProp(clip, prop, value, label = 'Ajustar') {
  mutate(label, () => setProp(clip, prop, clipTs(clip), value), { coalesce: `${clip.id}:${prop}` });
}

export function setClipField(clip, field, value, label = 'Ajustar') {
  mutate(label, () => {
    clip[field] = value;
  }, { coalesce: `${clip.id}:${field}` });
}

export function toggleKeyframe(obj, prop, clip, e = 'ease') {
  mutate('Keyframe', () => toggleKey(obj, prop, clipTs(clip), { e }));
}

export function gotoKeyframe(obj, prop, clip, dir) {
  const k = neighborKey(obj, prop, clipTs(clip), dir);
  if (!k) return;
  const fd = M.frameDur(state.project);
  setPlayhead(clamp(tsToTimeline(clip, k.t), clip.start, M.clipEnd(clip) - fd));
}

export function setTextProp(clip, key, value) {
  mutate('Texto', () => {
    clip.text[key] = value;
    if (key === 'content') clip.name = String(value).split('\n')[0].slice(0, 40) || 'Texto';
  }, { coalesce: `${clip.id}:text:${key}` });
}

// ------------------------------------------------------------ transiciones ----

export function applyTransition(clip, side, type, duration = DEFAULT_TRANSITION_DURATION) {
  mutate('Transición', (p) => {
    const c = M.clipById(p, clip.id);
    if (!c || !M.isVisual(c)) return;
    if (side === 'out') {
      const next = M.nextAdjacent(p, c);
      if (next && M.isVisual(next)) {
        next.transIn = { type, duration };
        c.transOut = null;
      } else c.transOut = { type, duration };
    } else c.transIn = { type, duration };
  });
}

export function removeTransition(clip, side) {
  mutate('Quitar transición', () => {
    if (side === 'out') clip.transOut = null;
    else clip.transIn = null;
  });
}

export function setTransitionDuration(clip, side, duration) {
  mutate('Duración de transición', () => {
    const tr = side === 'out' ? clip.transOut : clip.transIn;
    if (tr) tr.duration = Math.max(0.1, duration);
  }, { coalesce: `${clip.id}:tr:${side}` });
}

export function applyAudioTransition(clip, side, type, duration = DEFAULT_TRANSITION_DURATION) {
  mutate('Transición de audio', (p) => {
    const c = M.clipById(p, clip.id);
    if (!c || !M.clipHasAudio(p, c)) return;
    if (side === 'out') {
      const next = M.nextAdjacent(p, c);
      if (next && M.clipHasAudio(p, next)) next.audioTransIn = { type, duration };
      else c.audioFadeOut = Math.min(duration, c.duration);
    } else c.audioTransIn = { type, duration };
  });
}

// ----------------------------------------------------------------- efectos ----

export function addEffect(clip, type) {
  const def = effectById(type);
  if (!def || !clip.effects) return;
  mutate('Añadir efecto', () => {
    const ex = clip.effects.find((e) => e.type === type);
    if (ex) ex.enabled = true;
    else clip.effects.push(M.makeEffect(def));
  });
}

export function removeEffect(clip, id) {
  mutate('Quitar efecto', () => {
    clip.effects = clip.effects.filter((e) => e.id !== id);
  });
}

export function setEffectAmount(clip, effect, value) {
  mutate('Efecto', () => setProp(effect, 'amount', clipTs(clip), value), { coalesce: `${effect.id}:amount` });
}

export function setAudioFx(clip, fxId) {
  mutate('Efecto de audio', () => {
    clip.audioFx = fxId || null;
  });
}

// ------------------------------------------------------------------- color ----

export function applyColorPreset(clips, presetId) {
  const targets = clips.filter((c) => c.type === 'video' || c.type === 'image');
  if (!targets.length) return false;
  mutate('Plantilla de color', () => {
    for (const c of targets) c.color = presetId === 'none' ? null : colorFromPreset(presetId, c.color ? c.color.intensity : 1);
  });
  return true;
}

export function setColorParam(clip, key, value) {
  mutate('Color', () => {
    if (!clip.color) clip.color = { ...deepClone(COLOR_DEFAULT), preset: 'custom' };
    clip.color[key] = value;
  }, { coalesce: `${clip.id}:color:${key}` });
}

// -------------------------------------------------------------------- zoom ----

export function addZoom(clip, extra = {}) {
  if (!clip.zooms) return null;
  const zoom = mutate('Añadir zoom', () => {
    const srcEnd = clip.in + clip.duration;
    let start = clipTs(clip);
    let end = Math.min(start + 2.5, srcEnd);
    if (end - start < 0.6) start = Math.max(clip.in, end - 2.5);
    const z = M.makeZoom(start, end, extra);
    clip.zooms.push(z);
    return z;
  });
  setUI({ activeZoom: zoom.id, activeCensor: null });
  return zoom;
}

export function updateZoom(clip, zoom, patch) {
  mutate('Zoom', () => Object.assign(zoom, patch), { coalesce: `${zoom.id}:${Object.keys(patch).join(',')}` });
}

export function removeZoom(clip, id) {
  mutate('Quitar zoom', () => {
    clip.zooms = clip.zooms.filter((z) => z.id !== id);
  });
  if (state.activeZoom === id) setUI({ activeZoom: null });
}

// ----------------------------------------------------------------- censura ----

const RECT_PROPS = ['x', 'y', 'w', 'h'];

export function addCensor(clip, rect, mode = state.censorMode, shape = state.censorShape) {
  if (!clip.censors) return null;
  if (clip.censors.length >= MAX_CENSORS) {
    toast(`Cada clip admite hasta ${MAX_CENSORS} zonas de censura`);
    return null;
  }
  const region = mutate('Añadir censura', () => {
    const r = M.makeCensor(rect, mode, shape);
    clip.censors.push(r);
    return r;
  });
  select(clip.id);
  setUI({ activeCensor: region.id, activeZoom: null });
  return region;
}

export function updateCensor(clip, region, patch) {
  mutate('Censura', () => {
    Object.assign(region, patch);
    if (patch.mode === 'blur' && !region.feather) region.feather = 0.2;
    if (patch.mode === 'pixelate') region.feather = 0;
  }, { coalesce: `${region.id}:${Object.keys(patch).join(',')}` });
}

/** Escribe la geometría de una región (respeta los keyframes). No abre paso de deshacer propio. */
export function writeCensorRect(clip, region, rect) {
  const ts = clipTs(clip);
  for (const k of RECT_PROPS) if (rect[k] !== undefined) setProp(region, k, ts, rect[k], { e: 'linear' });
}

/** Activa o desactiva el seguimiento manual: cada vez que muevas la zona se crea un keyframe. */
export function toggleCensorAnimation(clip, region) {
  mutate('Animar censura', () => {
    const ts = clipTs(clip);
    if (hasKeys(region, 'x')) for (const k of RECT_PROPS) clearKeys(region, k, ts);
    else for (const k of RECT_PROPS) setKey(region, k, ts, region[k], { e: 'linear' });
  });
}

export function removeCensor(clip, id) {
  mutate('Quitar censura', () => {
    clip.censors = clip.censors.filter((r) => r.id !== id);
  });
  if (state.activeCensor === id) setUI({ activeCensor: null });
}

// ---------------------------------------------------------------- proyecto ----

export function setProjectSettings(patch) {
  mutate('Ajustes del proyecto', (p) => {
    const oldFps = p.settings.fps;
    Object.assign(p.settings, patch, { matched: true });
    if (patch.fps && patch.fps !== oldFps) {
      const fd = M.frameDur(p);
      for (const c of p.clips) {
        const s = M.snapFrame(p, c.start);
        const e = Math.max(s + fd, M.snapFrame(p, M.clipEnd(c)));
        c.start = s;
        c.duration = e - s;
      }
    }
  });
}

export function renameProject(name) {
  mutate('Renombrar proyecto', (p) => {
    p.name = name || 'Proyecto sin título';
  }, { coalesce: 'project:name' });
}

export function removeMedia(mediaId) {
  removedMedia.add(mediaId);
  mutate('Quitar medio', (p) => {
    p.clips = p.clips.filter((c) => c.mediaId !== mediaId);
    p.media = p.media.filter((m) => m.id !== mediaId);
  });
  select(state.selection.filter((id) => M.clipById(state.project, id)));
}
