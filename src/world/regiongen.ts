// MUNDO POR REGIONES: el mapa por semilla (mapgen.ts) generado por cajas de cualquier tamaño, en cualquier sitio y en
// cualquier orden. Regla de oro: lo que sale en una región no depende de qué otras regiones se generaron antes ni de en
// qué orden; todo sale de la semilla y de la posición. Así un mundo sin bordes se genera a trozos según se recorre, y
// el mismo sitio sale siempre igual.
//   const r = generateRegion(spec, { x0, y0, z0, width, depth, height });   // en celdas (bloques)
//   r.cells, r.heights, r.sown (lo sembrado en la región), r.touching (lo que la toca, aunque nazca fuera)
//
// Lo mismo que generateMap, cambiado donde dependía del mapa entero o del orden:
// - Relieve, estratos, agua y orilla: por columna, del ruido global (como en generateMap).
// - Vetas: cada celda de su materia empieza una mancha según un hash de la celda; la mancha crece con un azar sembrado
//   por esa celda y no se aleja más de VEIN_REACH celdas de ella. Las manchas se calculan contra los estratos (no contra
//   otras vetas): una celda es de la veta v si la cubre una mancha de v y su materia, tras las vetas anteriores, es de
//   v.in.
// - Cuevas: gusanos por macrocelda de CAVE_CELL x CAVE_CELL columnas, cada una con los suyos por hash (de media
//   caves.count por cada spec.width x spec.depth columnas, la densidad del mapa de siempre), de longitud y radio de su
//   spec. Para una región se recorren los de las macroceldas que pueden llegar a ella.
// - Lo sembrado: el candidato sale por hash de la columna (como en generateMap); se siembra si su prioridad (otro hash)
//   es la mayor entre los candidatos válidos de su regla con los que choca (a menos de `spacing`, o que se pisan). Las
//   reglas van en orden: una no puede pisar lo sembrado por las anteriores.
// - "Que quepa": en el rango de z del mundo (de bottom, o de 0, a height - 1), no en la región: en x e y no hay borde.
// - spec.bottom (opcional): por debajo, aire (un abismo). Sin bottom, el último estrato sigue hacia abajo sin fin. Las
//   cuevas no tocan la capa de abajo (bottom, o z = 0).
// spec.width y spec.depth ya no limitan nada: solo dan la densidad de las cuevas (caves.count por esa área).
import { fbmN, lattice } from '../worldgen/noise';
import { createRng } from '../sim/rng';
import type { MapSpec, MapSown } from './mapgen';
import type { BlockGrid } from './blocks';

export const CAVE_CELL = 32;            // lado de la macrocelda de las cuevas, en columnas
export const VEIN_REACH = 3;            // lo más que se aleja una mancha de veta de su celda de arranque

export interface RegionSpec extends MapSpec { bottom?: number }
export interface Region { x0: number; y0: number; z0: number; width: number; depth: number; height: number }

export interface GeneratedRegion {
  readonly region: Region;
  readonly cells: Uint16Array;           // (z * depth + y) * width + x, relativo a la región; 0 = aire
  readonly heights: Int16Array;          // por columna (y * width + x): la z del mundo más alta que no es aire ni agua (NONE si nada)
  readonly sown: MapSown[];              // lo sembrado cuya celda de arriba está en la región (coordenadas del mundo)
  readonly touching: MapSown[];          // lo sembrado que escribe alguna celda de la región (aunque nazca fuera)
  readonly structures: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>>;
}
export const NONE = -32768;

// Hashes por posición (enteros de 32 bits; lattice ya da 2D)
const salt = (seed: number, k: number) => (seed ^ Math.imul(k + 1, 0x9e3779b1)) | 0;
const hash3 = (x: number, y: number, z: number, seed: number) => lattice(x, Math.imul(y | 0, 1013) + (z | 0), seed);

// La caja de trabajo: columnas [x0, x1] x [y0, y1] (extremos incluidos) y las z [zlo, zhi]
interface Box { x0: number; y0: number; x1: number; y1: number; zlo: number; zhi: number }

export function generateRegion(spec: RegionSpec, region: Region): GeneratedRegion {
  if (!spec.strata.length) throw new Error('el mapa necesita al menos un estrato');
  // floor: la capa de abajo (las cuevas no la tocan; el relieve no baja de ella). solidFrom: desde dónde hay materia
  // (con bottom, debajo es aire; sin él, el último estrato sigue sin fin)
  const { seed } = spec, top = spec.height - 1, floor = spec.bottom ?? 0, solidFrom = spec.bottom ?? -Infinity;
  const sea = spec.seaLevel ?? -1, water = spec.water ?? 0;
  const sw = spec.shore ? spec.shore.width ?? 1 : 0;
  // El margen de la siembra: cada regla mira sus choques (spacing y lo que ocupa) y lo sembrado por las anteriores
  const rules = spec.scatter ?? [];
  const reachOf = (s: Array<[number, number, number, number]>) => Math.max(0, ...s.map(([dx, dy]) => Math.max(Math.abs(dx), Math.abs(dy))));
  // (por regla: sus choques, lo que ocupa a cada lado, y lo que ocupan las anteriores que la pueden pisar)
  const extAll = Math.max(0, ...rules.map((r) => reachOf(r.structure)));
  const marginOf = (r: (typeof rules)[number]) => Math.max(r.spacing ?? 0, 2 * reachOf(r.structure) + 1) + 2 * reachOf(r.structure) + extAll + 1;
  const H = rules.reduce((a, r) => a + marginOf(r), 0);
  // La caja de trabajo: la región con el margen de la siembra, y en z lo que haga falta para las alturas y lo sembrado
  const veinZ = (spec.veins ?? []).flatMap((v) => v.z), caveZ = spec.caves ? spec.caves.z : [];
  const zlo = Math.max(spec.bottom ?? -Infinity, Math.min(region.z0, floor, ...veinZ.map((z) => z - VEIN_REACH), ...caveZ.map((z) => z - Math.ceil(spec.caves!.radius[1]) - 1)));
  const box: Box = { x0: region.x0 - H, y0: region.y0 - H, x1: region.x0 + region.width - 1 + H, y1: region.y0 + region.depth - 1 + H, zlo, zhi: Math.max(region.z0 + region.height - 1, top) };
  const bw = box.x1 - box.x0 + 1, bd = box.y1 - box.y0 + 1, bh = box.zhi - box.zlo + 1;
  const cells = new Uint16Array(bw * bd * bh);
  const ci = (x: number, y: number, z: number) => ((z - box.zlo) * bd + (y - box.y0)) * bw + (x - box.x0);
  const inBox = (x: number, y: number, z: number) => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.zlo && z <= box.zhi;

  // 1) el relieve: la altura de cada columna (también en el margen de la orilla)
  const oct = spec.surface.octaves ?? 3;
  const heightAt = (x: number, y: number) => {
    const n = fbmN(x / spec.surface.scale, y / spec.surface.scale, seed, oct) * 2 - 1;
    return Math.max(floor, Math.min(top, Math.round(spec.surface.base + spec.surface.amplitude * n)));
  };
  const hw = bw + 2 * sw, hd = bd + 2 * sw, ground = new Int16Array(hw * hd);
  for (let y = 0; y < hd; y++) for (let x = 0; x < hw; x++) ground[y * hw + x] = heightAt(box.x0 - sw + x, box.y0 - sw + y);
  const groundAt = (x: number, y: number) => ground[(y - box.y0 + sw) * hw + (x - box.x0 + sw)]!;
  const wetAt = (x: number, y: number) => water !== 0 && sea >= 0 && groundAt(x, y) < sea;
  // El material de los estratos en (x, y, z) según la altura h de su columna
  const stratum = (h: number, z: number) => {
    const d = h - z;
    let li = 0, acc = 0;
    while (li < spec.strata.length - 1 && d >= acc + (spec.strata[li]!.depth ?? Infinity)) acc += spec.strata[li++]!.depth ?? 0;
    return spec.strata[li]!.material;
  };
  // 2) estratos, agua y orilla
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const h = groundAt(x, y);
    for (let z = box.zlo; z <= Math.min(h, box.zhi); z++) if (z >= solidFrom) cells[ci(x, y, z)] = stratum(h, z);
    if (wetAt(x, y)) for (let z = Math.max(h + 1, box.zlo); z <= Math.min(sea, top, box.zhi); z++) cells[ci(x, y, z)] = water;
    if (spec.shore && water && sea >= 0) {
      let near = wetAt(x, y);
      if (!near && h <= sea + 1) for (let dy = -sw; dy <= sw && !near; dy++) for (let dx = -sw; dx <= sw && !near; dx++) if (wetAt(x + dx, y + dy)) near = true;
      const sd = spec.shore.depth ?? 1;
      if (near) for (let z = h; z > h - sd && z >= floor; z--) if (z >= box.zlo && z <= box.zhi) cells[ci(x, y, z)] = spec.shore.material;
    }
  }
  // La materia de cualquier celda antes de las vetas (estratos, agua y orilla), solo de su posición: dentro o fuera de
  // la caja, la misma (las manchas de veta la miran, también fuera)
  const hCache = new Map<string, number>();
  const hAny = (x: number, y: number) => {
    if (x >= box.x0 - sw && x <= box.x1 + sw && y >= box.y0 - sw && y <= box.y1 + sw) return groundAt(x, y);
    const k = `${x},${y}`;
    let h = hCache.get(k);
    if (h === undefined) { h = heightAt(x, y); hCache.set(k, h); }
    return h;
  };
  const wetAny = (x: number, y: number) => water !== 0 && sea >= 0 && hAny(x, y) < sea;
  const baseAt = (x: number, y: number, z: number): number => {
    if (z < solidFrom || z > top) return 0;
    if (inBox(x, y, z)) return cells[ci(x, y, z)]!;
    const h = hAny(x, y);
    if (z > h) return wetAny(x, y) && z <= sea ? water : 0;
    if (spec.shore && water && sea >= 0 && z > h - (spec.shore.depth ?? 1)) {
      let near = wetAny(x, y);
      if (!near && h <= sea + 1) for (let dy = -sw; dy <= sw && !near; dy++) for (let dx = -sw; dx <= sw && !near; dx++) if (wetAny(x + dx, y + dy)) near = true;
      if (near) return spec.shore.material;
    }
    return stratum(h, z);
  };
  // 3) las vetas: manchas que arrancan por hash de su celda, contra los estratos, y se aplican en orden de veta
  (spec.veins ?? []).forEach((v, vi) => {
    const [s0, s1] = v.size ?? [2, 6], chance = v.density / ((s0 + s1) / 2), host = new Set(v.in);
    const z0 = Math.max(floor, v.z[0]), z1 = Math.min(top, v.z[1]);
    const vs = salt(seed, 100 + vi);
    const covered = new Set<number>();
    const R = VEIN_REACH;
    for (let z = Math.max(z0, box.zlo - R); z <= Math.min(z1, box.zhi + R); z++) for (let y = box.y0 - R; y <= box.y1 + R; y++) for (let x = box.x0 - R; x <= box.x1 + R; x++) {
      if (!host.has(baseAt(x, y, z)) || hash3(x, y, z, vs) >= chance) continue;
      const rng = createRng((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791) ^ vs) >>> 0);
      const want = s0 + Math.floor(rng() * (s1 - s0 + 1));
      let cx = x, cy = y, cz = z;
      for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
        if (cz >= z0 && cz <= z1 && host.has(baseAt(cx, cy, cz))) { if (inBox(cx, cy, cz)) covered.add(ci(cx, cy, cz)); k++; }
        const dir = Math.floor(rng() * 6);
        if (dir === 0) cx++; else if (dir === 1) cx--; else if (dir === 2) cy++; else if (dir === 3) cy--; else if (dir === 4) cz++; else cz--;
        cx = Math.max(x - R, Math.min(x + R, cx)); cy = Math.max(y - R, Math.min(y + R, cy)); cz = Math.max(Math.max(z0, z - R), Math.min(Math.min(z1, z + R), cz));
      }
    }
    for (const i of covered) if (host.has(cells[i]!)) cells[i] = v.material;
  });
  // 4) las cuevas: los gusanos de cada macrocelda que pueda llegar a la caja; vacían solo dentro de ella
  if (spec.caves) {
    const c = spec.caves, perColumn = c.count / Math.max(1, spec.width * spec.depth), perCell = perColumn * CAVE_CELL * CAVE_CELL;
    const reach = c.length[1] + Math.ceil(c.radius[1]) + 1;
    const mx0 = Math.floor((box.x0 - reach) / CAVE_CELL), mx1 = Math.floor((box.x1 + reach) / CAVE_CELL);
    const my0 = Math.floor((box.y0 - reach) / CAVE_CELL), my1 = Math.floor((box.y1 + reach) / CAVE_CELL);
    const cs = salt(seed, 200);
    for (let my = my0; my <= my1; my++) for (let mx = mx0; mx <= mx1; mx++) {
      const rng = createRng((Math.imul(mx, 73856093) ^ Math.imul(my, 19349663) ^ cs) >>> 0);
      const n = Math.floor(perCell) + (rng() < perCell - Math.floor(perCell) ? 1 : 0);
      for (let w = 0; w < n; w++) {
        let x = (mx + rng()) * CAVE_CELL, y = (my + rng()) * CAVE_CELL, z = c.z[0] + rng() * (c.z[1] - c.z[0]);
        let yaw = rng() * Math.PI * 2, pitch = (rng() - 0.5) * 0.6;
        const len = c.length[0] + Math.floor(rng() * (c.length[1] - c.length[0] + 1));
        const r = c.radius[0] + rng() * (c.radius[1] - c.radius[0]);
        for (let s = 0; s < len; s++) {
          const R = Math.ceil(r), fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
          if (fx + R >= box.x0 && fx - R <= box.x1 && fy + R >= box.y0 && fy - R <= box.y1) {
            for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
              if (dx * dx + dy * dy + dz * dz > r * r) continue;
              const cx = fx + dx, cy = fy + dy, cz = fz + dz;
              if (!inBox(cx, cy, cz) || cz <= floor || cz > top || wetAt(cx, cy)) continue;
              const i = ci(cx, cy, cz);
              if (cells[i] !== water) cells[i] = 0;
            }
          }
          yaw += (rng() - 0.5) * 0.8; pitch = Math.max(-0.5, Math.min(0.5, pitch + (rng() - 0.5) * 0.3));
          x += Math.cos(yaw) * Math.cos(pitch); y += Math.sin(yaw) * Math.cos(pitch); z += Math.sin(pitch);
          z = Math.max(c.z[0], Math.min(c.z[1], z));
        }
      }
    }
  }
  // La altura de cada columna de la caja, tras las cuevas: lo más alto que no es aire ni agua (en el mundo)
  const heights = new Int16Array(bw * bd).fill(NONE);
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    let z = top;
    while (z >= Math.max(floor, box.zlo) && (cells[ci(x, y, z)] === 0 || cells[ci(x, y, z)] === water)) z--;
    if (z >= Math.max(floor, box.zlo)) heights[(y - box.y0) * bw + (x - box.x0)] = z;
  }
  const hAt = (x: number, y: number) => heights[(y - box.y0) * bw + (x - box.x0)]!;
  // 5) lo sembrado, regla a regla. En la caja de cada regla se sabe todo lo que decide (sus choques y lo de las
  // anteriores); fuera de ella, no: la de la regla siguiente es más pequeña
  const structures = rules.map((sc) => sc.structure);
  const occupied = new Set<string>();                         // las celdas de lo sembrado por las reglas anteriores
  const placedAll: MapSown[] = [];
  let shrink = 0;
  rules.forEach((sc, si) => {
    const on = new Set(sc.on), spacing = sc.spacing ?? 0, ext = reachOf(sc.structure);
    const conflictR = Math.max(spacing, 2 * ext + 1);
    // La caja en que se buscan candidatos (y en la que se decide la regla: los de más adentro que conflictR + ext)
    const cx0 = box.x0 + shrink, cx1 = box.x1 - shrink, cy0 = box.y0 + shrink, cy1 = box.y1 - shrink;
    const ds = salt(seed, 300 + si), ps = salt(seed, 400 + si), dsOld = (seed ^ Math.imul(si + 1, 0x85ebca6b)) | 0;
    void ds;
    const cand = new Map<number, { x: number; y: number; z: number; p: number }>();
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
      const h = hAt(x, y);
      if (h === NONE || wetAt(x, y) || h < box.zlo || !on.has(cells[ci(x, y, h)]!)) continue;
      if (lattice(x, y, dsOld) >= sc.density) continue;
      const fits = sc.structure.every(([dx, dy, dz]) => {
        const qx = x + dx, qy = y + dy, qz = h + dz;
        return qz >= floor && qz <= top && inBox(qx, qy, qz) && cells[ci(qx, qy, qz)] === 0 && !occupied.has(`${qx},${qy},${qz}`);
      });
      if (!fits) continue;
      cand.set((y - box.y0) * bw + (x - box.x0), { x, y, z: h, p: lattice(x, y, ps) });
    }
    // Se siembra si gana a todos los candidatos válidos con los que choca (a menos de conflictR; empate: el de menor y, x)
    const shrinkNext = shrink + marginOf(sc);
    const dx0 = box.x0 + shrinkNext, dx1 = box.x1 - shrinkNext, dy0 = box.y0 + shrinkNext, dy1 = box.y1 - shrinkNext;
    for (const c of cand.values()) {
      if (c.x < dx0 || c.x > dx1 || c.y < dy0 || c.y > dy1) continue;
      let wins = true;
      for (let oy = c.y - conflictR + 1; oy <= c.y + conflictR - 1 && wins; oy++) for (let ox = c.x - conflictR + 1; ox <= c.x + conflictR - 1 && wins; ox++) {
        if (ox === c.x && oy === c.y) continue;
        const o = cand.get((oy - box.y0) * bw + (ox - box.x0));
        if (!o) continue;
        if (o.p > c.p || (o.p === c.p && (o.y < c.y || (o.y === c.y && o.x < c.x)))) wins = false;
      }
      if (!wins) continue;
      placedAll.push({ rule: si, x: c.x, y: c.y, z: c.z });
      for (const [dx, dy, dz] of sc.structure) occupied.add(`${c.x + dx},${c.y + dy},${c.z + dz}`);
    }
    shrink = shrinkNext;
  });
  // 6) la región: sus celdas, sus alturas y lo sembrado que es suyo o la toca
  const { x0, y0, z0, width: W, depth: D, height: Hh } = region;
  const out = new Uint16Array(W * D * Hh), oh = new Int16Array(W * D);
  for (let z = 0; z < Hh; z++) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) out[(z * D + y) * W + x] = cells[ci(x0 + x, y0 + y, z0 + z)]!;
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) oh[y * W + x] = hAt(x0 + x, y0 + y);
  const inside = (x: number, y: number, z: number) => x >= x0 && x < x0 + W && y >= y0 && y < y0 + D && z >= z0 && z < z0 + Hh;
  const order = (a: MapSown, b: MapSown) => a.rule - b.rule || a.y - b.y || a.x - b.x;
  const sown = placedAll.filter((s) => inside(s.x, s.y, s.z)).sort(order);
  const touching = placedAll.filter((s) => structures[s.rule]!.some(([dx, dy, dz]) => inside(s.x + dx, s.y + dy, s.z + dz))).sort(order);
  return { region: { ...region }, cells: out, heights: oh, sown, touching, structures };
}

// La huella de una región (FNV-1a de 32 bits sobre la caja, las celdas, las alturas y lo sembrado)
export function regionHash(r: GeneratedRegion): string {
  let h = 0x811c9dc5;
  const add = (v: number) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 0x01000193); };
  const g = r.region;
  for (const v of [g.x0, g.y0, g.z0, g.width, g.depth, g.height]) add(v);
  for (let i = 0; i < r.cells.length; i++) add(r.cells[i]!);
  for (let i = 0; i < r.heights.length; i++) add(r.heights[i]!);
  for (const s of r.sown) { add(s.rule); add(s.x); add(s.y); add(s.z); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Escribe la región en una rejilla de bloques, con la región puesta en (ox, oy, oz) de la rejilla: sus celdas (los
// tramos de cada columna de una vez) y lo sembrado que la toca, recortado a la región (lo de fuera lo escribe la
// región vecina). opts.skip: materiales que no se escriben (el agua, si la dibuja un WaterLayer)
export function applyRegion(r: GeneratedRegion, grid: BlockGrid, at: readonly [number, number, number] = [0, 0, 0], opts: { skip?: readonly number[] } = {}): void {
  const { x0, y0, z0, width: W, depth: D, height: H } = r.region, [ox, oy, oz] = at;
  const skip = new Set(opts.skip ?? []);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    let z = 0;
    while (z < H) {
      const t = r.cells[(z * D + y) * W + x]!;
      let e = z;
      while (e + 1 < H && r.cells[((e + 1) * D + y) * W + x] === t) e++;
      if (t && !skip.has(t)) grid.fill([ox + x, oy + y, oz + z], [ox + x, oy + y, oz + e], t);
      z = e + 1;
    }
  }
  for (const s of r.touching) for (const [dx, dy, dz, t] of r.structures[s.rule]!) {
    const wx = s.x + dx, wy = s.y + dy, wz = s.z + dz;
    if (wx < x0 || wy < y0 || wz < z0 || wx >= x0 + W || wy >= y0 + D || wz >= z0 + H) continue;
    grid.set(ox + wx - x0, oy + wy - y0, oz + wz - z0, t);
  }
}
