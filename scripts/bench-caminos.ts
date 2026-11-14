// Coste de LevelPathField en un terreno de bloques de 384 x 384 x 96 (el de bench-picar, con un túnel): construir, la
// búsqueda al cambiar la meta (lo de toward), dir en caliente y la búsqueda tras picar un bloque. Sin freno.
// Uso: bun scripts/bench-caminos.ts. Las opciones, las de un cuerpo de 3 x 14 que sube un bloque (cell 4, radius 1,
// height 14, step 8, maxDrop 64)
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { LevelPathField } from '../src/world/levelpaths';
import { clearBox } from '../src/world/edit';

const W = 384, ZT = 96, B = 8;
const pal = { ramps: [{ name: 'piedra', colors: ['#202428', '#3a4048', '#565e68'] }, { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038'] }, { name: 'brasa', colors: ['#ff8020', '#ffc040'], emissive: true }] };
const s = new StaticVoxels(pal, W, W, 0, ZT - 1);
const half = Math.floor(ZT / B / 2);
const hb = (bx: number, by: number) => half + Math.round(3 * Math.sin(bx / 5.3) * Math.cos(by / 4.1));
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const top = hb(x >> 3, y >> 3) * B;
  for (let z = 0; z < top; z++) {
    if (y >= 184 && y < 200 && x >= 40 && x < 344 && z >= 16 && z < 32) continue;
    s.set(x, y, z, z >= top - B ? material(1, 1) : material(0, 1));
  }
}
const st = new WorldState(s, [], null);
const O = { cell: 4, radius: 1, height: 14, step: 8, maxDrop: 64 };
let t = performance.now();
const f = new LevelPathField(st, O);
const build = performance.now() - t;
const top = (x: number, y: number) => hb(x >> 3, y >> 3) * B;
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
