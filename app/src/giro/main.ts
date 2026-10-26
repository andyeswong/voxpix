// Medida del giro de cámara en cuartos (NARUTO, condición de MAIA): cuánto tarda y cuánto ocupa hornear el mundo en
// cada giro, para decidir en la máquina de verdad si se guardan los 4 horneados o se rehornea al girar.
//   ?tema=medieval  ?seed=7  ?ruta=cpu
//   ?modo=cache: el giro actual al empezar y los otros 3 en segundo plano (prepareViewJob con la cola de presupuesto,
//   ?presupuesto=3 ms por cuadro), y se guardan   ?modo=rehornear (por defecto): se hornea al girar
// Q / E (o tocar la mitad izquierda / derecha) giran un cuarto. Si un rehorneado pasa de 300 ms, antes se pinta un
// cuadro de transición (no un cuadro congelado). El resultado queda en window.__giro.
import { generateLayout } from '../../../src/worldgen';
import { THEMES, type ThemeId } from '../../../src/samples/themes';
import { buildWorldState } from '../../../src/world/build';
import { bakeWorld, rebakeChangedJobs, type Baked } from '../../../src/world/bake';
import { WorldView, prepareViewJob, type Quarter } from '../../../src/world/view';
import { FrameBudget } from '../../../src/view/budget';
import { createCompositor } from '../../../src/view/compositor';

const VW = 384, VH = 216, TOPZ = 40, INCLINE = 0.5, SLOW_MS = 300;
const q = new URLSearchParams(location.search);
const theme = (q.get('tema') ?? 'medieval') as ThemeId;
const cache = q.get('modo') === 'cache';
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;
const s = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
canvas.style.width = `${VW * s}px`; canvas.style.height = `${VH * s}px`;
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });

const layout = generateLayout(THEMES[theme].spec, Number(q.get('seed') ?? 7));
const { world, state } = buildWorldState(layout, THEMES[theme].look);
const spawn = { x: layout.spawn.x + 0.5, y: world.depth - 1 - layout.spawn.y + 0.5 };

// Lo que ocupa un horneado: sus imágenes por píxel, los pesos de las luces horneadas y la rejilla de sombras
function bytesOf(b: Baked): number {
  let n = b.rgba.byteLength + b.depth.byteLength + b.face.byteLength + b.pick.byteLength + b.occ.byteLength;
  for (const l of b.lights) n += l.weight.byteLength;
  return n;
}
const mb = (n: number) => (n / 1048576).toFixed(1);
// Lo que ocupa la copia girada de los vóxeles (el giro 0 no copia): un trozo reservado por cada trozo con algo
function staticBytes(v: WorldView): number {
  return v.quarter === 0 ? 0 : v.static.byteLength;
}

interface Measure { quarter: Quarter; viewMs: number; bakeMs: number; lightMs: number; firstFrameMs: number; mb: number; staticMB: number }
const measures: Measure[] = [];
const views = new Map<Quarter, { view: WorldView; baked: Baked }>();

function prepare(quarter: Quarter): { view: WorldView; baked: Baked } {
  const have = views.get(quarter);
  if (have) return have;
  const t0 = performance.now();
  const view = new WorldView(state, quarter);
  const t1 = performance.now();
  const baked = bakeWorld(view.bakeable(), { topZ: TOPZ, incline: INCLINE });
  const t2 = performance.now();
  measures.push({ quarter, viewMs: t1 - t0, bakeMs: t2 - t1, lightMs: baked.ms.light, firstFrameMs: -1, mb: bytesOf(baked) / 1048576, staticMB: staticBytes(view) / 1048576 });
  const out = { view, baked };
  if (cache) views.set(quarter, out);
  return out;
}

function viewport(view: WorldView, b: Baked): { vx: number; vy: number } {
  const [x, y] = view.camera.pointToView(spawn.x, spawn.y);
  const feet = b.cam.project(x, y, 1);
  return {
    vx: Math.max(0, Math.min(b.width - VW, Math.floor(feet[0]) - VW / 2)),
    vy: Math.max(0, Math.min(b.height - VH, Math.floor(feet[1]) - VH / 2)),
  };
}

let quarter: Quarter = 0;
let cur = prepare(0);
// Los otros 3 giros, en segundo plano: lo que tardan en estar listos y el peor cuadro mientras tanto
const budget = new FrameBudget(Number(q.get('presupuesto') ?? 3));
const bg = { startMs: performance.now(), readyMs: -1, worstFrameMs: 0, worstJobMs: 0, frames: 0, ready: [] as Quarter[] };
const pending = cache ? ([1, 2, 3] as Quarter[]).map((k) => ({ quarter: k, prep: prepareViewJob(state, k, { topZ: TOPZ, incline: INCLINE }) })) : [];
const slowCalls: Array<{ q: Quarter; call: number; ms: number; frame: number }> = [];
for (const p of pending) {
  const job = p.prep.job;
  let call = 0;
  budget.push({ key: job.key, run(deadline) { const t = performance.now(); const r = job.run(deadline); const ms = performance.now() - t; if (ms > 20) slowCalls.push({ q: p.quarter, call, ms, frame: bg.frames }); call++; return r; } });
}
let lastFrame = performance.now();
// Un giro preparado pasa a la caché (bakeMs: lo que costó terminarlo de golpe al girar antes de tiempo)
function adopt(p: (typeof pending)[number], bakeMs: number): void {
  const r = p.prep.result()!;
  measures.push({ quarter: p.quarter, viewMs: 0, bakeMs, lightMs: r.baked.ms.light, firstFrameMs: -1, mb: bytesOf(r.baked) / 1048576, staticMB: staticBytes(r.view) / 1048576 });
  views.set(p.quarter, r);
  bg.ready.push(p.quarter);
  pending.splice(pending.indexOf(p), 1);
}
let firstPending = true;
let turning = false;

// El cuadro de transición: el último cuadro oscurecido con un aviso, pintado ANTES de un rehorneado largo
function drawTransition(): void {
  const g = document.getElementById('veil')!;
  g.style.display = 'flex';
}

async function turn(step: 1 | -1): Promise<void> {
  if (turning) return;
  const next = ((quarter + step + 4) % 4) as Quarter;
  const last = measures.find((m) => m.quarter === next) ?? measures[measures.length - 1];
  const slow = !views.has(next) && (last?.bakeMs ?? 0) > SLOW_MS;
  turning = true;
  if (slow) { drawTransition(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); }
  // Si el giro se estaba preparando en segundo plano, se termina ya (no se empieza otra vez)
  const p = pending.find((x) => x.quarter === next);
  if (p) { const t0 = performance.now(); while (!p.prep.job.run(Infinity)) { /* acaba */ } adopt(p, performance.now() - t0); }
  cur = prepare(next);
  quarter = next;
  firstPending = true;
  document.getElementById('veil')!.style.display = 'none';
  turning = false;
}

addEventListener('keydown', (e) => { if (e.key === 'q' || e.key === 'Q') void turn(-1); if (e.key === 'e' || e.key === 'E') void turn(1); });
addEventListener('pointerdown', (e) => void turn(e.clientX < innerWidth / 2 ? -1 : 1));

function loop(now: number): void {
  const frameGap = performance.now() - lastFrame;
  lastFrame = performance.now();
  const spent = budget.run();
  if (pending.length) bg.worstJobMs = Math.max(bg.worstJobMs, spent);
  if (pending.length || bg.readyMs < 0 && cache) {
    if (bg.frames++ > 2) bg.worstFrameMs = Math.max(bg.worstFrameMs, frameGap);
    for (const p of [...pending]) if (p.prep.result()) adopt(p, 0);
    if (!pending.length) bg.readyMs = performance.now() - bg.startMs;
  }
  state.step();
  const rs = cur.view.frame();
  // Lo que cambió en el mundo mientras este giro estaba guardado (o desde el cuadro anterior)
  for (const j of rebakeChangedJobs(cur.baked, rs.lights)) budget.push(j);
  const { vx, vy } = viewport(cur.view, cur.baked);
  const t0 = performance.now();
  compositor.frame(rs, cur.baked, { vx, vy, vw: VW, vh: VH, time: now / 1000, lights: true, ambient: THEMES[theme].ambient });
  const ms = performance.now() - t0;
  if (firstPending) {
    const m = [...measures].reverse().find((r) => r.quarter === quarter);
    if (m && m.firstFrameMs < 0) m.firstFrameMs = ms;
    firstPending = false;
  }
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const held = (m: Measure) => m.mb + m.staticMB;
  const total = cache ? measures.reduce((a, m) => a + held(m), 0) : ((m) => (m ? held(m) : 0))(measures.find((m) => m.quarter === quarter));
  (window as unknown as { __giro: unknown }).__giro = { theme, cache, width: world.width, depth: world.depth, measures, heldMB: total, heapMB: mem ? mem.usedJSHeapSize / 1048576 : null, ruta: compositor.kind, background: cache ? bg : null, slowCalls };
  hud.textContent = `giro ${quarter} · ${theme} ${world.width}x${world.depth} · ${cache ? 'los 4 guardados' : 'rehornear al girar'} · ruta ${compositor.kind}   (Q / E o tocar a un lado)\n` +
    measures.map((m) => `giro ${m.quarter}: vista ${m.viewMs.toFixed(0)} ms · horneado ${m.bakeMs.toFixed(0)} ms (luces ${m.lightMs.toFixed(0)}) · primer cuadro ${m.firstFrameMs < 0 ? '…' : m.firstFrameMs.toFixed(0)} ms · ${m.mb.toFixed(1)} MB + vóxeles girados ${m.staticMB.toFixed(1)} MB`).join('\n') +
    (cache ? `\nsegundo plano: ${bg.readyMs < 0 ? `preparando (${bg.ready.length}/3)` : `los 3 listos en ${(bg.readyMs / 1000).toFixed(1)} s`} · peor cuadro mientras tanto ${bg.worstFrameMs.toFixed(1)} ms (trabajo ${bg.worstJobMs.toFixed(1)} ms)` : '') +
    `\nhorneados en memoria: ${total.toFixed(1)} MB${mem ? ` · montón de JS ${mb(mem.usedJSHeapSize)} MB` : ''}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
