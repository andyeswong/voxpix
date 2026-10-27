// Lo que cuesta un objeto que se mueve (world/objects.ts): despertarlo y dormirlo (con su rehorneado), empujarlo, y
// lo que añaden N despiertos a groundAt (moveBody la llama por cada columna que pisa un cuerpo, en cada subpaso).
// Uso: bun scripts/bench-objetos.ts
import { floorLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { TICK } from '../src/world/state';
import { moveBody } from '../src/runtime/body';

const SPEC = { ...THEMES.oficina.spec, cols: 20, rows: 14 };
const { state: w } = buildWorldState(floorLayout(SPEC, 3, 1).layout, { ...THEMES.oficina.look, objects: true });
const b = bakeWorld({ model: w.solid, lights: [...w.lights], width: w.width, depth: w.depth }, { topZ: 40, incline: 0.5 });
const rebake = () => { const t0 = performance.now(); const jobs = rebakeChangedJobs(b, [...w.lights]); const t1 = performance.now(); for (const j of jobs) while (!j.run(Infinity)) { /* */ } return [t1 - t0, performance.now() - t0] as const; };
const objs = [...w.objects].filter((o) => w.objects.fitsSprite(o.id));
console.log(`${w.width}x${w.depth}: ${w.objects.size} objetos, ${objs.length} caben en un sprite (${objs.map((o) => `${o.kind} ${o.cells.length / 4} vóx ${o.mass.toFixed(0)} kg`).slice(0, 4).join('; ')}...)`);
const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(0.95 * (a.length - 1))]!.toFixed(2);
const wake: number[] = [], wakeBake: number[] = [], sleep: number[] = [], sleepBake: number[] = [], wakeSync: number[] = [];
for (let k = 0; k < 3; k++) for (const o of objs) {
  let t = performance.now(); w.objects.wake(o.id); wake.push(performance.now() - t);
  const [s1, a1] = rebake(); wakeSync.push(s1); wakeBake.push(a1);
  t = performance.now(); w.objects.sleep(o.id); sleep.push(performance.now() - t);
  w.objects.dropGhosts(w.solid.clock);
  sleepBake.push(rebake()[1]);
}
console.log(`despertar p95 ${p95(wake)} ms + rehorneado ${p95(wakeBake)} ms (síncrono ${p95(wakeSync)}); dormir p95 ${p95(sleep)} ms + rehorneado ${p95(sleepBake)} ms`);
for (const n of [0, 1, 4, Math.min(16, objs.length)]) {
  for (const o of objs.slice(0, n)) w.objects.wake(o.id);
  const body = { x: w.width / 2, y: w.depth / 2, z: 1, r: 3 };
  const t = performance.now();
  for (let i = 0; i < 2000; i++) moveBody(w, body, i % 2 ? 0.8 : -0.8, 0.3);
  const mv = (performance.now() - t) / 2000;
  const tp = performance.now();
  for (let i = 0; i < 200; i++) for (const o of objs.slice(0, n)) w.objects.push(o.id, i % 40 < 20 ? 1 : -1, 0, w.objects.forceToMove(o.id) * 3, TICK);
  const push = n ? (performance.now() - tp) / 200 : 0;
  console.log(`${n} despiertos: moveBody ${(mv * 1000).toFixed(1)} µs/llamada; empujar a todos ${push.toFixed(3)} ms/tick`);
  for (const o of objs.slice(0, n)) w.objects.sleep(o.id);
  w.objects.dropGhosts(w.solid.clock);
  rebake();
}
