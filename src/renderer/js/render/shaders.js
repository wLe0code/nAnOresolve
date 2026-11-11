// Shaders GLSL del compositor. La vista previa y la exportación usan exactamente los mismos.

export const MAX_CENSORS = 8;

export const VERT_LAYER = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform mat3 uMatrix;   // coordenadas locales (uv - 0.5) -> espacio de recorte
uniform vec2 uPad;      // margen en uv para suavizar los bordes
out vec2 vUv;
void main() {
  vec2 uv = mix(-uPad, 1.0 + uPad, aPos);
  vUv = uv;
  vec3 p = uMatrix * vec3(uv - 0.5, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const FRAG_LAYER = `#version 300 es
precision highp float;
#define MAXC ${MAX_CENSORS}
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform vec2 uTexSize;    // tamaño en texels
uniform vec2 uUnit;       // uv equivalente a "1 lado menor"
uniform vec2 uRef;        // uv de un píxel de referencia (1/1080 del lado menor)
uniform float uOpacity;
uniform vec4 uCrop;       // recorte de cada borde en uv: izquierda, arriba, derecha, abajo
uniform float uStraight;  // 1 = la textura no está premultiplicada
uniform float uTime;

// Efectos
uniform float uBlur;
uniform float uMosaic;
uniform float uSharpen;
uniform float uChroma;
uniform vec2 uMirror;
uniform float uInvert;
uniform float uVignette;
uniform float uGrain;

// Color
uniform float uColorMix;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform float uTint;
uniform float uHighlights;
uniform float uShadows;
uniform float uFade;
uniform float uHue;
uniform vec3 uWash;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;

// Censura
uniform int uCensorCount;
uniform vec4 uCensorRect[MAXC];   // centro.xy, mitad del tamaño.zw (uv)
uniform vec4 uCensorParam[MAXC];  // modo (0 pixelado, 1 difuminado), fuerza, forma (0 rect, 1 elipse), suavizado

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec2 mapUv(vec2 uv) {
  uv = clamp(uv, 0.0, 1.0);
  if (uMirror.x > 0.5) uv.x = 1.0 - uv.x;
  if (uMirror.y > 0.5) uv.y = 1.0 - uv.y;
  return uv;
}

vec4 texL(vec2 uv, float lod) { return textureLod(uTex, mapUv(uv), lod); }

// Desenfoque de disco apoyado en los mipmaps (radio como fracción del lado menor).
vec4 blurAt(vec2 uv, float radius) {
  float rpx = radius * min(uTexSize.x, uTexSize.y);
  if (rpx < 0.75) return texL(uv, 0.0);
  vec2 r = radius * uUnit;
  float lod = log2(max(1.0, rpx * 0.3));
  vec4 acc = vec4(0.0);
  const int N = 32;
  for (int i = 0; i < N; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / float(N));
    float a = fi * 2.39996323;
    acc += texL(uv + vec2(cos(a), sin(a)) * rr * r, lod);
  }
  return acc / float(N);
}

// Mosaico: cada bloque toma el color medio de su zona (bloque como fracción del lado menor).
vec4 mosaicAt(vec2 uv, float block) {
  vec2 b = max(block * uUnit, 1.0 / uTexSize);
  vec2 cell = (floor(uv / b) + 0.5) * b;
  float bpx = block * min(uTexSize.x, uTexSize.y);
  return texL(cell, log2(max(1.0, bpx)));
}

vec3 hueRotate(vec3 c, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c;
  float cs = cos(a);
  float sn = sin(a);
  yiq = vec3(yiq.x, yiq.y * cs - yiq.z * sn, yiq.y * sn + yiq.z * cs);
  return toRGB * yiq;
}

vec3 grade(vec3 c) {
  c *= exp2(uExposure);
  c *= vec3(1.0 + 0.28 * uTemperature, 1.0, 1.0 - 0.28 * uTemperature);
  c *= vec3(1.0 + 0.14 * uTint, 1.0 - 0.14 * uTint, 1.0 + 0.14 * uTint);
  c = (c - 0.5) * (1.0 + uContrast) + 0.5;
  float l = clamp(dot(c, LUMA), 0.0, 1.0);
  float sw = (1.0 - l) * (1.0 - l);
  float hw = l * l;
  c += uShadows * 0.45 * sw + uHighlights * 0.45 * hw;
  l = dot(c, LUMA);
  c = mix(vec3(l), c, uSaturation);
  if (uHue != 0.0) c = hueRotate(c, uHue);
  c *= uWash;
  l = clamp(dot(c, LUMA), 0.0, 1.0);
  c += uShadowTint * (1.0 - l) * (1.0 - l) + uHighlightTint * l * l;
  c = mix(c, c * 0.78 + 0.13, uFade);
  return clamp(c, 0.0, 1.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 uv = vUv;
  vec2 fw = max(fwidth(uv), vec2(1e-6));
  // Cobertura suavizada del borde de la imagen (o del recorte, si lo hay).
  vec2 cov2 = clamp(min(uv - uCrop.xy, (1.0 - uCrop.zw) - uv) / fw + 0.5, 0.0, 1.0);
  float cov = cov2.x * cov2.y;

  vec4 c = texture(uTex, mapUv(uv));

  if (uChroma > 0.0) {
    vec2 d = (uv - 0.5) * uChroma * 2.0;
    c.r = texture(uTex, mapUv(uv + d)).r;
    c.b = texture(uTex, mapUv(uv - d)).b;
  }
  if (uMosaic > 0.0) c = mosaicAt(uv, uMosaic);
  if (uBlur > 0.0) c = blurAt(uv, uBlur);
  if (uSharpen > 0.0) {
    vec3 n = texture(uTex, mapUv(uv + vec2(0.0, -uRef.y))).rgb + texture(uTex, mapUv(uv + vec2(0.0, uRef.y))).rgb
           + texture(uTex, mapUv(uv + vec2(-uRef.x, 0.0))).rgb + texture(uTex, mapUv(uv + vec2(uRef.x, 0.0))).rgb;
    c.rgb = clamp(c.rgb + (c.rgb * 4.0 - n) * uSharpen, 0.0, 1.0);
  }

  // La censura va después de la nitidez para que ningún detalle original se filtre a la zona tapada.
  for (int i = 0; i < MAXC; i++) {
    if (i >= uCensorCount) break;
    vec4 rc = uCensorRect[i];
    vec4 pm = uCensorParam[i];
    vec2 q = abs(uv - rc.xy) / max(rc.zw, vec2(1e-5));
    float e = pm.z < 0.5 ? max(q.x, q.y) : length(q);
    float m = pm.w > 0.0005 ? clamp((1.0 + pm.w - e) / pm.w, 0.0, 1.0) : step(e, 1.0);
    if (m > 0.0) {
      vec4 cc = pm.x < 0.5 ? mosaicAt(uv, pm.y) : blurAt(uv, pm.y);
      c = mix(c, cc, m);
    }
  }

  if (uStraight > 0.5) c.rgb *= c.a;

  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  if (uColorMix > 0.0) rgb = mix(rgb, grade(rgb), uColorMix);
  if (uInvert > 0.5) rgb = 1.0 - rgb;
  if (uVignette > 0.0) {
    vec2 vd = (uv - 0.5) * 2.0;
    float v = smoothstep(1.35, 0.35, length(vd));
    rgb *= mix(1.0, v, uVignette);
  }
  if (uGrain > 0.0) {
    float g = hash(floor(uv / (uRef * 1.5)) + fract(uTime * 7.31) * 113.0) - 0.5;
    rgb += g * uGrain * 0.35;
  }
  c.rgb = clamp(rgb, 0.0, 1.0) * c.a;

  outColor = c * (uOpacity * cov);
}`;

export const VERT_QUAD = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform float uFlip;
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4((aPos * 2.0 - 1.0) * vec2(1.0, uFlip), 0.0, 1.0);
}`;

// --- Exportación rápida ---------------------------------------------------------------------
// Los fotogramas viajan entre FFmpeg y el compositor como YUV 4:2:0 (NV12, 1,5 bytes por píxel)
// en vez de RGB/RGBA (3-4 bytes): menos datos por las tuberías y la conversión de color la
// hace la tarjeta gráfica. Siempre BT.709/601/2020 de rango limitado.

// NV12 decodificado -> RGB. uY: plano de luma; uUV: plano de croma intercalado.
export const FRAG_YUV_IN = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uY;
uniform sampler2D uUV;
uniform vec4 uCoef;       // Cr->R, Cb->G, Cr->G, Cb->B
uniform float uChromaShift; // medio píxel de luma: la croma 4:2:0 va alineada a la izquierda
void main() {
  float y = (texture(uY, vUv).r * 255.0 - 16.0) / 219.0;
  vec2 c = (texture(uUV, vUv + vec2(uChromaShift, 0.0)).rg * 255.0 - 128.0) / 224.0;
  vec3 rgb = vec3(y + uCoef.x * c.y, y - uCoef.y * c.x - uCoef.z * c.y, y + uCoef.w * c.x);
  outColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);
}`;

// Imagen compuesta (RGB) -> NV12 BT.709 de rango limitado, lista para el codificador.
// Las filas 0..H-1 del destino llevan la luma y las H/2 siguientes la croma intercalada.
export const FRAG_NV12_OUT = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D uSrc;
uniform int uH;
const vec3 KY = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v;
  if (p.y < uH) {
    v = 16.0 + 219.0 * dot(texelFetch(uSrc, p, 0).rgb, KY);
  } else {
    int cy = (p.y - uH) * 2;
    int cx = (p.x / 2) * 2;
    vec3 c = (texelFetch(uSrc, ivec2(cx, cy), 0).rgb + texelFetch(uSrc, ivec2(cx + 1, cy), 0).rgb
            + texelFetch(uSrc, ivec2(cx, cy + 1), 0).rgb + texelFetch(uSrc, ivec2(cx + 1, cy + 1), 0).rgb) * 0.25;
    float y = dot(c, KY);
    v = (p.x & 1) == 0 ? 128.0 + 224.0 * (c.b - y) / 1.8556 : 128.0 + 224.0 * (c.r - y) / 1.5748;
  }
  outColor = vec4(v / 255.0, 0.0, 0.0, 1.0);
}`;

// Transiciones entre dos imágenes ya compuestas (A sale, B entra). Colores premultiplicados.
export const FRAG_TRANSITION = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uA;
uniform sampler2D uB;
uniform float uP;
uniform int uType;
uniform float uAspect;

bool inside(vec2 p) { return p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0; }
vec4 A(vec2 p) { return inside(p) ? textureLod(uA, vec2(p.x, 1.0 - p.y), 0.0) : vec4(0.0); }
vec4 B(vec2 p) { return inside(p) ? textureLod(uB, vec2(p.x, 1.0 - p.y), 0.0) : vec4(0.0); }

vec4 soft(sampler2D t, vec2 p, float lod) {
  vec2 uv = vec2(p.x, 1.0 - p.y);
  vec2 o = vec2(exp2(lod)) / vec2(textureSize(t, 0)) * 0.75;
  vec4 acc = textureLod(t, uv, lod) * 2.0;
  acc += textureLod(t, clamp(uv + vec2(o.x, o.y), 0.0, 1.0), lod);
  acc += textureLod(t, clamp(uv + vec2(-o.x, o.y), 0.0, 1.0), lod);
  acc += textureLod(t, clamp(uv + vec2(o.x, -o.y), 0.0, 1.0), lod);
  acc += textureLod(t, clamp(uv + vec2(-o.x, -o.y), 0.0, 1.0), lod);
  return acc / 6.0;
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y);   // origen arriba a la izquierda
  float t = clamp(uP, 0.0, 1.0);
  float s = t * t * (3.0 - 2.0 * t);
  const float w = 0.035;
  vec4 c;

  if (uType == 1) {            // fundido a negro
    vec4 a = A(p); vec4 b = B(p);
    c = t < 0.5 ? vec4(a.rgb * (1.0 - 2.0 * t), a.a) : vec4(b.rgb * (2.0 * t - 1.0), b.a);
  } else if (uType == 2) {     // fundido a blanco
    vec4 a = A(p); vec4 b = B(p);
    c = t < 0.5 ? mix(a, vec4(a.a), 2.0 * t) : mix(vec4(b.a), b, 2.0 * t - 1.0);
  } else if (uType >= 3 && uType <= 6) {   // barridos
    float x = uType == 3 ? p.x : uType == 4 ? 1.0 - p.x : uType == 5 ? p.y : 1.0 - p.y;
    float m = clamp((s * (1.0 + w) - x) / w, 0.0, 1.0);
    c = mix(A(p), B(p), m);
  } else if (uType == 7) {     // empujar a la izquierda
    c = p.x + s < 1.0 ? A(p + vec2(s, 0.0)) : B(p + vec2(s - 1.0, 0.0));
  } else if (uType == 8) {     // empujar a la derecha
    c = p.x - s >= 0.0 ? A(p - vec2(s, 0.0)) : B(p - vec2(s - 1.0, 0.0));
  } else if (uType == 9) {     // empujar hacia arriba
    c = p.y + s < 1.0 ? A(p + vec2(0.0, s)) : B(p + vec2(0.0, s - 1.0));
  } else if (uType == 10) {    // empujar hacia abajo
    c = p.y - s >= 0.0 ? A(p - vec2(0.0, s)) : B(p - vec2(0.0, s - 1.0));
  } else if (uType == 11) {    // zoom
    vec2 d = p - 0.5;
    vec4 a = A(d / (1.0 + s * 1.4) + 0.5);
    vec4 b = B(d / (1.7 - 0.7 * s) + 0.5);
    c = mix(a, b, smoothstep(0.25, 0.75, t));
  } else if (uType == 12) {    // iris
    float r = length((p - 0.5) * vec2(uAspect, 1.0));
    float R = s * 0.5 * sqrt(uAspect * uAspect + 1.0) * 1.08;
    c = mix(A(p), B(p), smoothstep(R, R - 0.02, r));
  } else if (uType == 13) {    // desenfoque
    float lod = sin(t * 3.14159265) * 6.0;
    c = mix(soft(uA, p, lod), soft(uB, p, lod), s);
  } else {                     // disolución cruzada
    c = mix(A(p), B(p), t);
  }
  outColor = c;
}`;
