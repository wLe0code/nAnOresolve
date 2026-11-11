// Seguimiento automático para la censura: sigue lo que hay dentro de una zona (una placa, un
// rostro, un documento…) comparando fotograma a fotograma y crea los keyframes de posición y tamaño.

import { state, setUI, setPlayhead, beginTxn, endTxn, cancelTxn, touch } from '../core/store.js';
import * as M from '../core/model.js';
import * as A from '../core/actions.js';
import { evalProp, setKey } from '../core/keyframes.js';
import { clamp, h } from '../core/util.js';
import { previewUrl } from '../media/library.js';
import { engine } from '../playback/engine.js';
import { toast } from '../ui/widgets.js';
import { icon } from '../ui/icons.js';

const PROPS = ['x', 'y', 'w', 'h'];
let job = null;
let hud = null;

export const isTracking = () => !!job;

function once(el, event, timeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => done(false), timeout);
    const done = (ok) => {
      clearTimeout(timer);
      el.removeEventListener(event, onEvent);
      resolve(ok);
    };
    const onEvent = () => done(true);
    el.addEventListener(event, onEvent);
  });
}

/** Resta la media y normaliza. Devuelve la energía original (sirve para detectar zonas lisas). */
function normalize(a) {
  let mean = 0;
  for (let i = 0; i < a.length; i++) mean += a[i];
  mean /= a.length;
  let sq = 0;
  for (let i = 0; i < a.length; i++) {
    a[i] -= mean;
    sq += a[i] * a[i];
  }
  const norm = Math.sqrt(sq);
  if (norm > 1e-6) for (let i = 0; i < a.length; i++) a[i] /= norm;
  return norm / Math.sqrt(a.length);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Busca la plantilla T (tw×th, normalizada) dentro de S (sw×sh) por correlación cruzada normalizada. */
function search(T, tw, th, S, sw, sh) {
  const iw = sw + 1;
  const I = new Float64Array(iw * (sh + 1));
  const I2 = new Float64Array(iw * (sh + 1));
  for (let y = 0; y < sh; y++) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < sw; x++) {
      const v = S[y * sw + x];
      row += v;
      row2 += v * v;
      I[(y + 1) * iw + x + 1] = I[y * iw + x + 1] + row;
      I2[(y + 1) * iw + x + 1] = I2[y * iw + x + 1] + row2;
    }
  }
  const n = tw * th;
  const scoreAt = (ox, oy) => {
    const a = oy * iw + ox;
    const b = (oy + th) * iw + ox;
    const sum = I[b + tw] - I[a + tw] - I[b] + I[a];
    const sum2 = I2[b + tw] - I2[a + tw] - I2[b] + I2[a];
    const variance = sum2 - (sum * sum) / n;
    if (variance < 1e-3) return -1;
    let cross = 0;
    for (let y = 0; y < th; y++) {
      const so = (oy + y) * sw + ox;
      const to = y * tw;
      for (let x = 0; x < tw; x++) cross += T[to + x] * S[so + x];
    }
    return cross / Math.sqrt(variance);
  };
  const maxX = sw - tw;
  const maxY = sh - th;
  let best = { ox: maxX >> 1, oy: maxY >> 1, score: -2 };
  for (let oy = 0; oy <= maxY; oy += 2) {
    for (let ox = 0; ox <= maxX; ox += 2) {
      const sc = scoreAt(ox, oy);
      if (sc > best.score) best = { ox, oy, score: sc };
    }
  }
  const c = best;
  for (let oy = Math.max(0, c.oy - 1); oy <= Math.min(maxY, c.oy + 1); oy++) {
    for (let ox = Math.max(0, c.ox - 1); ox <= Math.min(maxX, c.ox + 1); ox++) {
      const sc = scoreAt(ox, oy);
      if (sc > best.score) best = { ox, oy, score: sc };
    }
  }
  return best;
}

/** Reduce la lista de muestras a los keyframes necesarios (Ramer–Douglas–Peucker en el tiempo). */
function simplify(samples, eps) {
  if (samples.length <= 2) return samples.slice();
  const keep = new Uint8Array(samples.length);
  keep[0] = 1;
  keep[samples.length - 1] = 1;
  const stack = [[0, samples.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A0 = samples[a];
    const B0 = samples[b];
    const span = B0.t - A0.t;
    let worst = -1;
    let worstErr = eps;
    for (let i = a + 1; i < b; i++) {
      const s = samples[i];
      const u = span > 0 ? (s.t - A0.t) / span : 0;
      let err = 0;
      for (const k of PROPS) err = Math.max(err, Math.abs(s[k] - (A0[k] + (B0[k] - A0[k]) * u)));
      if (err > worstErr) {
        worstErr = err;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return samples.filter((_, i) => keep[i]);
}

function smooth(samples) {
  const out = samples.map((s) => ({ ...s }));
  const avg = (i, k, r) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(samples.length - 1, i + r); j++) {
      sum += samples[j][k];
      n++;
    }
    return sum / n;
  };
  for (let i = 1; i < samples.length - 1; i++) {
    out[i].x = avg(i, 'x', 1);
    out[i].y = avg(i, 'y', 1);
    out[i].w = avg(i, 'w', 3);
    out[i].h = avg(i, 'h', 3);
  }
  return out;
}

function showHud(onStop) {
  if (!hud) {
    hud = {
      fill: h('div', { class: 'bar-fill' }),
      label: h('span', { class: 'hud-text' }, 'Siguiendo el objeto…'),
      stop: h('button', { class: 'btn small danger' }, 'Detener'),
    };
    hud.el = h('div', { class: 'hud-bar track-hud' }, h('span', { class: 'hud-ico', html: icon('track', 16) }), hud.label, h('div', { class: 'bar' }, hud.fill), hud.stop);
    document.getElementById('viewer-hud').append(hud.el);
  }
  hud.stop.onclick = onStop;
  hud.fill.style.width = '0%';
  hud.el.classList.add('show');
}

/**
 * Sigue el contenido de una zona de censura desde el cursor hasta el final del clip.
 * Si ya hay un seguimiento en marcha, lo detiene.
 */
export async function trackCensor(clip, region) {
  if (job) {
    job.cancelled = true;
    return;
  }
  const p = state.project;
  const media = M.mediaById(p, clip.mediaId);
  if (!media || media.type !== 'video') {
    toast('El seguimiento automático funciona con clips de video');
    return;
  }
  engine.pause();
  const ts0 = A.clipTs(clip);
  const tsEnd = Math.min(clip.in + clip.duration, region.end ?? Infinity, media.duration - 0.04);
  if (tsEnd - ts0 < 0.15) {
    toast('Coloca el cursor antes del final del clip para seguir el objeto');
    return;
  }

  const j = { cancelled: false };
  job = j;
  setUI({ tracking: true });
  showHud(() => {
    j.cancelled = true;
  });

  const el = document.createElement('video');
  el.muted = true;
  el.preload = 'auto';
  el.src = previewUrl(media);
  let started = false;
  let message = null;
  try {
    if (!(await once(el, 'loadeddata', 8000))) throw new Error('No se pudo abrir el video');
    el.currentTime = ts0;
    await once(el, 'seeked', 6000);
    const vw = el.videoWidth;
    const vh = el.videoHeight;
    if (!vw || !vh) throw new Error('No se pudo leer el video');

    // Zona inicial en píxeles del video.
    const cur = {
      x: evalProp(region, 'x', ts0) * vw,
      y: evalProp(region, 'y', ts0) * vh,
      w: Math.max(8, evalProp(region, 'w', ts0) * vw),
      h: Math.max(8, evalProp(region, 'h', ts0) * vh),
    };
    // La plantilla se analiza a un tamaño fijo: el lado mayor queda en ~56 px.
    const k0 = Math.min(1, 56 / Math.max(cur.w, cur.h));
    const tw = Math.max(8, Math.round(cur.w * k0));
    const th = Math.max(8, Math.round(cur.h * k0));
    const R = Math.max(10, Math.round(Math.max(tw, th) * 0.6));
    const sw = tw + 2 * R;
    const sh = th + 2 * R;

    const cv = new OffscreenCanvas(sw, sh);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const sample = (sx, sy, w, hh, dw, dh) => {
      if (cv.width !== dw || cv.height !== dh) {
        cv.width = dw;
        cv.height = dh;
      }
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, dw, dh);
      ctx.drawImage(el, sx, sy, w, hh, 0, 0, dw, dh);
      const d = ctx.getImageData(0, 0, dw, dh).data;
      const out = new Float32Array(dw * dh);
      for (let i = 0, q = 0; i < out.length; i++, q += 4) out[i] = d[q] * 0.299 + d[q + 1] * 0.587 + d[q + 2] * 0.114;
      return out;
    };
    const patchAt = (cx, cy, w, hh) => {
      const a = sample(cx - w / 2, cy - hh / 2, w, hh, tw, th);
      const energy = normalize(a);
      return { a, energy };
    };

    const first = patchAt(cur.x, cur.y, cur.w, cur.h);
    if (first.energy < 2) throw new Error('La zona es demasiado lisa para seguirla. Dibújala sobre algo con detalle (bordes, letras…).');
    const T0 = first.a;
    let T = Float32Array.from(T0);

    const samples = [{ t: ts0, x: cur.x / vw, y: cur.y / vh, w: cur.w / vw, h: cur.h / vh }];
    let vel = { x: 0, y: 0 };
    let lastT = ts0;
    let lost = 0;
    let lastUi = 0;

    beginTxn('Seguir objeto');
    started = true;
    // Los keyframes anteriores del tramo se sustituyen por los nuevos.
    for (const k of PROPS) {
      const v0 = evalProp(region, k, ts0);
      if (region.kf && region.kf[k]) region.kf[k] = region.kf[k].filter((key) => key.t < ts0 - 1e-4 || key.t > tsEnd + 1e-4);
      setKey(region, k, ts0, v0, { e: 'linear' });
    }

    const process = (mt) => {
      const dt = mt - lastT;
      if (dt <= 1e-4) return true;
      const k = tw / cur.w; // píxeles de análisis por píxel de video
      const px = cur.x + vel.x * dt;
      const py = cur.y + vel.y * dt;
      const S = sample(px - cur.w / 2 - R / k, py - cur.h / 2 - R / k, sw / k, sh / k, sw, sh);
      const m = search(T, tw, th, S, sw, sh);
      if (m.score < 0.3) {
        lost++;
        lastT = mt;
        return lost < 5;
      }
      lost = 0;
      let nx = px - cur.w / 2 - R / k + (m.ox + tw / 2) / k;
      let ny = py - cur.h / 2 - R / k + (m.oy + th / 2) / k;
      nx = clamp(nx, 0, vw);
      ny = clamp(ny, 0, vh);

      // ¿El objeto se acerca o se aleja? Prueba un tamaño algo mayor y algo menor.
      let bestPatch = patchAt(nx, ny, cur.w, cur.h);
      let bestScore = dot(T, bestPatch.a);
      let scale = 1;
      for (const s of [0.965, 1.035]) {
        const cand = patchAt(nx, ny, cur.w * s, cur.h * s);
        const sc = dot(T, cand.a);
        if (sc > bestScore + 0.012) {
          bestScore = sc;
          bestPatch = cand;
          scale = s;
        }
      }
      if (scale !== 1) {
        const w = clamp(cur.w * scale, 8, vw * 0.95);
        cur.h *= w / cur.w;
        cur.w = w;
      }
      vel = { x: ((nx - cur.x) / dt) * 0.7 + vel.x * 0.3, y: ((ny - cur.y) / dt) * 0.7 + vel.y * 0.3 };
      cur.x = nx;
      cur.y = ny;
      lastT = mt;

      if (bestScore > 0.55) {
        for (let i = 0; i < T.length; i++) T[i] = T[i] * 0.88 + bestPatch.a[i] * 0.1 + T0[i] * 0.02;
        normalize(T);
      }

      const smp = { t: mt, x: cur.x / vw, y: cur.y / vh, w: cur.w / vw, h: cur.h / vh };
      samples.push(smp);
      for (const key of PROPS) setKey(region, key, mt, smp[key], { e: 'linear' });
      const now = performance.now();
      if (now - lastUi > 110) {
        lastUi = now;
        hud.fill.style.width = `${Math.round(((mt - ts0) / (tsEnd - ts0)) * 100)}%`;
        setPlayhead(clamp(A.tsToTimeline(clip, mt), clip.start, M.clipEnd(clip) - M.frameDur(p)));
        touch();
      }
      return true;
    };

    // Reproduce el video y analiza cada fotograma que se presenta.
    const cost = ((2 * R + 1) * (2 * R + 1) * tw * th) / 4;
    el.playbackRate = cost < 2.5e6 ? 2 : 1;
    let stalled = false;
    if (el.requestVideoFrameCallback) {
      await new Promise((resolve) => {
        let done = false;
        let lastCb = performance.now();
        let watch = 0;
        const finish = () => {
          if (done) return;
          done = true;
          clearInterval(watch);
          el.pause();
          resolve();
        };
        const onFrame = (_now, meta) => {
          if (done) return;
          lastCb = performance.now();
          const mt = meta.mediaTime;
          if (j.cancelled || mt >= tsEnd - 1e-3) return finish();
          if (mt > lastT + 1e-4 && !process(mt)) return finish();
          el.requestVideoFrameCallback(onFrame);
          return undefined;
        };
        el.requestVideoFrameCallback(onFrame);
        el.addEventListener('ended', finish, { once: true });
        el.play().catch(finish);
        watch = setInterval(() => {
          if (j.cancelled) finish();
          else if (performance.now() - lastCb > 2500) {
            stalled = true;
            finish();
          }
        }, 150);
      });
    } else stalled = true;

    // Plan B: avanzar a saltos si el reproductor no entrega fotogramas.
    if (stalled && !j.cancelled && lost < 5 && lastT < tsEnd - 0.2) {
      const stepT = 1 / Math.min(media.fps || 30, 15);
      for (let t = lastT + stepT; t < tsEnd && !j.cancelled; t += stepT) {
        el.currentTime = t;
        if (!(await once(el, 'seeked', 5000))) break;
        if (!process(t)) break;
      }
    }

    // Suaviza la trayectoria y deja solo los keyframes necesarios.
    const final = simplify(smooth(samples), 0.0035);
    for (const k of PROPS) region.kf[k] = (region.kf[k] || []).filter((key) => key.t < ts0 - 1e-4 || key.t > lastT + 1e-4);
    for (const s of final) for (const k of PROPS) setKey(region, k, s.t, s[k], { e: 'linear' });
    touch();
    endTxn();
    started = false;
    setPlayhead(clamp(A.tsToTimeline(clip, lastT), clip.start, M.clipEnd(clip) - M.frameDur(p)));

    if (lost >= 5) message = ['Se perdió el objeto. Recoloca la zona y pulsa de nuevo "Seguir objeto" para continuar desde ahí.', 'info'];
    else if (j.cancelled) message = ['Seguimiento detenido. Se conservan los keyframes creados.', 'info'];
    else message = [`Seguimiento completado: ${final.length} keyframes`, 'ok'];
  } catch (e) {
    if (started) cancelTxn();
    message = [e.message || 'No se pudo seguir el objeto', 'error'];
  } finally {
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {
      /* sin efecto */
    }
    if (hud) hud.el.classList.remove('show');
    job = null;
    setUI({ tracking: false });
  }
  if (message) toast(message[0], message[1]);
}
