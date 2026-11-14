// Coste de picar bloques de 8x8x8 en un terreno de bloques: memoria de los vóxeles, horneado entero, y rehorneado de
// cada golpe (total y paso más largo, que es lo que la cola no puede partir). Sin navegador ni freno de CPU: es una
// señal de desarrollo; la medida de verdad es en el navegador, con freno.
// El terreno: a media altura, +-3 bloques, con capas (hierba, tierra, piedra) y antorchas fijas repartidas por la
// cuarta parte central del mundo, sobre el suelo. Se pica entre ellas.
// Uso: bun scripts/bench-picar.ts [lado 384] [alto 96] [antorchas 30]
import { material } from '../src/core';
import { StaticVoxels } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';

// Cada llamada con un plazo de PLAZO ms (0,45 sin freno son ~3 ms de presupuesto a 6x), como hace FrameBudget
const PLAZO = Number(process.env.PLAZO ?? 0.45);
const W = Number(process.argv[2] ?? 384), D = W, ZT = Number(process.argv[3] ?? 96), NT = Number(process.argv[4] ?? 30), B = 8;
const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
] };
const s = new StaticVoxels(pal, W, D, 0, ZT - 1);
const half = Math.floor(ZT / B / 2);
const hb = (bx: number, by: number) => half + Math.round(3 * Math.sin(bx / 5.3) * Math.cos(by / 4.1));   // en bloques
let t = performance.now();
for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
  const top = hb(x >> 3, y >> 3) * B;
  for (let z = 0; z < top; z++) s.set(x, y, z, z >= top - B ? material(2, 2 + ((x + y) & 1)) : z >= top - 3 * B ? material(1, 2) : material(0, 2));
}
const fill = performance.now() - t;
// Antorchas en una rejilla sobre la cuarta parte central (lado W/2), 2 bloques por encima del suelo
const lights: WorldLight[] = [];
const side = Math.ceil(Math.sqrt(NT));
for (let i = 0; i < NT; i++) {
  const x = Math.floor(W / 4 + ((i % side) + 0.5) * (W / 2) / side), y = Math.floor(D / 4 + (Math.floor(i / side) + 0.5) * (D / 2) / side);
  lights.push({ id: 't' + i, kind: 'torch', x, y, z: hb(x >> 3, y >> 3) * B + 2 * B, baked: true });
}
t = performance.now();
// CIELO=1: con el cielo horneado (bakeWorld { sky: true }), que también se rehace al picar
const b = bakeWorld({ model: s, lights, width: W, depth: D }, { topZ: ZT, incline: 0.5, sky: process.env.CIELO === '1' });
const full = performance.now() - t;
const total: number[] = [], worst: number[] = [], nJobs: number[] = [];
// 16 golpes de calentamiento (el juego ya lleva rato corriendo: el compilador ya ha hecho su trabajo) y 16 medidos,
// cada uno un bloque de arriba junto a una antorcha, en un sitio sin picar
for (let k = 0; k < 32; k++) {
  const warm = k < 16;
  const l = lights[warm ? lights.length - 1 - k : k - 16]!;
  const bx = (l.x >> 3) + (k % 3) - 1, by = (l.y >> 3) + (warm ? -2 : 1 + (k % 2)), top = hb(bx, by);
  for (let z = (top - 1) * B; z < top * B; z++) for (let y = by * B; y < by * B + B; y++) for (let x = bx * B; x < bx * B + B; x++) s.set(x, y, z, 0);
  const t0 = performance.now();
  let w = 0;
  const jobs = rebakeChangedJobs(b, lights);
  if (!warm) nJobs.push(jobs.length);
  for (const j of jobs) { let done = false; while (!done) { const a = performance.now(); done = j.run(a + PLAZO); w = Math.max(w, performance.now() - a); } }
  if (!warm) { total.push(performance.now() - t0); worst.push(w); }
}
const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]!.toFixed(1);
console.log(`${W}x${D}x${ZT}, ${NT} antorchas: llenar ${(fill / 1000).toFixed(1)} s, vóxeles ${(s.byteLength / 1e6).toFixed(0)} MB, horneado entero ${(full / 1000).toFixed(2)} s; ` +
  `picar un bloque: total p50 ${p(total, 0.5)} p95 ${p(total, 0.95)} ms, llamada más larga p95 ${p(worst, 0.95)} ms, trabajos ${p(nJobs, 0.5)}`);
