// Cadenas de audio compartidas por la vista previa (AudioContext) y la exportación (OfflineAudioContext).

/** Crea la cadena de un efecto de audio. Devuelve { input, output }. */
export function buildFx(ctx, fxId) {
  const input = ctx.createGain();
  const biquad = (type, freq, gainDb, q) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (gainDb !== undefined) f.gain.value = gainDb;
    if (q !== undefined) f.Q.value = q;
    return f;
  };
  const gain = (v) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const chain = (...nodes) => {
    let prev = input;
    for (const n of nodes) {
      prev.connect(n);
      prev = n;
    }
    return prev;
  };

  let output = input;
  switch (fxId) {
    case 'voice': {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.knee.value = 12;
      comp.ratio.value = 3;
      comp.attack.value = 0.004;
      comp.release.value = 0.2;
      output = chain(biquad('highpass', 90, undefined, 0.7), biquad('peaking', 3200, 4, 1), biquad('highshelf', 9000, 2.5), comp, gain(1.15));
      break;
    }
    case 'bass':
      output = chain(biquad('lowshelf', 130, 8), gain(0.85));
      break;
    case 'treble':
      output = chain(biquad('highshelf', 6000, 7), gain(0.9));
      break;
    case 'phone':
      output = chain(biquad('highpass', 400, undefined, 0.8), biquad('highpass', 400, undefined, 0.8), biquad('lowpass', 3200, undefined, 0.8), biquad('lowpass', 3200, undefined, 0.8), gain(1.6));
      break;
    case 'muffled':
      output = chain(biquad('lowpass', 650, undefined, 0.7), biquad('lowpass', 900, undefined, 0.7));
      break;
    case 'echo': {
      const out = ctx.createGain();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.28;
      const feedback = gain(0.35);
      const wet = gain(0.55);
      input.connect(out);
      input.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(out);
      output = out;
      break;
    }
    default:
      break;
  }
  return { input, output };
}

let limiterCurve = null;

/** Limitador suave sin memoria: transparente hasta -1.9 dBFS y nunca supera 0 dBFS. */
function softLimiterCurve() {
  if (limiterCurve) return limiterCurve;
  const n = 8193;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const y = ((i / (n - 1)) * 2 - 1) * 2; // la entrada llega atenuada a la mitad: aquí representa ±2
    const a = Math.abs(y);
    const v = a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
    curve[i] = Math.sign(y) * v;
  }
  limiterCurve = curve;
  return curve;
}

/** Bus maestro con limitador. Devuelve { input, output }. */
export function buildMaster(ctx) {
  const input = ctx.createGain();
  const pre = ctx.createGain();
  pre.gain.value = 0.5;
  const shaper = ctx.createWaveShaper();
  shaper.curve = softLimiterCurve();
  shaper.oversample = '2x';
  input.connect(pre);
  pre.connect(shaper);
  return { input, output: shaper };
}

/** Duración extra (s) que hay que renderizar antes de un tramo para que los efectos estén asentados. */
export const FX_PREROLL = 4;
