// Horneado de un mundo de vóxeles para jugarlo en 2D: se renderiza (imagen + profundidad + qué vóxel y qué cara hay
// en cada píxel) y, por cada luz fija, su peso en cada píxel de su zona, con la caída del juego, el ángulo con la
// cara y la sombra de los propios vóxeles. Por cuadro solo queda sumar las luces con su parpadeo (lightView).
//
// Si cambian vóxeles a mitad de partida, rebake() rehace SOLO lo afectado: el recuadro de pantalla de los trozos
// cambiados, la rejilla de sombras de esas columnas y los pesos de las luces que los alcanzan. El resultado es el
// mismo, byte a byte, que hornear el mundo entero de nuevo (hay prueba).
import { render, camera, unkey, DIR_VECTORS, type RenderOptions, type Camera, type VoxelSource } from '../core';
import { resolveLight } from './lightutil';
import { CHUNK, type StaticVoxels } from './state';
import type { WorldLight } from './build';

export interface BakedLight {
  light: WorldLight;
  color: readonly [number, number, number];
  intensity: number;
  rect: { x: number; y: number; w: number; h: number };   // zona de la imagen donde alumbra
  weight: Float32Array;                                    // peso por píxel de la zona (con la intensidad base)
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
  occ: Uint8Array;
  topZ: number;
  // Lo que se ha publicado desde el horneado (para quien guarda una copia, p. ej. las texturas de la GPU): cada
  // recuadro rehorneado con su número de serie. Solo se guardan los últimos; quien se quede atrás lo recarga todo.
  published: { serial: number; rects: Array<{ serial: number; x0: number; y0: number; x1: number; y1: number }> };
}

// Lo mínimo que necesita el horneado de un mundo
export interface Bakeable {
  model: StaticVoxels;
  lights: readonly WorldLight[];
  width: number;
  depth: number;
}

const facing = (ndl: number) => (ndl > 0 ? 0.35 + 0.65 * ndl : 0);
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
    options, cam: camera(options), lights: [], version: world.model.clock, ms: { render: Math.round(t1 - t0), light: 0 },
    source: world.model, occ: new Uint8Array(world.width * world.depth * gridZ(topZ)), topZ,
    published: { serial: 0, rects: [] },
  };
  fillOcc(b, 0, 0, world.width - 1, world.depth - 1);
  for (const l of world.lights) {
    if (l.baked === false) continue;                 // las dinámicas no se hornean: se suman cada cuadro
    const bl = lightWeights(b, l);
    if (bl) b.lights.push(bl);
  }
  b.ms.light = Math.round(performance.now() - t1);
  warmUp(b);
  return b;
}

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

// ---- rejilla densa de ocupación para los rayos de sombra (columnas x0..x1, y0..y1, toda la altura)
const gridZ = (topZ: number) => topZ + 2 + BASIN_DEPTH;
const Z0 = -BASIN_DEPTH;

function fillOcc(b: Baked, x0: number, y0: number, x1: number, y1: number): void {
  const GW = b.source.width, GD = b.source.depth, GZ = gridZ(b.topZ);
  for (let z = 0; z < GZ; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) b.occ[(z * GD + y) * GW + x] = 0;
  for (const [x, y, z0] of b.source.entries({ x0, y0, x1, y1 })) {
    const z = z0 - Z0;
    if (z >= 0 && z < GZ) b.occ[(z * GD + y) * GW + x] = 1;
  }
}

function occluded(b: Baked, px: number, py: number, pz: number, lx: number, ly: number, lz: number): boolean {
  const GW = b.source.width, GD = b.source.depth, GZ = gridZ(b.topZ);
  const filled = (x: number, y: number, z0: number) => { const z = z0 - Z0; return x >= 0 && y >= 0 && z >= 0 && x < GW && y < GD && z < GZ && b.occ[(z * GD + y) * GW + x] === 1; };
  const dx = lx - px, dy = ly - py, dz = lz - pz;
  let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
  const tx = Math.floor(lx), ty = Math.floor(ly), tz = Math.floor(lz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const ddx = sx ? Math.abs(1 / dx) : Infinity, ddy = sy ? Math.abs(1 / dy) : Infinity, ddz = sz ? Math.abs(1 / dz) : Infinity;
  let mx = sx ? (sx > 0 ? x + 1 - px : px - x) * ddx : Infinity;
  let my = sy ? (sy > 0 ? y + 1 - py : py - y) * ddy : Infinity;
  let mz = sz ? (sz > 0 ? z + 1 - pz : pz - z) * ddz : Infinity;
  for (let i = 0; i < 1024; i++) {
    if (x === tx && y === ty && z === tz) return false;
    if (mx <= my && mx <= mz) { if (mx > 1) return false; x += sx; mx += ddx; }
    else if (my <= mz) { if (my > 1) return false; y += sy; my += ddy; }
    else { if (mz > 1) return false; z += sz; mz += ddz; }
    if (x === tx && y === ty && z === tz) return false;
    if (filled(x, y, z)) return true;
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

function lightZone(b: Baked, l: WorldLight): BakedLight | null {
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
  return { light: l, color: p.color, intensity: p.base, rect, weight: new Float32Array(rect.w * rect.h) };
}

// Calcula las filas [j0, j1) de los pesos de una zona (escribe en zone.weight). La caché por cara solo vale dentro de
// la llamada: el resultado no depende de cómo se trocee.
function weightRows(b: Baked, zone: BakedLight, j0: number, j1: number): BakedLight {
  const { light: l, rect, weight } = zone;
  const p = resolveLight(l, 0);
  const r = p.radius;
  const cache = new Map<number, number>();
  for (let j = j0; j < j1; j++) for (let i = 0; i < rect.w; i++) {
    const idx = (rect.y + j) * b.width + rect.x + i;
    const k = b.pick[idx]!;
    if (Number.isNaN(k)) continue;
    const f = b.face[idx]!;
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
        const fa = d < 1e-6 ? 1 : facing((n[0] * ax + n[1] * ay + n[2] * az) / d);
        const k2 = 1 - d / r;
        if (fa > 0 && !occluded(b, vx + 0.5 + n[0], vy + 0.5 + n[1], vz + 0.5 + n[2], l.x, l.y, l.z)) w = k2 * k2 * fa * p.base;
      }
      cache.set(ck, w);
    }
    weight[j * rect.w + i] = w;
  }
  return zone;
}

// ---- rehorneado parcial

// Rehace el horneado de los trozos dados (índices de StaticVoxels): su recuadro de pantalla, la rejilla de sombras
// de sus columnas y los pesos de las luces fijas que los alcanzan.
export function rebake(b: Baked, chunks: readonly number[], lights: readonly WorldLight[]): { pixels: number; lights: number } {
  // Lo mismo que los trabajos, de una vez (las pruebas comparan los dos caminos)
  const jobs = rebakeJobs(b, chunks, lights);
  for (const j of jobs) while (!j.run(Infinity)) { /* el de luz espera al recuadro, que va antes */ }
  const { rect } = chunks.length ? chunkRect(b, chunks) : { rect: { x0: 0, x1: -1, y0: 0, y1: -1 } };
  return { pixels: (rect.x1 - rect.x0 + 1) * (rect.y1 - rect.y0 + 1), lights: jobs.length - (chunks.length ? 1 : 0) };
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

function chunkRect(b: Baked, chunks: readonly number[]): { rect: ScreenRect; plan: { X0: number; Y0: number; X1: number; Y1: number } } {
  const s = b.source;
  let cx0 = Infinity, cy0 = Infinity, cx1 = -Infinity, cy1 = -Infinity;
  for (const c of chunks) {
    const cx = c % s.cols, cy = Math.floor(c / s.cols);
    cx0 = Math.min(cx0, cx); cx1 = Math.max(cx1, cx); cy0 = Math.min(cy0, cy); cy1 = Math.max(cy1, cy);
  }
  const X0 = cx0 * CHUNK, Y0 = cy0 * CHUNK, X1 = Math.min(s.width, (cx1 + 1) * CHUNK) - 1, Y1 = Math.min(s.depth, (cy1 + 1) * CHUNK) - 1;
  const a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const rect = {
    x0: Math.max(0, X0 - 1), x1: Math.min(b.width - 1, X1 + 2),
    y0: Math.max(0, Math.floor(O - a * (Y1 + 1) - (s.zMax + 1)) - 1), y1: Math.min(b.height - 1, Math.ceil(O - a * Y0 - s.zMin) + 1),
  };
  return { rect, plan: { X0, Y0, X1, Y1 } };
}

// Renderiza las columnas de píxeles c0..c1 del recuadro en sus búferes
function renderColumns(b: Baked, r: ScreenRect, buf: RectBuffers, c0: number, c1: number): void {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const yLo = Math.floor((O - r.y1 - 1 - s.zMax - 1) / a) - 1, yHi = Math.ceil((O - r.y0 - s.zMin) / a) + 1;
  // Solo los vóxeles de esas columnas (el borde de una columna de píxeles es la columna de vóxeles de su x)
  const region = { x0: c0 - 1, y0: Math.max(0, yLo), x1: c1, y1: Math.min(s.depth - 1, yHi) };
  const w = c1 - c0 + 1;
  const sub: VoxelSource = { palette: s.palette, get: (x, y, z) => s.get(x, y, z), entries: () => s.entries(region) };
  const img = render(sub, { ...b.options, width: w, height: buf.h, originX: (b.options.originX ?? 0) - c0, originY: O - r.y0 });
  for (let j = 0; j < buf.h; j++) for (let i = 0; i < w; i++) {
    const src = j * w + i, dst = j * buf.w + (c0 - r.x0) + i;
    buf.depth[dst] = img.depth[src]!; buf.face[dst] = img.pickFace![src]!; buf.pick[dst] = img.pickKey![src]!;
    for (let ch = 0; ch < 4; ch++) buf.rgba[dst * 4 + ch] = img.rgba[src * 4 + ch]!;
  }
}

function publishRect(b: Baked, r: ScreenRect, buf: RectBuffers): void {
  for (let j = 0; j < buf.h; j++) for (let i = 0; i < buf.w; i++) {
    const src = j * buf.w + i, dst = (r.y0 + j) * b.width + r.x0 + i;
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
export interface ViewJob { readonly key: string; run(deadline: number): boolean }

const RECT_BAND = 2;      // columnas de píxeles por paso del recuadro
const LIGHT_BAND = 4;     // filas de pesos por paso de una luz

export function rebakeJobs(b: Baked, chunks: readonly number[], lights: readonly WorldLight[]): ViewJob[] {
  if (!chunks.length) return [];
  const { rect, plan } = chunkRect(b, chunks);
  // La rejilla de sombras se pone al día ya (es barata): los pesos viejos siguen publicados hasta que se rehagan
  fillOcc(b, plan.X0, plan.Y0, plan.X1, plan.Y1);
  const jobs: ViewJob[] = [];
  // 1) el recuadro, por franjas de columnas
  const buf = rectBuffers(rect);
  let col = rect.x0, rectDone = false;
  jobs.push({
    key: `rect:${rect.x0},${rect.y0},${rect.x1},${rect.y1}`,
    run(deadline) {
      do {
        const c1 = Math.min(rect.x1, col + RECT_BAND - 1);
        renderColumns(b, rect, buf, col, c1);
        col = c1 + 1;
      } while (col <= rect.x1 && performance.now() < deadline);
      if (col <= rect.x1) return false;
      publishRect(b, rect, buf);
      rectDone = true;
      return true;
    },
  });
  // 2) las luces fijas que alcanzan la zona, por filas (después del recuadro: leen qué vóxel se ve en cada píxel)
  for (const l of lights) {
    if (l.baked === false) continue;
    const r = resolveLight(l, 0).radius;
    if (l.x + r < plan.X0 || l.x - r > plan.X1 + 1 || l.y + r < plan.Y0 || l.y - r > plan.Y1 + 1) continue;
    let zone: BakedLight | null | undefined, row = 0;
    jobs.push({
      key: `light:${l.id}`,
      run(deadline) {
        if (!rectDone) return false;                       // espera al recuadro
        if (zone === undefined) zone = lightZone(b, l);
        if (zone) do {
          const r1 = Math.min(zone.rect.h, row + LIGHT_BAND);
          weightRows(b, zone, row, r1);
          row = r1;
        } while (row < zone.rect.h && performance.now() < deadline);
        if (zone && row < zone.rect.h) return false;
        const i = b.lights.findIndex((bl) => bl.light.id === l.id);
        if (i >= 0) { if (zone) b.lights[i] = zone; else b.lights.splice(i, 1); } else if (zone) b.lights.push(zone);
        return true;
      },
    });
  }
  return jobs;
}

// Los trabajos de lo que haya cambiado (solo vóxeles) desde el último horneado
export function rebakeChangedJobs(b: Baked, lights: readonly WorldLight[]): ViewJob[] {
  const jobs = rebakeJobs(b, b.source.changedSince(b.version), lights);
  b.version = b.source.clock;
  return jobs;
}

// Rehornea lo que haya cambiado (solo vóxeles) desde el último horneado
export function rebakeChanged(b: Baked, lights: readonly WorldLight[]): { chunks: number; pixels: number; lights: number } {
  const changed = b.source.changedSince(b.version);
  const r = rebake(b, changed, lights);
  b.version = b.source.clock;
  return { chunks: changed.length, ...r };
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

// El punto del mundo que se ve en un píxel de la imagen horneada (de su profundidad: en la proyección oblicua la
// pantalla y la profundidad son dos ecuaciones lineales en y, z). null si ahí no hay nada.
export function worldPointAt(b: Baked, sx: number, sy: number): [number, number, number] | null {
  const d = b.depth[sy * b.width + sx]!;
  if (d === Infinity) return null;
  const a = b.options.oblique?.y ?? 1, f1 = b.cam.fwd[1], f2 = b.cam.fwd[2];
  const P = b.options.originY - (sy + 0.5);            // = a*y + z
  const y = (P * f2 - d) / (a * f2 - f1);
  return [sx, y, P - a * y];
}
