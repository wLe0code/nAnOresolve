'use strict';
// Puente entre la interfaz y el resto de la app.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const EVENTS = new Set(['media:proxyProgress', 'app:saveAndClose']);

// Exportación: los fotogramas (varios MB cada uno) viajan por tuberías directas entre este
// proceso y FFmpeg; pasarlos por IPC al proceso principal era el cuello de botella.
// Si el módulo no puede cargarse aquí, se usa la ruta por IPC, más lenta pero equivalente.
let exporter = null;
try {
  exporter = require('../main/exporter');
  window.addEventListener('beforeunload', () => {
    exporter.cancelAll().catch(() => {});
  });
} catch (e) {
  exporter = null;
}
const exp = (name, channel) => (exporter ? (...args) => exporter[name](...args) : invoke(channel));

// Canal de fotogramas: los búferes se transfieren a la página sin copiarlos (el puente de
// contexto los copiaría enteros en cada sentido).
if (exporter) {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = async (e) => {
    const m = e.data;
    try {
      if (m.op === 'read') {
        const buf = await exporter.readFrame(m.decId);
        if (!buf) {
          port1.postMessage({ seq: m.seq, buf: null });
          return;
        }
        const whole = buf.byteOffset === 0 && buf.buffer.byteLength === buf.length;
        const ab = whole ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
        port1.postMessage({ seq: m.seq, buf: ab }, [ab]);
      } else if (m.op === 'write') {
        await exporter.writeFrame(m.id, new Uint8Array(m.buf));
        port1.postMessage({ seq: m.seq, ok: true });
      }
    } catch (err) {
      port1.postMessage({ seq: m.seq, error: String((err && err.message) || err) });
    }
  };
  window.addEventListener('DOMContentLoaded', () => {
    window.postMessage({ nanoFramePort: true }, '*', [port2]);
  });
}

contextBridge.exposeInMainWorld('nano', {
  appInfo: invoke('app:info'),

  openMediaDialog: invoke('dialog:openMedia'),
  probe: invoke('media:probe'),
  makeProxy: invoke('media:proxy'),
  peaks: invoke('media:peaks'),
  saveRecording: invoke('media:saveRecording'),
  pathForFile: (file) => webUtils.getPathForFile(file),

  openProject: invoke('project:open'),
  saveProject: invoke('project:save'),
  autosave: invoke('project:autosave'),
  readAutosave: invoke('project:readAutosave'),
  clearAutosave: invoke('project:clearAutosave'),

  exportChoosePath: invoke('export:choosePath'),
  exportDirect: !!exporter,
  exportBegin: exp('begin', 'export:begin'),
  exportAudioWrite: exp('audioWrite', 'export:audioWrite'),
  exportStartEncoder: exp('startEncoder', 'export:startEncoder'),
  exportWriteFrame: exp('writeFrame', 'export:writeFrame'),
  exportOpenVideoDecoder: exp('openVideoDecoder', 'export:openVideoDecoder'),
  exportOpenAudioDecoder: exp('openAudioDecoder', 'export:openAudioDecoder'),
  exportReadFrame: exp('readFrame', 'export:readFrame'),
  exportReadAudio: exp('readAudio', 'export:readAudio'),
  exportCloseDecoder: exp('closeDecoder', 'export:closeDecoder'),
  exportFinish: exp('finish', 'export:finish'),
  exportCancel: exp('cancel', 'export:cancel'),

  showItem: invoke('shell:showItem'),
  setDirty: (v) => ipcRenderer.send('app:setDirty', !!v),
  closeNow: () => ipcRenderer.send('app:closeNow'),

  on: (channel, cb) => {
    if (!EVENTS.has(channel)) return () => {};
    const h = (_e, ...args) => cb(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
