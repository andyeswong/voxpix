// Mide la parte síncrona de rebakeChangedJobs (lo que se paga dentro del cuadro) con cambios repartidos por el
// mundo, como en la caída de un piso: unos vóxeles en muchos trozos a la vez.
// Uso: bun scripts/bench-rebake.ts [ancho] [fondo] [trozos por tick]
import { material } from '../src/core';
import { StaticVoxels } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';

const W = Number(process.argv[2] ?? 192), D = Number(process.argv[3] ?? 160), per = Number(process.argv[4] ?? 12);
const s = new StaticVoxels({ ramps: [{ name: 'p', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] }] }, W, D, -4, 40);
for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) s.set(x, y, 0, material(0, 2));
for (let z = 1; z <= 24; z++) for (let x = 0; x < W; x++) { s.set(x, 0, z, material(0, 3)); s.set(x, 1, z, material(0, 3)); }
const lights = [{ id: 'a', kind: 'torch' as const, x: W / 2, y: D / 2, z: 8, baked: true }];
const b = bakeWorld({ model: s, lights, width: W, depth: D }, { topZ: 40, incline: 0.5 });
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const sync: number[] = [], total: number[] = [];
for (let t = 0; t < 40; t++) {
  for (let k = 0; k < per; k++) s.set(Math.floor(rnd() * W), Math.floor(rnd() * D), 1 + Math.floor(rnd() * 3), material(0, 4));
  const t0 = performance.now();
  const jobs = rebakeChangedJobs(b, lights);
  const t1 = performance.now();
  for (const j of jobs) while (!j.run(Infinity)) { /* */ }
  sync.push(t1 - t0); total.push(performance.now() - t0);
}
const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]!.toFixed(1);
console.log(`${W}x${D}, ${per} cambios/tick: síncrono p50 ${p(sync, 0.5)} p95 ${p(sync, 0.95)} ms; total p50 ${p(total, 0.5)} p95 ${p(total, 0.95)} ms`);
