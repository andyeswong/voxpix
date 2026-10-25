// Los shaders del compositor (WebGL2). Cada uno traduce, píxel a píxel, una parte del compositor en CPU, que es el
// oráculo (src/world/frame2d.ts, water.ts, particles.ts y lighting/shade.ts): si cambia allí, cambia aquí, y la
// prueba del oráculo (scripts/oracle) compara los dos.
//
// Todas las texturas de la vista guardan la fila 0 arriba, como los arrays de la CPU: la fila de un fragmento es
// int(gl_FragCoord.y). Solo el último paso, al pintar en el lienzo, da la vuelta.

export const MAX_LIGHTS = 32;      // luces del mundo por cuadro
export const MAX_BAKED = 32;       // luces fijas horneadas
export const MAX_CASTERS = 8;
const EMISSIVE = '1.0';            // luz de lo emisivo (frame2d.ts: EMISSIVE_LIGHT)      // entidades con sombra de verdad por cuadro (frame2d.ts: MAX_CASTERS)

// Las luces del mundo de este cuadro, en una textura RGBA32F de 4 x MAX_LIGHTS (en uniforms se pasaría del mínimo
// de vectores que WebGL2 garantiza en un móvil): por fila, posición y radio; color e intensidad con parpadeo;
// capa de pesos horneados (-1 si no), intensidad con parpadeo / horneada, 1 si es dinámica y el coseno del cono de
// dentro; y si es un foco, su dirección y el coseno del cono de fuera (-2 si no es foco).
const LIGHT_TABLE = `uniform sampler2D uLightTab;
vec4 lightPos(int i) { return texelFetch(uLightTab, ivec2(0, i), 0); }
vec4 lightCol(int i) { return texelFetch(uLightTab, ivec2(1, i), 0); }
vec4 lightMeta(int i) { return texelFetch(uLightTab, ivec2(2, i), 0); }
vec4 lightSpot(int i) { return texelFetch(uLightTab, ivec2(3, i), 0); }
// El cono de un foco (spotFactor de src/core/light3d.ts): v va de la luz al punto, dir en los mismos ejes
float spotOf(int i, vec3 v, vec3 dir) {
  vec4 sd = lightSpot(i);
  if (sd.w < -1.5) return 1.0;
  float d = length(v);
  if (d < 1e-6) return 1.0;
  float c = dot(v, dir) / d, ci = lightMeta(i).w;
  if (c <= sd.w) return 0.0;
  if (c >= ci) return 1.0;
  float t = (c - sd.w) / (ci - sd.w);
  return t * t * (3.0 - 2.0 * t);
}
float spot(int i, vec3 v) { return spotOf(i, v, lightSpot(i).xyz); }`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp isampler2D;
precision highp sampler2DArray;
precision highp sampler3D;
`;

export const VERT_FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// ---- 1) La escena: imagen horneada, luz (horneada, dinámica, sombras de entidades) y entidades encima
export const FRAG_SCENE = `${HEADER}
#define MAXL ${MAX_LIGHTS}
#define MAXB ${MAX_BAKED}
#define MAXE ${MAX_CASTERS}
#define REACH 48.0
#define TIE (1.0 / 1024.0)

uniform sampler2D uColor;
uniform sampler2D uDepth;
uniform isampler2D uFace;
uniform sampler2D uWorldY;             // la y del mundo de cada píxel (calculada en la CPU en doble precisión)
uniform sampler2DArray uWeights;
uniform sampler2D uEntColor;             // la capa de entidades (paso de entidades): color, su luz y profundidad
uniform sampler2D uEntLight;
uniform sampler2D uEntDepth;
uniform sampler2D uContact;              // las sombras de contacto: factor que multiplica la luz
uniform sampler3D uOcc;

uniform ivec2 uView;
uniform vec3 uBg;
uniform vec3 uAmbient;
uniform bool uLights;
uniform float uA, uOriginY, uF1, uF2;
uniform vec3 uDirs[6];

uniform int uNBaked;
uniform ivec4 uBakedRect[MAXB];        // x, y, w, h
uniform vec3 uBakedColorK[MAXB];       // color * (intensidad con parpadeo / intensidad horneada)

uniform int uNLights;
${LIGHT_TABLE}

uniform int uNEnt;                     // las que dan sombra de verdad (shadowCasters)
uniform ivec4 uEntBox[MAXE];           // recuadro de su sombra (imagen horneada), x0 y0 x1 y1
uniform vec3 uEntPos[MAXE];            // pies redondeados: ex, ey, ez
uniform ivec4 uEntOccMin[MAXE];        // esquina mínima del cuerpo (ejes locales girados), w = x en el atlas
uniform ivec3 uEntOccSize[MAXE];
uniform uint uEntNear[MAXE];           // qué luces llegan a su zona (bit i = luz i)

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
layout(location = 2) out vec4 oDepth;

float facing(float ndl) { return ndl > 0.0 ? 0.35 + 0.65 * ndl : 0.0; }

float contribution(int i, vec3 P, vec3 n) {
  vec4 lp = lightPos(i);
  vec3 dd = lp.xyz - P;
  float d = length(dd);
  if (d >= lp.w) return 0.0;
  float k = 1.0 - d / lp.w;
  return k * k * lightCol(i).w * (d < 1e-6 ? 1.0 : facing(dot(n, dd) / d)) * spot(i, -dd);
}

bool blockedByBody(int e, vec3 P, vec3 L) {
  vec3 mn = vec3(uEntOccMin[e].xyz);
  vec3 mx = mn + vec3(uEntOccSize[e]);
  float t0 = 0.0, t1 = 1.0;
  for (int i = 0; i < 3; i++) {
    float d = L[i] - P[i];
    if (abs(d) < 1e-9) { if (P[i] < mn[i] || P[i] > mx[i]) return false; continue; }
    float a = (mn[i] - P[i]) / d, b = (mx[i] - P[i]) / d;
    if (a > b) { float s = a; a = b; b = s; }
    t0 = max(t0, a); t1 = min(t1, b);
    if (t0 > t1) return false;
  }
  float len = length(L - P) * (t1 - t0);
  int steps = max(1, int(ceil(len * 2.0)));
  ivec3 imn = uEntOccMin[e].xyz, size = uEntOccSize[e];
  for (int k = 0; k <= steps; k++) {
    float t = t0 + (t1 - t0) * float(k) / float(steps);
    ivec3 v = ivec3(floor(P + (L - P) * t + TIE)) - imn;   // el mismo desempate que la CPU (frame2d.ts)
    if (any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, size))) continue;
    if (texelFetch(uOcc, ivec3(v.x + uEntOccMin[e].w, v.y, v.z), 0).r > 0.0) return true;
  }
  return false;
}

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 s = t + uView;
  vec4 c = texelFetch(uColor, s, 0);
  float depth = texelFetch(uDepth, s, 0).r;
  vec3 col = c.a == 0.0 ? uBg : c.rgb;
  vec3 total = uAmbient;
  if (uLights) {
    for (int i = 0; i < uNBaked; i++) {
      ivec4 r = uBakedRect[i];
      ivec2 l = s - r.xy;
      if (l.x < 0 || l.y < 0 || l.x >= r.z || l.y >= r.w) continue;
      float w = texelFetch(uWeights, ivec3(l, i), 0).r;
      if (w != 0.0) total += uBakedColorK[i] * w;
    }
    int f = texelFetch(uFace, s, 0).r;
    if (f >= 0) {
      // El punto del mundo que se ve aquí (worldPointAt) y su normal
      float Pp = uOriginY - (float(s.y) + 0.5);
      float wy = texelFetch(uWorldY, s, 0).r;
      vec3 P = vec3(float(s.x), wy, Pp - uA * wy);
      vec3 n = uDirs[f];
      for (int i = 0; i < uNLights; i++) {
        if (lightMeta(i).z == 0.0) continue;
        float w = contribution(i, P, n);
        if (w != 0.0) total += lightCol(i).rgb * w;
      }
      for (int e = 0; e < uNEnt; e++) {
        if (uEntNear[e] == 0u) continue;
        ivec4 bx = uEntBox[e];
        if (s.x < bx.x || s.y < bx.y || s.x > bx.z || s.y > bx.w) continue;
        vec3 ep = uEntPos[e];
        if (abs(P.x - ep.x) > REACH || abs(P.y - ep.y) > REACH) continue;
        vec3 Pl = P + n * 0.05 - ep;
        for (int i = 0; i < uNLights; i++) {
          if ((uEntNear[e] & (1u << uint(i))) == 0u) continue;
          if (!blockedByBody(e, Pl, lightPos(i).xyz - ep)) continue;
          float w = 0.0;
          int layer = int(lightMeta(i).x);
          if (layer >= 0) {
            ivec4 r = uBakedRect[layer];
            ivec2 l = s - r.xy;
            if (l.x >= 0 && l.y >= 0 && l.x < r.z && l.y < r.w) w = texelFetch(uWeights, ivec3(l, layer), 0).r * lightMeta(i).y;
          } else w = contribution(i, P, n);
          if (w == 0.0) continue;
          total = max(vec3(0.0), total - lightCol(i).rgb * w);
        }
      }
    }
  }
  // Las sombras de contacto, y encima la entidad más cercana si está delante de lo que hay
  if (uLights) total *= texelFetch(uContact, t, 0).rgb;
  float ed = texelFetch(uEntDepth, t, 0).r;
  if (ed < depth - 0.5) {
    depth = ed;
    col = texelFetch(uEntColor, t, 0).rgb;
    if (uLights) total = texelFetch(uEntLight, t, 0).rgb;
  }
  oColor = vec4(col, 1.0);
  oLight = vec4(total, 0.0);
  oDepth = vec4(depth, 0.0, 0.0, 0.0);
}`;

// ---- 2) El agua: superficie, reflejo, brillo, cáusticas y refracción (WaterLayer.draw)
export const FRAG_WATER = `${HEADER}
#define MAXL ${MAX_LIGHTS}
#define CELL 2
#define MARCH 40
#define REFLECT 0.38

uniform sampler2D uSrcColor;
uniform sampler2D uSrcLight;
uniform sampler2D uSrcDepth;
uniform sampler2D uWDepth;          // profundidad del agua por celda
uniform sampler2D uWStatic;         // fondo, sólida, cuenca

uniform bool uHasWater;
uniform bool uLights;
uniform ivec2 uView;
uniform ivec2 uViewSize;
uniform ivec2 uGrid;                // gw, gh
uniform ivec4 uCells;               // gx0, gx1, gy0, gy1
uniform float uA, uOriginY, uF1, uF2, uVy, uVz, uTPerPx, uDPerT;
uniform vec3 uAmbient;
uniform vec3 uTones[5];             // 0..255
uniform int uNLights;
${LIGHT_TABLE}

layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
layout(location = 2) out vec4 oDepth;

const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);

float jsRound(float x) { return floor(x + 0.5); }
float wDepth(ivec2 g) { return texelFetch(uWDepth, g, 0).r; }
vec4 wStatic(ivec2 g) { return texelFetch(uWStatic, g, 0); }
float sAt(ivec2 g, float own) {
  vec4 st = wStatic(g);
  float d = wDepth(g);
  return (st.g != 0.0 || d <= 0.01) ? own : st.r + d;
}
float srcDepthAt(int x, int y) { return texelFetch(uSrcDepth, ivec2(x, y), 0).r; }

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 sc = texelFetch(uSrcColor, t, 0);
  vec4 sl = texelFetch(uSrcLight, t, 0);
  float sd = srcDepthAt(t.x, t.y);
  oColor = sc; oLight = sl; oDepth = vec4(sd, 0.0, 0.0, 0.0);
  if (!uHasWater) return;
  int px = t.x + uView.x, sy = t.y + uView.y;
  int gx = px / CELL;
  if (gx < uCells.x || gx > uCells.y) return;
  // La celda que pinta este píxel: la de gy más alto que lo cubre y no queda tapada (en la CPU, la última en escribir)
  float yLo = (uOriginY - float(sy) - 32.0) / uA, yHi = (uOriginY - float(sy) + 16.0) / uA;
  int gyA = max(uCells.z, int(floor(yLo / float(CELL))) - 2), gyB = min(uCells.w, int(ceil(yHi / float(CELL))) + 2);
  int gy = -1;
  float d = 0.0, zs = 0.0, depthHere = 0.0;
  for (int g = gyB; g >= gyA; g--) {
    ivec2 c = ivec2(gx, g);
    vec4 st = wStatic(c);
    float dd = wDepth(c);
    if (st.g != 0.0 || dd < 0.04) continue;
    float z = st.r + dd;
    float north = float(g * CELL + CELL), south = float(g * CELL);
    int sy0 = int(jsRound(uOriginY - uA * north - z));
    int sy1 = max(sy0 + 1, int(jsRound(uOriginY - uA * south - z)));
    if (sy < sy0 || sy >= sy1) continue;
    float dh = ((north + south) / 2.0) * uF1 + z * uF2;
    if (dh >= sd - 0.3) continue;
    gy = g; d = dd; zs = z; depthHere = dh;
    break;
  }
  if (gy < 0) return;
  ivec2 c = ivec2(gx, gy);
  bool basin = wStatic(c).b != 0.0;
  float sE = gx < uGrid.x - 1 ? sAt(c + ivec2(1, 0), zs) : zs;
  float sW = gx > 0 ? sAt(c - ivec2(1, 0), zs) : zs;
  float sN = gy < uGrid.y - 1 ? sAt(c + ivec2(0, 1), zs) : zs;
  float sS = gy > 0 ? sAt(c - ivec2(0, 1), zs) : zs;
  float sx = (sE - sW) / float(2 * CELL), syl = (sN - sS) / float(2 * CELL);
  float lap = (sE + sW + sS + sN - 4.0 * zs) / float(CELL * CELL);
  float nx = -sx, ny = -syl, nz = 1.0, nl = length(vec3(nx, ny, nz));
  float keyL = (nx * -0.5 + ny * 0.5 + nz * 0.7) / nl - 0.7;
  int tone = d > 4.5 ? 2 : 3;
  if (keyL > 0.04) tone += 1; else if (keyL < -0.04) tone -= 1;
  float steep = length(vec2(sx, syl));
  if (steep > 0.45) tone = 4;
  if (d < 0.6 && !basin) tone = 3;
  tone = clamp(tone, 0, 4);
  vec3 tc = uTones[tone];
  float alpha = !basin ? min(0.6, d) : d >= 1.5 ? 1.0 : min(1.0, 0.45 + d * 0.35 + (tone == 4 ? 0.4 : 0.0));
  vec3 lt = uAmbient * vec3(1.25, 1.25, 1.3);
  vec3 sp3 = vec3(0.0);
  float spec = 0.0;
  float caustic = 1.0 + clamp(-lap * 6.0, -0.6, 2.5);
  if (uLights) for (int i = 0; i < uNLights; i++) {
    vec4 lp = lightPos(i);
    float cx = float(gx * CELL + 1), cy = float(gy * CELL + 1);
    float dx = lp.x - cx, dy = lp.y - cy, dz = lp.z - zs;
    if (dx > lp.w || dx < -lp.w || dy > lp.w || dy < -lp.w) continue;
    float dist = length(vec3(dx, dy, dz));
    if (dist >= lp.w) continue;
    float q = 1.0 - dist / lp.w;
    float kk = q * q * lightCol(i).w * spot(i, -vec3(dx, dy, dz));
    if (kk <= 0.0) continue;
    vec3 L = vec3(dx, dy, dz) / dist;
    float ndl = max(0.0, dot(vec3(nx, ny, nz), L) / nl);
    lt += lightCol(i).rgb * kk * (0.4 + 0.6 * ndl);
    vec3 h = vec3(L.x, L.y + uVy, L.z + uVz);
    float ndh = max(0.0, dot(vec3(nx, ny, nz), h) / (nl * length(h)));
    float sp = pow(ndh, 160.0) * kk * 3.0;
    if (sp > 0.02) { spec += sp; sp3 += lightCol(i).rgb * sp; }
  }
  int shift = int(clamp(jsRound(sx * 5.0), -2.0, 2.0));
  int vw = uViewSize.x;
  float aBayer = float(BAYER[(px & 3) + ((sy & 3) << 2)]) / 16.0;
  if (aBayer >= alpha) {
    // Se ve el fondo a través del agua: refractado, algo azulado y con las cáusticas
    ivec2 t2 = ivec2(clamp(t.x + shift, 0, vw - 1), t.y);
    vec3 b = texelFetch(uSrcColor, t2, 0).rgb;
    oColor = vec4(b.r * 0.85, b.g * 0.92, min(1.0, b.b * 1.05), 1.0);
    if (uLights) oLight = vec4(uAmbient + (texelFetch(uSrcLight, t2, 0).rgb - uAmbient) * caustic, 0.0);
    return;
  }
  // Superficie: su color, el reflejo de lo que tiene encima y el brillo de las fuentes
  vec3 cc = tc;
  vec3 ltt = lt + sp3;
  int col = clamp(t.x + shift, 0, vw - 1);
  for (int k = 2; k <= MARCH; k += 2) {
    if (t.y - k < 0) break;
    float sdk = srcDepthAt(col, t.y - k);
    if (!(!isinf(sdk) && sdk < depthHere + float(k) * uTPerPx * uDPerT - 0.5)) continue;
    int k1 = k - 1;
    float prev = srcDepthAt(col, t.y - k1);
    int kk = !isinf(prev) && prev < depthHere + float(k1) * uTPerPx * uDPerT - 0.5 ? k1 : k;
    ivec2 rt = ivec2(col, t.y - kk);
    float m = REFLECT * (tone == 4 ? 0.3 : 1.0);
    cc += (texelFetch(uSrcColor, rt, 0).rgb * 255.0 - cc) * m;
    if (uLights) ltt += (texelFetch(uSrcLight, rt, 0).rgb - ltt) * m;
    break;
  }
  if (spec > 0.35) cc = uTones[4];
  oColor = vec4(clamp(cc / 255.0, 0.0, 1.0), 1.0);
  oDepth = vec4(depthHere, 0.0, 0.0, 0.0);
  if (uLights) oLight = vec4(ltt, 0.0);
}`;

// ---- 3) Las gotas: puntos ya proyectados (x, y de la vista y profundidad); tapadas si hay algo delante
export const VERT_DROPS = `#version 300 es
in vec3 aPos;
uniform vec2 uViewSize;
out float vDepth;
void main() {
  vDepth = aPos.z;
  gl_Position = vec4((aPos.xy + 0.5) / uViewSize * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

export const FRAG_DROPS = `${HEADER}
uniform sampler2D uDepthNow;
uniform vec3 uDropColor;
uniform vec3 uDropLight;
uniform bool uLights;
in float vDepth;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
void main() {
  if (vDepth >= texelFetch(uDepthNow, ivec2(gl_FragCoord.xy), 0).r - 0.3) discard;
  oColor = vec4(uDropColor, 1.0);
  oLight = vec4(uDropLight, 0.0);
}`;

// ---- 4) La luz a pixel art (buildLayers + applyLayers, con steps 8 y brillo suave) y al lienzo
export const FRAG_SHADE = `${HEADER}
uniform sampler2D uColorTex;
uniform sampler2D uLightTex;
uniform bool uLights;
uniform vec3 uAmbient;
uniform int uMode;                  // 0 cuadro, 1 color sin luz, 2 capa multiply, 3 capa add
uniform bool uFlip;
uniform int uHeight;
out vec4 oColor;

const int BAYER[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
const int STEPS = 8;
const float GLOW = 0.4;

float quantize(float v, int steps, float threshold) {
  float top = float(steps - 1);
  return min(top, max(0.0, floor(v * top + threshold))) / top;
}

void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  if (uFlip) t.y = uHeight - 1 - t.y;
  vec3 scene = floor(texelFetch(uColorTex, t, 0).rgb * 255.0 + 0.5);
  if (uMode == 1 || !uLights) { oColor = vec4(scene / 255.0, 1.0); return; }
  vec3 tot = texelFetch(uLightTex, t, 0).rgb;
  float threshold = (float(BAYER[(t.y & 3) * 4 + (t.x & 3)]) + 0.5) / 16.0;
  float lum = 0.3 * tot.r + 0.6 * tot.g + 0.1 * tot.b;
  float soft = quantize(min(1.0, max(0.0, lum - 1.0) * GLOW), STEPS * 2, 0.5);
  float peak = max(max(tot.r, tot.g), max(tot.b, 1e-6));
  vec3 mul, add;
  for (int ch = 0; ch < 3; ch++) {
    float tt = tot[ch];
    float base = min(1.0, uAmbient[ch]);
    float room = 1.0 - base;
    float lit = room > 0.0 ? quantize(min(1.0, max(0.0, tt - base) / room), STEPS, threshold) * room : 0.0;
    mul[ch] = floor((base + lit) * 255.0 + 0.5);
    add[ch] = floor(soft * min(1.0, tt / peak) * 255.0 + 0.5);
  }
  mul = clamp(mul, 0.0, 255.0); add = clamp(add, 0.0, 255.0);
  if (uMode == 2) { oColor = vec4(mul / 255.0, 1.0); return; }
  if (uMode == 3) { oColor = vec4(add / 255.0, 1.0); return; }
  oColor = vec4(clamp(roundEven(scene * mul / 255.0 + add), 0.0, 255.0) / 255.0, 1.0);
}`;


// ---- 0) Las entidades: un quad por entidad (instanciado) con su sprite del atlas, su luz por cara y el z-buffer de
// la GPU (gana la más cercana; en un empate, la primera). Su luz es la de lightField3D (src/core/light3d.ts): por
// cara de vóxel, con el rayo contra su propio cuerpo, en los ejes de su modelo sin girar.
export const VERT_ENTITY = `#version 300 es
in vec2 aCorner;                     // 0..1
in vec4 aPlace;                      // x, y del lienzo en la vista, capa del atlas, dOff
in vec4 aPos;                        // pies + 0.5 en x, y, z + bote, giro (radianes)
in vec4 aOcc;                        // x en el atlas de cuerpos, mínimo del cuerpo (x, y, z)
in vec4 aOccSize;                    // tamaño del cuerpo, w = 1 si lleva luz
in vec2 aMask;                       // qué luces la alumbran (bits 0-15 y 16-31), con tope de luces por entidad
in vec4 aTint;                       // tinte plano (r, g, b) y w = 1 si lo lleva (Entity.tint)
uniform vec2 uViewSize;
uniform vec2 uCell;
flat out vec4 vPlace;
flat out vec4 vPos;
flat out vec4 vOcc;
flat out vec4 vOccSize;
flat out uint vMask;
flat out vec4 vTint;
void main() {
  vPlace = aPlace; vPos = aPos; vOcc = aOcc; vOccSize = aOccSize; vTint = aTint;
  vMask = uint(aMask.x) | (uint(aMask.y) << 16u);
  vec2 p = aPlace.xy + aCorner * uCell;
  gl_Position = vec4(p / uViewSize * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG_ENTITY = `${HEADER}
#define MAXL ${MAX_LIGHTS}
precision highp usampler2DArray;
uniform sampler2DArray uSprColor;
uniform sampler2DArray uSprDepth;
uniform usampler2DArray uSprVox;       // vóxel (x, y, z + 128) y cara (255 = ninguna) de cada píxel
uniform sampler3D uBody;               // los cuerpos (sin girar), uno detrás de otro en x
uniform bool uLights;
uniform vec3 uAmbient;
uniform vec3 uDirs[6];
uniform int uNLights;
uniform vec2 uDepthRange;              // profundidad mínima de este cuadro y 1 / su rango (para el z-buffer)
${LIGHT_TABLE}
flat in vec4 vPlace;
flat in vec4 vPos;
flat in vec4 vOcc;
flat in vec4 vOccSize;
flat in uint vMask;
flat in vec4 vTint;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oLight;
layout(location = 2) out vec4 oDepth;

float facing(float ndl) { return ndl > 0.0 ? 0.35 + 0.65 * ndl : 0.0; }

bool filled(ivec3 c) {
  ivec3 v = c - ivec3(vOcc.yzw);
  if (any(lessThan(v, ivec3(0))) || any(greaterThanEqual(v, ivec3(vOccSize.xyz)))) return false;
  return texelFetch(uBody, ivec3(v.x + int(vOcc.x), v.y, v.z), 0).r > 0.0;
}

// ¿Hay un vóxel del cuerpo entre p (en el aire) y la luz? Amanatides-Woo como en light3d.ts, recortado a la caja del
// cuerpo (fuera de ella no hay nada que tape)
bool occluded(vec3 p0, vec3 l0) {
  vec3 p = p0 + vec3(1.0, 2.0, 3.0) / 1024.0;   // RAY_NUDGE de light3d.ts
  vec3 l = l0 + vec3(3.0, 1.0, 2.0) / 1024.0;   // LIGHT_NUDGE
  vec3 d = l - p;
  vec3 mn = vOcc.yzw, mx = vOcc.yzw + vOccSize.xyz;
  float tExit = 1.0;
  for (int i = 0; i < 3; i++) {
    if (abs(d[i]) < 1e-9) { if (p[i] < mn[i] || p[i] > mx[i]) return false; continue; }
    float a = (mn[i] - p[i]) / d[i], b = (mx[i] - p[i]) / d[i];
    tExit = min(tExit, max(a, b));
  }
  ivec3 c = ivec3(floor(p)), tc = ivec3(floor(l));
  ivec3 st = ivec3(sign(d));
  vec3 dd = vec3(st.x != 0 ? abs(1.0 / d.x) : 1e30, st.y != 0 ? abs(1.0 / d.y) : 1e30, st.z != 0 ? abs(1.0 / d.z) : 1e30);
  vec3 m = vec3(
    st.x != 0 ? (st.x > 0 ? float(c.x) + 1.0 - p.x : p.x - float(c.x)) * dd.x : 1e30,
    st.y != 0 ? (st.y > 0 ? float(c.y) + 1.0 - p.y : p.y - float(c.y)) * dd.y : 1e30,
    st.z != 0 ? (st.z > 0 ? float(c.z) + 1.0 - p.z : p.z - float(c.z)) * dd.z : 1e30);
  for (int i = 0; i < 160; i++) {
    if (c == tc) return false;
    if (min(m.x, min(m.y, m.z)) > tExit) return false;
    if (m.x <= m.y && m.x <= m.z) { if (m.x > 1.0) return false; c.x += st.x; m.x += dd.x; }
    else if (m.y <= m.z) { if (m.y > 1.0) return false; c.y += st.y; m.y += dd.y; }
    else { if (m.z > 1.0) return false; c.z += st.z; m.z += dd.z; }
    if (c == tc) return false;
    if (filled(c)) return true;
  }
  return false;
}

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy) - ivec2(vPlace.xy);
  int layer = int(vPlace.z);
  vec4 c = texelFetch(uSprColor, ivec3(ij, layer), 0);
  if (c.a == 0.0) discard;
  float depth = texelFetch(uSprDepth, ivec3(ij, layer), 0).r + vPlace.w;
  gl_FragDepth = clamp((depth - uDepthRange.x) * uDepthRange.y, 0.0, 1.0);
  vec3 total = uAmbient;
  uvec4 vx = texelFetch(uSprVox, ivec3(ij, layer), 0);
  if (vTint.w > 0.5 && vx.a != 255u) { c.rgb = vTint.rgb; total = vec3(${EMISSIVE}); }   // tinte plano (Entity.tint)
  else if (vx.a != 255u && (vx.a & 128u) != 0u) total = vec3(${EMISSIVE});    // emisivo: su propia luz (frame2d.ts)
  else if (uLights && vOccSize.w != 0.0 && vx.a != 255u) {
    vec3 v = vec3(vx.rgb) - 128.0;
    vec3 n = uDirs[int(vx.a & 127u)];
    vec3 p = v + 0.5 + n * 0.5, start = v + 0.5 + n;
    float cs = cos(vPos.w), sn = sin(vPos.w);
    for (int i = 0; i < uNLights; i++) {
      if ((vMask & (1u << uint(i))) == 0u) continue;                 // fuera del tope de luces de esta entidad
      vec4 lp = lightPos(i), lc = lightCol(i);
      float dx = lp.x - vPos.x, dy = lp.y - vPos.y;
      vec3 l = vec3(dx * cs + dy * sn + 0.5, -dx * sn + dy * cs, lp.z - vPos.z);
      if (length(l.xy) >= lp.w + 20.0) continue;
      vec3 w = l - p;
      float d = length(w);
      if (d >= lp.w || lc.w <= 0.0) continue;
      float f = d < 1e-6 ? 1.0 : facing(dot(n, w) / d);
      if (f <= 0.0) continue;
      float k = 1.0 - d / lp.w;
      vec3 sd = lightSpot(i).xyz;                                     // el cono, girado a los ejes del modelo
      float att = k * k * lc.w * f * spotOf(i, p - l, vec3(sd.x * cs + sd.y * sn, -sd.x * sn + sd.y * cs, sd.z));
      if (att < 0.002) continue;
      if (occluded(start, l)) continue;
      total += lc.rgb * att;
    }
  }
  oColor = vec4(c.rgb, 1.0);
  oLight = vec4(total, 0.0);
  oDepth = vec4(depth, 0.0, 0.0, 0.0);
}`;

// ---- 0b) Las sombras de contacto: una elipse bajo los pies de cada entidad que multiplica la luz del suelo
export const VERT_CONTACT = `#version 300 es
in vec2 aCorner;
in vec3 aFeet;                       // pies en la vista (x, y) y radio vertical
uniform vec2 uViewSize;
flat out vec3 vFeet;
void main() {
  vFeet = aFeet;
  float cy = ceil(aFeet.z);
  vec2 p = aFeet.xy + vec2(-6.0, -cy) + aCorner * vec2(13.0, 2.0 * cy + 1.0);
  gl_Position = vec4(p / uViewSize * 2.0 - 1.0, 0.0, 1.0);
}`;

export const FRAG_CONTACT = `${HEADER}
flat in vec3 vFeet;
out vec4 oFactor;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) - ivec2(vFeet.xy);
  float ex = float(q.x) / 6.5, ey = float(q.y) / vFeet.z;
  if (ex * ex + ey * ey > 1.0) discard;
  oFactor = vec4(0.7, 0.7, 0.72, 1.0);
}`;
