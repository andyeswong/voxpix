// VISTA (NARUTO): render() del núcleo en la GPU, para el editor. Mismo resultado que src/core/render.ts (que es su
// oráculo: app/oraculo-render.html los compara píxel a píxel), pero lo caro se hace en shaders:
//   1. una pasada por cara (vóxel x 6): si se ve (vecino vacío y de cara a la cámara) y su tono, con la normal
//      suavizada (7x7x7 vecinos), la sombra (rayo DDA hacia la luz) y la oclusión ambiental, como toneFor;
//   2. el rasterizado: dos triángulos por cara visible, con z-buffer, que escriben el tono, el vóxel y la cara de cada
//      píxel y su profundidad;
//   3. la CPU lee eso y termina con finishRender (los contornos y los colores), el mismo código que la CPU.
// Lo que sube: los vóxeles (una lista y una rejilla 3D con el material) cuando cambia el modelo; cada render, solo
// uniforms.
import { finishRender, renderBasis, key, SMOOTH_EPS, RAY_NUDGE, LIGHT_NUDGE, type RenderOptions, type Rendered, type VoxelSource, type PointLight3D, type Camera } from '../../core';

const TW = 1024;                 // ancho de las texturas de lista (vóxeles, caras)
// El render de la CPU toma la muestra de cada píxel en (i + 0.5 + 1/1024) y decide con sus funciones de arista. La
// GPU ajusta los vértices a su rejilla de subpíxel (1/256 o menos), así que no basta con desplazar la geometría: se
// pinta la caja de cada triángulo y el fragment shader hace la misma prueba que la CPU, con su profundidad.
const SAMPLE = 0.5 + 1 / 1024;

const COMMON = `#version 300 es
precision highp float; precision highp int; precision highp isampler2D; precision highp usampler3D;
const int TW = ${TW};
uniform isampler2D uVox;
`;

const FRAG_TONE = `${COMMON}
uniform usampler3D uGrid;
uniform ivec3 uGridMin, uGridSize;
uniform int uFaces;
uniform vec3 uView, uL;
uniform bool uFlat, uShadows, uAo;
uniform float uSmooth;
uniform vec2 uTh;                // lit, mid
uniform int uRampLen[16];
out int oShade;
const ivec3 DIRS[6] = ivec3[6](ivec3(1, 0, 0), ivec3(-1, 0, 0), ivec3(0, 1, 0), ivec3(0, -1, 0), ivec3(0, 0, 1), ivec3(0, 0, -1));
const ivec3 PU[6] = ivec3[6](ivec3(0, 1, 0), ivec3(0, 1, 0), ivec3(1, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 0), ivec3(1, 0, 0));
const ivec3 PW[6] = ivec3[6](ivec3(0, 0, 1), ivec3(0, 0, 1), ivec3(0, 0, 1), ivec3(0, 0, 1), ivec3(0, 1, 0), ivec3(0, 1, 0));
bool filled(ivec3 p) {
  ivec3 q = p - uGridMin;
  if (any(lessThan(q, ivec3(0))) || any(greaterThanEqual(q, uGridSize))) return false;
  return texelFetch(uGrid, q, 0).r != 0u;
}
vec3 nrm(vec3 v) { float l = length(v); return v / (l > 0.0 ? l : 1.0); }
// El rayo de inShadow (render.ts): por la rejilla hacia la luz, 96 pasos. Fuera de la rejilla y alejándose ya no
// puede tocar nada.
bool inShadow(ivec3 c) {
  ivec3 q = c;
  ivec3 st = ivec3(sign(uL));
  vec3 td = vec3(st.x != 0 ? abs(1.0 / uL.x) : 1e30, st.y != 0 ? abs(1.0 / uL.y) : 1e30, st.z != 0 ? abs(1.0 / uL.z) : 1e30);
  vec3 t = td * 0.5;
  ivec3 lo = uGridMin, hi = uGridMin + uGridSize - 1;
  for (int k = 0; k < 96; k++) {
    if (t.x <= t.y && t.x <= t.z) { q.x += st.x; t.x += td.x; }
    else if (t.y <= t.z) { q.y += st.y; t.y += td.y; }
    else { q.z += st.z; t.z += td.z; }
    if (filled(q)) return true;
    if ((st.x > 0 && q.x > hi.x) || (st.x < 0 && q.x < lo.x) || (st.y > 0 && q.y > hi.y) || (st.y < 0 && q.y < lo.y)
      || (st.z > 0 && q.z > hi.z) || (st.z < 0 && q.z < lo.z)) return false;
  }
  return false;
}
void main() {
  int idx = int(gl_FragCoord.y) * TW + int(gl_FragCoord.x);
  oShade = -1;
  if (idx >= uFaces) return;
  int i = idx / 6, f = idx - i * 6;
  ivec4 vx = texelFetch(uVox, ivec2(i % TW, i / TW), 0);
  ivec3 p = vx.xyz;
  ivec3 d = DIRS[f];
  if (filled(p + d)) return;
  if (dot(vec3(d), uView) >= -1e-9) return;
  int ramp = (vx.w - 1) / 16, tone = (vx.w - 1) - ramp * 16;
  if (uFlat) { oShade = ramp * 16 + tone; return; }
  vec3 s = vec3(0.0);
  if (uSmooth > 0.0) for (int dz = -3; dz <= 3; dz++) for (int dy = -3; dy <= 3; dy++) for (int dx = -3; dx <= 3; dx++) {
    if (dx == 0 && dy == 0 && dz == 0) continue;
    if (filled(p + ivec3(dx, dy, dz))) continue;
    float w = 1.0 / float(dx * dx + dy * dy + dz * dz);
    s += vec3(dx, dy, dz) * w;
  }
  vec3 sn = length(s) < ${SMOOTH_EPS} ? vec3(0.0) : nrm(s);
  vec3 n = nrm(vec3(d) * (1.0 - uSmooth) + sn * uSmooth);
  float I = max(0.0, dot(n, uL));
  if (uShadows && inShadow(p + d)) I = min(I, uTh.y - 0.01);
  int level = I >= uTh.x ? 1 : I >= uTh.y ? 0 : -1;
  if (uAo) {
    int occ = 0;
    for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) {
      if (a == 0 && b == 0) continue;
      if (filled(p + d + a * PU[f] + b * PW[f])) occ++;
    }
    if (occ >= 5) level -= 1;
  }
  oShade = ramp * 16 + clamp(tone + level, 0, uRampLen[ramp] - 1);
}`;

const VERT_FULL = `#version 300 es
void main() { vec2 p = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0; gl_Position = vec4(p, 0.0, 1.0); }`;

const VERT_FACES = `${COMMON}
uniform isampler2D uTone;
uniform vec3 uPiv, uUp, uFwd;
uniform float uZs, uCos, uSin, uPpu;
uniform vec2 uOrigin, uSize;
flat out ivec4 vPick;
flat out vec3 vA, vB, vC;          // el triángulo en pantalla (x, y, profundidad), como lo rasteriza la CPU
const vec3 FC[24] = vec3[24](
  vec3(1, 0, 0), vec3(1, 1, 0), vec3(1, 1, 1), vec3(1, 0, 1),
  vec3(0, 0, 0), vec3(0, 0, 1), vec3(0, 1, 1), vec3(0, 1, 0),
  vec3(0, 1, 0), vec3(0, 1, 1), vec3(1, 1, 1), vec3(1, 1, 0),
  vec3(0, 0, 0), vec3(1, 0, 0), vec3(1, 0, 1), vec3(0, 0, 1),
  vec3(0, 0, 1), vec3(1, 0, 1), vec3(1, 1, 1), vec3(0, 1, 1),
  vec3(0, 0, 0), vec3(0, 1, 0), vec3(1, 1, 0), vec3(1, 0, 0));
const ivec3 TRI[2] = ivec3[2](ivec3(0, 1, 2), ivec3(0, 2, 3));
const vec2 BOX[6] = vec2[6](vec2(0, 0), vec2(1, 0), vec2(0, 1), vec2(0, 1), vec2(1, 0), vec2(1, 1));
// camera().project de render.ts
vec3 project(vec3 c) {
  float px = c.x - uPiv.x, py = c.y - uPiv.y, pz = (c.z - uPiv.z) * uZs;
  float wx = px * uCos - py * uSin, wy = px * uSin + py * uCos;
  return vec3(wx * uPpu + uOrigin.x + 0.5, -(wy * uUp.y + pz * uUp.z) * uPpu + uOrigin.y, wy * uFwd.y + pz * uFwd.z);
}
void main() {
  int idx = gl_InstanceID;
  int shade = texelFetch(uTone, ivec2(idx % TW, idx / TW), 0).r;
  vPick = ivec4(-1); vA = vB = vC = vec3(0.0);
  if (shade < 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int i = idx / 6, f = idx - i * 6;
  ivec4 vx = texelFetch(uVox, ivec2(i % TW, i / TW), 0);
  vec3 p = vec3(vx.xyz);
  ivec3 t = TRI[gl_VertexID / 6];
  vA = project(p + FC[f * 4 + t.x]); vB = project(p + FC[f * 4 + t.y]); vC = project(p + FC[f * 4 + t.z]);
  // La caja de píxeles que mira la CPU para este triángulo: de floor(min) a ceil(max), ambos incluidos
  vec2 lo = floor(min(vA.xy, min(vB.xy, vC.xy))), hi = ceil(max(vA.xy, max(vB.xy, vC.xy))) + 1.0;
  vec2 q = mix(lo, hi, BOX[gl_VertexID % 6]);
  gl_Position = vec4(q / uSize * 2.0 - 1.0, 0.0, 1.0);
  vPick = ivec4(shade, vx.x, vx.y, vx.z * 8 + f);
}`;

const FRAG_FACES = `#version 300 es
precision highp float; precision highp int;
flat in ivec4 vPick;
flat in vec3 vA, vB, vC;
uniform vec2 uDepthRange;
layout(location = 0) out ivec4 oPick;
layout(location = 1) out vec4 oDepth;
// raster() de render.ts: funciones de arista en la muestra del píxel, con los bordes incluidos
void main() {
  vec2 p = floor(gl_FragCoord.xy) + ${SAMPLE};
  float area = (vB.x - vA.x) * (vC.y - vA.y) - (vB.y - vA.y) * (vC.x - vA.x);
  if (abs(area) < 1e-12) discard;
  float w0 = (vB.x - p.x) * (vC.y - p.y) - (vB.y - p.y) * (vC.x - p.x);
  float w1 = (vC.x - p.x) * (vA.y - p.y) - (vC.y - p.y) * (vA.x - p.x);
  float w2 = (vA.x - p.x) * (vB.y - p.y) - (vA.y - p.y) * (vB.x - p.x);
  if (area < 0.0) { w0 = -w0; w1 = -w1; w2 = -w2; }
  if (w0 < 0.0 || w1 < 0.0 || w2 < 0.0) discard;
  float z = (w0 * vA.z + w1 * vB.z + w2 * vC.z) / abs(area);
  gl_FragDepth = clamp((z - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 1.0);
  oPick = vPick;
  oDepth = vec4(z, 0.0, 0.0, 0.0);
}`;

// lightField3D (src/core/light3d.ts) por píxel: la luz de la cara que se ve (en su centro, con el rayo desde la celda
// de aire de enfrente) o la del suelo (z = 0) donde no hay vóxel. Las mismas cuentas y los mismos empujones del rayo.
export const MAX_LIGHTS = 64;
const FRAG_LIGHT = `#version 300 es
precision highp float; precision highp int; precision highp isampler2D; precision highp usampler3D;
uniform isampler2D uPick;
uniform usampler3D uGrid;
uniform ivec3 uGridMin, uGridSize;
uniform int uNL;
uniform vec4 uLPos[${MAX_LIGHTS}];     // x, y, z, radio
uniform vec4 uLCol[${MAX_LIGHTS}];     // r, g, b, intensidad
uniform vec4 uLSpot[${MAX_LIGHTS}];    // dirección, coseno de fuera
uniform vec2 uLSpot2[${MAX_LIGHTS}];   // coseno de dentro, 1 si es foco
uniform vec3 uAmbient;
uniform bool uFloor;
uniform vec2 uG0, uGX, uGY;               // el punto del suelo bajo el píxel (sx, sy): uG0 + sx*uGX + sy*uGY
out vec4 oTotal;
const vec3 DIRS[6] = vec3[6](vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 1, 0), vec3(0, -1, 0), vec3(0, 0, 1), vec3(0, 0, -1));
const vec3 RAY_NUDGE = vec3(${RAY_NUDGE[0]}, ${RAY_NUDGE[1]}, ${RAY_NUDGE[2]});
const vec3 LIGHT_NUDGE = vec3(${LIGHT_NUDGE[0]}, ${LIGHT_NUDGE[1]}, ${LIGHT_NUDGE[2]});
bool filled(ivec3 p) {
  ivec3 q = p - uGridMin;
  if (any(lessThan(q, ivec3(0))) || any(greaterThanEqual(q, uGridSize))) return false;
  return texelFetch(uGrid, q, 0).r != 0u;
}
float facing(float ndl) { return ndl > 0.0 ? 0.35 + 0.65 * ndl : 0.0; }
float spotFactor(int i, vec3 v) {
  if (uLSpot2[i].y < 0.5) return 1.0;
  float d = length(v);
  if (d < 1e-6) return 1.0;
  float c = dot(v, uLSpot[i].xyz) / d;
  if (c <= uLSpot[i].w) return 0.0;
  if (c >= uLSpot2[i].x) return 1.0;
  float t = (c - uLSpot[i].w) / (uLSpot2[i].x - uLSpot[i].w);
  return t * t * (3.0 - 2.0 * t);
}
// occluded() de light3d.ts (Amanatides-Woo)
bool occluded(vec3 p0, vec3 l0) {
  vec3 p = p0 + RAY_NUDGE, l = l0 + LIGHT_NUDGE;
  vec3 d = l - p;
  ivec3 c = ivec3(floor(p)), t = ivec3(floor(l));
  ivec3 st = ivec3(sign(d));
  vec3 dd = vec3(st.x != 0 ? abs(1.0 / d.x) : 1e30, st.y != 0 ? abs(1.0 / d.y) : 1e30, st.z != 0 ? abs(1.0 / d.z) : 1e30);
  vec3 m = vec3(st.x != 0 ? (st.x > 0 ? float(c.x) + 1.0 - p.x : p.x - float(c.x)) * dd.x : 1e30,
                st.y != 0 ? (st.y > 0 ? float(c.y) + 1.0 - p.y : p.y - float(c.y)) * dd.y : 1e30,
                st.z != 0 ? (st.z > 0 ? float(c.z) + 1.0 - p.z : p.z - float(c.z)) * dd.z : 1e30);
  for (int i = 0; i < 512; i++) {
    if (c == t) return false;
    if (m.x <= m.y && m.x <= m.z) { if (m.x > 1.0) return false; c.x += st.x; m.x += dd.x; }
    else if (m.y <= m.z) { if (m.y > 1.0) return false; c.y += st.y; m.y += dd.y; }
    else { if (m.z > 1.0) return false; c.z += st.z; m.z += dd.z; }
    if (c == t) return false;
    if (filled(c)) return true;
  }
  return false;
}
vec3 lightAt(vec3 p, vec3 n, vec3 start) {
  vec3 o = uAmbient;
  for (int i = 0; i < uNL; i++) {
    vec3 lp = uLPos[i].xyz;
    vec3 v = lp - p;
    float d = length(v);
    if (d >= uLPos[i].w || uLCol[i].w <= 0.0) continue;
    float f = d < 1e-6 ? 1.0 : facing(dot(n, v) / d);
    if (f <= 0.0) continue;
    float k = 1.0 - d / uLPos[i].w;
    float att = k * k * uLCol[i].w * f * spotFactor(i, p - lp);
    if (att < 0.002) continue;
    if (occluded(start, lp)) continue;
    o += uLCol[i].rgb * att;
  }
  return o;
}
void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);
  ivec4 pk = texelFetch(uPick, px, 0);
  vec3 c;
  if (pk.x >= 0) {
    int f = pk.w & 7;                      // z*8 + cara, también con z negativa
    vec3 v = vec3(pk.y, pk.z, float((pk.w - f) / 8));
    vec3 n = DIRS[f];
    c = lightAt(v + 0.5 + n * 0.5, n, v + 0.5 + n);
  } else if (uFloor) {
    vec2 g = uG0 + (float(px.x) + 0.5) * uGX + (float(px.y) + 0.5) * uGY;
    c = lightAt(vec3(g, 0.0), vec3(0, 0, 1), vec3(g, 0.01));
  } else c = uAmbient;
  oTotal = vec4(c, 1.0);
}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Uniforms = Record<string, any>;

export class GpuVoxelRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly tone: { prog: WebGLProgram; u: Uniforms };
  private readonly faces: { prog: WebGLProgram; u: Uniforms };
  private readonly light: { prog: WebGLProgram; u: Uniforms };
  private readonly vao: WebGLVertexArrayObject;
  private readonly max3D: number;
  // El modelo subido
  private modelOf: VoxelSource | null = null;
  private rev: unknown = undefined;
  private n = 0;
  private gridMin: [number, number, number] = [0, 0, 0];
  private gridSize: [number, number, number] = [1, 1, 1];
  private tVox: WebGLTexture | null = null;
  private tGrid: WebGLTexture | null = null;
  // Tono por cara
  private tTone: WebGLTexture | null = null;
  private toneFbo: WebGLFramebuffer | null = null;
  private toneRows = 0;
  // Destino del rasterizado
  private target: { w: number; h: number; fbo: WebGLFramebuffer; pick: WebGLTexture; depth: WebGLTexture; zbuf: WebGLRenderbuffer } | null = null;
  private lastRender = '';           // qué hay en target (las opciones y la versión del modelo), para la luz
  private lightTarget: { w: number; h: number; fbo: WebGLFramebuffer; tex: WebGLTexture } | null = null;
  // ms del último render: subir el modelo y leer el resultado (lo demás es la GPU)
  readonly stats = { uploadMs: 0, gpuMs: 0, finishMs: 0, lightMs: 0 };

  static create(): GpuVoxelRenderer | null {
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false }) as WebGL2RenderingContext | null;
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    try { return new GpuVoxelRenderer(gl); } catch (e) { console.warn('[voxpix] render GPU: no arranca', e); return null; }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.tone = program(gl, VERT_FULL, FRAG_TONE);
    this.faces = program(gl, VERT_FACES, FRAG_FACES);
    this.light = program(gl, VERT_FULL, FRAG_LIGHT);
    this.vao = gl.createVertexArray()!;
    this.max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  get lost(): boolean { return this.gl.isContextLost(); }

  // Sube el modelo si cambió (otro objeto u otra `rev`). false si no cabe en una textura 3D (entonces, la CPU).
  private upload(model: VoxelSource, rev: unknown): boolean {
    if (model === this.modelOf && rev === this.rev) return true;
    const gl = this.gl;
    const list: number[] = [];
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    // En el orden de entries(), el de la CPU: con dos caras a la misma profundidad gana la primera, como allí
    for (const [x, y, z, v] of model.entries()) {
      list.push(x, y, z, v);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const n = list.length / 4;
    if (!n) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 0; }
    const size: [number, number, number] = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
    if (size.some((s) => s > this.max3D) || size[0] * size[1] * size[2] > 64 * 1024 * 1024) return false;
    const rows = Math.max(1, Math.ceil(n / TW));
    const vox = new Int16Array(TW * rows * 4);
    vox.set(list);
    const grid = new Uint8Array(size[0] * size[1] * size[2]);
    for (let i = 0; i < n; i++) {
      const x = list[i * 4]! - x0, y = list[i * 4 + 1]! - y0, z = list[i * 4 + 2]! - z0;
      grid[(z * size[1] + y) * size[0] + x] = list[i * 4 + 3]!;
    }
    for (const t of [this.tVox, this.tGrid]) if (t) gl.deleteTexture(t);
    this.tVox = tex(gl, gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16I, TW, rows, 0, gl.RGBA_INTEGER, gl.SHORT, vox);
    this.tGrid = tex(gl, gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8UI, size[0], size[1], size[2], 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, grid);
    // El tono de cada cara: una textura de TW de ancho con 6 caras por vóxel
    const toneRows = Math.max(1, Math.ceil((n * 6) / TW));
    if (toneRows !== this.toneRows || !this.tTone) {
      if (this.tTone) gl.deleteTexture(this.tTone);
      if (this.toneFbo) gl.deleteFramebuffer(this.toneFbo);
      this.tTone = tex(gl, gl.TEXTURE_2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, TW, toneRows, 0, gl.RED_INTEGER, gl.SHORT, null);
      this.toneFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.toneFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tTone, 0);
      checkFbo(gl);
      this.toneRows = toneRows;
    }
    this.modelOf = model; this.rev = rev; this.n = n;
    this.gridMin = [x0, y0, z0]; this.gridSize = size;
    return true;
  }

  private ensureTarget(w: number, h: number) {
    const t = this.target;
    if (t && t.w === w && t.h === h) return t;
    const gl = this.gl;
    if (t) { gl.deleteFramebuffer(t.fbo); gl.deleteTexture(t.pick); gl.deleteTexture(t.depth); gl.deleteRenderbuffer(t.zbuf); }
    const pick = tex(gl, gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32I, w, h, 0, gl.RGBA_INTEGER, gl.INT, null);
    const depth = tex(gl, gl.TEXTURE_2D);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
    const zbuf = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, zbuf);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pick, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, depth, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, zbuf);
    checkFbo(gl);
    this.target = { w, h, fbo, pick, depth, zbuf };
    return this.target;
  }

  // Como render(model, o). `rev` dice si el modelo cambió desde la última vez (p. ej. un contador de versión): con el
  // mismo objeto y la misma rev no se vuelve a subir. null si este modelo no cabe en la GPU (usa la CPU).
  render(model: VoxelSource, o: RenderOptions, rev?: unknown): Rendered | null {
    const gl = this.gl;
    const t0 = performance.now();
    if (!this.upload(model, rev)) return null;
    const t1 = performance.now();
    const { width: W, height: H } = o;
    const { cam, Lm, viewM } = renderBasis(o);
    const th = o.thresholds ?? { lit: 0.72, mid: 0.3 };
    const pal = model.palette;

    // 1. El tono de cada cara
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.toneFbo);
    gl.viewport(0, 0, TW, this.toneRows);
    gl.disable(gl.DEPTH_TEST);
    let u = this.tone.u;
    gl.useProgram(this.tone.prog);
    bind(gl, 0, gl.TEXTURE_2D, this.tVox, u.uVox);
    bind(gl, 1, gl.TEXTURE_3D, this.tGrid, u.uGrid);
    gl.uniform3iv(u.uGridMin, this.gridMin);
    gl.uniform3iv(u.uGridSize, this.gridSize);
    gl.uniform1i(u.uFaces, this.n * 6);
    gl.uniform3fv(u.uView, viewM);
    gl.uniform3fv(u.uL, Lm);
    gl.uniform1i(u.uFlat, o.flat ? 1 : 0);
    gl.uniform1i(u.uShadows, (o.shadows ?? true) ? 1 : 0);
    gl.uniform1i(u.uAo, (o.ao ?? true) ? 1 : 0);
    gl.uniform1f(u.uSmooth, o.smooth ?? 0.6);
    gl.uniform2f(u.uTh, th.lit, th.mid);
    const lens = new Int32Array(16).fill(1);
    pal.ramps.slice(0, 16).forEach((r, i) => { lens[i] = r.colors.length; });
    gl.uniform1iv(u.uRampLen, lens);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. Las caras visibles, con z-buffer
    const T = this.ensureTarget(W, H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.viewport(0, 0, W, H);
    gl.clearBufferiv(gl.COLOR, 0, [-1, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [Infinity, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    u = this.faces.u;
    gl.useProgram(this.faces.prog);
    bind(gl, 0, gl.TEXTURE_2D, this.tVox, u.uVox);
    bind(gl, 1, gl.TEXTURE_2D, this.tTone, u.uTone);
    gl.uniform3fv(u.uPiv, cam.pivot);
    gl.uniform3fv(u.uUp, cam.up);
    gl.uniform3fv(u.uFwd, cam.fwd);
    gl.uniform1f(u.uZs, cam.zScale);
    gl.uniform1f(u.uCos, cam.yawCos);
    gl.uniform1f(u.uSin, cam.yawSin);
    gl.uniform1f(u.uPpu, cam.ppu);
    gl.uniform2f(u.uOrigin, o.originX, o.originY);
    gl.uniform2f(u.uSize, W, H);
    // El rango de profundidad: el de las esquinas de la caja del modelo
    let dlo = Infinity, dhi = -Infinity;
    const [gx, gy, gz] = this.gridMin, [sx, sy, sz] = this.gridSize;
    for (const x of [gx, gx + sx]) for (const y of [gy, gy + sy]) for (const z of [gz, gz + sz]) {
      const d = cam.project(x, y, z)[2];
      dlo = Math.min(dlo, d); dhi = Math.max(dhi, d);
    }
    gl.uniform2f(u.uDepthRange, dlo - 1, dhi + 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 12, this.n * 6);
    gl.disable(gl.DEPTH_TEST);

    // 3. Leer y terminar como la CPU
    const pick = new Int32Array(W * H * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, W, H, gl.RGBA_INTEGER, gl.INT, pick);
    const dep = new Float32Array(W * H * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, dep);
    const t2 = performance.now();
    const color = new Int32Array(W * H);
    const depth = new Float32Array(W * H);
    const pickKey = o.pick ? new Float64Array(W * H).fill(NaN) : null;
    const pickFace = o.pick ? new Int8Array(W * H).fill(-1) : null;
    for (let i = 0; i < W * H; i++) {
      const c = pick[i * 4]!;
      color[i] = c;
      depth[i] = dep[i * 4]!;
      if (c < 0 || !pickKey) continue;
      const a = pick[i * 4 + 3]!, f = ((a % 8) + 8) % 8;
      pickKey[i] = key(pick[i * 4 + 1]!, pick[i * 4 + 2]!, (a - f) / 8);
      pickFace![i] = f;
    }
    this.lastRender = JSON.stringify(o);
    const out = finishRender(pal, o, color, depth, pickKey, pickFace);
    const t3 = performance.now();
    this.stats.uploadMs = t1 - t0; this.stats.gpuMs = t2 - t1; this.stats.finishMs = t3 - t2;
    return out;
  }
  // Como lightField3D(model, render(model, o), camera(o), lights, ambient, { floor }). null si no se puede (más de
  // MAX_LIGHTS luces o el modelo no cabe): entonces, la CPU.
  lightField(model: VoxelSource, o: RenderOptions, cam: Camera, lights: readonly PointLight3D[], ambient: readonly [number, number, number], options: { floor?: boolean } = {}, rev?: unknown): Float32Array | null {
    if (lights.length > MAX_LIGHTS) return null;
    // El vóxel y la cara de cada píxel tienen que ser los de este render
    if (model !== this.modelOf || rev !== this.rev || this.lastRender !== JSON.stringify(o)) {
      if (!this.render(model, { ...o, pick: true }, rev)) return null;
      this.lastRender = JSON.stringify(o);
    }
    const gl = this.gl;
    const t0 = performance.now();
    const { width: W, height: H } = o;
    let T = this.lightTarget;
    if (!T || T.w !== W || T.h !== H) {
      if (T) { gl.deleteFramebuffer(T.fbo); gl.deleteTexture(T.tex); }
      const t = tex(gl, gl.TEXTURE_2D);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, W, H, 0, gl.RGBA, gl.FLOAT, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      checkFbo(gl);
      T = this.lightTarget = { w: W, h: H, fbo, tex: t };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.fbo);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.DEPTH_TEST);
    const u = this.light.u;
    gl.useProgram(this.light.prog);
    bind(gl, 0, gl.TEXTURE_2D, this.target!.pick, u.uPick);
    bind(gl, 1, gl.TEXTURE_3D, this.tGrid, u.uGrid);
    gl.uniform3iv(u.uGridMin, this.gridMin);
    gl.uniform3iv(u.uGridSize, this.gridSize);
    const n = lights.length;
    const pos = new Float32Array(MAX_LIGHTS * 4), col = new Float32Array(MAX_LIGHTS * 4), spot = new Float32Array(MAX_LIGHTS * 4), spot2 = new Float32Array(MAX_LIGHTS * 2);
    lights.forEach((l, i) => {
      pos.set([l.x, l.y, l.z, l.radius], i * 4);
      col.set([l.color[0], l.color[1], l.color[2], l.intensity], i * 4);
      if (l.spot) { spot.set([...l.spot.dir, l.spot.cosOuter], i * 4); spot2.set([l.spot.cosInner, 1], i * 2); }
    });
    gl.uniform1i(u.uNL, n);
    gl.uniform4fv(u.uLPos, pos);
    gl.uniform4fv(u.uLCol, col);
    gl.uniform4fv(u.uLSpot, spot);
    gl.uniform2fv(u.uLSpot2, spot2);
    gl.uniform3f(u.uAmbient, ambient[0], ambient[1], ambient[2]);
    // El suelo bajo un píxel es afín en (sx, sy): se pasa como origen y dos ejes
    const g0 = cam.groundPoint(0, 0), gx = cam.groundPoint(1, 0), gy = cam.groundPoint(0, 1);
    const floor = (options.floor ?? true) && !!g0 && !!gx && !!gy;
    gl.uniform1i(u.uFloor, floor ? 1 : 0);
    if (floor) {
      gl.uniform2f(u.uG0, g0![0], g0![1]);
      gl.uniform2f(u.uGX, gx![0] - g0![0], gx![1] - g0![1]);
      gl.uniform2f(u.uGY, gy![0] - g0![0], gy![1] - g0![1]);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const rgba = new Float32Array(W * H * 4);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, rgba);
    const total = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) { total[i * 3] = rgba[i * 4]!; total[i * 3 + 1] = rgba[i * 4 + 1]!; total[i * 3 + 2] = rgba[i * 4 + 2]!; }
    this.stats.lightMs = performance.now() - t0;
    return total;
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): { prog: WebGLProgram; u: Uniforms } {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`programa: ${gl.getProgramInfoLog(prog)}`);
  const u: Uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u: new Proxy(u, { get: (t, k: string) => t[k] ?? null }) };
}

function tex(gl: WebGL2RenderingContext, target: number): WebGLTexture {
  const t = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE7);
  gl.bindTexture(target, t);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function bind(gl: WebGL2RenderingContext, unit: number, target: number, t: WebGLTexture | null, loc: WebGLUniformLocation | null): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, t);
  if (loc) gl.uniform1i(loc, unit);
}

function checkFbo(gl: WebGL2RenderingContext): void {
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incompleto: 0x${st.toString(16)}`);
}
