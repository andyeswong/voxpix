// Lo que cuesta, sin freno, cada parte de correr la ventana viva un trozo al este (LiveWindow, la ventana y el mundo de
// app/viva.html): preparar el corrimiento, el cambio, escribir cada trozo que entra y rehornearlo, por clase de trabajo.
//   bun scripts/bench-viva.ts [giros 1|4] [corrimientos 3]
import { LiveWindow } from '../src/world/live';
import { set, SPEC } from './ventana-mundo';
import type { ViewJob } from '../src/world/bake';

const GIROS = Number(process.argv[2] ?? 1), N = Number(process.argv[3] ?? 3);
const spec = { ...SPEC, height: 12, surface: { base: 6, amplitude: 2, scale: 9 }, seaLevel: 5, veins: (SPEC.veins ?? []).map((v) => ({ ...v, z: [1, 4] as [number, number] })), caves: { ...SPEC.caves!, z: [1, 4] as [number, number] } };
let t = performance.now();
const win = new LiveWindow({ blocks: set, spec, nx: 9, ny: 11, chunk: 16, center: [0, 0], margin: { x: 4, n: 6, s: 4 }, quarters: GIROS === 4 ? [0, 1, 2, 3] : [0], bake: { incline: 0.5, sky: true, outline: 'both' } });
console.log(`arranque (99 trozos, ${GIROS} giro(s)): ${(performance.now() - t).toFixed(0)} ms`);
// La cola: cada trabajo hasta acabar, sumando el tiempo por clase (la key hasta ":" o "#", sin el g<q>/)
const by = new Map<string, number>();
let q: ViewJob[] = [];
const budget = { push(j: ViewJob) { const i = q.findIndex((u) => u.key === j.key); if (i >= 0) q[i] = j; else q.push(j); } };
const kind = (k: string) => k.replace(/^g\d\//, '').split(/[:#]/)[0]!;
const T = win.T;
for (let s = 0; s < N; s++) {
  by.clear();
  const x = (win.tx0 + 9 - 4) * T + 1, y = T / 2;   // el objetivo, a menos del margen del borde este
  let guard = 0;
  do {
    win.update(x, y, budget);
    const jobs = q; q = [];
    for (const j of jobs) { const a = performance.now(); while (!j.run(performance.now() + 4)); by.set(kind(j.key), (by.get(kind(j.key)) ?? 0) + performance.now() - a); }
  } while ((win.busy || q.length) && ++guard < 10000);
  win.update(x, y, budget); for (const j of q) { const a = performance.now(); while (!j.run(performance.now() + 4)); by.set(kind(j.key), (by.get(kind(j.key)) ?? 0) + performance.now() - a); } q = [];
  const tot = [...by.values()].reduce((a, b) => a + b, 0);
  console.log(`corrimiento ${s + 1} (tx0 ${win.tx0}): total ${tot.toFixed(0)} ms; ` + [...by].map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') + `; cambio ${win.lastSwitchMs.toFixed(1)} ms; trozos ${win.stats.loadMs.slice(-11).map((v) => v.toFixed(0)).join(' ')}`);
}
