// Diálogo «Configuración del video»: resolución, fotogramas por segundo y color de fondo del proyecto.

import { state } from '../core/store.js';
import * as A from '../core/actions.js';
import { h } from '../core/util.js';
import { FRAME_RATES } from '../core/presets.js';
import { modal, toast } from './widgets.js';
import { icon } from './icons.js';

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const MIN_SIDE = 16;
const MAX_SIDE = 7680;

// Formatos y tamaños habituales. El primero de cada lista con `rec` es el recomendado.
export const FORMATS = [
  {
    id: 'h169',
    name: 'Horizontal',
    hint: '16:9 · YouTube, televisión',
    ratio: 16 / 9,
    sizes: [
      { w: 3840, h: 2160, name: '4K' },
      { w: 2560, h: 1440, name: '2K' },
      { w: 1920, h: 1080, name: 'Full HD', rec: true },
      { w: 1280, h: 720, name: 'HD' },
      { w: 854, h: 480, name: '480p' },
    ],
  },
  {
    id: 'v916',
    name: 'Vertical',
    hint: '9:16 · TikTok, Reels, Shorts',
    ratio: 9 / 16,
    sizes: [
      { w: 2160, h: 3840, name: '4K' },
      { w: 1440, h: 2560, name: '2K' },
      { w: 1080, h: 1920, name: 'Full HD', rec: true },
      { w: 720, h: 1280, name: 'HD' },
    ],
  },
  {
    id: 's11',
    name: 'Cuadrado',
    hint: '1:1 · publicaciones',
    ratio: 1,
    sizes: [
      { w: 2160, h: 2160, name: '4K' },
      { w: 1440, h: 1440, name: '2K' },
      { w: 1080, h: 1080, name: 'Full HD', rec: true },
      { w: 720, h: 720, name: 'HD' },
    ],
  },
  {
    id: 'p45',
    name: 'Retrato',
    hint: '4:5 · Instagram',
    ratio: 4 / 5,
    sizes: [
      { w: 2160, h: 2700, name: '4K' },
      { w: 1440, h: 1800, name: '2K' },
      { w: 1080, h: 1350, name: 'Full HD', rec: true },
      { w: 720, h: 900, name: 'HD' },
    ],
  },
  { id: 'custom', name: 'Personalizado', hint: 'Elige ancho y alto', ratio: null, sizes: [] },
];

const fpsLabel = (f) => (Number.isInteger(f) ? String(f) : String(Math.round(f * 1000) / 1000));
const FPS_HINT = { 23.976: 'cine (NTSC)', 24: 'cine', 25: 'PAL / Europa', 29.97: 'TV (NTSC)', 30: 'redes y web', 50: 'movimiento fluido (PAL)', 59.94: 'movimiento fluido (NTSC)', 60: 'movimiento fluido, juegos' };

/** Formato al que pertenece un tamaño (o 'custom'). */
function formatOf(w, hh) {
  for (const f of FORMATS) if (f.sizes.some((s) => s.w === w && s.h === hh)) return f.id;
  return 'custom';
}

/** Rectángulo que dibuja la proporción elegida dentro de una caja de 64×64. */
function aspectBox(w, hh) {
  const k = 52 / Math.max(w, hh);
  return { width: `${Math.max(6, Math.round(w * k))}px`, height: `${Math.max(6, Math.round(hh * k))}px` };
}

export function openVideoSettings() {
  const p = state.project;
  const s = p.settings;
  const cur = { w: s.width, h: s.height, fps: s.fps, bg: s.background || '#000000' };
  let fmt = formatOf(cur.w, cur.h);
  let otherFps = !FRAME_RATES.includes(cur.fps);

  // ---- formato ----
  const fmtButtons = FORMATS.map((f) =>
    h(
      'button',
      { class: 'vs-format', onclick: () => pickFormat(f.id) },
      h('span', { class: 'vs-shape-box' }, h('span', { class: 'vs-shape', style: f.ratio ? aspectBox(f.ratio * 100, 100) : { width: '22px', height: '22px', borderStyle: 'dashed' } })),
      h('b', {}, f.name),
      h('small', {}, f.hint)
    )
  );

  // ---- tamaño ----
  const sizeSelect = h('select', { class: 'select', onchange: () => { const [w, hh] = sizeSelect.value.split('x').map(Number); cur.w = w; cur.h = hh; sync(); } });
  const wIn = h('input', { type: 'number', class: 'num vs-num', min: MIN_SIDE, max: MAX_SIDE, step: 2 });
  const hIn = h('input', { type: 'number', class: 'num vs-num', min: MIN_SIDE, max: MAX_SIDE, step: 2 });
  const readCustom = () => {
    const w = Number(wIn.value);
    const hh = Number(hIn.value);
    if (w >= MIN_SIDE && hh >= MIN_SIDE) {
      cur.w = even(Math.min(MAX_SIDE, w));
      cur.h = even(Math.min(MAX_SIDE, hh));
    }
    sync(true);
  };
  for (const el of [wIn, hIn]) {
    el.addEventListener('input', readCustom);
    el.addEventListener('change', () => { readCustom(); sync(); });
  }
  const customRow = h('div', { class: 'vs-custom' }, wIn, h('span', { class: 'vs-x' }, '×'), hIn, h('span', { class: 'form-hint' }, 'píxeles'));

  // ---- copiar de un video ----
  const videos = p.media.filter((m) => m.type === 'video' && m.width && m.height);
  const copySelect = videos.length
    ? h(
        'select',
        {
          class: 'select',
          onchange: () => {
            const m = videos.find((x) => x.id === copySelect.value);
            copySelect.value = '';
            if (!m) return;
            cur.w = even(m.width);
            cur.h = even(m.height);
            const raw = m.fps || cur.fps;
            cur.fps = FRAME_RATES.find((r) => Math.abs(r - raw) < 0.02) || Math.round(raw * 1000) / 1000;
            otherFps = !FRAME_RATES.includes(cur.fps);
            fmt = formatOf(cur.w, cur.h);
            sync();
          },
        },
        h('option', { value: '' }, 'Elige un video…'),
        videos.map((m) => h('option', { value: m.id }, `${m.name} · ${m.width}×${m.height} · ${fpsLabel(Math.round((m.fps || 0) * 1000) / 1000)} fps`))
      )
    : null;

  // ---- fotogramas ----
  const fpsSelect = h(
    'select',
    {
      class: 'select',
      onchange: () => {
        otherFps = fpsSelect.value === 'other';
        if (!otherFps) cur.fps = Number(fpsSelect.value);
        sync();
        if (otherFps) fpsIn.focus();
      },
    },
    FRAME_RATES.map((r) => h('option', { value: String(r) }, `${fpsLabel(r)} fps · ${FPS_HINT[r]}`)),
    h('option', { value: 'other' }, 'Otro…')
  );
  const fpsIn = h('input', { type: 'number', class: 'num vs-num', min: 1, max: 120, step: 0.001 });
  fpsIn.addEventListener('change', () => {
    const v = Number(fpsIn.value);
    if (v >= 1 && v <= 120) cur.fps = Math.round(v * 1000) / 1000;
    sync();
  });
  const fpsOther = h('div', { class: 'vs-custom' }, fpsIn, h('span', { class: 'form-hint' }, 'fotogramas por segundo (1 a 120)'));
  const fpsHint = h('div', { class: 'form-hint' });

  // ---- fondo ----
  const bgIn = h('input', { type: 'color', class: 'color', oninput: () => { cur.bg = bgIn.value; } });

  // ---- resumen ----
  const preview = h('span', { class: 'vs-preview-shape' });
  const previewLabel = h('div', { class: 'vs-preview-label' });
  const changes = h('div', { class: 'vs-changes' });

  const row = (label, ...control) => h('div', { class: 'form-row' }, h('label', {}, label), h('div', { class: 'form-control' }, ...control));

  function pickFormat(id) {
    fmt = id;
    const f = FORMATS.find((x) => x.id === id);
    if (f.sizes.length && !f.sizes.some((z) => z.w === cur.w && z.h === cur.h)) {
      // Mantiene la calidad: elige el tamaño de ese formato con el lado menor más parecido.
      const short = Math.min(cur.w, cur.h);
      let best = f.sizes.find((z) => z.rec);
      for (const z of f.sizes) if (Math.abs(Math.min(z.w, z.h) - short) < Math.abs(Math.min(best.w, best.h) - short)) best = z;
      cur.w = best.w;
      cur.h = best.h;
    }
    sync();
  }

  function sync(typing = false) {
    fmtButtons.forEach((b, i) => b.classList.toggle('on', FORMATS[i].id === fmt));
    const f = FORMATS.find((x) => x.id === fmt);
    sizeSelect.style.display = f.sizes.length ? '' : 'none';
    customRow.style.display = f.sizes.length ? 'none' : '';
    if (f.sizes.length) {
      sizeSelect.replaceChildren(...f.sizes.map((z) => h('option', { value: `${z.w}x${z.h}` }, `${z.name} · ${z.w}×${z.h}${z.rec ? ' (recomendado)' : ''}`)));
      sizeSelect.value = `${cur.w}x${cur.h}`;
    }
    if (!typing) {
      wIn.value = cur.w;
      hIn.value = cur.h;
    }
    fpsSelect.value = otherFps ? 'other' : String(cur.fps);
    fpsOther.style.display = otherFps ? '' : 'none';
    if (document.activeElement !== fpsIn) fpsIn.value = cur.fps;
    fpsHint.textContent = cur.fps >= 48 ? 'El doble de fotogramas: movimiento más fluido y archivos más grandes.' : '';
    bgIn.value = cur.bg;

    Object.assign(preview.style, aspectBox(cur.w, cur.h));
    const g = (a, b) => (b ? g(b, a % b) : a);
    const d = g(cur.w, cur.h);
    const ratio = `${cur.w / d}:${cur.h / d}`;
    previewLabel.replaceChildren(h('b', {}, `${cur.w}×${cur.h}`), h('span', {}, `${ratio.length <= 7 ? ratio : (cur.w / cur.h).toFixed(2)} · ${fpsLabel(cur.fps)} fps`));

    const notes = [];
    const resized = cur.w !== s.width || cur.h !== s.height;
    if (resized) notes.push(p.clips.length ? 'Los clips se adaptan solos: videos e imágenes se encajan en el nuevo cuadro y textos y posiciones se reescalan.' : 'Cambia el tamaño del cuadro de la vista previa y de la exportación.');
    // Si la forma del cuadro cambia, ofrece ampliar los videos para que no queden franjas negras.
    const shapeChanged = Math.abs(cur.w / cur.h - s.width / s.height) > 0.01;
    fillRow.style.display = resized && shapeChanged && hasVideo ? '' : 'none';
    if (cur.fps !== s.fps && p.clips.length) notes.push('Los cortes se ajustarán al fotograma más cercano.');
    changes.replaceChildren(...notes.map((n) => h('p', {}, n)));
  }

  const sizeRow = row('Tamaño', sizeSelect, customRow);
  const hasVideo = p.clips.some((c) => c.type === 'video');
  const fillBox = h('input', { type: 'checkbox', checked: true });
  const fillRow = h(
    'label',
    { class: 'vs-fill' },
    fillBox,
    h('span', {}, h('b', {}, 'Ampliar los videos para llenar el cuadro'), h('small', {}, 'Así no quedan franjas negras; se recortan los bordes que sobran. Solo afecta a los videos que no has escalado.'))
  );
  const body = h(
    'div',
    { class: 'vs' },
    h('div', { class: 'vs-formats' }, fmtButtons),
    h(
      'div',
      { class: 'vs-grid' },
      h(
        'div',
        { class: 'vs-fields' },
        sizeRow,
        copySelect ? row('Copiar de', copySelect) : null,
        row('Fotogramas', fpsSelect, fpsOther, fpsHint),
        row('Fondo', h('span', { class: 'color-wrap' }, bgIn, h('span', { class: 'form-hint' }, 'se ve donde no hay imagen')))
      ),
      h('div', { class: 'vs-preview' }, h('div', { class: 'vs-preview-box' }, preview), previewLabel)
    ),
    fillRow,
    changes,
    h('p', { class: 'form-note' }, 'Al exportar puedes sacar el video a otra resolución sin cambiar esto.')
  );
  sync();

  modal({
    title: 'Configuración del video',
    width: 620,
    body,
    buttons: [
      { label: 'Cancelar', run: (m) => m.close() },
      {
        label: 'Aplicar',
        primary: true,
        run: (m) => {
          readFpsField();
          const patch = {};
          if (cur.w !== s.width || cur.h !== s.height) Object.assign(patch, { width: cur.w, height: cur.h });
          if (cur.fps !== s.fps) patch.fps = cur.fps;
          if (cur.bg.toLowerCase() !== String(s.background).toLowerCase()) patch.background = cur.bg;
          m.close();
          if (!Object.keys(patch).length) return;
          A.setProjectSettings(patch, { fill: fillRow.style.display !== 'none' && fillBox.checked });
          toast(`Video configurado: ${cur.w}×${cur.h} · ${fpsLabel(cur.fps)} fps`, 'ok');
        },
      },
    ],
  });

  function readFpsField() {
    if (!otherFps) return;
    const v = Number(fpsIn.value);
    if (v >= 1 && v <= 120) cur.fps = Math.round(v * 1000) / 1000;
  }
}

/** Botón de la barra superior que muestra la configuración actual y abre el diálogo. */
export function settingsChip() {
  const label = h('span', {});
  const el = h('button', { class: 'vs-chip', title: 'Configuración del video: resolución y fotogramas por segundo', onclick: () => openVideoSettings() }, h('span', { html: icon('film', 13) }), label);
  const sync = () => {
    const s = state.project.settings;
    label.textContent = `${s.width}×${s.height} · ${fpsLabel(s.fps)} fps`;
  };
  sync();
  return { el, sync };
}
