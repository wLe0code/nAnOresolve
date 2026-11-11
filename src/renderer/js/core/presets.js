// Catálogos: plantillas de color, transiciones, efectos, estilos de texto y formatos.

// ------------------------------------------------------------------ color ----

export const COLOR_DEFAULT = {
  preset: 'none',
  intensity: 1,
  exposure: 0, // -2..2 (pasos)
  contrast: 0, // -1..1
  saturation: 1, // 0..2
  temperature: 0, // -1 frío .. 1 cálido
  tint: 0, // -1 verde .. 1 magenta
  highlights: 0, // -1..1
  shadows: 0, // -1..1
  fade: 0, // 0..1 (negros lavados)
  hue: 0, // grados
  wash: [1, 1, 1], // multiplicador de color
  shadowTint: [0, 0, 0], // desplazamiento RGB en sombras
  highlightTint: [0, 0, 0], // desplazamiento RGB en luces
};

export const COLOR_PRESETS = [
  { id: 'none', name: 'Original', params: {} },
  { id: 'bw', name: 'Blanco y negro', params: { saturation: 0, contrast: 0.12 } },
  { id: 'noir', name: 'Cine negro', params: { saturation: 0, contrast: 0.45, exposure: -0.1, shadows: -0.15, fade: 0.05 } },
  {
    id: 'desert',
    name: 'Amarillo desierto',
    hint: 'El tono amarillento de México en Breaking Bad',
    params: { temperature: 0.5, tint: -0.22, saturation: 0.82, contrast: 0.2, exposure: 0.1, wash: [1.04, 0.95, 0.62], highlightTint: [0.05, 0.03, -0.06], shadowTint: [0.02, 0.012, -0.03] },
  },
  { id: 'tealorange', name: 'Teal & Orange', params: { contrast: 0.16, saturation: 1.12, shadowTint: [-0.055, 0.02, 0.065], highlightTint: [0.065, 0.02, -0.055] } },
  { id: 'cinematic', name: 'Cinematográfico', params: { contrast: 0.2, saturation: 0.9, highlights: -0.1, shadows: -0.08, shadowTint: [-0.02, 0, 0.035], highlightTint: [0.03, 0.015, -0.02], fade: 0.06 } },
  { id: 'warm', name: 'Cálido', params: { temperature: 0.38, saturation: 1.08, contrast: 0.05 } },
  { id: 'cold', name: 'Frío', params: { temperature: -0.4, saturation: 0.95, contrast: 0.06 } },
  { id: 'vivid', name: 'Vívido', params: { saturation: 1.42, contrast: 0.18, exposure: 0.05 } },
  { id: 'vintage', name: 'Vintage', params: { saturation: 0.75, fade: 0.45, temperature: 0.2, contrast: -0.05, shadowTint: [0, 0, 0.03], highlightTint: [0.04, 0.02, -0.03] } },
  { id: 'sepia', name: 'Sepia', params: { saturation: 0, wash: [1.08, 0.95, 0.72], contrast: 0.08, fade: 0.1 } },
  { id: 'matte', name: 'Mate', params: { fade: 0.6, saturation: 0.85, contrast: -0.08 } },
  { id: 'matrix', name: 'Código verde', params: { wash: [0.82, 1.06, 0.8], saturation: 0.8, contrast: 0.22, shadowTint: [-0.02, 0.04, -0.02] } },
  { id: 'sunset', name: 'Atardecer', params: { temperature: 0.4, tint: 0.2, saturation: 1.2, highlightTint: [0.07, 0, -0.04], shadowTint: [0.03, -0.01, 0.04] } },
  { id: 'night', name: 'Noche azul', params: { temperature: -0.5, exposure: -0.25, saturation: 0.75, contrast: 0.15, shadowTint: [-0.03, 0, 0.06] } },
  { id: 'bleach', name: 'Bleach bypass', params: { saturation: 0.45, contrast: 0.4, exposure: 0.05 } },
];

export function colorFromPreset(id, intensity = 1) {
  const p = COLOR_PRESETS.find((x) => x.id === id) || COLOR_PRESETS[0];
  return { ...COLOR_DEFAULT, ...JSON.parse(JSON.stringify(p.params)), preset: p.id, intensity };
}

export function isNeutralColor(c) {
  if (!c) return true;
  const d = COLOR_DEFAULT;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  return (
    c.intensity === 0 ||
    (c.exposure === 0 && c.contrast === 0 && c.saturation === 1 && c.temperature === 0 && c.tint === 0 && c.highlights === 0 && c.shadows === 0 && c.fade === 0 && c.hue === 0 && same(c.wash, d.wash) && same(c.shadowTint, d.shadowTint) && same(c.highlightTint, d.highlightTint))
  );
}

// ------------------------------------------------------------ transiciones ----

export const TRANSITIONS = [
  { id: 'dissolve', name: 'Disolución cruzada', code: 0 },
  { id: 'dipblack', name: 'Fundido a negro', code: 1 },
  { id: 'dipwhite', name: 'Fundido a blanco', code: 2 },
  { id: 'wipe-right', name: 'Barrido a la derecha', code: 3 },
  { id: 'wipe-left', name: 'Barrido a la izquierda', code: 4 },
  { id: 'wipe-down', name: 'Barrido hacia abajo', code: 5 },
  { id: 'wipe-up', name: 'Barrido hacia arriba', code: 6 },
  { id: 'push-left', name: 'Empujar a la izquierda', code: 7 },
  { id: 'push-right', name: 'Empujar a la derecha', code: 8 },
  { id: 'push-up', name: 'Empujar hacia arriba', code: 9 },
  { id: 'push-down', name: 'Empujar hacia abajo', code: 10 },
  { id: 'zoom', name: 'Zoom', code: 11 },
  { id: 'iris', name: 'Iris circular', code: 12 },
  { id: 'blur', name: 'Desenfoque', code: 13 },
];

export const AUDIO_TRANSITIONS = [
  { id: 'xfade', name: 'Fundido cruzado', hint: 'Potencia constante (+3 dB)' },
  { id: 'xfade-linear', name: 'Fundido cruzado lineal', hint: 'Ganancia lineal (0 dB)' },
];

export const DEFAULT_TRANSITION_DURATION = 1;
export const transitionById = (id) => TRANSITIONS.find((t) => t.id === id) || TRANSITIONS[0];

// ----------------------------------------------------------------- efectos ----

export const VIDEO_EFFECTS = [
  { id: 'blur', name: 'Desenfoque', amount: 25 },
  { id: 'sharpen', name: 'Nitidez', amount: 50 },
  { id: 'vignette', name: 'Viñeta', amount: 55 },
  { id: 'grain', name: 'Grano de película', amount: 40 },
  { id: 'chroma', name: 'Aberración cromática', amount: 35 },
  { id: 'mosaic', name: 'Mosaico', amount: 30 },
  { id: 'mirror', name: 'Espejo', amount: null },
  { id: 'flip', name: 'Voltear vertical', amount: null },
  { id: 'invert', name: 'Invertir colores', amount: null },
];

export const AUDIO_EFFECTS = [
  { id: 'voice', name: 'Voz clara', hint: 'Limpia graves, realza presencia y nivela' },
  { id: 'bass', name: 'Realce de graves', hint: 'Más cuerpo en bajas frecuencias' },
  { id: 'treble', name: 'Brillo', hint: 'Realza agudos' },
  { id: 'phone', name: 'Teléfono', hint: 'Sonido de llamada' },
  { id: 'muffled', name: 'Detrás de la pared', hint: 'Sonido apagado' },
  { id: 'echo', name: 'Eco', hint: 'Repeticiones que se desvanecen' },
];

export const effectById = (id) => VIDEO_EFFECTS.find((e) => e.id === id);
export const audioEffectById = (id) => AUDIO_EFFECTS.find((e) => e.id === id);

/** Tamaño de bloque del pixelado como fracción del lado menor del fotograma. */
export const censorBlock = (strength) => 0.008 + (strength / 100) * 0.052;
/** Radio del difuminado como fracción del lado menor del fotograma. */
export const censorBlur = (strength) => 0.01 + (strength / 100) * 0.07;

// ------------------------------------------------------------------- texto ----

export const TEXT_DEFAULT = {
  content: 'Tu texto aquí',
  font: 'Segoe UI',
  size: 90,
  weight: 700,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  spacing: 0,
  wrap: 0.9, // ancho máximo como fracción del ancho del proyecto
  strokeColor: '#000000',
  strokeWidth: 0,
  shadow: true,
  shadowColor: '#000000',
  shadowOpacity: 0.6,
  shadowBlur: 12,
  shadowX: 0,
  shadowY: 4,
  bg: false,
  bgColor: '#000000',
  bgOpacity: 0.6,
  bgPadding: 24,
  bgRadius: 12,
};

// `pos` es la posición inicial como fracción del tamaño del proyecto (0 = centro).
export const TEXT_PRESETS = [
  { id: 'title', name: 'Título', text: { content: 'TÍTULO', size: 150, weight: 800 }, pos: [0, 0] },
  { id: 'subtitle', name: 'Subtítulo', text: { content: 'Subtítulo del video', size: 60, weight: 600, bg: true, bgOpacity: 0.55, shadow: false }, pos: [0, 0.37] },
  { id: 'lower', name: 'Tercio inferior', text: { content: 'Nombre Apellido', size: 54, weight: 700, align: 'left', bg: true, bgColor: '#7c5cff', bgOpacity: 1, bgRadius: 6, shadow: false }, pos: [-0.27, 0.33] },
  { id: 'caption', name: 'Leyenda', text: { content: 'Leyenda del video', size: 52, weight: 600, strokeWidth: 8, shadow: false }, pos: [0, 0.4] },
  { id: 'impact', name: 'Impacto', text: { content: 'TEXTO IMPACTO', font: 'Impact', size: 130, weight: 400, strokeWidth: 12, uppercase: true, shadow: false }, pos: [0, -0.34] },
  { id: 'neon', name: 'Neón', text: { content: 'Neón', size: 130, weight: 700, color: '#9bfbff', shadowColor: '#00e5ff', shadowBlur: 44, shadowY: 0, shadowOpacity: 1 }, pos: [0, 0] },
  { id: 'minimal', name: 'Minimalista', text: { content: 'texto minimalista', size: 56, weight: 300, spacing: 10, shadow: false }, pos: [0, 0] },
  { id: 'label', name: 'Etiqueta', text: { content: 'ETIQUETA', size: 40, weight: 800, color: '#15130a', bg: true, bgColor: '#ffd84a', bgOpacity: 1, bgRadius: 999, bgPadding: 22, shadow: false, spacing: 3 }, pos: [-0.36, -0.39] },
];

export const FALLBACK_FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Impact', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

// -------------------------------------------------------------------- zoom ----

export const ZOOM_MODES = [
  { id: 'hold', name: 'Acercar y volver', hint: 'Se acerca al inicio, mantiene y vuelve al final' },
  { id: 'in', name: 'Acercamiento continuo', hint: 'Crece poco a poco del inicio al final' },
  { id: 'out', name: 'Alejamiento continuo', hint: 'Empieza acercado y se abre hasta el final' },
];

export const ZOOM_DEFAULT = { mode: 'hold', scale: 1.6, cx: 0.5, cy: 0.5, ramp: 0.45, curve: 'ease' };

// ------------------------------------------------------------- exportación ----

export const EXPORT_FORMATS = [
  { id: 'mp4-h264', name: 'MP4 · H.264', ext: 'mp4', hint: 'Compatible con todo. Recomendado.' },
  { id: 'mp4-h265', name: 'MP4 · H.265 (HEVC)', ext: 'mp4', hint: 'Misma calidad en archivos más pequeños.' },
  { id: 'mov-prores', name: 'MOV · ProRes 422', ext: 'mov', hint: 'Máster de edición, archivos grandes.' },
  { id: 'mkv-h264', name: 'MKV · H.264 + FLAC', ext: 'mkv', hint: 'Video H.264 con audio sin pérdidas.' },
  { id: 'webm-vp9', name: 'WebM · VP9', ext: 'webm', hint: 'Formato abierto para la web.' },
  { id: 'avi-mpeg4', name: 'AVI · MPEG-4', ext: 'avi', hint: 'Para reproductores antiguos.' },
  { id: 'mp3', name: 'Solo audio · MP3', ext: 'mp3', audioOnly: true, hint: 'Exporta únicamente la mezcla de audio.' },
  { id: 'wav', name: 'Solo audio · WAV', ext: 'wav', audioOnly: true, hint: 'Audio sin compresión.' },
];

export const EXPORT_QUALITIES = [
  { id: 'max', name: 'Máxima', hint: 'Visualmente sin pérdidas' },
  { id: 'high', name: 'Alta', hint: 'Excelente calidad (recomendada)' },
  { id: 'medium', name: 'Media', hint: 'Buen equilibrio de tamaño' },
  { id: 'low', name: 'Ligera', hint: 'Archivos pequeños' },
];

export const RESOLUTIONS = [
  { id: '3840x2160', name: '4K UHD · 3840×2160', w: 3840, h: 2160 },
  { id: '2560x1440', name: '2K QHD · 2560×1440', w: 2560, h: 1440 },
  { id: '1920x1080', name: 'Full HD · 1920×1080', w: 1920, h: 1080 },
  { id: '1280x720', name: 'HD · 1280×720', w: 1280, h: 720 },
  { id: '1080x1920', name: 'Vertical · 1080×1920', w: 1080, h: 1920 },
  { id: '1080x1350', name: 'Retrato 4:5 · 1080×1350', w: 1080, h: 1350 },
  { id: '1080x1080', name: 'Cuadrado · 1080×1080', w: 1080, h: 1080 },
];

export const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
