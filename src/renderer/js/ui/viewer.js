// Visor: lienzo de vista previa, controles de reproducción y tiradores sobre la imagen
// (mover / escalar / girar clips, recortar la imagen, dibujar y ajustar censuras, elegir el foco del zoom).

import { state, on, emit, setUI, select, primaryClip, beginTxn, endTxn, touch } from '../core/store.js';
import * as M from '../core/model.js';
import * as A from '../core/actions.js';
import { h, mat, clamp, formatTC, rafThrottle } from '../core/util.js';
import { evalProp, setProp } from '../core/keyframes.js';
import { buildScene, evalLayer, layerMatrix, hitLayer, sceneLayers } from '../render/scene.js';
import { engine } from '../playback/engine.js';
import { icon } from './icons.js';
import { toast, segmented } from './widgets.js';

const NS = 'http://www.w3.org/2000/svg';

function s(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  return el;
}

const isCroppable = (clip) => !!clip && (clip.type === 'video' || clip.type === 'image');

const pts = (list) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

export class Viewer {
  constructor() {
    this.stage = document.getElementById('viewer-stage');
    this.frame = document.getElementById('viewer-frame');
    this.canvas = document.getElementById('preview');
    this.overlay = document.getElementById('overlay');
    this.hud = document.getElementById('viewer-hud');
    this.empty = document.getElementById('viewer-empty');
    this.transport = document.getElementById('transport');
    this.svg = s('svg', { class: 'gizmos' });
    this.overlay.append(this.svg);
    this.fw = 640;
    this.fh = 360;
    this.drag = null;
    this.draft = null;
    this.guides = { v: false, h: false };

    engine.init(this.canvas);
    this.buildTransport();
    this.buildCensorHud();
    this.buildCropHud();

    this.renderOverlay = rafThrottle(() => this.paintOverlay());
    new ResizeObserver(() => this.resize()).observe(this.stage);
    on('frame', () => this.renderOverlay());
    on('selection', () => {
      // El recorte en el visor solo tiene sentido con un video o una imagen seleccionados.
      if (state.viewerMode === 'crop' && !isCroppable(primaryClip())) setUI({ viewerMode: null });
      this.renderOverlay();
    });
    on('project', (info) => {
      if (!info || info.load || info.label === 'Ajustes del proyecto' || info.restore) this.resize();
      this.updateEmpty();
      this.updateTime();
    });
    on('playhead', () => this.updateTime());
    on('ui', (keys) => {
      if (keys.includes('playing')) this.updatePlayButton();
      if (keys.includes('viewerMode') || keys.includes('censorMode') || keys.includes('censorShape')) this.updateCensorHud();
      if (keys.includes('viewerMode')) {
        this.cropHud.classList.toggle('show', state.viewerMode === 'crop');
        this.resize();
      }
      this.renderOverlay();
    });

    this.overlay.addEventListener('pointerdown', (e) => this.onDown(e));
    this.overlay.addEventListener('pointermove', (e) => this.onMove(e));
    this.overlay.addEventListener('pointerup', (e) => this.onUp(e));
    this.overlay.addEventListener('pointercancel', (e) => this.onUp(e));
    this.overlay.addEventListener('dblclick', () => {
      const clip = primaryClip();
      if (clip && clip.type === 'text') emit('focus-text');
    });

    this.resize();
    this.updateEmpty();
    this.updateTime();
  }

  // ------------------------------------------------------------ disposición ----

  resize() {
    const p = state.project;
    if (!p) return;
    // Al recortar se deja una franja libre arriba para la barra de ayuda: así no tapa ningún tirador.
    const band = state.viewerMode === 'crop' ? 44 : 0;
    this.stage.style.paddingTop = band ? `${band}px` : '';
    const r = this.stage.getBoundingClientRect();
    const pad = 14;
    const aw = Math.max(40, r.width - pad * 2);
    const ah = Math.max(40, r.height - pad * 2 - band);
    const { width: W, height: H } = p.settings;
    const k = Math.min(aw / W, ah / H);
    this.fw = Math.max(20, Math.floor(W * k));
    this.fh = Math.max(20, Math.floor(H * k));
    this.frame.style.width = `${this.fw}px`;
    this.frame.style.height = `${this.fh}px`;
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.min(1, (this.fw * dpr) / W);
    engine.resize(Math.round(W * scale), Math.round(H * scale));
    this.renderOverlay();
  }

  updateEmpty() {
    const p = state.project;
    this.empty.classList.toggle('show', !!p && p.clips.length === 0);
  }

  // -------------------------------------------------------------- transporte ----

  buildTransport() {
    const btn = (name, title, onclick, cls = '') => h('button', { class: `icon-btn ${cls}`, title, html: icon(name, 17), onclick });
    this.tcEl = h('div', { class: 'timecode', title: 'Posición del cursor' }, '00:00:00:00');
    this.durEl = h('div', { class: 'timecode dim', title: 'Duración del proyecto' }, '00:00:00:00');
    this.playBtn = btn('play', 'Reproducir / pausar (Espacio)', () => engine.toggle(), 'play-btn');
    this.meter = h('div', { class: 'meter', title: 'Nivel de salida' }, h('div', { class: 'meter-fill' }));
    this.transport.append(
      h('div', { class: 'transport-side' }, this.tcEl),
      h(
        'div',
        { class: 'transport-center' },
        btn('skipStart', 'Ir al inicio (Inicio)', () => engine.seek(0)),
        btn('prevFrame', 'Fotograma anterior (←)', () => engine.step(-1)),
        this.playBtn,
        btn('nextFrame', 'Fotograma siguiente (→)', () => engine.step(1)),
        btn('skipEnd', 'Ir al final (Fin)', () => engine.seek(M.projectDuration(state.project)))
      ),
      h('div', { class: 'transport-side right' }, this.meter, this.durEl)
    );
    const fill = this.meter.firstChild;
    let level = 0;
    const loop = () => {
      const target = state.playing ? Math.min(1, engine.level()) : 0;
      level = target > level ? target : level * 0.88;
      fill.style.transform = `scaleX(${Math.pow(level, 0.6).toFixed(3)})`;
      fill.classList.toggle('hot', level > 0.92);
      if (state.playing || level > 0.004) requestAnimationFrame(loop);
      else this.metering = false;
    };
    on('ui', (keys) => {
      if (keys.includes('playing') && state.playing && !this.metering) {
        this.metering = true;
        requestAnimationFrame(loop);
      }
    });
  }

  updatePlayButton() {
    this.playBtn.innerHTML = icon(state.playing ? 'pause' : 'play', 17);
    this.playBtn.classList.toggle('on', state.playing);
  }

  updateTime() {
    const p = state.project;
    if (!p) return;
    this.tcEl.textContent = formatTC(state.playhead, p.settings.fps);
    this.durEl.textContent = formatTC(M.projectDuration(p), p.settings.fps);
  }

  // ----------------------------------------------------------------- censura ----

  buildCensorHud() {
    this.modeSeg = segmented({
      options: [
        { id: 'pixelate', name: 'Pixelado', icon: 'censor' },
        { id: 'blur', name: 'Difuminado', icon: 'blur' },
      ],
      get: () => state.censorMode,
      set: (v) => setUI({ censorMode: v }),
    });
    this.shapeSeg = segmented({
      options: [
        { id: 'rect', name: 'Rectángulo', icon: 'rect', short: '' },
        { id: 'ellipse', name: 'Elipse', icon: 'ellipse', short: '' },
      ],
      get: () => state.censorShape,
      set: (v) => setUI({ censorShape: v }),
    });
    this.censorHud = h(
      'div',
      { class: 'hud-bar censor-hud' },
      h('span', { class: 'hud-ico', html: icon('censor', 16) }),
      h('span', { class: 'hud-text' }, 'Arrastra sobre lo que quieras tapar'),
      this.modeSeg.el,
      this.shapeSeg.el,
      h('button', { class: 'btn small primary', onclick: () => setUI({ viewerMode: null }) }, 'Listo')
    );
    this.hud.append(this.censorHud);
    this.updateCensorHud();
  }

  updateCensorHud() {
    this.censorHud.classList.toggle('show', state.viewerMode === 'censor');
    this.modeSeg.sync();
    this.shapeSeg.sync();
    this.overlay.classList.toggle('censor-mode', state.viewerMode === 'censor');
  }

  // ------------------------------------------------------------------ recorte ----

  buildCropHud() {
    const reset = () => {
      const c = primaryClip();
      if (isCroppable(c)) A.resetCrop(c);
    };
    this.cropHud = h(
      'div',
      { class: 'hud-bar crop-hud' },
      h('span', { class: 'hud-ico', html: icon('crop', 16) }),
      h('span', { class: 'hud-text' }, 'Arrastra los bordes para recortar la imagen'),
      h('button', { class: 'btn small', onclick: reset }, 'Restablecer'),
      h('button', { class: 'btn small primary', onclick: () => setUI({ viewerMode: null }) }, 'Listo')
    );
    this.hud.append(this.cropHud);
  }

  // --------------------------------------------------------------- tiradores ----

  toProject(e) {
    const r = this.frame.getBoundingClientRect();
    const k = r.width / state.project.settings.width;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k];
  }

  /** Clip visual seleccionado y visible en el cursor, con su capa evaluada. */
  activeLayer() {
    const p = state.project;
    const clip = primaryClip();
    const t = state.playhead;
    if (!clip || !M.isVisual(clip)) return null;
    if (t < clip.start - 1e-6 || t >= M.clipEnd(clip) - 1e-6) return null;
    const track = M.trackById(p, clip.trackId);
    if (!track || track.hidden) return null;
    const layer = evalLayer(p, clip, t);
    return { clip, layer, m: layerMatrix(layer, p.settings.width, p.settings.height), locked: track.locked };
  }

  paintOverlay() {
    const svg = this.svg;
    svg.replaceChildren();
    const p = state.project;
    if (!p) return;
    const fw = this.fw;
    const fh = this.fh;
    svg.setAttribute('viewBox', `0 0 ${fw} ${fh}`);
    svg.setAttribute('width', fw);
    svg.setAttribute('height', fh);
    if (state.playing) return;
    const { width: W, height: H } = p.settings;
    const k = fw / W;

    if (this.guides.v) svg.append(s('line', { x1: fw / 2, y1: 0, x2: fw / 2, y2: fh, class: 'gz-guide' }));
    if (this.guides.h) svg.append(s('line', { x1: 0, y1: fh / 2, x2: fw, y2: fh / 2, class: 'gz-guide' }));

    const act = this.activeLayer();
    if (act && !act.locked) {
      const { clip, layer, m } = act;
      const P = (lx, ly) => {
        const [x, y] = mat.apply(m, lx, ly);
        return [x * k, y * k];
      };
      const censorMode = state.viewerMode === 'censor';
      const cropMode = state.viewerMode === 'crop' && isCroppable(clip);
      const activeCensor = (clip.censors || []).find((r) => r.id === state.activeCensor);
      const activeZoom = (clip.zooms || []).find((z) => z.id === state.activeZoom);
      const transformMode = !censorMode && !cropMode && !activeCensor && !activeZoom;
      // Zona visible del clip (toda la imagen si no hay recorte), en coordenadas locales.
      const [cl, ct, cr, cb] = layer.crop;
      const x0 = cl - 0.5;
      const x1 = 0.5 - cr;
      const y0 = ct - 0.5;
      const y1 = 0.5 - cb;
      const full = [P(-0.5, -0.5), P(0.5, -0.5), P(0.5, 0.5), P(-0.5, 0.5)];
      const corners = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];

      if (cropMode) {
        const ring = (list) => `M${list.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`;
        svg.append(s('path', { d: ring(full) + ring(corners), 'fill-rule': 'evenodd', class: 'gz-crop-dim' }));
        for (const f of [1 / 3, 2 / 3]) {
          const a = P(x0 + (x1 - x0) * f, y0);
          const b = P(x0 + (x1 - x0) * f, y1);
          const c = P(x0, y0 + (y1 - y0) * f);
          const d = P(x1, y0 + (y1 - y0) * f);
          svg.append(s('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: 'gz-crop-grid' }));
          svg.append(s('line', { x1: c[0], y1: c[1], x2: d[0], y2: d[1], class: 'gz-crop-grid' }));
        }
        const win = s('polygon', { points: pts(corners), class: 'gz-crop' });
        win.dataset.role = 'crop-move';
        svg.append(win);
        for (const hx of [-1, 0, 1]) {
          for (const hy of [-1, 0, 1]) {
            if (!hx && !hy) continue;
            const [px, py] = P(hx < 0 ? x0 : hx > 0 ? x1 : (x0 + x1) / 2, hy < 0 ? y0 : hy > 0 ? y1 : (y0 + y1) / 2);
            const hd = s('rect', { x: px - 5, y: py - 5, width: 10, height: 10, rx: 2, class: 'gz-handle crop' });
            hd.dataset.role = 'crop-size';
            hd.dataset.hx = hx;
            hd.dataset.hy = hy;
            svg.append(hd);
          }
        }
      } else {
        const box = s('polygon', { points: pts(corners), class: `gz-box${transformMode ? '' : ' dim'}` });
        if (transformMode) box.dataset.role = 'move';
        svg.append(box);
      }

      // Regiones de censura del clip
      const ts = layer.ts;
      for (const r of clip.censors || []) {
        if (!r.enabled) continue;
        if (r.start !== null && ts < r.start - 1e-4) continue;
        if (r.end !== null && ts > r.end + 1e-4) continue;
        const x = evalProp(r, 'x', ts) - 0.5;
        const y = evalProp(r, 'y', ts) - 0.5;
        const hw = evalProp(r, 'w', ts) / 2;
        const hh = evalProp(r, 'h', ts) / 2;
        const active = r.id === state.activeCensor;
        let outline;
        if (r.shape === 'ellipse') {
          outline = [];
          for (let i = 0; i < 48; i++) {
            const a = (i / 48) * Math.PI * 2;
            outline.push(P(x + Math.cos(a) * hw, y + Math.sin(a) * hh));
          }
        } else outline = [P(x - hw, y - hh), P(x + hw, y - hh), P(x + hw, y + hh), P(x - hw, y + hh)];
        const shape = s('polygon', { points: pts(outline), class: `gz-censor${active ? ' active' : ''}` });
        shape.dataset.role = 'censor';
        shape.dataset.id = r.id;
        svg.append(shape);
        if (active) {
          for (const hx of [-1, 0, 1]) {
            for (const hy of [-1, 0, 1]) {
              if (!hx && !hy) continue;
              const [px, py] = P(x + hx * hw, y + hy * hh);
              const hd = s('rect', { x: px - 4.5, y: py - 4.5, width: 9, height: 9, rx: 2, class: 'gz-handle' });
              hd.dataset.role = 'censor-size';
              hd.dataset.id = r.id;
              hd.dataset.hx = hx;
              hd.dataset.hy = hy;
              svg.append(hd);
            }
          }
        }
      }

      // Foco del zoom seleccionado y zona que quedará a la vista
      if (activeZoom && !censorMode) {
        const full = { ...layer, zooms: [{ s: activeZoom.scale, cx: activeZoom.cx, cy: activeZoom.cy }] };
        const inv = mat.invert(layerMatrix(full, W, H));
        const area = [[0, 0], [W, 0], [W, H], [0, H]].map(([X, Y]) => P(...mat.apply(inv, X, Y)));
        svg.append(s('polygon', { points: pts(area), class: 'gz-zoom-area' }));
        const base = layerMatrix({ ...layer, zooms: [] }, W, H);
        const [bx, by] = mat.apply(base, activeZoom.cx - 0.5, activeZoom.cy - 0.5);
        const fx = bx * k;
        const fy = by * k;
        svg.append(s('line', { x1: fx - 16, y1: fy, x2: fx + 16, y2: fy, class: 'gz-focus-line' }));
        svg.append(s('line', { x1: fx, y1: fy - 16, x2: fx, y2: fy + 16, class: 'gz-focus-line' }));
        const focus = s('circle', { cx: fx, cy: fy, r: 11, class: 'gz-focus' });
        focus.dataset.role = 'zoom-focus';
        svg.append(focus);
      }

      if (transformMode) {
        for (const c of corners) {
          const hd = s('rect', { x: c[0] - 5, y: c[1] - 5, width: 10, height: 10, rx: 2, class: 'gz-handle' });
          hd.dataset.role = 'scale';
          svg.append(hd);
        }
        const top = P((x0 + x1) / 2, y0);
        const up = P(0, -0.5);
        const center = P(0, 0);
        const dx = up[0] - center[0];
        const dy = up[1] - center[1];
        const len = Math.hypot(dx, dy) || 1;
        const rx = top[0] + (dx / len) * 26;
        const ry = top[1] + (dy / len) * 26;
        svg.append(s('line', { x1: top[0], y1: top[1], x2: rx, y2: ry, class: 'gz-stem' }));
        const rot = s('circle', { cx: rx, cy: ry, r: 6, class: 'gz-rotate' });
        rot.dataset.role = 'rotate';
        svg.append(rot);
      }
    }

    if (this.draft) {
      const d = this.draft;
      const P = (lx, ly) => {
        const [x, y] = mat.apply(d.m, lx, ly);
        return [x * k, y * k];
      };
      const u0 = Math.min(d.u0, d.u1) - 0.5;
      const u1 = Math.max(d.u0, d.u1) - 0.5;
      const v0 = Math.min(d.v0, d.v1) - 0.5;
      const v1 = Math.max(d.v0, d.v1) - 0.5;
      let outline;
      if (state.censorShape === 'ellipse') {
        outline = [];
        for (let i = 0; i < 48; i++) {
          const a = (i / 48) * Math.PI * 2;
          outline.push(P((u0 + u1) / 2 + (Math.cos(a) * (u1 - u0)) / 2, (v0 + v1) / 2 + (Math.sin(a) * (v1 - v0)) / 2));
        }
      } else outline = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)];
      svg.append(s('polygon', { points: pts(outline), class: 'gz-censor draft' }));
    }
  }

  onDown(e) {
    if (e.button !== 0 || state.playing) return;
    const p = state.project;
    const { width: W, height: H } = p.settings;
    const role = e.target.dataset ? e.target.dataset.role : null;
    const [px, py] = this.toProject(e);
    const act = this.activeLayer();

    if (state.viewerMode === 'censor' && role !== 'censor' && role !== 'censor-size') {
      const scene = buildScene(p, state.playhead);
      const isMedia = (l) => l.kind === 'video' || l.kind === 'image';
      let layer = (hitLayer(scene, px, py, isMedia) || {}).layer;
      if (!layer && act && isMedia(act.layer)) layer = act.layer;
      if (!layer) layer = sceneLayers(scene).reverse().find(isMedia);
      if (!layer) {
        toast('Coloca el cursor sobre un video o una imagen para censurar');
        return;
      }
      if (M.trackById(p, layer.clip.trackId)?.locked) {
        toast('La pista está bloqueada');
        return;
      }
      const m = layerMatrix(layer, W, H);
      const inv = mat.invert(m);
      const [lx, ly] = mat.apply(inv, px, py);
      const u = clamp(lx + 0.5, 0, 1);
      const v = clamp(ly + 0.5, 0, 1);
      this.draft = { clip: layer.clip, m, inv, u0: u, v0: v, u1: u, v1: v };
      this.drag = { kind: 'draft' };
      this.overlay.setPointerCapture(e.pointerId);
      return;
    }

    if (!role || !act) {
      // Clic sobre la imagen: selecciona el clip que hay debajo.
      const hit = hitLayer(buildScene(p, state.playhead), px, py);
      if (hit) {
        if (!act || act.clip.id !== hit.layer.clip.id) select(hit.layer.clip.id);
        setUI({ activeCensor: null, activeZoom: null });
      } else if (state.viewerMode !== 'censor') select([]);
      return;
    }

    const { clip, layer, m } = act;
    const ts = layer.ts;
    const inv = mat.invert(m);
    const center = mat.apply(m, 0, 0);
    const d = { kind: role, clip, moved: false, px, py };

    if (role === 'move') {
      d.ox = layer.x;
      d.oy = layer.y;
    } else if (role === 'scale') {
      d.center = center;
      d.d0 = Math.max(1, Math.hypot(px - center[0], py - center[1]));
      d.s0 = layer.scale;
    } else if (role === 'rotate') {
      d.center = center;
      d.a0 = Math.atan2(py - center[1], px - center[0]);
      d.r0 = layer.rotation;
    } else if (role === 'censor' || role === 'censor-size') {
      const region = clip.censors.find((r) => r.id === e.target.dataset.id);
      if (!region) return;
      if (state.activeCensor !== region.id) setUI({ activeCensor: region.id, activeZoom: null });
      const [lx, ly] = mat.apply(inv, px, py);
      d.region = region;
      d.inv = inv;
      d.u0 = lx + 0.5;
      d.v0 = ly + 0.5;
      const x = evalProp(region, 'x', ts);
      const y = evalProp(region, 'y', ts);
      const w = evalProp(region, 'w', ts);
      const hh = evalProp(region, 'h', ts);
      d.rect = { x, y, w, h: hh, l: x - w / 2, r: x + w / 2, t: y - hh / 2, b: y + hh / 2 };
      d.hx = Number(e.target.dataset.hx || 0);
      d.hy = Number(e.target.dataset.hy || 0);
    } else if (role === 'crop-move' || role === 'crop-size') {
      const [lx, ly] = mat.apply(inv, px, py);
      const c = A.cropAt(clip, ts);
      d.inv = inv;
      d.u0 = lx + 0.5;
      d.v0 = ly + 0.5;
      d.rect = { l: c.cropL, t: c.cropT, r: 1 - c.cropR, b: 1 - c.cropB };
      d.hx = Number(e.target.dataset.hx || 0);
      d.hy = Number(e.target.dataset.hy || 0);
    } else if (role === 'zoom-focus') {
      d.zoom = clip.zooms.find((z) => z.id === state.activeZoom);
      if (!d.zoom) return;
      d.inv = mat.invert(layerMatrix({ ...layer, zooms: [] }, W, H));
    }
    this.drag = d;
    this.overlay.setPointerCapture(e.pointerId);
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return;
    const p = state.project;
    const [px, py] = this.toProject(e);

    if (d.kind === 'draft') {
      const [lx, ly] = mat.apply(this.draft.inv, px, py);
      this.draft.u1 = clamp(lx + 0.5, 0, 1);
      this.draft.v1 = clamp(ly + 0.5, 0, 1);
      this.renderOverlay();
      return;
    }

    if (!d.moved) {
      if (Math.hypot(px - d.px, py - d.py) * (this.fw / p.settings.width) < 3) return;
      d.moved = true;
      beginTxn('Ajustar en el visor');
    }
    const clip = d.clip;
    const ts = A.clipTs(clip);

    if (d.kind === 'move') {
      let x = d.ox + (px - d.px);
      let y = d.oy + (py - d.py);
      const tol = 9 / (this.fw / p.settings.width);
      this.guides.v = !e.ctrlKey && Math.abs(x) < tol;
      this.guides.h = !e.ctrlKey && Math.abs(y) < tol;
      if (this.guides.v) x = 0;
      if (this.guides.h) y = 0;
      setProp(clip, 'x', ts, Math.round(x * 10) / 10);
      setProp(clip, 'y', ts, Math.round(y * 10) / 10);
    } else if (d.kind === 'scale') {
      const dist = Math.hypot(px - d.center[0], py - d.center[1]);
      let v = clamp((d.s0 * dist) / d.d0, 0.02, 20);
      if (!e.ctrlKey && Math.abs(v - 1) < 0.02) v = 1;
      setProp(clip, 'scale', ts, Math.round(v * 1000) / 1000);
    } else if (d.kind === 'rotate') {
      const a = Math.atan2(py - d.center[1], px - d.center[0]);
      let deg = d.r0 + ((a - d.a0) * 180) / Math.PI;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      else {
        const near = Math.round(deg / 90) * 90;
        if (Math.abs(deg - near) < 3) deg = near;
      }
      setProp(clip, 'rotation', ts, Math.round(deg * 10) / 10);
    } else if (d.kind === 'censor') {
      const [lx, ly] = mat.apply(d.inv, px, py);
      const x = clamp(d.rect.x + (lx + 0.5 - d.u0), 0, 1);
      const y = clamp(d.rect.y + (ly + 0.5 - d.v0), 0, 1);
      A.writeCensorRect(clip, d.region, { x, y });
    } else if (d.kind === 'censor-size') {
      const [lx, ly] = mat.apply(d.inv, px, py);
      const u = lx + 0.5;
      const v = ly + 0.5;
      let { l, r, t, b } = d.rect;
      if (d.hx < 0) l = Math.min(u, r - 0.01);
      if (d.hx > 0) r = Math.max(u, l + 0.01);
      if (d.hy < 0) t = Math.min(v, b - 0.01);
      if (d.hy > 0) b = Math.max(v, t + 0.01);
      A.writeCensorRect(clip, d.region, { x: (l + r) / 2, y: (t + b) / 2, w: r - l, h: b - t });
    } else if (d.kind === 'crop-size') {
      const [lx, ly] = mat.apply(d.inv, px, py);
      // Cerca del borde de la imagen el recorte se pega a él (Ctrl lo evita).
      const snap = (x) => (!e.ctrlKey && x < 0.012 ? 0 : !e.ctrlKey && x > 0.988 ? 1 : x);
      const u = snap(clamp(lx + 0.5, 0, 1));
      const v = snap(clamp(ly + 0.5, 0, 1));
      const { l, r, t, b } = d.rect;
      const out = {};
      if (d.hx < 0) out.cropL = Math.min(u, r - 0.02);
      if (d.hx > 0) out.cropR = 1 - Math.max(u, l + 0.02);
      if (d.hy < 0) out.cropT = Math.min(v, b - 0.02);
      if (d.hy > 0) out.cropB = 1 - Math.max(v, t + 0.02);
      A.writeCrop(clip, out);
    } else if (d.kind === 'crop-move') {
      const [lx, ly] = mat.apply(d.inv, px, py);
      const { l, r, t, b } = d.rect;
      const du = clamp(lx + 0.5 - d.u0, -l, 1 - r);
      const dv = clamp(ly + 0.5 - d.v0, -t, 1 - b);
      A.writeCrop(clip, { cropL: l + du, cropR: 1 - (r + du), cropT: t + dv, cropB: 1 - (b + dv) });
    } else if (d.kind === 'zoom-focus') {
      const [lx, ly] = mat.apply(d.inv, px, py);
      d.zoom.cx = Math.round(clamp(lx + 0.5, 0, 1) * 1000) / 1000;
      d.zoom.cy = Math.round(clamp(ly + 0.5, 0, 1) * 1000) / 1000;
    }
    touch();
  }

  onUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try {
      this.overlay.releasePointerCapture(e.pointerId);
    } catch {
      /* ya liberado */
    }
    this.guides = { v: false, h: false };

    if (d.kind === 'draft') {
      const f = this.draft;
      this.draft = null;
      const w = Math.abs(f.u1 - f.u0);
      const hh = Math.abs(f.v1 - f.v0);
      if (w > 0.012 && hh > 0.012) {
        A.addCensor(f.clip, { x: (f.u0 + f.u1) / 2, y: (f.v0 + f.v1) / 2, w, h: hh });
      } else {
        toast('Arrastra para dibujar la zona que quieres tapar');
      }
      this.renderOverlay();
      return;
    }
    if (d.moved) endTxn();
    this.renderOverlay();
  }
}
