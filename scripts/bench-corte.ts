// Coste por cuadro del corte de vista (WorldView.cutJob) con la cola de la vista: poner, mover a saltos de 16 y quitar
// una caja de 32 x 32 sobre un túnel. La cola es FrameBudget(3, near 8 / 64) con los presupuestos divididos por 6,7 (lo
// que sube todo con la CPU frenada a 6x), y lo que se informa va multiplicado por 6,7 (como a 6x). Sin navegador: es una
// señal de desarrollo; la medida de verdad es en el navegador, con freno.
// Por evento: la llamada a budget.run más larga, los cuadros hasta que no queda trabajo cercano (aparece) y hasta que la
// cola se vacía (acaba). Y las llamadas que se pasan de 10 ms, con lo que hizo cada trabajo en ellas.
// Uso: bun scripts/bench-corte.ts [tiradas 3]. ANT=2: dos antorchas fijas dentro del túnel
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type ViewCut } from '../src/world/view';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { FrameBudget, type ViewJob } from '../src/view/budget';
import type { WorldLight } from '../src/world/build';

const W = 384, ZT = 96, B = 8, K = 6.7, RUNS = Number(process.argv[2] ?? 3);
const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
] };
// El terreno de bench-picar (a media altura, +-3 bloques) con un túnel este-oeste de 2 bloques de alto (y 184..199, z 16..31)
const s = new StaticVoxels(pal, W, W, 0, ZT - 1);
const half = Math.floor(ZT / B / 2);
const hb = (bx: number, by: number) => half + Math.round(3 * Math.sin(bx / 5.3) * Math.cos(by / 4.1));
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const top = hb(x >> 3, y >> 3) * B;
  for (let z = 0; z < top; z++) {
    if (y >= 184 && y < 200 && z >= 16 && z < 32) continue;
    s.set(x, y, z, z >= top - B ? material(2, 2 + ((x + y) & 1)) : z >= top - 3 * B ? material(1, 2) : material(0, 2));
  }
}
const lights: WorldLight[] = process.env.ANT === '2'
  ? [{ id: 'a', kind: 'torch', x: 180.5, y: 191.5, z: 24, baked: true }, { id: 'b', kind: 'torch', x: 230.5, y: 191.5, z: 24, baked: true }]
  : [];
const view = new WorldView(new WorldState(s, lights, null), 0, { cut: true });
const b = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, sky: true });
const q = new FrameBudget(3 / K, undefined, { ms: 8 / K, below: 64 });
const queue = () => (q as unknown as { queue: ViewJob[] }).queue;
const player = { x: 192, y: 192 };
const calls: string[] = [];
const wrap = (j: ViewJob): ViewJob => ({
  key: j.key, priority: j.priority,
  run(d) {
    const t = performance.now(), r = j.run(d);
    calls.push(`${j.key.split(/[:#]/)[0]}${j.priority !== undefined && j.priority < 64 ? '(cerca)' : ''}${r ? ' acaba' : ''} ${((performance.now() - t) * K).toFixed(1)}`);
    return r;
  },
});
const res: Array<{ max: number; appear: number; end: number }> = [];
function event(cut: ViewCut | null, measure: boolean): void {
  q.push(wrap(view.cutJob(cut)));
  let f = 0, max = 0, appear = -1;
  while (f < 400) {
    for (const j of rebakeChangedJobs(b, view.frame().lights, { near: player })) q.push(wrap(j));
    if (!q.pending) break;
    f++;
    calls.length = 0;
    const t = performance.now();
    q.run();
    const ms = (performance.now() - t) * K;
    max = Math.max(max, ms);
    if (measure && ms > 10) console.log(`  cuadro de ${ms.toFixed(1)} ms: ${calls.join(', ')}`);
    if (appear < 0 && !queue().some((j) => j.priority !== undefined && j.priority < 64)) appear = f;
  }
  if (measure) res.push({ max, appear, end: f });
}
const at = (x0: number): ViewCut => ({ x0, y0: 176, x1: x0 + 31, y1: 207, zTop: 32 });
// Una tirada de calentamiento y RUNS medidas, de 8 eventos cada una
for (let r = 0; r <= RUNS; r++) {
  const m = r > 0;
  event(at(176), m); event(at(192), m); event(at(208), m); event(at(192), m);
  event(at(176), m); event(null, m); event(at(192), m); event(null, m);
}
const p = (a: number[], x: number) => [...a].sort((u, v) => u - v)[Math.floor(x * (a.length - 1))]!;
const mx = res.map((r) => r.max), ap = res.map((r) => r.appear), en = res.map((r) => r.end);
console.log(`${res.length} eventos: budget.run máx por evento (a 6x) p50 ${p(mx, 0.5).toFixed(1)} p95 ${p(mx, 0.95).toFixed(1)} máx ${p(mx, 1).toFixed(1)} ms; ` +
  `aparece p50 ${p(ap, 0.5)} máx ${p(ap, 1)} cuadros; acaba p50 ${p(en, 0.5)} máx ${p(en, 1)}`);
