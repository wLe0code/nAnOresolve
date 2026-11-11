'use strict';
// Prueba de humo: arranca la app real, la maneja como lo haría una persona y guarda capturas.
//
//   npm run test:smoke
//
// Variables de entorno:
//   NANO_OUT       carpeta donde dejar capturas y resultados (por defecto scripts/.tmp/smoke)
//   NANO_MEDIA     carpeta con el material de prueba (por defecto scripts/.tmp/media)
//   NANO_SCENARIO  ruta a un guion alternativo: módulo que exporta async (ctx) => {}

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const outDir = path.resolve(process.env.NANO_OUT || path.join(__dirname, '.tmp', 'smoke'));
const mediaDir = path.resolve(process.env.NANO_MEDIA || path.join(__dirname, '.tmp', 'media'));
fs.mkdirSync(outDir, { recursive: true });
process.env.NANO_TEST = '1';
process.env.NANO_USER_DATA = process.env.NANO_USER_DATA || path.join(outDir, 'userdata');

const { app, BrowserWindow } = require('electron');
require('../src/main/main.js');
const ff = require('../src/main/ffmpeg');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logs = [];

/** Guion por defecto: importar, montar, editar y exportar un video corto. */
async function defaultScenario(ctx) {
  const { js, shot, waitFor, log, media } = ctx;
  const files = ['a_h264.mp4', 'c_mpeg4.avi', 'music.mp3'].map(media);

  log('importando', files.length, 'archivos');
  await js(`await __nano.library.importPaths(${JSON.stringify(files)}, (n, e) => console.error('import', n, e));`);
  await waitFor(`__nano.state.project.media.length === 3 && __nano.state.project.media.every((m) => __nano.library.isReady(m.id))`, 120000);

  log('montando la línea temporal');
  await js(`
    const { state, A, M, select, setPlayhead } = __nano;
    const [a, c, music] = state.project.media;
    const c1 = A.addMediaToTimeline(a);
    A.addMediaToTimeline(c);
    A.addMediaToTimeline(music);
    setPlayhead(3);
    select(c1.id);
    A.splitAtPlayhead();
    setPlayhead(5);
    A.splitAtPlayhead();
    const mid = state.project.clips.find((x) => x.mediaId === a.id && Math.abs(x.start - 3) < 0.01);
    select(mid.id);
    A.deleteSelection();
    const first = state.project.clips.find((x) => x.mediaId === a.id && x.start === 0);
    A.applyColorPreset([first], 'desert');
    A.addCensor(first, { x: 0.5, y: 0.5, w: 0.3, h: 0.2 });
    setPlayhead(1);
    A.addZoom(first);
    A.addText('title');
    const second = state.project.clips.find((x) => x.mediaId === a.id && x.start > 0);
    A.applyTransition(second, 'in', 'dissolve');
    __nano.timeline.fit();
    setPlayhead(1.5);
  `);
  await sleep(1500);
  await shot('editor');

  const out = path.join(outDir, 'smoke.mp4');
  log('exportando', out);
  const result = await js(`
    const { state, exportProject } = __nano;
    const p = state.project;
    return await exportProject(p, { outPath: ${JSON.stringify(out)}, width: 640, height: 360, fps: p.settings.fps, format: 'mp4-h264', quality: 'medium', speed: 'fast', start: 0, end: 4 }, () => {}, { cancelled: false });
  `);
  const info = await ff.probe(out);
  log('exportado', result.size, 'bytes ·', info.width + 'x' + info.height, '·', info.duration.toFixed(2), 's · audio:', info.hasAudio);
  if (info.width !== 640 || Math.abs(info.duration - 4) > 0.2 || !info.hasAudio) throw new Error('El archivo exportado no coincide con lo esperado');
}

async function main() {
  await app.whenReady();
  if (!fs.existsSync(path.join(mediaDir, 'a_h264.mp4'))) {
    spawnSync(process.execPath, [path.join(__dirname, 'make-test-media.js'), mediaDir], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  }
  let win = null;
  for (let i = 0; i < 200 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (!win) await sleep(50);
  }
  const wc = win.webContents;
  wc.on('console-message', (e, level, message, line, source) => {
    const lv = e && e.level !== undefined ? e.level : level;
    const msg = e && e.message !== undefined ? e.message : message;
    const isError = lv === 'error' || lv === 3;
    const isWarn = lv === 'warning' || lv === 2;
    logs.push({ level: isError ? 'error' : isWarn ? 'warn' : 'log', message: String(msg), source: `${(e && e.sourceId) || source || ''}:${(e && e.lineNumber) || line || ''}` });
  });
  wc.on('render-process-gone', (_e, d) => logs.push({ level: 'error', message: `render-process-gone: ${d.reason}`, source: '' }));

  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const ctx = {
    win,
    wc,
    outDir,
    mediaDir,
    logs,
    sleep,
    js,
    ff,
    media: (name) => path.join(mediaDir, name),
    log: (...a) => console.log('[smoke]', ...a),
    shot: async (name) => {
      const img = await wc.capturePage();
      const file = path.join(outDir, `${name}.png`);
      fs.writeFileSync(file, img.toPNG());
      return file;
    },
    waitFor: async (expr, timeout = 20000) => {
      const t0 = Date.now();
      for (;;) {
        if (await js(`return !!(${expr});`)) return true;
        if (Date.now() - t0 > timeout) throw new Error(`Tiempo agotado esperando: ${expr}`);
        await sleep(100);
      }
    },
    mouse: (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra }),
    key: (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    },
  };

  let code = 0;
  try {
    await ctx.waitFor('window.__nano && document.body.classList.contains("ready")', 30000);
    const scenario = process.env.NANO_SCENARIO ? require(path.resolve(process.env.NANO_SCENARIO)) : defaultScenario;
    await scenario(ctx);
    console.log('[smoke] guion terminado');
  } catch (e) {
    code = 1;
    console.error('[smoke] FALLO:', e && (e.stack || e.message || e));
    await ctx.shot('fallo').catch(() => {});
  }
  const errors = logs.filter((l) => l.level === 'error');
  for (const l of logs) if (l.level !== 'log' || process.env.NANO_VERBOSE) console.log(`[consola:${l.level}] ${l.message} (${l.source})`);
  if (errors.length) code = 1;
  console.log(code ? '[smoke] RESULTADO: FALLO' : '[smoke] RESULTADO: OK');
  app.exit(code);
}

main();
