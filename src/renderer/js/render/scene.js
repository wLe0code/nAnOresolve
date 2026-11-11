// Descripción de un fotograma: qué capas se dibujan en el instante t y con qué parámetros.
// Es una función pura del proyecto, compartida por la vista previa y la exportación.

import { clamp, mat } from '../core/util.js';
import { evalProp } from '../core/keyframes.js';
import { videoTracks, trackClips, clipEnd, mediaById, sourceTime, transInInfo, transOutInfo, zoomsAt, censorsAt } from '../core/model.js';
import { layoutText } from './textrender.js';

const T_EPS = 1e-6;

export function fit(mw, mh, pw, ph) {
  const s = Math.min(pw / mw, ph / mh);
  return [mw * s, mh * s];
}

function evalEffects(clip, ts) {
  const fx = { blur: 0, mosaic: 0, sharpen: 0, chroma: 0, vignette: 0, grain: 0, mirror: 0, flip: 0, invert: 0 };
  for (const e of clip.effects || []) {
    if (!e.enabled) continue;
    const a = clamp(evalProp(e, 'amount', ts) || 0, 0, 100) / 100;
    switch (e.type) {
      case 'blur': fx.blur = Math.max(fx.blur, a * 0.06); break;
      case 'mosaic': if (a > 0) fx.mosaic = Math.max(fx.mosaic, 0.004 + a * 0.08); break;
      case 'sharpen': fx.sharpen = Math.max(fx.sharpen, a * 1.5); break;
      case 'chroma': fx.chroma = Math.max(fx.chroma, a * 0.03); break;
      case 'vignette': fx.vignette = Math.max(fx.vignette, a); break;
      case 'grain': fx.grain = Math.max(fx.grain, a); break;
      case 'mirror': fx.mirror = 1; break;
      case 'flip': fx.flip = 1; break;
      case 'invert': fx.invert = 1; break;
      default: break;
    }
  }
  return fx;
}

/** Tamaño base (en píxeles de proyecto) de la imagen de un clip a escala 1. */
export function baseSize(project, clip) {
  const { width: W, height: H } = project.settings;
  if (clip.type === 'text') {
    const L = layoutText(clip.text, W);
    return [L.width, L.height];
  }
  const m = mediaById(project, clip.mediaId);
  return fit((m && m.width) || W, (m && m.height) || H, W, H);
}

/** Evalúa todas las propiedades visuales de un clip en el instante t. */
export function evalLayer(project, clip, t) {
  const ts = sourceTime(clip, t);
  const [baseW, baseH] = baseSize(project, clip);
  let opacity = clamp(evalProp(clip, 'opacity', ts), 0, 1);
  const local = t - clip.start;
  if (clip.fadeIn > 0 && local < clip.fadeIn) opacity *= clamp(local / clip.fadeIn, 0, 1);
  if (clip.fadeOut > 0 && clip.duration - local < clip.fadeOut) opacity *= clamp((clip.duration - local) / clip.fadeOut, 0, 1);
  return {
    id: clip.id,
    clip,
    kind: clip.type,
    ts,
    baseW,
    baseH,
    x: evalProp(clip, 'x', ts),
    y: evalProp(clip, 'y', ts),
    scale: Math.max(0.001, evalProp(clip, 'scale', ts)),
    rotation: evalProp(clip, 'rotation', ts),
    opacity,
    zooms: zoomsAt(clip, ts),
    censors: censorsAt(clip, ts),
    fx: evalEffects(clip, ts),
    color: clip.color,
  };
}

/** Matriz que lleva coordenadas locales (u - 0.5, v - 0.5) a píxeles de proyecto. */
export function layerMatrix(layer, W, H) {
  let m = mat.translate(W / 2 + layer.x, H / 2 + layer.y);
  if (layer.rotation) m = mat.mul(m, mat.rotate(layer.rotation));
  m = mat.mul(m, mat.scale(layer.scale));
  for (const z of layer.zooms) {
    const fx = (z.cx - 0.5) * layer.baseW;
    const fy = (z.cy - 0.5) * layer.baseH;
    m = mat.mul(m, mat.mul(mat.mul(mat.translate(fx, fy), mat.scale(z.s)), mat.translate(-fx, -fy)));
  }
  return mat.mul(m, mat.scale(layer.baseW, layer.baseH));
}

/** Construye la escena del instante t: elementos de abajo arriba. */
export function buildScene(project, t) {
  const { width, height, background } = project.settings;
  const items = [];
  const tracks = videoTracks(project).slice().reverse();
  for (const track of tracks) {
    if (track.hidden) continue;
    const clips = trackClips(project, track.id);
    let item = null;

    for (const c of clips) {
      if (!c.transIn) continue;
      const ti = transInInfo(project, c);
      if (ti && ti.between && ti.d > 0 && t >= ti.start - T_EPS && t < ti.end - T_EPS) {
        item = { transition: { type: ti.type, p: clamp((t - ti.start) / ti.d, 0, 1), a: evalLayer(project, ti.prev, t), b: evalLayer(project, c, t) } };
      }
    }

    if (!item) {
      const c = clips.find((x) => t >= x.start - T_EPS && t < clipEnd(x) - T_EPS);
      if (c) {
        const layer = evalLayer(project, c, t);
        const ti = c.transIn ? transInInfo(project, c) : null;
        const to = c.transOut ? transOutInfo(project, c) : null;
        if (ti && !ti.between && ti.d > 0 && t < ti.end - T_EPS) {
          item = { transition: { type: ti.type, p: clamp((t - ti.start) / ti.d, 0, 1), a: null, b: layer } };
        } else if (to && to.d > 0 && t >= to.start - T_EPS) {
          item = { transition: { type: to.type, p: clamp((t - to.start) / to.d, 0, 1), a: layer, b: null } };
        } else item = { layer };
      }
    }
    if (item) items.push(item);
  }
  return { t, width, height, background, items };
}

/** Lista plana de capas de una escena (de abajo arriba). */
export function sceneLayers(scene) {
  const out = [];
  for (const item of scene.items) {
    if (item.layer) out.push(item.layer);
    else {
      if (item.transition.a) out.push(item.transition.a);
      if (item.transition.b) out.push(item.transition.b);
    }
  }
  return out;
}

/** Capa visible más alta bajo un punto del proyecto (px). Devuelve { layer, u, v } o null. */
export function hitLayer(scene, px, py, filter) {
  const layers = sceneLayers(scene);
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (filter && !filter(layer)) continue;
    const inv = mat.invert(layerMatrix(layer, scene.width, scene.height));
    const [lx, ly] = mat.apply(inv, px, py);
    if (Math.abs(lx) <= 0.5 && Math.abs(ly) <= 0.5) return { layer, u: lx + 0.5, v: ly + 0.5 };
  }
  return null;
}
