// Biblioteca de medios: importación, comprobación de compatibilidad, proxys, formas de onda y miniaturas.
// Los datos de ejecución (bitmaps, picos, estado) viven aquí y no en el proyecto.

import { state, emit, mutateSilently } from '../core/store.js';
import { uid, clamp, rafThrottle } from '../core/util.js';

export const mediaUrl = (path) => `nano://app/__media__?p=${encodeURIComponent(path)}`;

export function cleanError(e) {
  return String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

const runtime = new Map();

/** Estado de ejecución de un medio. status: pending | loading | proxy | ready | error | offline */
export function rt(mediaId) {
  let r = runtime.get(mediaId);
  if (!r) {
    r = { status: 'pending', progress: 0, previewPath: null, peaks: null, poster: null, bitmap: null, error: null };
    runtime.set(mediaId, r);
  }
  return r;
}

export const isReady = (mediaId) => rt(mediaId).status === 'ready';
export const previewUrl = (media) => mediaUrl(rt(media.id).previewPath || media.path);

const notify = (id) => emit('media', id);
const notifyThumbs = rafThrottle(() => emit('thumbs'));

function once(el, event, timeout) {
  return new Promise((resolve) => {
    let timer = 0;
    const done = (ok) => {
      clearTimeout(timer);
      el.removeEventListener(event, onEvent);
      el.removeEventListener('error', onError);
      resolve(ok);
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    el.addEventListener(event, onEvent);
    el.addEventListener('error', onError);
    timer = setTimeout(() => done(false), timeout);
  });
}

function releaseElement(el) {
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* sin efecto */
  }
}

/** Comprueba que el motor de vista previa puede reproducir el archivo tal cual. */
async function testPlayable(url, media) {
  const el = document.createElement(media.type === 'video' ? 'video' : 'audio');
  el.muted = true;
  el.preload = 'auto';
  el.src = url;
  let ok = await once(el, 'loadeddata', 7000);
  if (ok && media.type === 'video' && !(el.videoWidth > 0)) ok = false;
  if (ok && Number.isFinite(el.duration) && Math.abs(el.duration - media.duration) > Math.max(0.75, media.duration * 0.03)) ok = false;
  if (ok && !Number.isFinite(el.duration)) ok = false;
  releaseElement(el);
  return ok;
}

async function loadBitmap(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('No se pudo leer la imagen');
  return createImageBitmap(await res.blob());
}

function buildPeakLevels(data) {
  const levels = [data];
  let cur = data;
  while (cur.length > 128) {
    const next = new Uint8Array(Math.ceil(cur.length / 2));
    for (let i = 0; i < next.length; i++) next[i] = Math.max(cur[i * 2], cur[i * 2 + 1] || 0);
    levels.push(next);
    cur = next;
  }
  return levels;
}

export const PEAKS_PER_SECOND = 50;

async function prepare(media) {
  const r = rt(media.id);
  try {
    r.status = 'loading';
    r.error = null;
    notify(media.id);

    if (media.type === 'image') {
      let path = media.path;
      if (!media.nativeHint) {
        r.status = 'proxy';
        notify(media.id);
        path = await window.nano.makeProxy(media);
        r.previewPath = path;
      }
      const bitmap = await loadBitmap(mediaUrl(path));
      r.bitmap = bitmap;
      r.poster = bitmap;
      if (!media.width || !media.height) {
        media.width = bitmap.width;
        media.height = bitmap.height;
      }
    } else {
      const native = media.nativeHint && (await testPlayable(mediaUrl(media.path), media));
      if (!native) {
        r.status = 'proxy';
        r.progress = 0;
        notify(media.id);
        // Si la imagen ya es reproducible se prueba primero una copia ligera (solo convierte el
        // audio); si el original falló pese a parecer compatible, se va directo a la completa.
        let full = !!media.nativeHint || media.type !== 'video' || !media.videoNative;
        let proxy = await window.nano.makeProxy(media, { full });
        if (!full && !(await testPlayable(mediaUrl(proxy), media))) {
          full = true;
          r.progress = 0;
          notify(media.id);
          proxy = await window.nano.makeProxy(media, { full });
        }
        r.previewPath = proxy;
        r.lightProxy = !full;
      }
    }
    r.status = 'ready';
    notify(media.id);

    if (media.type === 'video') makePoster(media);
    if (media.hasAudio) loadPeaks(media);
  } catch (e) {
    r.status = 'error';
    r.error = cleanError(e);
    notify(media.id);
  }
}

async function loadPeaks(media) {
  try {
    const data = await window.nano.peaks(media);
    if (data && data.length) {
      rt(media.id).peaks = buildPeakLevels(data instanceof Uint8Array ? data : new Uint8Array(data));
      notify(media.id);
    }
  } catch (e) {
    console.warn('Forma de onda no disponible', e);
  }
}

async function makePoster(media) {
  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.src = previewUrl(media);
  try {
    if (!(await once(el, 'loadeddata', 8000))) return;
    const t = Math.min(media.duration * 0.12, 2);
    if (t > 0.05) {
      el.currentTime = t;
      await once(el, 'seeked', 5000);
    }
    const w = 320;
    const h = Math.max(2, Math.round((w * el.videoHeight) / Math.max(1, el.videoWidth)));
    rt(media.id).poster = await createImageBitmap(el, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium' });
    notify(media.id);
  } catch (e) {
    console.warn('Sin miniatura', e);
  } finally {
    releaseElement(el);
  }
}

/** Importa archivos al proyecto. Devuelve los medios (nuevos o ya existentes). */
export async function importPaths(paths, onError) {
  const out = [];
  for (const p of paths) {
    const existing = state.project.media.find((m) => m.path.toLowerCase() === String(p).toLowerCase());
    if (existing) {
      out.push(existing);
      continue;
    }
    try {
      const info = await window.nano.probe(p);
      const media = { id: uid('m'), ...info };
      mutateSilently((project) => project.media.push(media));
      out.push(media);
      prepare(media);
    } catch (e) {
      const name = String(p).split(/[\\/]/).pop();
      if (onError) onError(name, cleanError(e));
    }
  }
  return out;
}

/** Tras abrir un proyecto: vuelve a analizar cada medio y prepara su vista previa. */
export async function reviveMedia(project) {
  for (const key of [...runtime.keys()]) if (!project.media.some((m) => m.id === key)) runtime.delete(key);
  await Promise.all(
    project.media.map(async (m) => {
      try {
        const info = await window.nano.probe(m.path);
        Object.assign(m, info);
        await prepare(m);
      } catch {
        const r = rt(m.id);
        r.status = 'offline';
        r.error = 'No se encuentra el archivo';
        notify(m.id);
      }
    })
  );
}

export function retryMedia(media) {
  return prepare(media);
}

export const TONEMAP_DEFAULT = { curve: 'hable', brightness: 0 };

/**
 * Cambia cómo se convierte a SDR un video HDR y vuelve a preparar su vista previa.
 * La exportación usa los mismos ajustes, así que sigue viéndose igual que en el editor.
 */
export async function setTonemap(mediaId, tonemap) {
  const media = state.project.media.find((m) => m.id === mediaId);
  if (!media) return;
  mutateSilently(() => {
    media.tonemap = { curve: tonemap.curve, brightness: tonemap.brightness };
  });
  const r = rt(media.id);
  r.poster = null;
  const th = thumbers.get(media.id);
  if (th) {
    releaseElement(th.el);
    thumbers.delete(media.id);
  }
  for (const [key, e] of [...thumbCache]) {
    if (key.startsWith(`${media.id}@`)) {
      e.bmp.close?.();
      thumbCache.delete(key);
    }
  }
  await prepare(media);
  emit('media-reload', media.id);
  notifyThumbs();
}

window.nano?.on('media:proxyProgress', ({ path, progress }) => {
  if (!state.project) return;
  const m = state.project.media.find((x) => x.path === path);
  if (!m) return;
  rt(m.id).progress = progress;
  notify(m.id);
});

// ------------------------------------------------------------- miniaturas ----

const THUMB_H = 72;
const MAX_THUMBS = 700;
const MAX_THUMBERS = 4;
const thumbCache = new Map();
const thumbers = new Map();
let stamp = 0;

/** La línea temporal lo llama al empezar a dibujar: las peticiones antiguas se descartan. */
export function beginThumbPass() {
  stamp++;
}

/** Miniatura del medio en un instante. Devuelve el bitmap si ya existe; si no, la encarga. */
export function thumb(media, time) {
  const r = rt(media.id);
  if (r.status !== 'ready') return null;
  if (media.type === 'image') return r.bitmap;
  if (media.type !== 'video') return null;
  const key = `${media.id}@${time.toFixed(2)}`;
  const hit = thumbCache.get(key);
  if (hit) {
    hit.used = stamp;
    return hit.bmp;
  }
  let th = thumbers.get(media.id);
  if (!th) {
    if (thumbers.size >= MAX_THUMBERS) {
      let oldest = null;
      for (const [id, t] of thumbers) if (!t.busy && (!oldest || t.used < thumbers.get(oldest).used)) oldest = id;
      if (oldest === null) return null;
      releaseElement(thumbers.get(oldest).el);
      thumbers.delete(oldest);
    }
    const el = document.createElement('video');
    el.muted = true;
    el.preload = 'auto';
    el.src = previewUrl(media);
    th = { el, queue: new Map(), busy: false, used: stamp, loaded: false };
    thumbers.set(media.id, th);
  }
  th.used = stamp;
  th.queue.set(key, { time, stamp });
  pump(th, media);
  return null;
}

async function pump(th, media) {
  if (th.busy) return;
  th.busy = true;
  try {
    if (!th.loaded) {
      th.loaded = th.el.readyState >= 1 || (await once(th.el, 'loadedmetadata', 8000));
      if (!th.loaded) {
        th.queue.clear();
        return;
      }
    }
    while (th.queue.size) {
      let bestKey = null;
      let best = null;
      for (const [k, v] of th.queue) {
        if (!best || v.stamp >= best.stamp) {
          best = v;
          bestKey = k;
        }
      }
      th.queue.delete(bestKey);
      if (best.stamp < stamp - 4) continue;
      const bmp = await grab(th.el, media, best.time);
      if (bmp) {
        thumbCache.set(bestKey, { bmp, used: stamp });
        if (thumbCache.size > MAX_THUMBS) evictThumbs();
        notifyThumbs();
      }
    }
  } catch (e) {
    console.warn('Miniaturas', e);
  } finally {
    th.busy = false;
  }
}

async function grab(el, media, time) {
  const t = clamp(time, 0, Math.max(0, media.duration - 0.05));
  if (Math.abs(el.currentTime - t) > 0.01 || el.readyState < 2) {
    el.currentTime = t;
    if (!(await once(el, 'seeked', 5000))) return null;
  }
  if (el.readyState < 2 || !el.videoWidth) return null;
  const w = Math.max(2, Math.round((THUMB_H * el.videoWidth) / el.videoHeight));
  try {
    return await createImageBitmap(el, { resizeWidth: w, resizeHeight: THUMB_H, resizeQuality: 'low' });
  } catch {
    return null;
  }
}

function evictThumbs() {
  const entries = [...thumbCache.entries()].sort((a, b) => a[1].used - b[1].used);
  for (let i = 0; i < entries.length / 4; i++) {
    entries[i][1].bmp.close?.();
    thumbCache.delete(entries[i][0]);
  }
}

/** Olvida los datos de ejecución (al cerrar o cambiar de proyecto). */
export function resetLibrary() {
  for (const th of thumbers.values()) releaseElement(th.el);
  thumbers.clear();
  for (const e of thumbCache.values()) e.bmp.close?.();
  thumbCache.clear();
  runtime.clear();
}
