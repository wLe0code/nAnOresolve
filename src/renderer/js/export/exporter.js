// Exportación: compone cada fotograma con el mismo compositor que la vista previa, a partir de
// los originales decodificados por FFmpeg, y lo envía al codificador.

import * as M from '../core/model.js';
import { Compositor } from '../render/compositor.js';
import { buildScene, sceneLayers, fit } from '../render/scene.js';
import { rt } from '../media/library.js';
import { renderAudio, audibleClips } from './audiorender.js';

export class ExportCancelled extends Error {
  constructor() {
    super('Exportación cancelada');
    this.cancelled = true;
  }
}

// Canal de fotogramas con el preload: los búferes se transfieren sin copiarse. Si no existe
// (modo aislado), se usa la API normal, más lenta.
let framePort = null;
const waiters = new Map();
let rpcSeq = 0;
window.addEventListener('message', (e) => {
  if (framePort || e.source !== window || !e.data || !e.data.nanoFramePort || !e.ports || !e.ports[0]) return;
  framePort = e.ports[0];
  framePort.onmessage = (ev) => {
    const m = ev.data;
    const w = waiters.get(m.seq);
    if (!w) return;
    waiters.delete(m.seq);
    if (m.error) w.reject(new Error(m.error));
    else w.resolve(m);
  };
});

function rpc(msg, transfer) {
  return new Promise((resolve, reject) => {
    const seq = ++rpcSeq;
    waiters.set(seq, { resolve, reject });
    framePort.postMessage({ ...msg, seq }, transfer || []);
  });
}

async function readFrame(decId) {
  if (!framePort) return window.nano.exportReadFrame(decId);
  const r = await rpc({ op: 'read', decId });
  return r.buf ? new Uint8Array(r.buf) : null;
}

/** Envía un fotograma al codificador. El búfer queda transferido: no se puede reutilizar. */
function writeFrame(id, pixels) {
  if (!framePort) return window.nano.exportWriteFrame(id, pixels);
  return rpc({ op: 'write', id, buf: pixels.buffer }, [pixels.buffer]);
}

/**
 * Matriz con la que pedir el video en YUV (NV12) en vez de RGB, o null si ese archivo necesita
 * la conversión completa de FFmpeg (transparencia, video RGB o matrices poco habituales).
 */
function yuvMatrix(media) {
  if (media.hasAlpha || !/^(yuv|nv)/.test(media.pixFmt || '')) return null;
  if (media.hdr) return 'bt709'; // la conversión HDR -> SDR ya entrega BT.709
  const cs = media.colorSpace || '';
  if (cs === 'bt709') return 'bt709';
  if (cs === 'smpte170m' || cs === 'bt470bg') return 'bt601';
  if (cs === 'bt2020nc') return 'bt2020';
  if (cs) return null;
  if (media.videoCodec === 'vp9') return 'bt709';
  return media.height > 576 || media.width >= 1280 ? 'bt709' : 'bt601'; // misma suposición que la vista previa
}

/** Entrega al compositor los fotogramas decodificados de cada clip de video. */
class FrameProvider {
  constructor(project, sessionId, opts) {
    this.project = project;
    this.sessionId = sessionId;
    this.fps = opts.fps;
    this.outW = opts.width;
    this.fast = opts.fast !== false;
    this.decoders = new Map(); // clipId -> decodificador
    this.seq = 0;
    this.opened = 0;
    this.errors = [];
  }

  decodeSize(clip, media) {
    const { width: W, height: H } = this.project.settings;
    const [bw, bh] = fit(media.width, media.height, W, H);
    const k = this.outW / W;
    const need = (Math.max(bw, bh) * k * Math.min(M.maxScaleOf(clip), 4)) / Math.max(media.width, media.height);
    const ratio = Math.min(1, Math.max(need, 0.05));
    // Dimensiones pares: lo exige el formato 4:2:0 y no cuesta nada en los demás.
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    return [even(media.width * ratio), even(media.height * ratio)];
  }

  async prepare(scene) {
    const layers = sceneLayers(scene).filter((l) => l.kind === 'video');
    const needed = new Set(layers.map((l) => l.id));
    // Los decodificadores de clips que ya terminaron quedan disponibles para el clip siguiente
    // si este continúa justo donde acabó el anterior (cortes sin saltos).
    const parked = [];
    for (const [clipId, d] of this.decoders) {
      if (!needed.has(clipId)) {
        this.decoders.delete(clipId);
        d.adopted = false;
        parked.push(d);
      }
    }
    await Promise.all(layers.map((layer) => this.advance(layer, parked)));
    for (const d of parked) if (!d.adopted) this.close(d);
  }

  async advance(layer, parked) {
    const clip = layer.clip;
    const media = M.mediaById(this.project, clip.mediaId);
    if (!media || media.type !== 'video') return;
    let d = this.decoders.get(clip.id);
    if (!d) {
      const [w, h] = this.decodeSize(clip, media);
      const speed = M.speedOf(clip);
      d = parked.find((x) => {
        if (x.adopted || x.eof || x.mediaId !== media.id || x.w !== w || x.h !== h || x.speed !== speed) return false;
        const target = Math.round(((layer.ts - x.ss) / speed) * this.fps);
        return target >= x.index && target <= x.index + 2;
      });
      if (d) d.adopted = true;
      else {
        const ss = Math.max(0, layer.ts);
        const alpha = !!media.hasAlpha;
        const yuv = this.fast ? yuvMatrix(media) : null;
        const decId = await window.nano.exportOpenVideoDecoder(this.sessionId, { media, ss, fps: this.fps, width: w, height: h, alpha, speed, yuv: !!yuv });
        d = { decId, mediaId: media.id, name: media.name, ss, speed, index: -1, frame: null, eof: false, w, h, uid: ++this.seq, alpha, yuv, adopted: false };
        this.opened++;
      }
      this.decoders.set(clip.id, d);
    }
    // El decodificador entrega un fotograma por cada fotograma de salida: n ↔ origen ss + n × velocidad / fps.
    const target = Math.max(0, Math.round(((layer.ts - d.ss) / d.speed) * this.fps));
    while (d.index < target && !d.eof) {
      const frame = await readFrame(d.decId);
      if (!frame) {
        d.eof = true;
        break;
      }
      d.frame = frame;
      d.index++;
    }
  }

  close(d) {
    Promise.resolve(window.nano.exportCloseDecoder(d.decId)).then((err) => {
      if (d.index < 0 && err) this.errors.push(`${d.name}: ${err}`);
    }).catch(() => {});
  }

  sourceFor(layer) {
    if (layer.kind === 'image') {
      const media = M.mediaById(this.project, layer.clip.mediaId);
      const bmp = media ? rt(media.id).bitmap : null;
      if (!bmp) return null;
      return { key: `img:${media.id}`, version: 1, ready: true, el: bmp, width: bmp.width, height: bmp.height };
    }
    const d = this.decoders.get(layer.id);
    if (!d || !d.frame) return null;
    return { key: `dec:${d.uid}`, version: d.index, ready: true, data: d.frame, width: d.w, height: d.h, straight: d.alpha, channels: d.alpha ? 4 : 3, yuv: d.yuv };
  }

  dispose() {
    for (const d of this.decoders.values()) this.close(d);
    this.decoders.clear();
  }
}

/**
 * Exporta el proyecto.
 * opts: { outPath, width, height, fps, format, quality, speed, hw, audioOnly, start, end }
 * onProgress({ stage: 'audio' | 'video' | 'finishing', fraction, frame, total, speed, pixels })
 * ctl: { cancelled } — pon cancelled = true para detener.
 */
export async function exportProject(project, opts, onProgress, ctl) {
  const nano = window.nano;
  const start = opts.start || 0;
  const end = opts.end ?? M.projectDuration(project);
  if (end - start <= 0) throw new Error('La línea temporal está vacía');
  // Ruta rápida: el compositor entrega cada fotograma ya en YUV 4:2:0 (NV12). ProRes guarda
  // más detalle de color (4:2:2), así que sigue recibiendo RGBA.
  let comp = null;
  let nv12 = false;
  if (!opts.audioOnly) {
    comp = new Compositor(new OffscreenCanvas(opts.width, opts.height));
    nv12 = opts.fast !== false && opts.format !== 'mov-prores' && opts.width % 2 === 0 && opts.height % 2 === 0 && comp.supportsNV12();
  }
  const { id } = await nano.exportBegin({
    outPath: opts.outPath,
    pixFmt: nv12 ? 'nv12' : 'rgba',
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    format: opts.format,
    quality: opts.quality,
    speed: opts.speed,
    hw: !!opts.hw,
    audioOnly: !!opts.audioOnly,
  });
  ctl.sessionId = id;
  let provider = null;
  let encoder = null;
  try {
    const hasAudio = audibleClips(project).length > 0;
    if (opts.audioOnly && !hasAudio) throw new Error('El proyecto no tiene audio que exportar');
    if (hasAudio) {
      await renderAudio(project, id, start, end, (f) => onProgress({ stage: 'audio', fraction: f }), ctl).catch((e) => {
        if (ctl.cancelled) throw new ExportCancelled();
        throw e;
      });
    }
    if (ctl.cancelled) throw new ExportCancelled();

    if (!opts.audioOnly) {
      encoder = await nano.exportStartEncoder(id);
      const { width, height, fps } = opts;
      provider = new FrameProvider(project, id, opts);
      const total = Math.max(1, Math.round((end - start) * fps));
      const frameBytes = nv12 ? width * height * 1.5 : width * height * 4;
      const t0 = performance.now();
      const stats = { prepare: 0, render: 0, read: 0, write: 0 };
      ctl.stats = stats;
      // Canalización solapada: mientras se lee de la GPU la imagen del fotograma n y se escribe
      // en el codificador, ya se piden al decodificador los datos del fotograma n + 1.
      const sceneAt = (n) => buildScene(project, start + n / fps);
      let scene = sceneAt(0);
      let pending = provider.prepare(scene);
      let prevWrite = Promise.resolve();
      for (let n = 0; n < total; n++) {
        if (ctl.cancelled) throw new ExportCancelled();
        let m0 = performance.now();
        await pending;
        let m1 = performance.now();
        stats.prepare += m1 - m0;
        if (comp.lost) throw new Error('Se perdió el contexto gráfico durante la exportación');
        comp.render(scene, provider, { fbo: 'out', width, height });
        m0 = performance.now();
        stats.render += m0 - m1;
        if (n + 1 < total) {
          scene = sceneAt(n + 1);
          pending = provider.prepare(scene);
          pending.catch(() => {});
        }
        await prevWrite;
        m1 = performance.now();
        stats.write += m1 - m0;
        // Búfer nuevo en cada fotograma: al escribirlo se transfiere al codificador sin copiarlo.
        const pixels = nv12 ? comp.readNV12('out', new Uint8Array(frameBytes)) : comp.readFbo('out', new Uint8Array(frameBytes));
        stats.read += performance.now() - m1;
        if (n % 4 === 0 || n === total - 1) {
          const elapsed = (performance.now() - t0) / 1000;
          // Miniatura de progreso (una de cada 24): siempre en RGBA.
          let thumb = null;
          if (n % 24 === 0) thumb = nv12 ? comp.readFbo('out', new Uint8Array(width * height * 4)) : pixels;
          onProgress({ stage: 'video', fraction: (n + 1) / total, frame: n + 1, total, speed: (n + 1) / Math.max(elapsed, 0.001), pixels: thumb, width, height });
        }
        prevWrite = writeFrame(id, pixels);
        prevWrite.catch(() => {});
      }
      await prevWrite;
    }
    onProgress({ stage: 'finishing', fraction: 1 });
    const result = await nano.exportFinish(id);
    return { ...result, encoder, fast: nv12, warnings: provider ? provider.errors : [] };
  } catch (e) {
    await nano.exportCancel(id).catch(() => {});
    throw e;
  } finally {
    if (provider) provider.dispose();
    if (comp) comp.dispose();
  }
}
