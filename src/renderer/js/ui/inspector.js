// Inspector: propiedades del clip seleccionado (transformación, recorte, velocidad, zoom, color,
// efectos, censura, audio, transiciones y texto) con botones de keyframe en cada propiedad animable.

import { state, on, emit, setUI, primaryClip, mutate, setPlayhead } from '../core/store.js';
import * as M from '../core/model.js';
import * as A from '../core/actions.js';
import { h, clear, rafThrottle, formatTC, clamp } from '../core/util.js';
import { evalProp, hasKeys, keyAt } from '../core/keyframes.js';
import { COLOR_PRESETS, COLOR_DEFAULT, colorFromPreset, TRANSITIONS, AUDIO_TRANSITIONS, VIDEO_EFFECTS, AUDIO_EFFECTS, effectById, ZOOM_MODES, RESOLUTIONS, FRAME_RATES, FALLBACK_FONTS, DEFAULT_TRANSITION_DURATION } from '../core/presets.js';
import { baseSize } from '../render/scene.js';
import { icon } from './icons.js';
import { section, sliderRow, selectRow, colorRow, toggleRow, segmented, textAreaRow, button, contextMenu, toast } from './widgets.js';
import { trackCensor, isTracking } from '../features/tracker.js';
import { openVideoSettings } from './settingsui.js';

const collapsed = new Map([
  ['transform', false],
  ['crop', true],
  ['speed', true],
  ['zoom', false],
  ['color', true],
  ['effects', true],
  ['censor', false],
  ['audio', false],
  ['transitions', true],
  ['text', false],
  ['textstyle', true],
  ['project', false],
]);

let fontList = null;
let fontPromise = null;
function loadFonts() {
  if (!fontPromise) {
    fontPromise = (async () => {
      try {
        const fonts = await window.queryLocalFonts();
        const fam = [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
        fontList = fam.length ? fam : FALLBACK_FONTS;
      } catch {
        fontList = FALLBACK_FONTS;
      }
      return fontList;
    })();
  }
  return fontPromise;
}

const fix = (digits) => (v) => (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits);
const signed = (v) => `${v > 0 ? '+' : ''}${Math.round(v)}`;

export class Inspector {
  constructor() {
    this.el = document.getElementById('inspector');
    this.controls = [];
    this.sig = null;
    this.generation = 0;
    const refresh = rafThrottle(() => this.refresh());
    const sync = rafThrottle(() => this.sync());
    on('selection', refresh);
    on('project', (info) => {
      if (info && (info.restore || info.load)) this.generation++;
      refresh();
    });
    on('playhead', sync);
    on('ui', (keys) => {
      if (keys.some((k) => ['activeCensor', 'activeZoom', 'workspace', 'viewerMode', 'tracking'].includes(k))) refresh();
    });
    // Otra parte de la interfaz pide ver una sección: se despliega y se lleva a la vista.
    on('reveal-section', (key) => {
      collapsed.set(key, false);
      this.sig = null;
      this.refresh();
      const el = this.el.querySelector(`[data-sec="${key}"]`);
      if (el) el.scrollIntoView({ block: 'nearest' });
    });
    on('focus-text', () => {
      const ta = this.el.querySelector('textarea');
      if (ta) {
        ta.focus();
        ta.select();
      }
    });
    this.refresh();
  }

  // Importante: la firma no puede depender de valores que cambian mientras se arrastra un control
  // (color aplicado, recorte, velocidad…). Si cambiara, el panel se reconstruiría y el arrastre se
  // cortaría a mitad. Esas marcas se actualizan en sync().
  signature() {
    const p = state.project;
    if (!p) return 'none';
    const c = primaryClip();
    if (!c) return `project|${this.generation}|${state.workspace}`;
    return JSON.stringify([
      this.generation,
      c.id,
      c.type,
      state.selection.length,
      state.workspace,
      state.activeCensor,
      state.activeZoom,
      state.viewerMode,
      isTracking(),
      (c.effects || []).map((e) => e.id),
      (c.censors || []).map((r) => `${r.id}${r.mode}${r.enabled}`),
      (c.zooms || []).map((z) => `${z.id}${z.mode}`),
      c.transIn ? 1 : 0,
      c.transOut ? 1 : 0,
      c.audioTransIn ? 1 : 0,
      c.audioDetached ? 1 : 0,
      c.text ? [c.text.bg, c.text.shadow] : 0,
      fontList ? fontList.length : 0,
    ]);
  }

  refresh() {
    const sig = this.signature();
    if (sig !== this.sig) {
      this.sig = sig;
      this.build();
    } else this.sync();
  }

  sync() {
    for (const c of this.controls) c.sync();
  }

  add(control) {
    this.controls.push(control);
    return control.el;
  }

  sec(key, title, ico, children, opts = {}) {
    const el = section(title, children, {
      icon: ico,
      collapsed: collapsed.get(key),
      onToggle: (v) => collapsed.set(key, v),
      ...opts,
    });
    el.dataset.sec = key;
    return el;
  }

  build() {
    const scroll = this.el.scrollTop;
    clear(this.el);
    this.controls = [];
    const p = state.project;
    if (!p) return;
    const clip = primaryClip();
    if (!clip) {
      this.buildProject(p);
      return;
    }
    const typeName = { video: 'Video', audio: 'Audio', image: 'Imagen', text: 'Texto' }[clip.type];
    this.el.append(
      h(
        'div',
        { class: 'insp-head' },
        h('span', { class: `insp-type ${clip.type}`, html: icon({ video: 'film', audio: 'music', image: 'image', text: 'type' }[clip.type], 14) }),
        h('div', { class: 'insp-title' }, h('b', { title: clip.name }, clip.name), this.add({ el: h('span', {}), sync() { this.el.textContent = `${typeName} · ${formatTC(clip.duration, p.settings.fps)}`; } })),
        state.selection.length > 1 ? h('span', { class: 'insp-multi', title: 'Los ajustes se aplican al último clip seleccionado' }, `+${state.selection.length - 1}`) : null
      )
    );
    if (clip.type === 'text') this.buildText(clip);
    if (M.isVisual(clip)) this.buildTransform(clip, p);
    if (clip.type === 'video' || clip.type === 'image') this.buildCrop(clip, p);
    if ('speed' in clip) this.buildSpeed(clip, p);
    if (clip.type === 'video' || clip.type === 'image') {
      this.buildZoom(clip, p);
      this.buildCensor(clip, p);
      this.buildColor(clip);
    }
    if (M.isVisual(clip)) this.buildEffects(clip);
    if ('volume' in clip && (clip.type === 'audio' || M.clipHasAudio(p, clip) || clip.audioDetached)) this.buildAudio(clip, p);
    if (M.isVisual(clip) || M.clipHasAudio(p, clip)) this.buildTransitions(clip, p);
    this.sync();
    this.el.scrollTop = scroll;
  }

  kf(obj, prop, clip, e = 'ease') {
    return {
      state: () => (!hasKeys(obj, prop) ? 'none' : keyAt(obj, prop, A.clipTs(clip)) ? 'on' : 'has'),
      toggle: () => A.toggleKeyframe(obj, prop, clip, e),
      prev: () => A.gotoKeyframe(obj, prop, clip, -1),
      next: () => A.gotoKeyframe(obj, prop, clip, 1),
    };
  }

  // ---------------------------------------------------------------- proyecto ----

  buildProject(p) {
    const s = p.settings;
    const resId = `${s.width}x${s.height}`;
    const resOptions = RESOLUTIONS.some((r) => r.id === resId) ? RESOLUTIONS : [{ id: resId, name: `Personalizada · ${s.width}×${s.height}`, w: s.width, h: s.height }, ...RESOLUTIONS];
    const fpsOptions = FRAME_RATES.includes(s.fps) ? FRAME_RATES : [s.fps, ...FRAME_RATES];
    this.el.append(
      h('div', { class: 'insp-head' }, h('span', { class: 'insp-type', html: icon('sliders', 14) }), h('div', { class: 'insp-title' }, h('b', {}, 'Proyecto'), h('span', {}, 'Selecciona un clip para ver sus propiedades'))),
      this.sec('project', 'Formato del proyecto', 'film', [
        this.add(
          selectRow({
            label: 'Resolución',
            options: resOptions,
            get: () => `${state.project.settings.width}x${state.project.settings.height}`,
            set: (id) => {
              const r = resOptions.find((x) => x.id === id);
              if (r) A.setProjectSettings({ width: r.w, height: r.h });
            },
          })
        ),
        this.add(
          selectRow({
            label: 'Fotogramas/s',
            options: fpsOptions.map((f) => ({ id: String(f), name: `${f} fps` })),
            get: () => String(state.project.settings.fps),
            set: (v) => A.setProjectSettings({ fps: Number(v) }),
          })
        ),
        this.add(colorRow({ label: 'Fondo', get: () => state.project.settings.background, set: (v) => A.setProjectSettings({ background: v }) })),
        h('div', { class: 'btn-row' }, button('Más opciones (vertical, cuadrado, personalizado)…', () => openVideoSettings(), { small: true, block: true, icon: 'sliders' })),
        h('p', { class: 'insp-note' }, 'El proyecto toma por defecto la resolución y los fotogramas del primer video que añadas. También puedes cambiarlos con Ctrl+K o desde el botón de resolución de la barra superior.'),
      ]),
      h(
        'div',
        { class: 'insp-tips' },
        h('h4', {}, 'Atajos útiles'),
        ...[
          ['Espacio', 'Reproducir / pausar'],
          ['B / A', 'Cuchilla / selección'],
          ['Ctrl+B', 'Cortar en el cursor'],
          ['N', 'Imán'],
          ['Supr', 'Eliminar'],
          ['← →', 'Fotograma a fotograma'],
          ['↑ ↓', 'Corte anterior / siguiente'],
          ['Ctrl+rueda', 'Zoom de la línea temporal'],
        ].map(([k, t]) => h('div', { class: 'tip' }, h('kbd', {}, k), h('span', {}, t)))
      )
    );
  }

  // ---------------------------------------------------------- transformación ----

  buildTransform(clip, p) {
    const { width: W, height: H } = p.settings;
    const val = (prop) => () => evalProp(clip, prop, A.clipTs(clip));
    const rows = [
      this.add(sliderRow({ label: 'Posición X', min: -W, max: W, step: 1, def: 0, hardMin: -W * 4, hardMax: W * 4, get: val('x'), set: (v) => A.setClipProp(clip, 'x', v, 'Posición'), format: fix(0), kf: this.kf(clip, 'x', clip) })),
      this.add(sliderRow({ label: 'Posición Y', min: -H, max: H, step: 1, def: 0, hardMin: -H * 4, hardMax: H * 4, get: val('y'), set: (v) => A.setClipProp(clip, 'y', v, 'Posición'), format: fix(0), kf: this.kf(clip, 'y', clip) })),
      this.add(sliderRow({ label: 'Escala %', min: 10, max: 400, step: 1, def: 100, hardMin: 1, hardMax: 2000, get: () => val('scale')() * 100, set: (v) => A.setClipProp(clip, 'scale', v / 100, 'Escala'), format: fix(0), kf: this.kf(clip, 'scale', clip) })),
      this.add(sliderRow({ label: 'Rotación °', min: -180, max: 180, step: 0.5, def: 0, hardMin: -3600, hardMax: 3600, get: val('rotation'), set: (v) => A.setClipProp(clip, 'rotation', v, 'Rotación'), format: fix(1), kf: this.kf(clip, 'rotation', clip) })),
      this.add(sliderRow({ label: 'Opacidad %', min: 0, max: 100, step: 1, def: 100, get: () => val('opacity')() * 100, set: (v) => A.setClipProp(clip, 'opacity', v / 100, 'Opacidad'), format: fix(0), kf: this.kf(clip, 'opacity', clip) })),
    ];
    const setMany = (label, values) =>
      mutate(label, () => {
        const ts = A.clipTs(clip);
        for (const [k, v] of Object.entries(values)) {
          if (hasKeys(clip, k)) {
            const key = keyAt(clip, k, ts);
            if (key) key.v = v;
            else clip.kf[k].push({ t: ts, v, e: 'ease' }), clip.kf[k].sort((a, b) => a.t - b.t);
          } else clip[k] = v;
        }
      });
    // Encaja (o hace cubrir) la parte visible del clip en el cuadro, teniendo en cuenta el recorte.
    const place = (label, cover) => {
      if (clip.type === 'text') return setMany(label, { x: 0, y: 0, scale: 1, rotation: 0 });
      const [bw, bh] = baseSize(p, clip);
      const c = A.cropAt(clip);
      const vw = bw * (1 - c.cropL - c.cropR);
      const vh = bh * (1 - c.cropT - c.cropB);
      const sc = cover ? Math.max(W / vw, H / vh) : Math.min(W / vw, H / vh);
      const round = (v) => Math.round(v * 1000) / 1000;
      return setMany(label, { x: round(-((c.cropL - c.cropR) / 2) * bw * sc), y: round(-((c.cropT - c.cropB) / 2) * bh * sc), scale: round(sc), rotation: 0 });
    };
    this.place = place;
    const actions = h(
      'div',
      { class: 'btn-row' },
      button('Ajustar', () => place('Ajustar al cuadro', false), { small: true, title: 'Centra y encaja el clip en el cuadro' }),
      clip.type !== 'text' ? button('Rellenar', () => place('Rellenar el cuadro', true), { small: true, title: 'Amplía hasta cubrir todo el cuadro' }) : null
    );
    this.el.append(this.sec('transform', 'Transformación', 'fit', [...rows, actions, h('p', { class: 'insp-note' }, 'También puedes arrastrar el clip en el visor. Pulsa ◆ para animar una propiedad con keyframes.')]));
  }

  // ------------------------------------------------------------------ recorte ----

  buildCrop(clip, p) {
    const media = M.mediaById(p, clip.mediaId);
    const aspect = media && media.width && media.height ? media.width / media.height : p.settings.width / p.settings.height;
    const cropping = state.viewerMode === 'crop';
    const side = (label, prop) =>
      this.add(sliderRow({ label, min: 0, max: 90, step: 0.1, def: 0, get: () => (evalProp(clip, prop, A.clipTs(clip)) || 0) * 100, set: (v) => A.setCrop(clip, prop, v / 100), format: fix(1), kf: this.kf(clip, prop, clip) }));
    const RATIOS = [
      { id: 'free', name: 'Libre' },
      { id: 'orig', name: 'Original (sin recorte)', r: aspect },
      { id: '16:9', name: '16:9 · horizontal', r: 16 / 9 },
      { id: '9:16', name: '9:16 · vertical', r: 9 / 16 },
      { id: '1:1', name: '1:1 · cuadrado', r: 1 },
      { id: '4:5', name: '4:5 · retrato', r: 4 / 5 },
      { id: '4:3', name: '4:3', r: 4 / 3 },
      { id: '21:9', name: '21:9 · cine', r: 21 / 9 },
    ];
    const current = () => {
      const c = A.cropAt(clip);
      if (!c.cropL && !c.cropT && !c.cropR && !c.cropB) return 'orig';
      const r = (aspect * (1 - c.cropL - c.cropR)) / (1 - c.cropT - c.cropB);
      const hit = RATIOS.find((x) => x.r && x.id !== 'orig' && Math.abs(x.r / r - 1) < 0.004);
      return hit ? hit.id : 'free';
    };
    const body = [
      button(cropping ? 'Recortando… arrastra los bordes en el visor' : 'Recortar en el visor', () => (cropping ? setUI({ viewerMode: null }) : A.startCrop(clip)), { icon: 'crop', block: true, small: true, primary: !cropping }),
      this.add(
        selectRow({
          label: 'Proporción',
          options: RATIOS,
          get: current,
          set: (id) => {
            const opt = RATIOS.find((x) => x.id === id);
            if (opt && opt.r) A.cropToAspect(clip, opt.r, aspect);
          },
        })
      ),
      side('Izquierda %', 'cropL'),
      side('Derecha %', 'cropR'),
      side('Arriba %', 'cropT'),
      side('Abajo %', 'cropB'),
      h(
        'div',
        { class: 'btn-row' },
        button('Rellenar el cuadro', () => this.place('Rellenar el cuadro', true), { small: true, title: 'Amplía lo que queda del clip hasta cubrir todo el cuadro' }),
        button('Quitar recorte', () => A.resetCrop(clip), { small: true, icon: 'reset' })
      ),
      h('p', { class: 'insp-note' }, 'El recorte quita los bordes de la imagen. Con «Rellenar el cuadro» lo que queda ocupa toda la pantalla, por ejemplo para pasar un video horizontal a vertical.'),
    ];
    const sec = this.sec('crop', 'Recorte', 'crop', body, { badge: '●' });
    // La marca se actualiza sin reconstruir el panel (reconstruirlo cortaría el arrastre de un control).
    const badge = sec.querySelector('.sec-badge');
    this.add({ el: sec, sync: () => { badge.style.display = A.hasCrop(clip) ? '' : 'none'; } });
    this.el.append(sec);
  }

  // ---------------------------------------------------------------- velocidad ----

  buildSpeed(clip, p) {
    const fps = p.settings.fps;
    const fd = 1 / fps;
    const hasSound = clip.type === 'audio' || M.clipHasAudio(p, clip);
    const span = M.sourceSpan(clip);
    const PRESETS = [0.25, 0.5, 1, 1.5, 2, 4];
    const presetBtns = PRESETS.map((v) => button(`${v}×`, () => A.setClipSpeed(clip, v), { small: true, title: v === 1 ? 'Velocidad normal' : v < 1 ? 'Cámara lenta' : 'Cámara rápida' }));
    const status = {
      el: h('div', { class: 'btn-row speed-presets' }, presetBtns),
      sync: () => {
        const v = M.speedOf(clip);
        presetBtns.forEach((b, i) => b.classList.toggle('primary', Math.abs(PRESETS[i] - v) < 1e-3));
      },
    };
    status.sync();
    const body = [
      this.add(sliderRow({ label: 'Velocidad ×', hint: 'Menos de 1 es cámara lenta; más de 1, cámara rápida. Doble clic para volver a 1×', min: 0.1, max: 4, step: 0.05, def: 1, hardMin: M.MIN_SPEED, hardMax: M.MAX_SPEED, get: () => M.speedOf(clip), set: (v) => A.setClipSpeed(clip, v), format: fix(2) })),
      this.add(status),
      this.add(
        sliderRow({
          label: 'Duración s',
          hint: 'Escribe cuánto debe durar el clip y la velocidad se ajusta sola',
          min: Math.max(fd, span / 4),
          max: Math.max(fd * 2, span / 0.25),
          step: fd,
          hardMin: Math.max(fd, span / M.MAX_SPEED),
          hardMax: Math.max(fd * 2, span / M.MIN_SPEED),
          get: () => clip.duration,
          set: (v) => A.setClipDuration(clip, v),
          format: fix(2),
        })
      ),
      hasSound ? this.add(toggleRow({ label: 'Mantener tono', hint: 'Evita que las voces suenen agudas o graves al cambiar la velocidad', get: () => clip.pitch !== false, set: (v) => A.setClipField(clip, 'pitch', !!v) })) : null,
      h('p', { class: 'insp-note' }, 'El clip sigue mostrando el mismo material: al acelerarlo se acorta y al frenarlo se alarga. Zooms, censuras y keyframes se mueven con él.'),
    ];
    const sec = this.sec('speed', 'Velocidad', 'gauge', body, { badge: '1×' });
    const badge = sec.querySelector('.sec-badge');
    this.add({
      el: sec,
      sync: () => {
        const v = M.speedOf(clip);
        badge.textContent = `${Math.round(v * 100) / 100}×`;
        badge.style.display = Math.abs(v - 1) > 1e-3 ? '' : 'none';
      },
    });
    this.el.append(sec);
  }

  // -------------------------------------------------------------------- zoom ----

  buildZoom(clip, p) {
    const fps = p.settings.fps;
    const body = [];
    const zooms = clip.zooms || [];
    if (zooms.length) {
      body.push(
        h(
          'div',
          { class: 'item-list' },
          zooms.map((z, i) =>
            h(
              'div',
              {
                class: `item${z.id === state.activeZoom ? ' on' : ''}`,
                onclick: () => {
                  setUI({ activeZoom: z.id === state.activeZoom ? null : z.id, activeCensor: null });
                  const t = A.tsToTimeline(clip, z.start);
                  if (state.playhead < t || state.playhead > A.tsToTimeline(clip, z.end)) setPlayhead(clamp(t + Math.min(z.ramp, (z.end - z.start) / 2) + 1 / fps, clip.start, M.clipEnd(clip) - 1 / fps));
                },
              },
              h('span', { class: 'item-ico', html: icon('zoomIn', 14) }),
              h('span', { class: 'item-name' }, `Zoom ${i + 1} · ${z.scale.toFixed(1)}×`),
              h('span', { class: 'item-sub' }, `${(z.end - z.start).toFixed(1)} s`),
              h('button', { class: 'icon-btn tiny', title: 'Eliminar zoom', html: icon('trash', 13), onclick: (e) => { e.stopPropagation(); A.removeZoom(clip, z.id); } })
            )
          )
        )
      );
    }
    body.push(button('Añadir zoom en el cursor', () => A.addZoom(clip), { icon: 'plus', block: true, small: true }));

    const z = zooms.find((x) => x.id === state.activeZoom);
    if (z) {
      const tc = (ts) => formatTC(Math.max(0, A.tsToTimeline(clip, ts)), fps);
      const startLbl = h('span', { class: 'mono' });
      const endLbl = h('span', { class: 'mono' });
      const marks = {
        el: h(
          'div',
          { class: 'mark-grid' },
          h('span', { class: 'row-label' }, 'Inicio'),
          startLbl,
          button('Marcar en el cursor', () => {
            const ts = A.clipTs(clip);
            if (ts >= z.end - 0.1) return toast('El inicio debe quedar antes del final del zoom');
            return A.updateZoom(clip, z, { start: ts });
          }, { small: true }),
          h('span', { class: 'row-label' }, 'Final'),
          endLbl,
          button('Marcar en el cursor', () => {
            const ts = A.clipTs(clip);
            if (ts <= z.start + 0.1) return toast('El final debe quedar después del inicio del zoom');
            return A.updateZoom(clip, z, { end: ts });
          }, { small: true })
        ),
        sync: () => {
          startLbl.textContent = tc(z.start);
          endLbl.textContent = tc(z.end);
        },
      };
      marks.sync();
      body.push(
        h('div', { class: 'sub-head' }, 'Ajustes del zoom seleccionado'),
        this.add(marks),
        this.add(selectRow({ label: 'Estilo', options: ZOOM_MODES, get: () => z.mode, set: (v) => A.updateZoom(clip, z, { mode: v }) })),
        this.add(sliderRow({ label: 'Aumento ×', min: 1, max: 5, step: 0.05, def: 1.6, hardMax: 12, get: () => z.scale, set: (v) => A.updateZoom(clip, z, { scale: v }), format: fix(2) })),
        z.mode === 'hold' ? this.add(sliderRow({ label: 'Suavidad s', hint: 'Cuánto tarda en acercarse y en volver', min: 0.05, max: 3, step: 0.05, def: 0.45, get: () => z.ramp, set: (v) => A.updateZoom(clip, z, { ramp: v }), format: fix(2) })) : null,
        this.add(sliderRow({ label: 'Foco X %', min: 0, max: 100, step: 0.5, def: 50, get: () => z.cx * 100, set: (v) => A.updateZoom(clip, z, { cx: v / 100 }), format: fix(1) })),
        this.add(sliderRow({ label: 'Foco Y %', min: 0, max: 100, step: 0.5, def: 50, get: () => z.cy * 100, set: (v) => A.updateZoom(clip, z, { cy: v / 100 }), format: fix(1) })),
        this.add(segmented({ label: 'Curva', options: [{ id: 'ease', name: 'Suave' }, { id: 'linear', name: 'Lineal' }], get: () => z.curve, set: (v) => A.updateZoom(clip, z, { curve: v }) })),
        h('p', { class: 'insp-note' }, 'Arrastra el punto amarillo del visor hacia lo que quieras acercar. El recuadro punteado muestra lo que quedará a la vista.')
      );
    } else if (!zooms.length) {
      body.push(h('p', { class: 'insp-note' }, 'Marca el inicio y el final, elige cuánto acercar y el editor anima el zoom por ti.'));
    }
    this.el.append(this.sec('zoom', 'Zoom', 'zoomIn', body, { badge: zooms.length ? String(zooms.length) : null }));
  }

  // ----------------------------------------------------------------- censura ----

  buildCensor(clip, p) {
    const fps = p.settings.fps;
    const regions = clip.censors || [];
    const body = [];
    const drawing = state.viewerMode === 'censor';
    body.push(
      button(drawing ? 'Dibujando… arrastra en el visor' : 'Dibujar zona de censura', () => setUI({ viewerMode: drawing ? null : 'censor' }), { icon: 'censor', block: true, small: true, primary: !drawing })
    );
    if (regions.length) {
      body.push(
        h(
          'div',
          { class: 'item-list' },
          regions.map((r, i) =>
            h(
              'div',
              { class: `item${r.id === state.activeCensor ? ' on' : ''}${r.enabled ? '' : ' off'}`, onclick: () => setUI({ activeCensor: r.id === state.activeCensor ? null : r.id, activeZoom: null }) },
              h('span', { class: 'item-ico', html: icon(r.mode === 'blur' ? 'blur' : 'censor', 14) }),
              h('span', { class: 'item-name' }, `Zona ${i + 1} · ${r.mode === 'blur' ? 'Difuminado' : 'Pixelado'}`),
              hasKeys(r, 'x') ? h('span', { class: 'item-sub', title: 'La zona se mueve con keyframes' }, 'sigue') : null,
              h('button', { class: 'icon-btn tiny', title: r.enabled ? 'Desactivar' : 'Activar', html: icon(r.enabled ? 'eye' : 'eyeOff', 13), onclick: (e) => { e.stopPropagation(); A.updateCensor(clip, r, { enabled: !r.enabled }); } }),
              h('button', { class: 'icon-btn tiny', title: 'Eliminar zona', html: icon('trash', 13), onclick: (e) => { e.stopPropagation(); A.removeCensor(clip, r.id); } })
            )
          )
        )
      );
    } else {
      body.push(h('p', { class: 'insp-note' }, 'Dibuja un recuadro sobre la placa, el rostro o el documento. Se pixela por defecto; puedes cambiarlo a difuminado.'));
    }

    const r = regions.find((x) => x.id === state.activeCensor);
    if (r) {
      const tracking = isTracking();
      const tc = (ts) => formatTC(Math.max(0, A.tsToTimeline(clip, ts)), fps);
      const rangeLbl = h('span', { class: 'mono small' });
      const range = {
        el: h(
          'div',
          { class: 'row block' },
          h('div', { class: 'range-line' }, h('span', { class: 'row-label' }, 'Visible'), rangeLbl),
          h(
            'div',
            { class: 'btn-row' },
            button('Desde el cursor', () => A.updateCensor(clip, r, { start: A.clipTs(clip) }), { small: true }),
            button('Hasta el cursor', () => A.updateCensor(clip, r, { end: A.clipTs(clip) }), { small: true }),
            button('Todo el clip', () => A.updateCensor(clip, r, { start: null, end: null }), { small: true })
          )
        ),
        sync: () => {
          rangeLbl.textContent = r.start === null && r.end === null ? 'Todo el clip' : `${r.start === null ? 'inicio' : tc(r.start)} → ${r.end === null ? 'final' : tc(r.end)}`;
        },
      };
      range.sync();
      body.push(
        h('div', { class: 'sub-head' }, 'Zona seleccionada'),
        this.add(segmented({ label: 'Tipo', options: [{ id: 'pixelate', name: 'Pixelado', icon: 'censor' }, { id: 'blur', name: 'Difuminado', icon: 'blur' }], get: () => r.mode, set: (v) => { A.updateCensor(clip, r, { mode: v }); setUI({ censorMode: v }); } })),
        this.add(segmented({ label: 'Forma', options: [{ id: 'rect', name: 'Rectángulo', icon: 'rect' }, { id: 'ellipse', name: 'Elipse', icon: 'ellipse' }], get: () => r.shape, set: (v) => { A.updateCensor(clip, r, { shape: v }); setUI({ censorShape: v }); } })),
        this.add(sliderRow({ label: 'Intensidad', min: 5, max: 100, step: 1, def: 50, get: () => r.strength, set: (v) => A.updateCensor(clip, r, { strength: v }), format: fix(0) })),
        r.mode === 'blur' ? this.add(sliderRow({ label: 'Borde suave', min: 0, max: 60, step: 1, def: 20, get: () => r.feather * 100, set: (v) => A.updateCensor(clip, r, { feather: v / 100 }), format: fix(0) })) : null,
        h(
          'div',
          { class: 'track-box' },
          button(tracking ? 'Siguiendo… (pulsa para detener)' : 'Seguir objeto automáticamente', () => trackCensor(clip, r), { icon: 'track', block: true, small: true, primary: !tracking }),
          h('p', { class: 'insp-note' }, 'Analiza el video desde el cursor y mueve la zona para que siga a lo que tapa (una placa, un rostro…).')
        ),
        this.add(
          toggleRow({
            label: 'Seguimiento manual',
            hint: 'Cada vez que muevas la zona en otro instante se crea un keyframe',
            get: () => hasKeys(r, 'x'),
            set: () => A.toggleCensorAnimation(clip, r),
          })
        ),
        this.add(range)
      );
    }
    this.el.append(this.sec('censor', 'Censura', 'censor', body, { badge: regions.length ? String(regions.length) : null }));
  }

  // ------------------------------------------------------------------- color ----

  buildColor(clip) {
    const c = () => clip.color || COLOR_DEFAULT;
    const param = (label, key, min, max, def, scale = 100, fmt = signed, step = 1) =>
      this.add(sliderRow({ label, min, max, step, def, get: () => c()[key] * scale, set: (v) => A.setColorParam(clip, key, v / scale), format: fmt }));
    const presetOptions = [...COLOR_PRESETS, { id: 'custom', name: 'Personalizado' }];
    const body = [
      this.add(
        selectRow({
          label: 'Plantilla',
          options: presetOptions,
          get: () => (clip.color ? clip.color.preset : 'none'),
          set: (id) => {
            if (id !== 'custom') A.applyColorPreset([clip], id);
          },
        })
      ),
      this.add(sliderRow({ label: 'Intensidad %', min: 0, max: 100, step: 1, def: 100, get: () => c().intensity * 100, set: (v) => A.setColorParam(clip, 'intensity', v / 100), format: fix(0) })),
      h('div', { class: 'sub-head' }, 'Ajuste fino'),
      param('Exposición', 'exposure', -200, 200, 0),
      param('Contraste', 'contrast', -100, 100, 0),
      param('Altas luces', 'highlights', -100, 100, 0),
      param('Sombras', 'shadows', -100, 100, 0),
      param('Saturación', 'saturation', 0, 200, 100, 100, fix(0)),
      param('Temperatura', 'temperature', -100, 100, 0),
      param('Tinte', 'tint', -100, 100, 0),
      param('Desvanecido', 'fade', 0, 100, 0, 100, fix(0)),
      param('Tono °', 'hue', -180, 180, 0, 1),
      h('div', { class: 'btn-row' }, button('Restablecer color', () => A.applyColorPreset([clip], 'none'), { small: true, icon: 'reset' })),
    ];
    const sec = this.sec('color', 'Color', 'palette', body, { badge: '●' });
    const badge = sec.querySelector('.sec-badge');
    this.add({ el: sec, sync: () => { badge.style.display = clip.color ? '' : 'none'; } });
    this.el.append(sec);
  }

  // ----------------------------------------------------------------- efectos ----

  buildEffects(clip) {
    const body = [];
    for (const e of clip.effects || []) {
      const def = effectById(e.type);
      if (!def) continue;
      body.push(
        h(
          'div',
          { class: `fx-item${e.enabled ? '' : ' off'}` },
          h(
            'div',
            { class: 'fx-head' },
            h('span', { class: 'item-ico', html: icon('sparkles', 13) }),
            h('span', { class: 'item-name' }, def.name),
            h('button', { class: 'icon-btn tiny', title: e.enabled ? 'Desactivar' : 'Activar', html: icon(e.enabled ? 'eye' : 'eyeOff', 13), onclick: () => mutate('Efecto', () => { e.enabled = !e.enabled; }) }),
            h('button', { class: 'icon-btn tiny', title: 'Quitar efecto', html: icon('trash', 13), onclick: () => A.removeEffect(clip, e.id) })
          ),
          def.amount !== null
            ? this.add(sliderRow({ label: 'Cantidad', min: 0, max: 100, step: 1, def: def.amount, get: () => evalProp(e, 'amount', A.clipTs(clip)), set: (v) => A.setEffectAmount(clip, e, v), format: fix(0), kf: this.kf(e, 'amount', clip) }))
            : null
        )
      );
    }
    const addBtn = button('Añadir efecto', (ev) => {
      const r = ev.currentTarget.getBoundingClientRect();
      contextMenu(r.left, r.bottom + 4, VIDEO_EFFECTS.map((d) => ({ label: d.name, icon: 'sparkles', run: () => A.addEffect(clip, d.id) })));
    }, { icon: 'plus', block: true, small: true });
    body.push(addBtn);
    this.el.append(this.sec('effects', 'Efectos de video', 'sparkles', body, { badge: clip.effects && clip.effects.length ? String(clip.effects.length) : null }));
  }

  // ------------------------------------------------------------------- audio ----

  buildAudio(clip, p) {
    if (clip.audioDetached) {
      this.el.append(this.sec('audio', 'Audio', 'volume', [h('p', { class: 'insp-note' }, 'El audio de este clip está separado en su propio clip de audio.'), button('Volver a unir el audio', () => A.setClipField(clip, 'audioDetached', false), { small: true })]));
      return;
    }
    const maxFade = () => Math.max(0.1, clip.duration);
    const body = [
      this.add(sliderRow({ label: 'Volumen %', min: 0, max: 200, step: 1, def: 100, hardMax: 400, get: () => evalProp(clip, 'volume', A.clipTs(clip)) * 100, set: (v) => A.setClipProp(clip, 'volume', v / 100, 'Volumen'), format: fix(0), kf: this.kf(clip, 'volume', clip, 'linear') })),
      this.add(toggleRow({ label: 'Silenciar clip', get: () => clip.muted, set: (v) => A.setClipField(clip, 'muted', v) })),
      this.add(sliderRow({ label: 'Entrada s', hint: 'Fundido de entrada', min: 0, max: 5, step: 0.05, def: 0, get: () => clip.audioFadeIn, set: (v) => A.setClipField(clip, 'audioFadeIn', Math.min(v, maxFade())), format: fix(2) })),
      this.add(sliderRow({ label: 'Salida s', hint: 'Fundido de salida', min: 0, max: 5, step: 0.05, def: 0, get: () => clip.audioFadeOut, set: (v) => A.setClipField(clip, 'audioFadeOut', Math.min(v, maxFade())), format: fix(2) })),
      this.add(selectRow({ label: 'Efecto', options: [{ id: '', name: 'Ninguno' }, ...AUDIO_EFFECTS], get: () => clip.audioFx || '', set: (v) => A.setAudioFx(clip, v || null) })),
    ];
    this.el.append(this.sec('audio', 'Audio', 'volume', body));
  }

  // ------------------------------------------------------------ transiciones ----

  buildTransitions(clip, p) {
    const body = [];
    const none = { id: '', name: 'Ninguna' };
    if (M.isVisual(clip)) {
      const side = (label, key, sideId) => {
        body.push(
          this.add(
            selectRow({
              label,
              options: [none, ...TRANSITIONS],
              get: () => (clip[key] ? clip[key].type : ''),
              set: (v) => {
                if (!v) A.removeTransition(clip, sideId);
                else mutate('Transición', () => { clip[key] = { type: v, duration: clip[key] ? clip[key].duration : DEFAULT_TRANSITION_DURATION }; });
              },
            })
          )
        );
        if (clip[key]) {
          body.push(this.add(sliderRow({ label: 'Duración s', min: 0.1, max: 4, step: 0.05, def: 1, hardMax: 20, get: () => (clip[key] ? clip[key].duration : 1), set: (v) => A.setTransitionDuration(clip, sideId, v), format: fix(2) })));
        }
      };
      side('Entrada', 'transIn', 'in');
      side('Salida', 'transOut', 'out');
    }
    if (M.clipHasAudio(p, clip)) {
      body.push(
        this.add(
          selectRow({
            label: 'Audio (entrada)',
            options: [{ id: '', name: 'Corte directo' }, ...AUDIO_TRANSITIONS],
            get: () => (clip.audioTransIn ? clip.audioTransIn.type : ''),
            set: (v) => mutate('Transición de audio', () => { clip.audioTransIn = v ? { type: v, duration: clip.audioTransIn ? clip.audioTransIn.duration : DEFAULT_TRANSITION_DURATION } : null; }),
          })
        )
      );
      if (clip.audioTransIn) {
        body.push(this.add(sliderRow({ label: 'Duración s', min: 0.1, max: 4, step: 0.05, def: 1, hardMax: 20, get: () => (clip.audioTransIn ? clip.audioTransIn.duration : 1), set: (v) => mutate('Transición de audio', () => { if (clip.audioTransIn) clip.audioTransIn.duration = v; }, { coalesce: `${clip.id}:atr` }), format: fix(2) })));
      }
    }
    body.push(h('p', { class: 'insp-note' }, 'Si hay un clip pegado antes, la transición de entrada se centra en el corte entre ambos.'));
    this.el.append(this.sec('transitions', 'Transiciones', 'transition', body, { badge: clip.transIn || clip.transOut || clip.audioTransIn ? '●' : null }));
  }

  // ------------------------------------------------------------------- texto ----

  buildText(clip) {
    const t = clip.text;
    const set = (key) => (v) => A.setTextProp(clip, key, v);
    if (!fontList) loadFonts().then(() => this.refresh());
    const fonts = fontList || FALLBACK_FONTS;
    const fontOptions = (fonts.includes(t.font) ? fonts : [t.font, ...fonts]).map((f) => ({ id: f, name: f }));
    const k = state.project.settings.height / 1080;

    this.el.append(
      this.sec('text', 'Texto', 'type', [
        this.add(textAreaRow({ get: () => clip.text.content, set: set('content'), placeholder: 'Escribe aquí…' })),
        this.add(selectRow({ label: 'Fuente', options: fontOptions, get: () => clip.text.font, set: set('font') })),
        this.add(sliderRow({ label: 'Tamaño', min: 12 * k, max: 400 * k, step: 1, def: 90 * k, hardMin: 4, hardMax: 2000, get: () => clip.text.size, set: set('size'), format: fix(0) })),
        this.add(selectRow({ label: 'Grosor', options: [{ id: '300', name: 'Fina' }, { id: '400', name: 'Normal' }, { id: '600', name: 'Seminegrita' }, { id: '700', name: 'Negrita' }, { id: '800', name: 'Extra negrita' }], get: () => String(clip.text.weight), set: (v) => set('weight')(Number(v)) })),
        this.add(colorRow({ label: 'Color', get: () => clip.text.color, set: set('color') })),
        this.add(segmented({ label: 'Alineación', options: [{ id: 'left', name: 'Izq.' }, { id: 'center', name: 'Centro' }, { id: 'right', name: 'Der.' }], get: () => clip.text.align, set: set('align') })),
        this.add(toggleRow({ label: 'Cursiva', get: () => clip.text.italic, set: set('italic') })),
        this.add(toggleRow({ label: 'Mayúsculas', get: () => clip.text.uppercase, set: set('uppercase') })),
        this.add(sliderRow({ label: 'Aparecer s', hint: 'Fundido al entrar', min: 0, max: 3, step: 0.05, def: 0.25, get: () => clip.fadeIn, set: (v) => A.setClipField(clip, 'fadeIn', Math.min(v, clip.duration)), format: fix(2) })),
        this.add(sliderRow({ label: 'Desaparecer s', hint: 'Fundido al salir', min: 0, max: 3, step: 0.05, def: 0.25, get: () => clip.fadeOut, set: (v) => A.setClipField(clip, 'fadeOut', Math.min(v, clip.duration)), format: fix(2) })),
      ]),
      this.sec('textstyle', 'Estilo del texto', 'sparkles', [
        this.add(sliderRow({ label: 'Interlineado', min: 0.8, max: 2.5, step: 0.01, def: 1.15, get: () => clip.text.lineHeight, set: set('lineHeight'), format: fix(2) })),
        this.add(sliderRow({ label: 'Espaciado', min: -5 * k, max: 40 * k, step: 0.5, def: 0, get: () => clip.text.spacing, set: set('spacing'), format: fix(1) })),
        h('div', { class: 'sub-head' }, 'Borde'),
        this.add(sliderRow({ label: 'Grosor', min: 0, max: 40 * k, step: 0.5, def: 0, get: () => clip.text.strokeWidth, set: set('strokeWidth'), format: fix(1) })),
        this.add(colorRow({ label: 'Color', get: () => clip.text.strokeColor, set: set('strokeColor') })),
        h('div', { class: 'sub-head' }, 'Sombra'),
        this.add(toggleRow({ label: 'Sombra', get: () => clip.text.shadow, set: set('shadow') })),
        t.shadow ? this.add(colorRow({ label: 'Color', get: () => clip.text.shadowColor, set: set('shadowColor') })) : null,
        t.shadow ? this.add(sliderRow({ label: 'Difusión', min: 0, max: 80 * k, step: 1, def: 12 * k, get: () => clip.text.shadowBlur, set: set('shadowBlur'), format: fix(0) })) : null,
        t.shadow ? this.add(sliderRow({ label: 'Opacidad %', min: 0, max: 100, step: 1, def: 60, get: () => clip.text.shadowOpacity * 100, set: (v) => set('shadowOpacity')(v / 100), format: fix(0) })) : null,
        t.shadow ? this.add(sliderRow({ label: 'Distancia', min: -40 * k, max: 40 * k, step: 1, def: 4 * k, get: () => clip.text.shadowY, set: set('shadowY'), format: fix(0) })) : null,
        h('div', { class: 'sub-head' }, 'Fondo'),
        this.add(toggleRow({ label: 'Caja de fondo', get: () => clip.text.bg, set: set('bg') })),
        t.bg ? this.add(colorRow({ label: 'Color', get: () => clip.text.bgColor, set: set('bgColor') })) : null,
        t.bg ? this.add(sliderRow({ label: 'Opacidad %', min: 0, max: 100, step: 1, def: 60, get: () => clip.text.bgOpacity * 100, set: (v) => set('bgOpacity')(v / 100), format: fix(0) })) : null,
        t.bg ? this.add(sliderRow({ label: 'Relleno', min: 0, max: 120 * k, step: 1, def: 24 * k, get: () => clip.text.bgPadding, set: set('bgPadding'), format: fix(0) })) : null,
        t.bg ? this.add(sliderRow({ label: 'Redondeo', min: 0, max: 120 * k, step: 1, def: 12 * k, hardMax: 999, get: () => Math.min(clip.text.bgRadius, 120 * k), set: set('bgRadius'), format: fix(0) })) : null,
      ])
    );
  }
}

/** Pliega o despliega una sección del inspector (se usa al cambiar de área de trabajo). */
export function setSectionCollapsed(key, value) {
  collapsed.set(key, value);
}
