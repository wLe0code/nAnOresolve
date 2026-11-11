// Línea temporal: dibujo en canvas e interacción (seleccionar, mover, recortar, cortar con
// cuchilla, imán, zooms, keyframes, fundidos y arrastre desde los paneles).

import { state, on, emit, setUI, setPlayhead, select, isSelected, beginTxn, endTxn, touch, mutate } from '../core/store.js';
import * as M from '../core/model.js';
import * as A from '../core/actions.js';
import { clamp, h, clear, rafThrottle, EPS } from '../core/util.js';
import { keyTimes, shiftKeys, deleteKeysAt } from '../core/keyframes.js';
import { rt, thumb, beginThumbPass, PEAKS_PER_SECOND, importPaths } from '../media/library.js';
import { icon } from './icons.js';
import { contextMenu, toast } from './widgets.js';
import { getDrag, clearDrag } from './dnd.js';
import { transitionById, TEXT_PRESETS } from '../core/presets.js';

const SNAP_PX = 9;
const EDGE_PX = 7;
const TITLE_H = 16;
const MIN_PPS = 1.5;
const MAX_PPS = 640;

const COLORS = {
  video: { base: '#223f72', top: '#2f5aa3', border: '#6f9bea', wave: '#9fc1ff' },
  audio: { base: '#17503f', top: '#1f7059', border: '#56cba8', wave: '#86f0cf' },
  text: { base: '#4b2f80', top: '#6843ad', border: '#b196f5', wave: '#fff' },
  image: { base: '#6b4720', top: '#96672b', border: '#e7ab5f', wave: '#fff' },
};

const THUMB_STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
const niceStep = (dt) => THUMB_STEPS.find((s) => s >= dt) || 3600;

function fitText(ctx, text, maxW) {
  if (maxW <= 6) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${text.slice(0, lo)}…` : '';
}

/** Propiedades de fundido que controlan los tiradores de un clip. */
function fadeProps(project, clip) {
  if (clip.type === 'audio' || (clip.type === 'video' && M.clipHasAudio(project, clip))) return ['audioFadeIn', 'audioFadeOut'];
  return ['fadeIn', 'fadeOut'];
}

/** Todos los tiempos con keyframes de un clip (propios, de efectos y de censuras). */
function allKeyTimes(clip) {
  let times = keyTimes(clip);
  for (const list of [clip.effects, clip.censors]) for (const o of list || []) times = times.concat(keyTimes(o));
  times.sort((a, b) => a - b);
  return times.filter((t, i) => i === 0 || t - times[i - 1] > 1e-4);
}

export class Timeline {
  constructor() {
    this.main = document.getElementById('tl-main');
    this.ruler = document.getElementById('tl-ruler');
    this.canvas = document.getElementById('tl-canvas');
    this.tracksEl = document.getElementById('tl-tracks');
    this.hscroll = document.getElementById('tl-hscroll');
    this.hinner = document.getElementById('tl-hscroll-inner');
    this.headers = document.getElementById('tl-track-headers');
    this.playheadEl = document.getElementById('tl-playhead');
    this.ctx = this.canvas.getContext('2d');
    this.rctx = this.ruler.getContext('2d');

    this.w = 100;
    this.h = 100;
    this.rows = [];
    this.scrollY = 0;
    this.drag = null;
    this.hover = null;
    this.snapLine = null;
    this.blade = null;
    this.ghost = null;
    this.dropTarget = null;
    this.marquee = null;
    this.live = null;
    this.skipped = null;

    this.draw = rafThrottle(() => this.paint());
    this.bind();
    new ResizeObserver(() => this.resize()).observe(this.main);
    this.resize();
  }

  // --------------------------------------------------------------- medidas ----

  get pps() {
    return state.pxPerSec;
  }
  xOf(t) {
    return t * state.pxPerSec - state.scrollX;
  }
  tAt(x) {
    return (x + state.scrollX) / state.pxPerSec;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.tracksEl.getBoundingClientRect();
    this.w = Math.max(50, Math.floor(r.width));
    this.h = Math.max(30, Math.floor(r.height));
    for (const [cv, hh] of [[this.canvas, this.h], [this.ruler, this.ruler.clientHeight || 30]]) {
      cv.width = Math.round(this.w * dpr);
      cv.height = Math.round(hh * dpr);
      cv.style.width = `${this.w}px`;
      cv.style.height = `${hh}px`;
    }
    this.dpr = dpr;
    this.rulerH = this.ruler.clientHeight || 30;
    this.layout();
    this.renderHeaders();
    this.syncScrollbar();
    this.paint();
  }

  layout() {
    const p = state.project;
    if (!p) return;
    const gap = 3;
    const pad = 6;
    const groupGap = 7;
    const base = p.tracks.map((t) => (t.kind === 'video' ? 64 : 52));
    const sum = base.reduce((a, b) => a + b, 0);
    const extra = gap * (base.length - 1) + pad * 2 + groupGap;
    const k = clamp((this.h - extra) / sum, 0.6, 1.15);
    let y = pad;
    let prevKind = null;
    this.rows = p.tracks.map((track, i) => {
      if (prevKind && prevKind !== track.kind) y += groupGap;
      prevKind = track.kind;
      const row = { track, y, h: Math.round(base[i] * k) };
      y += row.h + gap;
      return row;
    });
    this.contentH = y - gap + pad;
    this.scrollY = clamp(this.scrollY, 0, Math.max(0, this.contentH - this.h));
  }

  rowAt(y) {
    const yy = y + this.scrollY;
    return this.rows.find((r) => yy >= r.y - 2 && yy <= r.y + r.h + 2) || null;
  }

  rowOf(trackId) {
    return this.rows.find((r) => r.track.id === trackId) || null;
  }

  contentWidth() {
    return Math.max(M.projectDuration(state.project), 30) * this.pps + this.w * 0.7;
  }

  syncScrollbar() {
    this.hinner.style.width = `${Math.round(this.contentWidth())}px`;
    if (Math.abs(this.hscroll.scrollLeft - state.scrollX) > 1) this.hscroll.scrollLeft = state.scrollX;
  }

  setScroll(x) {
    const max = Math.max(0, this.contentWidth() - this.w);
    setUI({ scrollX: clamp(x, 0, max) });
  }

  /** Cambia la escala manteniendo fijo el instante bajo `anchorX` (px). */
  setZoom(pps, anchorX = this.w / 2) {
    const t = this.tAt(anchorX);
    const next = clamp(pps, MIN_PPS, MAX_PPS);
    state.pxPerSec = next;
    state.scrollX = Math.max(0, t * next - anchorX);
    this.syncScrollbar();
    setUI({ pxPerSec: next + 1e-9 });
  }

  fit() {
    const dur = M.projectDuration(state.project);
    if (dur <= 0) return;
    state.scrollX = 0;
    state.pxPerSec = clamp((this.w - 60) / dur, MIN_PPS, MAX_PPS);
    this.syncScrollbar();
    setUI({ pxPerSec: state.pxPerSec + 1e-9 });
  }

  // --------------------------------------------------------------- eventos ----

  bind() {
    on('project', (info) => {
      if (!info || info.label !== 'touch') {
        this.layout();
        this.renderHeaders();
      }
      this.syncScrollbar();
      this.draw();
    });
    on('selection', () => this.draw());
    on('media', () => this.draw());
    on('thumbs', () => this.draw());
    on('playhead', (opts) => this.onPlayhead(opts));
    on('ui', (keys) => {
      if (keys.includes('scrollX') || keys.includes('pxPerSec')) {
        this.syncScrollbar();
        this.placePlayhead();
      }
      if (keys.includes('tool')) {
        this.blade = null;
        this.canvas.style.cursor = state.tool === 'blade' ? 'crosshair' : 'default';
      }
      this.draw();
    });

    this.hscroll.addEventListener('scroll', () => {
      if (Math.abs(this.hscroll.scrollLeft - state.scrollX) > 1) setUI({ scrollX: this.hscroll.scrollLeft });
    });

    const wheel = (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || e.altKey) {
        this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0022), e.clientX - rect.left);
      } else if (e.shiftKey && this.contentH > this.h) {
        this.scrollY = clamp(this.scrollY + e.deltaY, 0, Math.max(0, this.contentH - this.h));
        this.renderHeaders();
        this.draw();
      } else {
        this.setScroll(state.scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
      }
    };
    this.canvas.addEventListener('wheel', wheel, { passive: false });
    this.ruler.addEventListener('wheel', wheel, { passive: false });

    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.drag) {
        this.hover = null;
        this.blade = null;
        this.draw();
      }
    });
    this.canvas.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.canvas.addEventListener('contextmenu', (e) => this.onContext(e));

    this.ruler.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.ruler.addEventListener('pointermove', (e) => this.onRulerMove(e));
    this.ruler.addEventListener('pointerup', (e) => this.onRulerUp(e));

    for (const el of [this.canvas, this.ruler]) {
      el.addEventListener('dragover', (e) => this.onDragOver(e));
      el.addEventListener('dragleave', () => {
        this.ghost = null;
        this.dropTarget = null;
        this.draw();
      });
      el.addEventListener('drop', (e) => this.onDrop(e));
    }
  }

  pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------------------------------------------------------------- cursor ----

  placePlayhead() {
    const x = this.xOf(state.playhead);
    this.playheadEl.style.transform = `translateX(${Math.round(x * 10) / 10}px)`;
    this.playheadEl.style.visibility = x < -2 || x > this.w + 2 ? 'hidden' : 'visible';
  }

  onPlayhead() {
    const x = this.xOf(state.playhead);
    if (state.playing && !this.drag) {
      if (x > this.w - 30) this.setScroll(state.playhead * this.pps - this.w * 0.12);
      else if (x < 0) this.setScroll(state.playhead * this.pps - this.w * 0.2);
    }
    this.placePlayhead();
    // Los keyframes y el marcador de corte dependen del cursor.
    if (!state.playing) this.draw();
  }

  /** Hace visible el cursor si quedó fuera de la vista. */
  revealPlayhead() {
    const x = this.xOf(state.playhead);
    if (x < 20 || x > this.w - 20) this.setScroll(state.playhead * this.pps - this.w * 0.35);
  }

  onRulerDown(e) {
    if (e.button !== 0) return;
    this.ruler.setPointerCapture(e.pointerId);
    this.scrubbing = true;
    this.scrubTo(e);
  }
  onRulerMove(e) {
    if (this.scrubbing) this.scrubTo(e);
  }
  onRulerUp(e) {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    this.snapLine = null;
    try {
      this.ruler.releasePointerCapture(e.pointerId);
    } catch {
      /* ya liberado */
    }
    this.draw();
  }
  scrubTo(e) {
    const p = state.project;
    const x = e.clientX - this.ruler.getBoundingClientRect().left;
    let t = Math.max(0, this.tAt(x));
    this.snapLine = null;
    if (state.snapping && !e.ctrlKey) {
      const s = this.snapTime(t, this.snapPoints(null, false), SNAP_PX * 0.7);
      if (s.hit !== null) {
        t = s.t;
        this.snapLine = s.t;
      }
    }
    setPlayhead(M.snapFrame(p, t));
    if (x > this.w - 24) this.setScroll(state.scrollX + 14);
    else if (x < 24) this.setScroll(state.scrollX - 14);
    this.draw();
  }

  // ------------------------------------------------------------------ imán ----

  snapPoints(exclude, withPlayhead = true) {
    const pts = [0];
    if (withPlayhead) pts.push(state.playhead);
    for (const c of state.project.clips) {
      if (exclude && exclude.has(c.id)) continue;
      pts.push(c.start, M.clipEnd(c));
    }
    return pts;
  }

  snapTime(t, points, px = SNAP_PX) {
    const tol = px / this.pps;
    let best = null;
    let bestD = tol;
    for (const p of points) {
      const d = Math.abs(p - t);
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best === null ? { t, hit: null } : { t: best, hit: best };
  }

  // -------------------------------------------------------------- geometría ----

  geom(clip, row) {
    const x0 = this.xOf(clip.start);
    const x1 = this.xOf(M.clipEnd(clip));
    const y = row.y - this.scrollY;
    return { x0, x1, w: x1 - x0, y, h: row.h };
  }

  hitTest(x, y) {
    const p = state.project;
    const row = this.rowAt(y);
    if (!row) return { row: null, clip: null, zone: null, t: this.tAt(x) };
    const t = this.tAt(x);
    const clips = M.trackClips(p, row.track.id);
    const clip = clips.find((c) => this.xOf(c.start) <= x && x <= this.xOf(M.clipEnd(c)));
    if (!clip) return { row, clip: null, zone: null, t };
    const g = this.geom(clip, row);
    const selected = isSelected(clip.id);
    const ly = y - g.y;

    if (selected && clip.kf && ly >= g.h - 13) {
      for (const kt of allKeyTimes(clip)) {
        const kx = this.xOf(A.tsToTimeline(clip, kt));
        if (Math.abs(kx - x) <= 5 && kx >= g.x0 - 1 && kx <= g.x1 + 1) return { row, clip, zone: 'key', key: kt, t };
      }
    }
    if (clip.zooms && clip.zooms.length && g.h >= 30 && ly >= TITLE_H + 1 && ly <= TITLE_H + 14) {
      for (const z of clip.zooms) {
        const zx0 = Math.max(g.x0, this.xOf(A.tsToTimeline(clip, z.start)));
        const zx1 = Math.min(g.x1, this.xOf(A.tsToTimeline(clip, z.end)));
        if (x >= zx0 - 3 && x <= zx1 + 3) {
          const zone = x <= zx0 + 4 ? 'zoom-l' : x >= zx1 - 4 ? 'zoom-r' : 'zoom';
          return { row, clip, zone, zoom: z, t };
        }
      }
    }
    if ((selected || (this.hover && this.hover.clip === clip)) && g.w >= 48 && ly <= 16) {
      const [fi, fo] = fadeProps(p, clip);
      const fxIn = g.x0 + (clip[fi] || 0) * this.pps;
      const fxOut = g.x1 - (clip[fo] || 0) * this.pps;
      if (Math.abs(x - Math.max(fxIn, g.x0 + 7)) <= 6) return { row, clip, zone: 'fade-in', t };
      if (Math.abs(x - Math.min(fxOut, g.x1 - 7)) <= 6) return { row, clip, zone: 'fade-out', t };
    }
    const edge = g.w < 18 ? 3 : EDGE_PX;
    if (x - g.x0 <= edge) return { row, clip, zone: 'trim-l', t };
    if (g.x1 - x <= edge) return { row, clip, zone: 'trim-r', t };
    return { row, clip, zone: 'body', t };
  }

  // --------------------------------------------------------------- puntero ----

  onDown(e) {
    const p = state.project;
    const { x, y } = this.pos(e);
    if (e.button === 1) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = { kind: 'pan', x0: e.clientX, scroll0: state.scrollX };
      return;
    }
    if (e.button !== 0) return;
    const hit = this.hitTest(x, y);
    const locked = hit.row && hit.row.track.locked;

    if (state.tool === 'blade') {
      const t = this.bladeTime(x, e);
      if (e.shiftKey) {
        if (!A.splitAllAt(t)) toast('No hay clips en ese punto');
      } else if (hit.clip && !locked) {
        if (!A.splitClipAt(hit.clip.id, t)) toast('El corte queda demasiado cerca del borde del clip');
      }
      return;
    }

    this.canvas.setPointerCapture(e.pointerId);
    if (!hit.clip || locked) {
      this.drag = { kind: 'marquee', x0: x, y0: y, add: e.shiftKey || e.ctrlKey, base: e.shiftKey || e.ctrlKey ? [...state.selection] : [], moved: false, t: hit.t };
      return;
    }
    const clip = hit.clip;
    const multi = e.ctrlKey || e.metaKey || e.shiftKey;

    switch (hit.zone) {
      case 'key':
        if (!isSelected(clip.id)) select(clip.id);
        this.drag = { kind: 'key', clip, from: hit.key, cur: hit.key, x0: x, moved: false };
        return;
      case 'zoom':
      case 'zoom-l':
      case 'zoom-r':
        select(clip.id);
        setUI({ activeZoom: hit.zoom.id, activeCensor: null });
        this.drag = { kind: hit.zone, clip, zoom: hit.zoom, x0: x, s0: hit.zoom.start, e0: hit.zoom.end, moved: false };
        return;
      case 'fade-in':
      case 'fade-out':
        if (!isSelected(clip.id)) select(clip.id);
        this.drag = { kind: hit.zone, clip, moved: false };
        return;
      case 'trim-l':
      case 'trim-r': {
        if (!isSelected(clip.id)) select(clip.id);
        const orig = new Map(p.clips.map((c) => [c.id, { start: c.start, in: c.in, duration: c.duration }]));
        this.drag = { kind: hit.zone, clip, orig, moved: false, x0: x };
        return;
      }
      default: {
        const was = isSelected(clip.id);
        if (!was) select(clip.id, multi ? { add: true } : {});
        const ids = new Set(state.selection);
        const orig = new Map();
        for (const c of p.clips) if (ids.has(c.id) && !M.trackById(p, c.trackId)?.locked) orig.set(c.id, { start: c.start, trackId: c.trackId });
        this.drag = { kind: 'move', clip, orig, grab: hit.t - clip.start, x0: x, y0: y, moved: false, was, multi, lastDt: 0, lastShift: 0 };
      }
    }
  }

  onMove(e) {
    const { x, y } = this.pos(e);
    const d = this.drag;
    if (!d) {
      this.updateHover(x, y, e);
      return;
    }
    switch (d.kind) {
      case 'pan':
        this.setScroll(d.scroll0 - (e.clientX - d.x0));
        break;
      case 'marquee':
        this.moveMarquee(d, x, y);
        break;
      case 'move':
        this.moveClips(d, x, y, e);
        break;
      case 'trim-l':
      case 'trim-r':
        this.moveTrim(d, x, e);
        break;
      case 'fade-in':
      case 'fade-out':
        this.moveFade(d, x);
        break;
      case 'zoom':
      case 'zoom-l':
      case 'zoom-r':
        this.moveZoom(d, x, e);
        break;
      case 'key':
        this.moveKey(d, x, e);
        break;
      default:
        break;
    }
    if (d.kind !== 'pan' && d.kind !== 'marquee') {
      if (x > this.w - 28) this.setScroll(state.scrollX + 12);
      else if (x < 28 && state.scrollX > 0) this.setScroll(state.scrollX - 12);
    }
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ya liberado */
    }
    this.snapLine = null;
    const p = state.project;

    if (d.kind === 'marquee') {
      this.marquee = null;
      if (!d.moved) {
        if (!d.add) select([]);
        setPlayhead(M.snapFrame(p, Math.max(0, d.t)));
      }
    } else if (d.kind === 'move') {
      if (d.moved) endTxn();
      else if (d.was && d.multi) select(d.clip.id, { toggle: true });
      else if (d.was && state.selection.length > 1) select(d.clip.id);
    } else if (d.moved) {
      endTxn();
    }
    if (this.skipped && this.skipped.size) {
      toast(`No se recorrió ${[...this.skipped].join(', ')}: un clip cruza el corte`);
    }
    this.skipped = null;
    this.draw();
  }

  updateHover(x, y, e) {
    if (state.tool === 'blade') {
      const hit = this.hitTest(x, y);
      const t = this.bladeTime(x, e);
      this.blade = { t, snapped: this.bladeSnapped, clip: hit.clip, all: e.shiftKey };
      this.canvas.style.cursor = 'crosshair';
      this.draw();
      return;
    }
    const hit = this.hitTest(x, y);
    const prev = this.hover;
    this.hover = hit.clip ? hit : null;
    let cur = 'default';
    if (hit.clip && !hit.row.track.locked) {
      if (hit.zone === 'trim-l' || hit.zone === 'trim-r' || hit.zone === 'zoom-l' || hit.zone === 'zoom-r') cur = 'ew-resize';
      else if (hit.zone === 'fade-in' || hit.zone === 'fade-out' || hit.zone === 'key') cur = 'pointer';
      else if (hit.zone === 'zoom') cur = 'grab';
    }
    this.canvas.style.cursor = cur;
    if ((prev && prev.clip) !== (this.hover && this.hover.clip)) this.draw();
  }

  /** Instante de corte de la cuchilla: con el imán activo se pega al cursor y a los bordes cercanos. */
  bladeTime(x, e) {
    const p = state.project;
    let t = this.tAt(x);
    this.bladeSnapped = false;
    if (state.snapping && !(e && e.ctrlKey)) {
      const viaPlayhead = this.snapTime(t, [state.playhead], SNAP_PX * 1.6);
      if (viaPlayhead.hit !== null) {
        this.bladeSnapped = true;
        return M.snapFrame(p, viaPlayhead.t);
      }
      const s = this.snapTime(t, this.snapPoints(null, false), SNAP_PX * 0.8);
      if (s.hit !== null) {
        this.bladeSnapped = true;
        t = s.t;
      }
    }
    return M.snapFrame(p, Math.max(0, t));
  }

  moveMarquee(d, x, y) {
    if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 4) return;
    d.moved = true;
    const p = state.project;
    const xa = Math.min(d.x0, x);
    const xb = Math.max(d.x0, x);
    const ya = Math.min(d.y0, y);
    const yb = Math.max(d.y0, y);
    this.marquee = { x: xa, y: ya, w: xb - xa, h: yb - ya };
    const ids = [...d.base];
    for (const row of this.rows) {
      const ry = row.y - this.scrollY;
      if (ry + row.h < ya || ry > yb || row.track.locked) continue;
      for (const c of p.clips) {
        if (c.trackId !== row.track.id) continue;
        if (this.xOf(M.clipEnd(c)) >= xa && this.xOf(c.start) <= xb && !ids.includes(c.id)) ids.push(c.id);
      }
    }
    select(ids);
    this.draw();
  }

  moveClips(d, x, y, e) {
    if (!d.moved) {
      if (Math.hypot(x - d.x0, y - d.y0) < 4) return;
      if (!d.orig.size) return;
      d.moved = true;
      beginTxn('Mover clips');
    }
    const p = state.project;
    const ids = new Set(d.orig.keys());
    const anchor0 = d.orig.get(d.clip.id) || [...d.orig.values()][0];
    const moving = p.clips.filter((c) => ids.has(c.id));
    const minStart = Math.min(...[...d.orig.values()].map((o) => o.start));

    // Cambio de pista: solo entre pistas del mismo tipo que el clip agarrado.
    const kind = M.kindOf(d.clip.type);
    const sameKind = p.tracks.filter((t) => t.kind === kind);
    const row = this.rowAt(y);
    let shift = d.lastShift;
    if (row && row.track.kind === kind && !row.track.locked) {
      shift = sameKind.indexOf(row.track) - sameKind.findIndex((t) => t.id === anchor0.trackId);
    }
    const idxs = moving.filter((c) => M.kindOf(c.type) === kind).map((c) => sameKind.findIndex((t) => t.id === d.orig.get(c.id).trackId));
    shift = clamp(shift, -Math.min(...idxs), sameKind.length - 1 - Math.max(...idxs));
    const targetTrack = (c) => {
      const o = d.orig.get(c.id);
      if (M.kindOf(c.type) !== kind) return o.trackId;
      const t = sameKind[sameKind.findIndex((tr) => tr.id === o.trackId) + shift];
      return t && !t.locked ? t.id : o.trackId;
    };

    let dt = this.tAt(x) - d.grab - anchor0.start;
    this.snapLine = null;
    if (state.snapping && !e.ctrlKey) {
      const points = this.snapPoints(ids);
      const tol = SNAP_PX / this.pps;
      let best = tol;
      let adj = null;
      for (const c of moving) {
        const o = d.orig.get(c.id);
        for (const edge of [o.start + dt, o.start + c.duration + dt]) {
          for (const pt of points) {
            const diff = pt - edge;
            if (Math.abs(diff) < best) {
              best = Math.abs(diff);
              adj = { diff, pt };
            }
          }
        }
      }
      if (adj) {
        dt += adj.diff;
        this.snapLine = adj.pt;
      }
    }
    dt = Math.max(dt, -minStart);
    dt = M.snapFrame(p, dt);

    // Evita solapamientos: busca el desplazamiento válido más cercano al deseado.
    const collides = (delta) => {
      for (const c of moving) {
        const o = d.orig.get(c.id);
        const s = o.start + delta;
        if (s < -EPS) return true;
        if (!M.rangeIsFree(p, targetTrack(c), s, c.duration, ids)) return true;
      }
      return false;
    };
    if (collides(dt)) {
      const candidates = [];
      for (const c of moving) {
        const o = d.orig.get(c.id);
        const tr = targetTrack(c);
        for (const s of p.clips) {
          if (s.trackId !== tr || ids.has(s.id)) continue;
          candidates.push(M.clipEnd(s) - o.start, s.start - (o.start + c.duration));
        }
      }
      candidates.push(-minStart, d.lastDt);
      let found = null;
      for (const cand of candidates) {
        const v = M.snapFrame(p, cand);
        if (collides(v)) continue;
        if (found === null || Math.abs(v - dt) < Math.abs(found - dt)) found = v;
      }
      if (found === null) {
        if (shift !== d.lastShift) {
          shift = d.lastShift;
          found = d.lastDt;
        } else found = d.lastDt;
      }
      dt = found;
      this.snapLine = null;
    }

    for (const c of moving) {
      const o = d.orig.get(c.id);
      c.trackId = targetTrack(c);
      c.start = Math.max(0, M.snapFrame(p, o.start + dt));
    }
    d.lastDt = dt;
    d.lastShift = shift;
    touch();
  }

  moveTrim(d, x, e) {
    const p = state.project;
    if (!d.moved) {
      if (Math.abs(x - d.x0) < 3) return;
      d.moved = true;
      beginTxn('Recortar');
    }
    for (const c of p.clips) {
      const o = d.orig.get(c.id);
      if (o) Object.assign(c, o);
    }
    const clip = d.clip;
    const o = d.orig.get(clip.id);
    const fd = M.frameDur(p);
    const maxDur = M.maxSourceDuration(p, clip);
    const k = M.speedOf(clip); // segundos de origen por segundo de línea temporal
    const main = M.mainTrack(p);
    const ripple = state.ripple && !e.altKey && main && clip.trackId === main.id;
    const oEnd = o.start + o.duration;
    const except = new Set([clip.id]);
    this.snapLine = null;

    let t = this.tAt(x);
    if (state.snapping && !e.ctrlKey && !(ripple && d.kind === 'trim-l')) {
      const s = this.snapTime(t, this.snapPoints(except));
      if (s.hit !== null) {
        t = s.t;
        this.snapLine = s.t;
      }
    }
    t = M.snapFrame(p, t);
    const others = M.trackClips(p, clip.trackId, except);

    if (d.kind === 'trim-r') {
      let maxEnd = o.start + (maxDur - o.in) / k;
      if (!ripple) {
        const next = others.find((c) => c.start >= oEnd - EPS);
        if (next) maxEnd = Math.min(maxEnd, next.start);
      }
      const newEnd = clamp(t, o.start + fd, Math.max(o.start + fd, M.floorFrame(p, maxEnd + EPS)));
      clip.duration = newEnd - o.start;
      if (ripple) this.noteSkipped(M.rippleShift(p, oEnd, newEnd - oEnd, { except }));
    } else if (ripple) {
      // Recorte de entrada con cierre de huecos: el inicio se queda y el resto se recorre.
      const minDelta = Number.isFinite(maxDur) ? -M.floorFrame(p, o.in / k) : -3600;
      const delta = M.snapFrame(p, clamp(t - o.start, minDelta, o.duration - fd));
      clip.in = Math.max(0, o.in + delta * k);
      clip.duration = o.duration - delta;
      this.noteSkipped(M.rippleShift(p, oEnd, -delta, { except }));
    } else {
      let minStart = 0;
      const prev = [...others].reverse().find((c) => M.clipEnd(c) <= o.start + EPS);
      if (prev) minStart = M.clipEnd(prev);
      if (Number.isFinite(maxDur)) minStart = Math.max(minStart, M.snapFrame(p, o.start - o.in / k + fd * 0.499));
      const newStart = clamp(t, minStart, oEnd - fd);
      const delta = newStart - o.start;
      clip.start = newStart;
      clip.in = Math.max(0, o.in + delta * k);
      clip.duration = o.duration - delta;
    }
    touch();
  }

  noteSkipped(tracks) {
    if (!tracks.length) return;
    if (!this.skipped) this.skipped = new Set();
    for (const t of tracks) this.skipped.add(t.name);
  }

  moveFade(d, x) {
    const p = state.project;
    if (!d.moved) {
      d.moved = true;
      beginTxn('Fundido');
    }
    const clip = d.clip;
    const [fi, fo] = fadeProps(p, clip);
    const t = this.tAt(x);
    if (d.kind === 'fade-in') clip[fi] = Math.round(clamp(t - clip.start, 0, clip.duration - (clip[fo] || 0)) * 100) / 100;
    else clip[fo] = Math.round(clamp(M.clipEnd(clip) - t, 0, clip.duration - (clip[fi] || 0)) * 100) / 100;
    touch();
  }

  moveZoom(d, x, e) {
    const p = state.project;
    if (!d.moved) {
      if (Math.abs(x - d.x0) < 3) return;
      d.moved = true;
      beginTxn('Zoom');
    }
    const clip = d.clip;
    const z = d.zoom;
    const lo = clip.in;
    const hi = M.sourceEnd(clip);
    const dts = ((x - d.x0) / this.pps) * M.speedOf(clip);
    const len = d.e0 - d.s0;
    const snapTs = (ts) => {
      if (!state.snapping || e.ctrlKey) return ts;
      const s = this.snapTime(A.tsToTimeline(clip, ts), [state.playhead, clip.start, M.clipEnd(clip)]);
      this.snapLine = s.hit;
      return s.hit === null ? ts : M.sourceTime(clip, s.t);
    };
    this.snapLine = null;
    if (d.kind === 'zoom') {
      const s = clamp(snapTs(d.s0 + dts), lo, hi - len);
      z.start = s;
      z.end = s + len;
    } else if (d.kind === 'zoom-l') {
      z.start = clamp(snapTs(d.s0 + dts), lo, d.e0 - 0.1);
    } else {
      z.end = clamp(snapTs(d.e0 + dts), d.s0 + 0.1, hi);
    }
    const fps = p.settings.fps;
    z.start = Math.round(z.start * fps) / fps;
    z.end = Math.round(z.end * fps) / fps;
    touch();
  }

  moveKey(d, x, e) {
    const p = state.project;
    if (!d.moved) {
      if (Math.abs(x - d.x0) < 3) return;
      d.moved = true;
      beginTxn('Mover keyframe');
    }
    const clip = d.clip;
    let t = this.tAt(x);
    this.snapLine = null;
    if (state.snapping && !e.ctrlKey) {
      const s = this.snapTime(t, [state.playhead]);
      if (s.hit !== null) {
        t = s.t;
        this.snapLine = s.t;
      }
    }
    t = clamp(M.snapFrame(p, t), clip.start, M.clipEnd(clip));
    const ts = M.sourceTime(clip, t);
    if (Math.abs(ts - d.cur) < 1e-6) return;
    for (const o of [clip, ...(clip.effects || []), ...(clip.censors || [])]) shiftKeys(o, d.cur, ts);
    d.cur = ts;
    touch();
  }

  onDblClick(e) {
    const { x, y } = this.pos(e);
    const hit = this.hitTest(x, y);
    if (hit.clip && state.tool !== 'blade') {
      select(hit.clip.id);
      setPlayhead(M.snapFrame(state.project, clamp(hit.t, hit.clip.start, M.clipEnd(hit.clip) - M.frameDur(state.project))));
    }
  }

  onContext(e) {
    e.preventDefault();
    const p = state.project;
    const { x, y } = this.pos(e);
    const hit = this.hitTest(x, y);
    const t = M.snapFrame(p, Math.max(0, hit.t));

    if (hit.clip && hit.zone === 'key') {
      const clip = hit.clip;
      contextMenu(e.clientX, e.clientY, [
        { label: 'Ir a este keyframe', icon: 'diamond', run: () => setPlayhead(A.tsToTimeline(clip, hit.key)) },
        {
          label: 'Eliminar keyframe',
          icon: 'trash',
          danger: true,
          run: () => mutate('Eliminar keyframe', () => {
            for (const o of [clip, ...(clip.effects || []), ...(clip.censors || [])]) deleteKeysAt(o, hit.key);
          }),
        },
      ]);
      return;
    }
    if (hit.clip && hit.zone && hit.zone.startsWith('zoom')) {
      const clip = hit.clip;
      select(clip.id);
      setUI({ activeZoom: hit.zoom.id });
      contextMenu(e.clientX, e.clientY, [{ label: 'Eliminar zoom', icon: 'trash', danger: true, run: () => A.removeZoom(clip, hit.zoom.id) }]);
      return;
    }
    if (hit.clip) {
      const clip = hit.clip;
      if (!isSelected(clip.id)) select(clip.id);
      const inside = state.playhead > clip.start + EPS && state.playhead < M.clipEnd(clip) - EPS;
      const main = M.mainTrack(p);
      const onMain = main && clip.trackId === main.id;
      const media = clip.mediaId ? M.mediaById(p, clip.mediaId) : null;
      contextMenu(e.clientX, e.clientY, [
        { label: 'Cortar en el cursor', icon: 'split', shortcut: 'Ctrl+B', disabled: !inside, run: () => A.splitAtPlayhead() },
        { label: 'Cortar aquí', icon: 'scissors', run: () => A.splitClipAt(clip.id, t) },
        '-',
        { label: 'Copiar', icon: 'copy', shortcut: 'Ctrl+C', run: () => A.copySelection() },
        { label: 'Duplicar', icon: 'copy', shortcut: 'Ctrl+D', run: () => A.duplicateSelection() },
        clip.type === 'video' && M.clipHasAudio(p, clip) ? { label: 'Separar audio', icon: 'wave', run: () => A.detachAudio(clip) } : null,
        'volume' in clip ? { label: clip.muted ? 'Activar sonido del clip' : 'Silenciar clip', icon: clip.muted ? 'volume' : 'volumeX', run: () => A.setClipField(clip, 'muted', !clip.muted) } : null,
        clip.zooms ? { label: 'Añadir zoom aquí', icon: 'zoomIn', run: () => { setPlayhead(t); A.addZoom(clip); } } : null,
        'speed' in clip ? { label: 'Cambiar velocidad…', icon: 'gauge', run: () => { if (state.workspace === 'cut') setUI({ workspace: 'edit' }); emit('reveal-section', 'speed'); } } : null,
        Math.abs(M.speedOf(clip) - 1) > 1e-3 ? { label: 'Volver a velocidad normal', icon: 'reset', run: () => A.setClipSpeed(clip, 1) } : null,
        clip.type === 'video' || clip.type === 'image' ? { label: 'Recortar imagen…', icon: 'crop', run: () => { if (state.workspace === 'cut') setUI({ workspace: 'edit' }); A.startCrop(clip); emit('reveal-section', 'crop'); } } : null,
        clip.transIn ? { label: 'Quitar transición de entrada', icon: 'transition', run: () => A.removeTransition(clip, 'in') } : null,
        clip.transOut ? { label: 'Quitar transición de salida', icon: 'transition', run: () => A.removeTransition(clip, 'out') } : null,
        clip.audioTransIn ? { label: 'Quitar fundido cruzado de audio', icon: 'wave', run: () => A.setClipField(clip, 'audioTransIn', null) } : null,
        media ? { label: 'Mostrar archivo en la carpeta', icon: 'folder', run: () => window.nano.showItem(media.path) } : null,
        '-',
        { label: 'Eliminar', icon: 'trash', shortcut: 'Supr', danger: true, run: () => A.deleteSelection() },
        onMain ? { label: state.ripple ? 'Eliminar dejando el hueco' : 'Eliminar y cerrar el hueco', icon: 'ripple', shortcut: 'Mayús+Supr', danger: true, run: () => A.deleteSelection({ ripple: !state.ripple }) } : null,
      ]);
      return;
    }
    if (hit.row) {
      const track = hit.row.track;
      const clips = M.trackClips(p, track.id);
      const next = clips.find((c) => c.start > hit.t);
      const prevEnd = Math.max(0, ...clips.filter((c) => M.clipEnd(c) <= hit.t + EPS).map(M.clipEnd));
      const gap = next ? next.start - prevEnd : 0;
      contextMenu(e.clientX, e.clientY, [
        { label: 'Pegar aquí', icon: 'copy', shortcut: 'Ctrl+V', run: () => { setPlayhead(t); A.pasteAtPlayhead(); } },
        track.kind === 'video' ? { label: 'Añadir texto aquí', icon: 'type', run: () => A.addText('title', { trackId: track.id, start: t }) } : null,
        {
          label: 'Cerrar este hueco',
          icon: 'ripple',
          disabled: gap <= EPS,
          run: () => mutate('Cerrar hueco', (proj) => {
            const main = M.mainTrack(proj);
            const skipped = M.rippleShift(proj, next.start, -gap, main && track.id === main.id ? {} : { onlyTrack: track.id });
            if (skipped.length) toast(`No se recorrió ${skipped.map((s) => s.name).join(', ')}: un clip cruza el corte`);
          }),
        },
        '-',
        { label: 'Añadir pista de video', icon: 'film', run: () => A.addTrack('video') },
        { label: 'Añadir pista de audio', icon: 'music', run: () => A.addTrack('audio') },
        { label: `Eliminar pista ${track.name}`, icon: 'trash', danger: true, run: () => A.removeTrack(track.id) },
      ]);
    }
  }

  // ----------------------------------------------------- arrastrar y soltar ----

  onDragOver(e) {
    const p = state.project;
    const payload = getDrag();
    const hasFiles = [...e.dataTransfer.types].includes('Files');
    if (!payload && !hasFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const { x, y } = this.pos(e);
    const row = this.rowAt(y);
    this.ghost = null;
    this.dropTarget = null;
    this.snapLine = null;

    const ghostFor = (kind, duration, label) => {
      let track = row && row.track.kind === kind && !row.track.locked ? row.track : null;
      if (!track) {
        const c = p.tracks.filter((t) => t.kind === kind && !t.locked);
        track = kind === 'video' ? c[c.length - 1] : c[0];
      }
      if (!track) return;
      let t = Math.max(0, this.tAt(x) - Math.min(duration / 2, 40 / this.pps));
      if (state.snapping) {
        const pts = this.snapPoints(null);
        const a = this.snapTime(t, pts);
        const b = this.snapTime(t + duration, pts);
        if (a.hit !== null) {
          t = a.t;
          this.snapLine = a.t;
        } else if (b.hit !== null) {
          t = b.t - duration;
          this.snapLine = b.t;
        }
      }
      const start = M.snapFrame(p, M.resolveStart(p, track.id, Math.max(0, t), duration));
      this.ghost = { trackId: track.id, start, duration, label, kind };
    };

    if (payload && payload.kind === 'media') {
      const media = M.mediaById(p, payload.id);
      if (media) ghostFor(M.kindOf(media.type), media.type === 'image' ? 5 : media.duration, media.name);
    } else if (payload && payload.kind === 'text') {
      ghostFor('video', 4, 'Texto');
    } else if (payload) {
      const hit = this.hitTest(x, y);
      if (hit.clip && !hit.row.track.locked) {
        const g = this.geom(hit.clip, hit.row);
        this.dropTarget = { clip: hit.clip, side: x < g.x0 + g.w / 2 ? 'in' : 'out', payload };
      }
    }
    this.draw();
  }

  async onDrop(e) {
    e.preventDefault();
    const p = state.project;
    const payload = getDrag();
    const ghost = this.ghost;
    const target = this.dropTarget;
    this.ghost = null;
    this.dropTarget = null;
    this.snapLine = null;
    clearDrag();
    this.draw();

    if (!payload) {
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      const { x, y } = this.pos(e);
      const row = this.rowAt(y);
      let t = M.snapFrame(p, Math.max(0, this.tAt(x)));
      const paths = files.map((f) => window.nano.pathForFile(f)).filter(Boolean);
      const medias = await importPaths(paths, (name, err) => toast(`No se pudo importar ${name}: ${err}`, 'error'));
      for (const m of medias) {
        const kind = M.kindOf(m.type);
        const clip = A.addMediaToTimeline(m, { trackId: row && row.track.kind === kind ? row.track.id : undefined, start: t });
        t = M.clipEnd(clip);
      }
      return;
    }

    if (payload.kind === 'media' && ghost) {
      const media = M.mediaById(p, payload.id);
      if (media) A.addMediaToTimeline(media, { trackId: ghost.trackId, start: ghost.start });
    } else if (payload.kind === 'text' && ghost) {
      A.addText(payload.id, { trackId: ghost.trackId, start: ghost.start });
    } else if (target) {
      applyPayload(payload, target.clip, target.side);
    }
  }

  // ---------------------------------------------------------------- dibujo ----

  renderHeaders() {
    const p = state.project;
    if (!p) return;
    clear(this.headers);
    const main = M.mainTrack(p);
    const btn = (name, title, on, flag, id) =>
      h('button', { class: `icon-btn tiny${on ? ' on' : ''}`, title, html: icon(name, 14), onclick: () => A.toggleTrack(id, flag) });
    for (const row of this.rows) {
      const t = row.track;
      const el = h(
        'div',
        {
          class: `tl-head ${t.kind}${t.locked ? ' locked' : ''}${row.h < 46 ? ' compact' : ''}`,
          style: { top: `${row.y - this.scrollY}px`, height: `${row.h}px` },
          oncontextmenu: (e) => {
            e.preventDefault();
            contextMenu(e.clientX, e.clientY, [
              { label: 'Añadir pista de video', icon: 'film', run: () => A.addTrack('video') },
              { label: 'Añadir pista de audio', icon: 'music', run: () => A.addTrack('audio') },
              '-',
              { label: `Eliminar pista ${t.name}`, icon: 'trash', danger: true, run: () => A.removeTrack(t.id) },
            ]);
          },
        },
        h('div', { class: 'tl-head-name' }, h('b', {}, t.name), main && t.id === main.id ? h('span', { class: 'tag', title: 'Pista principal: al borrar o recortar aquí, el resto se recorre' }, 'principal') : null),
        h(
          'div',
          { class: 'tl-head-btns' },
          t.kind === 'video' ? btn(t.hidden ? 'eyeOff' : 'eye', t.hidden ? 'Mostrar pista' : 'Ocultar pista', t.hidden, 'hidden', t.id) : null,
          btn(t.muted ? 'volumeX' : 'volume', t.muted ? 'Activar sonido' : 'Silenciar pista', t.muted, 'muted', t.id),
          btn(t.locked ? 'lock' : 'unlock', t.locked ? 'Desbloquear pista' : 'Bloquear pista', t.locked, 'locked', t.id)
        )
      );
      this.headers.append(el);
    }
  }

  paint() {
    const p = state.project;
    if (!p) return;
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    beginThumbPass();

    for (const row of this.rows) {
      const y = row.y - this.scrollY;
      ctx.fillStyle = row.track.kind === 'video' ? '#15171d' : '#13161b';
      ctx.fillRect(0, y, W, row.h);
    }
    this.paintGrid(ctx, W, H);

    for (const row of this.rows) {
      const clips = M.trackClips(p, row.track.id);
      for (const clip of clips) {
        const g = this.geom(clip, row);
        if (g.x1 < -2 || g.x0 > W + 2) continue;
        this.paintClip(ctx, clip, row, g);
      }
      if (row.track.locked) {
        ctx.fillStyle = 'rgba(8, 9, 12, 0.45)';
        ctx.fillRect(0, row.y - this.scrollY, W, row.h);
      }
    }

    if (this.live) this.paintLive(ctx);
    if (this.ghost) this.paintGhost(ctx);
    if (this.dropTarget) this.paintDropTarget(ctx);

    if (this.marquee) {
      const m = this.marquee;
      ctx.fillStyle = 'rgba(124, 92, 255, 0.14)';
      ctx.strokeStyle = 'rgba(155, 131, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.w, m.h);
    }
    if (this.snapLine !== null) {
      const x = Math.round(this.xOf(this.snapLine)) + 0.5;
      ctx.strokeStyle = '#ffd84a';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.blade && state.tool === 'blade') this.paintBlade(ctx, H);

    this.paintRuler();
    this.placePlayhead();
  }

  tickStep() {
    const fps = state.project.settings.fps;
    const steps = [1 / fps, 5 / fps, 10 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    return steps.find((s) => s * this.pps >= 84) || 7200;
  }

  paintGrid(ctx, W, H) {
    const step = this.tickStep();
    const t0 = Math.floor(this.tAt(0) / step) * step;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = t0; this.xOf(t) < W; t += step) {
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    ctx.stroke();
  }

  paintRuler() {
    const p = state.project;
    const ctx = this.rctx;
    const W = this.w;
    const H = this.rulerH;
    const fps = p.settings.fps;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const step = this.tickStep();
    const minor = step >= 1 ? step / (step === 2 || step === 10 || step === 30 || step === 300 ? 2 : 5) : step / (Math.round(step * fps) % 5 === 0 ? 5 : 1);
    const pad = (n) => String(n).padStart(2, '0');
    const label = (t) => {
      const total = Math.round(t * fps);
      const f = Math.round(fps);
      const s = Math.floor(total / f);
      const ff = total % f;
      const base = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
      return step < 1 ? `${base}:${pad(ff)}` : base;
    };
    ctx.font = '10.5px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7d8493';
    ctx.strokeStyle = '#3a3f4c';
    ctx.lineWidth = 1;
    const t0 = Math.floor(this.tAt(0) / step) * step;
    ctx.beginPath();
    for (let t = t0; this.xOf(t) < W + 60; t += step) {
      const x = Math.round(this.xOf(t)) + 0.5;
      ctx.moveTo(x, H - 11);
      ctx.lineTo(x, H);
      if (x > -40) ctx.fillText(label(Math.max(0, t)), x + 5, H - 17);
      if (minor * this.pps >= 5) {
        for (let m = t + minor; m < t + step - minor / 2; m += minor) {
          const mx = Math.round(this.xOf(m)) + 0.5;
          ctx.moveTo(mx, H - 5);
          ctx.lineTo(mx, H);
        }
      }
    }
    ctx.stroke();
    const end = this.xOf(M.projectDuration(p));
    if (end > 0 && end < W) {
      ctx.fillStyle = 'rgba(124, 92, 255, 0.5)';
      ctx.fillRect(Math.round(end), H - 3, 2, 3);
    }
  }

  paintClip(ctx, clip, row, g) {
    const p = state.project;
    const col = COLORS[clip.type] || COLORS.video;
    const selected = isSelected(clip.id);
    const media = clip.mediaId ? M.mediaById(p, clip.mediaId) : null;
    const r = media ? rt(media.id) : null;
    const x = g.x0;
    const y = g.y + 1;
    const w = Math.max(2, g.w - 1);
    const hh = g.h - 2;
    const vx0 = Math.max(x, -4);
    const vx1 = Math.min(x + w, this.w + 4);
    const hasAudio = M.clipHasAudio(p, clip);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, Math.min(5, w / 2));
    ctx.clip();
    ctx.fillStyle = col.base;
    ctx.fillRect(vx0, y, vx1 - vx0, hh);

    const waveH = clip.type === 'audio' ? hh - TITLE_H : clip.type === 'video' && hasAudio ? Math.round(hh * 0.32) : 0;
    const thumbH = hh - waveH;

    if ((clip.type === 'video' || clip.type === 'image') && media && w > 10) {
      const aspect = media.width && media.height ? media.width / media.height : 16 / 9;
      const tw = Math.max(8, thumbH * aspect);
      const k = M.speedOf(clip);
      const dt = (tw / this.pps) * k; // segundos de origen que cubre cada miniatura
      const step = niceStep(dt);
      const srcVis0 = M.sourceTime(clip, this.tAt(vx0));
      const srcVis1 = M.sourceTime(clip, this.tAt(vx1));
      const j0 = Math.floor(srcVis0 / dt);
      const j1 = Math.ceil(srcVis1 / dt);
      for (let j = j0; j < j1; j++) {
        const tx = x + ((j * dt - clip.in) / k) * this.pps;
        const ts = clip.type === 'image' ? 0 : Math.max(0, Math.floor((j * dt) / step + 1e-6) * step);
        const bmp = r && r.status === 'ready' ? thumb(media, ts) : null;
        if (bmp) ctx.drawImage(bmp, tx, y, tw + 0.5, thumbH);
      }
      ctx.fillStyle = 'rgba(10, 14, 24, 0.22)';
      ctx.fillRect(vx0, y, vx1 - vx0, thumbH);
    }

    if (waveH > 0 && media) {
      const wy = y + hh - waveH;
      if (clip.type === 'video') {
        ctx.fillStyle = 'rgba(9, 16, 30, 0.82)';
        ctx.fillRect(vx0, wy, vx1 - vx0, waveH);
      }
      const levels = r && r.peaks;
      if (levels) {
        const perPx = (PEAKS_PER_SECOND * M.speedOf(clip)) / this.pps;
        let L = 0;
        while (L < levels.length - 1 && perPx / (1 << L) > 2) L++;
        const data = levels[L];
        const scale = PEAKS_PER_SECOND / (1 << L);
        const center = clip.type === 'audio';
        const amp = center ? (waveH - 6) / 2 : waveH - 4;
        const vol = clip.muted ? 0.25 : clamp(clip.volume ?? 1, 0.15, 1.6);
        ctx.fillStyle = clip.muted ? 'rgba(160, 170, 185, 0.5)' : col.wave;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (let px = Math.floor(vx0); px < vx1; px += 1) {
          const ts = M.sourceTime(clip, this.tAt(px));
          if (ts < 0) continue;
          const i = Math.floor(ts * scale);
          if (i >= data.length) break;
          const v = Math.max(data[i], data[Math.min(data.length - 1, i + 1)]) / 255;
          const a = Math.max(0.5, Math.min(1, Math.pow(v, 0.75) * vol) * amp);
          if (center) ctx.rect(px, wy + waveH / 2 - a, 1, a * 2);
          else ctx.rect(px, wy + waveH - 2 - a, 1, a);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    if (clip.type === 'text') {
      ctx.fillStyle = col.top;
      ctx.fillRect(vx0, y, vx1 - vx0, hh);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const label = fitText(ctx, String(clip.text.content).replace(/\n/g, ' '), w - 14);
      ctx.fillText(label, Math.max(x, 0) + 8, y + hh / 2 + 5);
    }

    // Franja de título
    const grad = ctx.createLinearGradient(0, y, 0, y + TITLE_H + 6);
    grad.addColorStop(0, 'rgba(6, 9, 16, 0.78)');
    grad.addColorStop(1, 'rgba(6, 9, 16, 0)');
    ctx.fillStyle = clip.type === 'text' ? 'rgba(0, 0, 0, 0.18)' : grad;
    ctx.fillRect(vx0, y, vx1 - vx0, TITLE_H + 6);
    if (w > 26 && clip.type !== 'text') {
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const tags = [];
      const spd = M.speedOf(clip);
      if (Math.abs(spd - 1) > 1e-3) tags.push(`${Math.round(spd * 100) / 100}×`);
      if (A.hasCrop(clip)) tags.push('recorte');
      if (clip.color) tags.push('color');
      if (clip.effects && clip.effects.some((e2) => e2.enabled)) tags.push('fx');
      if (clip.censors && clip.censors.length) tags.push('censura');
      if (clip.audioFx) tags.push('audio fx');
      if (clip.audioDetached) tags.push('sin audio');
      let tagW = 0;
      const tagText = tags.join(' · ');
      if (tagText && w > 120) tagW = ctx.measureText(tagText).width + 12;
      const tx = Math.max(x, 0) + 7;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
      ctx.fillText(fitText(ctx, clip.name.replace(/\.[a-z0-9]{2,5}$/i, ''), x + w - tx - 6 - tagW), tx, y + 9);
      if (tagW) {
        ctx.fillStyle = 'rgba(255, 216, 74, 0.92)';
        ctx.fillText(tagText, x + w - tagW + 4, y + 9);
      }
    } else if (clip.type === 'text' && w > 40) {
      ctx.font = '10px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.textBaseline = 'middle';
      ctx.fillText('TEXTO', Math.max(x, 0) + 8, y + 9);
    }

    // Estado del medio
    if (r && r.status !== 'ready') {
      ctx.fillStyle = r.status === 'offline' || r.status === 'error' ? 'rgba(120, 20, 30, 0.72)' : 'rgba(10, 12, 18, 0.62)';
      ctx.fillRect(vx0, y, vx1 - vx0, hh);
      ctx.fillStyle = '#fff';
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      const msg = r.status === 'offline' ? 'Archivo no encontrado' : r.status === 'error' ? 'No se pudo cargar' : r.status === 'proxy' ? `Preparando vista previa ${Math.round(r.progress * 100)}%` : 'Cargando…';
      ctx.fillText(fitText(ctx, msg, w - 12), Math.max(x, 0) + 7, y + hh / 2 + 4);
    }

    // Fundidos
    const [fi, fo] = fadeProps(p, clip);
    const fin = (clip[fi] || 0) * this.pps;
    const fout = (clip[fo] || 0) * this.pps;
    if (fin > 1 || fout > 1) {
      ctx.fillStyle = 'rgba(5, 7, 12, 0.55)';
      if (fin > 1) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + fin, y);
        ctx.quadraticCurveTo(x + fin * 0.35, y + hh * 0.2, x, y + hh);
        ctx.closePath();
        ctx.fill();
      }
      if (fout > 1) {
        ctx.beginPath();
        ctx.moveTo(x + w, y);
        ctx.lineTo(x + w - fout, y);
        ctx.quadraticCurveTo(x + w - fout * 0.35, y + hh * 0.2, x + w, y + hh);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Transiciones
    const drawTrans = (tx0, tx1, name, audio) => {
      const a = Math.max(tx0, x);
      const b = Math.min(tx1, x + w);
      if (b - a < 3) return;
      const th = Math.min(14, Math.floor(hh / 2) - 2);
      const ty = audio ? y + hh - th - 1 : y + 1;
      ctx.fillStyle = audio ? 'rgba(20, 70, 56, 0.92)' : 'rgba(30, 34, 46, 0.9)';
      ctx.fillRect(a, ty, b - a, th);
      ctx.strokeStyle = audio ? 'rgba(134, 240, 207, 0.95)' : 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a + 0.5, ty + th - 0.5);
      ctx.lineTo(b - 0.5, ty + 0.5);
      ctx.stroke();
      ctx.strokeRect(a + 0.5, ty + 0.5, b - a - 1, th - 1);
      if (b - a > 54) {
        ctx.font = '9.5px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.textBaseline = 'middle';
        ctx.fillText(fitText(ctx, name, b - a - 8), a + 4, ty + th / 2 + 0.5);
      }
    };
    if (M.isVisual(clip)) {
      const ti = clip.transIn ? M.transInInfo(p, clip) : null;
      if (ti) drawTrans(this.xOf(ti.start), this.xOf(ti.end), transitionById(ti.type).name, false);
      const to = clip.transOut ? M.transOutInfo(p, clip) : null;
      if (to) drawTrans(this.xOf(to.start), this.xOf(to.end), transitionById(to.type).name, false);
      const next = M.nextAdjacent(p, clip);
      const tn = next && next.transIn ? M.transInInfo(p, next) : null;
      if (tn && tn.between) drawTrans(this.xOf(tn.start), this.xOf(tn.end), transitionById(tn.type).name, false);
    }
    if (hasAudio) {
      const ai = clip.audioTransIn ? M.audioTransInfo(p, clip) : null;
      if (ai) drawTrans(this.xOf(ai.start), this.xOf(ai.end), 'Fundido cruzado', true);
      const next = M.nextAdjacent(p, clip);
      const an = next && next.audioTransIn && M.clipHasAudio(p, next) ? M.audioTransInfo(p, next) : null;
      if (an && an.between) drawTrans(this.xOf(an.start), this.xOf(an.end), 'Fundido cruzado', true);
    }

    // Zooms
    if (clip.zooms && clip.zooms.length && g.h >= 30) {
      for (const z of clip.zooms) {
        const zx0 = Math.max(x, this.xOf(A.tsToTimeline(clip, z.start)));
        const zx1 = Math.min(x + w, this.xOf(A.tsToTimeline(clip, z.end)));
        if (zx1 - zx0 < 2) continue;
        const active = selected && state.activeZoom === z.id;
        const zy = y + TITLE_H + 1;
        ctx.fillStyle = active ? 'rgba(255, 200, 60, 0.95)' : 'rgba(255, 200, 60, 0.6)';
        ctx.beginPath();
        ctx.roundRect(zx0, zy, zx1 - zx0, 12, 3);
        ctx.fill();
        if (zx1 - zx0 > 44) {
          ctx.font = '600 9.5px "Segoe UI", system-ui, sans-serif';
          ctx.fillStyle = '#231a00';
          ctx.textBaseline = 'middle';
          ctx.fillText(fitText(ctx, `ZOOM ${z.scale.toFixed(1)}×`, zx1 - zx0 - 8), zx0 + 5, zy + 6.5);
        }
      }
    }

    // Keyframes
    if (selected) {
      const times = allKeyTimes(clip);
      if (times.length) {
        const ky = y + hh - 7;
        const cur = A.clipTs(clip);
        let lastX = -Infinity;
        for (const kt of times) {
          const kx = this.xOf(A.tsToTimeline(clip, kt));
          if (kx < x - 2 || kx > x + w + 2 || kx < -6 || kx > this.w + 6) continue;
          if (kx - lastX < 3.2) continue;
          lastX = kx;
          const on = Math.abs(kt - cur) < 1 / 120;
          ctx.fillStyle = on ? '#ffd84a' : '#ffffff';
          ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(kx, ky - 4.5);
          ctx.lineTo(kx + 4.5, ky);
          ctx.lineTo(kx, ky + 4.5);
          ctx.lineTo(kx - 4.5, ky);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // Borde y tiradores
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y + 0.5, w - 1, hh - 1, Math.min(5, w / 2));
    ctx.lineWidth = selected ? 2 : 1;
    ctx.strokeStyle = selected ? '#ffffff' : 'rgba(255, 255, 255, 0.16)';
    ctx.stroke();
    if (selected) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.fillRect(x + 2.5, y + hh / 2 - 7, 2, 14);
      ctx.fillRect(x + w - 4.5, y + hh / 2 - 7, 2, 14);
    }
    const hovering = this.hover && this.hover.clip === clip;
    if ((selected || hovering) && g.w >= 48) {
      for (const hx of [Math.max(x + fin, x + 7), Math.min(x + w - fout, x + w - 7)]) {
        ctx.beginPath();
        ctx.arc(hx, y + 8, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = col.base;
        ctx.stroke();
      }
    }
  }

  paintLive(ctx) {
    const live = this.live;
    const row = this.rowOf(live.trackId);
    if (!row) return;
    const x = this.xOf(live.start);
    const w = Math.max(3, live.duration * this.pps);
    const y = row.y - this.scrollY + 1;
    const hh = row.h - 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, hh, 5);
    ctx.clip();
    ctx.fillStyle = '#7d1f2c';
    ctx.fillRect(x, y, w, hh);
    ctx.fillStyle = '#ff9aa6';
    ctx.beginPath();
    const peaks = live.peaks;
    const per = live.peaksPerSecond;
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(this.w, x + w); px++) {
      const i = Math.floor(((px - x) / this.pps) * per);
      if (i < 0 || i >= peaks.length) continue;
      const a = Math.max(0.6, Math.min(1, Math.pow(peaks[i], 0.7)) * (hh - 8) * 0.5);
      ctx.rect(px, y + hh / 2 - a, 1, a * 2);
    }
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#ff5b6e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 1, y + 1, w - 2, hh - 2, 5);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    if (w > 70) ctx.fillText('● Grabando', x + 8, y + 10);
  }

  paintGhost(ctx) {
    const g = this.ghost;
    const row = this.rowOf(g.trackId);
    if (!row) return;
    const x = this.xOf(g.start);
    const w = Math.max(6, g.duration * this.pps);
    const y = row.y - this.scrollY + 1;
    ctx.fillStyle = 'rgba(124, 92, 255, 0.28)';
    ctx.strokeStyle = '#9b83ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.roundRect(x, y, w, row.h - 2, 5);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(fitText(ctx, g.label || '', w - 12), x + 7, y + 10);
  }

  paintDropTarget(ctx) {
    const { clip, side, payload } = this.dropTarget;
    const row = this.rowOf(clip.trackId);
    if (!row) return;
    const g = this.geom(clip, row);
    const edgeDrop = payload.kind === 'transition' || payload.kind === 'audio-transition';
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffd84a';
    ctx.fillStyle = 'rgba(255, 216, 74, 0.2)';
    if (edgeDrop) {
      const ew = Math.min(g.w / 2, 46);
      const ex = side === 'in' ? g.x0 : g.x1 - ew;
      ctx.fillRect(ex, g.y + 1, ew, g.h - 2);
      ctx.strokeRect(ex + 1, g.y + 2, ew - 2, g.h - 4);
    } else {
      ctx.beginPath();
      ctx.roundRect(g.x0 + 1, g.y + 2, g.w - 2, g.h - 4, 5);
      ctx.fill();
      ctx.stroke();
    }
  }

  paintBlade(ctx, H) {
    const b = this.blade;
    const x = Math.round(this.xOf(b.t)) + 0.5;
    ctx.lineWidth = b.snapped ? 2 : 1;
    ctx.strokeStyle = b.snapped ? '#ffd84a' : '#ff6b7a';
    ctx.beginPath();
    if (b.all || !b.clip) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    } else {
      const row = this.rowOf(b.clip.trackId);
      const y = row.y - this.scrollY;
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y + row.h + 3);
    }
    ctx.stroke();
    if (b.snapped) {
      ctx.fillStyle = '#ffd84a';
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 7);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Aplica al clip lo arrastrado desde un panel (transición, efecto, plantilla de color…). */
export function applyPayload(payload, clip, side = 'in') {
  const p = state.project;
  switch (payload.kind) {
    case 'transition':
      if (!M.isVisual(clip)) return toast('Las transiciones de video van sobre clips de video, imagen o texto');
      A.applyTransition(clip, side, payload.id);
      break;
    case 'audio-transition':
      if (!M.clipHasAudio(p, clip)) return toast('Ese clip no tiene audio');
      A.applyAudioTransition(clip, side, payload.id);
      break;
    case 'effect':
      if (clip.type !== 'video' && clip.type !== 'image' && clip.type !== 'text') return toast('Ese efecto es para clips de video o imagen');
      A.addEffect(clip, payload.id);
      break;
    case 'audio-effect':
      if (!M.clipHasAudio(p, clip)) return toast('Ese clip no tiene audio');
      A.setAudioFx(clip, payload.id);
      break;
    case 'color':
      if (!A.applyColorPreset([clip], payload.id)) return toast('Las plantillas de color son para clips de video o imagen');
      break;
    case 'text':
      A.addText(payload.id, { start: clip.start });
      return undefined;
    default:
      return undefined;
  }
  select(clip.id);
  return undefined;
}

export { TEXT_PRESETS };
