// La ventana viva: lo que cuesta correrla (NARUTO). Una ventana de nx x ny trozos de 16 x 16 bloques (el mundo de
// scripts/ventana-mundo.ts) horneada y compuesta en la GPU; cada `cada` cuadros (192: un trozo a 5 bloques/s) se corre
// un trozo, alternando este y oeste, con shiftBakedJob en la cola de la vista (FrameBudget(3, cercano 8 / 64), como el
// juego). Cuadros seguidos sin esperar al reloj; con el freno de CDP, los ms a esa velocidad.
//   ?medir=1: deja en window.__ventana, por corrimiento, los cuadros de la copia y el cuadro del cambio (y lo que tardó
//   la GPU en correrse); y del resto, p50, p95 y los de más de 25 ms. ?nx=8&ny=13&banda=32&cada=192&n=800
//   ?doble=1: en cada corrimiento, cruza otro borde (hacia el norte) a mitad de la copia (merge)
import { WorldState } from '../../../src/world/state';
import { bakeWorld, shiftBakedJob, type ShiftJob } from '../../../src/world/bake';
import type { Frame2DOptions } from '../../../src/world/frame2d';
import { GpuCompositor } from '../../../src/view/gpu/compositor';
import { FrameBudget } from '../../../src/view/budget';
import { windowWorld, B, H } from '../../../scripts/ventana-mundo';

const VW = 384, VH = 216;
const q = new URLSearchParams(location.search);
const hud = document.getElementById('hud')!;
const NX = Number(q.get('nx') ?? 8), NY = Number(q.get('ny') ?? 13), BAND = Number(q.get('banda') ?? 32), EVERY = Number(q.get('cada') ?? 192), N = Number(q.get('n') ?? 800);
const pct = (a: number[], p: number) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))]! : 0; };

function measure(): unknown {
  let t = performance.now();
  const s = windowWorld(NX, NY);
  const fill = performance.now() - t;
  const state = new WorldState(s, [], null);
  t = performance.now();
  const b = bakeWorld({ model: s, lights: [], width: s.width, depth: s.depth }, { topZ: H * B, incline: 0.5, sky: true, outline: 'both' });
  const bake = performance.now() - t;
  const gc = GpuCompositor.create(document.createElement('canvas'));
  if (!gc) return { error: 'sin WebGL2' };
  const o: Frame2DOptions = { vx: Math.floor((b.width - VW) / 2), vy: Math.floor((b.height - VH) / 2), vw: VW, vh: VH, time: 0, lights: true, ambient: [0.8, 0.8, 0.85], cave: [0.2, 0.2, 0.25] };
  gc.read(state, b, o, 'frame');                                      // sube el horneado
  const budget = new FrameBudget(3, undefined, { ms: 8, below: 64 });
  const shifts: Array<{ start: number; copyFrames: number; swapFrame: number; swapMs: number; jobMs: { voxels: number; recopy: number; swap: number }; voxelFrameMs: number; voxelRunMs: number; voxelReadMs: number; runMs: number; readMs: number; gpuShiftMs: number; gpuShifted: boolean }> = [];
  const other: number[] = [];
  let job: ShiftJob | null = null, start = 0, dir = 1, merged = false, prevMs = 0, prevRun = 0, prevRead = 0;
  const k = 128 / 16;                                                  // trozos de vóxeles por trozo
  for (let f = 0; f < N; f++) {
    if (f % EVERY === 20 && !job) { job = shiftBakedJob(b, dir * k, 0, { band: BAND }); dir = -dir; start = f; merged = false; budget.push(job); }
    if (job && q.get('doble') === '1' && !merged && f === start + 5) { job.merge(0, k); merged = true; }
    const c0 = gc.shiftCount;
    const t0 = performance.now();
    budget.run();
    const t1 = performance.now();
    gc.read(state, b, o, 'frame');
    const ms = performance.now() - t0, runMs = t1 - t0, readMs = ms - runMs;
    if (job && job.done) {
      shifts.push({ start, copyFrames: f - start, swapFrame: f, swapMs: +ms.toFixed(2), jobMs: { ...job.ms }, voxelFrameMs: +prevMs.toFixed(2), voxelRunMs: +prevRun.toFixed(2), voxelReadMs: +prevRead.toFixed(2), runMs: +runMs.toFixed(2), readMs: +readMs.toFixed(2), gpuShiftMs: +gc.shiftMs.toFixed(2), gpuShifted: gc.shiftCount > c0 });
      job = null;
    } else if (!job) other.push(ms);
    prevMs = ms; prevRun = runMs; prevRead = readMs;
  }
  const all = shifts.map((x) => x.swapMs);
  return { size: [b.width, b.height], fillS: +(fill / 1000).toFixed(1), bakeS: +(bake / 1000).toFixed(1), band: BAND,
    shifts, swap: { p50: pct(all, 0.5), max: Math.max(0, ...all) }, copyFrames: { p50: pct(shifts.map((x) => x.copyFrames), 0.5), max: Math.max(0, ...shifts.map((x) => x.copyFrames)) },
    rest: { frames: other.length, p50: +pct(other, 0.5).toFixed(2), p95: +pct(other, 0.95).toFixed(2), over25: other.filter((v) => v > 25).length } };
}

if (q.get('medir')) {
  hud.textContent = 'midiendo…';
  setTimeout(() => { const r = measure(); (window as unknown as { __ventana: unknown }).__ventana = r; hud.textContent = JSON.stringify(r).slice(0, 300); }, 50);
}
