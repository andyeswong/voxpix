// Lo que cuesta el mundo por regiones (src/world/regiongen.ts), en Bun sin freno, con el spec de
// test/mundo-regiones.test.ts (vetas, cuevas, árboles y flores) y bloques de 8 vóxeles:
// - generar un trozo de 16 x 16 x 24 bloques (generateRegion) en TROZOS sitios distintos: p50, p95;
// - una región de 96 x 96 entera, y generateMap del mismo tamaño;
// - escribir un trozo en la rejilla: applyRegion (vóxel a vóxel) y grid.stampRegion (por trozo de vóxeles).
//   bun scripts/bench-region.ts [trozos 36]
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, applyRegion, type RegionSpec } from '../src/world/regiongen';
import { generateMap } from '../src/world/mapgen';

const B = 8, C = 16, H = 24, CHUNKS = Number(process.argv[2] ?? 36);
const ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'mena', 'tronco', 'hojas', 'flor'];
const colors = ['#565e68', '#6a4a30', '#2e7038', '#2f6a86', '#d8c290', '#1e1e26', '#b8602e', '#4a2f1d', '#2a5426', '#d02c30'];
const pal: Palette = { ramps: colors.map((c, i) => ({ name: ids[i]!, colors: [c, c, c] })) };
const cube = (r: number): Array<[number, number, number, number]> => {
  const o: Array<[number, number, number, number]> = [];
  for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, 1 + ((x + y + z) % 2))]);
  return o;
};
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as VoxsetFile);
const T = (id: string) => set.index(id);
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) leaves.push([dx, dy, 4, T('hojas')]);
// El de test/mundo-regiones.test.ts, con los índices de este set
const SPEC: RegionSpec = {
  seed: 11, width: 96, depth: 96, height: H,
  surface: { base: 11, amplitude: 4, scale: 9 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
  seaLevel: 10, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 },
  veins: [
    { material: T('carbon'), in: [T('piedra')], z: [3, 9], density: 0.06, size: [2, 5] },
    { material: T('mena'), in: [T('piedra')], z: [1, 6], density: 0.03, size: [2, 4] },
  ],
  caves: { count: 20, z: [2, 8], length: [20, 40], radius: [1, 1.7] },
  scatter: [
    { on: [T('hierba')], density: 0.03, spacing: 4, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves, [0, 0, 5, T('hojas')]] },
    { on: [T('hierba')], density: 0.08, structure: [[0, 0, 1, T('flor')]] },
  ],
};
const p = (a: number[], q: number) => [...a].sort((u, v) => u - v)[Math.floor(q * (a.length - 1))]!;
const f = (v: number) => v.toFixed(1);

// Calentar (JIT) con unos trozos lejos de los medidos
for (let k = 0; k < 4; k++) generateRegion(SPEC, { x0: -1000 - k * C, y0: -1000, z0: 0, width: C, depth: C, height: H });

// Generar trozos en sitios distintos (una rejilla de lado ceil(sqrt(TROZOS)))
const side = Math.ceil(Math.sqrt(CHUNKS)), gen: number[] = [], regions = [];
for (let k = 0; k < CHUNKS; k++) {
  const a = performance.now();
  regions.push(generateRegion(SPEC, { x0: (k % side) * C, y0: Math.floor(k / side) * C, z0: 0, width: C, depth: C, height: H }));
  gen.push(performance.now() - a);
}
console.log(`generar un trozo de ${C} x ${C} x ${H} (${CHUNKS} trozos): p50 ${f(p(gen, 0.5))} ms, p95 ${f(p(gen, 0.95))} ms, máx ${f(p(gen, 1))} ms`);

// Una región de 96 x 96, y generateMap del mismo tamaño (tres veces cada una: la mejor y la peor)
const big: number[] = [], map: number[] = [];
for (let k = 0; k < 3; k++) {
  let a = performance.now(); generateRegion(SPEC, { x0: 0, y0: 0, z0: 0, width: 96, depth: 96, height: H }); big.push(performance.now() - a);
  a = performance.now(); generateMap(SPEC); map.push(performance.now() - a);
}
console.log(`región de 96 x 96: ${f(Math.min(...big))}-${f(Math.max(...big))} ms; generateMap del mismo tamaño: ${f(Math.min(...map))}-${f(Math.max(...map))} ms`);

// Escribir cada trozo en una rejilla de su tamaño: applyRegion y stampRegion (cada uno en una rejilla nueva)
const grid = () => new BlockGrid(new WorldState(new StaticVoxels(pal, C * B, C * B, 0, H * B - 1), [], null), set);
const apply: number[] = [], stamp: number[] = [];
for (const r of regions.slice(0, Math.min(CHUNKS, 12))) {
  let g = grid(), a = performance.now();
  applyRegion(r, g);
  apply.push(performance.now() - a);
  g = grid(); a = performance.now();
  g.stampRegion(r);
  stamp.push(performance.now() - a);
}
console.log(`escribir un trozo (${apply.length}): applyRegion p50 ${f(p(apply, 0.5))} ms, p95 ${f(p(apply, 0.95))} ms; stampRegion p50 ${f(p(stamp, 0.5))} ms, p95 ${f(p(stamp, 0.95))} ms`);
