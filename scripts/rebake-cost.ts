// Coste de rehornear tras destruir una columna (medieval, semilla 7) frente a hornear el nivel entero
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorldState } from '../src/world/build';
import { bakeWorld, rebakeChanged } from '../src/world/bake';
const layout = generateLayout(THEMES.medieval.spec, 7);
const { world, state } = buildWorldState(layout, 'medieval');
let t = performance.now();
const b = bakeWorld(world, { topZ: 40, incline: 0.5 });
const full = performance.now() - t;
// La primera columna que haya: se vacía su columna de vóxeles (como si la rompieran)
let col: [number, number] | null = null;
for (let y = 0; y < state.depth && !col; y++) for (let x = 0; x < state.width && !col; x++) if (state.groundAt(x, y) > 30 && y > 80) col = [x, y];
const [cx, cy] = col!;
for (let y = cy - 1; y < cy + 15; y++) for (let x = cx - 2; x < cx + 15; x++) for (let z = 1; z < 40; z++) if (state.groundAt(x, y) > 20) state.solid.set(x, y, z, 0);
t = performance.now();
const r = rebakeChanged(b, state.lights);
const part = performance.now() - t;
console.log(`horneado entero ${full.toFixed(0)} ms · rehorneado tras romper una columna ${part.toFixed(1)} ms (${r.chunks} trozos, ${r.pixels} px, ${r.lights} luces)`);
// Peor caso: romper algo junto a una luz fija grande (el brasero de la fuente, radio 120)
const f = world.fountain!;
for (let z = 1; z < 20; z++) for (let y = Math.floor(f.y) - 3; y <= Math.floor(f.y) + 3; y++) for (let x = Math.floor(f.x) - 3; x <= Math.floor(f.x) + 3; x++) state.solid.set(x, y, z, 0);
t = performance.now();
const r2 = rebakeChanged(b, state.lights);
console.log(`rehorneado junto al brasero de la fuente ${(performance.now() - t).toFixed(1)} ms (${r2.chunks} trozos, ${r2.lights} luces recalculadas)`);
// Como trabajos: cuánto dura como máximo un paso (lo mínimo que la cola no puede partir)
import { rebakeChangedJobs } from '../src/world/bake';
for (let z = 1; z < 20; z++) for (let y = Math.floor(f.y) - 3; y <= Math.floor(f.y) + 3; y++) for (let x = Math.floor(f.x) + 8; x <= Math.floor(f.x) + 12; x++) state.solid.set(x, y, z, z % 2 ? 0 : 1);
const jobs = rebakeChangedJobs(b, state.lights);
let calls = 0, worst = 0, total = 0;
for (const j of jobs) {
  let done = false;
  while (!done) { const t0 = performance.now(); done = j.run(0); const dt = performance.now() - t0; worst = Math.max(worst, dt); total += dt; calls++; }
}
console.log(`como trabajos: ${jobs.map((j) => j.key).join(', ')} · ${calls} pasos · paso más largo ${worst.toFixed(2)} ms · total ${total.toFixed(1)} ms`);
