// Duración de cada paso de un trabajo de rehorneado (romper el tile 296,135 del medieval 7, como ?romper)
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorldState } from '../src/world/build';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
const { world, state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval');
const b = bakeWorld(world, { topZ: 40, incline: 0.5 });
const tx = Math.floor(296 / 16) * 16, ty = Math.floor(135 / 16) * 16;
for (let y = ty; y < ty + 16; y++) for (let x = tx; x < tx + 16; x++) for (let z = state.groundAt(x, y) - 1; z >= 1; z--) state.solid.set(x, y, z, 0);
const jobs = rebakeChangedJobs(b, state.lights);
const steps: number[] = [];
for (const j of jobs) { let done = false; while (!done) { const t0 = performance.now(); done = j.run(0); steps.push(performance.now() - t0); } }
console.log('pasos:', steps.map((x) => x.toFixed(1)).join(' '));
console.log(jobs.map((j) => j.key).join(' '), '·', steps.length, 'pasos · primero', steps[0]!.toFixed(2), 'ms · máx', Math.max(...steps).toFixed(2), 'ms · mediana', steps.slice().sort((a, c) => a - c)[steps.length >> 1]!.toFixed(2), 'ms · total', steps.reduce((a, c) => a + c, 0).toFixed(1), 'ms');

// Segunda vez: otro tile, con todo ya calentado
const tx2 = tx + 32;
for (let y = ty; y < ty + 16; y++) for (let x = tx2; x < tx2 + 16; x++) for (let z = 1; z < 12; z++) state.solid.set(x, y, z, 1);   // un bloque nuevo
const jobs2 = rebakeChangedJobs(b, state.lights);
const steps2: number[] = [];
for (const j of jobs2) { let done = false; while (!done) { const t0 = performance.now(); done = j.run(0); steps2.push(performance.now() - t0); } }
console.log('segunda vez, pasos:', steps2.map((x) => x.toFixed(1)).join(' '));
