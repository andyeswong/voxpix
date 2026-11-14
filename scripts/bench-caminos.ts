// Coste de LevelPathField en un terreno de bloques de 384 x 384 x 96 (el de bench-picar, con un túnel): construir, la
// búsqueda al cambiar la meta (lo de toward), dir en caliente y la búsqueda tras picar un bloque. Sin freno.
// Uso: bun scripts/bench-caminos.ts (RADIO=n: otro radio del cuerpo). Las opciones, las de un cuerpo de 3 x 14 que sube un bloque (cell 4, radius 1,
// height 14, step 8, maxDrop 64)
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { LevelPathField } from '../src/world/levelpaths';
import { clearBox } from '../src/world/edit';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { generateTerrain } from '../src/world/terrain';
import type { Palette } from '../src/core';

const W = 384, ZT = 96, B = 8;
// MUNDO=bloques: un mundo de bloques de 48 x 48 x 12 con generateTerrain (superficie con ruido, capas, vetas y árboles
// con hojas que no se suben), como el de un juego de bloques. Si no, el terreno de bench-picar con un túnel
const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68'] }, { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] }, { name: 'carbon', colors: ['#101010', '#202020', '#303030'] },
  { name: 'tronco', colors: ['#2b1b12', '#4a2f1d', '#6e4729'] }, { name: 'hojas', colors: ['#1f3a22', '#2f5a2f', '#46803c'], material: 'arbusto' },
] } as Palette;
const s = new StaticVoxels(pal, W, W, 0, ZT - 1);
const blockWorld = process.env.MUNDO === 'bloques';
const half = Math.floor(ZT / B / 2);
const hb = (bx: number, by: number) => half + Math.round(3 * Math.sin(bx / 5.3) * Math.cos(by / 4.1));
if (blockWorld) {
  const cube = (r: number, keep: (x: number, y: number, z: number) => boolean = () => true) => {
    const o: Array<[number, number, number, number]> = [];
    for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) if (keep(x, y, z)) o.push([x, y, z, material(r, (x + y + z) % 3)]);
    return o;
  };
  const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: [
    { id: 'piedra', voxels: cube(0) }, { id: 'hierba', voxels: cube(1), props: { covered: 'tierra' } }, { id: 'tierra', voxels: cube(2) },
    { id: 'carbon', voxels: cube(3) },
    { id: 'tronco', voxels: cube(4, (x, y) => Math.hypot(x - 3.5, y - 3.5) < 3.2) },                  // redondeado
    { id: 'hojas', voxels: cube(5, (x, y, z) => ((x * 7 + y * 13 + z * 5) % 11) > 1) },              // ~18 % de huecos
  ] });
  const leaf: Array<[number, number, number, string]> = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leaf.push([dx!, dy!, 4, 'hojas']);
  generateTerrain({
    seed: 1, surface: { base: 6, amplitude: 2, scale: 9, octaves: 3 },
    layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],
    veins: [{ block: 'carbon', in: 'piedra', chance: 0.08, size: [1, 3], bz: [0, 5] }],
    scatter: [{ on: 'hierba', density: 0.02, spacing: 4, structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'tronco'], [0, 0, 3, 'tronco'], ...leaf, [0, 0, 5, 'hojas']] }],
  }, new BlockGrid(new WorldState(s, [], null), set));
} else for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const top = hb(x >> 3, y >> 3) * B;
  for (let z = 0; z < top; z++) {
    if (y >= 184 && y < 200 && x >= 40 && x < 344 && z >= 16 && z < 32) continue;
    s.set(x, y, z, z >= top - B ? material(1, 1) : material(0, 1));
  }
}
const st = new WorldState(s, [], null);
const O = { cell: 4, radius: Number(process.env.RADIO ?? 1), height: 14, step: 8, maxDrop: 64 };
let t = performance.now();
const f = new LevelPathField(st, O);
const build = performance.now() - t;
const top = (x: number, y: number) => blockWorld ? s.height[Math.floor(y) * W + Math.floor(x)]! : hb(x >> 3, y >> 3) * B;
const goals: Array<{ x: number; y: number; z: number }> = [];
for (let k = 0; k < 40; k++) { const x = 100 + ((k * 37) % 180), y = 100 + ((k * 53) % 180); goals.push({ x, y, z: top(x, y) }); }
const search: number[] = [], dir: number[] = [], dug: number[] = [];
for (let k = 0; k < goals.length; k++) {
  const g = goals[k]!;
  t = performance.now(); f.dir({ x: 30, y: 30, z: top(30, 30) }, g); const a = performance.now() - t;
  t = performance.now(); for (let e = 0; e < 20; e++) f.dir({ x: 40 + e * 7, y: 60 + e * 5, z: top(40 + e * 7, 60 + e * 5) }, g); const d = performance.now() - t;
  if (k >= 8) { search.push(a); dir.push(d); }
}
for (let k = 0; k < 24; k++) {
  const bx = 10 + k, by = 30;
  clearBox(st, { x0: bx * B, y0: by * B, z0: top(bx * B, by * B) - B, x1: bx * B + B - 1, y1: by * B + B - 1, z1: top(bx * B, by * B) - 1 });
  t = performance.now(); f.dir({ x: 30, y: 30, z: top(30, 30) }, goals[0]!); const a = performance.now() - t;
  if (k >= 8) dug.push(a);
}
const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]!.toFixed(2);
console.log(`${f.cols}x${f.rows}x${f.L} nodos: construir ${build.toFixed(1)} ms; búsqueda p50 ${p(search, 0.5)} p95 ${p(search, 0.95)} ms; dir x20 p50 ${p(dir, 0.5)} ms; tras picar p50 ${p(dug, 0.5)} p95 ${p(dug, 0.95)} ms`);
f.close();
// Repartida: lo que cuesta cada advance() con tandas de BUDGET nodos (por defecto 2000), buscando de nuevo cada 12 ticks
const BUDGET = Number(process.env.BUDGET ?? 2000);
if ((LevelPathField.prototype as unknown as { advance?: unknown }).advance) {
  const g2 = new LevelPathField(st, { ...O, budget: BUDGET });
  const per: number[] = [];
  let ticks = 0, done = 0;
  for (let k = 0; k < 400; k++) {
    if (k % 12 === 0) g2.dir({ x: 30, y: 30, z: top(30, 30) }, goals[(k / 12) % goals.length]!);
    t = performance.now(); const fin = g2.advance(); const a = performance.now() - t;
    if (k >= 48) { per.push(a); ticks++; if (fin) done++; }
  }
  console.log(`repartida en tandas de ${BUDGET} nodos: advance p50 ${p(per, 0.5)} p95 ${p(per, 0.95)} máx ${p(per, 1)} ms (${done} de ${ticks} ticks sin nada pendiente)`);
  g2.close();
}
