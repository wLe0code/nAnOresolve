// Keyframes: cada objeto animable (clip, región de censura) guarda `kf = { propiedad: [{ t, v, e }] }`.
// `t` es tiempo de origen del clip (segundos dentro del medio), así los cortes no desplazan la animación.

export const EASINGS = {
  linear: (u) => u,
  ease: (u) => u * u * (3 - 2 * u),
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  hold: () => 0,
};

export const EASING_LABELS = { ease: 'Suave', linear: 'Lineal', in: 'Acelerar', out: 'Frenar', hold: 'Mantener' };

export function hasKeys(obj, prop) {
  return !!(obj.kf && obj.kf[prop] && obj.kf[prop].length);
}

export function interp(keys, ts) {
  const n = keys.length;
  if (ts <= keys[0].t) return keys[0].v;
  if (ts >= keys[n - 1].t) return keys[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= ts) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (ts - a.t) / span;
  return a.v + (b.v - a.v) * (EASINGS[a.e] || EASINGS.ease)(u);
}

/** Valor de una propiedad en el tiempo de origen ts (con o sin keyframes). */
export function evalProp(obj, prop, ts) {
  const keys = obj.kf && obj.kf[prop];
  if (!keys || !keys.length) return obj[prop];
  return interp(keys, ts);
}

export function keyAt(obj, prop, ts, tol = 1 / 120) {
  const keys = obj.kf && obj.kf[prop];
  if (!keys) return null;
  for (const k of keys) if (Math.abs(k.t - ts) <= tol) return k;
  return null;
}

/** Crea o actualiza un keyframe. */
export function setKey(obj, prop, ts, v, opts = {}) {
  const tol = opts.tol ?? 1 / 120;
  if (!obj.kf) obj.kf = {};
  if (!obj.kf[prop]) obj.kf[prop] = [];
  const keys = obj.kf[prop];
  const existing = keys.find((k) => Math.abs(k.t - ts) <= tol);
  if (existing) {
    existing.v = v;
    if (opts.e) existing.e = opts.e;
    return existing;
  }
  const key = { t: ts, v, e: opts.e || 'ease' };
  let i = 0;
  while (i < keys.length && keys[i].t < ts) i++;
  keys.splice(i, 0, key);
  return key;
}

export function removeKey(obj, prop, ts, tol = 1 / 120) {
  const keys = obj.kf && obj.kf[prop];
  if (!keys) return false;
  const i = keys.findIndex((k) => Math.abs(k.t - ts) <= tol);
  if (i < 0) return false;
  // Al quitar el último keyframe la propiedad conserva su valor actual.
  if (keys.length === 1) obj[prop] = keys[0].v;
  keys.splice(i, 1);
  if (!keys.length) delete obj.kf[prop];
  return true;
}

export function clearKeys(obj, prop, ts) {
  if (!hasKeys(obj, prop)) return;
  obj[prop] = evalProp(obj, prop, ts);
  delete obj.kf[prop];
}

/** Asigna un valor: si la propiedad está animada crea/actualiza el keyframe en ts. */
export function setProp(obj, prop, ts, v, opts = {}) {
  if (hasKeys(obj, prop)) setKey(obj, prop, ts, v, opts);
  else obj[prop] = v;
}

/** Activa o desactiva el keyframe de la propiedad en ts. Devuelve true si quedó creado. */
export function toggleKey(obj, prop, ts, opts = {}) {
  if (keyAt(obj, prop, ts, opts.tol)) {
    removeKey(obj, prop, ts, opts.tol);
    return false;
  }
  setKey(obj, prop, ts, evalProp(obj, prop, ts), opts);
  return true;
}

/** Tiempos (ordenados, sin repetir) de todos los keyframes de un objeto. */
export function keyTimes(obj, props) {
  const out = [];
  if (!obj.kf) return out;
  for (const [prop, keys] of Object.entries(obj.kf)) {
    if (props && !props.includes(prop)) continue;
    for (const k of keys) out.push(k.t);
  }
  out.sort((a, b) => a - b);
  return out.filter((t, i) => i === 0 || t - out[i - 1] > 1e-4);
}

/** Keyframe anterior / siguiente respecto a ts para una propiedad. */
export function neighborKey(obj, prop, ts, dir) {
  const keys = obj.kf && obj.kf[prop];
  if (!keys) return null;
  if (dir < 0) {
    for (let i = keys.length - 1; i >= 0; i--) if (keys[i].t < ts - 1e-3) return keys[i];
  } else {
    for (const k of keys) if (k.t > ts + 1e-3) return k;
  }
  return null;
}

/** Mueve en bloque los keyframes cuyo tiempo coincide con `from` (en todas las propiedades dadas). */
export function shiftKeys(obj, from, to, tol = 1 / 120) {
  if (!obj.kf) return;
  for (const keys of Object.values(obj.kf)) {
    for (const k of keys) if (Math.abs(k.t - from) <= tol) k.t = to;
    keys.sort((a, b) => a.t - b.t);
  }
}

export function deleteKeysAt(obj, ts, tol = 1 / 120) {
  if (!obj.kf) return;
  for (const prop of Object.keys(obj.kf)) removeKey(obj, prop, ts, tol);
}
