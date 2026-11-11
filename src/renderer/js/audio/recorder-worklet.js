// Procesador de audio que captura el micrófono sin compresión y envía bloques PCM a la interfaz.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.started = false;
    this.buf = new Float32Array(4800);
    this.n = 0;
    this.peak = 0;
    this.blocks = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') {
        this.n = 0;
        this.started = false;
        this.recording = true;
      } else if (e.data.cmd === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  flush() {
    if (this.n > 0) {
      this.port.postMessage({ type: 'data', samples: this.buf.slice(0, this.n) });
      this.n = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (!ch0) return true;
    const ch1 = input[1];
    for (let i = 0; i < ch0.length; i++) {
      const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.recording) {
        this.buf[this.n++] = v;
        if (this.n === this.buf.length) this.flush();
      }
    }
    if (this.recording && !this.started) {
      this.started = true;
      this.port.postMessage({ type: 'started', time: currentTime });
    }
    if (++this.blocks >= 6) {
      this.port.postMessage({ type: 'level', peak: this.peak });
      this.peak = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor('nano-recorder', RecorderProcessor);
