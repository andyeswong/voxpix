// Coste de moveBodyLevels: CUERPOS cuerpos (20) de radio 3 y alto 14 persiguiendo a un punto que da vueltas, 1800 ticks,
// en el terreno de bench-caminos (MUNDO=bloques: el de bloques con árboles; si no, el de un túnel). Saltan si se
// atascan. Da µs por llamada (sin freno) y una huella de las posiciones (la misma huella = los mismos resultados).
// Uso: bun scripts/bench-niveles.ts
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { generateTerrain } from '../src/world/terrain';
import { moveBodyLevels, LEVEL_RULES, type LevelBody } from '../src/runtime/levels';
import { fnv32 } from '../src/core/icons';

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
const N = Number(process.env.CUERPOS ?? 20), TICKS = 1800, rules = { ...LEVEL_RULES, step: 8, jump: 2.2 };
const ground = (x: number, y: number) => s.height[Math.floor(y) * W + Math.floor(x)]!;
const bodies: LevelBody[] = [];
for (let k = 0; k < N; k++) { const a = (k / N) * Math.PI * 2, x = 192 + Math.cos(a) * 120, y = 192 + Math.sin(a) * 120; bodies.push({ x, y, z: ground(x, y), r: 3, height: 14, vz: 0 }); }
const times: number[] = [];
let calls = 0;
for (let t = 0; t < TICKS; t++) {
  const px = 192 + Math.cos(t / 300) * 60, py = 192 + Math.sin(t / 300) * 60;
  for (const b of bodies) {
    const ex = px - b.x, ey = py - b.y, l = Math.hypot(ex, ey) || 1, sp = 0.7;
    const t0 = performance.now();
    const m = moveBodyLevels(st, b, (ex / l) * sp, (ey / l) * sp, (b as { stuck?: number }).stuck! > 0, rules);
    const dt = performance.now() - t0;
    if (t >= 300) { times.push(dt); calls++; }
    (b as { stuck?: number }).stuck = m.blocked ? 1 : 0;
  }
}
const f = new Float64Array(bodies.flatMap((b) => [b.x, b.y, b.z, b.vz]));
times.sort((a, b) => a - b);
const us = (q: number) => (times[Math.floor(q * (times.length - 1))]! * 1000).toFixed(1);
const mean = times.reduce((a, b) => a + b, 0) / times.length * 1000;
console.log(`${N} cuerpos, ${calls} llamadas: media ${mean.toFixed(1)} µs, p50 ${us(0.5)}, p95 ${us(0.95)}; huella ${fnv32(new Uint8Array(f.buffer))}`);
