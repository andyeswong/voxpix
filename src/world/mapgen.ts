// UN MAPA POR SEMILLA, en celdas (bloques): relieve por ruido, estratos por profundidad, lagos bajo el nivel del mar con
// su orilla, vetas, cuevas y lo que se siembra encima (árboles, flores...). El motor no sabe qué es cada material: son
// números que pone quien llama (con un BlockGrid, los índices de su set; 0 es aire). Determinista: la misma semilla y
// el mismo spec dan las mismas celdas y la misma lista de siembras, en cualquier máquina (sin reloj ni Math.random).
//   const map = generateMap(spec);            // puro: no toca ningún mundo
//   applyMap(map, grid);                       // y lo escribe en un BlockGrid (los tramos de una vez, lo sembrado con set)
import { fbmN, lattice } from '../worldgen/noise';
import { createRng } from '../sim/rng';
import type { BlockGrid } from './blocks';

export interface MapSpec {
  seed: number;
  width: number; depth: number; height: number;                  // celdas: x, y y z
  // La altura de cada columna (la celda z de arriba del terreno): base +- amplitude, con ruido de `scale` celdas y
  // `octaves` octavas (por defecto 3). Se queda entre 0 y height - 1
  surface: { base: number; amplitude: number; scale: number; octaves?: number };
  // De arriba abajo: cada estrato, su material y cuántas celdas mide; el último (sin depth) llega hasta abajo
  strata: Array<{ material: number; depth?: number }>;
  // Agua: las columnas cuya superficie queda por debajo de seaLevel se llenan de `water` hasta seaLevel (lagos en las
  // cuencas). Sin `water`, no hay agua
  seaLevel?: number;
  water?: number;
  // La orilla: el lecho de los lagos y la tierra a `width` columnas del agua (por defecto 1) que no sube más de 1 sobre
  // el nivel del mar pasan a `material` en sus `depth` celdas de arriba (por defecto 1)
  shore?: { material: number; width?: number; depth?: number };
  // Vetas: dentro de los materiales `in` y entre las celdas z [z0, z1], manchas de size [mínimo, máximo] celdas (por
  // defecto [2, 6]) que crecen por vecinos. `density`: la parte de esas celdas que acaba siendo veta (aproximada)
  veins?: Array<{ material: number; in: number[]; z: [number, number]; density: number; size?: [number, number] }>;
  // Cuevas: `count` gusanos que empiezan entre las celdas z [z0, z1], avanzan `length` [mín, máx] celdas girando poco a
  // poco y vacían una esfera de radius [mín, máx] a su paso. No tocan la capa z = 0 ni las columnas con agua
  caves?: { count: number; z: [number, number]; length: [number, number]; radius: [number, number] };
  // Lo que se siembra: sobre las columnas cuyo material de arriba es uno de `on` (y fuera del agua), con probabilidad
  // `density`, a `spacing` columnas o más de lo anterior de la misma regla, la estructura [dx, dy, dz, material]
  // relativa a la celda de arriba (dz = 1, la de encima). Solo si cabe entera en el mapa y va sobre aire
  // inWater: al revés, solo sobre el fondo del agua, y puede ocupar celdas de agua (plantas de agua)
  scatter?: Array<{ on: number[]; density: number; spacing?: number; inWater?: boolean; structure: Array<[number, number, number, number]> }>;
}

export interface MapSown { rule: number; x: number; y: number; z: number }   // la celda de arriba sobre la que se siembra

export interface GeneratedMap {
  readonly width: number; readonly depth: number; readonly height: number;
  readonly cells: Uint16Array;           // material de cada celda, índice (z * depth + y) * width + x; 0 = aire
  readonly heights: Int16Array;          // por columna (y * width + x): la celda z más alta que no es aire ni agua; -1 si nada
  readonly sown: MapSown[];              // lo sembrado (no está en cells: lo escribe quien lo use, p. ej. applyMap)
  readonly structures: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>>;   // las de spec.scatter
}

const at = (m: { width: number; depth: number }, x: number, y: number, z: number) => (z * m.depth + y) * m.width + x;

export function generateMap(spec: MapSpec): GeneratedMap {
  const { width: W, depth: D, height: H, seed } = spec;
  if (!spec.strata.length) throw new Error('el mapa necesita al menos un estrato');
  const cells = new Uint16Array(W * D * H), heights = new Int16Array(W * D);
  const m = { width: W, depth: D };
  const oct = spec.surface.octaves ?? 3;
  // 1) el relieve y los estratos
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const n = fbmN(x / spec.surface.scale, y / spec.surface.scale, seed, oct) * 2 - 1;
    const h = Math.max(0, Math.min(H - 1, Math.round(spec.surface.base + spec.surface.amplitude * n)));
    heights[y * W + x] = h;
    for (let z = h, d = 0; z >= 0; z--, d++) {
      let li = 0, acc = 0;
      while (li < spec.strata.length - 1 && d >= acc + (spec.strata[li]!.depth ?? Infinity)) acc += spec.strata[li++]!.depth ?? 0;
      cells[at(m, x, y, z)] = spec.strata[li]!.material;
    }
  }
  // 2) el agua hasta el nivel del mar, y la orilla
  const sea = spec.seaLevel ?? -1, water = spec.water ?? 0;
  const wet = new Uint8Array(W * D);
  if (water && sea >= 0) for (let i = 0; i < W * D; i++) {
    const h = heights[i]!;
    if (h >= sea) continue;
    wet[i] = 1;
    for (let z = h + 1; z <= Math.min(sea, H - 1); z++) cells[z * W * D + i] = water;
  }
  if (spec.shore && water && sea >= 0) {
    const { material, width: sw = 1, depth: sd = 1 } = spec.shore;
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, h = heights[i]!;
      let near = wet[i] === 1;
      if (!near && h <= sea + 1) for (let dy = -sw; dy <= sw && !near; dy++) for (let dx = -sw; dx <= sw && !near; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < D && wet[ny * W + nx]) near = true;
      }
      if (near) for (let z = h; z > h - sd && z >= 0; z--) cells[at(m, x, y, z)] = material;
    }
  }
  // 3) las vetas, en orden fijo y cada una con su azar: cada celda de su materia empieza una mancha con la probabilidad
  // que deja, de media, `density` de esas celdas cubiertas
  (spec.veins ?? []).forEach((v, vi) => {
    const rng = createRng((seed ^ Math.imul(vi + 1, 0x9e3779b1)) >>> 0);
    const [s0, s1] = v.size ?? [2, 6], chance = v.density / ((s0 + s1) / 2);
    const host = new Set(v.in);
    const z0 = Math.max(0, v.z[0]), z1 = Math.min(H - 1, v.z[1]);
    for (let z = z0; z <= z1; z++) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
      if (!host.has(cells[at(m, x, y, z)]!) || rng() >= chance) continue;
      const want = s0 + Math.floor(rng() * (s1 - s0 + 1));
      let cx = x, cy = y, cz = z;
      for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
        if (cx >= 0 && cy >= 0 && cx < W && cy < D && cz >= z0 && cz <= z1 && host.has(cells[at(m, cx, cy, cz)]!)) { cells[at(m, cx, cy, cz)] = v.material; k++; }
        const dir = Math.floor(rng() * 6);
        if (dir === 0) cx++; else if (dir === 1) cx--; else if (dir === 2) cy++; else if (dir === 3) cy--; else if (dir === 4) cz++; else cz--;
        cx = Math.max(0, Math.min(W - 1, cx)); cy = Math.max(0, Math.min(D - 1, cy)); cz = Math.max(z0, Math.min(z1, cz));
      }
    }
  });
  // 4) las cuevas: gusanos que giran poco a poco (el rumbo y la pendiente cambian con su azar) y vacían esferas
  if (spec.caves) {
    const c = spec.caves, rng = createRng((seed ^ 0x27d4eb2f) >>> 0);
    for (let w = 0; w < c.count; w++) {
      let x = rng() * W, y = rng() * D, z = c.z[0] + rng() * (c.z[1] - c.z[0]);
      let yaw = rng() * Math.PI * 2, pitch = (rng() - 0.5) * 0.6;
      const len = c.length[0] + Math.floor(rng() * (c.length[1] - c.length[0] + 1));
      const r = c.radius[0] + rng() * (c.radius[1] - c.radius[0]);
      for (let s = 0; s < len; s++) {
        const R = Math.ceil(r);
        for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          if (dx * dx + dy * dy + dz * dz > r * r) continue;
          const cx = Math.floor(x) + dx, cy = Math.floor(y) + dy, cz = Math.floor(z) + dz;
          if (cx < 0 || cy < 0 || cx >= W || cy >= D || cz < 1 || cz >= H || wet[cy * W + cx]) continue;
          const i = at(m, cx, cy, cz);
          if (cells[i] !== water) cells[i] = 0;
        }
        yaw += (rng() - 0.5) * 0.8; pitch = Math.max(-0.5, Math.min(0.5, pitch + (rng() - 0.5) * 0.3));
        x += Math.cos(yaw) * Math.cos(pitch); y += Math.sin(yaw) * Math.cos(pitch); z += Math.sin(pitch);
        z = Math.max(c.z[0], Math.min(c.z[1], z));
      }
    }
  }
  // La altura de cada columna, tras las cuevas: lo más alto que no es aire ni agua
  for (let i = 0; i < W * D; i++) {
    let z = H - 1;
    while (z >= 0 && (cells[z * W * D + i] === 0 || cells[z * W * D + i] === water)) z--;
    heights[i] = z;
  }
  // 5) lo sembrado: la lista (las celdas que ocupa se apartan para que dos estructuras no se pisen)
  const sown: MapSown[] = [], taken = new Uint8Array(W * D * H);
  const structures = (spec.scatter ?? []).map((sc) => sc.structure);
  (spec.scatter ?? []).forEach((sc, si) => {
    const on = new Set(sc.on), spacing = sc.spacing ?? 0, placed: Array<[number, number]> = [];
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, h = heights[i]!;
      if (h < 0 || !!wet[i] !== !!sc.inWater || !on.has(cells[at(m, x, y, h)]!)) continue;
      if (lattice(x, y, (seed ^ Math.imul(si + 1, 0x85ebca6b)) | 0) >= sc.density) continue;
      if (placed.some(([px, py]) => Math.abs(px - x) < spacing && Math.abs(py - y) < spacing)) continue;
      const fits = sc.structure.every(([dx, dy, dz]) => {
        const cx = x + dx, cy = y + dy, cz = h + dz;
        return cx >= 0 && cy >= 0 && cz >= 0 && cx < W && cy < D && cz < H && (cells[at(m, cx, cy, cz)] === 0 || (!!sc.inWater && cells[at(m, cx, cy, cz)] === spec.water)) && !taken[at(m, cx, cy, cz)];
      });
      if (!fits) continue;
      for (const [dx, dy, dz] of sc.structure) taken[at(m, x + dx, y + dy, h + dz)] = 1;
      sown.push({ rule: si, x, y, z: h });
      placed.push([x, y]);
    }
  });
  return { width: W, depth: D, height: H, cells, heights, sown, structures };
}

// Las columnas por tramos: para la columna (x, y), los tramos [z0, z1, material] seguidos del mismo material, de abajo
// arriba (el aire no sale)
export function mapColumn(map: GeneratedMap, x: number, y: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  let z = 0;
  while (z < map.height) {
    const t = map.cells[at(map, x, y, z)]!;
    let e = z;
    while (e + 1 < map.height && map.cells[at(map, x, y, e + 1)] === t) e++;
    if (t) out.push([z, e, t]);
    z = e + 1;
  }
  return out;
}

// Escribe el mapa en una rejilla de bloques (con los materiales como tipos de su set): los tramos de cada columna de
// una vez (grid.fill) y lo sembrado con grid.set (aplica las variantes tapadas y la luz que emitan). El mapa tiene que
// caber en la rejilla
// opts.skip: materiales que no se escriben (el agua, si la dibuja un WaterLayer: ver mapWater)
export function applyMap(map: GeneratedMap, grid: BlockGrid, opts: { skip?: readonly number[] } = {}): void {
  if (map.width > grid.cols || map.depth > grid.rows || map.height > grid.layers) throw new Error(`el mapa (${map.width} x ${map.depth} x ${map.height}) no cabe en la rejilla (${grid.cols} x ${grid.rows} x ${grid.layers})`);
  const skip = new Set(opts.skip ?? []);
  for (let y = 0; y < map.depth; y++) for (let x = 0; x < map.width; x++) for (const [z0, z1, t] of mapColumn(map, x, y)) if (!skip.has(t)) grid.fill([x, y, z0], [x, y, z1], t);
  for (const s of map.sown) for (const [dx, dy, dz, t] of map.structures[s.rule]!) grid.set(s.x + dx, s.y + dy, s.z + dz, t);
}

// El agua del mapa para un WaterLayer (agua por columnas, con ondas): por columna de VÓXELES (bloques de `size`),
// si empieza con agua (wet) y la altura de su superficie (waterTop: la cara de arriba de la celda de agua más alta).
// Se escribe el mapa sin el agua (applyMap con skip: [water]) y se crea el agua con { ...esto, model, width, depth }
export function mapWater(map: GeneratedMap, size: number, water: number): { wet: Uint8Array; waterTop: Int16Array } {
  const W = map.width * size, D = map.depth * size, wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  for (let y = 0; y < map.depth; y++) for (let x = 0; x < map.width; x++) {
    let top = -1;
    for (let z = map.height - 1; z >= 0 && top < 0; z--) if (map.cells[at(map, x, y, z)] === water) top = z;
    if (top < 0) continue;
    for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
      const i = (y * size + dy) * W + x * size + dx;
      wet[i] = 1; waterTop[i] = (top + 1) * size;
    }
  }
  return { wet, waterTop };
}

// La huella del mapa (FNV-1a de 32 bits sobre las celdas y lo sembrado): para comprobar que una semilla da lo mismo
export function mapHash(map: GeneratedMap): string {
  let h = 0x811c9dc5;
  const add = (v: number) => { h ^= v & 0xffff; h = Math.imul(h, 0x01000193); h ^= v >>> 16; h = Math.imul(h, 0x01000193); };
  add(map.width); add(map.depth); add(map.height);
  for (let i = 0; i < map.cells.length; i++) add(map.cells[i]!);
  for (const s of map.sown) { add(s.rule); add(s.x); add(s.y); add(s.z); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
