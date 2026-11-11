// Maquetación y dibujo de textos en un lienzo 2D (se usa igual en vista previa y exportación).

import { rgba } from '../core/util.js';

let measureCtx = null;
const layoutCache = new Map();

function getMeasureCtx() {
  if (!measureCtx) measureCtx = new OffscreenCanvas(8, 8).getContext('2d');
  return measureCtx;
}

export function fontString(text, size = text.size) {
  const family = String(text.font || 'Segoe UI').replace(/["\\]/g, '');
  return `${text.italic ? 'italic ' : ''}${text.weight || 400} ${size}px "${family}", "Segoe UI", system-ui, sans-serif`;
}

/**
 * Calcula líneas y dimensiones del texto en píxeles de proyecto.
 * width/height incluyen el margen necesario para borde, sombra y fondo.
 */
export function layoutText(text, projectWidth) {
  const key = JSON.stringify([
    text.content, text.font, text.size, text.weight, text.italic, text.uppercase, text.lineHeight, text.spacing, text.wrap,
    text.strokeWidth, text.shadow, text.shadowBlur, text.shadowX, text.shadowY, text.bg, text.bgPadding, projectWidth,
  ]);
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const ctx = getMeasureCtx();
  ctx.font = fontString(text);
  ctx.letterSpacing = `${text.spacing || 0}px`;
  const maxW = text.wrap > 0 ? text.wrap * projectWidth : Infinity;
  const content = String(text.content ?? '');
  const paragraphs = (text.uppercase ? content.toUpperCase() : content).split('\n');
  const lines = [];
  for (const para of paragraphs) {
    if (ctx.measureText(para).width <= maxW) {
      lines.push(para);
      continue;
    }
    let cur = '';
    for (const token of para.split(/(\s+)/)) {
      const test = cur + token;
      if (cur.trim() && ctx.measureText(test.trimEnd()).width > maxW) {
        lines.push(cur.trimEnd());
        cur = token.trimStart();
      } else cur = test;
    }
    lines.push(cur.trimEnd());
  }
  const widths = lines.map((l) => ctx.measureText(l).width);
  const textW = Math.max(1, ...widths);
  const lineH = text.size * (text.lineHeight || 1.15);
  const textH = Math.max(1, lineH * lines.length);
  const padBg = text.bg ? Math.max(0, text.bgPadding) : 0;
  const padFx = Math.max(
    (text.strokeWidth || 0) / 2 + 2,
    text.shadow ? text.shadowBlur * 1.6 + Math.max(Math.abs(text.shadowX), Math.abs(text.shadowY)) : 0
  );
  const pad = Math.ceil(padBg + padFx + 4);
  const layout = { lines, widths, textW, textH, lineH, pad, padBg, width: textW + pad * 2, height: textH + pad * 2 };

  if (layoutCache.size > 400) layoutCache.clear();
  layoutCache.set(key, layout);
  return layout;
}

/** Dibuja el texto a `pixelScale` píxeles por píxel de proyecto. Devuelve { canvas, layout }. */
export function renderText(text, projectWidth, pixelScale) {
  const L = layoutText(text, projectWidth);
  let s = pixelScale;
  const MAX = 8192;
  if (L.width * s > MAX) s = MAX / L.width;
  if (L.height * s > MAX) s = MAX / L.height;
  const cw = Math.max(2, Math.ceil(L.width * s));
  const ch = Math.max(2, Math.ceil(L.height * s));
  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  ctx.scale(cw / L.width, ch / L.height);

  if (text.bg) {
    const bw = L.textW + L.padBg * 2;
    const bh = L.textH + L.padBg * 2;
    ctx.fillStyle = rgba(text.bgColor, text.bgOpacity);
    ctx.beginPath();
    ctx.roundRect(L.pad - L.padBg, L.pad - L.padBg, bw, bh, Math.min(text.bgRadius, bh / 2, bw / 2));
    ctx.fill();
  }

  ctx.font = fontString(text);
  ctx.letterSpacing = `${text.spacing || 0}px`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  const pos = (i) => {
    const w = L.widths[i];
    const x = text.align === 'left' ? L.pad : text.align === 'right' ? L.pad + L.textW - w : L.pad + (L.textW - w) / 2;
    return [x, L.pad + L.lineH * (i + 0.5)];
  };
  const shadowOn = () => {
    if (!text.shadow) return;
    // Sombra y desplazamiento no siguen la transformación del lienzo: se escalan a mano.
    ctx.shadowColor = rgba(text.shadowColor, text.shadowOpacity);
    ctx.shadowBlur = text.shadowBlur * s;
    ctx.shadowOffsetX = text.shadowX * s;
    ctx.shadowOffsetY = text.shadowY * s;
  };
  const shadowOff = () => {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  };

  if (text.strokeWidth > 0) {
    ctx.lineWidth = text.strokeWidth;
    ctx.strokeStyle = text.strokeColor;
    shadowOn();
    L.lines.forEach((line, i) => ctx.strokeText(line, ...pos(i)));
    shadowOff();
    ctx.fillStyle = text.color;
    L.lines.forEach((line, i) => ctx.fillText(line, ...pos(i)));
  } else {
    ctx.fillStyle = text.color;
    shadowOn();
    L.lines.forEach((line, i) => ctx.fillText(line, ...pos(i)));
    shadowOff();
  }
  return { canvas, layout: L };
}
