// Grabación de voz: el botón del micrófono abre un panel con un botón grande; al pulsarlo se
// graba desde la posición del cursor y el audio queda como clip en una pista de audio.

import { state, on, setUI, setPlayhead, select, beginTxn, endTxn, cancelTxn, touch } from '../core/store.js';
import * as M from '../core/model.js';
import { h, clamp, formatTC } from '../core/util.js';
import { importPaths, cleanError } from '../media/library.js';
import { engine } from '../playback/engine.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/widgets.js';

const SR = 48000;
const LIVE_PEAKS = 50;

function encodeWav(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

export class Recorder {
  constructor(timeline) {
    this.timeline = timeline;
    this.open = false;
    this.recording = false;
    this.busy = false;
    this.opts = { countdown: true, muteProject: true, denoise: true };
    this.buildHud();
    on('ui', (keys) => {
      if (keys.includes('viewerMode') && state.viewerMode !== 'record' && this.open && !this.recording) this.close();
    });
    on('playhead', () => {
      if (this.open && !this.recording) this.updateHint();
    });
  }

  buildHud() {
    const check = (label, key, title) => {
      const input = h('input', { type: 'checkbox', checked: this.opts[key], onchange: () => { this.opts[key] = input.checked; if (key === 'denoise' && this.open && !this.recording) this.initMic(this.deviceSel.value); } });
      return h('label', { class: 'mic-check', title: title || '' }, input, h('span', {}, label));
    };
    this.deviceSel = h('select', { class: 'select mic-device', title: 'Micrófono', onchange: () => this.initMic(this.deviceSel.value) });
    this.levelFill = h('div', { class: 'mic-level-fill' });
    this.bigBtn = h('button', { class: 'mic-big', title: 'Grabar / detener', onclick: () => (this.recording ? this.stop() : this.start()) }, h('span', { class: 'mic-big-ico', html: icon('mic', 34) }));
    this.hint = h('div', { class: 'mic-hint' });
    this.count = h('div', { class: 'mic-count' });
    this.hud = h(
      'div',
      { class: 'mic-hud' },
      h('div', { class: 'mic-top' }, h('span', { class: 'mic-title', html: `${icon('mic', 15)} <b>Grabar voz</b>` }), this.deviceSel, h('div', { class: 'mic-level', title: 'Nivel del micrófono' }, this.levelFill), h('button', { class: 'icon-btn', title: 'Cerrar', html: icon('x', 16), onclick: () => this.close() })),
      h('div', { class: 'mic-center' }, this.bigBtn, this.hint),
      h(
        'div',
        { class: 'mic-opts' },
        check('Cuenta atrás de 3 s', 'countdown'),
        check('Silenciar el proyecto mientras grabo', 'muteProject', 'Evita que el micrófono capte el sonido del video si no usas auriculares'),
        check('Reducir ruido de fondo', 'denoise')
      ),
      this.count
    );
    document.getElementById('viewer-hud').append(this.hud);
  }

  toggle() {
    if (this.recording) this.stop();
    else if (this.open) this.close();
    else this.show();
  }

  async show() {
    engine.pause();
    this.open = true;
    this.hud.classList.add('show');
    setUI({ viewerMode: 'record' });
    this.updateHint();
    await this.initMic();
  }

  close() {
    if (this.recording) return;
    this.open = false;
    this.hud.classList.remove('show');
    this.releaseMic();
    if (state.viewerMode === 'record') setUI({ viewerMode: null });
  }

  updateHint(text) {
    if (text) {
      this.hint.textContent = text;
      return;
    }
    if (this.error) {
      this.hint.textContent = this.error;
      return;
    }
    const fps = state.project.settings.fps;
    this.hint.textContent = this.recording ? '' : `Pulsa para grabar desde ${formatTC(state.playhead, fps)}`;
  }

  releaseMic() {
    try {
      if (this.source) this.source.disconnect();
      if (this.node) {
        this.node.port.onmessage = null;
        this.node.disconnect();
      }
      if (this.sink) this.sink.disconnect();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    } catch {
      /* sin efecto */
    }
    this.source = null;
    this.node = null;
    this.sink = null;
    this.stream = null;
    this.levelFill.style.transform = 'scaleX(0)';
  }

  async initMic(deviceId) {
    this.releaseMic();
    this.error = null;
    this.bigBtn.disabled = true;
    try {
      const ctx = engine.ctx;
      if (ctx.state !== 'running') await ctx.resume();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          autoGainControl: false,
          noiseSuppression: this.opts.denoise,
          channelCount: 1,
        },
      });
      if (!this.open) {
        this.releaseMic();
        return;
      }
      if (!this.workletReady) {
        await ctx.audioWorklet.addModule('js/audio/recorder-worklet.js');
        this.workletReady = true;
      }
      this.source = ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(ctx, 'nano-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.node.port.onmessage = (e) => this.onWorklet(e.data);

      const track = this.stream.getAudioTracks()[0];
      const settings = track ? track.getSettings() : {};
      this.inputLatency = Number(settings.latency) || 0.01;
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      this.deviceSel.replaceChildren(...devices.map((d, i) => h('option', { value: d.deviceId }, d.label || `Micrófono ${i + 1}`)));
      if (settings.deviceId) this.deviceSel.value = settings.deviceId;
      this.bigBtn.disabled = false;
      this.updateHint();
    } catch (e) {
      console.warn('Micrófono', e);
      this.error = 'No se pudo acceder al micrófono. Comprueba que está conectado y que Windows permite su uso (Configuración → Privacidad → Micrófono).';
      this.updateHint();
    }
  }

  onWorklet(msg) {
    if (msg.type === 'level') {
      this.levelFill.style.transform = `scaleX(${Math.min(1, Math.pow(msg.peak, 0.5)).toFixed(3)})`;
      this.levelFill.classList.toggle('hot', msg.peak > 0.95);
    } else if (msg.type === 'data' && this.recording) {
      this.chunks.push(msg.samples);
      const s = msg.samples;
      const step = SR / LIVE_PEAKS;
      for (let i = 0; i < s.length; i++) {
        const a = Math.abs(s[i]);
        if (a > this.peakAcc) this.peakAcc = a;
        if (++this.peakCount >= step) {
          this.live.peaks.push(this.peakAcc);
          this.peakAcc = 0;
          this.peakCount = 0;
        }
      }
      this.samples += s.length;
      this.live.duration = this.samples / SR;
      this.timeline.draw();
    } else if (msg.type === 'stopped' && this.onStopped) {
      this.onStopped();
    }
  }

  countdown(seconds) {
    return new Promise((resolve) => {
      let n = seconds;
      this.count.classList.add('show');
      const tick = () => {
        if (!this.open || this.abort) {
          this.count.classList.remove('show');
          resolve(false);
          return;
        }
        if (n <= 0) {
          this.count.classList.remove('show');
          resolve(true);
          return;
        }
        this.count.textContent = String(n--);
        this.countTimer = setTimeout(tick, 1000);
      };
      tick();
    });
  }

  async start() {
    if (this.recording || this.busy || !this.node) return;
    const p = state.project;
    this.busy = true;
    this.abort = false;
    engine.pause();
    this.startT = M.snapFrame(p, state.playhead);
    this.bigBtn.classList.add('arming');
    if (this.opts.countdown) {
      this.updateHint('Prepárate…');
      const ok = await this.countdown(3);
      if (!ok) {
        this.busy = false;
        this.bigBtn.classList.remove('arming');
        this.updateHint();
        return;
      }
    }
    this.bigBtn.classList.remove('arming');

    // Pista de destino: una de audio sin nada desde el cursor en adelante, o una nueva.
    beginTxn('Grabar voz');
    let track = M.audioTracks(p).find((t) => !t.locked && !p.clips.some((c) => c.trackId === t.id && M.clipEnd(c) > this.startT + 1e-4));
    if (!track) {
      track = M.addTrack(p, 'audio');
      touch({ label: 'pista' });
    }
    this.trackId = track.id;
    this.chunks = [];
    this.samples = 0;
    this.peakAcc = 0;
    this.peakCount = 0;
    this.live = { trackId: track.id, start: this.startT, duration: 0, peaks: [], peaksPerSecond: LIVE_PEAKS };
    this.timeline.live = this.live;

    this.recording = true;
    this.busy = false;
    this.hud.classList.add('recording');
    this.bigBtn.firstChild.innerHTML = icon('stop', 30);
    if (this.opts.muteProject) engine.setOutputMuted(true);
    this.node.port.postMessage({ cmd: 'start' });
    this.startNow = performance.now();
    if (M.projectDuration(p) > this.startT + 0.05) engine.play();
    this.loop();
  }

  loop() {
    if (!this.recording) return;
    const fps = state.project.settings.fps;
    const elapsed = (performance.now() - this.startNow) / 1000;
    // Si el proyecto ya terminó, el cursor sigue avanzando con la grabación.
    if (!engine.playing) setPlayhead(this.startT + elapsed);
    this.updateHint(`Grabando ${formatTC(elapsed, fps)} · pulsa para detener`);
    requestAnimationFrame(() => this.loop());
  }

  async stop() {
    if (!this.recording) return;
    this.recording = false;
    engine.pause();
    engine.setOutputMuted(false);
    this.hud.classList.remove('recording');
    this.bigBtn.firstChild.innerHTML = icon('mic', 34);
    this.bigBtn.disabled = true;
    this.updateHint('Guardando la grabación…');

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 800);
      this.onStopped = () => {
        clearTimeout(timer);
        resolve();
      };
      this.node.port.postMessage({ cmd: 'stop' });
    });
    this.onStopped = null;
    this.timeline.live = null;

    try {
      if (this.samples < SR * 0.25) {
        cancelTxn();
        toast('La grabación fue demasiado corta');
        return;
      }
      const pcm = new Float32Array(this.samples);
      let off = 0;
      for (const c of this.chunks) {
        pcm.set(c, off);
        off += c.length;
      }
      this.chunks = [];
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `Voz ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
      const file = await window.nano.saveRecording(encodeWav(pcm, SR), name);
      const [media] = await importPaths([file]);
      if (!media) throw new Error('No se pudo leer la grabación');

      const p = state.project;
      const ctx = engine.ctx;
      // Compensa la latencia de entrada/salida para que la voz quede alineada con lo que se veía.
      const comp = clamp((ctx.outputLatency || 0) + (ctx.baseLatency || 0) + (this.inputLatency || 0), 0, 0.25);
      let track = M.trackById(p, this.trackId);
      const clip = M.makeMediaClip(p, media, this.trackId, this.startT);
      clip.name = name;
      clip.in = Math.min(comp, Math.max(0, media.duration - 0.1));
      clip.duration = Math.max(M.frameDur(p), M.floorFrame(p, media.duration - clip.in));
      if (!track || !M.rangeIsFree(p, track.id, clip.start, clip.duration)) {
        track = M.findFreeTrack(p, 'audio', clip.start, clip.duration) || M.addTrack(p, 'audio');
        clip.trackId = track.id;
      }
      p.clips.push(clip);
      touch({ label: 'grabación' });
      endTxn();
      select(clip.id);
      toast('Grabación añadida a la línea temporal', 'ok');
    } catch (e) {
      cancelTxn();
      toast(`No se pudo guardar la grabación: ${cleanError(e)}`, 'error');
    } finally {
      this.bigBtn.disabled = false;
      this.timeline.draw();
      this.updateHint();
    }
  }
}
