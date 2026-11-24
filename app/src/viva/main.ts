// El banco de andar de la ventana viva: MAIA anda por un mundo por regiones sin bordes (el spec de
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
//   ?agua=1: el agua del mundo (el material 'agua' del set) como WaterLayer (movable, sin cargar, LiveWindow.setWater): sin
//   escribirla en la rejilla (skip), cargada por trozo en onLoad (regionWater) y guardada en onUnload. ?pisar=N: cada N
//   cuadros, un pisotón en el agua más cercana al personaje (hasta 64 vóxeles). ?aguacheck=N: cada N cuadros, la textura del
//   fondo del agua de la GPU leída contra la vista (celdas distintas). Deja en __viva.agua lo que cuesta
import { Model, type ModelFile } from '@core/index';
import { createCompositor } from '../../../src/view/compositor';
import { FrameBudget, wrapJob } from '../../../src/view/budget';
import { BakeWorker, type BakeWorkerPort } from '../../../src/world/horno';
import { LiveWindow, type PreparedTrozo, type TrozoCtx } from '../../../src/world/live';
import { WaterLayer, regionWater, type WaterChunk } from '../../../src/world/water';
import { Weather } from '../../../src/world/weather';
import { daySun } from '../../../src/lighting/daycycle';
import { LevelPathField } from '../../../src/world/levelpaths';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import { set as SET, SPEC } from '../../../scripts/ventana-mundo';
import { BlockSet, type VoxsetFile } from '../../../src/world/blocks';
import type { RegionSpec } from '../../../src/world/regiongen';
import type { ViewJob, RectOut } from '../../../src/world/bake';
import maiaFile from '../../../models/maia/maia.json';
import type { Frame2DOptions } from '../../../src/world/frame2d';
import { SectionPainter, sectionAround, crossWindow } from '../../../src/world/section';
import { AgentHost, installAgent } from '../../../src/agent/agent';
import * as bakeMod from '../../../src/world/bake';
import type { Baked } from '../../../src/world/bake';

// (todo dentro de una función async: el mundo de ?mundo= se lee con fetch antes de empezar)
void (async () => {
  // El arranque, por fases (ms desde que se abrió la página: performance.now cuenta desde la navegación)
  const boot: Record<string, number> = { script: Math.round(performance.now()) };
  const VW = 384, VH = 216, B = 8;
  const q = new URLSearchParams(location.search);
  const AGUA = q.get('agua') === '1', PISAR = Number(q.get('pisar') ?? 0), AGUACHECK = Number(q.get('aguacheck') ?? 0);
  // ?foco=N: el agua solo se simula a N vóxeles o menos del personaje (WaterLayer.setFocus); ?pisar=orilla: un pisotón al
  // entrar en el agua (al pasar de seco a mojado), el ritmo de un juego, en vez de cada N cuadros
  const FOCO = Number(q.get('foco') ?? 0), ORILLA = q.get('pisar') === 'orilla';
  // ?seguir=1: el agua sigue al mundo (WaterLayer.follow: cada vóxel escrito, también los trozos que entran, rehace su fondo),
  // como en un juego que pica y pone
  const SEGUIR = q.get('seguir') === '1';
  const SECONDS = Number(q.get('segundos') ?? 330), BLOCKS = Number(q.get('bloques') ?? 200), NX = Number(q.get('nx') ?? 9), NY = Number(q.get('ny') ?? 11), GIROS = Number(q.get('giros') ?? 1);
  // ?girar=s: cada s segundos, Q (girar con fundido, turnTo: solo vive el giro de ahora); ?presu=ms: el presupuesto cercano
  // mientras dura el fundido (8 por defecto, el de siempre)
  const GIRAR = Number(q.get('girar') ?? 0), PRESU = Number(q.get('presu') ?? 8);
  // ?nucleo=1: la ventana hornea primero solo lo que se ve (bakeFirst: 'view'); ?quieto=1: MAIA no anda
  const NUCLEO = q.get('nucleo') === '1', QUIETO = q.get('quieto') === '1';
  // ?entrar=T: a los T segundos, entrar bajo tierra: un corte (win.view.cutJob) de una caja de 2 x ?corte=N vóxeles
  // alrededor de MAIA, que esconde desde ?cortez=Z vóxeles por debajo de sus pies, y su rehorneado sin prioridad en cada
  // cuadro (rebakeChangedJobs sin near); una captura a los 800 ms y otra con la cola vacía, y cuándo se abrió
  const ENTRAR = Number(q.get('entrar') ?? 0), CORTE = Number(q.get('corte') ?? 48), CORTEZ = Number(q.get('cortez') ?? 8), ENTRARNEAR = q.get('entrarnear') === '1';
  // ?hz=60: un cuadro cada 1000/hz ms como mucho, como una pantalla con vsync. Edge sin ventana no tiene vsync y da ~180
  // cuadros por segundo: la cola (~6 ms por cuadro) avanzaba 3 veces más por segundo que en el juego
  const HZ = Number(q.get('hz') ?? 0);
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const hud = document.getElementById('hud')!;
  canvas.width = VW; canvas.height = VH;

  type World = { voxset: VoxsetFile; spec: RegionSpec; bake?: Record<string, unknown>; center?: [number, number]; nx?: number; ny?: number; margin?: { x: number; n: number; s: number } };
  const MUNDO = q.get('mundo');
  const ext: World | null = MUNDO ? await (await fetch(MUNDO)).json() as World : null;
  boot.mundo = Math.round(performance.now());
  // ?clima=viento,agua,cae,suelo,sol (o todo): esas piezas del clima en cada cuadro; con cualquiera, las hojas, la flor y la
  // hierba del set se mecen si está viento. ?mece=1: las rampas se mecen aunque el clima esté apagado (lo que cuesta declararlo)
  const CLIMA = new Set((q.get('clima') ?? '').replace('todo', 'viento,agua,cae,suelo,sol').split(',').filter(Boolean)), MECE = q.get('mece') === '1' || CLIMA.has('viento');
  const meteo = new Weather({ seed: 5, levels: { wind: [0.8, 0.3], gust: 0.7, rain: CLIMA.has('cae') ? 0.9 : 0, snow: CLIMA.has('cae') ? 0.3 : 0, clouds: 0.5 } });
  if (CLIMA.has('suelo')) meteo.importState({ ...meteo.exportState(), snow: 0.5, wet: 0.7 });
  const baseSet = ext ? BlockSet.fromJSON(ext.voxset) : SET;
  const set = !MECE ? baseSet : BlockSet.fromJSON((() => { const j = structuredClone(baseSet.toJSON()); for (const r of j.palette.ramps) { if (r.name === 'hojas') r.props = { ...r.props, sway: 2, anchor: 'self' }; if (r.name === 'flor' || r.name === 'hierba') r.props = { ...r.props, sway: 2, anchor: 'root', reach: 0 }; } return j; })());
  boot.bloques = Math.round(performance.now());
  const spec0 = { ...SPEC, height: 12, surface: { base: 6, amplitude: 2, scale: 9 }, seaLevel: 5, veins: (SPEC.veins ?? []).map((v) => ({ ...v, z: [1, 4] as [number, number] })), caves: { ...SPEC.caves!, z: [1, 4] as [number, number] } };
  const t0 = performance.now();
  const spec = ext ? ext.spec : spec0;
  const CENTER: [number, number] = ext?.center ?? [0, 0];
  const NXW = ext?.nx ?? NX, NYW = ext?.ny ?? NY;
  // ?worker=1 pinta los recuadros de lo que entra en un worker con su copia de la ventana
  // (hornero.ts); ?freno=N, su freno propio
  // ?worker=2: el del motor (BakeWorker, src/world/horno.ts), con los trozos escritos aquí
  // ?negro=N: cada N s, la fracción casi negra de la pantalla y la vacía dentro del recuadro de la vista (huecos)
  const NEGRO = Number(q.get('negro') ?? 0), negro: Array<Record<string, number>> = [];
  let nextNegro = 0, negroCanvas: HTMLCanvasElement | null = null;
  const WORKER = q.get('worker') === '1', WORKER2 = q.get('worker') === '2', FRENO = Number(q.get('freno') ?? 1);
  const hornero = WORKER ? new Worker(new URL('./hornero.ts', import.meta.url), { type: 'module' }) : null;
  const remote = { asked: 0, got: 0, workerMs: 0, busyMs: 0, skipped: 0, preps: 0, prepMs: 0 };
  const preps = new Map<number, PreparedTrozo>(), prepped = new Set<string>();
  let pid = 0;
  let lastView: [number, number] = [-1e9, -1e9], viewPending = 0;
  // (con ?worker=2: cada segundo, lo pedido fuera, lo saltado, lo que falta por llegar, los recuadros ocupados, las tandas y
  // los re-pedidos: para ver un atasco en el tiempo)
  const linea: Array<Record<string, number>> = [];
  let nextLinea = 0;
  const results = new Map<number, RectOut>();
  if (hornero) {
    hornero.postMessage({ kind: 'init', voxset: ext ? ext.voxset : null, spec: ext ? ext.spec : spec0, chunk: 16, width: NXW * 128, depth: NYW * 128, bake: ext?.bake ?? { incline: 0.5, sky: true, outline: 'both' } });
    hornero.onmessage = (e) => {
      const d = e.data as { kind: string; id: number; ms: number; busyMs: number; skipped: number; o: RectOut; p: PreparedTrozo };
      if (d.kind === 'prep') { preps.set(d.id, d.p); remote.prepMs += d.ms; return; }
      results.set(d.id, d.o); remote.got++; remote.workerMs += d.ms; remote.busyMs = d.busyMs; remote.skipped = d.skipped;
    };
  }
  // El agua: los trozos llegan a onLoad antes de que haya capa (la del constructor); se cargan al ponerla
  const AGUA_T = AGUA ? set.index('agua') : -1;
  if (AGUA && hornero) throw new Error('?agua=1 con el worker de la página (hornero) no: sus trozos traen el agua escrita');
  let water: WaterLayer | null = null;
  const aguaPend: Array<[readonly [number, number], TrozoCtx]> = [], aguaSaved = new Map<string, WaterChunk | null>();
  const aguaRect = (ctx: TrozoCtx) => [ctx.at[0] * B, ctx.at[1] * B, ctx.at[0] * B + 128 - 1, ctx.at[1] * B + 128 - 1] as const;
  const aguaLoad = (t: readonly [number, number], ctx: TrozoCtx) => {
    const sv = aguaSaved.get(`${t[0]},${t[1]}`) ?? null;
    return water!.loadJob(...aguaRect(ctx), { saved: sv, surface: sv ? null : regionWater(ctx.region!, AGUA_T, B, ctx.at) });
  };
  const win = new LiveWindow({
    ...(ENTRAR ? { view: { cut: true } } : {}),
    ...(AGUA ? {
      skip: [AGUA_T],
      onLoad: (t: readonly [number, number], ctx: TrozoCtx) => { if (water) return aguaLoad(t, ctx); aguaPend.push([t, ctx]); },
      onUnload: (t: readonly [number, number], ctx: TrozoCtx) => { aguaSaved.set(`${t[0]},${t[1]}`, water!.save(...aguaRect(ctx))); },
    } : {}),
    // (con el worker, recuadros por trozo: 8 x 8 trozos de vóxeles)
    // (?tile=N: el rehorneado por baldosas de N x N trozos de vóxeles con o sin worker; 0, sin baldosas)
    ...(q.get('tile') !== null ? (Number(q.get('tile')) ? { rebake: { band: 16, rows: 64, merge: true, tile: Number(q.get('tile')) } } : {}) : hornero || WORKER2 ? { rebake: { band: 16, rows: 64, merge: true, tile: 8 } } : {}),
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
    } : {}), blocks: set, spec, nx: ext?.nx ?? NX, ny: ext?.ny ?? NY, chunk: 16, center: CENTER, margin: ext?.margin ?? { x: 4, n: 6, s: 4 }, ...(GIRAR || NUCLEO ? { viewport: [VW, VH] as const } : { quarters: GIROS === 4 ? [0, 1, 2, 3] as const : [0] as const }), ...(NUCLEO ? { bakeFirst: 'view' as const } : {}), ...(q.get("prepara") === "0" ? {} : { beforeTurnSwap: (bk: Baked) => compositor.prepare(bk) }), bake: (ext?.bake ?? { incline: 0.5, sky: true, outline: 'both' }) as never });
  if (AGUA) {
    const st = win.store;
    water = new WaterLayer({ model: st, lights: [], width: st.width, depth: st.depth, wet: new Uint8Array(0), waterTop: new Int16Array(0), fountain: null } as never, { movable: true, unloaded: true, wallAbove: Infinity });
    win.setWater(water);
    if (SEGUIR) water.follow(win.state.watchChanges());
    for (const [t, ctx] of aguaPend) { const j = aguaLoad(t, ctx); while (!j.run(Infinity)); }
    aguaPend.length = 0;
  }
  const loadMs = performance.now() - t0;
  boot.ventana = Math.round(performance.now());
  let rid = 0;
  if (hornero) win.baked.remote = { ask: (rect) => { const id = ++rid; remote.asked++; hornero.postMessage({ kind: 'rect', id, rect, brake: FRENO, epoch: win.baked.rebakeEpoch ?? 0 }); return { result: () => { const o = results.get(id); if (o) results.delete(id); return o ?? null; }, ready: () => results.has(id) }; } };
  const motor = WORKER2 ? new BakeWorker(new Worker(new URL('../../../src/world/horno-worker.ts', import.meta.url), { type: 'module' }) as unknown as BakeWorkerPort, { brake: FRENO, ...(q.get('cerca') === '1' ? { near: (r: { x0: number; x1: number }) => !!cercaX && r.x1 >= cercaX[0] && r.x0 <= cercaX[1] } : {}) }) : null;
  motor?.attach(win);
  // (?cerca=1, con el del motor y ?entrar: desde que se entra, lo que toca la columna del corte (su caja ± 32 px, toda la
  // altura) es cercano y se pinta aquí; lo que estaba fuera y pasa a serlo se retira)
  let cercaX: [number, number] | null = null;
  const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });
  boot.compositor = Math.round(performance.now());
  compositor.upload(win.baked);
  boot.subida = Math.round(performance.now());
  const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));
  const T = 128, X0 = CENTER[0] * T + 64, Y = CENTER[1] * T + 64.5;
  let x = X0 + 0.5, dir = QUIETO ? 0 : 1;
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
  const fases: Record<string, number[]> = {};
  const SECCION = Number(q.get('seccion') ?? 0), RAFAGA = Number(q.get('rafaga') ?? 0), SECZ = Number(q.get('seccionz') ?? 0), CRUZ = Number(q.get('cruz') ?? 0), RADIO = Number(q.get('radio') ?? 40), BORDE = Number(q.get('borde') ?? 0);
  let veloMax = 0;                                       // (para medir) el máximo de píxeles con velo de la capa
  const VELO = q.get('velo') === null ? null : Number(q.get('velo')), VELOZ = Number(q.get('veloz') ?? 8), VELOCARAS = q.get('velocaras') === '1';
  let sinHornear = 0, sinHornearPrimero = -1, muestras = 0;
  const captura: { primero?: string; final?: string; finalA?: number } = {}, CAPTURA = q.get('captura') === '1';
  let nextBurst = 2000;
  const entrada: { a?: number; abiertoMs?: number; corteMs?: number; c800?: string; final?: string; finalMs?: number; rects800?: number; pendientes800?: string[]; seccionMs?: number; cola800?: string[] } = {};
  let painter: SectionPainter | null = null, secFrames = 0, secUnready = 0, secMoves = 0, secMoved = 0;
  // ?agente=1: la interfaz para agentes en window.voxpixAgent (la vista, el personaje, los caminos si hay ?caminos=1; sin
  // simulación: aquí se anda por guion), y window.__vivaAgente.pixel() el píxel del centro del personaje en la imagen
  if (q.get('agente') === '1') {
    const host = new AgentHost({ state: win.state, grid: win.grid, look: () => ({ view: win.view, baked: win.baked, section: painter?.layer() ?? null }),
      player: () => { const e = win.state.entities.get(id); return e ? { x: e.x, y: e.y, z: e.z } : null; }, playerEntity: id, ...(field ? { paths: field } : {}) });
    installAgent(window as unknown as Record<string, unknown>, host);
    (window as unknown as { __vivaAgente: unknown }).__vivaAgente = {
      id,
      pixel: () => { const e = win.state.entities.get(id)!; const [vx, vy] = win.view.camera.pointToView(e.x, e.y); const [px, py] = win.baked.cam.project(vx + 0.5, vy, e.z + 8); return [Math.floor(px), Math.floor(py)]; },
    };
  }
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
      w = wrapJob(j, { run(d: number) { const a = performance.now(), ok = j.run(d), e = byKind.get(kind) ?? { ms: 0, calls: 0 }; e.ms += performance.now() - a; e.calls++; byKind.set(kind, e); return ok; } });
      wrapped.set(j, w);
    }
    budget.push(w);
  } };
  let ringHoles = 0, ringOut = 0, ringUnloaded = 0;
  const posHist: Record<number, number> = {};

  const frames: number[] = [], heap: number[] = [], shots: string[] = [], queueMs: number[] = [], lag: number[] = [];
  // Por giro: ms desde que se pide hasta el cambio, cuadros, cuadros de más de 25 ms en ese tiempo y CPU del núcleo
  const turns: Array<{ ms: number; frames: number; over25: number; worst: number }> = [];
  // (por giro, en ms de performance.now(): la tecla, el cambio de horneado y el final de lo demás; con ?worker=2 se cruza
  // con el primer espejo creado tras la tecla)
  const giros: Array<{ tecla: number; cambio: number; resto: number; nucleo?: unknown }> = [];
  let turnAt = -1, turnFrames = 0, turnOver = 0, turnWorst = 0, nextTurn = GIRAR * 1000, lastBaked = win.baked, fade = 1, swapMs = -1;
  let shifts = 0, lastTx0 = win.tx0, lastTy0 = win.ty0, holes = 0, last = performance.now(), start = -1, nextHeap = 0, frameNo = 0;
  const gcHeap = () => { (window as unknown as { gc?: () => void }).gc?.(); return +(mem() / 1e6).toFixed(1); };
  let heapBefore = -1;
  const HEAPGIRO = q.get('heapgiro') === '1', turnHeap: number[] = [];
  const HEAPCADA = Number(q.get('heapcada') ?? 0), heapEvery: Array<{ s: number; mb: number; cola: number; trozos: number }> = [];
  let nextHeapGc = HEAPCADA * 1000;
  // ?entrar: los 4 s antes de entrar y los 4 s tras entrar, cuadro a cuadro (el intervalo, sus fases, lo de fuera de
  // nuestro JS, los recuadros publicados en el cuadro y sus píxeles, y si el montón cayó: el recolector)
  const ventanas: { antes: Array<Record<string, number>>; tras: Array<Record<string, number>> } = { antes: [], tras: [] };
  let prevExtra: Record<string, number> | null = null, pubSeen = -1, pubOf: unknown = null, heapSeen = 0;
  const mem = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;

  // Un error en un cuadro para el banco y queda en window.__viva (si no, el que mide espera hasta su tope)
  function loop(now: number): void {
    try { step(now); } catch (e) { (window as unknown as { __viva: unknown }).__viva = { error: String((e as Error)?.stack ?? e), frames: frames.length }; }
  }
  function step(now: number): void {
    if (!boot.raf) boot.raf = Math.round(performance.now());
    else if (!boot.segundoRaf) boot.segundoRaf = Math.round(performance.now());
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
    // (y lo que queda en la cola y de trozos por rehornear: con ?nucleo, hasta cuándo dura el rehorneado de lo de fuera)
    if (HEAPCADA && now - start >= nextHeapGc) { heapEvery.push({ s: Math.round((now - start) / 1000), mb: gcHeap(), cola: budget.pending, trozos: win.baked.source.changedSince(win.baked.version).length }); nextHeapGc += HEAPCADA * 1000; }
    // ?heapgiro=1: el montón (con el recolector forzado) antes de cada giro, para ver si crece de giro en giro
    if (GIRAR && HEAPGIRO && now - start >= nextTurn) turnHeap.push(gcHeap());
    if (GIRAR && now - start >= nextTurn) { giros.push({ tecla: performance.now(), cambio: -1, resto: -1 }); win.turnTo(((win.turnTarget + 1) % 4) as 0 | 1 | 2 | 3); nextTurn += GIRAR * 1000; if (turnAt < 0) { turnAt = now; turnFrames = 0; turnOver = 0; turnWorst = 0; } }
    if (turnAt >= 0) { turnFrames++; const f = frames[frames.length - 1]!; if (f > 25) turnOver++; turnWorst = Math.max(turnWorst, f); }
    budget.near!.ms = win.turning?.phase === 'core' ? PRESU : 8;
    const t0 = performance.now();
    win.update(x, Y, timed);
    if (ENTRAR && entrada.a === undefined && now - start >= ENTRAR * 1000) {
      const [ex, ey] = win.toLocal(x, Y);
      timed.push(win.view.cutJob({ x0: Math.floor(ex) - CORTE, y0: Math.floor(ey) - CORTE, x1: Math.floor(ex) + CORTE, y1: Math.floor(ey) + CORTE, zTop: ground(x, Y) - CORTEZ }));
      entrada.a = now;
      cercaX = [Math.floor(ex) - CORTE - 32, Math.floor(ex) + CORTE + 32];
    }
    if (ENTRAR && entrada.a !== undefined && win.baked.source.changedSince(win.baked.version).length) {
      // (?entrarnear=1: con near en MAIA, como el rehorneado de lo editado en el juego: prioridad por distancia en pantalla)
      const [nx, ny] = win.view.camera.pointToView(...win.toLocal(x, Y));
      for (const j of bakeMod.rebakeChangedJobs(win.baked, win.view.bakeable().lights, { shape: { band: 16, rows: 64, merge: true }, ...(ENTRARNEAR ? { near: { x: nx, y: ny } } : {}) })) timed.push(j);
    }
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
      const g = giros[giros.length - 1];
      if (g && g.cambio < 0) { g.cambio = performance.now(); g.nucleo = { ...win.lastTurn, copyMs: Math.round(win.lastTurn.copyMs), jobMs: Object.fromEntries(Object.entries(win.lastTurn.jobMs).map(([k, v]) => [k, Math.round(v)])) }; }
    }
    { const g = giros[giros.length - 1]; if (g && g.cambio >= 0 && g.resto < 0 && !win.turning) g.resto = performance.now(); }
    // El fundido: a negro mientras se hace el núcleo, y de vuelta al cambiar (150 ms cada uno)
    fade = win.turning?.phase === 'core' ? Math.max(0, fade - dt / 0.15) : Math.min(1, fade + dt / 0.15);
    canvas.style.opacity = fade.toFixed(2);
    // (el giro se cuenta hasta acabar el fundido de vuelta: la subida del horneado nuevo va en ese tramo)
    if (swapMs >= 0 && fade >= 1) { turns.push({ ms: +swapMs.toFixed(0), frames: turnFrames, over25: turnOver, worst: +turnWorst.toFixed(1) }); turnAt = -1; swapMs = -1; }
    // La vista, centrada en MAIA (en los ejes del giro de ahora)
    const [vx, vy] = win.view.camera.pointToView(lx, ly);
    const [px, py] = win.baked.cam.project(vx, vy, ground(x, Y));
    const o: Frame2DOptions = { vx: Math.max(0, Math.min(win.baked.width - VW, Math.round(px) - VW / 2)), vy: Math.max(0, Math.min(win.baked.height - VH, Math.round(py) - VH / 2)), vw: VW, vh: VH, time: CAPTURA || ENTRAR ? 0 : (now - start) / 1000, lights: true, ambient: [0.8, 0.8, 0.85], cave: [0.2, 0.2, 0.25] };
    // ?seccion=N: el corte de una caja de N vóxeles de ancho alrededor de MAIA, desde sus pies (lo de delante, bajo tierra),
    // pintado por franjas (SectionPainter, uno por horneado) en la cola; se cuentan los cuadros con la caja sin pintar
    // del todo
    // (con ?entrar, la sección empieza al entrar, como en el juego al quedar bajo la superficie)
    if (SECCION && (!ENTRAR || entrada.a !== undefined)) {
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
      // (?seccionz=N: el suelo de la caja N vóxeles por debajo de los pies, como un corte bajo tierra)
      const cut = sectionAround(win.view.camera, lx, ly, ground(x, Y) - SECZ, SECCION);
      // (?cruz=N: la sección solo por una ventana en cruz de brazo N, y ?radio=R, 40, alrededor del cuerpo; ?borde=G: con
      // su borde dibujado de G píxeles, del color de ?bordecolor=rrggbb)
      if (CRUZ) { const [vx, vy] = win.view.camera.pointToView(lx, ly), [wx, wy] = win.baked.cam.project(vx, vy, ground(x, Y) + 8); cut.window = crossWindow(wx, wy, { arm: CRUZ, r: RADIO, border: BORDE ? { color: `#${q.get('bordecolor') ?? 'ffd666'}`, width: BORDE } : null }); }
      // (?velo=A: lo de la sección desde ?veloz=N vóxeles (8) por encima del suelo de la caja, semitransparente con alpha A;
      // ?velocaras=1: con keepFacing. La z del velo cambia con cada escalón, como el suelo de la caja)
      if (VELO !== null) cut.ghost = { z: cut.zMin + VELOZ, alpha: VELO, ...(VELOCARAS ? { keepFacing: true } : {}) };
      painter.set(cut, dir);
      const pj = painter.job();
      if (pj) timed.push(pj);
      o.sectionLayer = painter.layer();
      veloMax = Math.max(veloMax, o.sectionLayer?.ghost?.count ?? 0);
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
    // La vara de un juego: el anillo tx ± 3, ty - 3 .. + 5 alrededor del trozo de MAIA
    // (y por qué: algún trozo del anillo fuera de la ventana, o dentro sin escribir; y dónde va MAIA en la ventana)
    { const [mtx, mty] = win.trozoOf(x, Y); let r = false, out = false, unl = false;
      for (let ty = mty - 3; ty <= mty + 5; ty++) for (let tx = mtx - 3; tx <= mtx + 3; tx++) if (!win.isLoaded([tx, ty])) { r = true; if (tx < win.tx0 || tx >= win.tx0 + NXW || ty < win.ty0 || ty >= win.ty0 + NYW) out = true; else unl = true; }
      if (r) ringHoles++; if (out) ringOut++; if (unl) ringUnloaded++;
      const ix = mtx - win.tx0; posHist[ix] = (posHist[ix] ?? 0) + 1; }
    const t4 = performance.now();
    // (con el worker: dónde está la vista, para que pinte primero lo de cerca; y si lo que se ve tiene algún recuadro
    // pendiente, la puerta del 6x)
    motor?.frame();
    if (hornero && (Math.abs(o.vx - lastView[0]) > 8 || Math.abs(o.vy - lastView[1]) > 8)) { lastView = [o.vx, o.vy]; hornero.postMessage({ kind: 'view', x: o.vx + VW / 2, y: o.vy + VH / 2 }); }
    if (motor && now - start >= nextLinea) {
      nextLinea += 1000;
      const st = motor.stats, rs = win.baked.remoteStats;
      linea.push({ s: Math.round((now - start) / 1000), asked: st.asked, skies: st.skies, got: st.got, skipped: st.skipped, skShift: st.skippedShift, out: motor.outstanding,
        busy: win.baked.rectsBusy?.size ?? 0, tandas: win.baked.rebakeBatches?.size ?? 0, cola: budget.pending, reask: rs?.reasked ?? 0, skyReask: rs?.skyReasked ?? 0,
        cambiados: win.baked.source.changedSince(win.baked.version).length });
    }
    for (const k of win.baked.rectsBusy?.keys() ?? []) {
      const [x0, y0, x1, y1] = k.slice(5).split(',').map(Number) as [number, number, number, number];
      if (x1 >= o.vx && x0 < o.vx + VW && y1 >= o.vy && y0 < o.vy + VH) { viewPending++; break; }
    }
    // ?prewarm=1: los 8 cuadros de andar de MAIA, a este y oeste, precalentados la primera vez (como el juego)
    if (!boot.primerCuadro) boot.primerPaso = Math.round(performance.now());
    if (PREWARM && !warmed) { compositor.prewarm(win.baked, o, walk.map((m) => ({ model: m, yaws: [90, 270], casts: true }))); warmed = true; boot.prewarm = Math.round(performance.now()); }
    if (CLIMA.size) {
      const tick = Math.round((now - start) * 0.06);
      o.weather = { weather: meteo, tick, origin: [win.tx0 * T, win.ty0 * T], camera: win.view.camera, sway: CLIMA.has('viento') ? 1 : 0, waves: CLIMA.has('agua') ? 1 : 0, fall: CLIMA.has('cae') ? {} : null, solid: win.store, cover: CLIMA.has('suelo'), sunlight: CLIMA.has('sol') ? daySun(0.4) : null };
    }
    compositor.frame(win.view.frame(), win.baked, o);
    if (water && frames.length > 60) {
      agua.copia.push((win.view.water as unknown as { visited?: number } | null)?.visited ?? 0);
      // ?aguacheck=N: la textura del fondo del agua de la GPU contra la vista (lo que acaba de pintar)
      if (AGUACHECK && frameNo % AGUACHECK === 0) {
        const tex = compositor.readWaterStatic(), vw = win.view.water;
        if (tex && vw) {
          agua.checks++;
          let bad = 0;
          for (let i = 0; i < vw.gw * vw.gh; i++) if (tex[i * 4] !== vw.sim.ground[i] || tex[i * 4 + 1] !== vw.sim.solid[i] || tex[i * 4 + 2] !== (vw.isBasin(i) ? 1 : 0)) { if (!bad && !agua.primeraMala) agua.primeraMala = `celda ${i % vw.gw},${Math.floor(i / vw.gw)}: gpu ${tex[i * 4]},${tex[i * 4 + 1]},${tex[i * 4 + 2]} vista ${vw.sim.ground[i]},${vw.sim.solid[i]},${vw.isBasin(i) ? 1 : 0} (cuadro ${frameNo})`; bad++; }
          if (bad) agua.malas++;
        }
      }
    }
    // ?negro=N: cada N s, lo que se ve reducido a 64 x 36 y la fracción de píxeles casi negros (ningún canal > 25), con lo
    // marcado como cambiado sin rehornear, la cola y los corrimientos (la pantalla negra andando a 6x)
    if (NEGRO && now - start >= nextNegro) {
      nextNegro += NEGRO * 1000;
      const sc = (negroCanvas ??= Object.assign(document.createElement('canvas'), { width: 64, height: 36 })), cx = sc.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(compositor.canvas, 0, 0, 64, 36);
      const px = cx.getImageData(0, 0, 64, 36).data;
      let dark = 0;
      // (casi negro: ningún canal pasa de 25; el fondo de viva sin nada es (13, 12, 18))
      for (let i = 0; i < px.length; i += 4) if (Math.max(px[i]!, px[i + 1]!, px[i + 2]!) < 25) dark++;
      negro.push({ s: Math.round((now - start) / 1000), negro: +(dark / (64 * 36)).toFixed(3), cambiados: win.baked.source.changedSince(win.baked.version).length, cola: budget.pending, corrimientos: shifts, ocupada: win.busy ? 1 : 0, ...(() => { const w = win as unknown as { loading: unknown[]; loadJob: unknown; shiftJobs: unknown; storeShift: unknown }; return { muertos: (budget as unknown as { dropped?: number }).dropped ?? -1, publicados: win.baked.published.serial, porEscribir: w.loading?.length ?? -1, cargando: w.loadJob ? 1 : 0, corriendo: w.shiftJobs ? 1 : 0, almacen: w.storeShift ? 1 : 0 }; })(), vista: (() => { const b = win.baked; let e = 0, n = 0; for (let y = o.vy; y < o.vy + VH; y += 4) for (let x = o.vx; x < o.vx + VW; x += 4) { n++; if (b.face[y * b.width + x]! < 0) e++; } return +(e / n).toFixed(3); })(), vacio: (() => { const b = win.baked; let e = 0; for (let x = 0; x < b.width; x += 8) for (let y = 0; y < b.height; y += 8) if (b.face[y * b.width + x]! < 0) e++; return +(e / (Math.ceil(b.width / 8) * Math.ceil(b.height / 8))).toFixed(3); })() });
    }
    if (!boot.primerCuadro) boot.primerCuadro = Math.round(performance.now());
    // Cuadros (uno de cada 5) con algo de la pantalla en trozos de vóxeles aún por rehornear (cambiados desde el horneado):
    // lo que se vería a medio hacer
    if (frameNo % 5 === 0) {
      const ch = win.baked.source.changedSince(win.baked.version);
      if (ch.length) {
        const vis = bakeMod.chunksInScreen(win.baked, { x0: o.vx, y0: o.vy, x1: o.vx + VW - 1, y1: o.vy + VH - 1 });
        const set2 = new Set(ch);
        if (vis.some((c) => set2.has(c))) { sinHornear++; if (sinHornearPrimero < 0) sinHornearPrimero = Math.round((now - start) / 100) / 10; }
        muestras++;
      } else muestras++;
    }
    if (ENTRAR && entrada.a !== undefined) {
      // (lo que queda en la cola del corte y de su rehorneado)
      const qk = (budget as unknown as { queue: ViewJob[] }).queue.map((j) => j.key);
      const left = qk.filter((k) => k === 'view-cut' || k.startsWith('rect:') || k.startsWith('sky:'));
      const changed = win.baked.source.changedSince(win.baked.version).length;
      const ms = now - entrada.a;
      if (entrada.corteMs === undefined && !qk.includes('view-cut')) entrada.corteMs = Math.round(ms);
      if (SECCION && entrada.seccionMs === undefined && painter?.ready()) entrada.seccionMs = Math.round(ms);
      if (entrada.abiertoMs === undefined && !left.length && !changed) entrada.abiertoMs = Math.round(ms);
      if (!entrada.c800 && ms >= 800) {
        entrada.cola800 = (budget as unknown as { queue: ViewJob[] }).queue.slice(0, 30).map((j) => `${j.key}|${j.priority === undefined ? '-' : +j.priority.toFixed(1)}${j.waiting?.() ? '|espera' : ''}`); entrada.c800 = canvas.toDataURL('image/png'); entrada.rects800 = left.length + changed; entrada.pendientes800 = qk.slice(0, 30); }
      else if (entrada.c800 && !entrada.final && !win.busy && !budget.pending) { entrada.final = canvas.toDataURL('image/png'); entrada.finalMs = Math.round(ms); }
    }
    // ?nucleo=1 (con ?quieto=1): el primer cuadro y el mismo cuadro con la cola vacía (todo horneado), para compararlos
    if (CAPTURA) {
      if (!captura.primero) captura.primero = canvas.toDataURL('image/png');
      else if (!captura.final && frames.length > 60 && !win.busy && !budget.pending) { captura.final = canvas.toDataURL('image/png'); captura.finalA = Math.round((now - start) / 1000 * 10) / 10; }
    }
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
    if (ENTRAR && prevPhases && prevExtra) {
      const rel = entrada.a === undefined ? now - start - ENTRAR * 1000 : now - entrada.a;
      const w = rel >= -4000 && rel < 0 ? 'antes' : rel >= 0 && rel < 4000 ? 'tras' : null;
      const iv = frames[frames.length - 1]!;
      if (w) ventanas[w].push({ iv: +iv.toFixed(1), ...prevPhases, paso: +prevPaso.toFixed(1), fuera: +(iv - prevPaso).toFixed(1), ...prevExtra });
    }
    {
      const pb = win.baked.published;
      if (pubOf !== win.baked) { pubOf = win.baked; pubSeen = pb.serial; }
      let rects = 0, px = 0;
      for (const r of pb.rects) if (r.serial > pubSeen) { rects++; px += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1); }
      const sky = pb.rects.filter((r) => r.serial > pubSeen && r.sky).length;
      pubSeen = pb.serial;
      const m = mem(), gc = heapSeen - m > 2e6 ? 1 : 0;
      heapSeen = m;
      prevExtra = { rects, sky, kpx: +(px / 1000).toFixed(1), gc, heapMB: +(m / 1e6).toFixed(1) };
    }
    prevPhases = { update: +(t1 - t0).toFixed(1), caminos: +(b0 - t1).toFixed(1), cola: +(t2 - b0).toFixed(1), mover: +(t3 - t2).toFixed(1), resto: +(t4 - t3).toFixed(1), componer: +(t5 - t4).toFixed(1), captura: +(t7 - t6).toFixed(1) };
    // Todas las fases de todos los cuadros (tras los 60 primeros), y lo que se lleva cada parte del compositor de la GPU
    if (frames.length > 60) {
      for (const [k, v] of Object.entries(prevPhases)) (fases[k] ??= []).push(v);
      const parts = (compositor.stats as { parts?: Record<string, number> }).parts;
      if (parts) for (const [k, v] of Object.entries(parts)) (fases['gpu.' + k] ??= []).push(v);
      (fases['gpu.frame'] ??= []).push(compositor.stats.frameMs);
    }
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
      linea, giros: giros.map((g, i) => {
        const fin = giros[i + 1]?.tecla ?? Infinity, ms = (t: number) => t < 0 ? null : Math.round(t - g.tecla);
        const e = motor?.mirrorLog.find((l) => l.at >= g.tecla && l.at < fin);
        return { cambio: ms(g.cambio), resto: ms(g.resto), nucleo: g.nucleo, ...(e ? { espejo: ms(e.at), pedido: ms(e.firstAsk), trozos: e.chunksFirst, syncMs: Math.round(e.syncMsFirst), llega: ms(e.firstGot), worker: e.worker ? Object.fromEntries(Object.entries(e.worker).map(([k, v]) => [k, Math.round(v as number)])) : null } : {}) };
      }), remote: WORKER ? { ...remote, workerMs: Math.round(remote.workerMs), busyMs: Math.round(remote.busyMs), main: win.baked.remoteStats ?? null } : motor ? { motor: { ...motor.stats, workerMs: Math.round(motor.stats.workerMs), syncMs: Math.round(motor.stats.syncMs) }, main: win.baked.remoteStats ?? null } : null,
      vistaSinHornear: { muestras, conPendiente: sinHornear, primeroA: sinHornearPrimero },
      entrada: ENTRAR ? { corteMs: entrada.corteMs ?? null, seccionMs: entrada.seccionMs ?? null, abiertoMs: entrada.abiertoMs ?? null, finalMs: entrada.finalMs ?? null, rects800: entrada.rects800 ?? null, pendientes800: entrada.pendientes800 ?? null, cola800: entrada.cola800 ?? null, iguales: !!entrada.final && entrada.c800 === entrada.final, c800: entrada.c800 ?? null, final: entrada.final ?? null } : null,
      captura: CAPTURA ? { iguales: !!captura.final && captura.primero === captura.final, finalA: captura.finalA ?? null, primero: captura.primero ?? null, final: captura.final ?? null } : null,
      arranque: { ...boot, ventanaPorDentro: win.startup, horneado: win.baked.ms }, adelantados: budget.starvedRuns, cielo: win.baked.skyStats ? { ...win.baked.skyStats, ms: Math.round(win.baked.skyStats.ms) } : null, viewPending, seccion: SECCION ? { frames: secFrames, sinPintar: secUnready, pct: +(100 * secUnready / Math.max(1, secFrames)).toFixed(1), pintadas: painter?.painted ?? 0, velo: veloMax, avances: secMoves, tiradas: painter?.resets ?? 0, porque: secWhy, rachas: { n: secRuns.length, max: Math.max(0, ...secRuns), media: +(secRuns.reduce((a, r) => a + r, 0) / Math.max(1, secRuns.length)).toFixed(2), p95: [...secRuns].sort((a, r) => a - r)[Math.floor(0.95 * Math.max(0, secRuns.length - 1))] ?? 0, hist: secRuns.reduce((h: Record<string, number>, r) => { const k = r <= 2 ? '1-2' : r <= 5 ? '3-5' : r <= 10 ? '6-10' : '>10'; h[k] = (h[k] ?? 0) + 1; return h; }, {}) } } : null, over25By, uploads, slowCompose: { n: slowCompose.length, primeros: slowCompose.slice(0, 20) }, worst, esperas: esperas.slice(0, 20), ringHoles, ringOut, ringUnloaded, posHist, negro, queueByKind: Object.fromEntries([...byKind].map(([k, v]) => [k, { ms: Math.round(v.ms), calls: v.calls }])),
      over25perMin: +(f.filter((v) => v > 25).length / (SECONDS / 60)).toFixed(1), shifts, holes,
      fases: Object.fromEntries(Object.entries(fases).map(([k, v]) => [k, { m: +avg(v).toFixed(2), p95: pq(v, 0.95) }])),
      agua: water ? {
        pasoMs: { p50: pq(agua.pasoMs, 0.5), p95: pq(agua.pasoMs, 0.95), max: pq(agua.pasoMs, 1) },
        activas: { p50: pq(agua.activas, 0.5), p95: pq(agua.activas, 0.95), max: pq(agua.activas, 1) },
        copia: { p50: pq(agua.copia, 0.5), p95: pq(agua.copia, 0.95), max: pq(agua.copia, 1) },
        gpu: compositor.waterStats(), pisotones: agua.pisotones, checks: agua.checks, malas: agua.malas, primeraMala: agua.primeraMala,
        volumen: Math.round(water.sim.totalVolume()), celdas: water.gw * water.gh, guardados: aguaSaved.size,
      } : null,
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
      ventanas: ENTRAR ? Object.fromEntries((['antes', 'tras'] as const).map((w) => {
        const a = ventanas[w];
        if (!a.length) return [w, null];
        const keys = Object.keys(a[0]!), stat: Record<string, unknown> = { n: a.length, over25: a.filter((r) => r.iv! > 25).length };
        for (const k of keys) {
          const v = a.map((r) => r[k] ?? 0);
          stat[k] = ['rects', 'sky', 'kpx', 'gc'].includes(k) ? +v.reduce((u, z) => u + z, 0).toFixed(1) : k === 'heapMB' ? [Math.min(...v), Math.max(...v)] : { m: +avg(v).toFixed(2), p90: pq(v, 0.9), max: pq(v, 1) };
        }
        // (los cuadros de más de 25 ms, por la fase que más pesó)
        const by: Record<string, number> = {};
        for (const r of a) if (r.iv! > 25) { const top = ['update', 'cola', 'resto', 'componer', 'fuera', 'captura'].map((k) => [k, r[k] ?? 0] as const).sort((u, v) => v[1] - u[1])[0]![0]; by[top] = (by[top] ?? 0) + 1; }
        stat.over25By = by;
        return [w, stat];
      })) : null,
    };
  }
  function state_move(lx: number, ly: number): void {
    win.state.entities.move(id, lx, ly, ground(x, Y), dir > 0 ? 90 : 270);
    win.state.entities.setModel(id, CAPTURA ? walk[0]! : walk[Math.floor(performance.now() / WALK_FRAME_MS) % 8]!);
    if (water && FOCO) water.setFocus(lx, ly, FOCO);
    if (water && ORILLA) {
      const wet = water.depthAt(lx, ly) > 0.3;
      if (wet && !agua.mojado) { win.state.events.disturb(lx, ly, 2.8, 3); agua.pisotones++; }
      agua.mojado = wet;
    }
    // ?pisar=N: un pisotón en el agua más cercana al personaje (en espiral de 4 en 4 vóxeles, hasta 64)
    if (water && PISAR && frameNo % PISAR === 0) {
      let hit: [number, number] | null = null;
      for (let r = 0; r <= 64 && !hit; r += 4) for (let a = 0; a < 16 && !hit; a++) {
        const wx = lx + Math.round(Math.cos((a / 16) * Math.PI * 2) * r), wy = ly + Math.round(Math.sin((a / 16) * Math.PI * 2) * r);
        if (water.depthAt(wx, wy) > 1) hit = [wx, wy];
      }
      if (hit) { win.state.events.disturb(hit[0], hit[1], 2.8, 3); agua.pisotones++; }
    }
    const a0 = performance.now();
    win.state.step();
    if (water && frames.length > 60) { agua.pasoMs.push(performance.now() - a0); agua.activas.push(water.sim.activeCount); }
  }
  const agua = { mojado: false, pasoMs: [] as number[], activas: [] as number[], copia: [] as number[], pisotones: 0, checks: 0, malas: 0, primeraMala: null as null | string };
  boot.antesDelPrimerRaf = Math.round(performance.now());
  requestAnimationFrame(loop);
})();
