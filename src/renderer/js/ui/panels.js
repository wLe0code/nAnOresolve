// Panel izquierdo: medios del proyecto y bibliotecas de transiciones, efectos, textos y color.

import { state, on, setUI, primaryClip, selectedClips } from '../core/store.js';
import * as M from '../core/model.js';
import * as A from '../core/actions.js';
import { h, clear, formatDur, debounce } from '../core/util.js';
import { rt, importPaths, retryMedia } from '../media/library.js';
import { COLOR_PRESETS, colorFromPreset, TRANSITIONS, AUDIO_TRANSITIONS, VIDEO_EFFECTS, AUDIO_EFFECTS, TEXT_PRESETS, TEXT_DEFAULT } from '../core/presets.js';
import { Compositor } from '../render/compositor.js';
import { renderText } from '../render/textrender.js';
import { buildScene, sceneLayers } from '../render/scene.js';
import { engine } from '../playback/engine.js';
import { icon } from './icons.js';
import { toast, contextMenu, confirmDialog } from './widgets.js';
import { setDrag } from './dnd.js';
import { applyPayload } from './timeline.js';

const TABS = [
  { id: 'media', name: 'Medios', icon: 'film' },
  { id: 'transitions', name: 'Transiciones', icon: 'transition' },
  { id: 'effects', name: 'Efectos', icon: 'sparkles' },
  { id: 'text', name: 'Texto', icon: 'type' },
  { id: 'color', name: 'Color', icon: 'palette' },
];

export async function importDialog() {
  const paths = await window.nano.openMediaDialog();
  if (!paths || !paths.length) return [];
  return importPaths(paths, (name, err) => toast(`No se pudo importar ${name}: ${err}`, 'error'));
}

/** Clip de video o imagen sobre el que actúan las herramientas: el seleccionado o el que está bajo el cursor. */
export function targetMediaClip() {
  const p = state.project;
  const sel = primaryClip();
  if (sel && (sel.type === 'video' || sel.type === 'image')) return sel;
  const layers = sceneLayers(buildScene(p, state.playhead)).filter((l) => l.kind === 'video' || l.kind === 'image');
  return layers.length ? layers[layers.length - 1].clip : null;
}

export class LeftPanel {
  constructor() {
    this.tabsEl = document.getElementById('left-tabs');
    this.body = document.getElementById('left-body');
    this.cards = new Map();
    if (!state.leftTab) state.leftTab = 'media';
    this.buildTabs();
    this.render();

    on('ui', (keys) => {
      if (keys.includes('leftTab')) {
        this.syncTabs();
        this.render();
      }
    });
    on('project', (info) => {
      if (state.leftTab === 'media' && (!info || info.label !== 'touch')) this.renderMediaIfChanged();
      if (state.leftTab === 'color') this.refreshColor();
    });
    on('media', (id) => {
      if (state.leftTab === 'media') this.updateCard(id);
      if (state.leftTab === 'color') this.refreshColor();
    });
    on('selection', () => {
      if (state.leftTab === 'color') this.refreshColor();
    });
    on('playhead', () => {
      if (state.leftTab === 'color' && !state.playing) this.refreshColor();
    });
    this.refreshColor = debounce(() => this.paintColorThumbs(), 180);
  }

  buildTabs() {
    this.tabButtons = TABS.map((t) =>
      h('button', { class: 'tab', title: t.name, onclick: () => setUI({ leftTab: t.id }) }, h('span', { html: icon(t.icon, 15) }), h('span', { class: 'tab-label' }, t.name))
    );
    this.tabsEl.append(...this.tabButtons);
    this.syncTabs();
  }

  syncTabs() {
    this.tabButtons.forEach((b, i) => b.classList.toggle('on', TABS[i].id === state.leftTab));
  }

  render() {
    clear(this.body);
    this.cards.clear();
    this.mediaSig = null;
    this.body.className = `tab-${state.leftTab}`;
    switch (state.leftTab) {
      case 'transitions':
        this.renderTransitions();
        break;
      case 'effects':
        this.renderEffects();
        break;
      case 'text':
        this.renderText();
        break;
      case 'color':
        this.renderColor();
        break;
      default:
        this.renderMedia();
        break;
    }
  }

  // ------------------------------------------------------------------ medios ----

  renderMediaIfChanged() {
    const sig = state.project.media.map((m) => m.id).join(',');
    if (sig !== this.mediaSig) this.render();
  }

  renderMedia() {
    const p = state.project;
    this.mediaSig = p.media.map((m) => m.id).join(',');
    const importBtn = h('button', { class: 'btn primary', onclick: () => importDialog() }, h('span', { html: icon('import', 14) }), 'Importar');
    this.body.append(h('div', { class: 'panel-head' }, importBtn, h('span', { class: 'panel-count' }, p.media.length ? `${p.media.length} ${p.media.length === 1 ? 'elemento' : 'elementos'}` : '')));
    if (!p.media.length) {
      this.body.append(
        h(
          'div',
          { class: 'empty-state', onclick: () => importDialog() },
          h('div', { class: 'empty-ico', html: icon('film', 30) }),
          h('div', { class: 'empty-title' }, 'Importa tus videos'),
          h('div', { class: 'empty-text' }, 'Arrastra archivos aquí o pulsa Importar. Se admite prácticamente cualquier formato de video, audio e imagen.')
        )
      );
      return;
    }
    const grid = h('div', { class: 'media-grid' });
    for (const m of p.media) grid.append(this.makeCard(m));
    this.body.append(grid, h('div', { class: 'panel-hint' }, 'Doble clic o arrastra a la línea temporal para añadir.'));
  }

  makeCard(media) {
    const cv = h('canvas', { class: 'media-thumb', width: 224, height: 126 });
    const status = h('div', { class: 'media-status' });
    const badge = h('span', { class: 'media-badge' });
    const el = h(
      'div',
      {
        class: 'media-card',
        draggable: true,
        title: media.path,
        ondragstart: (e) => setDrag(e, { kind: 'media', id: media.id }),
        ondblclick: () => A.addMediaToTimeline(media),
        oncontextmenu: (e) => {
          e.preventDefault();
          const r = rt(media.id);
          contextMenu(e.clientX, e.clientY, [
            { label: 'Añadir a la línea temporal', icon: 'plus', run: () => A.addMediaToTimeline(media) },
            { label: 'Añadir en el cursor', icon: 'split', run: () => A.addMediaToTimeline(media, { start: state.playhead }) },
            { label: 'Mostrar en la carpeta', icon: 'folder', run: () => window.nano.showItem(media.path) },
            r.status === 'error' || r.status === 'offline' ? { label: 'Reintentar', icon: 'reset', run: () => retryMedia(media) } : null,
            '-',
            {
              label: 'Quitar del proyecto',
              icon: 'trash',
              danger: true,
              run: async () => {
                const used = state.project.clips.filter((c) => c.mediaId === media.id).length;
                if (used && !(await confirmDialog('Quitar medio', `"${media.name}" se usa en ${used} ${used === 1 ? 'clip' : 'clips'} de la línea temporal. Se quitarán también.`, 'Quitar', { danger: true }))) return;
                A.removeMedia(media.id);
              },
            },
          ]);
        },
      },
      h(
        'div',
        { class: 'media-thumb-wrap' },
        cv,
        status,
        h('span', { class: 'media-type', html: icon(media.type === 'video' ? 'film' : media.type === 'audio' ? 'music' : 'image', 12) }),
        media.type !== 'image' ? h('span', { class: 'media-dur' }, formatDur(media.duration)) : null,
        badge,
        h('button', { class: 'media-add', title: 'Añadir al final de la línea temporal', html: icon('plus', 15), onclick: (e) => { e.stopPropagation(); A.addMediaToTimeline(media); } })
      ),
      h('div', { class: 'media-name' }, media.name)
    );
    this.cards.set(media.id, { el, cv, status, badge, media });
    this.updateCard(media.id);
    return el;
  }

  updateCard(id) {
    const card = this.cards.get(id);
    if (!card) return;
    const { cv, status, badge, media, el } = card;
    const r = rt(id);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#12141a';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (r.poster) {
      const s = Math.max(cv.width / r.poster.width, cv.height / r.poster.height);
      const w = r.poster.width * s;
      const hh = r.poster.height * s;
      ctx.drawImage(r.poster, (cv.width - w) / 2, (cv.height - hh) / 2, w, hh);
    } else if (media.type === 'audio') {
      const g = ctx.createLinearGradient(0, 0, 0, cv.height);
      g.addColorStop(0, '#12392f');
      g.addColorStop(1, '#0f2420');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cv.width, cv.height);
      if (r.peaks) {
        const data = r.peaks[0];
        ctx.fillStyle = '#62dcb8';
        for (let x = 0; x < cv.width; x += 2) {
          const i0 = Math.floor((x / cv.width) * data.length);
          const i1 = Math.max(i0 + 1, Math.floor(((x + 2) / cv.width) * data.length));
          let v = 0;
          for (let i = i0; i < i1 && i < data.length; i += Math.max(1, Math.floor((i1 - i0) / 24))) v = Math.max(v, data[i]);
          const a = Math.max(1, Math.pow(v / 255, 0.75) * cv.height * 0.42);
          ctx.fillRect(x, cv.height / 2 - a, 1.4, a * 2);
        }
      }
    }
    el.classList.toggle('busy', r.status !== 'ready');
    el.classList.toggle('failed', r.status === 'error' || r.status === 'offline');
    badge.textContent = r.status === 'ready' && r.previewPath ? 'PROXY' : '';
    badge.title = 'Se usa una copia ligera para la vista previa. La exportación usa siempre el archivo original.';
    if (r.status === 'ready') status.textContent = '';
    else if (r.status === 'proxy') status.textContent = `Preparando vista previa… ${Math.round(r.progress * 100)}%`;
    else if (r.status === 'error') status.textContent = r.error || 'No se pudo cargar';
    else if (r.status === 'offline') status.textContent = 'Archivo no encontrado';
    else status.textContent = 'Analizando…';
  }

  // ------------------------------------------------------------ transiciones ----

  applyToSelection(payload) {
    const clip = primaryClip();
    if (!clip) {
      toast('Selecciona un clip o arrastra el elemento a la línea temporal');
      return;
    }
    const mid = clip.start + clip.duration / 2;
    applyPayload(payload, clip, state.playhead > mid ? 'out' : 'in');
  }

  tile(payload, name, visual, hint) {
    return h(
      'div',
      {
        class: 'lib-tile',
        draggable: true,
        title: hint || `${name} — arrastra a un clip o haz doble clic`,
        ondragstart: (e) => setDrag(e, payload),
        ondblclick: () => this.applyToSelection(payload),
      },
      visual,
      h('div', { class: 'lib-name' }, name)
    );
  }

  renderTransitions() {
    const video = h('div', { class: 'lib-grid' }, TRANSITIONS.map((t) => this.tile({ kind: 'transition', id: t.id }, t.name, h('div', { class: `tr-preview tr-${t.id}` }, h('span', { class: 'a' }, 'A'), h('span', { class: 'b' }, 'B')))));
    const audio = h('div', { class: 'lib-grid' }, AUDIO_TRANSITIONS.map((t) => this.tile({ kind: 'audio-transition', id: t.id }, t.name, h('div', { class: 'tr-preview audio', html: icon('wave', 26) }), t.hint)));
    this.body.append(
      h('div', { class: 'panel-hint top' }, 'Arrastra una transición al inicio o al final de un clip. Entre dos clips pegados se centra en el corte.'),
      h('h3', { class: 'lib-title' }, 'Video'),
      video,
      h('h3', { class: 'lib-title' }, 'Audio'),
      audio
    );
  }

  // ----------------------------------------------------------------- efectos ----

  renderEffects() {
    const row = (payload, name, hint, ico) =>
      h(
        'div',
        { class: 'lib-row', draggable: true, title: hint || 'Arrastra a un clip o haz doble clic', ondragstart: (e) => setDrag(e, payload), ondblclick: () => this.applyToSelection(payload) },
        h('span', { class: 'lib-row-ico', html: icon(ico, 15) }),
        h('span', { class: 'lib-row-name' }, name),
        hint ? h('span', { class: 'lib-row-hint' }, hint) : null,
        h('button', { class: 'icon-btn tiny', title: 'Aplicar al clip seleccionado', html: icon('plus', 14), onclick: () => this.applyToSelection(payload) })
      );
    this.body.append(
      h('div', { class: 'panel-hint top' }, 'Arrastra un efecto sobre un clip o selecciónalo y pulsa +. Los ajustes aparecen en el inspector.'),
      h('h3', { class: 'lib-title' }, 'Video'),
      h('div', { class: 'lib-list' }, VIDEO_EFFECTS.map((e) => row({ kind: 'effect', id: e.id }, e.name, '', 'sparkles'))),
      h('h3', { class: 'lib-title' }, 'Audio'),
      h('div', { class: 'lib-list' }, AUDIO_EFFECTS.map((e) => row({ kind: 'audio-effect', id: e.id }, e.name, e.hint, 'wave')))
    );
  }

  // ------------------------------------------------------------------- texto ----

  renderText() {
    const tiles = TEXT_PRESETS.map((preset) => {
      const cv = h('canvas', { class: 'text-preview', width: 224, height: 112 });
      const text = { ...TEXT_DEFAULT, ...preset.text, wrap: 0 };
      try {
        const { canvas } = renderText(text, 1920, 1);
        const ctx = cv.getContext('2d');
        const s = Math.min((cv.width - 20) / canvas.width, (cv.height - 16) / canvas.height);
        ctx.drawImage(canvas, (cv.width - canvas.width * s) / 2, (cv.height - canvas.height * s) / 2, canvas.width * s, canvas.height * s);
      } catch (e) {
        console.warn(e);
      }
      return h(
        'div',
        {
          class: 'lib-tile text-tile',
          draggable: true,
          title: `${preset.name} — doble clic para añadir en el cursor`,
          ondragstart: (e) => setDrag(e, { kind: 'text', id: preset.id }),
          ondblclick: () => A.addText(preset.id),
        },
        cv,
        h('div', { class: 'lib-name' }, preset.name)
      );
    });
    this.body.append(
      h('div', { class: 'panel-head' }, h('button', { class: 'btn primary', onclick: () => A.addText('title') }, h('span', { html: icon('plus', 14) }), 'Añadir texto')),
      h('div', { class: 'panel-hint top' }, 'Doble clic para añadir el estilo en el cursor, o arrástralo a una pista de video.'),
      h('div', { class: 'lib-grid two' }, tiles)
    );
  }

  // ------------------------------------------------------------------- color ----

  renderColor() {
    this.colorTiles = COLOR_PRESETS.map((preset) => {
      const cv = h('canvas', { class: 'color-thumb', width: 208, height: 117 });
      const el = h(
        'div',
        {
          class: 'lib-tile color-tile',
          draggable: true,
          title: preset.hint || preset.name,
          ondragstart: (e) => setDrag(e, { kind: 'color', id: preset.id }),
          onclick: () => this.applyColor(preset.id),
        },
        cv,
        h('div', { class: 'lib-name' }, preset.name)
      );
      return { preset, cv, el };
    });
    this.colorTarget = h('div', { class: 'panel-hint top' });
    this.body.append(this.colorTarget, h('div', { class: 'lib-grid two' }, this.colorTiles.map((t) => t.el)));
    this.paintColorThumbs();
  }

  applyColor(presetId) {
    let clips = selectedClips().filter((c) => c.type === 'video' || c.type === 'image');
    if (!clips.length) {
      const c = targetMediaClip();
      if (c) clips = [c];
    }
    if (!clips.length) {
      toast('Coloca el cursor sobre un video o selecciona un clip');
      return;
    }
    A.applyColorPreset(clips, presetId);
  }

  sampleImage() {
    if (!this.sample) {
      const c = new OffscreenCanvas(208, 117);
      const ctx = c.getContext('2d');
      const sky = ctx.createLinearGradient(0, 0, 0, 117);
      sky.addColorStop(0, '#3f78c9');
      sky.addColorStop(0.55, '#b9d3ee');
      sky.addColorStop(0.56, '#6f8f4a');
      sky.addColorStop(1, '#3c5a2c');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, 208, 117);
      ctx.fillStyle = '#f4e3b0';
      ctx.beginPath();
      ctx.arc(160, 28, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#d9a37f';
      ctx.beginPath();
      ctx.ellipse(70, 62, 20, 25, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(40, 86, 60, 31);
      ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'].forEach((col, i) => {
        ctx.fillStyle = col;
        ctx.fillRect(120 + i * 16, 92, 14, 18);
      });
      this.sample = c;
    }
    return this.sample;
  }

  async paintColorThumbs() {
    if (state.leftTab !== 'color' || !this.colorTiles) return;
    const p = state.project;
    const clip = targetMediaClip();
    let source = null;
    if (clip) {
      const media = M.mediaById(p, clip.mediaId);
      const slot = engine.slots.get(clip.id);
      try {
        if (clip.type === 'image' && media && rt(media.id).bitmap) source = rt(media.id).bitmap;
        else if (slot && slot.el.readyState >= 2 && slot.el.videoWidth) {
          source = await createImageBitmap(slot.el, { resizeWidth: 320, resizeHeight: Math.max(2, Math.round((320 * slot.el.videoHeight) / slot.el.videoWidth)), resizeQuality: 'medium' });
        }
      } catch {
        source = null;
      }
    }
    if (state.leftTab !== 'color' || !this.colorTiles) return;
    const sel = primaryClip();
    this.colorTarget.textContent = clip
      ? `Pulsa una plantilla para aplicarla a "${clip.name}". Ajusta la intensidad en el inspector.`
      : 'Selecciona un clip (o coloca el cursor sobre un video) y pulsa una plantilla.';
    const current = sel && sel.color ? sel.color.preset : clip && clip.color ? clip.color.preset : 'none';
    const img = source || this.sampleImage();

    try {
      if (!this.thumbComp) this.thumbComp = new Compositor(new OffscreenCanvas(208, 117));
      const comp = this.thumbComp;
      const tw = 208;
      const th = 117;
      const s = Math.max(tw / img.width, th / img.height);
      this.thumbVersion = (this.thumbVersion || 0) + 1;
      const provider = { sourceFor: () => ({ key: 'thumb-src', version: this.thumbVersion, ready: true, el: img, width: img.width, height: img.height }) };
      const pixels = new Uint8ClampedArray(tw * th * 4);
      const zero = { blur: 0, mosaic: 0, sharpen: 0, chroma: 0, vignette: 0, grain: 0, mirror: 0, flip: 0, invert: 0 };
      for (const tile of this.colorTiles) {
        const color = tile.preset.id === 'none' ? null : colorFromPreset(tile.preset.id, 1);
        const layer = { id: 'thumb', kind: 'image', clip: { mediaId: null }, ts: 0, baseW: img.width * s, baseH: img.height * s, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, zooms: [], censors: [], fx: zero, color };
        comp.render({ width: tw, height: th, background: '#000000', items: [{ layer }] }, provider, { fbo: 'thumb', width: tw, height: th });
        comp.readFbo('thumb', pixels);
        tile.cv.getContext('2d').putImageData(new ImageData(pixels, tw, th), 0, 0);
        tile.el.classList.toggle('on', tile.preset.id === current);
      }
    } catch (e) {
      console.warn('Miniaturas de color', e);
    }
    if (source && source !== (clip && rt(clip.mediaId) && rt(clip.mediaId).bitmap)) source.close?.();
  }
}
