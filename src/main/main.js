'use strict';
// Proceso principal de nAnOresolve: ventana, protocolo local, diálogos y puente con FFmpeg.

const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const ff = require('./ffmpeg');
const media = require('./media');
const exporter = require('./exporter');

const IS_TEST = !!process.env.NANO_TEST;
const IS_DEV = IS_TEST || process.argv.includes('--dev');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_ORIGIN = 'nano://app';

if (process.env.NANO_USER_DATA) app.setPath('userData', process.env.NANO_USER_DATA);
if (IS_TEST) {
  // Micrófono simulado para las pruebas automáticas.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'nano', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } },
]);

let win = null;
let dirty = false;
let closing = false;

const cacheDir = () => path.join(app.getPath('userData'), 'cache');
const recordingsDir = () =>
  process.env.NANO_USER_DATA ? path.join(process.env.NANO_USER_DATA, 'Grabaciones') : path.join(app.getPath('documents'), 'nAnOresolve', 'Grabaciones');
const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.json');

// ------------------------------------------------------- protocolo nano:// ----

// Solo se sirven archivos que el usuario ha importado o que la app ha generado.
const allowedMedia = new Set();
const allow = (p) => allowedMedia.add(path.resolve(p).toLowerCase());
const isAllowed = (p) => allowedMedia.has(path.resolve(p).toLowerCase());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

async function serveFile(request, file) {
  let stat;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return new Response('No encontrado', { status: 404 });
  }
  const size = stat.size;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = request.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
    let end = m[1] && m[2] ? parseInt(m[2], 10) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = fs.createReadStream(file, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  if (size === 0) return new Response('', { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function registerProtocol() {
  protocol.handle('nano', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== 'app') return new Response('No encontrado', { status: 404 });
      if (url.pathname === '/__media__') {
        const p = url.searchParams.get('p');
        if (!p || !isAllowed(p)) return new Response('Prohibido', { status: 403 });
        return await serveFile(request, p);
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(RENDERER_DIR, rel));
      if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Prohibido', { status: 403 });
      return await serveFile(request, file);
    } catch (e) {
      return new Response(String(e && e.message), { status: 500 });
    }
  });
}

// ------------------------------------------------------------------ ventana ----

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 680,
    show: false,
    backgroundColor: '#0d0e12',
    title: 'nAnOresolve',
    focusable: !IS_TEST,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#111217', symbolColor: '#b9bdc9', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // El preload necesita Node para hablar con FFmpeg por tuberías durante la exportación.
      // La página sigue aislada (contextIsolation) y solo carga contenido propio de la app.
      sandbox: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    if (IS_TEST) {
      // En las pruebas la ventana se muestra sin tomar el foco (oculta, Chromium no decodifica video).
      win.showInactive();
    } else {
      win.maximize();
      win.show();
    }
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${APP_ORIGIN}/`)) e.preventDefault();
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (IS_DEV && input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('close', (e) => {
    if (closing || !dirty || IS_TEST) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'nAnOresolve',
      message: '¿Guardar los cambios del proyecto antes de salir?',
      buttons: ['Guardar', 'No guardar', 'Cancelar'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) win.webContents.send('app:saveAndClose');
    else if (choice === 1) {
      closing = true;
      win.close();
    }
  });
  win.on('closed', () => {
    win = null;
  });

  win.loadURL(`${APP_ORIGIN}/index.html`);
}

function setupPermissions() {
  const granted = new Set(['media', 'local-fonts', 'clipboard-sanitized-write']);
  const fromApp = (url) => typeof url === 'string' && url.startsWith(APP_ORIGIN);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(granted.has(permission) && fromApp(wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, origin) => granted.has(permission) && fromApp(origin));
}

// ---------------------------------------------------------------------- IPC ----

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'vob', 'mxf', 'f4v', 'asf', 'divx', 'gif', 'rm', 'rmvb', 'dv', 'y4m'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'ac3', 'amr', 'mka'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'avif', 'tif', 'tiff', 'tga', 'heic'];

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (_e, ...args) => fn(...args));

  handle('app:info', async () => {
    const caps = await ff.capabilities().catch(() => null);
    return {
      version: app.getVersion(),
      test: IS_TEST,
      dev: IS_DEV,
      platform: process.platform,
      ffmpeg: caps ? caps.version : null,
      recordingsDir: recordingsDir(),
    };
  });

  handle('dialog:openMedia', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Importar medios',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Medios', extensions: [...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT] },
        { name: 'Video', extensions: VIDEO_EXT },
        { name: 'Audio', extensions: AUDIO_EXT },
        { name: 'Imágenes', extensions: IMAGE_EXT },
        { name: 'Todos los archivos', extensions: ['*'] },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  handle('media:probe', async (file) => {
    const info = await ff.probe(String(file));
    allow(info.path);
    return info;
  });

  handle('media:proxy', async (info) => {
    const out = await media.ensureProxy(info, cacheDir(), (progress) => {
      if (win && !win.isDestroyed()) win.webContents.send('media:proxyProgress', { path: info.path, progress });
    });
    allow(out);
    return out;
  });

  handle('media:peaks', (info) => media.computePeaks(info, cacheDir()));

  handle('media:saveRecording', async (bytes, name) => {
    const file = await media.saveRecording(recordingsDir(), bytes, name);
    allow(file);
    return file;
  });

  // Proyectos
  handle('project:open', async (file) => {
    let target = file;
    if (!target) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Abrir proyecto',
        properties: ['openFile'],
        filters: [{ name: 'Proyecto de nAnOresolve', extensions: ['nres'] }],
      });
      if (res.canceled || !res.filePaths.length) return null;
      target = res.filePaths[0];
    }
    const json = await fs.promises.readFile(target, 'utf8');
    return { path: target, json };
  });

  handle('project:save', async ({ path: current, json, saveAs, name }) => {
    let target = current;
    if (!target || saveAs) {
      const res = await dialog.showSaveDialog(win, {
        title: 'Guardar proyecto',
        defaultPath: current || path.join(app.getPath('documents'), `${name || 'Proyecto'}.nres`),
        filters: [{ name: 'Proyecto de nAnOresolve', extensions: ['nres'] }],
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    await fs.promises.writeFile(target, json, 'utf8');
    return target;
  });

  handle('project:autosave', async (json) => {
    await fs.promises.mkdir(path.dirname(autosaveFile()), { recursive: true });
    await fs.promises.writeFile(autosaveFile(), json, 'utf8');
    return true;
  });
  handle('project:readAutosave', async () => {
    try {
      return await fs.promises.readFile(autosaveFile(), 'utf8');
    } catch {
      return null;
    }
  });
  handle('project:clearAutosave', async () => {
    await fs.promises.rm(autosaveFile(), { force: true }).catch(() => {});
    return true;
  });

  // Exportación
  handle('export:choosePath', async ({ name, ext, label }) => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Exportar',
      defaultPath: path.join(app.getPath('videos'), `${name || 'Video'}.${ext}`),
      filters: [{ name: label || ext.toUpperCase(), extensions: [ext] }],
    });
    return res.canceled ? null : res.filePath;
  });
  handle('export:begin', (opts) => exporter.begin(opts));
  handle('export:audioWrite', (id, bytes) => exporter.audioWrite(id, bytes));
  handle('export:startEncoder', (id) => exporter.startEncoder(id));
  handle('export:writeFrame', (id, bytes) => exporter.writeFrame(id, bytes));
  handle('export:openVideoDecoder', (id, p) => exporter.openVideoDecoder(id, p));
  handle('export:openAudioDecoder', (id, p) => exporter.openAudioDecoder(id, p));
  handle('export:readFrame', (decId) => exporter.readFrame(decId));
  handle('export:readAudio', (decId, max) => exporter.readAudio(decId, max));
  handle('export:closeDecoder', (decId) => exporter.closeDecoder(decId));
  handle('export:finish', (id) => exporter.finish(id));
  handle('export:cancel', (id) => exporter.cancel(id));

  handle('shell:showItem', (file) => {
    shell.showItemInFolder(String(file));
    return true;
  });

  ipcMain.on('app:setDirty', (_e, v) => {
    dirty = !!v;
  });
  ipcMain.on('app:closeNow', () => {
    closing = true;
    if (win) win.close();
  });
}

// --------------------------------------------------------------- arranque ----

const gotLock = IS_TEST || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerProtocol();
    setupPermissions();
    registerIpc();
    createWindow();
    if (IS_TEST) {
      // Diagnóstico para las pruebas: confirma que los binarios incluidos responden.
      ff.capabilities()
        .then((c) => console.log(`[nano] ffmpeg ${c.version} · filtros ${c.filters.size} · codificadores ${c.encoders.size}`))
        .catch((e) => console.log(`[nano] ffmpeg no disponible: ${e.message}`));
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    media.killProxies();
    exporter.cancelAll().catch(() => {});
  });
}

module.exports = { getWindow: () => win, allow, recordingsDir };
