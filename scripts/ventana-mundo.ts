// El mundo por regiones de bench-region y bench-ventana (y de app/ventana.html): el spec de test/mundo-regiones.test.ts
// (vetas, cuevas, árboles y flores) con un set de bloques de 8 vóxeles, y una ventana de nx x ny trozos de 16 x 16
// bloques llena con él
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, type RegionSpec } from '../src/world/regiongen';

export const B = 8, C = 16, H = 24, TV = C * B;

const ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'mena', 'tronco', 'hojas', 'flor'];
const colors = ['#565e68', '#6a4a30', '#2e7038', '#2f6a86', '#d8c290', '#1e1e26', '#b8602e', '#4a2f1d', '#2a5426', '#d02c30'];
export const pal: Palette = { ramps: colors.map((c, i) => ({ name: ids[i]!, colors: [c, c, c] })) };
const cube = (r: number): Array<[number, number, number, number]> => {
  const o: Array<[number, number, number, number]> = [];
  for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, 1 + ((x + y + z) % 2))]);
  return o;
};

export const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as VoxsetFile);
const T = (id: string) => set.index(id);
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) leaves.push([dx, dy, 4, T('hojas')]);
// El de test/mundo-regiones.test.ts, con los índices de este set
export const SPEC: RegionSpec = {
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

// Una ventana de nx x ny trozos (la esquina en el trozo 0, 0) llena con el mundo
export function windowWorld(nx: number, ny: number): StaticVoxels {
  const s = new StaticVoxels(pal, nx * TV, ny * TV, 0, H * B - 1);
  const grid = new BlockGrid(new WorldState(s, [], null), set);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) grid.stampRegion(generateRegion(SPEC, { x0: tx * C, y0: ty * C, z0: 0, width: C, depth: C, height: H }), [tx * C, ty * C, 0]);
  return s;
}
