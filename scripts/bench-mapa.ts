// Lo que cuesta un mapa por semilla (src/world/mapgen.ts) del tamaño de un mundo de bloques grande: 384 x 384 x 96
// vóxeles (48 x 48 x 12 bloques de 8). Generarlo (generateMap, en celdas) y escribirlo en el mundo (applyMap: BlockGrid
// -> vóxeles), por separado, sin freno.
//   bun scripts/bench-mapa.ts [semillas=1,2,3]
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateMap, applyMap, mapHash, type MapSpec } from '../src/world/mapgen';

const B = 8, CW = 48, CD = 48, CH = 12;
const ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'hierro', 'oro', 'tronco', 'hojas', 'flor'];
const colors = ['#565e68', '#6a4a30', '#2e7038', '#2f6a86', '#d8c290', '#1e1e26', '#b8602e', '#e8b830', '#4a2f1d', '#2a5426', '#d02c30'];
const pal: Palette = { ramps: colors.map((c, i) => ({ name: ids[i]!, colors: [c, c, c] })) };
const cube = (r: number): Array<[number, number, number, number]> => {
  const o: Array<[number, number, number, number]> = [];
  for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, 1 + ((x + y + z) % 2))]);
  return o;
};
const file: VoxsetFile = { format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) };
const set = BlockSet.fromJSON(file);
const T = (id: string) => set.index(id);

function spec(seed: number): MapSpec {
  const leaves: Array<[number, number, number, number]> = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leaves.push([dx!, dy!, 4, T('hojas')]);
  return {
    seed, width: CW, depth: CD, height: CH,
    surface: { base: 6, amplitude: 2.5, scale: 9 },
    strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
    seaLevel: 5, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 },
    veins: [
      { material: T('carbon'), in: [T('piedra')], z: [3, 6], density: 0.06, size: [2, 5] },
      { material: T('hierro'), in: [T('piedra')], z: [1, 4], density: 0.03, size: [2, 4] },
      { material: T('oro'), in: [T('piedra')], z: [0, 2], density: 0.01, size: [1, 3] },
    ],
    caves: { count: 10, z: [1, 5], length: [20, 40], radius: [1, 1.7] },
    scatter: [
      { on: [T('hierba')], density: 0.02, spacing: 4, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves, [0, 0, 5, T('hojas')]] },
      { on: [T('hierba')], density: 0.05, structure: [[0, 0, 1, T('flor')]] },
    ],
  };
}

const seeds = (process.argv[2] ?? '1,2,3').split(',').map(Number);
for (const seed of seeds) {
  const a = performance.now();
  const map = generateMap(spec(seed));
  const b = performance.now();
  const s = new StaticVoxels(pal, CW * B, CD * B, 0, CH * B - 1);
  const grid = new BlockGrid(new WorldState(s, [], null), set);
  const c = performance.now();
  applyMap(map, grid);
  const d = performance.now();
  let water = 0, filled = 0;
  for (const v of map.cells) { if (v) filled++; if (v === T('agua')) water++; }
  console.log(`semilla ${seed}: generar ${(b - a).toFixed(1)} ms · escribir en el mundo ${(d - c).toFixed(0)} ms (${(s.size / 1e6).toFixed(2)} M vóxeles) · ${filled} celdas llenas, ${water} de agua, ${map.sown.length} sembradas · huella ${mapHash(map)}`);
}
