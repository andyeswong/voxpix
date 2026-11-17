// Lo que cuesta mover la ventana viva (StaticVoxels.shift): una ventana de 8 x 13 trozos de 16 x 16 bloques de 8
// (1024 x 1664 x 192 vóxeles) llena con el mundo por regiones de bench-region, corrida un trozo (8 trozos de vóxeles)
// en cada dirección, en Bun sin freno. Y lo que pesa.
//   bun scripts/bench-ventana.ts [veces 8]
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, type RegionSpec } from '../src/world/regiongen';

const B = 8, C = 16, H = 24, TIMES = Number(process.argv[2] ?? 8);
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

const NX = 8, NY = 13, TV = C * B;
const s = new StaticVoxels(pal, NX * TV, NY * TV, 0, H * B - 1);
const grid = new BlockGrid(new WorldState(s, [], null), set);
let a = performance.now();
for (let ty = 0; ty < NY; ty++) for (let tx = 0; tx < NX; tx++) grid.stampRegion(generateRegion(SPEC, { x0: tx * C, y0: ty * C, z0: 0, width: C, depth: C, height: H }), [tx * C, ty * C, 0]);
console.log(`llenar ${NX} x ${NY} trozos: ${((performance.now() - a) / 1000).toFixed(1)} s; vóxeles ${(s.byteLength / 1e6).toFixed(0)} MB`);
s.forEachExposed(() => {});                                     // las máscaras hechas (como tras hornear)
const ms: number[] = [], k = TV / 16;
for (let i = 0; i < TIMES; i++) for (const [dx, dy] of [[k, 0], [0, k], [-k, 0], [0, -k]] as const) {
  a = performance.now(); s.shift(dx, dy); ms.push(performance.now() - a);
}
console.log(`shift de un trozo (${ms.length}): p50 ${f(p(ms, 0.5))} ms, p95 ${f(p(ms, 0.95))} ms, máx ${f(p(ms, 1))} ms`);
