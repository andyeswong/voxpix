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
import { LiveWindow, type PreparedTrozo } from '../../../src/world/live';
import { LevelPathField } from '../../../src/world/levelpaths';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import { set as SET, SPEC } from '../../../scripts/ventana-mundo';
import { BlockSet, type VoxsetFile } from '../../../src/world/blocks';
import type { RegionSpec } from '../../../src/world/regiongen';
import type { ViewJob, RectOut } from '../../../src/world/bake';
import maiaFile from '../../../models/maia/maia.json';
import type { Frame2DOptions } from '../../../src/world/frame2d';
import { SectionPainter, sectionAround } from '../../../src/world/section';
import * as bakeMod from '../../../src/world/bake';
import type { Baked } from '../../../src/world/bake';

// (todo dentro de una función async: el mundo de ?mundo= se lee con fetch antes de empezar)
void (async () => {
  const VW = 384, VH = 216, B = 8;
  const q = new URLSearchParams(location.search);
  const SECONDS = Number(q.get('segundos') ?? 330), BLOCKS = Number(q.get('bloques') ?? 200), NX = Number(q.get('nx') ?? 9), NY = Number(q.get('ny') ?? 11), GIROS = Number(q.get('giros') ?? 1);
  // ?girar=s: cada s segundos, Q (girar con fundido, turnTo: solo vive el giro de ahora); ?presu=ms: el presupuesto cercano
  // mientras dura el fundido (8 por defecto, el de siempre)
  const GIRAR = Number(q.get('girar') ?? 0), PRESU = Number(q.get('presu') ?? 8);
  // ?hz=60: un cuadro cada 1000/hz ms como mucho, como una pantalla con vsync. Edge sin ventana no tiene vsync y da ~180
  // cuadros por segundo: la cola (~6 ms por cuadro) avanzaba 3 veces más por segundo que en el juego
  const HZ = Number(q.get('hz') ?? 0);
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
  const NXW = ext?.nx ?? NX, NYW = ext?.ny ?? NY;
  // ?worker=1 pinta los recuadros de lo que entra en un worker con su copia de la ventana
  // (hornero.ts); ?freno=N, su freno propio
  const WORKER = q.get('worker') === '1', FRENO = Number(q.get('freno') ?? 1);
  const hornero = WORKER ? new Worker(new URL('./hornero.ts', import.meta.url), { type: 'module' }) : null;
  const remote = { asked: 0, got: 0, workerMs: 0, busyMs: 0, skipped: 0, preps: 0, prepMs: 0 };
  const preps = new Map<number, PreparedTrozo>(), prepped = new Set<string>();
  let pid = 0;
  let lastView: [number, number] = [-1e9, -1e9], viewPending = 0;
  const results = new Map<number, RectOut>();
  if (hornero) {
    hornero.postMessage({ kind: 'init', voxset: ext ? ext.voxset : null, spec: ext ? ext.spec : spec0, chunk: 16, width: NXW * 128, depth: NYW * 128, bake: ext?.bake ?? { incline: 0.5, sky: true, outline: 'both' } });
    hornero.onmessage = (e) => {
      const d = e.data as { kind: string; id: number; ms: number; busyMs: number; skipped: number; o: RectOut; p: PreparedTrozo };
      if (d.kind === 'prep') { preps.set(d.id, d.p); remote.prepMs += d.ms; return; }
      results.set(d.id, d.o); remote.got++; remote.workerMs += d.ms; remote.busyMs = d.busyMs; remote.skipped = d.skipped;
    };
  }
  const win = new LiveWindow({
    // (con el worker, recuadros por trozo: 8 x 8 trozos de vóxeles)
    ...(hornero ? { rebake: { band: 16, rows: 64, merge: true, tile: 8 } } : {}),
    ...(hornero ? {
      // (los que escribió el worker ya están en su copia; los del constructor, no)
      onLoad: (t: readonly [number, number], ctx: { at: readonly [number, number, number] }) => { if (!prepped.delete(`${t[0]},${t[1]}`)) hornero.postMessage({ kind: 'gen', t, at: [ctx.at[0], ctx.at[1]] }); },
      prepareTrozo: (t: readonly [number, number], at: readonly [number, number]) => {
        const id = ++pid; prepped.add(`${t[0]},${t[1]}`); remote.preps++;
        hornero.postMessage({ kind: 'prep', id, t, at, brake: FRENO });
        return { result: () => { const p = preps.get(id); if (p) preps.delete(id); return p ?? null; } };
      },
      // (la tanda nueva antes que el corrimiento: lo pedido antes se salta en el worker)
      onShift: (d: { cells: readonly [number, number]; voxels: readonly [number, number] }) => { hornero.postMessage({ kind: 'epoch', epoch: win.baked.rebakeEpoch ?? 0 }); hornero.postMessage({ kind: 'shift', chunks: [d.voxels[0] / 16, d.voxels[1] / 16], cells: d.cells }); },
    } : {}), blocks: set, spec, nx: ext?.nx ?? NX, ny: ext?.ny ?? NY, chunk: 16, center: CENTER, margin: ext?.margin ?? { x: 4, n: 6, s: 4 }, ...(GIRAR ? { viewport: [VW, VH] as const } : { quarters: GIROS === 4 ? [0, 1, 2, 3] as const : [0] as const }), ...(q.get("prepara") === "0" ? {} : { beforeTurnSwap: (bk: Baked) => compositor.prepare(bk) }), bake: (ext?.bake ?? { incline: 0.5, sky: true, outline: 'both' }) as never });
  const loadMs = performance.now() - t0;
  let rid = 0;
  if (hornero) win.baked.remote = { ask: (rect) => { const id = ++rid; remote.asked++; hornero.postMessage({ kind: 'rect', id, rect, brake: FRENO, epoch: win.baked.rebakeEpoch ?? 0 }); return { result: () => { const o = results.get(id); if (o) results.delete(id); return o ?? null; }, ready: () => results.has(id) }; } };
  const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });
  compositor.upload(win.baked);
  const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));
  const T = 128, X0 = CENTER[0] * T + 64, Y = CENTER[1] * T + 64.5;
  let x = X0 + 0.5, dir = 1;
  const ground = (wx: number, wy: number) => { const [lx, ly] = win.toLocal(Math.floor(wx), Math.floor(wy)); return win.store.height[ly * win.store.width + lx] ?? 0; };
  const [lx0, ly0] = win.toLocal(x, Y);
  const id = win.state.entities.add({ model: walk[0]!, x: lx0, y: ly0, z: ground(x, Y), facing: 90 });
  const budget = new FrameBudget(3, undefined, { ms: 8, below: 64 });
  const PREWARM = q.get('prewarm') === '1';
  let warmed = false;
  const uploads: Array<Record<string, number>> = [], slowCompose: number[] = [];
  // ?caminos=1: un campo de caminos por niveles enganchado a la ventana (se corre en el cambio) y un bicho a 40 vóxeles
  // detrás de MAIA que le pregunta cada cuadro (búsqueda repartida, budget nodos por cuadro): lo que cuesta en el cuadro
  // del cambio y en los demás
  const CAMINOS = q.get('caminos') === '1';
  const REACH = q.get('reach') ? Number(q.get('reach')) : undefined;
  const field = CAMINOS ? new LevelPathField(win.state, { cell: 4, radius: 2, height: 16, step: 8, maxDrop: 24, budget: Number(q.get('nodos') ?? 400), ...(REACH ? { reach: REACH } : {}) }) : null;
  if (field) win.attach(field);
  const pathMs: number[] = [];
  const BICHOS = Number(q.get('bichos') ?? 1);
  // ?espera=fase:ms:cada: para comprobar el reparto por fases, una espera activa de ms en esa fase cada `cada` cuadros
  // (tiene que salir en esa fase y en ese cuadro de los peores)
  const [EF, EMS, ECADA] = (q.get('espera') ?? '::').split(':') as [string, string, string];
  const espera = (fase: string) => { if (EF === fase && frameNo % Number(ECADA) === 0) { const u = performance.now() + Number(EMS); while (performance.now() < u); esperas.push(frameNo); } };
  const esperas: number[] = [];
  let prevPhases: Record<string, number> | null = null, prevShift = false, shiftsSeen = 0, prevPaso = 0;
  const over25By: Record<string, number> = {};
  const SECCION = Number(q.get('seccion') ?? 0), RAFAGA = Number(q.get('rafaga') ?? 0);
  let nextBurst = 2000;
  let painter: SectionPainter | null = null, secFrames = 0, secUnready = 0, secMoves = 0, secMoved = 0;
  const secWhy: Record<string, number> = {}, SEC_RECENT = 6, secRuns: number[] = [];
  let secRun = 0;
  const worst: Array<Record<string, number | boolean> & { iv: number }> = [];
  // La cola por clase de trabajo (la key hasta ":" o "#", sin el g<q>/): ms y llamadas, envolviendo cada trabajo una vez
  const byKind = new Map<string, { ms: number; calls: number }>();
  const wrapped = new WeakMap<ViewJob, ViewJob>();
  const kindOf = (k: string) => k.replace(/^g\d\//, '').split(/[:#]/)[0]!;
  const timed = { push(j: ViewJob) {
    let w = wrapped.get(j);
    if (!w) {
      const kind = kindOf(j.key);
      w = { key: j.key, ...(j.priority !== undefined ? { priority: j.priority } : {}), ...(j.waiting ? { waiting: () => j.waiting!() } : {}), run(d: number) { const a = performance.now(), ok = j.run(d), e = byKind.get(kind) ?? { ms: 0, calls: 0 }; e.ms += performance.now() - a; e.calls++; byKind.set(kind, e); return ok; } };
      wrapped.set(j, w);
    }
    budget.push(w);
  } };
  let ringHoles = 0, ringOut = 0, ringUnloaded = 0;
  const posHist: Record<number, number> = {};

  const frames: number[] = [], heap: number[] = [], shots: string[] = [], queueMs: number[] = [], lag: number[] = [];
  // Por giro: ms desde que se pide hasta el cambio, cuadros, cuadros de más de 25 ms en ese tiempo y CPU del núcleo
  const turns: Array<{ ms: number; frames: number; over25: number; worst: number }> = [];
  let turnAt = -1, turnFrames = 0, turnOver = 0, turnWorst = 0, nextTurn = GIRAR * 1000, lastBaked = win.baked, fade = 1, swapMs = -1;
  let shifts = 0, lastTx0 = win.tx0, lastTy0 = win.ty0, holes = 0, last = performance.now(), start = -1, nextHeap = 0, frameNo = 0;
  const gcHeap = () => { (window as unknown as { gc?: () => void }).gc?.(); return +(mem() / 1e6).toFixed(1); };
  let heapBefore = -1;
  const HEAPGIRO = q.get('heapgiro') === '1', turnHeap: number[] = [];
  const HEAPCADA = Number(q.get('heapcada') ?? 0), heapEvery: Array<{ s: number; mb: number }> = [];
  let nextHeapGc = HEAPCADA * 1000;
  const mem = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

  // Un error en un cuadro para el banco y queda en window.__viva (si no, el que mide espera hasta su tope)
  function loop(now: number): void {
    try { step(now); } catch (e) { (window as unknown as { __viva: unknown }).__viva = { error: String((e as Error)?.stack ?? e), frames: frames.length }; }
  }
  function step(now: number): void {
    // (medio milisegundo de holgura: los rAF no caen exactos)
    if (HZ && last > 0 && now - last < 1000 / HZ - 0.5) { requestAnimationFrame(loop); return; }
    const tPaso = performance.now();
    if (start < 0) start = now;
    const dt = Math.min(0.1, (now - last) / 1000);
    frames.push(now - last); last = now; frameNo++;
    // Andar: ida y vuelta sobre BLOCKS bloques
    x += dir * 6 * B * dt;
    if (x > X0 + BLOCKS * B) dir = -1; else if (x < X0) dir = 1;
    // Girar: Q cada GIRAR segundos; mientras dura el núcleo, el presupuesto cercano es PRESU
    // El montón antes del primer giro (con el recolector forzado si Edge lo da: --js-flags=--expose-gc)
    if (GIRAR && heapBefore < 0 && now - start >= nextTurn) heapBefore = gcHeap();
    // ?heapcada=N: el montón (con el recolector forzado) cada N segundos, gire o no
    if (HEAPCADA && now - start >= nextHeapGc) { heapEvery.push({ s: Math.round((now - start) / 1000), mb: gcHeap() }); nextHeapGc += HEAPCADA * 1000; }
    // ?heapgiro=1: el montón (con el recolector forzado) antes de cada giro, para ver si crece de giro en giro
    if (GIRAR && HEAPGIRO && now - start >= nextTurn) turnHeap.push(gcHeap());
    if (GIRAR && now - start >= nextTurn) { win.turnTo(((win.turnTarget + 1) % 4) as 0 | 1 | 2 | 3); nextTurn += GIRAR * 1000; if (turnAt < 0) { turnAt = now; turnFrames = 0; turnOver = 0; turnWorst = 0; } }
    if (turnAt >= 0) { turnFrames++; const f = frames[frames.length - 1]!; if (f > 25) turnOver++; turnWorst = Math.max(turnWorst, f); }
    budget.near!.ms = win.turning?.phase === 'core' ? PRESU : 8;
    const t0 = performance.now();
    win.update(x, Y, timed);
    espera('update');
    const t1 = performance.now();
    if (field) {
      // BICHOS bichos alrededor de MAIA (a 16..112 vóxeles, repartidos en círculo), todos hacia ella: una búsqueda
      // compartida (la misma meta) y un advance por cuadro
      const a = performance.now(), [mx, my] = win.toLocal(x, Y), goal = { x: mx, y: my, z: ground(x, Y) };
      for (let k = 0; k < BICHOS; k++) {
        const ang = (k / BICHOS) * Math.PI * 2, d = BICHOS === 1 ? 40 : 16 + (k % 5) * 24, wx = x + Math.cos(ang) * d * (BICHOS === 1 ? -dir : 1), wy = Y + (BICHOS === 1 ? 0 : Math.sin(ang) * d);
        const [ex, ey] = win.toLocal(wx, wy);
        field.dir({ x: ex, y: ey, z: ground(wx, wy) }, goal, 4);
      }
      field.advance();
      pathMs.push(performance.now() - a);
    }
    const b0 = performance.now();
    budget.run();
    espera('cola');
    queueMs.push(performance.now() - b0);
    const t2 = performance.now();
    // Lo que va detrás: trozos por escribir
    lag.push(win.queued);
    if (win.tx0 !== lastTx0 || win.ty0 !== lastTy0) { shifts++; lastTx0 = win.tx0; lastTy0 = win.ty0; }
    const [lx, ly] = win.toLocal(x, Y);
    state_move(lx, ly);
    const t3 = performance.now();
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
    // ?seccion=N: el corte de una caja de N vóxeles de ancho alrededor de MAIA, desde sus pies (lo de delante, bajo tierra),
    // pintado por franjas (SectionPainter, uno por horneado) en la cola; se cuentan los cuadros con la caja sin pintar
    // del todo
    if (SECCION) {
      // ?rafaga=N: cada 2 s, N recuadros publicados lejos de la caja (200 columnas a la derecha de MAIA, toda la altura),
      // como los que entrega el worker de golpe (no cambian nada de la imagen: solo cuentan como publicados)
      if (RAFAGA && now - start >= nextBurst) {
        nextBurst += 2000;
        const bk = win.baked, fx = Math.min(bk.width - 5, Math.round(px) + 200);
        for (let k = 0; k < RAFAGA; k++) {
          const r = { serial: ++bk.published.serial, x0: fx, y0: 0, x1: fx + 3, y1: bk.height - 1 };
          const pp = (bakeMod as unknown as { pushPublished?: (b: unknown, r: unknown) => void }).pushPublished;
          if (pp) pp(bk, r); else { bk.published.rects.push(r); if (bk.published.rects.length > 32) bk.published.rects.shift(); }
        }
      }
      if (!painter || painter.b !== win.baked) painter = new SectionPainter(win.baked);
      painter.set(sectionAround(win.view.camera, lx, ly, ground(x, Y), SECCION), dir);
      const pj = painter.job();
      if (pj) timed.push(pj);
      o.sectionLayer = painter.layer();
      if (frames.length > 60) {
        secFrames++;
        const st = painter.boxState();
        if (st.moved) secMoves++;
        const ready = painter.ready();
        if (!ready) secRun++;
        else if (secRun) { secRuns.push(secRun); secRun = 0; }
        if (!ready) {
          secUnready++;
          // Por qué: la caja acaba de cambiar de franja (este cuadro o en los SEC_RECENT anteriores), franjas sin pintar,
          // franjas viejas por un rehorneado, lo tirado por moverse en y o en z
          if (st.moved) secMoved = SEC_RECENT;
          const k = `${secMoved > 0 ? 'tras-avanzar' : 'quieta'}:${st.missing ? 'sin-pintar' : ''}${st.missing && st.stale ? '+' : ''}${st.stale ? 'viejas' : ''}`;
          secWhy[k] = (secWhy[k] ?? 0) + 1;
        }
        if (secMoved > 0) secMoved--;
      }
    }
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
    // (y por qué: algún trozo del anillo fuera de la ventana, o dentro sin escribir; y dónde va MAIA en la ventana)
    { const [mtx, mty] = win.trozoOf(x, Y); let r = false, out = false, unl = false;
      for (let ty = mty - 3; ty <= mty + 5; ty++) for (let tx = mtx - 3; tx <= mtx + 3; tx++) if (!win.isLoaded([tx, ty])) { r = true; if (tx < win.tx0 || tx >= win.tx0 + NXW || ty < win.ty0 || ty >= win.ty0 + NYW) out = true; else unl = true; }
      if (r) ringHoles++; if (out) ringOut++; if (unl) ringUnloaded++;
      const ix = mtx - win.tx0; posHist[ix] = (posHist[ix] ?? 0) + 1; }
    const t4 = performance.now();
    // (con el worker: dónde está la vista, para que pinte primero lo de cerca; y si lo que se ve tiene algún recuadro
    // pendiente, la puerta del 6x)
    if (hornero && (Math.abs(o.vx - lastView[0]) > 8 || Math.abs(o.vy - lastView[1]) > 8)) { lastView = [o.vx, o.vy]; hornero.postMessage({ kind: 'view', x: o.vx + VW / 2, y: o.vy + VH / 2 }); }
    for (const k of win.baked.rectsBusy?.keys() ?? []) {
      const [x0, y0, x1, y1] = k.slice(5).split(',').map(Number) as [number, number, number, number];
      if (x1 >= o.vx && x0 < o.vx + VW && y1 >= o.vy && y0 < o.vy + VH) { viewPending++; break; }
    }
    // ?prewarm=1: los 8 cuadros de andar de MAIA, a este y oeste, precalentados la primera vez (como el juego)
    if (PREWARM && !warmed) { compositor.prewarm(win.baked, o, walk.map((m) => ({ model: m, yaws: [90, 270], casts: true }))); warmed = true; }
    compositor.frame(win.view.frame(), win.baked, o);
    espera('componer');
    const t5 = performance.now();
    // Lo que subió este cuadro: sprites nuevos y cuerpos de sombra (el primer cuadro de cada modelo y giro)
    { const u = compositor.uploadStats(); if (u && (u.sprites || u.occFull || u.occParts || u.bodyFull || u.bodyParts) && uploads.length < 60) uploads.push({ at: +((now - start) / 1000).toFixed(1), sprites: u.sprites, occ: u.occFull + u.occParts, body: u.bodyFull + u.bodyParts, componer: +(t5 - t4).toFixed(1) }); }
    if (t5 - t4 > 8) slowCompose.push(+((now - start) / 1000).toFixed(1));
    // Por fases (el intervalo que acaba en el cuadro siguiente es el de este trabajo): los 8 peores intervalos, con lo de
    // cada fase del cuadro de antes y lo que queda fuera de nuestro JS (el recolector, el navegador, la GPU)
    // (el paso entero del cuadro de antes, prevPaso: lo que no cae en ninguna fase es "sinMedir", y lo que queda del
    // intervalo fuera del paso, "fuera" de verdad)
    if (prevPhases && frames.length > 60) {
      const iv = frames[frames.length - 1]!;
      // Cada intervalo de más de 25 ms, por lo que más pesó en él: una fase nuestra o lo de fuera de nuestro JS
      if (iv > 25) {
        const parts: Record<string, number> = { ...prevPhases, fuera: iv - prevPaso };
        const top = Object.entries(parts).sort((u, v) => v[1] - u[1])[0]![0];
        over25By[top] = (over25By[top] ?? 0) + 1;
        if (prevShift) over25By.conCorrimiento = (over25By.conCorrimiento ?? 0) + 1;
      }
      if (worst.length < 8 || iv > worst[worst.length - 1]!.iv) {
        const ours = Object.values(prevPhases).reduce((u, v) => u + v, 0);
        worst.push({ iv: +iv.toFixed(1), at: +((now - start) / 1000).toFixed(1), cuadro: frameNo - 1, ...prevPhases, paso: +prevPaso.toFixed(1), sinMedir: +(prevPaso - ours).toFixed(1), fuera: +(iv - prevPaso).toFixed(1), shift: prevShift });
        worst.sort((u, v) => v.iv - u.iv); worst.length = Math.min(8, worst.length);
      }
    }
    if (now - start >= nextHeap) { heap.push(mem()); nextHeap += 1000; }
    // (las capturas del banco: toDataURL del lienzo de la GPU, también por fases)
    const t6 = performance.now();
    if (frameNo % 1200 === 600 && shots.length < 6) shots.push(canvas.toDataURL('image/png'));
    const t7 = performance.now();
    prevPhases = { update: +(t1 - t0).toFixed(1), caminos: +(b0 - t1).toFixed(1), cola: +(t2 - b0).toFixed(1), mover: +(t3 - t2).toFixed(1), resto: +(t4 - t3).toFixed(1), componer: +(t5 - t4).toFixed(1), captura: +(t7 - t6).toFixed(1) };
    prevShift = shifts !== shiftsSeen; shiftsSeen = shifts;
    hud.textContent = `ventana viva · ${(now - start) / 1000 | 0} s · giro ${win.quarter}${win.turning ? ' (' + win.turning.phase + ')' : ''} · trozo ${win.trozoOf(x, Y).join(',')} · corrimientos ${shifts} · huecos ${holes}`;
    prevPaso = performance.now() - tPaso;
    if (now - start < SECONDS * 1000) { requestAnimationFrame(loop); return; }
    const f = frames.slice(60), s = [...f].sort((a, b) => a - b), p = (k: number) => +s[Math.floor(k * (s.length - 1))]!.toFixed(1);
    const pq = (a: number[], k: number) => { if (!a.length) return 0; const s2 = [...a].sort((u, v) => u - v); return +s2[Math.floor(k * (s2.length - 1))]!.toFixed(1); };
    const avg = (a: number[]) => a.length ? a.reduce((u, v) => u + v, 0) / a.length : 0;
    (window as unknown as { __viva: unknown }).__viva = {
      loadMs: +loadMs.toFixed(0), frames: f.length, p50: p(0.5), p95: p(0.95), max: p(1), over25: f.filter((v) => v > 25).length,
      pathMs: CAMINOS ? { p50: pq(pathMs, 0.5), p95: pq(pathMs, 0.95), max: pq(pathMs, 1), lag: field!.lag } : null,
      remote: WORKER ? { ...remote, workerMs: Math.round(remote.workerMs), busyMs: Math.round(remote.busyMs), main: win.baked.remoteStats ?? null } : null,
      cielo: win.baked.skyStats ? { ...win.baked.skyStats, ms: Math.round(win.baked.skyStats.ms) } : null, viewPending, seccion: SECCION ? { frames: secFrames, sinPintar: secUnready, pct: +(100 * secUnready / Math.max(1, secFrames)).toFixed(1), pintadas: painter?.painted ?? 0, avances: secMoves, tiradas: painter?.resets ?? 0, porque: secWhy, rachas: { n: secRuns.length, max: Math.max(0, ...secRuns), hist: secRuns.reduce((h: Record<string, number>, r) => { const k = r <= 2 ? '1-2' : r <= 5 ? '3-5' : r <= 10 ? '6-10' : '>10'; h[k] = (h[k] ?? 0) + 1; return h; }, {}) } } : null, over25By, uploads, slowCompose: { n: slowCompose.length, primeros: slowCompose.slice(0, 20) }, worst, esperas: esperas.slice(0, 20), ringHoles, ringOut, ringUnloaded, posHist, queueByKind: Object.fromEntries([...byKind].map(([k, v]) => [k, { ms: Math.round(v.ms), calls: v.calls }])),
      over25perMin: +(f.filter((v) => v > 25).length / (SECONDS / 60)).toFixed(1), shifts, holes,
      queueMs: { p50: pq(queueMs, 0.5), p95: pq(queueMs, 0.95), max: pq(queueMs, 1) }, queuedMax: Math.max(...lag), queuedP50: pq(lag, 0.5),
      trozoMs: { n: win.stats.loadMs.length, p50: pq(win.stats.loadMs, 0.5), p95: pq(win.stats.loadMs, 0.95) },
      shiftMs: { n: win.stats.shiftMs.length, p50: pq(win.stats.shiftMs, 0.5), max: pq(win.stats.shiftMs, 1) },
      switchMs: { p50: pq(win.stats.switchMs, 0.5), max: pq(win.stats.switchMs, 1) },
      shiftWallMs: { p50: pq(win.stats.shiftWallMs, 0.5), p95: pq(win.stats.shiftWallMs, 0.95), max: pq(win.stats.shiftWallMs, 1) },
      loadWallMs: { p50: pq(win.stats.loadWallMs, 0.5), p95: pq(win.stats.loadWallMs, 0.95), max: pq(win.stats.loadWallMs, 1) },
      turnHeap, heapEvery, heapGc: { before: heapBefore, after: gcHeap(), forced: typeof (window as unknown as { gc?: unknown }).gc === 'function' },
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
