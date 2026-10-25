import { key, type VoxelSource } from './model';
import { decode, rampOf, rgbOf, allowedColors, type Palette } from './palette';

// Render de vóxeles a pixel art por software. Determinista: mismo modelo y mismas opciones, mismos bytes.
//
// Cámara ortográfica: el modelo gira `yaw` grados sobre el eje vertical alrededor del pivote (los pies) y
// la cámara mira hacia el norte (+y) inclinada `elevation` grados hacia abajo. 1 vóxel = 1 píxel.
// El pivote cae SIEMPRE en el mismo punto de la imagen (centro de la columna originX, borde de la fila originY): el personaje no salta
// al girar ni entre frames (condición de MAIA).
//
// Luz: una dirección fija en PANTALLA (arriba-izquierda, como el juego), así que al girar el modelo la luz no
// gira con él. La sombra proyectada usa la MISMA dirección. La luz no multiplica colores: mueve el tono
// dentro de la rampa del material, así que la imagen solo tiene colores de la paleta.

export interface RenderOptions {
  width: number;
  height: number;
  originX: number;              // columna de píxeles cuyo centro recibe el pivote (entero)
  originY: number;              // fila bajo los pies: los pies ocupan la fila originY - 1
  yaw?: number;                 // grados; 0 = el modelo mira a la cámara (su frente es -y)
  elevation?: number;           // grados sobre el horizonte; 0 = de frente, 90 = cenital
  zScale?: number;              // estirado vertical; por defecto 1/cos(elevation): la altura en píxeles = la altura en vóxeles
  pivot?: [number, number, number];   // por defecto (0.5, 0.5, 0): el centro de la base del vóxel (0, 0, 0)
  light?: [number, number, number];   // hacia la luz, en ejes de pantalla: x derecha, y arriba, z hacia el espectador
  smooth?: number;              // 0 = normales de cara (facetado), 1 = normal suavizada del entorno
  thresholds?: { lit: number; mid: number };   // intensidad para subir un tono (lit) o quedarse en el base (mid)
  ao?: boolean;                 // oclusión ambiental: un tono menos en rincones
  shadows?: boolean;            // sombra proyectada por el propio modelo
  flat?: boolean;               // sombreado ya pintado en los colores (arte hecho a mano): no mueve el tono
  outline?: 'none' | 'outer' | 'both';
  innerGap?: number;            // salto de profundidad para el contorno interior
  outlineColor?: string;        // color fijo del contorno (#rrggbb); si no, el de la paleta o el tono 0 de la rampa vecina
  ppu?: number;                 // píxeles por vóxel (1 = pixel art final; más = zoom del editor)
  pick?: boolean;               // devolver qué vóxel y qué cara se ve en cada píxel (para editar en 3D)
  // Proyección oblicua del pixel art 3/4 (la del juego): cada vóxel hacia el norte sube `y` píxeles y cada vóxel
  // de altura sube `z` píxeles, sin acortar. Con { y: 1, z: 1 } una loseta mide 16x16 y una pared de 32 sube 32.
  // Sustituye a elevation/zScale.
  oblique?: { y: number; z: number };
}

export interface Rendered {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;   // listo para ImageData o PNG
  depth: Float32Array;          // Infinity = vacío
  pickKey?: Float64Array;       // clave del vóxel visible en cada píxel (NaN = nada)
  pickFace?: Int8Array;         // cara visible: índice en DIRS (-1 = nada)
}

export const DIR_VECTORS: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// La cámara de un render: proyección de un punto del modelo a la imagen y, al revés, qué celda del suelo
// (z = 0) cae bajo un píxel. La usan el render y el editor 3D, así que siempre coinciden.
export interface Camera {
  project(x: number, y: number, z: number): [number, number, number];
  groundAt(sx: number, sy: number): [number, number] | null;
  groundPoint(sx: number, sy: number): [number, number] | null;   // punto exacto del suelo (z = 0) bajo un píxel
  yawCos: number;
  yawSin: number;
  up: [number, number, number];
  fwd: [number, number, number];
  zScale: number;               // lo que se estira z (1 en oblicua)
  pivot: [number, number, number];
  ppu: number;
}

export function camera(o: RenderOptions): Camera {
  const yaw = ((o.yaw ?? 0) * Math.PI) / 180;
  const elev = ((o.elevation ?? 30) * Math.PI) / 180;
  const zScale = o.zScale ?? 1 / Math.cos(elev);
  const [pvx, pvy, pvz] = o.pivot ?? [0.5, 0.5, 0];
  const ppu = o.ppu ?? 1;
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  let se = Math.sin(elev), ce = Math.cos(elev);
  let up: [number, number, number] = [0, se, ce];
  let fwd: [number, number, number] = [0, ce, -se];
  let zs = zScale;
  if (o.oblique) {
    // pantalla y = -(a*y + b*z): los puntos que caen en el mismo píxel están sobre (0, b, -a), que es la dirección
    // de la vista (para la profundidad y para saber qué caras se ven)
    const { y: a, z: b } = o.oblique;
    const l = Math.hypot(a, b);
    up = [0, a, b]; fwd = [0, b / l, -a / l]; zs = 1; se = a / l; ce = b / l;
  }
  return {
    yawCos: cos, yawSin: sin, up, fwd, zScale: zs, pivot: [pvx, pvy, pvz], ppu,
    project(x, y, z) {
      const px = x - pvx, py = y - pvy, pz = (z - pvz) * zs;
      const wx = px * cos - py * sin, wy = px * sin + py * cos;
      return [wx * ppu + o.originX + 0.5, -(wy * up[1] + pz * up[2]) * ppu + o.originY, wy * fwd[1] + pz * fwd[2]];
    },
    groundPoint(sx, sy) {
      if (se < 1e-3) return null;                       // de frente, el suelo no se ve
      const wx = (sx - o.originX - 0.5) / ppu;
      const pz = (0 - pvz) * zs;
      const wy = (-(sy - o.originY) / ppu - pz * up[2]) / up[1];
      // mundo girado -> modelo
      return [wx * cos + wy * sin + pvx, -wx * sin + wy * cos + pvy];
    },
    groundAt(sx, sy) {
      const p = this.groundPoint(sx, sy);
      return p ? [Math.floor(p[0]), Math.floor(p[1])] : null;
    },
  };
}

const DIRS = DIR_VECTORS;
// Esquinas de cada cara del cubo unidad [0,1]^3, en orden de vuelta
const FACE_CORNERS: Array<Array<[number, number, number]>> = [
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
];

// Los dos ejes del plano de cada cara (para la oclusión ambiental)
const PLANE: Array<[[number, number, number], [number, number, number]]> = [
  [[0, 1, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 1, 0]],
];

// Las muestras se toman un poco desplazadas del centro del píxel (fracción binaria exacta): los bordes de
// vóxel que caen justo en .5 se deciden siempre igual, sin ensanchar la silueta
const SAMPLE = 0.5 + 1 / 1024;
// Por debajo de esto, la suma de la normal suavizada es cero (el mínimo real, un vecino lleno a distancia 3, es ~0,02)
export const SMOOTH_EPS = 1e-3;

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

// La luz y la dirección de la vista en los ejes del modelo (las usan la CPU y la GPU)
export function renderBasis(o: RenderOptions): { cam: Camera; Lm: [number, number, number]; viewM: [number, number, number] } {
  const cam = camera(o);
  const cos = cam.yawCos, sin = cam.yawSin;
  // Base de la cámara en el mundo ya girado: derecha, arriba de pantalla, hacia dentro de la pantalla
  const fwd = cam.fwd;
  const ul = Math.hypot(cam.up[1], cam.up[2]) || 1;
  const up: [number, number, number] = [0, cam.up[1] / ul, cam.up[2] / ul];

  // Mundo -> modelo (para pasar la luz y la vista a los ejes del modelo)
  const toModel = (v: [number, number, number]): [number, number, number] => [v[0] * cos + v[1] * sin, -v[0] * sin + v[1] * cos, v[2]];

  const Ls = norm(o.light ?? [-0.6, 0.75, 0.75]);
  // Luz de pantalla -> mundo girado -> modelo
  const Lw: [number, number, number] = [Ls[0], Ls[1] * up[1] - Ls[2] * fwd[1], Ls[1] * up[2] - Ls[2] * fwd[2]];
  return { cam, Lm: norm(toModel(Lw)), viewM: toModel(fwd) };
}

export function render(model: VoxelSource, o: RenderOptions): Rendered {
  const { cam, Lm, viewM } = renderBasis(o);
  const smooth = o.smooth ?? 0.6;
  const th = o.thresholds ?? { lit: 0.72, mid: 0.3 };
  const { width: W, height: H } = o;

  const project = cam.project;

  const depth = new Float32Array(W * H).fill(Infinity);
  const color = new Int32Array(W * H).fill(-1);       // índice de color plano: rampa*16 + tono
  const pickKey = o.pick ? new Float64Array(W * H).fill(NaN) : null;
  const pickFace = o.pick ? new Int8Array(W * H).fill(-1) : null;
  const filled = (x: number, y: number, z: number) => model.get(x, y, z) !== 0;

  const pal = model.palette;
  const toneCache = new Map<number, number>();

  for (const [x, y, z, v] of model.entries()) {
    for (let f = 0; f < 6; f++) {
      const d = DIRS[f]!;
      if (filled(x + d[0], y + d[1], z + d[2])) continue;
      if (dot(d, viewM) >= -1e-9) continue;          // cara de espaldas a la cámara

      const shade = toneFor(x, y, z, f, v);
      const pts = FACE_CORNERS[f]!.map(([cx, cy, cz]) => project(x + cx, y + cy, z + cz));
      const k = key(x, y, z);
      raster(pts[0]!, pts[1]!, pts[2]!, shade, k, f);
      raster(pts[0]!, pts[2]!, pts[3]!, shade, k, f);
    }
  }

  function toneFor(x: number, y: number, z: number, f: number, v: number): number {
    if (o.flat) { const { ramp, tone } = decode(v); return ramp * 16 + tone; }
    const k = key(x, y, z) * 8 + f;
    const hit = toneCache.get(k);
    if (hit !== undefined) return hit;
    const d = DIRS[f]!;
    // Normal suavizada: apunta hacia el aire del entorno (radio 3), mezclada con la de la cara
    let sx = 0, sy = 0, sz = 0;
    if (smooth > 0) for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      if (!dx && !dy && !dz) continue;
      if (filled(x + dx, y + dy, z + dz)) continue;
      const w = 1 / (dx * dx + dy * dy + dz * dz);
      sx += dx * w; sy += dy * w; sz += dz * w;
    }
    // Con el aire alrededor simétrico (un vóxel suelto) la suma se anula: lo que quede son restos de coma flotante,
    // sin dirección; se toma como cero (la normal de la cara)
    const sn: [number, number, number] = Math.hypot(sx, sy, sz) < SMOOTH_EPS ? [0, 0, 0] : norm([sx, sy, sz]);
    const n = norm([d[0] * (1 - smooth) + sn[0] * smooth, d[1] * (1 - smooth) + sn[1] * smooth, d[2] * (1 - smooth) + sn[2] * smooth]);
    let I = Math.max(0, dot(n, Lm));
    if ((o.shadows ?? true) && inShadow(x + d[0], y + d[1], z + d[2])) I = Math.min(I, th.mid - 0.01);
    let level = I >= th.lit ? 1 : I >= th.mid ? 0 : -1;
    if (o.ao ?? true) {
      // Celdas que rodean el hueco frente a la cara, en el plano de la cara
      let occ = 0;
      const [u, w] = PLANE[f]!;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        if (!a && !b) continue;
        if (filled(x + d[0] + a * u[0] + b * w[0], y + d[1] + a * u[1] + b * w[1], z + d[2] + a * u[2] + b * w[2])) occ++;
      }
      if (occ >= 5) level -= 1;
    }
    const { ramp, tone } = decode(v);
    const r = rampOf(pal, ramp);
    const t = Math.max(0, Math.min(r.colors.length - 1, tone + level));
    const out = ramp * 16 + t;
    toneCache.set(k, out);
    return out;
  }

  // Rayo por la rejilla hacia la luz (DDA). Empieza en la celda vacía frente a la cara.
  function inShadow(cx: number, cy: number, cz: number): boolean {
    let x = cx, y = cy, z = cz;
    const sx = Math.sign(Lm[0]), sy = Math.sign(Lm[1]), sz = Math.sign(Lm[2]);
    const tdx = sx ? Math.abs(1 / Lm[0]) : Infinity, tdy = sy ? Math.abs(1 / Lm[1]) : Infinity, tdz = sz ? Math.abs(1 / Lm[2]) : Infinity;
    let tx = tdx / 2, ty = tdy / 2, tz = tdz / 2;
    for (let i = 0; i < 96; i++) {
      if (tx <= ty && tx <= tz) { x += sx; tx += tdx; } else if (ty <= tz) { y += sy; ty += tdy; } else { z += sz; tz += tdz; }
      if (filled(x, y, z)) return true;
    }
    return false;
  }

  function raster(a: [number, number, number], b: [number, number, number], c: [number, number, number], shade: number, vk: number, face: number): void {
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) < 1e-12) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    for (let j = minY; j <= maxY; j++) for (let i = minX; i <= maxX; i++) {
      const px = i + SAMPLE, py = j + SAMPLE;
      let w0 = (b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px);
      let w1 = (c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px);
      let w2 = (a[0] - px) * (b[1] - py) - (a[1] - py) * (b[0] - px);
      if (area < 0) { w0 = -w0; w1 = -w1; w2 = -w2; }
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const s = Math.abs(area);
      const z = (w0 * a[2] + w1 * b[2] + w2 * c[2]) / s;
      const idx = j * W + i;
      if (z < depth[idx]! - 1e-6) {
        depth[idx] = z; color[idx] = shade;
        if (pickKey) { pickKey[idx] = vk; pickFace![idx] = face; }
      }
    }
  }

  return finishRender(pal, o, color, depth, pickKey, pickFace);
}

// Lo que sigue al rasterizado, común a la CPU y a la GPU (src/view/gpu/voxrender.ts): los contornos y los colores.
// `color` es el índice plano de cada píxel (rampa*16 + tono; -1 = vacío) y `depth` su profundidad.
export function finishRender(pal: Palette, o: RenderOptions, color: Int32Array, depth: Float32Array, pickKey: Float64Array | null, pickFace: Int8Array | null): Rendered {
  const { width: W, height: H } = o;
  // Contornos
  const mode = o.outline ?? 'outer';
  const final = Int32Array.from(color);
  const OUTLINE = -2;
  if (mode === 'both') {
    const gap = o.innerGap ?? 2.5;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      if (color[idx]! < 0) continue;
      for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const n = nj * W + ni;
        if (color[n]! >= 0 && depth[n]! < depth[idx]! - gap) { final[idx] = o.outlineColor ? OUTLINE : (color[idx]! & ~15); break; }   // tono 0 de su rampa
      }
    }
  }
  const outlineOf = new Int32Array(W * H).fill(-1);
  if (mode !== 'none') {
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      if (color[idx]! >= 0) continue;
      for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
        const n = color[nj * W + ni]!;
        if (n >= 0) { final[idx] = OUTLINE; outlineOf[idx] = n; break; }
      }
    }
  }

  const rgba = new Uint8ClampedArray(W * H * 4);
  const outlineRgb = o.outlineColor ? rgbOf(o.outlineColor) : pal.outline ? rgbOf(pal.outline) : null;
  for (let p = 0; p < W * H; p++) {
    const c = final[p]!;
    if (c === -1) continue;
    let rgb: [number, number, number];
    if (c === OUTLINE) rgb = outlineRgb ?? rgbOf(rampOf(pal, outlineOf[p]! >> 4).colors[0]!);
    else rgb = rgbOf(rampOf(pal, c >> 4).colors[c & 15]!);
    rgba[p * 4] = rgb[0]; rgba[p * 4 + 1] = rgb[1]; rgba[p * 4 + 2] = rgb[2]; rgba[p * 4 + 3] = 255;
  }
  return { width: W, height: H, rgba, depth, ...(pickKey ? { pickKey, pickFace: pickFace! } : {}) };
}

// Comprueba que la imagen solo usa colores de la paleta (y alfa 0 o 255). Lanza si no.
export function assertClosedPalette(img: Rendered, model: VoxelSource): void {
  const ok = allowedColors(model.palette);
  for (let p = 0; p < img.width * img.height; p++) {
    const a = img.rgba[p * 4 + 3]!;
    if (a === 0) continue;
    if (a !== 255) throw new Error(`alfa parcial en el píxel ${p}`);
    const hex = '#' + [0, 1, 2].map((k) => img.rgba[p * 4 + k]!.toString(16).padStart(2, '0')).join('');
    if (!ok.has(hex)) throw new Error(`color fuera de la paleta: ${hex} en el píxel ${p % img.width},${Math.floor(p / img.width)}`);
  }
}

// ---- encuadre
// El de los sprites del juego (64x48 con el pivote en 32,42) si el modelo cabe en él en cualquier giro; si no, uno
// que lo contiene girando: el radio de su caja alrededor del pivote y su altura. No depende del giro, así que al girar
// la vista no salta. Lo usan la vista previa y la exportación de la app y la CLI cuando no se le da --size.
export interface Frame { W: number; H: number; originX: number; originY: number }
export const SPRITE_FRAME: Frame = { W: 64, H: 48, originX: 32, originY: 42 };
export function fitFrame(b: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null, elevation: number): Frame {
  if (!b) return SPRITE_FRAME;
  let R = 0;
  for (const x of [b.minX, b.maxX + 1]) for (const y of [b.minY, b.maxY + 1]) R = Math.max(R, Math.hypot(x - 0.5, y - 0.5));
  const se = Math.sin((elevation * Math.PI) / 180);
  const top = R * se + Math.max(0, b.maxZ + 1), bottom = R * se - Math.min(0, b.minZ);
  const M = 2;                                        // el contorno y un poco de aire
  if (R + M <= 31 && top + M <= 42 && bottom + M <= 6) return SPRITE_FRAME;
  const half = Math.ceil(R) + M;
  const originY = Math.ceil(top) + M;
  return { W: half * 2, H: originY + Math.ceil(bottom) + M, originX: half, originY };
}
