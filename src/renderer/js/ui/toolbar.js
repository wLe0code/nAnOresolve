// Barra de herramientas de la línea temporal.

import { state, on, setUI, select } from '../core/store.js';
import * as A from '../core/actions.js';
import { h } from '../core/util.js';
import { icon } from './icons.js';
import { toast } from './widgets.js';
import { targetMediaClip } from './panels.js';

const MIN_PPS = 1.5;
const MAX_PPS = 640;

export function buildToolbar(timeline, recorder) {
  const bar = document.getElementById('tl-toolbar');
  const corner = document.getElementById('tl-corner');

  const tool = (ico, title, onclick, opts = {}) =>
    h('button', { class: `tool-btn${opts.label ? ' labeled' : ''}${opts.cls ? ` ${opts.cls}` : ''}`, title, onclick }, h('span', { class: 'tool-ico', html: icon(ico, 16) }), opts.label ? h('span', { class: 'tool-label' }, opts.label) : null);
  const sep = () => h('span', { class: 'tool-sep' });

  // Las herramientas creativas necesitan el inspector: si está oculto (área de Cortes) se abre Edición.
  const ensureInspector = () => {
    if (state.workspace === 'cut') setUI({ workspace: 'edit' });
  };

  const selectBtn = tool('cursor', 'Selección (A)', () => setUI({ tool: 'select' }));
  const bladeBtn = tool('scissors', 'Cuchilla (B): haz clic en un clip para cortarlo. Con Mayús corta todas las pistas.', () => setUI({ tool: 'blade' }));
  const snapBtn = tool('magnet', 'Imán (N): la cuchilla y los clips se pegan al cursor y a los cortes cercanos', () => setUI({ snapping: !state.snapping }));
  const rippleBtn = tool('ripple', 'Cerrar huecos: al borrar o recortar en la pista principal, lo que sigue se recorre', () => setUI({ ripple: !state.ripple }));
  const splitBtn = tool('split', 'Cortar en el cursor (Ctrl+B)', () => A.splitAtPlayhead());
  const delBtn = tool('trash', 'Eliminar la selección (Supr)', () => A.deleteSelection());

  const micBtn = tool('mic', 'Grabar tu voz con el micrófono desde la posición del cursor', () => recorder.toggle(), { label: 'Voz', cls: 'feature mic' });
  const zoomBtn = tool(
    'zoomIn',
    'Añadir un zoom en el cursor: marca inicio, final y cuánto acercar',
    () => {
      const clip = targetMediaClip();
      if (!clip) return toast('Coloca el cursor sobre un video o una imagen para añadirle un zoom');
      select(clip.id);
      A.addZoom(clip);
      ensureInspector();
      return undefined;
    },
    { label: 'Zoom', cls: 'feature' }
  );
  const censorBtn = tool(
    'censor',
    'Censurar: dibuja sobre una placa, un rostro o un documento para pixelarlo o difuminarlo',
    () => {
      if (state.viewerMode === 'censor') return setUI({ viewerMode: null });
      const clip = targetMediaClip();
      if (!clip) return toast('Coloca el cursor sobre un video o una imagen para censurar');
      select(clip.id);
      ensureInspector();
      return setUI({ viewerMode: 'censor', activeZoom: null });
    },
    { label: 'Censurar', cls: 'feature' }
  );
  const textBtn = tool(
    'type',
    'Añadir un texto en el cursor',
    () => {
      A.addText('title');
      ensureInspector();
    },
    { label: 'Texto', cls: 'feature' }
  );

  const toSlider = (pps) => (Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000;
  const fromSlider = (v) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 1000);
  const zoomSlider = h('input', { type: 'range', class: 'slider tl-zoom', min: 0, max: 1000, step: 1, title: 'Zoom de la línea temporal (Ctrl + rueda)' });
  zoomSlider.addEventListener('input', () => timeline.setZoom(fromSlider(Number(zoomSlider.value)), timeline.xOf(state.playhead) > 0 && timeline.xOf(state.playhead) < timeline.w ? timeline.xOf(state.playhead) : timeline.w / 2));

  bar.append(
    h('div', { class: 'tool-group' }, selectBtn, bladeBtn),
    sep(),
    h('div', { class: 'tool-group' }, snapBtn, rippleBtn),
    sep(),
    h('div', { class: 'tool-group' }, splitBtn, delBtn),
    sep(),
    h('div', { class: 'tool-group features' }, micBtn, zoomBtn, censorBtn, textBtn),
    h('div', { class: 'tool-spacer' }),
    h(
      'div',
      { class: 'tool-group' },
      tool('minus', 'Alejar la línea temporal (-)', () => timeline.setZoom(state.pxPerSec / 1.35)),
      zoomSlider,
      tool('plus', 'Acercar la línea temporal (+)', () => timeline.setZoom(state.pxPerSec * 1.35)),
      tool('fit', 'Ver toda la línea temporal (Mayús+Z)', () => timeline.fit())
    )
  );

  corner.append(
    h('button', { class: 'corner-btn', title: 'Añadir pista de video', onclick: () => A.addTrack('video') }, h('span', { html: icon('plus', 11) }), 'Video'),
    h('button', { class: 'corner-btn', title: 'Añadir pista de audio', onclick: () => A.addTrack('audio') }, h('span', { html: icon('plus', 11) }), 'Audio')
  );

  const sync = () => {
    selectBtn.classList.toggle('on', state.tool === 'select');
    bladeBtn.classList.toggle('on', state.tool === 'blade');
    snapBtn.classList.toggle('on', state.snapping);
    rippleBtn.classList.toggle('on', state.ripple);
    censorBtn.classList.toggle('on', state.viewerMode === 'censor');
    micBtn.classList.toggle('on', state.viewerMode === 'record');
    delBtn.disabled = state.selection.length === 0;
    if (document.activeElement !== zoomSlider) zoomSlider.value = toSlider(state.pxPerSec);
    const pct = (toSlider(state.pxPerSec) / 1000) * 100;
    zoomSlider.style.setProperty('--fill', `${pct}%`);
  };
  on('ui', sync);
  on('selection', sync);
  sync();
}
