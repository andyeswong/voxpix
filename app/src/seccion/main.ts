// El corte al componer (src/world/section.ts) andando por un túnel, para verlo y medirlo. El mundo de
// scripts/tunel.ts (de bloques, con dos antorchas fijas dentro del túnel), MAIA andando por el túnel hacia el este a 5
// bloques/s, la vista siguiéndola y la sección pintada por franjas con SectionPainter en la cola de la vista
// (FrameBudget(3, cercano 8 / 64), como bench-corte).
//   ?ancho=4: el ancho de la caja en bloques (8 vóxeles)   ?ruta=cpu: compone la CPU   ?mundo=768: el ancho del mundo
//   ?medir=4,48: mide, con cuadros seguidos sin esperar al reloj, andar sin corte y con el corte de cada ancho, y lo deja
//   en window.__seccion. Por cuadro: el paso del mundo, la cola, la capa y el cuadro de la GPU esperado (read). Con el
//   freno de CDP, son los ms a esa velocidad
import { Model, type ModelFile } from '@core/index';
import { WorldState } from '../../../src/world/state';
import { bakeWorld } from '../../../src/world/bake';
import type { Frame2DOptions } from '../../../src/world/frame2d';
import { createCompositor } from '../../../src/view/compositor';
import { GpuCompositor } from '../../../src/view/gpu/compositor';
import { FrameBudget } from '../../../src/view/budget';
import { SectionPainter, sectionAround, type SectionLayer } from '../../../src/world/section';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import { tunnelWorld } from '../../../scripts/tunel';
import maiaFile from '../../../models/maia/maia.json';

const VW = 384, VH = 216, B = 8, SPEED = 5 * B / 60;        // vóxeles por cuadro a 60 cuadros por segundo
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;
const sc = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
canvas.style.width = `${VW * sc}px`; canvas.style.height = `${VH * sc}px`;

const { s, lights, W, D, ZT } = tunnelWorld(true, true, Number(q.get('mundo') ?? 384));
const state = new WorldState(s, lights, null);
const baked = bakeWorld({ model: s, lights, width: W, depth: D }, { topZ: ZT, incline: 0.5, sky: true, outline: 'both' });
const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));
const TY = 191, TZ = 8, X0 = 64, X1 = W - 64, GAME = q.get('juego') === '1';
const id = state.entities.add({ model: walk[0]!, x: X0, y: TY, z: TZ, facing: 90 });
const [, py] = baked.cam.project(X0, TY, TZ);
const vy = Math.max(0, Math.min(baked.height - VH, Math.round(py) - VH / 2));
const opts = (x: number, t: number): Frame2DOptions => {
  const [px] = baked.cam.project(x, TY, TZ);
  return { vx: Math.max(0, Math.min(baked.width - VW, Math.round(px) - VW / 2)), vy, vw: VW, vh: VH, time: t, lights: true, ambient: [0.8, 0.8, 0.85], cave: [0.2, 0.2, 0.25] };
};

// Un cuadro: MAIA avanza, el corte sigue a sus pies (si hay ancho), la cola corre y se compone
interface Walker { x: number; f: number; painter: SectionPainter | null; budget: FrameBudget; width: number }
const walker = (width: number): Walker => ({ x: X0, f: 0, painter: width ? new SectionPainter(baked, { ahead: 4, behind: 1 }) : null, budget: new FrameBudget(3, undefined, { ms: 8, below: 64 }), width });
function advance(w: Walker): { layer: SectionLayer | null; ready: boolean; queue: number; layerMs: number } {
  w.x += SPEED; w.f++;
  if (w.x > X1) w.x = X0;
  // (?juego=1: como en el juego, se mueve en y dentro del túnel y sus pies cambian de vez en cuando)
  const jy = GAME ? TY + Math.round(3 * Math.sin(w.f / 23)) : TY, jz = GAME ? TZ + (Math.floor(w.f / 37) % 3 === 2 ? 1 : 0) : TZ;
  state.entities.move(id, Math.round(w.x), jy, jz, 90);
  state.entities.setModel(id, walk[Math.floor((w.f * 1000 / 60) / WALK_FRAME_MS) % 8]!);
  state.step();
  let layer: SectionLayer | null = null, ready = true, layerMs = 0;
  const t0 = performance.now();
  if (w.painter) {
    w.painter.set(sectionAround(null, w.x, jy, jz, w.width * B), 1);
    const job = w.painter.job();
    if (job) w.budget.push(job);
  }
  w.budget.run();
  const queue = performance.now() - t0;
  if (w.painter) {
    const t1 = performance.now();
    layer = w.painter.layer();
    layerMs = performance.now() - t1;
    ready = w.painter.ready();
  }
  return { layer, ready, queue, layerMs };
}

const pct = (a: number[], p: number) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]!; };
function measure(widths: number[]): unknown {
  const gc = GpuCompositor.create(document.createElement('canvas'));
  if (!gc) return { error: 'sin WebGL2' };
  const N = Number(q.get('n') ?? 360);
  const run = (width: number) => {
    const w = walker(width);
    const frame: number[] = [], queue: number[] = [], layerMs: number[] = [], read: number[] = [], upload: number[] = [], steady: boolean[] = [];
    let appear = -1, holes = 0;
    for (let i = 0; i < N + 20; i++) {
      const t0 = performance.now();
      const r = advance(w);
      const t1 = performance.now();
      gc.read(state, baked, { ...opts(w.x, w.f / 60), ...(r.layer !== null || width ? { sectionLayer: r.layer } : {}) }, 'frame');
      const t2 = performance.now();
      if (width) { if (appear < 0 && r.ready) appear = i; else if (appear >= 0 && !r.ready) holes++; }
      if (i < 20) continue;                                   // calentar (el primer cuadro sube el horneado)
      frame.push(t2 - t0); queue.push(r.queue); layerMs.push(r.layerMs); read.push(t2 - t1); upload.push(gc.sectionMs); steady.push(!width || (appear >= 0 && i > appear));
    }
    const st = (a: number[]) => ({ p50: +pct(a, 0.5).toFixed(2), p95: +pct(a, 0.95).toFixed(2), max: +Math.max(...a).toFixed(1), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) });
    // Andando con todo pintado (después de que aparece; sin corte, todos)
    const only = (a: number[]) => a.filter((_, k) => steady[k]);
    // Lo que no es la cola (componer, subir, el cuadro): la puerta de +1 ms es su mediana
    const rest = frame.map((v, k) => v - queue[k]!);
    const walking = { rest: st(only(rest)), frames: only(frame).length, over25: only(frame).filter((v) => v > 25).length, frame: st(only(frame)), queue: st(only(queue)), layer: st(only(layerMs)), read: st(only(read)), upload: st(only(upload)) };
    return { width, frames: N, appear, holes, over25: frame.filter((v) => v > 25).length, frame: st(frame), queue: st(queue), layer: st(layerMs), read: st(read), upload: st(upload), painted: w.painter?.painted ?? 0, walking };
  };
  const base = run(0);
  return { base, widths: widths.map(run) };
}

const live = walker(Number(q.get('ancho') ?? 4));
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });
// ?objeto=1: el primer cambio de objeto. El modelo de MAIA cambia a uno que la GPU no ha visto nunca (MAIA con un objeto en
// la mano: unos vóxeles más), y de control, a uno que ya vio. Por cambio: el cuadro (frame + read), el de después, y lo
// que subió a la GPU (uploadStats). Deja el resultado en window.__objeto
function measureObject(): unknown {
  const gc = GpuCompositor.create(document.createElement('canvas'));
  if (!gc) return { error: 'sin WebGL2' };
  const o = opts(X0 + 100, 0);
  state.entities.move(id, X0 + 100, TY, TZ, 90);
  const frame = () => { const t0 = performance.now(); gc.read(state, baked, o, 'frame'); return +(performance.now() - t0).toFixed(2); };
  for (let i = 0; i < 30; i++) { state.entities.setModel(id, walk[i % 8]!); frame(); }
  const base = Array.from({ length: 30 }, () => frame());
  const out: unknown[] = [];
  for (let k = 0; k < 6; k++) {
    // Nuevo: MAIA con un palo de k + 3 vóxeles en la mano (otro modelo cada vez)
    const m = walk[0]!.clone();
    for (let z = 0; z < k + 3; z++) m.set(6, -2, 10 + z, m.get(0, 0, 1) || 1);
    state.entities.setModel(id, m);
    const nw = frame(), nwUp = gc.lastUploads, nwParts = { ...gc.parts }, after = frame();
    // Control: uno ya visto
    state.entities.setModel(id, walk[k % 8]!);
    const seen = frame(), seenUp = gc.lastUploads;
    for (let i = 0; i < 10; i++) frame();
    out.push({ new: nw, after, newUploads: nwUp, newParts: nwParts, seen, seenUploads: seenUp, seenParts: { ...gc.parts } });
  }
  const pct = (a: number[], p: number) => { const v = [...a].sort((x, y) => x - y); return v[Math.floor(p * (v.length - 1))]!; };
  return { base: { p50: pct(base, 0.5), max: Math.max(...base) }, changes: out };
}
if (q.get('objeto')) (window as unknown as { __seccion: unknown }).__seccion = measureObject();
else if (q.get('medir')) (window as unknown as { __seccion: unknown }).__seccion = measure(q.get('medir')!.split(',').map(Number));

let acc = 0, n = 0, avg = 0;
function loop(): void {
  const r = advance(live);
  const t0 = performance.now();
  compositor.frame(state, baked, { ...opts(live.x, live.f / 60), sectionLayer: r.layer });
  acc += performance.now() - t0;
  if (++n === 30) { avg = acc / n; acc = 0; n = 0; }
  hud.textContent = `corte al componer · ruta ${compositor.kind} · ancho ${live.width} bloques · cuadro ${avg.toFixed(2)} ms · ${r.ready ? 'sección entera' : 'pintando'}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
