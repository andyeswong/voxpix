// El banco de andar de la ventana viva (NARUTO): MAIA anda por un mundo por regiones sin bordes (el spec de
// scripts/ventana-mundo.ts con 12 bloques de alto, como el juego) a 6 bloques/s, de ida y vuelta sobre `bloques` bloques,
// con LiveWindow (9 x 11 trozos, margen { x: 4, n: 6, s: 4 }), la cola del juego (FrameBudget(3, cercano 8 / 64)) y el
// compositor de la GPU, en tiempo real (requestAnimationFrame). Al acabar `segundos`, deja en window.__viva:
// los intervalos entre cuadros (p50, p95, máx, de más de 25 ms), el montón de JS por segundo (minuto 1 contra minuto 5),
// los corrimientos, los cuadros con algo de la vista sin hornear (un trozo de la vista sin escribir) y unas capturas.
//   ?segundos=330&bloques=200&nx=9&ny=11
import { Model, type ModelFile } from '@core/index';
import { createCompositor } from '../../../src/view/compositor';
import { FrameBudget } from '../../../src/view/budget';
import { LiveWindow } from '../../../src/world/live';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import { set, SPEC } from '../../../scripts/ventana-mundo';
import maiaFile from '../../../models/maia/maia.json';
import type { Frame2DOptions } from '../../../src/world/frame2d';

const VW = 384, VH = 216, B = 8;
const q = new URLSearchParams(location.search);
const SECONDS = Number(q.get('segundos') ?? 330), BLOCKS = Number(q.get('bloques') ?? 200), NX = Number(q.get('nx') ?? 9), NY = Number(q.get('ny') ?? 11);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;

const spec = { ...SPEC, height: 12, surface: { base: 6, amplitude: 2, scale: 9 }, seaLevel: 5, veins: (SPEC.veins ?? []).map((v) => ({ ...v, z: [1, 4] as [number, number] })), caves: { ...SPEC.caves!, z: [1, 4] as [number, number] } };
const t0 = performance.now();
const win = new LiveWindow({ blocks: set, spec, nx: NX, ny: NY, chunk: 16, center: [0, 0], margin: { x: 4, n: 6, s: 4 }, bake: { incline: 0.5, sky: true, outline: 'both' } });
const loadMs = performance.now() - t0;
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });
compositor.upload(win.baked);
const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));
const T = 128, Y = 64.5;
let x = 64.5, dir = 1;
const ground = (wx: number, wy: number) => { const [lx, ly] = win.toLocal(Math.floor(wx), Math.floor(wy)); return win.store.height[ly * win.store.width + lx] ?? 0; };
const [lx0, ly0] = win.toLocal(x, Y);
const id = win.state.entities.add({ model: walk[0]!, x: lx0, y: ly0, z: ground(x, Y), facing: 90 });
const budget = new FrameBudget(3, undefined, { ms: 8, below: 64 });

const frames: number[] = [], heap: number[] = [], shots: string[] = [];
let shifts = 0, lastTx0 = win.tx0, lastTy0 = win.ty0, holes = 0, last = performance.now(), start = -1, nextHeap = 0, frameNo = 0;
const mem = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

function loop(now: number): void {
  if (start < 0) start = now;
  const dt = Math.min(0.1, (now - last) / 1000);
  frames.push(now - last); last = now; frameNo++;
  // Andar: ida y vuelta sobre BLOCKS bloques
  x += dir * 6 * B * dt;
  if (x > 64 + BLOCKS * B) dir = -1; else if (x < 64) dir = 1;
  win.update(x, Y, budget);
  budget.run();
  if (win.tx0 !== lastTx0 || win.ty0 !== lastTy0) { shifts++; lastTx0 = win.tx0; lastTy0 = win.ty0; }
  const [lx, ly] = win.toLocal(x, Y);
  state_move(lx, ly);
  // La vista, centrada en MAIA
  const [px, py] = win.baked.cam.project(lx, ly, ground(x, Y));
  const o: Frame2DOptions = { vx: Math.max(0, Math.min(win.baked.width - VW, Math.round(px) - VW / 2)), vy: Math.max(0, Math.min(win.baked.height - VH, Math.round(py) - VH / 2)), vw: VW, vh: VH, time: (now - start) / 1000, lights: true, ambient: [0.8, 0.8, 0.85], cave: [0.2, 0.2, 0.25] };
  // ¿Algún trozo de lo que cae en la vista sin escribir? Las columnas de la vista (de 32 en 32) por las filas de trozos que
  // se ven: de 2 al sur a 4 al norte del de MAIA
  const ox = win.tx0 * T, tty = win.trozoOf(x, Y)[1];
  let hole = false;
  for (let sx = o.vx; sx < o.vx + VW && !hole; sx += 32) {
    const tc = Math.floor((sx + ox) / T);
    for (let ty = tty - 2; ty <= tty + 4 && !hole; ty++) if (!win.isLoaded([tc, ty])) hole = true;
  }
  if (hole) holes++;
  compositor.frame(win.state, win.baked, o);
  if (now - start >= nextHeap) { heap.push(mem()); nextHeap += 1000; }
  if (frameNo % 1200 === 600 && shots.length < 6) shots.push(canvas.toDataURL('image/png'));
  hud.textContent = `ventana viva · ${(now - start) / 1000 | 0} s · trozo ${win.trozoOf(x, Y).join(',')} · corrimientos ${shifts} · huecos ${holes}`;
  if (now - start < SECONDS * 1000) { requestAnimationFrame(loop); return; }
  const f = frames.slice(60), s = [...f].sort((a, b) => a - b), p = (k: number) => +s[Math.floor(k * (s.length - 1))]!.toFixed(1);
  const avg = (a: number[]) => a.length ? a.reduce((u, v) => u + v, 0) / a.length : 0;
  (window as unknown as { __viva: unknown }).__viva = {
    loadMs: +loadMs.toFixed(0), frames: f.length, p50: p(0.5), p95: p(0.95), max: p(1), over25: f.filter((v) => v > 25).length,
    over25perMin: +(f.filter((v) => v > 25).length / (SECONDS / 60)).toFixed(1), shifts, holes,
    heapMB: { min1: +(avg(heap.slice(55, 65)) / 1e6).toFixed(1), min5: +(avg(heap.slice(295, 305)) / 1e6).toFixed(1), max: +(Math.max(...heap) / 1e6).toFixed(1) },
    shots,
  };
}
function state_move(lx: number, ly: number): void {
  win.state.entities.move(id, lx, ly, ground(x, Y), dir > 0 ? 90 : 270);
  win.state.entities.setModel(id, walk[Math.floor(performance.now() / WALK_FRAME_MS) % 8]!);
  win.state.step();
}
requestAnimationFrame(loop);
