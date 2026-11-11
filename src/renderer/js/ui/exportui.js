// Diálogo de exportación: formato, resolución, calidad y progreso.

import { state } from '../core/store.js';
import * as M from '../core/model.js';
import { h, formatDur, formatBytes } from '../core/util.js';
import { EXPORT_FORMATS, EXPORT_QUALITIES, FRAME_RATES } from '../core/presets.js';
import { rt, cleanError } from '../media/library.js';
import { engine } from '../playback/engine.js';
import { exportProject } from '../export/exporter.js';
import { modal, toast } from './widgets.js';
import { icon } from './icons.js';

let lastOptions = { format: 'mp4-h264', quality: 'high', speed: 'balanced', height: 0, fps: 0 };
let exporting = false;

export const isExporting = () => exporting;

function resolutionOptions(project) {
  const { width: W, height: H } = project.settings;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const short = Math.min(W, H);
  const out = [{ id: 0, w: W, h: H, name: `Igual que el proyecto · ${W}×${H}` }];
  for (const s of [2160, 1440, 1080, 720, 480]) {
    if (s === short) continue;
    const k = s / short;
    const w = even(W * k);
    const hh = even(H * k);
    if (Math.max(w, hh) > 7680) continue;
    out.push({ id: s, w, h: hh, name: `${s === 2160 ? '4K' : s === 1440 ? '2K' : `${s}p`} · ${w}×${hh}` });
  }
  return out;
}

export function openExportDialog() {
  if (exporting) return;
  const project = state.project;
  const duration = M.projectDuration(project);
  if (duration <= 0) {
    toast('Añade algún clip a la línea temporal antes de exportar');
    return;
  }
  engine.pause();
  const missing = project.clips.filter((c) => c.mediaId && ['offline', 'error'].includes(rt(c.mediaId).status)).length;
  const resOptions = resolutionOptions(project);
  const fpsOptions = [{ id: 0, name: `Igual que el proyecto · ${project.settings.fps} fps` }, ...FRAME_RATES.filter((f) => f !== project.settings.fps).map((f) => ({ id: f, name: `${f} fps` }))];
  const opt = { ...lastOptions };
  if (!resOptions.some((r) => r.id === opt.height)) opt.height = 0;

  const select = (options, key, onChange) => {
    const el = h(
      'select',
      {
        class: 'select',
        onchange: () => {
          const raw = el.value;
          opt[key] = typeof options[0].id === 'number' ? Number(raw) : raw;
          if (onChange) onChange();
        },
      },
      options.map((o) => h('option', { value: o.id }, o.name))
    );
    el.value = opt[key];
    return el;
  };
  const field = (label, control, hintEl) => h('div', { class: 'form-row' }, h('label', {}, label), h('div', { class: 'form-control' }, control, hintEl || null));

  const formatHint = h('div', { class: 'form-hint' });
  const qualityHint = h('div', { class: 'form-hint' });
  const videoFields = h('div', {});
  const updateHints = () => {
    const f = EXPORT_FORMATS.find((x) => x.id === opt.format);
    formatHint.textContent = f.hint;
    qualityHint.textContent = EXPORT_QUALITIES.find((x) => x.id === opt.quality).hint;
    videoFields.style.display = f.audioOnly ? 'none' : '';
  };
  videoFields.append(
    field('Resolución', select(resOptions, 'height')),
    field('Fotogramas', select(fpsOptions, 'fps')),
    field('Codificación', select([{ id: 'fast', name: 'Rápida' }, { id: 'balanced', name: 'Equilibrada' }, { id: 'slow', name: 'Lenta (archivo más pequeño)' }], 'speed'))
  );

  const form = h(
    'div',
    { class: 'export-form' },
    h('div', { class: 'export-summary' }, h('span', { html: icon('clock', 14) }), `Duración: ${formatDur(duration)}`, h('span', { class: 'dot' }, '·'), `${project.clips.length} clips`),
    missing ? h('div', { class: 'export-warn' }, h('span', { html: icon('warning', 14) }), `${missing} ${missing === 1 ? 'clip usa un archivo' : 'clips usan archivos'} que no se encuentra y saldrá en negro.`) : null,
    field('Formato', select(EXPORT_FORMATS, 'format', updateHints), formatHint),
    field('Calidad', select(EXPORT_QUALITIES, 'quality', updateHints), qualityHint),
    videoFields,
    h('p', { class: 'form-note' }, 'La exportación lee siempre los archivos originales a su máxima calidad, aunque la vista previa use copias ligeras.')
  );
  updateHints();

  const progress = h('div', { class: 'export-progress' });
  const body = h('div', {}, form, progress);
  let ctl = null;

  const dlg = modal({
    title: 'Exportar',
    body,
    width: 500,
    buttons: [],
    onClose: () => {
      if (ctl && exporting) ctl.cancelled = true;
    },
  });

  const idleButtons = () =>
    dlg.setButtons([
      { label: 'Cancelar', run: (m) => m.close() },
      { label: 'Exportar…', icon: 'export', primary: true, run: () => start() },
    ]);
  idleButtons();

  async function start() {
    const f = EXPORT_FORMATS.find((x) => x.id === opt.format);
    const outPath = await window.nano.exportChoosePath({ name: project.name, ext: f.ext, label: f.name });
    if (!outPath) return;
    lastOptions = { ...opt };
    const res = resOptions.find((r) => r.id === opt.height) || resOptions[0];
    const fps = opt.fps || project.settings.fps;
    ctl = { cancelled: false };
    exporting = true;
    dlg.locked = true;
    form.style.display = 'none';

    const bar = h('div', { class: 'bar-fill' });
    const stage = h('div', { class: 'export-stage' }, 'Preparando…');
    const detail = h('div', { class: 'export-detail' });
    const preview = h('canvas', { class: 'export-preview', width: 320, height: Math.max(2, Math.round((320 * res.h) / res.w)) });
    progress.replaceChildren(f.audioOnly ? '' : preview, stage, h('div', { class: 'bar' }, bar), detail);
    dlg.setButtons([{ label: 'Detener exportación', danger: true, run: () => { ctl.cancelled = true; stage.textContent = 'Cancelando…'; } }]);
    const pctx = preview.getContext('2d');
    const t0 = performance.now();
    let drawing = false;

    const onProgress = (p) => {
      // El audio ocupa el primer 6 % de la barra; el video, el resto.
      const hasVideo = !f.audioOnly;
      let frac = p.fraction || 0;
      if (p.stage === 'audio') {
        stage.textContent = 'Mezclando el audio…';
        frac = hasVideo ? frac * 0.06 : frac;
      } else if (p.stage === 'video') {
        stage.textContent = 'Renderizando el video…';
        const left = p.speed > 0 ? (p.total - p.frame) / p.speed : 0;
        detail.textContent = `Fotograma ${p.frame} de ${p.total} · ${p.speed.toFixed(1)} fps · faltan ${formatDur(left)}`;
        frac = 0.06 + frac * 0.94;
        if (p.pixels && !drawing) {
          drawing = true;
          createImageBitmap(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height), { resizeWidth: preview.width, resizeHeight: preview.height, resizeQuality: 'low' })
            .then((bmp) => {
              pctx.drawImage(bmp, 0, 0);
              bmp.close();
            })
            .catch(() => {})
            .finally(() => {
              drawing = false;
            });
        }
      } else {
        stage.textContent = 'Terminando el archivo…';
        frac = 1;
      }
      bar.style.width = `${(frac * 100).toFixed(1)}%`;
    };

    try {
      const result = await exportProject(project, { outPath, width: res.w, height: res.h, fps, format: f.id, quality: opt.quality, speed: opt.speed, audioOnly: !!f.audioOnly }, onProgress, ctl);
      exporting = false;
      dlg.locked = false;
      const secs = (performance.now() - t0) / 1000;
      progress.replaceChildren(
        h('div', { class: 'export-done' }, h('span', { class: 'done-ico', html: icon('check', 26) }), h('div', {}, h('b', {}, 'Exportación completada'), h('span', {}, `${formatBytes(result.size)} · ${formatDur(secs)} de proceso`))),
        h('div', { class: 'export-path', title: result.path }, result.path),
        result.warnings && result.warnings.length ? h('div', { class: 'export-warn' }, `Avisos: ${result.warnings.slice(0, 3).join(' · ')}`) : null
      );
      dlg.setButtons([
        { label: 'Mostrar en la carpeta', icon: 'folder', run: () => window.nano.showItem(result.path) },
        { label: 'Cerrar', primary: true, run: (m) => m.close() },
      ]);
    } catch (e) {
      exporting = false;
      dlg.locked = false;
      if (e && e.cancelled) {
        if (dlg.closed) return;
        progress.replaceChildren();
        form.style.display = '';
        idleButtons();
        toast('Exportación cancelada');
        return;
      }
      console.error(e);
      progress.replaceChildren(h('div', { class: 'export-error' }, h('b', {}, 'No se pudo exportar'), h('pre', {}, cleanError(e))));
      dlg.setButtons([
        { label: 'Cerrar', run: (m) => m.close() },
        { label: 'Volver a intentar', primary: true, run: () => { progress.replaceChildren(); form.style.display = ''; idleButtons(); } },
      ]);
    }
  }
}
