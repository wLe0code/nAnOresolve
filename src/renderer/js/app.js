// Arranque de la interfaz: barra superior, áreas de trabajo, atajos, proyectos y autoguardado.

import { state, on, emit, setUI, setPlayhead, select, loadProject, markSaved, undo, redo, canUndo, canRedo } from './core/store.js';
import * as M from './core/model.js';
import * as A from './core/actions.js';
import { h, debounce, clamp } from './core/util.js';
import * as library from './media/library.js';
import { engine } from './playback/engine.js';
import { Viewer } from './ui/viewer.js';
import { Timeline } from './ui/timeline.js';
import { LeftPanel, importDialog } from './ui/panels.js';
import { Inspector, setSectionCollapsed } from './ui/inspector.js';
import { buildToolbar } from './ui/toolbar.js';
import { Recorder } from './audio/recorder.js';
import { openExportDialog, isExporting } from './ui/exportui.js';
import { exportProject } from './export/exporter.js';
import { icon } from './ui/icons.js';
import { toast, contextMenu, confirmDialog, modal } from './ui/widgets.js';

const nano = window.nano;
const app = document.getElementById('app');
let timeline = null;
let recorder = null;
let appInfo = { test: false };

const WORKSPACES = [
  { id: 'cut', name: 'Cortes', icon: 'scissors', hint: 'Monta tus clips y córtalos' },
  { id: 'edit', name: 'Edición', icon: 'layers', hint: 'Efectos, transiciones, zoom, textos y censura' },
  { id: 'color', name: 'Color', icon: 'palette', hint: 'Plantillas y corrección de color' },
];

const SHORTCUTS = [
  ['Espacio', 'Reproducir / pausar'],
  ['← / →', 'Fotograma anterior / siguiente (con Mayús, 1 segundo)'],
  ['↑ / ↓', 'Corte anterior / siguiente'],
  ['Inicio / Fin', 'Ir al principio / al final'],
  ['A', 'Herramienta de selección'],
  ['B', 'Cuchilla'],
  ['Ctrl+B', 'Cortar en el cursor'],
  ['N', 'Activar o desactivar el imán'],
  ['Supr', 'Eliminar la selección'],
  ['Mayús+Supr', 'Eliminar invirtiendo el modo "cerrar huecos"'],
  ['Ctrl+C / Ctrl+V', 'Copiar / pegar clips en el cursor'],
  ['Ctrl+D', 'Duplicar'],
  ['Ctrl+A', 'Seleccionar todo'],
  ['Ctrl+Z / Ctrl+Y', 'Deshacer / rehacer'],
  ['+ / −', 'Acercar / alejar la línea temporal'],
  ['Mayús+Z', 'Ver toda la línea temporal'],
  ['Ctrl+rueda', 'Zoom de la línea temporal en el puntero'],
  ['Ctrl+S', 'Guardar proyecto'],
  ['Ctrl+I', 'Importar medios'],
  ['Ctrl+E', 'Exportar'],
  ['Esc', 'Salir de la herramienta actual'],
];

// ---------------------------------------------------------------- proyectos ----

async function confirmDiscard() {
  if (!state.dirty) return true;
  return confirmDialog('Cambios sin guardar', 'El proyecto actual tiene cambios sin guardar. ¿Quieres descartarlos?', 'Descartar', { danger: true });
}

async function saveProject(saveAs = false) {
  try {
    const json = JSON.stringify(state.project, null, 1);
    const path = await nano.saveProject({ path: state.projectPath, json, saveAs, name: state.project.name });
    if (!path) return false;
    markSaved(path);
    nano.clearAutosave();
    toast('Proyecto guardado', 'ok');
    return true;
  } catch (e) {
    toast(`No se pudo guardar: ${library.cleanError(e)}`, 'error');
    return false;
  }
}

function openData(data, path, dirty) {
  engine.pause();
  library.resetLibrary();
  loadProject(M.reviveProject(data), path);
  if (dirty) {
    state.dirty = true;
    emit('dirty');
  }
  library.reviveMedia(state.project);
  requestAnimationFrame(() => timeline.fit());
}

async function openProject() {
  if (!(await confirmDiscard())) return;
  try {
    const res = await nano.openProject();
    if (!res) return;
    openData(JSON.parse(res.json), res.path, false);
  } catch (e) {
    toast(`No se pudo abrir el proyecto: ${library.cleanError(e)}`, 'error');
  }
}

async function newProject() {
  if (!(await confirmDiscard())) return;
  engine.pause();
  library.resetLibrary();
  loadProject(M.newProject());
  nano.clearAutosave();
}

async function restoreAutosave() {
  if (appInfo.test) return;
  try {
    const raw = await nano.readAutosave();
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved.project || (!saved.project.clips.length && !saved.project.media.length)) return;
    const ok = await confirmDialog('Recuperar trabajo', `Se encontró trabajo sin guardar de la última sesión ("${saved.project.name}"). ¿Quieres recuperarlo?`, 'Recuperar', { cancelLabel: 'Descartar' });
    if (ok) openData(saved.project, saved.path || null, true);
    else nano.clearAutosave();
  } catch (e) {
    console.warn('Autoguardado no disponible', e);
  }
}

function showShortcuts() {
  modal({
    title: 'Atajos de teclado',
    width: 520,
    body: h('div', { class: 'shortcut-list' }, SHORTCUTS.map(([k, t]) => h('div', { class: 'tip' }, h('kbd', {}, k), h('span', {}, t)))),
    buttons: [{ label: 'Cerrar', primary: true, run: (m) => m.close() }],
  });
}

// ------------------------------------------------------------ barra superior ----

function buildTopbar() {
  const fileBtn = h(
    'button',
    {
      class: 'menu-btn',
      onclick: () => {
        const r = fileBtn.getBoundingClientRect();
        contextMenu(r.left, r.bottom + 4, [
          { label: 'Nuevo proyecto', icon: 'file', shortcut: 'Ctrl+N', run: newProject },
          { label: 'Abrir proyecto…', icon: 'folder', shortcut: 'Ctrl+O', run: openProject },
          { label: 'Guardar', icon: 'save', shortcut: 'Ctrl+S', run: () => saveProject(false) },
          { label: 'Guardar como…', icon: 'save', shortcut: 'Ctrl+Mayús+S', run: () => saveProject(true) },
          '-',
          { label: 'Importar medios…', icon: 'import', shortcut: 'Ctrl+I', run: () => importDialog() },
          { label: 'Exportar…', icon: 'export', shortcut: 'Ctrl+E', run: openExportDialog },
          '-',
          { label: 'Atajos de teclado', icon: 'keyboard', run: showShortcuts },
        ]);
      },
    },
    'Archivo',
    h('span', { html: icon('chevronDown', 12) })
  );
  document.getElementById('file-menu').append(fileBtn);

  const wsButtons = WORKSPACES.map((w) => h('button', { class: 'ws-btn', title: w.hint, onclick: () => setUI({ workspace: w.id }) }, h('span', { html: icon(w.icon, 14) }), w.name));
  document.getElementById('workspaces').append(...wsButtons);

  const nameInput = document.getElementById('project-name');
  nameInput.addEventListener('change', () => A.renameProject(nameInput.value.trim()));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur();
    e.stopPropagation();
  });
  const saveState = document.getElementById('save-state');

  const undoBtn = h('button', { class: 'icon-btn', title: 'Deshacer (Ctrl+Z)', html: icon('undo', 16), onclick: () => undo() });
  const redoBtn = h('button', { class: 'icon-btn', title: 'Rehacer (Ctrl+Y)', html: icon('redo', 16), onclick: () => redo() });
  const saveBtn = h('button', { class: 'icon-btn', title: 'Guardar (Ctrl+S)', html: icon('save', 16), onclick: () => saveProject(false) });
  const exportBtn = h('button', { class: 'btn primary export-btn', title: 'Exportar el video (Ctrl+E)', onclick: openExportDialog }, h('span', { html: icon('export', 15) }), 'Exportar');
  document.getElementById('top-actions').append(undoBtn, redoBtn, saveBtn, exportBtn);

  const sync = () => {
    const p = state.project;
    if (document.activeElement !== nameInput) nameInput.value = p.name;
    nameInput.style.width = `${clamp(nameInput.value.length * 7.4 + 26, 120, 380)}px`;
    saveState.textContent = state.dirty ? 'Sin guardar' : state.projectPath ? 'Guardado' : '';
    saveState.classList.toggle('dirty', state.dirty);
    undoBtn.disabled = !canUndo();
    redoBtn.disabled = !canRedo();
    wsButtons.forEach((b, i) => b.classList.toggle('on', WORKSPACES[i].id === state.workspace));
    document.title = `${p.name}${state.dirty ? ' •' : ''} — nAnOresolve`;
  };
  on('project', sync);
  on('history', sync);
  on('dirty', () => {
    sync();
    nano.setDirty(state.dirty);
  });
  on('ui', (keys) => {
    if (keys.includes('workspace')) {
      applyWorkspace();
      sync();
    }
  });
  sync();
}

function applyWorkspace() {
  app.classList.remove('ws-cut', 'ws-edit', 'ws-color');
  app.classList.add(`ws-${state.workspace}`);
  if (state.workspace === 'cut') setUI({ leftTab: 'media' });
  else if (state.workspace === 'color') {
    setSectionCollapsed('color', false);
    setSectionCollapsed('transform', true);
    setUI({ leftTab: 'color' });
  } else {
    setSectionCollapsed('transform', false);
    if (state.leftTab === 'color') setUI({ leftTab: 'media' });
  }
}

function buildEmptyState() {
  document.getElementById('viewer-empty').append(
    h('div', { class: 'empty-logo' }),
    h('h2', {}, 'Empieza importando un video'),
    h('p', {}, 'Arrástralo a la ventana o usa el botón. Después añádelo a la línea temporal para cortarlo y editarlo.'),
    h('button', { class: 'btn primary big', onclick: () => importDialog() }, h('span', { html: icon('import', 16) }), 'Importar medios')
  );
}

// ------------------------------------------------------------------ atajos ----

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(el.type);
}

function setupShortcuts() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('button');
    if (b) b.blur();
  });

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop') || isExporting()) return;
    if (isTyping()) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const el = document.activeElement;
    if (el && el.tagName === 'INPUT' && el.type === 'range' && key.startsWith('Arrow')) return;
    let handled = true;
    const fps = state.project.settings.fps;

    if (ctrl) {
      switch (key) {
        case 'z': if (e.shiftKey) redo(); else undo(); break;
        case 'y': redo(); break;
        case 's': saveProject(e.shiftKey); break;
        case 'o': openProject(); break;
        case 'n': newProject(); break;
        case 'i': importDialog(); break;
        case 'e': openExportDialog(); break;
        case 'b': A.splitAtPlayhead(); break;
        case 'c': A.copySelection(); break;
        case 'x': if (A.copySelection()) A.deleteSelection(); break;
        case 'v': A.pasteAtPlayhead(); break;
        case 'd': A.duplicateSelection(); break;
        case 'a': A.selectAll(); break;
        default: handled = false;
      }
    } else {
      switch (key) {
        case ' ':
          if (recorder.recording) recorder.stop();
          else engine.toggle();
          break;
        case 'k': engine.pause(); break;
        case 'l': engine.play(); break;
        case 'j': engine.pause(); setPlayhead(Math.max(0, state.playhead - 1)); break;
        case 'ArrowLeft': engine.step(e.shiftKey ? -Math.round(fps) : -1); break;
        case 'ArrowRight': engine.step(e.shiftKey ? Math.round(fps) : 1); break;
        case 'ArrowUp': engine.pause(); A.jumpEdit(-1); timeline.revealPlayhead(); break;
        case 'ArrowDown': engine.pause(); A.jumpEdit(1); timeline.revealPlayhead(); break;
        case 'Home': engine.pause(); setPlayhead(0); timeline.revealPlayhead(); break;
        case 'End': engine.pause(); setPlayhead(M.projectDuration(state.project)); timeline.revealPlayhead(); break;
        case 'a':
        case 'v': setUI({ tool: 'select' }); break;
        case 'b':
        case 'c': setUI({ tool: 'blade' }); break;
        case 's': A.splitAtPlayhead(); break;
        case 'n': setUI({ snapping: !state.snapping }); toast(state.snapping ? 'Imán activado' : 'Imán desactivado'); break;
        case 'z': if (e.shiftKey) timeline.fit(); else handled = false; break;
        case '+':
        case '=': timeline.setZoom(state.pxPerSec * 1.35, timeline.xOf(state.playhead)); break;
        case '-': timeline.setZoom(state.pxPerSec / 1.35, timeline.xOf(state.playhead)); break;
        case 'Delete':
        case 'Backspace': {
          const clip = state.selection.length ? state.project.clips.find((c) => c.id === state.selection[state.selection.length - 1]) : null;
          if (clip && state.activeCensor && (clip.censors || []).some((r) => r.id === state.activeCensor)) A.removeCensor(clip, state.activeCensor);
          else if (clip && state.activeZoom && (clip.zooms || []).some((z) => z.id === state.activeZoom)) A.removeZoom(clip, state.activeZoom);
          else A.deleteSelection(e.shiftKey ? { ripple: !state.ripple } : {});
          break;
        }
        case 'Escape':
          if (state.viewerMode === 'censor') setUI({ viewerMode: null });
          else if (state.viewerMode === 'record' && !recorder.recording) recorder.close();
          else if (state.tool !== 'select') setUI({ tool: 'select' });
          else if (state.activeCensor || state.activeZoom) setUI({ activeCensor: null, activeZoom: null });
          else select([]);
          break;
        default: handled = false;
      }
    }
    if (handled) e.preventDefault();
  });
}

// --------------------------------------------------------------- separadores ----

function setupSplitters() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem('nano.layout') || '{}');
  } catch {
    saved = {};
  }
  const sizes = { left: saved.left || 300, right: saved.right || 318, timeline: saved.timeline || 330 };
  const apply = () => {
    app.style.setProperty('--left-w', `${sizes.left}px`);
    app.style.setProperty('--right-w', `${sizes.right}px`);
    app.style.setProperty('--timeline-h', `${sizes.timeline}px`);
  };
  apply();
  for (const sp of document.querySelectorAll('.splitter')) {
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add('active');
      const target = sp.dataset.target;
      const main = document.getElementById('main').getBoundingClientRect();
      const move = (ev) => {
        if (target === 'left') sizes.left = clamp(ev.clientX - main.left, 220, 520);
        else if (target === 'right') sizes.right = clamp(main.right - ev.clientX, 260, 520);
        else sizes.timeline = clamp(main.bottom - ev.clientY, 190, main.height - 230);
        apply();
      };
      const up = () => {
        sp.classList.remove('active');
        sp.removeEventListener('pointermove', move);
        sp.removeEventListener('pointerup', up);
        sp.removeEventListener('pointercancel', up);
        localStorage.setItem('nano.layout', JSON.stringify(sizes));
      };
      sp.addEventListener('pointermove', move);
      sp.addEventListener('pointerup', up);
      sp.addEventListener('pointercancel', up);
    });
  }
}

// ------------------------------------------------------- arrastrar archivos ----

function setupFileDrop() {
  const veil = document.getElementById('drop-veil');
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    veil.classList.add('show');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) veil.classList.remove('show');
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    depth = 0;
    veil.classList.remove('show');
    if (!hasFiles(e)) return;
    const handledByTimeline = e.defaultPrevented;
    e.preventDefault();
    if (handledByTimeline) return;
    const paths = [...e.dataTransfer.files].map((f) => nano.pathForFile(f)).filter(Boolean);
    if (!paths.length) return;
    const medias = await library.importPaths(paths, (name, err) => toast(`No se pudo importar ${name}: ${err}`, 'error'));
    if (medias.length) {
      setUI({ leftTab: 'media' });
      toast(medias.length === 1 ? `"${medias[0].name}" importado` : `${medias.length} archivos importados`, 'ok');
    }
  });
}

// ------------------------------------------------------------------ arranque ----

async function boot() {
  try {
    appInfo = await nano.appInfo();
  } catch {
    appInfo = { test: false };
  }
  loadProject(M.newProject());

  // eslint-disable-next-line no-new
  new Viewer();
  timeline = new Timeline();
  // eslint-disable-next-line no-new
  new LeftPanel();
  // eslint-disable-next-line no-new
  new Inspector();
  recorder = new Recorder(timeline);
  buildToolbar(timeline, recorder);
  buildTopbar();
  buildEmptyState();
  setupShortcuts();
  setupSplitters();
  setupFileDrop();
  applyWorkspace();

  const autosave = debounce(() => {
    if (!state.dirty) return;
    nano.autosave(JSON.stringify({ path: state.projectPath, savedAt: Date.now(), project: state.project })).catch(() => {});
  }, 2500);
  on('project', autosave);

  nano.on('app:saveAndClose', async () => {
    if (await saveProject(false)) nano.closeNow();
  });
  on('gl-lost', () => toast('Se perdió el contexto gráfico de la vista previa. Reinicia la aplicación si la imagen no vuelve.', 'error'));

  if (appInfo.test) {
    window.__nano = { state, M, A, engine, timeline, recorder, library, exportProject, setUI, setPlayhead, select, undo, redo, openData };
  }
  document.body.classList.add('ready');
  restoreAutosave();
}

window.addEventListener('error', (e) => console.error('Error no controlado:', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('Promesa rechazada:', e.reason && (e.reason.stack || e.reason.message || e.reason)));

boot();
