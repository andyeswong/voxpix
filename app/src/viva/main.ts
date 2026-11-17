// El banco de andar de la ventana viva (NARUTO): MAIA anda por un mundo por regiones sin bordes (el spec de
// scripts/ventana-mundo.ts con 12 bloques de alto, como el juego) a 6 bloques/s, de ida y vuelta sobre `bloques` bloques,
// con LiveWindow (9 x 11 trozos, margen { x: 4, n: 6, s: 4 }), la cola del juego (FrameBudget(3, cercano 8 / 64)) y el
// compositor de la GPU, en tiempo real (requestAnimationFrame). Al acabar `segundos`, deja en window.__viva:
// los intervalos entre cuadros (p50, p95, máx, de más de 25 ms), el montón de JS por segundo (minuto 1 contra minuto 5),
// los corrimientos, los cuadros con algo de la vista sin hornear (un trozo de la vista sin escribir) y unas capturas.
//   ?segundos=330&bloques=200&nx=9&ny=11&giros=1 (giros=4: los 4 horneados al día; se ve el 0)
//   ?mundo=<url>: otro mundo, de un JSON { voxset, spec, bake?, center?, nx?, ny?, margin? } (el set, el RegionSpec con
//   sus índices y las opciones de horneado de LiveWindow): para medir con el mundo de un juego sin meterlo en el repo.
// Además deja la cola por clase de trabajo (ms y llamadas) y los huecos con otra vara: el anillo de trozos tx ± 3,
// ty - 3 .. + 5 alrededor del de MAIA, sin escribir
import { Model, type ModelFile } from '@core/index';
import { createCompositor } from '../../../src/view/compositor';
import { FrameBudget } from '../../../src/view/budget';
import { LiveWindow } from '../../../src/world/live';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import { set as SET, SPEC } from '../../../scripts/ventana-mundo';
import { BlockSet, type VoxsetFile } from '../../../src/world/blocks';
import type { RegionSpec } from '../../../src/world/regiongen';
import type { ViewJob } from '../../../src/world/bake';
import maiaFile from '../../../models/maia/maia.json';
import type { Frame2DOptions } from '../../../src/world/frame2d';

// (todo dentro de una función async: el mundo de ?mundo= se lee con fetch antes de empezar)
void (async () => {
  const VW = 384, VH = 216, B = 8;
  const q = new URLSearchParams(location.search);
  const SECONDS = Number(q.get('segundos') ?? 330), BLOCKS = Number(q.get('bloques') ?? 200), NX = Number(q.get('nx') ?? 9), NY = Number(q.get('ny') ?? 11), GIROS = Number(q.get('giros') ?? 1);
  // ?girar=s: cada s segundos, Q (girar con fundido, turnTo: solo vive el giro de ahora); ?presu=ms: el presupuesto cercano
  // mientras dura el fundido (8 por defecto, el de siempre)
  const GIRAR = Number(q.get('girar') ?? 0), PRESU = Number(q.get('presu') ?? 8);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  canvas.width = VW; canvas.height = VH;

  type World = { voxset: VoxsetFile; spec: RegionSpec; bake?: Record<string, unknown>; center?: [number, number]; nx?: number; ny?: number; margin?: { x: number; n: number; s: number } };
  const MUNDO = q.get('mundo');
  const ext: World | null = MUNDO ? await (await fetch(MUNDO)).json() as World : null;
  const set = ext ? BlockSet.fromJSON(ext.voxset) : SET;
  const spec0 = { ...SPEC, height: 12, surface: { base: 6, amplitude: 2, scale: 9 }, seaLevel: 5, veins: (SPEC.veins ?? []).map((v) => ({ ...v, z: [1, 4] as [number, number] })), caves: { ...SPEC.caves!, z: [1, 4] as [number, number] } };
  const t0 = performance.now();
  const spec = ext ? ext.spec : spec0;
  const CENTER: [number, number] = ext?.center ?? [0, 0];
  const win = new LiveWindow({ blocks: set, spec, nx: ext?.nx ?? NX, ny: ext?.ny ?? NY, chunk: 16, center: CENTER, margin: ext?.margin ?? { x: 4, n: 6, s: 4 }, ...(GIRAR ? { viewport: [VW, VH] as const } : { quarters: GIROS === 4 ? [0, 1, 2, 3] as const : [0] as const }), bake: (ext?.bake ?? { incline: 0.5, sky: true, outline: 'both' }) as never });
  const loadMs = performance.now() - t0;
  const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });
  compositor.upload(win.baked);
  const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));
  const T = 128, X0 = CENTER[0] * T + 64, Y = CENTER[1] * T + 64.5;
  let x = X0 + 0.5, dir = 1;
  const ground = (wx: number, wy: number) => { const [lx, ly] = win.toLocal(Math.floor(wx), Math.floor(wy)); return win.store.height[ly * win.store.width + lx] ?? 0; };
  const [lx0, ly0] = win.toLocal(x, Y);
  const id = win.state.entities.add({ model: walk[0]!, x: lx0, y: ly0, z: ground(x, Y), facing: 90 });
  const budget = new FrameBudget(3, undefined, { ms: 8, below: 64 });
  // La cola por clase de trabajo (la key hasta ":" o "#", sin el g<q>/): ms y llamadas, envolviendo cada trabajo una vez
  const byKind = new Map<string, { ms: number; calls: number }>();
  const wrapped = new WeakMap<ViewJob, ViewJob>();
  const kindOf = (k: string) => k.replace(/^g\d\//, '').split(/[:#]/)[0]!;
  const timed = { push(j: ViewJob) {
    let w = wrapped.get(j);
    if (!w) {
      const kind = kindOf(j.key);
      w = { key: j.key, ...(j.priority !== undefined ? { priority: j.priority } : {}), run(d: number) { const a = performance.now(), ok = j.run(d), e = byKind.get(kind) ?? { ms: 0, calls: 0 }; e.ms += performance.now() - a; e.calls++; byKind.set(kind, e); return ok; } };
      wrapped.set(j, w);
    }
    budget.push(w);
  } };
  let ringHoles = 0;

  const frames: number[] = [], heap: number[] = [], shots: string[] = [], queueMs: number[] = [], lag: number[] = [];
  // Por giro: ms desde que se pide hasta el cambio, cuadros, cuadros de más de 25 ms en ese tiempo y CPU del núcleo
  const turns: Array<{ ms: number; frames: number; over25: number; worst: number }> = [];
  let turnAt = -1, turnFrames = 0, turnOver = 0, turnWorst = 0, nextTurn = GIRAR * 1000, lastBaked = win.baked, fade = 1, swapMs = -1;
  let shifts = 0, lastTx0 = win.tx0, lastTy0 = win.ty0, holes = 0, last = performance.now(), start = -1, nextHeap = 0, frameNo = 0;
  const gcHeap = () => { (window as unknown as { gc?: () => void }).gc?.(); return +(mem() / 1e6).toFixed(1); };
  let heapBefore = -1;
  const mem = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

  function loop(now: number): void {
    if (start < 0) start = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    frames.push(now - last); last = now; frameNo++;
    // Andar: ida y vuelta sobre BLOCKS bloques
    x += dir * 6 * B * dt;
    if (x > X0 + BLOCKS * B) dir = -1; else if (x < X0) dir = 1;
    // Girar: Q cada GIRAR segundos; mientras dura el núcleo, el presupuesto cercano es PRESU
    // El montón antes del primer giro (con el recolector forzado si Edge lo da: --js-flags=--expose-gc)
    if (GIRAR && heapBefore < 0 && now - start >= nextTurn) heapBefore = gcHeap();
    if (GIRAR && now - start >= nextTurn) { win.turnTo(((win.turnTarget + 1) % 4) as 0 | 1 | 2 | 3); nextTurn += GIRAR * 1000; if (turnAt < 0) { turnAt = now; turnFrames = 0; turnOver = 0; turnWorst = 0; } }
    if (turnAt >= 0) { turnFrames++; const f = frames[frames.length - 1]!; if (f > 25) turnOver++; turnWorst = Math.max(turnWorst, f); }
    budget.near!.ms = win.turning?.phase === 'core' ? PRESU : 8;
    win.update(x, Y, timed);
    const b0 = performance.now();
    budget.run();
    queueMs.push(performance.now() - b0);
    // Lo que va detrás: trozos por escribir
    lag.push(win.queued);
    if (win.tx0 !== lastTx0 || win.ty0 !== lastTy0) { shifts++; lastTx0 = win.tx0; lastTy0 = win.ty0; }
    const [lx, ly] = win.toLocal(x, Y);
    state_move(lx, ly);
    // El cambio de giro: subir el horneado nuevo y apuntar lo que tardó
    if (win.baked !== lastBaked) {
      compositor.upload(win.baked);
      // (el de antes ya no se pinta: con giros con fundido, uno nuevo por giro)
      if (GIRAR) compositor.release(lastBaked);
      lastBaked = win.baked;
      if (turnAt >= 0 && swapMs < 0 && (!win.turning || win.turning.phase === 'rest')) swapMs = now - turnAt;
    }
    // El fundido: a negro mientras se hace el núcleo, y de vuelta al cambiar (150 ms cada uno)
    fade = win.turning?.phase === 'core' ? Math.max(0, fade - dt / 0.15) : Math.min(1, fade + dt / 0.15);
    canvas.style.opacity = fade.toFixed(2);
    // (el giro se cuenta hasta acabar el fundido de vuelta: la subida del horneado nuevo va en ese tramo)
    if (swapMs >= 0 && fade >= 1) { turns.push({ ms: +swapMs.toFixed(0), frames: turnFrames, over25: turnOver, worst: +turnWorst.toFixed(1) }); turnAt = -1; swapMs = -1; }
    // La vista, centrada en MAIA (en los ejes del giro de ahora)
    const [vx, vy] = win.view.camera.pointToView(lx, ly);
    const [px, py] = win.baked.cam.project(vx, vy, ground(x, Y));
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
    // La vara de FERN: el anillo tx ± 3, ty - 3 .. + 5 alrededor del trozo de MAIA
    { const [mtx, mty] = win.trozoOf(x, Y); let r = false; for (let ty = mty - 3; ty <= mty + 5 && !r; ty++) for (let tx = mtx - 3; tx <= mtx + 3 && !r; tx++) if (!win.isLoaded([tx, ty])) r = true; if (r) ringHoles++; }
    compositor.frame(win.view.frame(), win.baked, o);
    if (now - start >= nextHeap) { heap.push(mem()); nextHeap += 1000; }
    if (frameNo % 1200 === 600 && shots.length < 6) shots.push(canvas.toDataURL('image/png'));
    hud.textContent = `ventana viva · ${(now - start) / 1000 | 0} s · giro ${win.quarter}${win.turning ? ' (' + win.turning.phase + ')' : ''} · trozo ${win.trozoOf(x, Y).join(',')} · corrimientos ${shifts} · huecos ${holes}`;
    if (now - start < SECONDS * 1000) { requestAnimationFrame(loop); return; }
    const f = frames.slice(60), s = [...f].sort((a, b) => a - b), p = (k: number) => +s[Math.floor(k * (s.length - 1))]!.toFixed(1);
    const pq = (a: number[], k: number) => { if (!a.length) return 0; const s2 = [...a].sort((u, v) => u - v); return +s2[Math.floor(k * (s2.length - 1))]!.toFixed(1); };
    const avg = (a: number[]) => a.length ? a.reduce((u, v) => u + v, 0) / a.length : 0;
    (window as unknown as { __viva: unknown }).__viva = {
      loadMs: +loadMs.toFixed(0), frames: f.length, p50: p(0.5), p95: p(0.95), max: p(1), over25: f.filter((v) => v > 25).length,
      ringHoles, queueByKind: Object.fromEntries([...byKind].map(([k, v]) => [k, { ms: Math.round(v.ms), calls: v.calls }])),
      over25perMin: +(f.filter((v) => v > 25).length / (SECONDS / 60)).toFixed(1), shifts, holes,
      queueMs: { p50: pq(queueMs, 0.5), p95: pq(queueMs, 0.95), max: pq(queueMs, 1) }, queuedMax: Math.max(...lag), queuedP50: pq(lag, 0.5),
      trozoMs: { n: win.stats.loadMs.length, p50: pq(win.stats.loadMs, 0.5), p95: pq(win.stats.loadMs, 0.95) },
      shiftMs: { n: win.stats.shiftMs.length, p50: pq(win.stats.shiftMs, 0.5), max: pq(win.stats.shiftMs, 1) },
      switchMs: { p50: pq(win.stats.switchMs, 0.5), max: pq(win.stats.switchMs, 1) },
      heapGc: { before: heapBefore, after: gcHeap(), forced: typeof (window as unknown as { gc?: unknown }).gc === 'function' },
      turns, turnMs: { p50: pq(turns.map((t) => t.ms), 0.5), max: pq(turns.map((t) => t.ms), 1) }, turnOver25: turns.reduce((n, t) => n + t.over25, 0), turnCpuMs: win.stats.turnMs.map((v) => +v.toFixed(0)), quarter: win.quarter,
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
})();
