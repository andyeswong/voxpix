// Horneado de un mundo de vóxeles para jugarlo en 2D: se renderiza (imagen + profundidad + qué vóxel y qué cara hay
// en cada píxel) y, por cada luz fija, su peso en cada píxel de su zona, con la caída del juego, el ángulo con la
// cara y la sombra de los propios vóxeles. Por cuadro solo queda sumar las luces con su parpadeo (lightView).
//
// Si cambian vóxeles a mitad de partida, rebake() rehace SOLO lo afectado: el recuadro de pantalla de los trozos
// cambiados, la rejilla de sombras de esas columnas y los pesos de las luces que los alcanzan. El resultado es el
// mismo, byte a byte, que hornear el mundo entero de nuevo (hay prueba).
import { render, camera, unkey, decode, DIR_VECTORS, facingOf, materialsOf, type RenderOptions, type Camera, type VoxelSource } from '../core';
import { resolveLight } from './lightutil';
import { CHUNK, type StaticVoxels } from './state';
import type { Box3 } from './changes';
import type { WorldLight } from './build';
import type { LightId } from './state';

export interface BakedLight {
  light: WorldLight;
  color: readonly [number, number, number];
  intensity: number;
  rect: { x: number; y: number; w: number; h: number };   // zona de la imagen donde alumbra
  weight: Float32Array;                                    // peso por píxel de la zona (con la intensidad base)
  // Si se rehízo solo en parte sobre los pesos de otra (el rehorneado de lo cambiado): esa (base), y el recuadro de la
  // zona que pudo cambiar (dirty, relativo a rect). Quien guarda una copia de la base solo tiene que poner al día ese
  // recuadro (la GPU); de cualquier otra, la zona entera
  base?: BakedLight;
  dirty?: { x: number; y: number; w: number; h: number };
}

export interface Baked {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  depth: Float32Array;
  face: Int8Array;              // qué cara se ve en cada píxel (índice en DIR_VECTORS; -1 = nada)
  pick: Float64Array;           // qué vóxel se ve en cada píxel (clave; NaN = nada)
  options: RenderOptions;
  cam: Camera;
  lights: BakedLight[];
  version: number;              // versión del mundo horneada (para rebakeChanged)
  ms: { render: number; light: number };
  // Para rehornear: el mundo, su rejilla de sombras y el alto máximo
  source: StaticVoxels;
  occ: Uint8Array;              // OBSOLETO, vacío: las sombras leen los vóxeles (source) directamente
  topZ: number;
  // Lo que se ha publicado desde el horneado (para quien guarda una copia, p. ej. las texturas de la GPU): cada
  // recuadro rehorneado con su número de serie. Solo se guardan los últimos; quien se quede atrás lo recarga todo.
  published: { serial: number; rects: Array<{ serial: number; x0: number; y0: number; x1: number; y1: number }> };
  // Las fijas nuevas que se están horneando (rebakeJobs): no se vuelven a pedir, y si se quitan antes de acabar, su
  // trabajo no las publica
  pendingLights?: Set<LightId>;
}

// Lo mínimo que necesita el horneado de un mundo
export interface Bakeable {
  model: StaticVoxels;
  lights: readonly WorldLight[];
  width: number;
  depth: number;
}

const BASIN_DEPTH = 10;   // las cuencas del agua bajan hasta z = -8: la imagen se alarga por abajo

// Proyección oblicua 3/4: la altura sube 1:1 y el suelo se acorta por `incline` (1 = sin acortar, como los tiles
// del juego; 0.5 = losetas de 16x8, que deja ver a los personajes de frente con un poco de cabeza). Personajes y
// escenario usan la MISMA proyección. La imagen tiene el norte arriba.
// outline: el contorno del render ('both' marca también los saltos de profundidad: paredes, columnas)
export function bakeWorld(world: Bakeable, opts: { topZ?: number; incline?: number; outline?: 'none' | 'outer' | 'both'; outlineColor?: string } = {}): Baked {
  const topZ = opts.topZ ?? 40;
  const incline = opts.incline ?? 0.5;
  const originY = Math.ceil(world.depth * incline) + topZ;
  const options: RenderOptions = {
    width: world.width + 2, height: originY + 2 + BASIN_DEPTH, originX: 0, originY,
    yaw: 0, oblique: { y: incline, z: 1 }, pivot: [0, 0, 0], smooth: 0, shadows: false, ao: true, outline: opts.outline ?? 'none', ...(opts.outlineColor ? { outlineColor: opts.outlineColor } : {}), pick: true,
  };
  const t0 = performance.now();
  const img = render(world.model, options);
  const t1 = performance.now();
  const b: Baked = {
    width: img.width, height: img.height, rgba: img.rgba, depth: img.depth, face: img.pickFace!, pick: img.pickKey!,
    options, cam: camera(options), lights: [], version: cutVersion(world.model), ms: { render: Math.round(t1 - t0), light: 0 },
    source: world.model, occ: new Uint8Array(0), topZ,
    published: { serial: 0, rects: [] },
  };
  for (const l of world.lights) {
    if (l.baked === false) continue;                 // las dinámicas no se hornean: se suman cada cuadro
    const bl = lightWeights(b, l);
    if (bl) b.lights.push(bl);
  }
  b.ms.light = Math.round(performance.now() - t1);
  warmUp(b);
  return b;
}

// El horneado entero como un trabajo que se reanuda (ViewJob), para hornear sin congelar la vista: otro giro de la
// cámara, el nivel siguiente. Mientras el trabajo no acaba, `baked` está a medias y no se enseña; al acabar es el
// mismo, byte a byte, que el de bakeWorld (hay prueba). Lo que cambie en el mundo mientras tanto lo recoge después
// rebakeChangedJobs, como siempre: la versión horneada es la del principio.
export function bakeWorldJob(world: Bakeable, opts: Parameters<typeof bakeWorld>[1] = {}, key = 'bake'): { baked: Baked; job: ViewJob } {
  const topZ = opts.topZ ?? 40;
  const incline = opts.incline ?? 0.5;
  const originY = Math.ceil(world.depth * incline) + topZ;
  const options: RenderOptions = {
    width: world.width + 2, height: originY + 2 + BASIN_DEPTH, originX: 0, originY,
    yaw: 0, oblique: { y: incline, z: 1 }, pivot: [0, 0, 0], smooth: 0, shadows: false, ao: true, outline: opts.outline ?? 'none', ...(opts.outlineColor ? { outlineColor: opts.outlineColor } : {}), pick: true,
  };
  const W = options.width!, H = options.height!;
  const b: Baked = {
    width: W, height: H, rgba: new Uint8ClampedArray(W * H * 4), depth: new Float32Array(W * H), face: new Int8Array(W * H).fill(-1), pick: new Float64Array(W * H).fill(NaN),
    options, cam: camera(options), lights: [], version: cutVersion(world.model), ms: { render: 0, light: 0 },
    source: world.model, occ: new Uint8Array(0), topZ,
    published: { serial: 0, rects: [] },
  };
  // La imagen se pinta por franjas de columnas directamente en el horneado (nadie lo ve todavía: no hace falta doble búfer)
  const rect: ScreenRect = { x0: 0, x1: W - 1, y0: 0, y1: H - 1 };
  const buf: RectBuffers = { rgba: b.rgba, depth: b.depth, face: b.face, pick: b.pick, w: W, h: H };
  const lights = world.lights.filter((l) => l.baked !== false);
  // Lo que cuesta cada columna de píxeles: los vóxeles de su columna x (y la de al lado, que también se mira), de la
  // rejilla de alturas. Con eso y lo que se va midiendo (ms por vóxel), cada franja se corta para que tarde lo que
  // toca, también al pasar de columnas vacías a una pared larga
  const vox = new Float64Array(W + 1);
  const hgt = world.model.height, zMin = world.model.zMin;
  for (let y = 0; y < world.depth; y++) for (let x = 0; x < world.width; x++) vox[x + 1] = vox[x + 1]! + Math.max(0, hgt[y * world.width + x]! - zMin);
  const colCost = (c: number) => 1 + vox[c]! + (c > 0 ? vox[c - 1]! : 0);
  let col = 0, li = 0, cell = 0, msPerVox = -1, msPerCell = -1;
  let zone: BakedLight | null | undefined;
  const job: ViewJob = {
    key,
    run(deadline) {
      do {
        const t = performance.now();
        if (col <= rect.x1) {
          // La primera franja, de una columna (para medir); luego, las columnas que quepan en BAKE_STEP_MS
          let c1 = col, cost = colCost(col);
          if (msPerVox > 0) while (c1 < rect.x1 && c1 - col < 64 && (cost + colCost(c1 + 1)) * msPerVox <= BAKE_STEP_MS) cost += colCost(++c1);
          renderColumns(b, rect, buf, col, c1);
          col = c1 + 1;
          const ms = performance.now() - t;
          const rate = ms / cost;
          msPerVox = msPerVox < 0 ? rate : msPerVox * 0.7 + rate * 0.3;
          b.ms.render += ms;
        } else if (li < lights.length) {
          if (zone === undefined) { zone = lightZone(b, lights[li]!); cell = 0; msPerCell = -1; }
          const n = zone ? zone.rect.w * zone.rect.h : 0;
          if (zone && cell < n) {
            // Trozos de píxeles de la zona según lo que se va midiendo de esta luz (el primero, pequeño, para medir;
            // en una máquina lenta, menos de una fila)
            const want = msPerCell > 0 ? Math.max(16, Math.floor(BAKE_STEP_MS / msPerCell)) : 64;
            const c1 = Math.min(n, cell + want);
            weightCells(b, zone, cell, c1);
            const rate = (performance.now() - t) / (c1 - cell);
            msPerCell = msPerCell < 0 ? rate : msPerCell * 0.7 + rate * 0.3;
            cell = c1;
          }
          if (!zone || cell >= n) { if (zone) b.lights.push(zone); zone = undefined; li++; }
          b.ms.light += performance.now() - t;
        }
        if (col > rect.x1 && li >= lights.length) {
          b.ms.render = Math.round(b.ms.render); b.ms.light = Math.round(b.ms.light);
          return true;
        }
      } while (performance.now() < deadline);
      return false;
    },
  };
  return { baked: b, job };
}
const BAKE_STEP_MS = 2;   // lo que se busca que tarde cada paso del horneado entero

// Calienta el camino del rehorneado (el JIT compila renderColumns al usarlo): si no, la primera vez que algo se
// rompe en la partida, sus primeras franjas cuestan 4-7 ms en vez de ~1. Se renderizan unas franjas de prueba en
// búferes de usar y tirar; no se publica nada.
function warmUp(b: Baked): void {
  const s = b.source;
  const c = Math.floor(s.rows / 2) * s.cols + Math.floor(s.cols / 2);
  const { rect } = chunkRect(b, [c]);
  const buf = rectBuffers(rect);
  for (let k = 0, col = rect.x0; k < 6 && col <= rect.x1; k++, col += RECT_BAND) renderColumns(b, rect, buf, col, Math.min(rect.x1, col + RECT_BAND - 1));
}

// La versión del mundo que se hornea; corta los tramos de cambios (StaticVoxels.cut) para que lo que cambie después
// tenga su caja aparte
function cutVersion(s: StaticVoxels): number {
  s.cut();
  return s.clock;
}

// ---- los rayos de sombra leen los vóxeles del mundo, en la franja de alturas de siempre (Z0 .. topZ + 1)
const gridZ = (topZ: number) => topZ + 2 + BASIN_DEPTH;
const Z0 = -BASIN_DEPTH;

// Cuánta luz llega de p a la luz: 0 tras algo opaco, y por cada vóxel que deja pasar luz, lo que deja pasar
// (MaterialProps.light de su rampa); 1 si no se cruza nada
function transmit(b: Baked, px: number, py: number, pz: number, lx: number, ly: number, lz: number): number {
  const src = b.source, zHi = Z0 + gridZ(b.topZ) - 1;
  // Lo normal (una luz por encima del terreno): el segmento pasa por encima de lo más alto de cada columna que cruza,
  // así que no toca ningún vóxel y llega entera. Se mira por columnas con la rejilla de alturas, mucho más corto
  if (overColumns(src, px, py, pz, lx, ly, lz)) return 1;
  const mt = materialsOf(src.palette);
  // 0 vacío, 1 opaco, 2 + rampa si deja pasar luz (follaje, vidrio: materials.ts)
  const cell = (x: number, y: number, z: number) => {
    if (z < Z0 || z > zHi) return 0;
    const v = src.get(x, y, z);
    return !v ? 0 : mt && mt.light[v] ? 2 + decode(v).ramp : 1;
  };
  let t = 1;
  const dx = lx - px, dy = ly - py, dz = lz - pz;
  let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
  const tx = Math.floor(lx), ty = Math.floor(ly), tz = Math.floor(lz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const ddx = sx ? Math.abs(1 / dx) : Infinity, ddy = sy ? Math.abs(1 / dy) : Infinity, ddz = sz ? Math.abs(1 / dz) : Infinity;
  let mx = sx ? (sx > 0 ? x + 1 - px : px - x) * ddx : Infinity;
  let my = sy ? (sy > 0 ? y + 1 - py : py - y) * ddy : Infinity;
  let mz = sz ? (sz > 0 ? z + 1 - pz : pz - z) * ddz : Infinity;
  for (let i = 0; i < 1024; i++) {
    if (x === tx && y === ty && z === tz) return t;
    if (mx <= my && mx <= mz) { if (mx > 1) return t; x += sx; mx += ddx; }
    else if (my <= mz) { if (my > 1) return t; y += sy; my += ddy; }
    else { if (mz > 1) return t; z += sz; mz += ddz; }
    if (x === tx && y === ty && z === tz) return t;
    const c = cell(x, y, z);
    if (c === 1) return 0;
    if (c >= 2) t *= mt!.light[(c - 2) * 16 + 1]!;
  }
  return t;
}

// ¿Va el segmento p -> l por encima de todos los vóxeles de las columnas que cruza? (la rejilla de alturas: la cara de
// arriba del más alto de cada columna). Si dice que sí, el segmento no toca ningún vóxel; si no, no se sabe
function overColumns(s: StaticVoxels, px: number, py: number, pz: number, lx: number, ly: number, lz: number): boolean {
  const H = s.height, W = s.width, D = s.depth;
  const dx = lx - px, dy = ly - py, dz = lz - pz;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  let x = Math.floor(px), y = Math.floor(py), t0 = 0;
  for (let i = 0; i < 4096; i++) {
    const tX = sx ? ((sx > 0 ? x + 1 : x) - px) / dx : Infinity, tY = sy ? ((sy > 0 ? y + 1 : y) - py) / dy : Infinity;
    const t1 = Math.min(tX, tY, 1);
    const zLow = pz + dz * (dz < 0 ? t1 : t0);
    // Estricto y con margen: rozar la arista de arriba de una columna lo cuenta el recorrido por vóxeles (un empate)
    if (x >= 0 && y >= 0 && x < W && y < D && zLow <= H[y * W + x]! + 1e-6) return false;
    if (t1 >= 1) return true;
    if (tX <= tY) x += sx; else y += sy;
    t0 = t1;
  }
  return false;
}

// ---- pesos de una luz fija: su zona de pantalla y el peso de cada píxel (por cara de vóxel, con sombras)
function lightWeights(b: Baked, l: WorldLight): BakedLight | null {
  const z = lightZone(b, l);
  if (!z) return null;
  const rows = weightRows(b, z, 0, z.rect.h);
  return rows;
}

function lightZone(b: Baked, l: WorldLight, weight?: Float32Array): BakedLight | null {
  const p = resolveLight(l, 0);
  const r = p.radius;
  // Zona de la imagen: la proyección de la caja que rodea la esfera de la luz
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const dx of [-r, r]) for (const dy of [-r, r]) for (const z of [Z0, Math.min(b.topZ, l.z + r)]) {
    const [sx, sy] = b.cam.project(l.x + dx, l.y + dy, z);
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const rx = Math.max(0, Math.floor(x0)), ry = Math.max(0, Math.floor(y0));
  const rect = { x: rx, y: ry, w: Math.min(b.width, Math.ceil(x1)) - rx, h: Math.min(b.height, Math.ceil(y1)) - ry };
  if (rect.w <= 0 || rect.h <= 0) return null;
  return { light: l, color: p.color, intensity: p.base, rect, weight: weight && weight.length === rect.w * rect.h ? weight : new Float32Array(rect.w * rect.h) };
}

// Calcula las filas [j0, j1) de los pesos de una zona (escribe en zone.weight). La caché por cara solo vale dentro de
// la llamada: el resultado no depende de cómo se trocee.
function weightRows(b: Baked, zone: BakedLight, j0: number, j1: number): BakedLight {
  return weightCells(b, zone, j0 * zone.rect.w, j1 * zone.rect.w);
}
// Lo mismo por píxeles de la zona en orden de lectura, [c0, c1): para trocear más fino que una fila
type CellFilter = (px: number, py: number, k: number, f: number) => boolean;

// ¿Alumbra igual? (los pesos viejos de una luz solo valen para la misma luz en el mismo sitio)
function sameLight(a: WorldLight, b: WorldLight): boolean {
  return a === b || (a.kind === b.kind && a.x === b.x && a.y === b.y && a.z === b.z && a.intensity === b.intensity && a.radius === b.radius &&
    String(a.color) === String(b.color) && String(a.dir) === String(b.dir) && a.cone === b.cone);
}

// Los píxeles (fuera de los que cambiaron de vóxel o de cara, que se rehacen siempre) cuyo peso de la luz l puede
// haber cambiado: los de un vóxel dentro de lo cambiado y los que miran a la luz por un segmento que lo cruza (el rayo
// de sombra, de transmit). Las cajas llevan ya el
// margen del rehorneado; aquí, 1 vóxel más para las celdas que el rayo pisa de lado
function touchedBy(l: WorldLight, plans: readonly Plan[]): CellFilter {
  return (_px, _py, k, f) => {
    if (Number.isNaN(k)) return false;
    // unkey sin crear nada (es por píxel)
    const vz = (k % 2048) - 1024, rr = Math.floor(k / 2048), vy = (rr % 2048) - 1024, vx = Math.floor(rr / 2048) - 1024;
    // El vóxel mismo dentro de lo cambiado (pudo cambiar su material: cuánta luz recibe por detrás)
    for (let q = 0; q < plans.length; q++) {
      const p = plans[q]!;
      if (vx >= p.X0 && vx <= p.X1 && vy >= p.Y0 && vy <= p.Y1 && vz >= p.Z0 && vz <= p.Z1) return true;
    }
    const n = DIR_VECTORS[f]!;
    const ox = vx + 0.5 + n[0], oy = vy + 0.5 + n[1], oz = vz + 0.5 + n[2];
    for (let q = 0; q < plans.length; q++) {
      const p = plans[q]!;
      if (segmentHitsBox(ox, oy, oz, l.x, l.y, l.z, p.X0 - 1, p.Y0 - 1, p.Z0 - 1, p.X1 + 2, p.Y1 + 2, p.Z1 + 2)) return true;
    }
    return false;
  };
}

// Las filas de pantalla de la sombra (su silueta convexa, no su recuadro), con 2 píxeles de margen en x y en y:
// [x0, x1, y] con x0..x1 incluidos
function shadowRows(b: Baked, l: WorldLight, r: number, p: Plan): Array<[number, number, number]> | 'all' | null {
  const pts = shadowHull(b, l, r, p);
  if (pts === null || pts === 'all') return pts;
  const hull = convexHull(pts), n = hull.length;
  let ya = Infinity, yb = -Infinity;
  for (const [, y] of hull) { ya = Math.min(ya, y); yb = Math.max(yb, y); }
  const Y0 = Math.floor(ya) - 2, Y1 = Math.ceil(yb) + 2;
  // El intervalo en x de la silueta en la franja de cada fila entera [y, y+1)
  const lo = new Float64Array(Y1 - Y0 + 1).fill(Infinity), hi = new Float64Array(Y1 - Y0 + 1).fill(-Infinity);
  const put = (x: number, y: number) => { const j = Math.floor(y) - Y0; if (j >= 0 && j < lo.length) { if (x < lo[j]!) lo[j] = x; if (x > hi[j]!) hi[j] = x; } };
  for (let i = 0; i < n; i++) {
    const [ax, ay] = hull[i]!, [bx, by] = hull[(i + 1) % n]!;
    put(ax, ay);
    const s0 = Math.min(ay, by), s1 = Math.max(ay, by);
    for (let y = Math.ceil(s0); y <= s1; y++) {                // donde el lado cruza una fila entera
      const t = by === ay ? 0 : (y - ay) / (by - ay), x = ax + (bx - ax) * t;
      put(x, y); put(x, y - 1);
    }
  }
  const rows: Array<[number, number, number]> = [];
  for (let j = 0; j < lo.length; j++) {
    let a = Infinity, c = -Infinity;
    for (let k = Math.max(0, j - 2); k <= Math.min(lo.length - 1, j + 2); k++) { a = Math.min(a, lo[k]!); c = Math.max(c, hi[k]!); }
    if (a <= c) rows.push([Math.floor(a) - 2, Math.ceil(c) + 2, Y0 + j]);
  }
  return rows;
}

// La envolvente convexa de unos puntos (cadena monótona), en orden
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], c: [number, number]) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Los puntos de pantalla de la sombra de la caja vista desde la luz: sus 8 esquinas y las mismas alargadas hasta donde
// la luz ya no llega ('all': la sombra abre demasiado; null: la caja queda fuera de su alcance)
function shadowHull(b: Baked, l: WorldLight, r: number, p: Plan): Array<[number, number]> | 'all' | null {
  const x0 = p.X0 - 1, y0 = p.Y0 - 1, z0 = p.Z0 - 1, x1 = p.X1 + 2, y1 = p.Y1 + 2, z1 = p.Z1 + 2;
  const cx = (x0 + x1) / 2 - l.x, cy = (y0 + y1) / 2 - l.y, cz = (z0 + z1) / 2 - l.z, cl = Math.hypot(cx, cy, cz);
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
  if (cl - Math.hypot(hx, hy, hz) > r) return null;
  if (cl < 1e-6) return 'all';
  // Lo más que se abren las esquinas respecto al centro: la sombra hasta r cabe en las esquinas alargadas hasta r / cos
  let cosMin = 1;
  const corners: Array<[number, number, number]> = [];
  for (let c = 0; c < 8; c++) {
    const ex = (c & 1 ? x1 : x0) - l.x, ey = (c & 2 ? y1 : y0) - l.y, ez = (c & 4 ? z1 : z0) - l.z, el = Math.hypot(ex, ey, ez);
    if (el < 1e-6) return 'all';
    cosMin = Math.min(cosMin, (ex * cx + ey * cy + ez * cz) / (el * cl));
    corners.push([ex, ey, ez]);
  }
  if (cosMin < 0.35) return 'all';
  const far = r / cosMin;
  const out: Array<[number, number]> = [];
  for (const [ex, ey, ez] of corners) {
    const el = Math.hypot(ex, ey, ez), k = Math.max(1, far / el);
    for (const t of [1, k]) {
      const [sx, sy] = b.cam.project(l.x + ex * t, l.y + ey * t, l.z + ez * t);
      out.push([sx, sy]);
    }
  }
  return out;
}

// ¿Corta el segmento a -> b la caja [x0, x1] x [y0, y1] x [z0, z1]? (por franjas, sin crear nada)
function segmentHitsBox(ax: number, ay: number, az: number, bx: number, by: number, bz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  let t0 = 0, t1 = 1, d = bx - ax;
  if (d === 0) { if (ax < x0 || ax > x1) return false; } else {
    let u = (x0 - ax) / d, v = (x1 - ax) / d;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return false;
  }
  d = by - ay;
  if (d === 0) { if (ay < y0 || ay > y1) return false; } else {
    let u = (y0 - ay) / d, v = (y1 - ay) / d;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return false;
  }
  d = bz - az;
  if (d === 0) return az >= z0 && az <= z1;
  let u = (z0 - az) / d, v = (z1 - az) / d;
  if (u > v) { const w = u; u = v; v = w; }
  if (u > t0) t0 = u; if (v < t1) t1 = v;
  return t0 <= t1;
}
function weightCells(b: Baked, zone: BakedLight, c0: number, c1: number, only?: CellFilter, out?: Staged, given?: WeightCtx): BakedLight {
  const ctx = given ?? weightCtx(b, zone, out);
  for (let c = c0; c < c1; c++) cellWeight(b, zone, ctx, c, only);
  return zone;
}
// Lo mismo para una lista de píxeles de la zona (en orden de lectura de la zona)
function weightList(b: Baked, zone: BakedLight, cells: ArrayLike<number>, from: number, to: number, out?: Staged, given?: WeightCtx): void {
  const ctx = given ?? weightCtx(b, zone, out);
  for (let q = from; q < to; q++) cellWeight(b, zone, ctx, cells[q]!);
}
// Pesos rehechos que esperan a publicarse (la zona publicada no cambia hasta que el trabajo acaba): índice y valor
interface Staged { i: number[]; v: number[] }
interface WeightCtx { r: number; base: number; mt: ReturnType<typeof materialsOf>; cache: Map<number, number>; out?: Staged }
function weightCtx(b: Baked, zone: BakedLight, out?: Staged): WeightCtx {
  const p = resolveLight(zone.light, 0);
  return { r: p.radius, base: p.base, mt: materialsOf(b.source.palette), cache: new Map(), ...(out ? { out } : {}) };
}
function cellWeight(b: Baked, zone: BakedLight, x: WeightCtx, c: number, only?: CellFilter): void {
  const { light: l, rect, weight } = zone, { r, mt, cache } = x;
  const j = Math.floor(c / rect.w), i = c - j * rect.w;
  const idx = (rect.y + j) * b.width + rect.x + i;
  const k = b.pick[idx]!;
  const f = b.face[idx]!;
  if (only && !only(rect.x + i, rect.y + j, k, f)) return;
  if (Number.isNaN(k)) { if (x.out) { x.out.i.push(c); x.out.v.push(0); } else weight[c] = 0; return; }
  const ck = k * 8 + f;
  let w = cache.get(ck);
  if (w === undefined) {
    const [vx, vy, vz] = unkey(k);
    const n = DIR_VECTORS[f]!;
    const cx = vx + 0.5 + n[0] * 0.5, cy = vy + 0.5 + n[1] * 0.5, cz = vz + 0.5 + n[2] * 0.5;
    const ax = l.x - cx, ay = l.y - cy, az = l.z - cz;
    const d = Math.hypot(ax, ay, az);
    w = 0;
    if (d < r) {
      const back = mt ? mt.backlit[b.source.get(vx, vy, vz)]! : 0;
      const fa = d < 1e-6 ? 1 : facingOf((n[0] * ax + n[1] * ay + n[2] * az) / d, back);
      const k2 = 1 - d / r;
      if (fa > 0) {
        const t = transmit(b, vx + 0.5 + n[0], vy + 0.5 + n[1], vz + 0.5 + n[2], l.x, l.y, l.z);
        if (t > 0) w = t === 1 ? k2 * k2 * fa * x.base : k2 * k2 * fa * x.base * t;
      }
    }
    cache.set(ck, w);
  }
  if (x.out) { x.out.i.push(c); x.out.v.push(w); } else weight[c] = w;
}

// ---- rehorneado parcial

// Rehace el horneado de los trozos dados (índices de StaticVoxels): su recuadro de pantalla, la rejilla de sombras
// de sus columnas y los pesos de las luces fijas que los alcanzan.
export function rebake(b: Baked, chunks: readonly number[], lights: readonly WorldLight[], boxes?: ReadonlyMap<number, Box3>): { pixels: number; lights: number } {
  // Lo mismo que los trabajos, de una vez (las pruebas comparan los dos caminos)
  const jobs = rebakeJobs(b, chunks, lights, boxes);
  for (const j of jobs) while (!j.run(Infinity)) { /* el de luz espera a los recuadros, que van antes */ }
  const rects = chunkGroups(b, chunks).map((g) => chunkRect(b, g, boxes).rect);
  return { pixels: rects.reduce((n, r) => n + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0), lights: jobs.length - rects.length };
}

// ---- el recuadro de pantalla de unos trozos, por franjas de columnas
// Con la cámara sin girar, la columna de vóxeles x cae exactamente en la columna de píxeles x: cada franja de
// columnas se puede renderizar por separado (con sus vóxeles, y los vecinos del mundo entero para caras y oclusión)
// y el resultado es el mismo que de una vez.
interface ScreenRect { x0: number; x1: number; y0: number; y1: number }
interface RectBuffers { rgba: Uint8ClampedArray; depth: Float32Array; face: Int8Array; pick: Float64Array; w: number; h: number }

function rectBuffers(r: ScreenRect): RectBuffers {
  const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
  return { rgba: new Uint8ClampedArray(w * h * 4), depth: new Float32Array(w * h), face: new Int8Array(w * h), pick: new Float64Array(w * h), w, h };
}

interface Plan { X0: number; Y0: number; X1: number; Y1: number; Z0: number; Z1: number }
function chunkRect(b: Baked, chunks: readonly number[], boxes?: ReadonlyMap<number, Box3>): { rect: ScreenRect; plan: Plan } {
  const s = b.source;
  // La caja de lo cambiado: la de cada trozo si se sabe (changedBox), si no el trozo entero con toda su altura
  let X0 = Infinity, Y0 = Infinity, Z0b = Infinity, X1 = -Infinity, Y1 = -Infinity, Z1b = -Infinity;
  for (const c of chunks) {
    const k = boxes?.get(c);
    const cx = c % s.cols, cy = Math.floor(c / s.cols);
    const bx = k ?? { x0: cx * CHUNK, y0: cy * CHUNK, z0: s.zMin, x1: Math.min(s.width, (cx + 1) * CHUNK) - 1, y1: Math.min(s.depth, (cy + 1) * CHUNK) - 1, z1: s.zMax };
    X0 = Math.min(X0, bx.x0); Y0 = Math.min(Y0, bx.y0); Z0b = Math.min(Z0b, bx.z0);
    X1 = Math.max(X1, bx.x1); Y1 = Math.max(Y1, bx.y1); Z1b = Math.max(Z1b, bx.z1);
  }
  // Un vóxel que cambia cambia también el tono de las caras vecinas: la oclusión (1 vóxel) y, con smooth, la normal
  // suavizada (3)
  const m = (b.options.smooth ?? 0.6) > 0 ? 3 : 1;
  X0 = Math.max(0, X0 - m); Y0 = Math.max(0, Y0 - m); X1 = Math.min(s.width - 1, X1 + m); Y1 = Math.min(s.depth - 1, Y1 + m);
  Z0b = Math.max(s.zMin, Z0b - m); Z1b = Math.min(s.zMax, Z1b + m);
  // Los píxeles por los que pasa la caja (lo que tapa o destapa no sale de ahí), con 1 de margen para el contorno
  const a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const rect = {
    x0: Math.max(0, X0 - 1), x1: Math.min(b.width - 1, X1 + 2),
    y0: Math.max(0, Math.floor(O - a * (Y1 + 1) - (Z1b + 1)) - 1), y1: Math.min(b.height - 1, Math.ceil(O - a * Y0 - Z0b) + 1),
  };
  return { rect, plan: { X0, Y0, X1, Y1, Z0: Z0b, Z1: Z1b } };
}

// Los trozos cambiados, en grupos que se rehornean cada uno con su recuadro: por columna de trozos, los tramos
// seguidos en y. Dos tramos de la misma columna van juntos si el hueco entre ellos cuesta menos píxeles que la altura
// de las paredes que repetirían dos recuadros. Así unos cambios sueltos por todo el mundo (una caída) no rehacen el
// mundo entero de un recuadro.
function chunkGroups(b: Baked, chunks: readonly number[]): number[][] {
  const s = b.source, a = b.options.oblique?.y ?? 1;
  const gap = Math.max(1, Math.floor((s.zMax - s.zMin + 2) / (a * CHUNK)));
  const byCol = new Map<number, number[]>();
  for (const c of new Set(chunks)) {
    const cx = c % s.cols;
    const l = byCol.get(cx);
    if (l) l.push(c); else byCol.set(cx, [c]);
  }
  const groups: number[][] = [];
  for (const cx of [...byCol.keys()].sort((p, q) => p - q)) {
    const col = byCol.get(cx)!.sort((p, q) => p - q);
    let g = [col[0]!];
    for (let i = 1; i < col.length; i++) {
      if (Math.floor(col[i]! / s.cols) - Math.floor(col[i - 1]! / s.cols) > gap) { groups.push(g); g = []; }
      g.push(col[i]!);
    }
    groups.push(g);
  }
  return groups;
}

// Renderiza las columnas de píxeles c0..c1 del recuadro en sus búferes
function renderColumns(b: Baked, r: ScreenRect, buf: RectBuffers, c0: number, c1: number): void {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  // Se renderiza con 1 píxel más por cada lado y se recorta: el contorno de un píxel mira a sus 4 vecinos, y los del
  // borde del recuadro tienen que verlos como en el horneado entero
  const R0 = r.y0 - 1, R1 = r.y1 + 1, C0 = c0 - 1, C1 = c1 + 1;
  // Solo los vóxeles de esas columnas (el borde de una columna de píxeles es la columna de vóxeles de su x) y de las y
  // que pueden caer en esas filas. Por arriba manda lo más alto que haya en esas columnas (la rejilla de alturas), no
  // zMax: en un mundo alto y medio vacío, eso es la mitad de las filas
  const yHi = Math.min(s.depth - 1, Math.ceil((O - R0 - s.zMin) / a) + 1);
  let yLo = Math.max(0, Math.floor((O - R1 - 1 - s.zMax - 1) / a) - 1), top = s.zMin;
  for (let x = Math.max(0, C0 - 1); x <= Math.min(s.width - 1, C1); x++) for (let y = yLo; y <= yHi; y++) top = Math.max(top, s.height[y * s.width + x]!);
  yLo = Math.max(yLo, Math.floor((O - R1 - 1 - top) / a) - 1);
  const region = { x0: C0 - 1, y0: yLo, x1: C1, y1: yHi };
  const W = C1 - C0 + 1, H = R1 - R0 + 1, w = c1 - c0 + 1;
  // Por bandas de 16 filas de y (un trozo), con la franja de alturas que puede caer en las filas R0..R1 (la cara de
  // arriba del vóxel (y, z) va de la fila O - a*(y+1) - (z+1) a la O - a*y - z): el mismo orden que de una vez
  const banded = (fn: (x: number, y: number, z: number, v: number) => void) => {
    for (let y0 = region.y0; y0 <= region.y1; y0 = (y0 | 15) + 1) {
      const y1 = Math.min(region.y1, y0 | 15);
      s.forEachExposed(fn, { x0: region.x0, x1: region.x1, y0, y1, z0: Math.floor(O - R1 - a * (y1 + 1)) - 2, z1: Math.ceil(O - R0 - a * y0) + 1 });
    }
  };
  const sub: VoxelSource = { palette: s.palette, get: (x, y, z) => s.get(x, y, z), entries: () => s.entries(region), forEachExposed: (b.options.yaw ?? 0) === 0 ? banded : (fn) => s.forEachExposed(fn, region) };
  const img = render(sub, { ...b.options, width: W, height: H, originX: (b.options.originX ?? 0) - C0, originY: O - R0 });
  for (let j = 0; j < buf.h; j++) for (let i = 0; i < w; i++) {
    const src = (j + 1) * W + i + (c0 - C0), dst = j * buf.w + (c0 - r.x0) + i;
    buf.depth[dst] = img.depth[src]!; buf.face[dst] = img.pickFace![src]!; buf.pick[dst] = img.pickKey![src]!;
    for (let ch = 0; ch < 4; ch++) buf.rgba[dst * 4 + ch] = img.rgba[src * 4 + ch]!;
  }
}

// changed (opcional, buf.w x buf.h): se marca 1 donde cambió qué vóxel o qué cara se ve
function publishRect(b: Baked, r: ScreenRect, buf: RectBuffers, changed?: Uint8Array): void {
  for (let j = 0; j < buf.h; j++) for (let i = 0; i < buf.w; i++) {
    const src = j * buf.w + i, dst = (r.y0 + j) * b.width + r.x0 + i;
    if (changed && (b.face[dst] !== buf.face[src] || !Object.is(b.pick[dst], buf.pick[src]))) changed[src] = 1;
    b.depth[dst] = buf.depth[src]!; b.face[dst] = buf.face[src]!; b.pick[dst] = buf.pick[src]!;
    for (let ch = 0; ch < 4; ch++) b.rgba[dst * 4 + ch] = buf.rgba[src * 4 + ch]!;
  }
  const pub = b.published;
  pub.rects.push({ serial: ++pub.serial, ...r });
  if (pub.rects.length > PUBLISHED_KEEP) pub.rects.shift();
}
const PUBLISHED_KEEP = 32;

// ---- rehorneado como trabajos que se reanudan (para la cola con presupuesto de la vista)
// run(deadline) trabaja hasta que el reloj pasa de `deadline` o acaba, y devuelve true si acabó. Mientras no acaba
// vale lo viejo; lo nuevo se publica de golpe al terminar (doble búfer). Un trabajo nuevo con la misma key sustituye
// al viejo (lo hace la cola).
export interface ViewJob { readonly key: string; run(deadline: number): boolean; readonly priority?: number }

const RECT_BAND = 4;      // columnas de píxeles por paso del recuadro
const LIGHT_CELLS = 32;   // píxeles de una zona de luz por paso
const LIGHT_OWN = 16;     // píxeles cambiados por paso (cada uno, su rayo de sombra)

// boxes (opcional): la caja de lo cambiado en cada trozo (StaticVoxels.changedBox); sin ella, el trozo entero
// lights son TODAS las luces del mundo (o de la vista): las fijas horneadas que ya no están (quitadas, o que pasaron a
// dinámicas) se deshornean al momento, y las fijas que no estaban horneadas (puestas en partida) se hornean enteras,
// aunque no haya cambiado ningún vóxel
export function rebakeJobs(b: Baked, chunks: readonly number[], lights: readonly WorldLight[], boxes?: ReadonlyMap<number, Box3>): ViewJob[] {
  const fixed = new Map<LightId, WorldLight>();
  for (const l of lights) if (l.baked !== false) fixed.set(l.id, l);
  for (let i = b.lights.length - 1; i >= 0; i--) if (!fixed.has(b.lights[i]!.light.id)) b.lights.splice(i, 1);
  const pend = (b.pendingLights ??= new Set());
  for (const id of [...pend]) if (!fixed.has(id)) pend.delete(id);
  const added = [...fixed.values()].filter((l) => !pend.has(l.id) && !b.lights.some((bl) => bl.light.id === l.id));
  for (const l of added) pend.add(l.id);
  if (!chunks.length) return added.map((l) => lightJob(b, l));
  const jobs: ViewJob[] = [];
  // 1) un recuadro por grupo de trozos, por franjas de columnas (los búferes se piden al empezar, no aquí)
  const plans: Plan[] = [], rects: ScreenRect[] = [], masks = new Map<ScreenRect, Uint8Array>();
  // Los píxeles de la imagen donde cambió el vóxel o la cara que se ve (de las máscaras de los recuadros, que ya se
  // publicaron cuando las luces preguntan); una vez por rehorneado
  let changed: Int32Array | null = null;
  const changedPixels = (): Int32Array => {
    if (changed) return changed;
    const out: number[] = [];
    for (const r of rects) {
      const m = masks.get(r), w = r.x1 - r.x0 + 1;
      for (let j = 0; j <= r.y1 - r.y0; j++) for (let i = 0; i < w; i++) if (!m || m[j * w + i]) out.push((r.y0 + j) * b.width + r.x0 + i);
    }
    return (changed = Int32Array.from(new Set(out)));
  };
  let pending = 0;
  for (const g of chunkGroups(b, chunks)) {
    const { rect, plan } = chunkRect(b, g, boxes);
    plans.push(plan); rects.push(rect);
    pending++;
    let buf: RectBuffers | null = null, col = rect.x0;
    jobs.push({
      key: `rect:${rect.x0},${rect.y0},${rect.x1},${rect.y1}`,
      run(deadline) {
        if (col > rect.x1) return true;
        buf ??= rectBuffers(rect);
        do {
          const c1 = Math.min(rect.x1, col + RECT_BAND - 1);
          renderColumns(b, rect, buf, col, c1);
          col = c1 + 1;
        } while (col <= rect.x1 && performance.now() < deadline);
        if (col <= rect.x1) return false;
        const mask = new Uint8Array(buf.w * buf.h);
        publishRect(b, rect, buf, mask);
        masks.set(rect, mask);
        buf = null;
        pending--;
        return true;
      },
    });
  }
  // 2) las luces fijas que alcanzan algún grupo, por filas (después de los recuadros: leen qué vóxel se ve en cada píxel)
  for (const l of lights) {
    if (l.baked === false) {
      // Una fija que pasó a dinámica (la de un objeto que se despertó): sus pesos horneados sobran
      const i = b.lights.findIndex((bl) => bl.light.id === l.id);
      if (i >= 0) b.lights.splice(i, 1);
      continue;
    }
    const r = resolveLight(l, 0).radius;
    if (!plans.some((p) => !(l.x + r < p.X0 || l.x - r > p.X1 + 1 || l.y + r < p.Y0 || l.y - r > p.Y1 + 1))) continue;
    let zone: BakedLight | null | undefined, only: CellFilter | undefined;
    // Lo que hay que rehacer de la zona, en recuadros de la zona [i0, i1) x [j0, j1), y por dónde va
    let spans: Array<[number, number, number, number]> = [], si = 0, row = 0, col = -1, own: number[] = [], oi = 0, staged: Staged | undefined, wctx: WeightCtx | undefined;
    jobs.push({
      key: `light:${l.id}`,
      run(deadline) {
        if (pending > 0) return false;                     // espera a los recuadros
        if (zone === undefined) {
          const prev = b.lights.find((bl) => bl.light.id === l.id);
          // Con la misma luz, los pesos se rehacen sobre los de antes (en un objeto nuevo, para que quien guarda una
          // copia, como la GPU, sepa que cambió)
          zone = lightZone(b, l, prev && sameLight(prev.light, l) ? prev.weight : undefined);
          if (zone) spans = [[0, zone.rect.w, 0, zone.rect.h]];
          // Si la luz ya estaba horneada con la misma zona, solo cambian los píxeles de los recuadros rehechos y los
          // que miran a la luz a través de lo cambiado: se parte de sus pesos y se rehacen esos, mirando solo los
          // recuadros rehechos y la sombra de cada caja en pantalla
          if (zone && prev && zone.weight === prev.weight && prev.rect.x === zone.rect.x && prev.rect.y === zone.rect.y) {
            only = touchedBy(l, plans);
            staged = { i: [], v: [] };
            const zr = zone.rect, out: Array<[number, number, number, number]> = [];
            // Los píxeles que cambiaron de vóxel o de cara, dentro de la zona: se rehacen todos, primero
            const cp = changedPixels(), list: number[] = [];
            for (let q = 0; q < cp.length; q++) {
              const g = cp[q]!, gx = g % b.width, gy = (g - gx) / b.width;
              if (gx >= zr.x && gy >= zr.y && gx < zr.x + zr.w && gy < zr.y + zr.h) list.push((gy - zr.y) * zr.w + gx - zr.x);
            }
            own = list;
            const add = (x0: number, y0: number, x1: number, y1: number) => {
              const i0 = Math.max(0, Math.floor(x0) - zr.x), i1 = Math.min(zr.w, Math.ceil(x1) + 1 - zr.x);
              const j0 = Math.max(0, Math.floor(y0) - zr.y), j1 = Math.min(zr.h, Math.ceil(y1) + 1 - zr.y);
              if (i0 < i1 && j0 < j1) out.push([i0, i1, j0, j1]);
            };
            let whole = false;
            for (const p of plans) {
              const sh = shadowRows(b, l, r, p);
              if (sh === 'all') { whole = true; break; }
              if (sh) for (const [x0, x1, y] of sh) add(x0, y, x1, y);
            }
            if (!whole) {
              spans = out;
              let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
              for (const [i0, i1, j0, j1] of out) { dx0 = Math.min(dx0, i0); dx1 = Math.max(dx1, i1); dy0 = Math.min(dy0, j0); dy1 = Math.max(dy1, j1); }
              for (const c of list) { const ci = c % zr.w, cj = (c - ci) / zr.w; dx0 = Math.min(dx0, ci); dx1 = Math.max(dx1, ci + 1); dy0 = Math.min(dy0, cj); dy1 = Math.max(dy1, cj + 1); }
              zone.base = prev;
              prev.base = undefined;                   // solo un eslabón: no se encadenan los horneados viejos
              zone.dirty = dx1 > dx0 ? { x: dx0, y: dy0, w: dx1 - dx0, h: dy1 - dy0 } : { x: 0, y: 0, w: 0, h: 0 };
            }
          }
        }
        if (zone && oi < own.length) {
          // Los píxeles que cambiaron, de LIGHT_OWN en LIGHT_OWN (su rayo de sombra puede ser largo: en un foso cruza
          // paredes y va vóxel a vóxel)
          wctx ??= weightCtx(b, zone, staged);
          do { const o1 = Math.min(own.length, oi + LIGHT_OWN); weightList(b, zone, own, oi, o1, staged, wctx); oi = o1; } while (oi < own.length && performance.now() < deadline);
          if (oi < own.length) return false;
        }
        // Los recuadros, de LIGHT_CELLS en LIGHT_CELLS píxeles (no de filas enteras: una fila de una zona grande con
        // sombras largas era un paso de varios ms)
        if (zone) while (si < spans.length) {
          const [i0, i1, j0, j1] = spans[si]!;
          if (row < j0 || col < 0) { row = Math.max(row, j0); col = i0; }
          const c1 = Math.min(i1, col + LIGHT_CELLS);
          wctx ??= weightCtx(b, zone, staged);
          weightCells(b, zone, row * zone.rect.w + col, row * zone.rect.w + c1, only, staged, wctx);
          col = c1;
          if (col >= i1) { row++; col = i0; if (row >= j1) { si++; row = 0; col = -1; } }
          if (performance.now() >= deadline) break;
        }
        if (zone && si < spans.length) return false;
        // Los pesos rehechos se ponen ahora, de una vez (la zona es la misma memoria que la publicada)
        if (zone && staged) for (let q = 0; q < staged.i.length; q++) zone.weight[staged.i[q]!] = staged.v[q]!;
        b.pendingLights?.delete(l.id);
        const i = b.lights.findIndex((bl) => bl.light.id === l.id);
        if (i >= 0) { if (zone) b.lights[i] = zone; else b.lights.splice(i, 1); } else if (zone) b.lights.push(zone);
        return true;
      },
    });
  }
  // Las fijas nuevas que no alcanzan lo cambiado
  for (const l of added) if (!jobs.some((j) => j.key === `light:${l.id}`)) jobs.push(lightJob(b, l));
  return jobs;
}

// Hornea una luz fija entera como trabajo (una puesta en partida)
function lightJob(b: Baked, l: WorldLight): ViewJob {
  let zone: BakedLight | null | undefined, cell = 0, wctx: WeightCtx | undefined;
  return {
    key: `light:${l.id}`,
    run(deadline) {
      if (zone === undefined) zone = lightZone(b, l);
      const n = zone ? zone.rect.w * zone.rect.h : 0;
      if (zone) do {
        const c1 = Math.min(n, cell + LIGHT_CELLS);
        wctx ??= weightCtx(b, zone);
        weightCells(b, zone, cell, c1, undefined, undefined, wctx);
        cell = c1;
      } while (cell < n && performance.now() < deadline);
      if (zone && cell < n) return false;
      if (!b.pendingLights?.delete(l.id)) return true;   // se quitó mientras: no se publica
      const i = b.lights.findIndex((bl) => bl.light.id === l.id);
      if (i >= 0) b.lights.splice(i, 1);
      if (zone) b.lights.push(zone);
      return true;
    },
  };
}

// Los trabajos de lo que haya cambiado (solo vóxeles) desde el último horneado
// Las luces de un rehorneado con near van detrás de todos los recuadros y nunca cuentan como "cercanas" para el
// presupuesto aparte de FrameBudget (near.below), salvo un umbral de más de esto: su prioridad empieza aquí
export const LIGHT_PRIORITY = 10000;

// near (opcional): dónde está el jugador (x, y del mundo). Los trabajos llevan entonces prioridad (ViewJob.priority, la
// distancia en píxeles de pantalla): FrameBudget hace antes lo más cercano, aunque haya trabajo viejo en la cola
export function rebakeChangedJobs(b: Baked, lights: readonly WorldLight[], opts: { near?: { x: number; y: number } } = {}): ViewJob[] {
  const { chunks, boxes } = changedBoxes(b);
  const jobs = rebakeJobs(b, chunks, lights, boxes);
  const n = opts.near;
  if (!n) return jobs;
  const s = b.source, h = s.height[Math.max(0, Math.min(s.depth - 1, Math.floor(n.y))) * s.width + Math.max(0, Math.min(s.width - 1, Math.floor(n.x)))]!;
  const [px, py] = b.cam.project(n.x, n.y, h);
  const byId = new Map<string, WorldLight>(lights.map((l) => [`light:${l.id}`, l]));
  return jobs.map((j) => {
    let p = 0;
    const m = j.key.match(/^rect:(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/);
    if (m) p = Math.hypot(Math.max(0, +m[1]! - px, px - +m[3]!), Math.max(0, +m[2]! - py, py - +m[4]!));
    else {
      const l = byId.get(j.key);
      if (l) { const [lx, ly] = b.cam.project(l.x, l.y, l.z); p = LIGHT_PRIORITY + Math.hypot(lx - px, ly - py); }
    }
    return { key: j.key, priority: p, run: (d: number) => j.run(d) };
  });
}

// Los trozos cambiados desde el último horneado y la caja de lo cambiado en cada uno; pone b.version al día
function changedBoxes(b: Baked): { chunks: number[]; boxes: Map<number, Box3> } {
  const s = b.source, chunks = s.changedSince(b.version), boxes = new Map<number, Box3>();
  for (const c of chunks) { const k = s.changedBox(c, b.version); if (k) boxes.set(c, k); }
  s.cut();
  b.version = s.clock;
  return { chunks, boxes };
}

// Rehornea lo que haya cambiado (solo vóxeles) desde el último horneado
export function rebakeChanged(b: Baked, lights: readonly WorldLight[]): { chunks: number; pixels: number; lights: number } {
  const { chunks, boxes } = changedBoxes(b);
  const r = rebake(b, chunks, lights, boxes);
  return { chunks: chunks.length, ...r };
}

// Luz total (ambiente + fuentes con su parpadeo en `time`) de una ventana de la imagen horneada
export function lightView(b: Baked, vx: number, vy: number, vw: number, vh: number, ambient: readonly [number, number, number], time: number): Float32Array {
  const total = new Float32Array(vw * vh * 3);
  for (let i = 0; i < vw * vh; i++) { total[i * 3] = ambient[0]; total[i * 3 + 1] = ambient[1]; total[i * 3 + 2] = ambient[2]; }
  for (const bl of b.lights) {
    const r = bl.rect;
    const ix0 = Math.max(vx, r.x), iy0 = Math.max(vy, r.y), ix1 = Math.min(vx + vw, r.x + r.w), iy1 = Math.min(vy + vh, r.y + r.h);
    if (ix0 >= ix1 || iy0 >= iy1) continue;
    const k = resolveLight(bl.light, time).intensity / bl.intensity;
    const [cr, cg, cb] = bl.color;
    for (let y = iy0; y < iy1; y++) {
      const src = (y - r.y) * r.w - r.x, dst = (y - vy) * vw - vx;
      for (let x = ix0; x < ix1; x++) {
        const w = bl.weight[src + x]!;
        if (!w) continue;
        const o = (dst + x) * 3, kw = w * k;
        total[o] = total[o]! + cr * kw; total[o + 1] = total[o + 1]! + cg * kw; total[o + 2] = total[o + 2]! + cb * kw;
      }
    }
  }
  return total;
}

// La inversa de la proyección oblicua de la imagen horneada: de una fila de píxeles y su profundidad, el punto del
// mundo (en la proyección oblicua la pantalla y la profundidad son dos ecuaciones lineales en y, z). UNA sola fórmula:
// la usan worldPointAt, la luz dinámica de la CPU (por píxel, sin crear nada) y fillWorldY de la GPU.
export interface Unproject { a: number; O: number; f2: number; den: number }
export function unprojector(b: Baked): Unproject {
  const a = b.options.oblique?.y ?? 1, f1 = b.cam.fwd[1], f2 = b.cam.fwd[2];
  return { a, O: b.options.originY, f2, den: a * f2 - f1 };
}
export const rowP = (u: Unproject, sy: number): number => u.O - (sy + 0.5);                  // = a*y + z de la fila
export const worldYAt = (u: Unproject, P: number, d: number): number => (P * u.f2 - d) / u.den;

// El punto del mundo que se ve en un píxel de la imagen horneada. null si ahí no hay nada.
export function worldPointAt(b: Baked, sx: number, sy: number): [number, number, number] | null {
  const d = b.depth[sy * b.width + sx]!;
  if (d === Infinity) return null;
  const u = unprojector(b), P = rowP(u, sy), y = worldYAt(u, P, d);
  return [sx, y, P - u.a * y];
}
