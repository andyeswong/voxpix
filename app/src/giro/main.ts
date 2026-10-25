// Medida del giro de cámara en cuartos (NARUTO, condición de MAIA): cuánto tarda y cuánto ocupa hornear el mundo en
// cada giro, para decidir en la máquina de verdad si se guardan los 4 horneados o se rehornea al girar.
//   ?tema=medieval  ?seed=7  ?ruta=cpu
//   ?modo=cache: los 4 horneados hechos al empezar y guardados   ?modo=rehornear (por defecto): se hornea al girar
// Q / E (o tocar la mitad izquierda / derecha) giran un cuarto. Si un rehorneado pasa de 300 ms, antes se pinta un
// cuadro de transición (no un cuadro congelado). El resultado queda en window.__giro.
import { generateLayout } from '../../../src/worldgen';
import { THEMES } from '../../../src/content/themes';
import { buildWorldState, type WorldTheme } from '../../../src/world/build';
import { bakeWorld, type Baked } from '../../../src/world/bake';
import { WorldView, type Quarter } from '../../../src/world/view';
import { createCompositor } from '../../../src/view/compositor';

const VW = 384, VH = 216, TOPZ = 40, INCLINE = 0.5, SLOW_MS = 300;
const q = new URLSearchParams(location.search);
const theme = (q.get('tema') ?? 'medieval') as WorldTheme;
const cache = q.get('modo') === 'cache';
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;
const s = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
canvas.style.width = `${VW * s}px`; canvas.style.height = `${VH * s}px`;
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });

const layout = generateLayout(THEMES[theme].spec, Number(q.get('seed') ?? 7));
const { world, state } = buildWorldState(layout, theme);
const spawn = { x: layout.spawn.x + 0.5, y: world.depth - 1 - layout.spawn.y + 0.5 };

// Lo que ocupa un horneado: sus imágenes por píxel, los pesos de las luces horneadas y la rejilla de sombras
function bytesOf(b: Baked): number {
  let n = b.rgba.byteLength + b.depth.byteLength + b.face.byteLength + b.pick.byteLength + b.occ.byteLength;
  for (const l of b.lights) n += l.weight.byteLength;
  return n;
}
const mb = (n: number) => (n / 1048576).toFixed(1);

interface Measure { quarter: Quarter; viewMs: number; bakeMs: number; lightMs: number; firstFrameMs: number; mb: number }
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
  measures.push({ quarter, viewMs: t1 - t0, bakeMs: t2 - t1, lightMs: baked.ms.light, firstFrameMs: -1, mb: bytesOf(baked) / 1048576 });
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
if (cache) for (const k of [1, 2, 3] as Quarter[]) prepare(k);
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
  cur = prepare(next);
  quarter = next;
  firstPending = true;
  document.getElementById('veil')!.style.display = 'none';
  turning = false;
}

addEventListener('keydown', (e) => { if (e.key === 'q' || e.key === 'Q') void turn(-1); if (e.key === 'e' || e.key === 'E') void turn(1); });
addEventListener('pointerdown', (e) => void turn(e.clientX < innerWidth / 2 ? -1 : 1));

function loop(now: number): void {
  state.step();
  const rs = cur.view.frame();
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
  const total = cache ? measures.reduce((a, m) => a + m.mb, 0) : (measures.find((m) => m.quarter === quarter)?.mb ?? 0);
  (window as unknown as { __giro: unknown }).__giro = { theme, cache, width: world.width, depth: world.depth, measures, heldMB: total, heapMB: mem ? mem.usedJSHeapSize / 1048576 : null, ruta: compositor.kind };
  hud.textContent = `giro ${quarter} · ${theme} ${world.width}x${world.depth} · ${cache ? 'los 4 guardados' : 'rehornear al girar'} · ruta ${compositor.kind}   (Q / E o tocar a un lado)\n` +
    measures.map((m) => `giro ${m.quarter}: vista ${m.viewMs.toFixed(0)} ms · horneado ${m.bakeMs.toFixed(0)} ms (luces ${m.lightMs.toFixed(0)}) · primer cuadro ${m.firstFrameMs < 0 ? '…' : m.firstFrameMs.toFixed(0)} ms · ${m.mb.toFixed(1)} MB`).join('\n') +
    `\nhorneados en memoria: ${total.toFixed(1)} MB${mem ? ` · montón de JS ${mb(mem.usedJSHeapSize)} MB` : ''}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
