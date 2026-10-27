// Lo que cuesta rehornear un piso que se monta desde el cielo (VoxelFall.rebuild), por tick: la parte síncrona de
// rebakeChangedJobs y el trabajo entero, con commit 'landing' (cada pieza al aterrizar) y 'end' (todas al final).
// Uso: bun scripts/bench-caida.ts [pieza]
import { floorLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { VoxelFall } from '../src/world/fall';

const piece = Number(process.argv[2] ?? 16);
const SPEC = { ...THEMES.oficina.spec, cols: 12, rows: 10 };
for (const commit of ['landing', 'end'] as const) {
  const { state: w, lights } = buildWorldState(floorLayout(SPEC, 5, 2).layout, THEMES.oficina.look) as any;
  const s = w.solid;
  const b = bakeWorld({ model: s, lights: lights ?? [], width: s.width, depth: s.depth }, { topZ: 40, incline: 0.5 });
  const f = new VoxelFall(w);
  const n = f.rebuild({ x0: 0, y0: 0, z0: s.zMin, x1: s.width - 1, y1: s.depth - 1, z1: s.zMax }, { piece, commit });
  const sync: number[] = [], total: number[] = [];
  let ticks = 0;
  while (!f.done && ticks++ < 2000) {
    f.step();
    const t0 = performance.now();
    const jobs = rebakeChangedJobs(b, lights ?? []);
    const t1 = performance.now();
    for (const j of jobs) while (!j.run(Infinity)) { /* */ }
    sync.push(t1 - t0); total.push(performance.now() - t0);
  }
  const p = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))]!.toFixed(1);
  const sum = total.reduce((a, x) => a + x, 0);
  console.log(`${s.width}x${s.depth} pieza ${piece} (${n} piezas), commit ${commit}: ${ticks} ticks; síncrono p95 ${p(sync, 0.95)} máx ${Math.max(...sync).toFixed(1)} ms; trabajo p95 ${p(total, 0.95)} ms, suma ${sum.toFixed(0)} ms`);
}
