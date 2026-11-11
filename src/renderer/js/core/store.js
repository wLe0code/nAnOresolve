// Estado global de la aplicación, eventos e historial (deshacer / rehacer).

const listeners = new Map();

export function on(event, cb) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(cb);
  return () => listeners.get(event).delete(cb);
}

export function emit(event, data) {
  const set = listeners.get(event);
  if (!set) return;
  for (const cb of [...set]) {
    try {
      cb(data);
    } catch (e) {
      console.error(`[evento ${event}]`, e);
    }
  }
}

export const state = {
  project: null,
  projectPath: null,
  dirty: false,

  playhead: 0,
  playing: false,
  selection: [], // ids de clips; el último es el principal

  tool: 'select', // 'select' | 'blade'
  snapping: true, // imán
  ripple: true, // cerrar huecos automáticamente en la pista principal
  workspace: 'cut', // 'cut' | 'edit' | 'color'

  pxPerSec: 60,
  scrollX: 0,

  viewerMode: null, // null | 'censor' | 'crop' | 'record'
  censorMode: 'pixelate', // modo por defecto al dibujar una censura
  censorShape: 'rect',
  activeCensor: null, // id de la región de censura seleccionada
  activeZoom: null, // id del zoom seleccionado
};

/** Cambia valores de interfaz y avisa con el evento 'ui' (lista de claves cambiadas). */
export function setUI(patch) {
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    if (state[k] !== v) {
      state[k] = v;
      changed.push(k);
    }
  }
  if (changed.length) emit('ui', changed);
}

export function setPlayhead(t, opts = {}) {
  const v = Math.max(0, t);
  if (v === state.playhead && !opts.force) return;
  state.playhead = v;
  emit('playhead', opts);
}

// ----------------------------------------------------------- selección ----

export function select(ids, opts = {}) {
  const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
  let next;
  if (opts.toggle) {
    next = [...state.selection];
    for (const id of list) {
      const i = next.indexOf(id);
      if (i >= 0) next.splice(i, 1);
      else next.push(id);
    }
  } else if (opts.add) {
    next = [...state.selection.filter((id) => !list.includes(id)), ...list];
  } else {
    next = list;
  }
  const same = next.length === state.selection.length && next.every((id, i) => id === state.selection[i]);
  if (same) return;
  const prevPrimary = state.selection[state.selection.length - 1];
  state.selection = next;
  if (next[next.length - 1] !== prevPrimary) {
    state.activeCensor = null;
    state.activeZoom = null;
  }
  emit('selection');
}

export const isSelected = (id) => state.selection.includes(id);

export function primaryClip() {
  const id = state.selection[state.selection.length - 1];
  return id ? state.project.clips.find((c) => c.id === id) || null : null;
}

export function selectedClips() {
  return state.selection.map((id) => state.project.clips.find((c) => c.id === id)).filter(Boolean);
}

// ------------------------------------------------------------ historial ----

const undoStack = [];
const redoStack = [];
const MAX_HISTORY = 150;
let txn = null;
let lastCoalesce = { key: null, time: 0 };

const snapshot = () => JSON.stringify(state.project);

function pushUndo(snap) {
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

function markDirty() {
  if (!state.dirty) {
    state.dirty = true;
    emit('dirty');
  }
}

/** Aplica un cambio al proyecto guardando un paso de deshacer. */
export function mutate(label, fn, opts = {}) {
  let before = null;
  if (!txn) {
    const now = performance.now();
    const coalesce = !!opts.coalesce && lastCoalesce.key === opts.coalesce && now - lastCoalesce.time < 900;
    if (!coalesce) before = snapshot();
    lastCoalesce = { key: opts.coalesce || null, time: now };
  }
  const result = fn(state.project);
  if (before !== null) pushUndo(before);
  if (!txn) {
    markDirty();
    emit('history');
  }
  emit('project', { label });
  return result;
}

/** Inicia una operación interactiva (arrastres): un solo paso de deshacer al terminar. */
export function beginTxn(label) {
  if (txn) {
    txn.depth++;
    return;
  }
  txn = { snap: snapshot(), label, depth: 1 };
  lastCoalesce = { key: null, time: 0 };
}

export function endTxn() {
  if (!txn) return;
  if (--txn.depth > 0) return;
  const before = txn.snap;
  txn = null;
  if (snapshot() !== before) {
    pushUndo(before);
    markDirty();
    emit('history');
  }
  emit('project', { label: 'txn-end' });
}

export function cancelTxn() {
  if (!txn) return;
  const snap = txn.snap;
  txn = null;
  restore(snap);
}

/** Notifica un cambio hecho directamente sobre el proyecto dentro de una transacción. */
export function touch(info) {
  emit('project', info || { label: 'touch' });
}

/** Cambio que no forma parte del historial (por ejemplo, importar medios). */
export function mutateSilently(fn) {
  const result = fn(state.project);
  markDirty();
  emit('project', { label: 'silent' });
  return result;
}

/** Medios quitados a propósito por el usuario (deshacer otra cosa no debe devolverlos). */
export const removedMedia = new Set();

function restore(json) {
  const current = state.project;
  const next = JSON.parse(json);
  // Los medios importados no se pierden al deshacer.
  for (const m of next.media) removedMedia.delete(m.id);
  if (current) {
    for (const m of current.media) {
      if (!next.media.some((x) => x.id === m.id) && !removedMedia.has(m.id)) next.media.push(m);
    }
  }
  state.project = next;
  const ids = new Set(next.clips.map((c) => c.id));
  const sel = state.selection.filter((id) => ids.has(id));
  if (sel.length !== state.selection.length) {
    state.selection = sel;
    emit('selection');
  }
  markDirty();
  emit('project', { label: 'restore', restore: true });
  emit('history');
}

export function undo() {
  if (txn || !undoStack.length) return false;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  return true;
}

export function redo() {
  if (txn || !redoStack.length) return false;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  return true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

/** Sustituye el proyecto completo (nuevo / abrir). */
export function loadProject(project, path = null) {
  undoStack.length = 0;
  redoStack.length = 0;
  txn = null;
  state.project = project;
  state.projectPath = path;
  state.dirty = false;
  state.selection = [];
  state.playhead = 0;
  state.activeCensor = null;
  state.activeZoom = null;
  state.viewerMode = null;
  emit('project', { label: 'load', load: true });
  emit('selection');
  emit('playhead', {});
  emit('history');
  emit('dirty');
  emit('ui', ['viewerMode']);
}

export function markSaved(path) {
  state.projectPath = path;
  state.dirty = false;
  emit('dirty');
}
