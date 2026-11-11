// Modelo del proyecto: pistas, clips y toda la aritmética de la línea temporal.
//
// Convenciones:
//  - Tiempos en segundos. `start`/`duration` de un clip están alineados a fotogramas del proyecto.
//  - `in` es el punto de entrada dentro del medio. Tiempo de origen: ts = in + (t - start).
//  - project.tracks está en orden de pantalla: pistas de video de arriba abajo (la última es la
//    principal, V1) y después las de audio.

import { uid, EPS, clamp, deepClone } from './util.js';
import { evalProp } from './keyframes.js';
import { TEXT_DEFAULT, ZOOM_DEFAULT } from './presets.js';

export const PROJECT_VERSION = 1;

export function newProject() {
  return {
    version: PROJECT_VERSION,
    app: 'nAnOresolve',
    name: 'Proyecto sin título',
    settings: { width: 1920, height: 1080, fps: 30, background: '#000000', matched: false },
    media: [],
    tracks: [
      { id: uid('t'), kind: 'video', name: 'V2', muted: false, hidden: false, locked: false },
      { id: uid('t'), kind: 'video', name: 'V1', muted: false, hidden: false, locked: false },
      { id: uid('t'), kind: 'audio', name: 'A1', muted: false, hidden: false, locked: false },
      { id: uid('t'), kind: 'audio', name: 'A2', muted: false, hidden: false, locked: false },
    ],
    clips: [],
  };
}

// --------------------------------------------------------------- consultas ----

export const frameDur = (project) => 1 / project.settings.fps;
export const snapFrame = (project, t) => Math.round(t * project.settings.fps) / project.settings.fps;
export const floorFrame = (project, t) => Math.floor(t * project.settings.fps + 1e-6) / project.settings.fps;
export const clipEnd = (c) => c.start + c.duration;
export const isVisual = (c) => c.type === 'video' || c.type === 'image' || c.type === 'text';
export const kindOf = (clipType) => (clipType === 'audio' ? 'audio' : 'video');
export const sourceTime = (clip, t) => clip.in + (t - clip.start);

export const trackById = (project, id) => project.tracks.find((t) => t.id === id) || null;
export const clipById = (project, id) => project.clips.find((c) => c.id === id) || null;
export const mediaById = (project, id) => project.media.find((m) => m.id === id) || null;

export function trackClips(project, trackId, ignore) {
  return project.clips.filter((c) => c.trackId === trackId && !(ignore && ignore.has(c.id))).sort((a, b) => a.start - b.start);
}

export const videoTracks = (project) => project.tracks.filter((t) => t.kind === 'video');
export const audioTracks = (project) => project.tracks.filter((t) => t.kind === 'audio');

/** Pista principal (V1): la que recibe los cortes y cierra huecos. */
export function mainTrack(project) {
  const v = videoTracks(project);
  return v[v.length - 1] || null;
}

export function projectDuration(project) {
  let d = 0;
  for (const c of project.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function clipHasAudio(project, clip) {
  if (clip.type === 'audio') return true;
  if (clip.type !== 'video' || clip.audioDetached) return false;
  const m = mediaById(project, clip.mediaId);
  return !!(m && m.hasAudio);
}

/** Límite de duración que permite el medio (Infinity para textos e imágenes). */
export function maxSourceDuration(project, clip) {
  if (clip.type === 'text' || clip.type === 'image') return Infinity;
  const m = mediaById(project, clip.mediaId);
  return m ? m.duration : Infinity;
}

// ---------------------------------------------------------------- creación ----

const visualProps = () => ({
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  opacity: 1,
  fadeIn: 0,
  fadeOut: 0,
  color: null,
  effects: [],
  censors: [],
  zooms: [],
  transIn: null,
  transOut: null,
});

const audioProps = () => ({ volume: 1, muted: false, audioFadeIn: 0, audioFadeOut: 0, audioFx: null, audioTransIn: null });

export function makeMediaClip(project, media, trackId, start) {
  const fd = frameDur(project);
  const duration = media.type === 'image' ? 5 : Math.max(fd, floorFrame(project, media.duration));
  const clip = { id: uid('c'), trackId, type: media.type, mediaId: media.id, name: media.name, start, in: 0, duration, kf: {} };
  if (media.type !== 'audio') Object.assign(clip, visualProps());
  if (media.type !== 'image') Object.assign(clip, audioProps());
  return clip;
}

export function makeTextClip(project, preset, trackId, start) {
  const { width, height } = project.settings;
  const k = height / 1080;
  const text = { ...TEXT_DEFAULT, ...deepClone(preset.text) };
  for (const p of ['size', 'strokeWidth', 'shadowBlur', 'shadowX', 'shadowY', 'bgPadding', 'spacing']) text[p] = Math.round(text[p] * k * 100) / 100;
  if (text.bgRadius < 500) text.bgRadius = Math.round(text.bgRadius * k);
  return {
    id: uid('c'),
    trackId,
    type: 'text',
    name: text.content,
    start,
    in: 0,
    duration: 4,
    ...visualProps(),
    x: Math.round(preset.pos[0] * width),
    y: Math.round(preset.pos[1] * height),
    fadeIn: 0.25,
    fadeOut: 0.25,
    text,
    kf: {},
  };
}

export function makeZoom(start, end, extra = {}) {
  return { id: uid('z'), ...ZOOM_DEFAULT, start, end, ...extra };
}

/** Región de censura. x, y = centro; w, h = tamaño; todo normalizado (0..1) sobre el fotograma del clip. */
export function makeCensor(rect, mode = 'pixelate', shape = 'rect') {
  return { id: uid('s'), mode, shape, x: rect.x, y: rect.y, w: rect.w, h: rect.h, strength: 50, feather: mode === 'blur' ? 0.2 : 0, start: null, end: null, enabled: true, kf: {} };
}

export function makeEffect(def) {
  return { id: uid('e'), type: def.id, amount: def.amount ?? 0, enabled: true, kf: {} };
}

// ------------------------------------------------------------- colocación ----

/** Posición libre más cercana a `desired` para un clip de `duration` en la pista. */
export function resolveStart(project, trackId, desired, duration, ignore) {
  const others = trackClips(project, trackId, ignore);
  let best = null;
  let gapStart = 0;
  const consider = (gs, ge) => {
    if (ge - gs < duration - EPS) return;
    const pos = clamp(desired, gs, Math.max(gs, ge - duration));
    if (best === null || Math.abs(pos - desired) < Math.abs(best - desired)) best = pos;
  };
  for (const c of others) {
    consider(gapStart, c.start);
    gapStart = Math.max(gapStart, clipEnd(c));
  }
  consider(gapStart, Infinity);
  return best === null ? gapStart : best;
}

export function rangeIsFree(project, trackId, start, duration, ignore) {
  const end = start + duration;
  return !project.clips.some((c) => c.trackId === trackId && !(ignore && ignore.has(c.id)) && c.start < end - EPS && clipEnd(c) > start + EPS);
}

/** Final del último clip de una pista. */
export function trackEnd(project, trackId) {
  let e = 0;
  for (const c of project.clips) if (c.trackId === trackId) e = Math.max(e, clipEnd(c));
  return e;
}

export function addTrack(project, kind) {
  const count = project.tracks.filter((t) => t.kind === kind).length;
  const track = { id: uid('t'), kind, name: `${kind === 'video' ? 'V' : 'A'}${count + 1}`, muted: false, hidden: false, locked: false };
  if (kind === 'video') project.tracks.unshift(track);
  else project.tracks.push(track);
  return track;
}

/** Primera pista del tipo dado con el rango libre (las de video se recorren de abajo arriba). */
export function findFreeTrack(project, kind, start, duration, opts = {}) {
  let tracks = project.tracks.filter((t) => t.kind === kind && !t.locked);
  if (kind === 'video') tracks = tracks.reverse();
  if (opts.skipMain && kind === 'video') tracks = tracks.slice(1);
  return tracks.find((t) => rangeIsFree(project, t.id, start, duration)) || null;
}

/**
 * Desplaza `delta` segundos los clips que empiezan en `from` o después.
 * Las pistas donde eso provocaría un solapamiento no se mueven; se devuelven en la lista.
 */
export function rippleShift(project, from, delta, opts = {}) {
  const skipped = [];
  if (Math.abs(delta) < EPS) return skipped;
  for (const track of project.tracks) {
    if (track.locked) continue;
    if (opts.onlyTrack && track.id !== opts.onlyTrack) continue;
    const clips = trackClips(project, track.id);
    const movers = clips.filter((c) => c.start >= from - EPS && !(opts.except && opts.except.has(c.id)));
    if (!movers.length) continue;
    if (delta < 0) {
      let limit = 0;
      for (const c of clips) if (!movers.includes(c)) limit = Math.max(limit, clipEnd(c));
      if (movers[0].start + delta < limit - EPS) {
        skipped.push(track);
        continue;
      }
    }
    for (const c of movers) c.start = Math.max(0, snapFrame(project, c.start + delta));
  }
  return skipped;
}

// ------------------------------------------------------------------ cortes ----

function renewIds(clip) {
  for (const list of [clip.effects, clip.censors, clip.zooms]) {
    if (list) for (const o of list) o.id = uid(o.id.split('_')[0] || 'o');
  }
}

/** Divide un clip en t. Devuelve la mitad derecha, o null si t no cae dentro del clip. */
export function splitClip(project, clip, t) {
  const fd = frameDur(project);
  t = snapFrame(project, t);
  if (t < clip.start + fd - EPS || t > clipEnd(clip) - fd + EPS) return null;
  const leftDur = t - clip.start;
  const right = deepClone(clip);
  right.id = uid('c');
  renewIds(right);
  right.start = t;
  right.in = clip.in + leftDur;
  right.duration = clip.duration - leftDur;
  clip.duration = leftDur;

  if ('transIn' in clip) {
    right.transIn = null;
    clip.transOut = null; // la salida se queda en la mitad derecha
    right.fadeIn = 0;
    clip.fadeOut = 0;
    // Los zooms que quedan por completo en una mitad se quitan de la otra.
    const cut = right.in;
    clip.zooms = clip.zooms.filter((z) => z.start < cut - EPS);
    right.zooms = right.zooms.filter((z) => z.end > cut + EPS);
  }
  if ('volume' in clip) {
    right.audioTransIn = null;
    right.audioFadeIn = 0;
    clip.audioFadeOut = 0;
  }
  project.clips.push(right);
  return right;
}

/** Duplica un clip (con ids nuevos) sin insertarlo. */
export function cloneClip(clip) {
  const c = deepClone(clip);
  c.id = uid('c');
  renewIds(c);
  return c;
}

// ------------------------------------------------- transiciones y ventanas ----

export function prevAdjacent(project, clip) {
  for (const c of project.clips) if (c.trackId === clip.trackId && c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < EPS) return c;
  return null;
}

export function nextAdjacent(project, clip) {
  const end = clipEnd(clip);
  for (const c of project.clips) if (c.trackId === clip.trackId && c.id !== clip.id && Math.abs(c.start - end) < EPS) return c;
  return null;
}

/**
 * Transición de entrada de un clip. Si hay un clip pegado antes, la transición va centrada en el
 * corte y usa material extra de ambos clips (como en DaVinci Resolve); si no, entra desde vacío.
 */
export function transInInfo(project, clip) {
  const tr = clip.transIn;
  if (!tr || !isVisual(clip)) return null;
  const prev = prevAdjacent(project, clip);
  if (prev && isVisual(prev)) {
    const d = Math.max(0, Math.min(tr.duration, prev.duration, clip.duration));
    return { type: tr.type, d, between: true, prev, start: clip.start - d / 2, end: clip.start + d / 2 };
  }
  const d = Math.min(tr.duration, clip.duration);
  return { type: tr.type, d, between: false, prev: null, start: clip.start, end: clip.start + d };
}

export function transOutInfo(project, clip) {
  const tr = clip.transOut;
  if (!tr || !isVisual(clip)) return null;
  const next = nextAdjacent(project, clip);
  if (next && next.transIn && isVisual(next)) return null;
  const d = Math.min(tr.duration, clip.duration);
  return { type: tr.type, d, start: clipEnd(clip) - d, end: clipEnd(clip) };
}

/** Intervalo de la línea temporal en el que la imagen del clip puede verse (incluye transiciones). */
export function videoWindow(project, clip) {
  let ws = clip.start;
  let we = clipEnd(clip);
  const ti = transInInfo(project, clip);
  if (ti && ti.between) ws = ti.start;
  const next = nextAdjacent(project, clip);
  if (next) {
    const tn = transInInfo(project, next);
    if (tn && tn.between) we = tn.end;
  }
  return [ws, we];
}

export function audioTransInfo(project, clip) {
  const tr = clip.audioTransIn;
  if (!tr) return null;
  const prev = prevAdjacent(project, clip);
  if (prev && clipHasAudio(project, prev)) {
    const d = Math.max(0, Math.min(tr.duration, prev.duration, clip.duration));
    return { type: tr.type, d, between: true, start: clip.start - d / 2, end: clip.start + d / 2 };
  }
  const d = Math.min(tr.duration, clip.duration);
  return { type: tr.type, d, between: false, start: clip.start, end: clip.start + d };
}

/** Intervalo en el que el audio del clip puede sonar (incluye fundidos cruzados). */
export function audioWindow(project, clip) {
  let ws = clip.start;
  let we = clipEnd(clip);
  const ti = audioTransInfo(project, clip);
  if (ti && ti.between) ws = ti.start;
  const next = nextAdjacent(project, clip);
  if (next && clipHasAudio(project, next)) {
    const tn = audioTransInfo(project, next);
    if (tn && tn.between) we = tn.end;
  }
  return [ws, we];
}

/** Intervalo en el que el medio del clip tiene que estar disponible (imagen o sonido). */
export function mediaWindow(project, clip) {
  if (clip.type === 'audio') return audioWindow(project, clip);
  const [vs, ve] = videoWindow(project, clip);
  if (!clipHasAudio(project, clip)) return [vs, ve];
  const [as, ae] = audioWindow(project, clip);
  return [Math.min(vs, as), Math.max(ve, ae)];
}

/** Ganancia lineal del audio de un clip en el instante t de la línea temporal. */
export function audioGainAt(project, clip, t) {
  if (clip.muted) return 0;
  const track = trackById(project, clip.trackId);
  if (!track || track.muted) return 0;
  const end = clipEnd(clip);
  let g = Math.max(0, evalProp(clip, 'volume', sourceTime(clip, t)));

  const xin = audioTransInfo(project, clip);
  if (xin && xin.d > 0 && t < xin.end) {
    const p = clamp((t - xin.start) / xin.d, 0, 1);
    g *= xin.type === 'xfade-linear' ? p : Math.sin((p * Math.PI) / 2);
  } else if (t < clip.start) return 0;

  const next = nextAdjacent(project, clip);
  const xout = next && clipHasAudio(project, next) ? audioTransInfo(project, next) : null;
  if (xout && xout.between && xout.d > 0) {
    if (t > xout.end) return 0;
    if (t > xout.start) {
      const p = clamp((t - xout.start) / xout.d, 0, 1);
      g *= xout.type === 'xfade-linear' ? 1 - p : Math.cos((p * Math.PI) / 2);
    }
  } else if (t > end) return 0;

  if (clip.audioFadeIn > 0 && t < clip.start + clip.audioFadeIn) g *= Math.sin((clamp((t - clip.start) / clip.audioFadeIn, 0, 1) * Math.PI) / 2);
  if (clip.audioFadeOut > 0 && t > end - clip.audioFadeOut) g *= Math.sin((clamp((end - t) / clip.audioFadeOut, 0, 1) * Math.PI) / 2);
  return g;
}

// -------------------------------------------------------------------- zoom ----

const smooth = (u) => u * u * (3 - 2 * u);

/** Cuánto zoom (0..1) aporta un segmento en el tiempo de origen ts. */
export function zoomAmount(z, ts) {
  if (ts < z.start || ts > z.end) return 0;
  const len = z.end - z.start;
  if (len <= 0) return 0;
  const curve = z.curve === 'linear' ? (u) => u : smooth;
  if (z.mode === 'in') return curve(clamp((ts - z.start) / len, 0, 1));
  if (z.mode === 'out') return 1 - curve(clamp((ts - z.start) / len, 0, 1));
  const ramp = Math.min(Math.max(z.ramp, 0.001), len / 2);
  return curve(clamp(Math.min((ts - z.start) / ramp, (z.end - ts) / ramp), 0, 1));
}

/** Escalados de zoom activos en ts: [{ s, cx, cy }]. */
export function zoomsAt(clip, ts) {
  const out = [];
  if (!clip.zooms) return out;
  for (const z of clip.zooms) {
    const a = zoomAmount(z, ts);
    if (a > 0) out.push({ s: 1 + (z.scale - 1) * a, cx: z.cx, cy: z.cy });
  }
  return out;
}

/** Mayor escala (propia × zoom) que alcanza un clip; sirve para decidir la resolución de decodificación. */
export function maxScaleOf(clip) {
  let s = clip.scale || 1;
  if (clip.kf && clip.kf.scale) for (const k of clip.kf.scale) s = Math.max(s, k.v);
  let z = 1;
  for (const zoom of clip.zooms || []) z *= Math.max(1, zoom.scale);
  return s * z;
}

/** Regiones de censura activas en ts. */
export function censorsAt(clip, ts) {
  const out = [];
  if (!clip.censors) return out;
  for (const r of clip.censors) {
    if (!r.enabled) continue;
    if (r.start !== null && ts < r.start - EPS) continue;
    if (r.end !== null && ts > r.end + EPS) continue;
    out.push({
      id: r.id,
      mode: r.mode,
      shape: r.shape,
      strength: r.strength,
      feather: r.feather,
      x: evalProp(r, 'x', ts),
      y: evalProp(r, 'y', ts),
      w: evalProp(r, 'w', ts),
      h: evalProp(r, 'h', ts),
    });
  }
  return out;
}

// ----------------------------------------------------------------- archivo ----

/** Valida y normaliza un proyecto leído de disco. */
export function reviveProject(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tracks) || !Array.isArray(data.clips) || !Array.isArray(data.media)) {
    throw new Error('El archivo no es un proyecto de nAnOresolve');
  }
  if ((data.version || 0) > PROJECT_VERSION) throw new Error('El proyecto fue creado con una versión más reciente de nAnOresolve');
  const base = newProject();
  data.settings = { ...base.settings, ...(data.settings || {}) };
  data.name = data.name || base.name;
  data.version = PROJECT_VERSION;
  const trackIds = new Set(data.tracks.map((t) => t.id));
  data.clips = data.clips.filter((c) => trackIds.has(c.trackId));
  for (const c of data.clips) {
    if (!c.kf) c.kf = {};
    if (isVisual(c)) {
      const v = visualProps();
      for (const k of Object.keys(v)) if (c[k] === undefined) c[k] = v[k];
    }
    if (c.type === 'video' || c.type === 'audio') {
      const a = audioProps();
      for (const k of Object.keys(a)) if (c[k] === undefined) c[k] = a[k];
    }
    if (c.type === 'text') c.text = { ...TEXT_DEFAULT, ...(c.text || {}) };
  }
  return data;
}
