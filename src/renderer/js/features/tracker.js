// Seguimiento automático para la censura: sigue lo que hay dentro de una zona (una placa, un
// rostro, un documento…) comparando fotograma a fotograma y crea los keyframes de posición y tamaño.

import { state, setUI, setPlayhead, beginTxn, endTxn, cancelTxn, touch } from '../core/store.js';
import * as M from '../core/model.js';
import * as A from '../core/actions.js';
import { evalProp, setKey } from '../core/keyframes.js';
import { clamp, h, formatTC } from '../core/util.js';
import { previewUrl } from '../media/library.js';
import { engine } from '../playback/engine.js';
import { toast } from '../ui/widgets.js';
import { icon } from '../ui/icons.js';

const PROPS = ['x', 'y', 'w', 'h'];

// Umbrales de parecido (correlación normalizada, de -1 a 1). Son relativos al parecido habitual
// de cada objeto (`typical`), porque no todas las imágenes se dejan comparar igual de bien.
const limits = (typical) => ({
  ok: clamp(typical * 0.62, 0.3, 0.5), // por debajo, el objeto se da por tapado
  back: clamp(typical * 0.75, 0.42, 0.62), // para darlo por reencontrado tras haberlo perdido
  learn: clamp(typical * 0.85, 0.5, 0.7), // solo se aprende el aspecto nuevo si se ve con claridad
  sure: clamp(typical * 0.92, 0.6, 0.8), // con este parecido se acepta aunque haya dado un salto
});
const MAX_HIDDEN = 1.2; // segundos que se sigue por inercia antes de detenerse

/** Suavizado 3×3: hace la comparación tolerante a desplazamientos de menos de un píxel. */
function blur3(a, w, hh) {
  const tmp = new Float32Array(a.length);
  for (let y = 0; y < hh; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) tmp[o + x] = (a[o + Math.max(0, x - 1)] + a[o + x] + a[o + Math.min(w - 1, x + 1)]) / 3;
  }
  for (let y = 0; y < hh; y++) {
    const o = y * w;
    const up = Math.max(0, y - 1) * w;
    const dn = Math.min(hh - 1, y + 1) * w;
    for (let x = 0; x < w; x++) a[o + x] = (tmp[up + x] + tmp[o + x] + tmp[dn + x]) / 3;
  }
  return a;
}
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
  // Ajuste por debajo del píxel: vértice de la parábola que pasa por el máximo y sus vecinos.
  const peak = (lo, mid, hi) => {
    const den = lo - 2 * mid + hi;
    return den < -1e-9 ? clamp((0.5 * (lo - hi)) / den, -0.5, 0.5) : 0;
  };
  let fx = 0;
  let fy = 0;
  if (best.ox > 0 && best.ox < maxX) fx = peak(scoreAt(best.ox - 1, best.oy), best.score, scoreAt(best.ox + 1, best.oy));
  if (best.oy > 0 && best.oy < maxY) fy = peak(scoreAt(best.ox, best.oy - 1), best.score, scoreAt(best.ox, best.oy + 1));
  return { ox: best.ox + fx, oy: best.oy + fy, score: best.score };
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
  const tsEnd = Math.min(M.sourceEnd(clip), region.end ?? Infinity, media.duration - 0.04);
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

    // Cada fotograma se copia una sola vez y todo el análisis trabaja sobre esa copia: si se
    // leyera del video varias veces, este podría haber avanzado entre una lectura y la siguiente.
    const fk = Math.min(1, 1920 / vw);
    const frame = new OffscreenCanvas(Math.max(2, Math.round(vw * fk)), Math.max(2, Math.round(vh * fk)));
    const fctx = frame.getContext('2d');
    const grab = () => fctx.drawImage(el, 0, 0, frame.width, frame.height);
    grab();

    const cv = new OffscreenCanvas(sw, sh);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const sample = (sx, sy, w, hh, dw, dh) => {
      if (cv.width !== dw || cv.height !== dh) {
        cv.width = dw;
        cv.height = dh;
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, dw, dh);
      ctx.drawImage(frame, sx * fk, sy * fk, w * fk, hh * fk, 0, 0, dw, dh);
      const d = ctx.getImageData(0, 0, dw, dh).data;
      const out = new Float32Array(dw * dh);
      for (let i = 0, q = 0; i < out.length; i++, q += 4) out[i] = d[q] * 0.299 + d[q + 1] * 0.587 + d[q + 2] * 0.114;
      return blur3(out, dw, dh);
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
    let typical = 0; // parecido habitual del objeto cuando se ve bien
    let lastT = ts0;
    let hiddenAt = null; // instante en que se dejó de ver el objeto (null = a la vista)
    let gaveUp = false;
    let seen = { t: ts0, x: cur.x, y: cur.y }; // última vez que se vio con seguridad
    let lastUi = 0;

    /** Mejor coincidencia de la plantilla alrededor de (px, py), buscando `radius` píxeles de análisis. */
    const locate = (px, py, radius) => {
      const k = tw / cur.w; // píxeles de análisis por píxel de video
      const w = tw + 2 * radius;
      const hh = th + 2 * radius;
      const S = sample(px - cur.w / 2 - radius / k, py - cur.h / 2 - radius / k, w / k, hh / k, w, hh);
      const m = search(T, tw, th, S, w, hh);
      return { score: m.score, x: px - cur.w / 2 - radius / k + (m.ox + tw / 2) / k, y: py - cur.h / 2 - radius / k + (m.oy + th / 2) / k };
    };
    const progress = (mt, force) => {
      const now = performance.now();
      if (!force && now - lastUi < 110) return;
      lastUi = now;
      hud.label.textContent = hiddenAt === null ? 'Siguiendo el objeto…' : 'Objeto tapado: buscándolo…';
      hud.fill.style.width = `${Math.round(((mt - ts0) / (tsEnd - ts0)) * 100)}%`;
      setPlayhead(clamp(A.tsToTimeline(clip, mt), clip.start, M.clipEnd(clip) - M.frameDur(p)));
      touch();
    };

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
      const hidden = hiddenAt !== null;
      const px = clamp(cur.x + vel.x * dt, 0, vw);
      const py = clamp(cur.y + vel.y * dt, 0, vh);
      // Mientras está tapado se busca en una zona cada vez más amplia.
      const m = locate(px, py, hidden ? Math.round(R * (2 + Math.min(1.5, (mt - hiddenAt) * 1.5))) : R);
      // Un salto brusco con un parecido solo regular suele ser otra cosa que pasa por delante.
      const lim = limits(typical || m.score);
      const jump = Math.hypot(m.x - px, m.y - py);
      const gate = (0.35 * Math.min(cur.w, cur.h) + 3) * (m.score >= lim.learn ? 1 : 0.5) + 0.3 * Math.hypot(vel.x, vel.y) * dt;
      const found = hidden ? m.score >= lim.back : m.score >= lim.ok && (jump <= gate || m.score >= lim.sure);
      if (!found) {
        // Tapado: la zona sigue por inercia y no se guarda nada hasta volver a verlo.
        if (!hidden) {
          hiddenAt = lastT;
          // Inercia con la velocidad media del último medio segundo en que se vio bien.
          const last = samples[samples.length - 1];
          let ref = samples[0];
          for (const s of samples) if (s.t <= last.t - 0.5) ref = s;
          const span = last.t - ref.t;
          vel = span > 0.1 ? { x: ((last.x - ref.x) * vw) / span, y: ((last.y - ref.y) * vh) / span } : { x: 0, y: 0 };
        }
        cur.x = px;
        cur.y = py;
        lastT = mt;
        progress(mt);
        if (mt - hiddenAt > MAX_HIDDEN) {
          gaveUp = true;
          return false;
        }
        return true;
      }
      const nx = clamp(m.x, 0, vw);
      const ny = clamp(m.y, 0, vh);
      if (hidden) {
        // Reencontrado: la velocidad se recalcula con el tramo completo que estuvo oculto.
        hiddenAt = null;
        const span = Math.max(mt - seen.t, 1e-3);
        vel = { x: (nx - seen.x) / span, y: (ny - seen.y) / span };
        cur.x = nx - vel.x * dt;
        cur.y = ny - vel.y * dt;
      }

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

      seen = { t: mt, x: nx, y: ny };
      typical = typical ? typical * 0.9 + m.score * 0.1 : m.score;

      // El aspecto se actualiza poco a poco y solo cuando se ve con claridad, para no acabar
      // siguiendo a lo que lo tapa.
      if (bestScore > lim.learn) {
        for (let i = 0; i < T.length; i++) T[i] = T[i] * 0.88 + bestPatch.a[i] * 0.09 + T0[i] * 0.03;
        normalize(T);
      }

      const smp = { t: mt, x: cur.x / vw, y: cur.y / vh, w: cur.w / vw, h: cur.h / vh };
      samples.push(smp);
      for (const key of PROPS) setKey(region, key, mt, smp[key], { e: 'linear' });
      progress(mt);
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
          if (mt > lastT + 1e-4) {
            grab();
            if (!process(mt)) return finish();
          }
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
    if (stalled && !j.cancelled && !gaveUp && lastT < tsEnd - 0.2) {
      const stepT = 1 / Math.min(media.fps || 30, 15);
      for (let t = lastT + stepT; t < tsEnd && !j.cancelled; t += stepT) {
        el.currentTime = t;
        if (!(await once(el, 'seeked', 5000))) break;
        grab();
        if (!process(t)) break;
      }
    }

    // Suaviza la trayectoria y deja solo los keyframes necesarios. Si terminó con el objeto
    // tapado, el seguimiento llega hasta la última vez que se vio.
    const endT = samples[samples.length - 1].t;
    const final = simplify(smooth(samples), 0.0035);
    for (const k of PROPS) region.kf[k] = (region.kf[k] || []).filter((key) => key.t < ts0 - 1e-4 || key.t > endT + 1e-4);
    for (const s of final) for (const k of PROPS) setKey(region, k, s.t, s[k], { e: 'linear' });
    touch();
    endTxn();
    started = false;
    const stopAt = clamp(A.tsToTimeline(clip, endT), clip.start, M.clipEnd(clip) - M.frameDur(p));
    setPlayhead(stopAt);

    if (gaveUp || (hiddenAt !== null && !j.cancelled)) {
      message = [`El objeto dejó de verse en ${formatTC(stopAt, p.settings.fps)}. El seguimiento llega hasta ahí: si reaparece, recoloca la zona y pulsa de nuevo «Seguir objeto».`, 'info', { duration: 9000 }];
    } else if (j.cancelled) message = ['Seguimiento detenido. Se conservan los keyframes creados.', 'info'];
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
  if (message) toast(message[0], message[1], message[2]);
}
