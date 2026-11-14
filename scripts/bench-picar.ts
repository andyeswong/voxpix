// Coste de picar un bloque de 8x8x8, junto a las antorchas, en un mundo de 768x768x192 lleno hasta la mitad: memoria de los vóxeles,
// horneado entero, y rehorneado por caja (total y paso más largo, que es lo que la cola no puede partir).
// Uso: bun scripts/bench-picar.ts [antorchas fijas cerca, 4 por defecto]
import { material } from '../src/core';
import { StaticVoxels } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';

const W = 768, D = 768, ZT = 192, B = 8, NT = Number(process.argv[2] ?? 4);
const s = new StaticVoxels({ ramps: [{ name: 'p', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] }] }, W, D, 0, ZT - 1);
// Terreno por bloques de unos 10 de alto, con capas de material cada 8 vóxeles
const hb = (bx: number, by: number) => 10 + Math.floor(3 * Math.sin(bx / 7) + 2 * Math.cos(by / 5));
let t = performance.now();
for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) { const top = hb(x >> 3, y >> 3) * B; for (let z = 0; z < top; z++) s.set(x, y, z, material(0, 1 + ((z >> 3) % 4))); }
const fill = performance.now() - t;
const lights: WorldLight[] = Array.from({ length: NT }, (_, i) => ({ id: 't' + i, kind: 'torch', x: W / 2 + 24 * (i % 2) - 12, y: D / 2 + 24 * (i >> 1) - 12, z: 110, baked: true }));
t = performance.now();
const b = bakeWorld({ model: s, lights, width: W, depth: D }, { topZ: ZT, incline: 0.5 });
const full = performance.now() - t;
const total: number[] = [], worst: number[] = [];
for (let k = 0; k < 12; k++) {
  const X = W / 2 - 16 + (k % 4) * 8, Y = D / 2 - 12 + Math.floor(k / 4) * 8, top = hb(X >> 3, Y >> 3) * B;
  for (let z = top - B; z < top; z++) for (let y = Y; y < Y + B; y++) for (let x = X; x < X + B; x++) s.set(x, y, z, 0);
  const t0 = performance.now();
  let w = 0;
  for (const j of rebakeChangedJobs(b, lights)) { let done = false; while (!done) { const a = performance.now(); done = j.run(0); w = Math.max(w, performance.now() - a); } }
  total.push(performance.now() - t0); worst.push(w);
}
const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]!.toFixed(1);
console.log(`${W}x${D}x${ZT}, ${NT} antorchas: llenar ${(fill / 1000).toFixed(1)} s, vóxeles ${(s.byteLength / 1e6).toFixed(0)} MB, horneado entero ${(full / 1000).toFixed(1)} s; picar un bloque de ${B}^3: total p50 ${p(total, 0.5)} p95 ${p(total, 0.95)} ms, paso más largo ${p(worst, 0.95)} ms`);
