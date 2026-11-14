// Coste por cuadro del corte de vista (WorldView.cutJob) con la cola de la vista: poner, mover a saltos de 16 y quitar
// una caja de 32 x 32 sobre un túnel. La cola es FrameBudget(3, near 8 / 64) con los presupuestos divididos por 6,7 (lo
// que sube todo con la CPU frenada a 6x), y lo que se informa va multiplicado por 6,7 (como a 6x). Sin navegador: es una
// señal de desarrollo; la medida de verdad es en el navegador, con freno.
// Por evento: la llamada a budget.run más larga, los cuadros hasta que no queda trabajo cercano (aparece) y hasta que la
// cola se vacía (acaba). Y las llamadas que se pasan de 10 ms, con lo que hizo cada trabajo en ellas.
// Uso: bun scripts/bench-corte.ts [tiradas 3]. ANT=2: dos antorchas fijas dentro del túnel. DOS=1: dos cajas (la de los pies, 16 x 32); DOS=2: la de los pies de 24 x 64 hacia la cámara. NEAR=ms: el presupuesto
// cercano (como a 6x; 8 por defecto). VER=1: cada evento con sus llamadas, y las estimaciones de la cola al final
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type ViewCut } from '../src/world/view';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { FrameBudget, type ViewJob } from '../src/view/budget';
import type { WorldLight } from '../src/world/build';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { generateTerrain } from '../src/world/terrain';
import type { Palette } from '../src/core';

const W = 384, ZT = 96, B = 8, K = 6.7, RUNS = Number(process.argv[2] ?? 3);
const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
  { name: 'tronco', colors: ['#2b1b12', '#4a2f1d', '#6e4729'] }, { name: 'hojas', colors: ['#1f3a22', '#2f5a2f', '#46803c'], material: 'arbusto' },
] } as Palette;
// El terreno de bench-picar (a media altura, +-3 bloques) con un túnel este-oeste de 1,5 bloques de alto (y 184..199,
// z 8..19), bajo todo el relieve: el corte (zTop 20, en su techo) siempre quita algo
const s = new StaticVoxels(pal, W, W, 0, ZT - 1);
const half = Math.floor(ZT / B / 2);
const hb = (bx: number, by: number) => half + Math.round(3 * Math.sin(bx / 5.3) * Math.cos(by / 4.1));
// MUNDO=bloques: el mundo de bloques de bench-caminos (generateTerrain, árboles con hojas), con el mismo túnel cavado
if (process.env.MUNDO === 'bloques') {
  const cube = (r: number, keep: (x: number, y: number, z: number) => boolean = () => true) => {
    const o: Array<[number, number, number, number]> = [];
    for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) if (keep(x, y, z)) o.push([x, y, z, material(r, 1 + ((x + y + z) % 2))]);
    return o;
  };
  const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: [
    { id: 'piedra', voxels: cube(0) }, { id: 'hierba', voxels: cube(2), props: { covered: 'tierra' } }, { id: 'tierra', voxels: cube(1) },
    { id: 'tronco', voxels: cube(3, (x, y) => Math.hypot(x - 3.5, y - 3.5) < 3.2) },
    { id: 'hojas', voxels: cube(4, (x, y, z) => ((x * 7 + y * 13 + z * 5) % 11) > 1) },
  ] });
  const leaf: Array<[number, number, number, string]> = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leaf.push([dx!, dy!, 4, 'hojas']);
  generateTerrain({
    seed: 1, surface: { base: 6, amplitude: 2, scale: 9, octaves: 3 },
    layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],
    scatter: [{ on: 'hierba', density: 0.02, spacing: 4, structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'tronco'], [0, 0, 3, 'tronco'], ...leaf, [0, 0, 5, 'hojas']] }],
  }, new BlockGrid(new WorldState(s, [], null), set));
  for (let y = 184; y < 200; y++) for (let x = 0; x < W; x++) for (let z = 8; z < 20; z++) s.set(x, y, z, 0);
} else for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const top = hb(x >> 3, y >> 3) * B;
  for (let z = 0; z < top; z++) {
    if (y >= 184 && y < 200 && z >= 8 && z < 20) continue;
    s.set(x, y, z, z >= top - B ? material(2, 2 + ((x + y) & 1)) : z >= top - 3 * B ? material(1, 2) : material(0, 2));
  }
}
const lights: WorldLight[] = process.env.ANT === '2'
  ? [{ id: 'a', kind: 'torch', x: 180.5, y: 191.5, z: 12, baked: true }, { id: 'b', kind: 'torch', x: 230.5, y: 191.5, z: 12, baked: true }]
  : [];
const st = new WorldState(s, lights, null);
const view = new WorldView(st, 0, { cut: true });
// CONTORNO=both|outer: el horneado con contorno (el del juego: 'both', con los saltos de profundidad)
const outline = (process.env.CONTORNO ?? 'none') as 'none' | 'outer' | 'both';
const b = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, sky: true, outline });
const q = new FrameBudget(3 / K, undefined, { ms: Number(process.env.NEAR ?? 8) / K, below: 64 });
const queue = () => (q as unknown as { queue: ViewJob[] }).queue;
const player = { x: 192, y: 192 };
const calls: string[] = [];
const cnt: Record<string, number> = {};
const byClass: Record<string, number[]> = {};
let measuring = false;
const wrap = (j: ViewJob): ViewJob => ({
  key: j.key, priority: j.priority,
  run(d) {
    const t = performance.now(), r = j.run(d);
    const kk = j.key.split(/[:#]/)[0]! + (j.priority !== undefined && j.priority < 64 ? 'c' : ''); cnt[kk] = (cnt[kk] ?? 0) + 1;
    const ms6 = (performance.now() - t) * K, kc = j.key.split(/[:#]/)[0]!; if (measuring) (byClass[kc] ??= []).push(ms6);
    calls.push(`${j.key.split(/[:#]/)[0]}${j.priority !== undefined && j.priority < 64 ? '(cerca)' : ''}${r ? ' acaba' : ''} ${((performance.now() - t) * K).toFixed(1)}`);
    return r;
  },
});
const res: Array<{ max: number; appear: number; end: number }> = [];
function event(cut: ViewCut | ViewCut[] | null, measure: boolean): void {
  measuring = measure;
  q.push(wrap(view.cutJob(cut)));
  let f = 0, max = 0, appear = -1;
  while (f < 400) {
    for (const j of rebakeChangedJobs(b, view.frame().lights, { near: player, nearLights: process.env.LUZLEJOS !== '1' })) q.push(wrap(j));
    // Aparece: el corte hecho y, después de recoger lo que cambió, ningún recuadro cercano en la cola (las luces, aunque
    // sean cercanas, no cuentan: es lo que se ve aparecer; los recuadros del corte
    // entran en la cola el cuadro después de que el corte escribe)
    if (f > 0 && appear < 0 && !queue().some((j) => j.priority !== undefined && j.priority < 64 && /^(rect|view-cut)/.test(j.key))) appear = f;
    if (!q.pending) break;
    f++;
    calls.length = 0;
    const t = performance.now();
    q.run();
    const ms = (performance.now() - t) * K;
    max = Math.max(max, ms);
    if (measure && ms > 10) console.log(`  cuadro de ${ms.toFixed(1)} ms: ${calls.join(', ')}`);
  }
  if (measure) res.push({ max, appear, end: f });
  if (measure && process.env.VER) console.log('evento', cut ? 'corte' : 'quitar', 'aparece', appear, 'acaba', f, 'llamadas', JSON.stringify(cnt)); for (const k in cnt) delete cnt[k];
}
// DOS=1: corte de casa de muñecas, la caja de siempre hasta el techo del túnel y la mitad del lado de la cámara (y
// pequeñas, 16 x 32) hasta los pies (el suelo del túnel, z 8)
const at = (x0: number): ViewCut | ViewCut[] => {
  const roof = { x0, y0: 176, x1: x0 + 31, y1: 207, zTop: 20 };
  // DOS=2: la caja de los pies como la de un juego: 24 de ancho centrada en la de siempre y 64 de fondo hacia la cámara
  // (y pequeñas) desde el borde del túnel, hasta los pies
  if (process.env.DOS === '2') return [roof, { x0: x0 + 4, y0: 191 - 63, x1: x0 + 27, y1: 191, zTop: 8 }];
  return process.env.DOS === '1' ? [roof, { x0, y0: 176, x1: x0 + 31, y1: 191, zTop: 8 }] : roof;
};
// ANTORCHA=1: en vez de cortes, poner una antorcha junto al jugador (en el túnel, sin corte) y contar los cuadros hasta
// que alumbra (su trabajo de luz acabado). LUZLEJOS=1: las luces sin prioridad cercana, como antes
if (process.env.ANTORCHA === '1') {
  const frames: number[] = [], ms: number[] = [];
  for (let k = 0; k < 4 + RUNS * 4; k++) {
    const id = `nueva${k}`;
    st.lights.addFixed({ id, kind: 'torch', x: 186.5 + (k % 4) * 4, y: 189.5, z: 12 });
    let f = 0, lit = -1, t = 0;
    while (f < 400) {
      for (const j of rebakeChangedJobs(b, view.frame().lights, { near: player, nearLights: process.env.LUZLEJOS !== '1' })) q.push(j);
      if (!q.pending) break;
      f++;
      const t0 = performance.now(); q.run(); t += performance.now() - t0;
      if (lit < 0 && b.lights.some((l) => l.light.id === id)) lit = f;
    }
    if (k >= 4) { frames.push(lit); ms.push(t * K); }
    st.lights.removeFixed(id);
    for (let g = 0; g < 400 && (q.pending || rebakeChangedJobs(b, view.frame().lights).length); g++) { for (const j of rebakeChangedJobs(b, view.frame().lights, { near: player })) q.push(j); q.run(); }
  }
  const pp = (a: number[], x: number) => [...a].sort((u, v) => u - v)[Math.floor(x * (a.length - 1))]!;
  console.log(`antorcha nueva junto al jugador (${frames.length}): alumbra en p50 ${pp(frames, 0.5)} máx ${pp(frames, 1)} cuadros (a 6x); trabajo de la cola p50 ${pp(ms, 0.5).toFixed(0)} ms (a 6x)`);
  process.exit(0);
}
// Una tirada de calentamiento y RUNS medidas, de 8 eventos cada una
for (let r = 0; r <= RUNS; r++) {
  const m = r > 0;
  event(at(176), m); event(at(192), m); event(at(208), m); event(at(192), m);
  event(at(176), m); event(null, m); event(at(192), m); event(null, m);
}
const p = (a: number[], x: number) => [...a].sort((u, v) => u - v)[Math.floor(x * (a.length - 1))]!;
const mx = res.map((r) => r.max), ap = res.map((r) => r.appear), en = res.map((r) => r.end);
for (const [k, v] of Object.entries(byClass)) { v.sort((a, b) => a - b); console.log(`  llamadas ${k}: n ${v.length}, p50 ${v[v.length >> 1]!.toFixed(1)}, p95 ${v[Math.floor(0.95 * (v.length - 1))]!.toFixed(1)}, máx ${v.at(-1)!.toFixed(1)} ms (a 6x), más de 6,7 (1 ms sin freno): ${v.filter((x) => x > 6.7).length}`); }
console.log(`${res.length} eventos: budget.run máx por evento (a 6x) p50 ${p(mx, 0.5).toFixed(1)} p95 ${p(mx, 0.95).toFixed(1)} máx ${p(mx, 1).toFixed(1)} ms; ` +
  `aparece p50 ${p(ap, 0.5)} máx ${p(ap, 1)} cuadros; acaba p50 ${p(en, 0.5)} máx ${p(en, 1)}`);
if (process.env.VER) {
  const c = (q as unknown as { costs: Map<string, { ms: number[]; p95: number }> }).costs;
  for (const [k, v] of c) console.log('estimación', k, 'p95', (v.p95 * K).toFixed(1), 'muestras', v.ms.map((x) => (x * K).toFixed(1)).sort((a, b) => +a - +b).join(' '));
}
