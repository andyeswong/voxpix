// TERRENO POR SEMILLA para un mundo de bloques: la superficie (una altura por columna, con ruido), las capas
// por profundidad, las vetas dentro de una capa y lo que se planta encima (estructuras: un árbol, una roca, lo que
// sea, como lista de bloques). Todo como datos (TerrainSpec), determinista: la misma semilla da el mismo terreno en
// cualquier máquina. Escribe en una BlockGrid antes de hornear. Sin cuevas (solo superficie).
// docs/motor.md, "Terreno por semilla".
import { fbmN, lattice } from '../worldgen/noise';
import { createRng } from '../sim/rng';
import type { BlockGrid } from './blocks';

export interface TerrainSpec {
  seed: number;
  // La altura de cada columna, en bloques: base +- amplitude, con ruido de `scale` bloques y `octaves` octavas. Se
  // queda entre 0 y la última capa de la rejilla
  surface: { base: number; amplitude: number; scale: number; octaves?: number };
  // De arriba abajo: cada capa, su bloque y cuántos bloques mide; la última (sin depth) llega hasta abajo
  layers: Array<{ block: string; depth?: number }>;
  // Vetas: en los bloques `in`, entre las alturas bz [desde, hasta], cada uno empieza una veta con probabilidad
  // `chance`; la veta crece por vecinos `in` hasta size [mínimo, máximo] bloques
  veins?: Array<{ block: string; in: string; chance: number; size: [number, number]; bz?: [number, number] }>;
  // Plantar: sobre las columnas cuyo bloque de arriba es `on`, con probabilidad `density`, separadas al menos `spacing`
  // bloques (en x e y), la estructura: bloques [dx, dy, dz, bloque] relativos al de arriba (dz = 1, el de encima). Solo
  // se planta si toda la estructura cabe en la rejilla y va sobre aire
  scatter?: Array<{ on: string; density: number; spacing?: number; structure: Array<[number, number, number, string]> }>;
}

export interface Terrain {
  heights: Int16Array;          // por columna (by * cols + bx): el bz del bloque de arriba (sin lo plantado), -1 si nada
}

export function generateTerrain(spec: TerrainSpec, grid: BlockGrid): Terrain {
  const set = grid.blocks, { cols, rows, layers } = grid;
  if (!spec.layers.length) throw new Error('el terreno necesita al menos una capa');
  const layerIds = spec.layers.map((l) => set.index(l.block));
  const oct = spec.surface.octaves ?? 3;
  const heights = new Int16Array(cols * rows);
  // 1) la superficie y las capas: una rejilla de tipos que se escribe al final
  const type = new Uint16Array(cols * rows * layers);
  const at = (bx: number, by: number, bz: number) => (bz * rows + by) * cols + bx;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    const n = fbmN(bx / spec.surface.scale, by / spec.surface.scale, spec.seed, oct) * 2 - 1;
    const h = Math.max(0, Math.min(layers - 1, Math.round(spec.surface.base + spec.surface.amplitude * n)));
    heights[by * cols + bx] = h;
    for (let bz = h, d = 0; bz >= 0; bz--, d++) {
      let li = 0, acc = 0;
      while (li < spec.layers.length - 1 && d >= acc + (spec.layers[li]!.depth ?? Infinity)) acc += spec.layers[li++]!.depth ?? 0;
      type[at(bx, by, bz)] = layerIds[li]!;
    }
  }
  // 2) las vetas, en orden fijo y cada una con su azar
  (spec.veins ?? []).forEach((v, vi) => {
    const id = set.index(v.block), inside = set.index(v.in), rng = createRng((spec.seed ^ Math.imul(vi + 1, 0x9e3779b1)) >>> 0);
    const [z0, z1] = v.bz ?? [0, layers - 1];
    for (let bz = Math.max(0, z0); bz <= Math.min(layers - 1, z1); bz++) for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      if (type[at(bx, by, bz)] !== inside || rng() >= v.chance) continue;
      const want = v.size[0] + Math.floor(rng() * (v.size[1] - v.size[0] + 1));
      let x = bx, y = by, z = bz;
      for (let k = 0, tries = 0; k < want && tries < want * 8; tries++) {
        if (x >= 0 && y >= 0 && x < cols && y < rows && z >= Math.max(0, z0) && z <= Math.min(layers - 1, z1) && type[at(x, y, z)] === inside) { type[at(x, y, z)] = id; k++; }
        const dir = Math.floor(rng() * 6);
        if (dir === 0) x++; else if (dir === 1) x--; else if (dir === 2) y++; else if (dir === 3) y--; else if (dir === 4) z++; else z--;
        x = Math.max(0, Math.min(cols - 1, x)); y = Math.max(0, Math.min(rows - 1, y)); z = Math.max(0, Math.min(layers - 1, z));
      }
    }
  });
  // 3) escribir columna a columna (tramos seguidos del mismo tipo de una vez)
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
    let bz = 0;
    while (bz < layers) {
      const t = type[at(bx, by, bz)]!;
      let e = bz;
      while (e + 1 < layers && type[at(bx, by, e + 1)] === t) e++;
      if (t) grid.fill([bx, by, bz], [bx, by, e], t);
      bz = e + 1;
    }
  }
  // 4) lo plantado, con grid.set (aplica las variantes tapadas y la luz que emitan)
  (spec.scatter ?? []).forEach((sc, si) => {
    const on = set.index(sc.on), parts = sc.structure.map(([dx, dy, dz, b]) => [dx, dy, dz, set.index(b)] as const);
    const spacing = sc.spacing ?? 0, placed: Array<[number, number]> = [];
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const h = heights[by * cols + bx]!;
      if (h < 0 || grid.get(bx, by, h) !== on) continue;
      if (lattice(bx, by, (spec.seed ^ Math.imul(si + 1, 0x85ebca6b)) | 0) >= sc.density) continue;
      if (placed.some(([px, py]) => Math.abs(px - bx) < spacing && Math.abs(py - by) < spacing)) continue;
      const fits = parts.every(([dx, dy, dz]) => {
        const x = bx + dx, y = by + dy, z = h + dz;
        return x >= 0 && y >= 0 && z >= 0 && x < cols && y < rows && z < layers && grid.get(x, y, z) === 0;
      });
      if (!fits) continue;
      for (const [dx, dy, dz, t] of parts) grid.set(bx + dx, by + dy, h + dz, t);
      placed.push([bx, by]);
    }
  });
  return { heights };
}
