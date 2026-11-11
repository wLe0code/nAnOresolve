// Compositor WebGL2: dibuja una escena (capas, efectos, color, censura y transiciones).
// La vista previa lo usa sobre el lienzo visible y la exportación sobre un framebuffer.

import { VERT_LAYER, FRAG_LAYER, VERT_QUAD, FRAG_TRANSITION, FRAG_YUV_IN, FRAG_NV12_OUT, MAX_CENSORS } from './shaders.js';
import { mat, hexToRgb, clamp } from '../core/util.js';
import { layerMatrix } from './scene.js';
import { renderText } from './textrender.js';
import { COLOR_DEFAULT, isNeutralColor, censorBlock, censorBlur, transitionById } from '../core/presets.js';

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Error al compilar shader: ${log}`);
  }
  return sh;
}

function makeProgram(gl, vs, fs) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Error al enlazar shaders: ${gl.getProgramInfoLog(prog)}`);
  const u = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i);
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u };
}

// Coeficientes YUV -> RGB por matriz de color: [Cr->R, Cb->G, Cr->G, Cb->B].
export const YUV_COEF = {
  bt709: [1.5748, 0.1873, 0.4681, 1.8556],
  bt601: [1.402, 0.344136, 0.714136, 1.772],
  bt2020: [1.4746, 0.16455, 0.57135, 1.8814],
};

const quantizeScale = (s) => clamp(Math.pow(2, Math.ceil(Math.log2(Math.max(s, 0.01)) * 2) / 2), 0.25, 8);

export class Compositor {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: !!opts.preserve,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('Este equipo no admite WebGL2, necesario para la vista previa.');
    this.gl = gl;
    this.textures = new Map();
    this.fbos = new Map();
    this.frame = 0;
    this.lost = false;
    this.rectBuf = new Float32Array(MAX_CENSORS * 4);
    this.paramBuf = new Float32Array(MAX_CENSORS * 4);

    this.layerProg = makeProgram(gl, VERT_LAYER, FRAG_LAYER);
    this.transProg = makeProgram(gl, VERT_QUAD, FRAG_TRANSITION);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');

    canvas.addEventListener?.('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      if (opts.onLost) opts.onLost();
    });
  }

  setSize(w, h) {
    w = Math.max(2, Math.round(w));
    h = Math.max(2, Math.round(h));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  createTexture(mip = true) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mip && this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    return tex;
  }

  fbo(name, w, h) {
    const gl = this.gl;
    let f = this.fbos.get(name);
    if (!f) {
      f = { fbo: gl.createFramebuffer(), tex: this.createTexture(true), w: 0, h: 0 };
      this.fbos.set(name, f);
    }
    if (f.w !== w || f.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, f.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
      f.w = w;
      f.h = h;
    }
    return f;
  }

  /**
   * Dibuja la escena.
   * opts.fbo: nombre del framebuffer de destino (si falta, se dibuja en el lienzo).
   * opts.width / opts.height: tamaño de salida cuando se usa un framebuffer.
   */
  render(scene, provider, opts = {}) {
    if (this.lost) return;
    const gl = this.gl;
    this.frame++;
    const W = opts.fbo ? opts.width || this.canvas.width : this.canvas.width;
    const H = opts.fbo ? opts.height || this.canvas.height : this.canvas.height;
    const target = opts.fbo ? this.fbo(opts.fbo, W, H) : null;
    const flipY = !!opts.fbo; // con readPixels las filas salen de arriba abajo
    const bind = () => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.viewport(0, 0, W, H);
    };

    bind();
    const [r, g, b] = hexToRgb(scene.background);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);

    for (const item of scene.items) {
      if (item.layer) {
        this.drawLayer(item.layer, scene, provider, W, H, flipY);
        continue;
      }
      const tr = item.transition;
      const code = transitionById(tr.type).code;
      const A = this.fbo('trA', W, H);
      const B = this.fbo('trB', W, H);
      for (const [side, f] of [[tr.a, A], [tr.b, B]]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.viewport(0, 0, W, H);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (side) this.drawLayer(side, scene, provider, W, H, false);
        if (code === 13) {
          gl.bindTexture(gl.TEXTURE_2D, f.tex);
          gl.generateMipmap(gl.TEXTURE_2D);
        }
      }
      bind();
      const p = this.transProg;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, B.tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform1i(p.u.uA, 0);
      gl.uniform1i(p.u.uB, 1);
      gl.uniform1f(p.u.uP, clamp(tr.p, 0, 1));
      gl.uniform1i(p.u.uType, code);
      gl.uniform1f(p.u.uAspect, W / H);
      gl.uniform1f(p.u.uFlip, flipY ? -1 : 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (this.frame % 120 === 0) this.collect();
  }

  drawLayer(layer, scene, provider, W, H, flipY) {
    const gl = this.gl;
    const src = layer.kind === 'text' ? this.textSource(layer, scene, W) : this.mediaSource(layer, provider);
    if (!src || !src.w) return;
    const p = this.layerProg;
    const u = p.u;
    gl.useProgram(p.prog);

    const m = layerMatrix(layer, scene.width, scene.height);
    const sx = 2 / scene.width;
    const sy = 2 / scene.height;
    const f = mat.mul(flipY ? [sx, 0, 0, sy, -1, -1] : [sx, 0, 0, -sy, -1, 1], m);
    gl.uniformMatrix3fv(u.uMatrix, false, [f[0], f[1], 0, f[2], f[3], 0, f[4], f[5], 1]);

    const k = W / scene.width;
    const lw = Math.hypot(m[0], m[1]) * k;
    const lh = Math.hypot(m[2], m[3]) * k;
    gl.uniform2f(u.uPad, 1.5 / Math.max(lw, 1), 1.5 / Math.max(lh, 1));

    const minSide = Math.min(src.w, src.h);
    gl.uniform2f(u.uTexSize, src.w, src.h);
    gl.uniform2f(u.uUnit, minSide / src.w, minSide / src.h);
    gl.uniform2f(u.uRef, minSide / src.w / 1080, minSide / src.h / 1080);
    gl.uniform1f(u.uOpacity, layer.opacity);
    const crop = layer.crop || [0, 0, 0, 0];
    gl.uniform4f(u.uCrop, crop[0], crop[1], crop[2], crop[3]);
    gl.uniform1f(u.uStraight, src.straight ? 1 : 0);
    gl.uniform1f(u.uTime, layer.ts);

    const fx = layer.fx;
    gl.uniform1f(u.uBlur, fx.blur);
    gl.uniform1f(u.uMosaic, fx.mosaic);
    gl.uniform1f(u.uSharpen, fx.sharpen);
    gl.uniform1f(u.uChroma, fx.chroma);
    gl.uniform2f(u.uMirror, fx.mirror, fx.flip);
    gl.uniform1f(u.uInvert, fx.invert);
    gl.uniform1f(u.uVignette, fx.vignette);
    gl.uniform1f(u.uGrain, fx.grain);

    const c = layer.color || COLOR_DEFAULT;
    const neutral = isNeutralColor(layer.color);
    gl.uniform1f(u.uColorMix, neutral ? 0 : clamp(c.intensity, 0, 1));
    if (!neutral) {
      gl.uniform1f(u.uExposure, c.exposure);
      gl.uniform1f(u.uContrast, c.contrast);
      gl.uniform1f(u.uSaturation, c.saturation);
      gl.uniform1f(u.uTemperature, c.temperature);
      gl.uniform1f(u.uTint, c.tint);
      gl.uniform1f(u.uHighlights, c.highlights);
      gl.uniform1f(u.uShadows, c.shadows);
      gl.uniform1f(u.uFade, c.fade);
      gl.uniform1f(u.uHue, (c.hue * Math.PI) / 180);
      gl.uniform3fv(u.uWash, c.wash);
      gl.uniform3fv(u.uShadowTint, c.shadowTint);
      gl.uniform3fv(u.uHighlightTint, c.highlightTint);
    }

    const n = Math.min(MAX_CENSORS, layer.censors.length);
    gl.uniform1i(u.uCensorCount, n);
    if (n > 0) {
      for (let i = 0; i < n; i++) {
        const r = layer.censors[i];
        const blur = r.mode === 'blur';
        this.rectBuf.set([r.x, r.y, Math.max(r.w / 2, 1e-4), Math.max(r.h / 2, 1e-4)], i * 4);
        this.paramBuf.set([blur ? 1 : 0, blur ? censorBlur(r.strength) : censorBlock(r.strength), r.shape === 'ellipse' ? 1 : 0, r.feather || 0], i * 4);
      }
      gl.uniform4fv(u.uCensorRect, this.rectBuf);
      gl.uniform4fv(u.uCensorParam, this.paramBuf);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(u.uTex, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Textura de un medio (video, imagen o fotograma decodificado) entregado por el proveedor. */
  mediaSource(layer, provider) {
    const s = provider.sourceFor(layer);
    if (!s) return null;
    let e = this.textures.get(s.key);
    if (!e) {
      if (!s.ready) return null;
      e = { tex: this.createTexture(true), version: null, w: 0, h: 0 };
      this.textures.set(s.key, e);
    }
    if (s.ready && e.version !== s.version) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      try {
        if (s.data && s.yuv) {
          this.uploadYuv(e, s);
        } else if (s.data) {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          if (s.channels === 3) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, s.width, s.height, 0, gl.RGB, gl.UNSIGNED_BYTE, s.data);
          else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, s.width, s.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, s.data);
        } else {
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, s.el);
        }
        gl.generateMipmap(gl.TEXTURE_2D);
        e.w = s.width;
        e.h = s.height;
        e.version = s.version;
      } catch (err) {
        console.warn('No se pudo subir la textura', err);
      }
    }
    e.used = this.frame;
    e.straight = !!s.data && !!s.straight;
    return e;
  }

  textSource(layer, scene, W) {
    const gl = this.gl;
    let zs = layer.scale;
    for (const z of layer.zooms) zs *= z.s;
    const q = quantizeScale((W / scene.width) * clamp(zs, 1, 4));
    const key = `text:${layer.id}`;
    const sig = `${JSON.stringify(layer.clip.text)}|${q}|${scene.width}`;
    let e = this.textures.get(key);
    if (!e) {
      e = { tex: this.createTexture(true), w: 0, h: 0, sig: '' };
      this.textures.set(key, e);
    }
    if (e.sig !== sig) {
      const { canvas } = renderText(layer.clip.text, scene.width, q);
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      e.w = canvas.width;
      e.h = canvas.height;
      e.sig = sig;
    }
    e.used = this.frame;
    e.straight = false;
    return e;
  }

  // ---------------------------------------------------- YUV (exportación) ----

  yuvPrograms() {
    if (!this.yuvIn) {
      const gl = this.gl;
      this.yuvIn = makeProgram(gl, VERT_QUAD, FRAG_YUV_IN);
      this.nv12Out = makeProgram(gl, VERT_QUAD, FRAG_NV12_OUT);
      this.scratchFbo = gl.createFramebuffer();
      const plane = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.planeY = plane();
      this.planeUV = plane();
    }
  }

  /** Convierte un fotograma NV12 (ancho y alto pares) en la textura RGBA `e.tex`. */
  uploadYuv(e, s) {
    const gl = this.gl;
    this.yuvPrograms();
    const w = s.width;
    const h = s.height;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.planeUV);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, w / 2, h / 2, 0, gl.RG, gl.UNSIGNED_BYTE, s.data, w * h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.planeY);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, s.data, 0);

    if (e.w !== w || e.h !== h || !e.rgba) {
      gl.bindTexture(gl.TEXTURE_2D, e.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      e.rgba = true;
      gl.bindTexture(gl.TEXTURE_2D, this.planeY);
    }
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevView = gl.getParameter(gl.VIEWPORT);
    const blend = gl.isEnabled(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.scratchFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, e.tex, 0);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    const p = this.yuvIn;
    gl.useProgram(p.prog);
    gl.uniform1i(p.u.uY, 0);
    gl.uniform1i(p.u.uUV, 1);
    gl.uniform4fv(p.u.uCoef, YUV_COEF[s.yuv] || YUV_COEF.bt709);
    gl.uniform1f(p.u.uChromaShift, 0.5 / w);
    gl.uniform1f(p.u.uFlip, 1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevView[0], prevView[1], prevView[2], prevView[3]);
    if (blend) gl.enable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, e.tex);
  }

  packTarget(w, h) {
    const gl = this.gl;
    let t = this.pack;
    if (!t) {
      t = this.pack = { fbo: gl.createFramebuffer(), tex: gl.createTexture(), w: 0, h: 0 };
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    }
    if (t.w !== w || t.h !== h) {
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
      t.w = w;
      t.h = h;
    }
    return t;
  }

  /** ¿Puede esta tarjeta entregar el fotograma final ya convertido a NV12? */
  supportsNV12() {
    if (this.nv12Ok === undefined) {
      const gl = this.gl;
      try {
        this.yuvPrograms();
        const t = this.packTarget(4, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        this.nv12Ok =
          gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE &&
          gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RED &&
          gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_BYTE;
      } catch {
        this.nv12Ok = false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    return this.nv12Ok;
  }

  /** Lee un framebuffer ya compuesto como NV12 (ancho × alto × 1,5 bytes, filas de arriba abajo). */
  readNV12(name, out) {
    const gl = this.gl;
    const f = this.fbos.get(name);
    if (!f) return null;
    const t = this.packTarget(f.w, f.h + f.h / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.disable(gl.BLEND);
    const p = this.nv12Out;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.uniform1i(p.u.uSrc, 0);
    gl.uniform1i(p.u.uH, f.h);
    gl.uniform1f(p.u.uFlip, 1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RED, gl.UNSIGNED_BYTE, out);
    gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  /** Lee el contenido de un framebuffer (RGBA, filas de arriba abajo). */
  readFbo(name, out) {
    const gl = this.gl;
    const f = this.fbos.get(name);
    if (!f) return null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
    gl.readPixels(0, 0, f.w, f.h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  dropTexture(key) {
    const e = this.textures.get(key);
    if (!e) return;
    this.gl.deleteTexture(e.tex);
    this.textures.delete(key);
  }

  /** Libera texturas que llevan tiempo sin usarse. */
  collect() {
    for (const [key, e] of this.textures) {
      if (e.used !== undefined && e.used < this.frame - 600) this.dropTexture(key);
    }
  }

  dispose() {
    const gl = this.gl;
    for (const key of [...this.textures.keys()]) this.dropTexture(key);
    for (const f of this.fbos.values()) {
      gl.deleteFramebuffer(f.fbo);
      gl.deleteTexture(f.tex);
    }
    this.fbos.clear();
    if (this.pack) {
      gl.deleteFramebuffer(this.pack.fbo);
      gl.deleteTexture(this.pack.tex);
    }
    if (this.scratchFbo) {
      gl.deleteFramebuffer(this.scratchFbo);
      gl.deleteTexture(this.planeY);
      gl.deleteTexture(this.planeUV);
    }
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  }
}
