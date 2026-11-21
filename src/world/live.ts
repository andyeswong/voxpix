// LA VENTANA VIVA (NARUTO, fase 4, 3a): un mundo sin bordes alrededor de un objetivo. Una ventana de nx x ny trozos
// (cada uno de `chunk` x `chunk` bloques del set) se genera por regiones (regiongen.ts), se escribe de una vez por trozo
// (BlockGrid.stampRegionJob), se hornea, y se corre cuando el objetivo se acerca a un borde (shiftBakedJob: la imagen y
// los vóxeles por pasos en la cola, sin copiar ni rehornear lo que se queda). Todo el trabajo va a la FrameBudget de la
// vista: nunca un trozo entero en un cuadro si no cabe.
//
// Dos marcos de coordenadas: las del MUNDO (sin tope, también negativas: el trozo (tx, ty) empieza en tx * T, ty * T
// vóxeles) y las LOCALES del WorldState de la ventana (state, grid, baked: la esquina de la ventana en (0, 0)). toLocal /
// toWorld pasan de unas a otras. Al correrse la ventana, las entidades, las luces, las gotas, lo que flota y los efectos
// del state se corren con ella (sus coordenadas locales cambian; las del mundo no).
//
// El juego:
// - fill(t, ctx) (opcional): escribe él el trozo t que entra (lo generado y sus diferencias guardadas, hornos, cofres...)
//   y devuelve un trabajo de la cola (o nada, si lo hizo ya). Sin fill, LiveWindow lo genera (generateRegion), lo escribe
//   (stampRegionJob) y llama a onLoad(t, ctx). Lo uno o lo otro va ANTES de hornear el trozo.
// - onUnload(t, ctx): el trozo t sale; aún está en la rejilla (ctx.read, ctx.cell), para guardar sus diferencias y
//   quitar sus entidades. Se llama antes de correr nada.
// - onShift({ cells, voxels }): el origen local se corrió: lo que estaba en la x local pasa a x - voxels[0] (y en celdas,
//   bx - cells[0]); igual en y. Las entidades, las luces, las gotas, lo que flota y los efectos del state ya van corridos
//   (WorldState.shiftDynamic); lo demás que guarde el juego en
//   coordenadas locales (cuerpos, listas por celda, la cámara, el corte), lo corre él aquí.
// Todo lo de ctx va en coordenadas del MUNDO (vóxeles y celdas); ctx.grid y ctx.at (la celda local de la esquina del
// trozo) por si hace falta ir directo a la rejilla.
//
// Los giros (opts.quarters): cada giro pedido tiene su vista (WorldView, con su copia girada) y su horneado, y todos se
// tienen al día: al correrse, cada uno corre su imagen (en sus ejes: dirToView) y el cambio es de todos a la vez; lo que
// entra se rehornea en todos. turn(q) cambia de giro sin esperar (como la caché de giros del juego): win.view y
// win.baked pasan a ser los de q (hay que volver a subir el horneado a la GPU). El giro 0 siempre está (su vista es el
// mundo, sin copia). Lo que cambia el juego (picar) lo rehornea él en el giro de ahora (rebakeChangedJobs con near,
// como siempre); en los demás lo rehornea update.
//
// GIRAR CON FUNDIDO (turnTo): solo vive el giro de ahora (más los de opts.quarters, que siguen como arriba). Al pedir
// otro, su vista se hace por pasos en la cola y el juego tapa la espera con un fundido (turning.phase === 'core'):
//   1) lo visible primero: la copia girada de los trozos de vóxeles que caen en el recuadro de pantalla alrededor del
//      objetivo (opts.viewport, con margen; sin viewport, todo), y uno más alrededor (lo que miran la oclusión y el
//      cielo), y su horneado por recuadros sobre una imagen vacía (rebakeJobs: lo mismo, byte a byte, que el horneado
//      entero). Va con prioridad 0 (el presupuesto cercano de la FrameBudget);
//   2) el cambio: win.view y win.baked pasan a ser los del giro nuevo (hay que subir el horneado entero a la GPU) y el de
//      antes se suelta;
//   3) turning.phase === 'rest': la copia de lo demás, que queda marcado como cambiado (StaticVoxels.touch) y lo rehornea
//      la cola de siempre (update y el rehorneado del juego), como un trozo que entra.
// Mientras se gira no se corre la ventana, y durante el núcleo no se empieza a escribir ningún trozo. Pedir otro giro
// durante el fundido cambia el destino (lo hecho se tira; volver al de ahora lo cancela); después del cambio empieza
// otro giro. turnTarget es el giro al que se va (para sumarle Q / E).
import type { Palette } from '../core';
import { StaticVoxels, WorldState, CHUNK, type PreparedSlab } from './state';
import { BlockGrid, type BlockSet } from './blocks';
import type { Yaw } from './edit';
import { generateRegion, type RegionSpec, type GeneratedRegion } from './regiongen';
import { bakeWorld, bakeWorldJob, shiftBakedJob, rebakeJobs, rebakeChangedJobs, cancelRebakes, chunksInScreen, wrapJob, type RemoteRects, SKY_RAYS, LIGHT_PRIORITY, type Baked, type ShiftJob, type ViewJob, type RebakeShape } from './bake';
import { WorldView, ViewCamera, type Quarter, type WorldViewOptions } from './view';
import type { WaterLayer } from './water';

export type Trozo = readonly [number, number];
// Lo que se engancha a la ventana para correrse con ella (attach)
export interface Attached {
  shift(dx: number, dy: number): void;
  shiftSources?(sources: ReadonlyArray<{ source: StaticVoxels; dcx: number; dcy: number }>): void;
}
// Lo que se le da al juego por trozo, en coordenadas del MUNDO
export interface TrozoCtx {
  grid: BlockGrid;
  at: readonly [number, number, number];                       // la celda local (de grid) de la esquina del trozo
  read(x: number, y: number, z: number): number;               // vóxel
  write(x: number, y: number, z: number, v: number): void;
  cell(bx: number, by: number, bz: number): [number, Yaw];     // [bloque, giro en grados]
  setCell(bx: number, by: number, bz: number, block: number, yaw?: Yaw): void;
  // En onLoad, si lo generó la ventana (o lo preparó prepareTrozo): la región generada, con lo que no se escribió (skip),
  // como el agua que va a un WaterLayer (regionWater)
  region?: GeneratedRegion;
}
export interface LiveWindowOptions {
  blocks: BlockSet;
  spec: RegionSpec;                    // el mundo (generateRegion); height en bloques
  nx: number; ny: number;              // trozos de la ventana
  chunk?: number;                      // bloques por lado de un trozo (16)
  center?: Trozo;                      // el trozo del mundo donde empieza el objetivo (la ventana, centrada en él)
  bake?: Parameters<typeof bakeWorld>[1];
  // Trozos que tiene que haber entre el del objetivo y el borde de la ventana; al quedar menos, se corre (2). O por lado:
  // { x, n, s } (este y oeste, norte (+y) y sur): lo visible de una vista oblicua llega más lejos al norte (lo alto de
  // allí sube a la imagen) que al sur
  margin?: number | { x: number; n: number; s: number };
  band?: number;                       // filas de la imagen por paso al correrla (shiftBakedJob)
  quarters?: readonly Quarter[];       // los giros que se tienen horneados (el 0 siempre; [0] por defecto)
  // Cómo se rehornea lo que entra (rebakeJobs): por defecto pasos de 16 columnas x 64 filas y un recuadro por tramo de
  // trozos (bench-viva, sin freno: de ~1020 a ~660 ms por trozo cruzado, y la llamada más larga de 8 a 5 ms)
  rebake?: RebakeShape;
  // Lo que se ve de la imagen (píxeles, ancho y alto, centrado en el objetivo como la cámara del juego): lo que turnTo
  // hornea antes del cambio. Sin él, la imagen entera
  viewport?: readonly [number, number];
  // Al construir, con viewport: hornear solo lo que se ve (el núcleo, como turnTo: los trozos de vóxeles que caen en el
  // recuadro de la pantalla alrededor de `target`, recortado a él) y dejar lo demás de la imagen para la cola (rehorneado
  // de siempre). El primer cuadro enseña lo mismo que con la imagen entera; el resto se hace sin verse. Lo que queda para la
  // cola es casi toda la imagen: con el mundo de FERN en 11 x 13, ~8700 trozos de vóxeles que tardan ~21 s a 1x en acabar
  // (por detrás, sin que se vean: andando no se llega a ver nada sin hacer). Un giro en ese tiempo hornea el giro nuevo
  // entero con turnTo, como siempre; lo que se queda a medias es la imagen del giro 0 fuera de la pantalla
  bakeFirst?: 'view';
  // Dónde está el objetivo al construir (coordenadas del mundo; por defecto el centro del trozo `center`): el núcleo de
  // bakeFirst y lo cercano de la carga
  target?: readonly [number, number];
  // La carga del principio: 'block' (por defecto), todos los trozos en el constructor; 'queue', la ventana vacía y los
  // trozos por la cola del centro hacia fuera, con prioridad 0 (el presupuesto cercano) y su rehorneado detrás, también
  // cercano, hasta que estén todos (ready() dice cuándo está lo de alrededor del objetivo: para una pantalla de carga que
  // avanza y un juego que empieza antes de tenerlo todo)
  preload?: 'block' | 'queue';
  // Lo que el juego hace con el horneado del giro nuevo antes de enseñarlo (turnTo), como trabajo por pasos que corre el
  // núcleo del giro tras sus recuadros y antes del cambio: subirlo a la GPU por partes (compositor.prepare). Así el
  // cuadro del cambio no lo sube entero (~100 ms con 11 x 13)
  beforeTurnSwap?(baked: Baked): { run(deadline: number): boolean } | null;
  // Las opciones de sus vistas (WorldView): { cut: true } para el corte de casa de muñecas (setCut / cutJob en win.view).
  // El corte se corre con la ventana (WorldView.shift, antes de onShift); un cutJob a medias sigue en la cola
  view?: WorldViewOptions;
  fill?(t: Trozo, ctx: TrozoCtx): { run(deadline: number): boolean } | void;
  // Escribir un trozo fuera (un worker que lo genera y lo estampa en su copia): pide el trozo t
  // para su sitio `at` (celda de la rejilla) y da un vale; result() trae sus celdas y sus trozos de vóxeles ya hechos
  // (los de writeChunkPrepared), y aquí solo se ponen. Sin fill; el constructor escribe aquí (no puede esperar)
  prepareTrozo?(t: Trozo, at: readonly [number, number]): { result(): PreparedTrozo | null };
  onUnload?(t: Trozo, ctx: TrozoCtx): void;
  // (puede devolver un trabajo por pasos, p. ej. WaterLayer.loadJob: la ventana lo corre dentro del del trozo, con su
  // plazo, antes de darlo por escrito y de hornearlo)
  onLoad?(t: Trozo, ctx: TrozoCtx): { run(deadline: number): boolean } | void;
  onShift?(d: { cells: readonly [number, number]; voxels: readonly [number, number] }): void;
  // Materiales de la región que no se escriben en la rejilla (el agua, si la simula un WaterLayer: se carga en onLoad con
  // regionWater(ctx.region, ...)). Un prepareTrozo del juego tiene que saltarse los mismos en sus vóxeles
  skip?: readonly number[];
}

export interface PreparedTrozo {
  cells: GeneratedRegion;
  chunks: Array<{ c: number; slabs: Array<PreparedSlab | null>; tops: Int16Array }>;
  local?: boolean;                     // no se pudo preparar (una losa con más de 256 valores): se estampa aquí
}

export class LiveWindow {
  readonly store: StaticVoxels;
  readonly state: WorldState;
  readonly grid: BlockGrid;
  // El giro de ahora, y por giro su vista y su horneado
  quarter: Quarter = 0;
  private readonly views = new Map<Quarter, { view: WorldView; baked: Baked }>();
  get view(): WorldView { return this.views.get(this.quarter)!.view; }
  get baked(): Baked { return this.views.get(this.quarter)!.baked; }
  get quarters(): Quarter[] { return [...this.views.keys()]; }
  viewOf(q: Quarter): { view: WorldView; baked: Baked } | undefined { return this.views.get(q); }
  readonly T: number;                  // vóxeles por lado de un trozo
  tx0: number; ty0: number;            // la esquina de la ventana (trozos del mundo)
  private readonly o: Required<Pick<LiveWindowOptions, 'band'>> & LiveWindowOptions;
  private readonly m: { x: number; n: number; s: number };
  private readonly C: number;          // bloques por lado de un trozo
  private shiftJobs: Array<{ q: Quarter; job: ShiftJob }> | null = null;
  private shiftJob: ViewJob | null = null;     // el que los lleva en la cola
  private shiftTo: Trozo | null = null;
  private loading: Trozo[] = [];       // los que entraron y faltan por escribir
  private loadJob: ViewJob | null = null;
  private loaded = new Set<string>();
  // Los giros que se tienen siempre (opts.quarters); los demás, solo mientras son el de ahora
  private readonly live: Set<Quarter>;
  // El objetivo del último update (mundo)
  private at: [number, number] = [0, 0];
  // El giro en marcha (turnTo): el núcleo antes del cambio (job: null hasta que se pueda empezar) y lo demás después
  private turnPrep: { q: Quarter; job: ViewJob | null } | null = null;
  // (el núcleo dejado a medias: lo que pidió fuera se cancela, para que nada lo espere ni guarde su horneado)
  private turnAbort: (() => void) | null = null;
  private turnRest: { q: Quarter; job: ViewJob } | null = null;

  constructor(opts: LiveWindowOptions) {
    this.o = { band: 32, ...opts };
    const mg = opts.margin ?? 2;
    this.m = typeof mg === 'number' ? { x: mg, n: mg, s: mg } : mg;
    if (opts.nx < 2 * this.m.x + 1 || opts.ny < this.m.n + this.m.s + 1) throw new Error(`LiveWindow: la ventana (${opts.nx} x ${opts.ny}) no cabe los márgenes (${JSON.stringify(this.m)}): hace falta ${2 * this.m.x + 1} x ${this.m.n + this.m.s + 1}`);
    this.live = new Set(opts.quarters ?? []);
    this.C = opts.chunk ?? 16;
    const B = opts.blocks.size;
    this.T = this.C * B;
    if (this.T % CHUNK) throw new Error(`LiveWindow: el trozo (${this.T} vóxeles) tiene que ser múltiplo de ${CHUNK}`);
    // (la del objetivo, a sus márgenes: centrada en x, y en y con el sur a m.s)
    const [cx, cy] = opts.center ?? [0, 0];
    this.tx0 = cx - Math.floor(opts.nx / 2); this.ty0 = cy - this.m.s - Math.floor((opts.ny - this.m.n - this.m.s - 1) / 2);
    this.store = new StaticVoxels(opts.blocks.palette as Palette, opts.nx * this.T, opts.ny * this.T, 0, opts.spec.height * B - 1);
    this.state = new WorldState(this.store, [], null);
    this.grid = new BlockGrid(this.state, opts.blocks);
    if (opts.preload === 'queue') {
      // Del trozo del objetivo hacia fuera (por la cola, en update)
      const all: Trozo[] = [];
      for (let ty = this.ty0; ty < this.ty0 + opts.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + opts.nx; tx++) all.push([tx, ty]);
      all.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy) || a[1] - b[1] || a[0] - b[0]);
      this.loading.push(...all);
      this.preloading = true;
      this.at = [(cx + 0.5) * this.T, (cy + 0.5) * this.T];
    } else {
      const t0 = performance.now();
      for (let ty = this.ty0; ty < this.ty0 + opts.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + opts.nx; tx++) {
        const job = this.loadTrozoJob([tx, ty]);
        while (!job.run(Infinity));
      }
      this.startup.loadMs = Math.round(performance.now() - t0);
    }
    const t1 = performance.now();
    if (opts.target) this.at = [opts.target[0], opts.target[1]];
    else if (!this.at[0] && !this.at[1]) this.at = [(cx + 0.5) * this.T, (cy + 0.5) * this.T];
    for (const q of new Set<Quarter>([0, ...(opts.quarters ?? [])])) {
      const view = new WorldView(this.state, q, opts.view ?? {});
      // (lo que se ve primero: el giro que se enseña, el 0; los demás de quarters, enteros)
      const baked = q === 0 && opts.bakeFirst === 'view' && opts.viewport && opts.preload !== 'queue' ? this.bakeCore(view) : bakeWorld(view.bakeable(), { topZ: this.store.zMax + 1, ...(opts.bake ?? {}) });
      this.views.set(q, { view, baked });
    }
    this.startup.bakeMs = Math.round(performance.now() - t1);
  }
  // (para medir) lo que costó el constructor: escribir los trozos (sin preload por la cola) y hornear las vistas; con
  // bakeFirst, los trozos de vóxeles del núcleo y los que quedan para la cola
  readonly startup = { loadMs: 0, bakeMs: 0, core: 0, rest: 0 };

  // bakeFirst: la imagen vacía (sin profundidad y con todo el cielo, como el fondo del horneado entero), lo que cae en el
  // recuadro de la pantalla alrededor del objetivo horneado de una vez y recortado a él, y lo demás marcado como cambiado
  // para el rehorneado de la cola. Lo mismo que el núcleo de turnTo, sin copia (el giro 0) y sin repartirlo en cuadros
  private bakeCore(view: WorldView): Baked {
    const src = this.store, vs = view.static, n = vs.cols * vs.rows, vp = this.o.viewport!, cam = view.camera;
    const baked = bakeWorldJob(view.bakeable(), { topZ: src.zMax + 1, ...(this.o.bake ?? {}) }, 'bake:g0').baked;
    baked.depth.fill(Infinity);
    baked.sky?.fill(SKY_RAYS);
    const boxesOf = (cs: Iterable<number>) => {
      const out = new Map<number, { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }>();
      for (const c of cs) {
        const X = (c % vs.cols) * CHUNK, Y = Math.floor(c / vs.cols) * CHUNK;
        let top = vs.zMin;
        for (let y = Y; y < Math.min(vs.depth, Y + CHUNK); y++) for (let x = X; x < Math.min(vs.width, X + CHUNK); x++) top = Math.max(top, vs.height[y * vs.width + x]!);
        out.set(c, { x0: X, y0: Y, z0: vs.zMin, x1: X + CHUNK - 1, y1: Y + CHUNK - 1, z1: Math.max(vs.zMin, top - 1) });
      }
      return out;
    };
    const [lx, ly] = this.toLocal(this.at[0], this.at[1]), [vx, vy] = cam.pointToView(lx, ly);
    const hx = Math.max(0, Math.min(vs.width - 1, Math.floor(vx))), hy = Math.max(0, Math.min(vs.depth - 1, Math.floor(vy)));
    const [px, py] = baked.cam.project(vx, vy, vs.height[hy * vs.width + hx]!);
    const M = 16, x0 = Math.max(0, Math.min(baked.width - vp[0], Math.round(px) - vp[0] / 2)), y0 = Math.max(0, Math.min(baked.height - vp[1], Math.round(py) - vp[1] / 2));
    const clip = { x0: x0 - M, y0: y0 - M, x1: x0 + vp[0] - 1 + M, y1: y0 + vp[1] - 1 + M };
    const near = chunksInScreen(baked, clip), nearSet = new Set(near);
    const hit = chunksInScreen(baked, clip, boxesOf(near)).filter((c) => nearSet.has(c));
    let cx0 = Infinity, cy0 = Infinity, cx1 = -1, cy1 = -1;
    for (const c of hit) { const cx = c % vs.cols, cy = Math.floor(c / vs.cols); cx0 = Math.min(cx0, cx); cy0 = Math.min(cy0, cy); cx1 = Math.max(cx1, cx); cy1 = Math.max(cy1, cy); }
    const core: number[] = [];
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) core.push(cy * vs.cols + cx);
    vs.cut();
    const V1 = vs.clock;
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
    for (const c of core) { const x = (c % vs.cols) * CHUNK, y = Math.floor(c / vs.cols) * CHUNK; X0 = Math.min(X0, x); Y0 = Math.min(Y0, y); X1 = Math.max(X1, x + CHUNK); Y1 = Math.max(Y1, y + CHUNK); }
    const R = 64, lights = view.lights.filter((l) => l.x > X0 - R && l.x < X1 + R && l.y > Y0 - R && l.y < Y1 + R);
    const boxes = boxesOf(core);
    for (const j of rebakeJobs(baked, core, lights, boxes, this.o.rebake ?? { band: 16, rows: 64, merge: true }, clip)) while (!j.run(Infinity));
    // Lo que queda fuera (o en el borde del recorte: su contorno puede quedar mal), para la cola
    const inCore = new Set(chunksInScreen(baked, { x0: clip.x0 + 2, y0: clip.y0 + 2, x1: clip.x1 - 2, y1: clip.y1 - 2 }, boxes, true).filter((c) => core.includes(c)));
    baked.version = V1;
    let rest = 0;
    for (let c = 0; c < n; c++) if (!inCore.has(c)) { vs.touch(c); rest++; }
    this.pendingRebake = true;
    this.startup.core = inCore.size; this.startup.rest = rest;
    return baked;
  }

  /**
   * Cambia al giro q, ya horneado y al día (uno de `quarters`, o el 0): view y baked pasan a ser los suyos, sin esperar.
   *
   * Qué vistas quedan vivas (con su horneado y su copia, y rehorneadas en cada carga):
   * - Al construir: la del giro 0 y las de `quarters`.
   * - Tras turn(q) o turnTo(q): la de q y las de `quarters`; la que se enseñaba, si no está en `quarters`, se suelta (su
   *   rehorneado en la cola acaba sin hacer nada). Así, sin `quarters` (o sin el 0 en ella) solo vive la del giro de ahora;
   *   con `quarters: [0, 1, 2, 3]`, las cuatro siempre.
   * - turnTo(q) con q sin hornear la hace por pasos (núcleo, fundido, lo demás) y suelta la de antes en el cambio.
   * Antes turn() no soltaba nada: con `quarters: [1]` y turn(1) quedaban vivas la del 0 y la del 1, y cada carga
   * rehorneaba las dos (el doble de trabajo tras un salto).
   */
  turn(q: Quarter): void {
    if (!this.views.has(q)) throw new Error(`LiveWindow: el giro ${q} no está horneado (quarters: ${this.quarters.join(', ')})`);
    const old = this.quarter;
    this.quarter = q;
    if (old === q || this.live.has(old)) { this.applyRemote(); return; }
    const v = this.views.get(old);
    this.views.delete(old);
    if (v) cancelRebakes(v.baked);
    this.applyRemote(v?.baked);
    // Un corrimiento a medias: el de la vista que se soltó sobra, y los vóxeles del mundo los corre el giro 0 si sigue o,
    // si no, aparte (como en el cambio de turnTo)
    if (this.shiftJobs) {
      const [dx, dy] = this.shiftDir;
      this.shiftJobs = this.shiftJobs.filter((sj) => this.views.has(sj.q));
      if (this.worldViewed()) this.storeShift = null;
      else if (!this.storeShift) { const k = this.T / CHUNK; this.storeShift = { job: this.store.shiftJob(dx * k, dy * k), ready: false }; }
    }
  }

  // Engancha algo que va en coordenadas locales y sabe correrse (PathField, LevelPathField): en el cambio de cada
  // corrimiento, x.shift(dx, dy) con los vóxeles que se corrió (lo de x pasa a x - dx), antes de onShift. Devuelve con qué
  // soltarlo
  // (shiftSources, opcional: además, en el mismo momento, cada horneado vivo con lo que se corrió su fuente en trozos de
  // vóxeles, en sus ejes: quien guarda una copia de esas fuentes, como BakeWorker, la corre igual)
  attach(x: Attached): () => void {
    this.attached.add(x);
    return () => { this.attached.delete(x); };
  }
  private readonly attached = new Set<Attached>();

  // El agua de la ventana (un WaterLayer movable, creado sobre win.store después de la ventana: necesita sus vóxeles): la
  // pone en el state, la engancha (se corre con la ventana) y las vistas la toman. Los trozos ya cargados los carga el
  // juego (water.load), como en onLoad. null la quita
  setWater(water: WaterLayer | null): void {
    if (water && !water.movable) throw new Error('LiveWindow.setWater: la capa tiene que ser movable (WaterOptions.movable)');
    const old = this.state.water;
    if (old) this.attached.delete(old);
    this.state.water = water;
    if (water) this.attached.add(water);
    for (const { view } of this.views.values()) view.useWater();
  }

  // Quien pinta fuera los recuadros (Baked.remote): la ventana lo pone en el horneado del giro que se ve y lo quita de los
  // demás, también al girar (turn, y en el cambio de turnTo). null lo quita de todos
  // (urgent: el núcleo de un giro con fundido, que aún no se ve y la pantalla espera en negro: va antes que lo demás)
  setRemote(remote: ((b: Baked, o?: { urgent: boolean }) => RemoteRects | null) | null): void { this.remoteFor = remote; this.applyRemote(); }
  private remoteFor: ((b: Baked, o?: { urgent: boolean }) => RemoteRects | null) | null = null;
  private applyRemote(released?: Baked): void {
    if (released) delete released.remote;
    for (const [q, { baked }] of this.views) {
      const r = q === this.quarter && this.remoteFor ? this.remoteFor(baked) : null;
      if (r) baked.remote = r; else delete baked.remote;
    }
  }

  // Pide girar a q con fundido (ver arriba). Si q se tiene siempre (opts.quarters), es turn(q), sin esperar
  turnTo(q: Quarter): void {
    if (this.turnPrep) { if (this.turnPrep.q === q) return; this.turnAbort?.(); this.turnPrep = null; }
    if (q === this.quarter) return;
    if (this.views.has(q)) { this.turn(q); return; }
    this.turnPrep = { q, job: null };
  }
  // El giro en marcha: 'core' hasta el cambio (el fundido), 'rest' mientras se copia lo demás
  get turning(): { to: Quarter; phase: 'core' | 'rest' } | null {
    return this.turnPrep ? { to: this.turnPrep.q, phase: 'core' } : this.turnRest ? { to: this.turnRest.q, phase: 'rest' } : null;
  }
  // Para el banco: lo del último núcleo (trozos de vóxeles del núcleo, copiados antes, de cuántos; ms de la copia y por
  // clase de trabajo del rehorneado)
  lastTurn = { core: 0, copied: 0, of: 0, copyMs: 0, jobMs: {} as Record<string, number> };
  get turnTarget(): Quarter { return this.turnPrep?.q ?? this.quarter; }

  // El núcleo del giro q: copiar lo visible (y un trozo más), hornearlo sobre una imagen vacía y cambiar
  private turnCoreJob(q: Quarter): ViewJob {
    const src = this.store, cam = new ViewCamera(q, src.width, src.depth);
    // (la vista tiene copia si está girada o con corte: se copia por trozos, no de una vez en el constructor)
    const vo = this.o.view ?? {}, copied = q !== 0 || !!vo.cut || !!vo.dress;
    // Se prepara por pasos en la propia cola (antes, en update: ~20 ms en un cuadro con 11 x 13): la copia girada, la vista
    // y el horneado vacío, y el núcleo (lo que cae en el recuadro de la pantalla)
    let rotated: StaticVoxels | null = null, view!: WorldView, baked!: Baked, vs!: StaticVoxels, n = 0;
    let core!: number[], clip: { x0: number; y0: number; x1: number; y1: number } | undefined;
    let inCore!: Set<number>, first!: Set<number>, copyFirst!: number[];
    // Del trozo c de la vista, el trozo del mundo (para copyRotatedChunk)
    const toWorld = (c: number) => { const [x, y] = cam.cellToWorld((c % vs.cols) * CHUNK, Math.floor(c / vs.cols) * CHUNK); return src.chunkOf(x, y); };
    // La caja de cada trozo de la vista hasta lo más alto que tiene (de las alturas de h, en ejes del mundo o de la vista):
    // con toda la altura (zMax) el núcleo y sus recuadros salen mucho más altos de lo que hay
    const boxesOf = (h: StaticVoxels, world: boolean, cs: Iterable<number>) => {
      const out = new Map<number, { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }>();
      for (const c of cs) {
        const X = (c % vs.cols) * CHUNK, Y = Math.floor(c / vs.cols) * CHUNK, wc = world ? toWorld(c) : c;
        const WX = (wc % h.cols) * CHUNK, WY = Math.floor(wc / h.cols) * CHUNK;
        let top = h.zMin;
        for (let y = WY; y < WY + CHUNK; y++) for (let x = WX; x < WX + CHUNK; x++) top = Math.max(top, h.height[y * h.width + x]!);
        out.set(c, { x0: X, y0: Y, z0: h.zMin, x1: X + CHUNK - 1, y1: Y + CHUNK - 1, z1: Math.max(h.zMin, top - 1) });
      }
      return out;
    };
    let stage = 0;
    const build = (deadline: number): boolean => {
      for (let did = false; stage < 4; stage++, did = true) {
        if (did && performance.now() >= deadline) return false;
        if (stage === 0) {
          if (copied) rotated = new StaticVoxels(src.palette, cam.viewWidth, cam.viewDepth, src.zMin, src.zMax);
        } else if (stage === 1) {
          view = new WorldView(this.state, q, vo, rotated ? { static: rotated, since: src.clock } : undefined);
          baked = bakeWorldJob(view.bakeable(), { topZ: src.zMax + 1, ...(this.o.bake ?? {}) }, `bake:g${q}`).baked;
          vs = view.static; n = vs.cols * vs.rows;
        } else if (stage === 2) {
          // (lo que ningún recuadro pinta, el fondo, como en el horneado entero: sin profundidad y con todo el cielo; aparte,
          // porque llenar la memoria nueva de la imagen es lo que cuesta: ~10 ms con 1410 x 948 en Bun)
          baked.depth.fill(Infinity);
          baked.sky?.fill(SKY_RAYS);
        } else {
          const vp = this.o.viewport;
          if (!vp) core = Array.from({ length: n }, (_, c) => c);
          else {
            const [lx, ly] = this.toLocal(this.at[0], this.at[1]), [vx, vy] = cam.pointToView(lx, ly);
            const hx = Math.max(0, Math.min(src.width - 1, Math.floor(lx))), hy = Math.max(0, Math.min(src.depth - 1, Math.floor(ly)));
            const [px, py] = baked.cam.project(vx, vy, src.height[hy * src.width + hx]!);
            const M = 16, x0 = Math.max(0, Math.min(baked.width - vp[0], Math.round(px) - vp[0] / 2)), y0 = Math.max(0, Math.min(baked.height - vp[1], Math.round(py) - vp[1] / 2));
            clip = { x0: x0 - M, y0: y0 - M, x1: x0 + vp[0] - 1 + M, y1: y0 + vp[1] - 1 + M };
            // Primero con toda la altura (sin mirar alturas: una caja que contiene la de verdad), y las alturas solo de esos:
            // lo mismo que mirarlas en toda la ventana (que eran 5-8 ms con 11 x 13)
            const near = chunksInScreen(baked, clip), nearSet = new Set(near);
            const hit = chunksInScreen(baked, clip, boxesOf(src, true, near)).filter((c) => nearSet.has(c));
            // Su rectángulo de trozos entero: así todas las columnas de trozos tienen el mismo tramo y el rehorneado las junta
            // en un recuadro (por columnas sueltas, cada una repetía su margen: ~1,5 veces los píxeles)
            let cx0 = Infinity, cy0 = Infinity, cx1 = -1, cy1 = -1;
            for (const c of hit) { const cx = c % vs.cols, cy = Math.floor(c / vs.cols); cx0 = Math.min(cx0, cx); cy0 = Math.min(cy0, cy); cx1 = Math.max(cx1, cx); cy1 = Math.max(cy1, cy); }
            core = [];
            for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) core.push(cy * vs.cols + cx);
          }
          // Lo que no hace falta rehornear después: con recorte, solo los trozos del núcleo que caen enteros dentro (a 2
          // píxeles del borde: el contorno del borde del recorte puede quedar mal); el resto, como lo demás
          inCore = new Set(core);
          // Lo que se copia antes: el núcleo y un trozo más alrededor
          first = new Set<number>();
          for (const c of core) {
            const cx = c % vs.cols, cy = Math.floor(c / vs.cols);
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const x = cx + dx, y = cy + dy;
              if (x >= 0 && y >= 0 && x < vs.cols && y < vs.rows) first.add(y * vs.cols + x);
            }
          }
          copyFirst = rotated ? [...first] : [];
          this.lastTurn = { core: core.length, copied: copyFirst.length, of: n, copyMs: 0, jobMs: {} };
        }
      }
      return true;
    };
    let k = 0, jobs: ViewJob[] | null = null, j = 0, V1 = 0, spent = 0, prepDone = false;
    let prep: { run(deadline: number): boolean } | null | undefined;
    const job: ViewJob = { key: `turn:g${q}`, priority: 0, run: (deadline: number) => {
      // (se cambió de destino: este se deja)
      if (this.turnPrep?.job !== job) return true;
      const a = performance.now();
      try {
        if (stage < 4) { if (!build(deadline)) return false; if (performance.now() >= deadline) return false; }
        // (al menos un trozo por llamada: con el índice no bastaba, al volver a entrar con el plazo ya vencido no avanzaba)
        for (let did = false; k < copyFirst.length; k++, did = true) {
          if (did && performance.now() >= deadline) { this.lastTurn.copyMs += performance.now() - a; return false; }
          rotated!.copyRotatedChunk(src, q, toWorld(copyFirst[k]!));
        }
        if (!jobs) this.lastTurn.copyMs += performance.now() - a;
        if (!jobs) {
          // (lo que cambió el mundo mientras, copiado; y desde aquí, lo que cambie lo rehornea la cola de siempre)
          view.bakeable();
          vs.cut(); V1 = vs.clock;
          let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity;
          for (const c of core) { const x = (c % vs.cols) * CHUNK, y = Math.floor(c / vs.cols) * CHUNK; X0 = Math.min(X0, x); Y0 = Math.min(Y0, y); X1 = Math.max(X1, x + CHUNK); Y1 = Math.max(Y1, y + CHUNK); }
          // Las luces que pueden llegar a lo visible (las demás, con lo demás)
          const R = 64, lights = view.lights.filter((l) => l.x > X0 - R && l.x < X1 + R && l.y > Y0 - R && l.y < Y1 + R);
          // (las cajas, de lo copiado: lo que haya cambiado desde que se eligió el núcleo, también)
          const boxes = boxesOf(vs, false, core);
          // (con quien pinta fuera: el núcleo también, aunque aún no se vea; si el giro se deja, lo pedido se cancela)
          const r = this.remoteFor?.(baked, { urgent: true });
          if (r) baked.remote = r;
          jobs = rebakeJobs(baked, core, lights, boxes, this.o.rebake ?? { band: 16, rows: 64, merge: true }, clip);
          const js = jobs;
          this.turnAbort = () => { cancelRebakes(baked); for (const x of js) x?.run(0); delete baked.remote; this.turnAbort = null; };
          if (clip) inCore = new Set(chunksInScreen(baked, { x0: clip.x0 + 2, y0: clip.y0 + 2, x1: clip.x1 - 2, y1: clip.y1 - 2 }, boxes, true).filter((c) => inCore.has(c)));
          if (performance.now() >= deadline) return false;
        }
        // (en orden; lo que espera a lo pedido fuera no para a los de detrás, que piden lo suyo: el worker los pinta
        // seguidos. Sin worker, como siempre: el primero que no acaba es que se acabó el plazo)
        let all = true;
        for (let i = j; i < jobs.length; i++) {
          const x = jobs[i]!;
          if (!x) continue;
          if (!all && performance.now() >= deadline) return false;
          if (x.waiting?.()) { all = false; continue; }
          const t = performance.now(), ok = x.run(deadline), kind = x.key.split(/[:#]/)[0]!;
          this.lastTurn.jobMs[kind] = (this.lastTurn.jobMs[kind] ?? 0) + performance.now() - t;
          if (ok) { jobs[i] = null as unknown as ViewJob; if (all) j = i + 1; continue; }
          if (!x.waiting?.()) return false;
          all = false;
        }
        if (!all) return false;
        this.turnAbort = null;
        // Lo del juego antes del cambio (subirlo a la GPU por partes)
        if (!prepDone) {
          if (prep === undefined) prep = this.o.beforeTurnSwap?.(baked) ?? null;
          if (prep && !prep.run(deadline)) return false;
          prepDone = true;
        }
      } finally { spent += performance.now() - a; }
      // El cambio
      const old = this.quarter;
      baked.version = V1;
      this.views.set(q, { view, baked });
      this.quarter = q;
      // La vista que se suelta: su rehorneado en la cola (recuadros, cielo, luces) acaba sin hacer nada. Si no, se quedaba
      // en la cola, que no lo alcanza con giros seguidos, y guardaba su imagen y su copia girada (~220 MB por giro con 11 x 13)
      let released: Baked | undefined;
      if (!this.live.has(old)) { const v = this.views.get(old); this.views.delete(old); if (v && v.baked !== baked) { cancelRebakes(v.baked); released = v.baked; } }
      this.applyRemote(released);
      this.turnPrep = null;
      // Un corrimiento a medias: el de la vista que se soltó sobra, la nueva prepara el suyo, y los vóxeles del mundo los
      // corre el giro 0 si está (su horneado es del mundo) o, si no, aparte
      if (this.shiftJobs) {
        const [dx, dy] = this.shiftDir;
        this.shiftJobs = this.shiftJobs.filter((s) => this.views.has(s.q) && s.q !== q);
        this.shiftJobs.push(this.viewShiftJob(q, view, baked, dx, dy));
        if (this.worldViewed()) this.storeShift = null;
        else if (!this.storeShift) { const k = this.T / CHUNK; this.storeShift = { job: this.store.shiftJob(dx * k, dy * k), ready: false }; }
      }
      this.stats.turnMs.push(spent);
      const rest: number[] = [];
      for (let c = 0; c < n; c++) if (!inCore.has(c)) rest.push(c);
      let r = 0;
      this.turnRest = { q, job: { key: `turn-rest:g${q}`, priority: 70, run: (deadline: number) => {
        // (si ya se giró a otro, este se dejó)
        if (this.views.get(q)?.view !== view) return true;
        for (let did = false; r < rest.length; r++, did = true) {
          if (did && performance.now() >= deadline) return false;
          const c = rest[r]!;
          if (rotated && !first.has(c)) rotated.copyRotatedChunk(src, q, toWorld(c));
          vs.touch(c);
        }
        if (this.turnRest?.q === q) this.turnRest = null;
        this.pendingRebake = true;
        return true;
      } } };
      return true;
    } };
    return job;
  }

  // Lo del trozo t para el juego (en coordenadas del mundo)
  ctx(t: Trozo, region?: GeneratedRegion): TrozoCtx {
    const C = this.C, cx0 = this.tx0 * C, cy0 = this.ty0 * C;
    return {
      ...(region ? { region } : {}),
      grid: this.grid, at: [(t[0] - this.tx0) * C, (t[1] - this.ty0) * C, 0],
      read: (x, y, z) => { const [lx, ly] = this.toLocal(x, y); return this.store.get(lx, ly, z); },
      write: (x, y, z, v) => { const [lx, ly] = this.toLocal(x, y); this.store.set(lx, ly, z, v); },
      cell: (bx, by, bz) => [this.grid.get(bx - cx0, by - cy0, bz), this.grid.yawOf(bx - cx0, by - cy0, bz)],
      setCell: (bx, by, bz, block, yaw = 0) => { this.grid.set(bx - cx0, by - cy0, bz, block, yaw); },
    };
  }

  // De coordenadas del mundo a las locales (del state) y al revés
  toLocal(x: number, y: number): [number, number] { return [x - this.tx0 * this.T, y - this.ty0 * this.T]; }
  toWorld(x: number, y: number): [number, number] { return [x + this.tx0 * this.T, y + this.ty0 * this.T]; }
  // El trozo del mundo de un punto del mundo
  trozoOf(x: number, y: number): Trozo { return [Math.floor(x / this.T), Math.floor(y / this.T)]; }
  // ¿Está escrito el trozo (y se puede leer)?
  isLoaded(t: Trozo): boolean { return this.loaded.has(`${t[0]},${t[1]}`); }
  // Cuántas veces la ventana saltó (el objetivo apareció fuera de ella)
  jumps = 0;
  private jumping = false;
  // ¿Sigue la carga del principio (preload: 'queue', o tras un salto)?
  get preloadingNow(): boolean { return this.preloading; }
  private preloading = false;
  // ¿Está listo lo de alrededor del punto (x, y) del MUNDO: los trozos tx - ring.x .. tx + ring.x, ty - ring.s .. ty +
  // ring.n escritos, y su imagen en el giro de ahora sin nada por rehornear (ni en la cola ni sin encolar)? Para la
  // pantalla de carga con preload: 'queue', o para saber si lo que se ve ya está
  ready(x: number, y: number, ring: { x: number; n: number; s: number } = { x: 3, n: 5, s: 3 }): boolean {
    const [tx, ty] = this.trozoOf(x, y);
    for (let j = ty - ring.s; j <= ty + ring.n; j++) for (let i = tx - ring.x; i <= tx + ring.x; i++) if (!this.isLoaded([i, j])) return false;
    // Los trozos de vóxeles de la imagen de ahora que caen en el anillo (en ejes de la vista)
    const { view, baked } = this.views.get(this.quarter)!, src = baked.source, cam = view.camera;
    const [ax, ay] = this.toLocal((tx - ring.x) * this.T, (ty - ring.s) * this.T), [bx, by] = this.toLocal((tx + ring.x + 1) * this.T - 1, (ty + ring.n + 1) * this.T - 1);
    const [p0x, p0y] = cam.cellToView(Math.max(0, ax), Math.max(0, ay)), [p1x, p1y] = cam.cellToView(Math.min(this.store.width - 1, bx), Math.min(this.store.depth - 1, by));
    const X0 = Math.floor(Math.min(p0x, p1x) / CHUNK), X1 = Math.floor(Math.max(p0x, p1x) / CHUNK), Y0 = Math.floor(Math.min(p0y, p1y) / CHUNK), Y1 = Math.floor(Math.max(p0y, p1y) / CHUNK);
    const inRing = (c: number) => { const x = c % src.cols, y = Math.floor(c / src.cols); return x >= X0 && x <= X1 && y >= Y0 && y <= Y1; };
    if (src.changedSince(baked.version).some(inRing)) return false;
    // (sin el margen que chunkRect suma a la caja de cada plan: el rehorneado de un trozo vecino lo toca solo por él)
    const mg = (baked.options.smooth ?? 0.6) > 0 ? 3 : 1;
    for (const plans of baked.pendingPlans?.values() ?? []) for (const p of plans) {
      if (!(p.X1 - mg < X0 * CHUNK || p.X0 + mg > (X1 + 1) * CHUNK - 1 || p.Y1 - mg < Y0 * CHUNK || p.Y0 + mg > (Y1 + 1) * CHUNK - 1)) return false;
    }
    return true;
  }
  // ¿Hay trabajo de la ventana en marcha (corrimiento o trozos por escribir)?
  // ¿Hay un corrimiento empezado (sin cambiar aún)?
  get shifting(): boolean { return !!this.shiftJobs; }
  get busy(): boolean { return !!this.shiftJobs || this.loading.length > 0 || !!this.loadJob || !!this.turnPrep || !!this.turnRest || this.pendingRebake; }

  // Cada cuadro: con el objetivo en (x, y) del MUNDO, decide si correr la ventana y mete su trabajo en la cola. Se corre un
  // trozo cada vez, hacia donde haga falta para que el del objetivo quede a margin trozos o más del borde
  update(x: number, y: number, budget: { push(job: ViewJob): void }): void {
    const [tx, ty] = this.trozoOf(x, y), m = this.m, { nx, ny } = this.o;
    this.at = [x, y];
    let dx = 0, dy = 0;
    if (tx - this.tx0 < m.x) dx = -1; else if (this.tx0 + nx - 1 - tx < m.x) dx = 1;
    if (ty - this.ty0 < m.s) dy = -1; else if (this.ty0 + ny - 1 - ty < m.n) dy = 1;
    const turning = !!this.turnPrep || !!this.turnRest;
    // EL SALTO: el objetivo fuera de la ventana (aparecer lejos, un teletransporte). En vez de correrse trozo a trozo
    // (cada cambio descartaba y volvía a marcar lo encolado, y al final quedaba un rehorneado de casi toda la imagen que no
    // se veía hasta acabar: 26-34 s en negro a 1x en la página de FERN), un solo cambio hasta la ventana centrada en él,
    // y la ventana nueva se carga del centro hacia fuera con prioridad cercana, como preload 'queue'. Lo que estaba por
    // escribir se olvida (sigue el trozo a medias, si lo hay)
    const outside = tx < this.tx0 || tx >= this.tx0 + nx || ty < this.ty0 || ty >= this.ty0 + ny;
    if (outside && !turning && !this.shiftJobs && !this.loadJob) {
      const ntx0 = tx - Math.floor(nx / 2), nty0 = ty - m.s - Math.floor((ny - m.n - m.s - 1) / 2);
      this.loading = [];
      this.preloading = true;
      this.jumps++;
      this.jumping = true;
      this.startShift(ntx0 - this.tx0, nty0 - this.ty0);
    } else if ((dx || dy) && !turning && !this.shiftJobs && !this.loading.length && !this.loadJob) this.startShift(dx, dy);
    if (this.shiftJob) budget.push(this.shiftJob);
    // El giro, cuando no hay corrimiento a medias (copia de lo que se está corriendo)
    // El giro no espera a un corrimiento a medias: el cambio del corrimiento es el que espera a que acabe el giro (núcleo y
    // copia de lo demás), y en el cambio de giro el corrimiento pasa a ser el de la vista nueva
    if (this.turnPrep) budget.push(this.turnPrep.job ??= this.turnCoreJob(this.turnPrep.q));
    if (this.turnRest) budget.push(this.turnRest.job);
    if (!this.shiftJobs && !this.turnPrep && this.loading.length && !this.loadJob) this.nextLoad();
    // La carga del principio acaba con el último trozo escrito (su rehorneado, que se encola abajo, aún va cercano)
    const lastPreload = this.preloading && !this.loading.length && !this.loadJob;
    if (this.loadJob) budget.push(this.loadJob);
    if (this.shiftJobs) return;
    // Lo escrito (los trozos que entraron, con lo del juego), a rehornear en todos los giros; en los que no se ven, también
    // lo que haya cambiado el juego (en el de ahora lo rehornea él, con near)
    const all = this.pendingRebake;
    this.pendingRebake = false;
    for (const [q, { view, baked }] of this.views) {
      if (q === this.quarter && !all) continue;
      const lights = view.bakeable().lights;
      if (!baked.source.changedSince(baked.version).length) continue;
      // (en la carga del principio y tras un salto, el rehorneado va cercano, detrás de los trozos y por distancia al
      // objetivo en pantalla, lo de cerca primero; lo expuesto, detrás de todo)
      const pre = this.preloading && q === this.quarter;
      const near = pre ? (() => { const [lx, ly] = this.toLocal(this.at[0], this.at[1]), [vx, vy] = view.camera.pointToView(lx, ly); return { x: vx, y: vy }; })() : undefined;
      // (el cielo y las luces llevan LIGHT_PRIORITY más su distancia: van justo detrás del recuadro a su misma distancia)
      const dist = (p: number) => p >= LIGHT_PRIORITY ? p - LIGHT_PRIORITY + 0.5 : p;
      const pri = (j: ViewJob) => pre && !j.key.startsWith('exposure:') ? 1 + Math.min(62, dist(j.priority ?? 0) / 16) : this.preloading && !j.key.startsWith('exposure:') ? 1 : j.priority;
      for (const j of rebakeChangedJobs(baked, lights, { shape: this.o.rebake ?? { band: 16, rows: 64, merge: true }, ...(near ? { near } : {}) })) {
        const p = pri(j);
        budget.push(q === 0 && p === j.priority ? j : wrapJob(j, { key: q === 0 ? j.key : `g${q}/${j.key}`, priority: p }));
      }
    }
    if (lastPreload && !this.pendingRebake) this.preloading = false;
  }

  // Corre la ventana dx, dy trozos: el juego guarda lo que sale (aún en el store), y el trabajo de la cola hace el resto
  private readonly prefetch = new Map<string, { result(): PreparedTrozo | null }>();
  private startShift(dx: number, dy: number): void {
    this.prefetch.clear();
    const { nx, ny } = this.o, ntx = this.tx0 + dx, nty = this.ty0 + dy;
    for (let ty = this.ty0; ty < this.ty0 + ny; ty++) for (let tx = this.tx0; tx < this.tx0 + nx; tx++) {
      if (tx >= ntx && tx < ntx + nx && ty >= nty && ty < nty + ny) continue;
      // (solo los escritos: tras un salto con trozos por escribir, uno sin escribir no tiene nada que guardar, y guardarlo
      // pisaría sus diferencias con aire)
      if (!this.loaded.has(`${tx},${ty}`)) continue;
      this.o.onUnload?.([tx, ty], this.ctx([tx, ty]));
      this.loaded.delete(`${tx},${ty}`);
    }
    // Cada giro, su imagen en sus ejes (el corrimiento es una dirección); el cambio lo hace trySwitch, de todos a la vez
    const k = this.T / CHUNK;
    this.shiftTo = [ntx, nty];
    this.shiftDir = [dx, dy];
    this.shiftJobs = [...this.views].map(([q, { view, baked }]) => this.viewShiftJob(q, view, baked, dx, dy));
    // Sin el giro 0 (girar con fundido), nadie corre los vóxeles del mundo con su horneado: se corren aparte, por pasos, y
    // cambian en el mismo momento que los giros
    this.storeShift = this.worldViewed() ? null : { job: this.store.shiftJob(dx * k, dy * k), ready: false };
    // Un trabajo de la cola: prepara los giros (el que se ve, primero) y, cuando están todos, el cambio
    this.shiftSpent = 0; this.shiftStartAt = performance.now();
    // (con la prioridad de los trozos: sin ella iba detrás de todo el rehorneado de la cola, en orden de llegada)
    this.shiftJob = { key: 'shift', priority: 70, run: (deadline: number) => {
      const a = performance.now();
      try {
        const st = this.storeShift;
        while (st && !st.ready) { st.ready = st.job.step(); if (!st.ready && performance.now() >= deadline) return false; }
        const jobs = [...this.shiftJobs!].sort((a, b) => +(b.q === this.quarter) - +(a.q === this.quarter));
        // (también los ya preparados: así recopian lo publicado mientras tanto)
        for (const s of jobs) if (!s.job.run(deadline)) return false;
        return this.trySwitch();
      } finally { this.shiftSpent += performance.now() - a; }
    } };
  }
  // El corrimiento de la imagen del giro q (en sus ejes), preparado por pasos; el cambio lo hace trySwitch
  private viewShiftJob(q: Quarter, view: WorldView, baked: Baked, dx: number, dy: number): { q: Quarter; job: ShiftJob } {
    const k = this.T / CHUNK, [vx, vy] = view.camera.dirToView(dx, dy);
    return { q, job: shiftBakedJob(baked, vx * k, vy * k, { band: this.o.band, manual: true, key: `shift:g${q}` }) };
  }
  private shiftDir: [number, number] = [0, 0];
  // ¿Alguna vista hornea los vóxeles del mundo tal cual (el giro 0 sin copia)? Entonces su corrimiento los corre; si no,
  // se corren aparte (storeShift)
  private worldViewed(): boolean { for (const { view } of this.views.values()) if (view.static === this.store) return true; return false; }
  private storeShift: { job: { step(): boolean; commit(): void }; ready: boolean } | null = null;
  // Lo que pidió el último cambio (para el banco): ms de todo el cambio
  lastSwitchMs = 0;
  // Para el banco: ms de CPU por trozo escrito (en sus llamadas), por corrimiento preparado y por cambio, y los que esperan
  // (y por giro con fundido, ms de CPU del núcleo)
  // (y de reloj: del empiece de cada corrimiento a su cambio, y del cambio a tener escritos los trozos que entraron)
  readonly stats = { loadMs: [] as number[], shiftMs: [] as number[], switchMs: [] as number[], turnMs: [] as number[], shiftWallMs: [] as number[], loadWallMs: [] as number[] };
  private shiftStartAt = 0;
  private switchAt = -1;
  get queued(): number { return this.loading.length + (this.loadJob ? 1 : 0); }
  private shiftSpent = 0;

  // El cambio, de todos los giros a la vez (y en el mismo momento la rejilla, las entidades, las luces y el juego): si
  // alguno aún no puede (rehorneado a medias, o hay que volver a prepararlo), se espera
  private trySwitch(): boolean {
    const t0 = performance.now();
    // Las copias giradas, al día con el mundo antes de correrlas
    // (un giro en marcha copia del mundo sin correr: el corrimiento espera a que acabe)
    if (this.turnPrep || this.turnRest) return false;
    for (const { view } of this.views.values()) view.frame();
    for (const s of this.shiftJobs!) if (!s.job.canCommit()) return false;
    for (const s of this.shiftJobs!) s.job.commit();
    this.storeShift?.job.commit(); this.storeShift = null;
    const [dx, dy] = this.shiftDir;
    // El corte de cada vista (en coordenadas locales del mundo), corrido antes de avisar al juego (que puede poner otro
    // en onShift, ya en las coordenadas nuevas)
    for (const { view } of this.views.values()) view.shift(dx * this.T, dy * this.T);
    this.onSwitch(dx, dy);
    // (los dos se corrieron igual: lo que entra, vacío en los dos)
    for (const { view } of this.views.values()) view.markSynced();
    // (lo que quedaba por rehornear se descartó en el cambio y se volvió a marcar: a la cola otra vez)
    this.pendingRebake = true;
    // Tras un salto no queda nada de antes: la imagen corrida está vacía, que es lo que da un mundo vacío. Se da por
    // horneada tal cual (si no, el primer rehorneado era un recuadro de toda la imagen vacía, y lo del centro esperaba
    // detrás); lo que se escriba se rehornea trozo a trozo, del centro hacia fuera
    if (this.jumping) {
      this.jumping = false;
      for (const { baked } of this.views.values()) { baked.source.cut(); baked.version = baked.source.clock; }
    } else for (const { baked } of this.views.values()) {
      // Al correrse, lo que entra está vacío, y la imagen corrida también: no hay nada que rehornear ahí hasta que se
      // escriba cada trozo (si no, el primer rehorneado era un recuadro de toda la columna que entra, de vacío, y con un
      // worker llegaba siempre tarde: los trozos se escribían mientras). Se da por horneado lo vacío; lo demás que cambió
      // (el borde nuevo, lo que se volvió a marcar) sigue marcado
      const s = baked.source, keep = s.changedSince(baked.version).filter((c) => !s.chunkEmpty(c));
      s.cut(); baked.version = s.clock;
      for (const c of keep) s.touch(c);
    }
    this.lastSwitchMs = performance.now() - t0;
    this.stats.switchMs.push(this.lastSwitchMs); this.stats.shiftMs.push(this.shiftSpent);
    this.stats.shiftWallMs.push(performance.now() - this.shiftStartAt); this.switchAt = performance.now();
    this.afterShift(dx, dy);
    return true;
  }

  private onSwitch(dx: number, dy: number): void {
    const DX = dx * this.T, DY = dy * this.T;
    this.grid.shift(dx * this.C, dy * this.C);
    // Las entidades y las luces, en el marco nuevo (las del mundo no cambian)
    for (const e of [...this.state.entities]) this.state.entities.move(e.id, e.x - DX, e.y - DY, e.z, e.yaw);
    for (const l of this.state.lights) { l.x -= DX; l.y -= DY; }
    // Las gotas, lo que flota y los efectos (sus posiciones son del state)
    this.state.shiftDynamic(DX, DY);
    this.tx0 += dx; this.ty0 += dy;
    // Lo que oye los cambios del mundo (watchChanges: caminos, cachés del juego): lo apuntado sin tomar, corrido; y lo
    // enganchado (attach: los campos de caminos), corrido en el mismo momento
    for (const w of this.state.changes.list ?? []) w.shift(DX, DY, CHUNK);
    const k = this.T / CHUNK;
    const sources = [...this.views.values()].map(({ view, baked }) => { const [vx, vy] = view.camera.dirToView(dx, dy); return { source: baked.source, dcx: vx * k, dcy: vy * k }; });
    for (const a of this.attached) { a.shift(DX, DY); a.shiftSources?.(sources); }
    this.o.onShift?.({ cells: [dx * this.C, dy * this.C], voxels: [DX, DY] });
  }

  private afterShift(dx: number, dy: number): void {
    const [ntx, nty] = this.shiftTo!, { nx, ny } = this.o;
    this.shiftJobs = null; this.shiftJob = null; this.shiftTo = null;
    // Los que hay que escribir (los que entran y, tras un salto, los que estaban por escribir), del centro hacia fuera
    void dx; void dy;
    const entered: Trozo[] = [];
    for (let ty = nty; ty < nty + ny; ty++) for (let tx = ntx; tx < ntx + nx; tx++) if (!this.loaded.has(`${tx},${ty}`)) entered.push([tx, ty]);
    const cx = ntx + (nx - 1) / 2, cy = nty + (ny - 1) / 2;
    entered.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    this.loading.push(...entered);
    // (fuera: se piden todos ya, en orden, para que el worker los haga seguidos y no uno por cada recuadro que pinta;
    // sus sitios valen hasta el próximo corrimiento, que espera a que estén escritos)
    if (this.o.prepareTrozo) for (const t of entered) this.prefetch.set(`${t[0]},${t[1]}`, this.o.prepareTrozo(t, [(t[0] - this.tx0) * this.C, (t[1] - this.ty0) * this.C]));
  }

  // El siguiente trozo por escribir: generarlo, escribirlo por pasos y, al acabar, lo del juego y el rehorneado
  private nextLoad(): void {
    const t = this.loading.shift()!;
    const job = this.loadTrozoJob(t, true);
    let spent = 0;
    this.loadJob = { key: `trozo:${t[0]},${t[1]}`, priority: this.preloading ? 0 : 70, run: (deadline: number) => {
      const a = performance.now(), ok = job.run(deadline);
      spent += performance.now() - a;
      if (!ok) return false;
      this.stats.loadMs.push(spent);
      this.loadJob = null;
      if (!this.loading.length && this.switchAt >= 0) { this.stats.loadWallMs.push(performance.now() - this.switchAt); this.switchAt = -1; }
      // Rehornear lo escrito (y lo del juego): sus trabajos, a la cola en la próxima update
      this.pendingRebake = true;
      return true;
    } };
  }
  private pendingRebake = false;
  private get skipOpt(): { skip?: readonly number[] } { return this.o.skip ? { skip: this.o.skip } : {}; }

  // Generar y escribir el trozo t (en su sitio de la ventana), y lo del juego
  private loadTrozoJob(t: Trozo, remote = false): { run(deadline: number): boolean } {
    const C = this.C, [tx, ty] = t, spec = this.o.spec;
    if (this.o.fill) {
      // Lo escribe el juego
      let job: { run(deadline: number): boolean } | void | null = null;
      return { run: (deadline: number) => {
        if (job === null) { job = this.o.fill!(t, this.ctx(t)); if (!job) { this.loaded.add(`${tx},${ty}`); return true; } }
        if (!job!.run(deadline)) return false;
        this.loaded.add(`${tx},${ty}`);
        return true;
      } };
    }
    let stamp: { run(deadline: number): boolean } | null = null;
    // (fuera, si se puede: se pide y se espera sin gastar; al llegar, las celdas y un trozo de vóxeles por paso)
    const pre = this.prefetch.get(`${tx},${ty}`);
    if (pre) this.prefetch.delete(`${tx},${ty}`);
    let ticket: { result(): PreparedTrozo | null } | null = this.o.prepareTrozo && remote ? pre ?? this.o.prepareTrozo(t, [(tx - this.tx0) * C, (ty - this.ty0) * C]) : null;
    let prep: PreparedTrozo | null = null, k = -1;
    // (lo que devolvió onLoad: undefined, aún no se llamó; null, nada)
    let after: { run(deadline: number): boolean } | null | undefined;
    // (el estampado acabado: si lo de onLoad queda a medias, no se vuelve a llamar)
    let stamped = false;
    if (ticket) return { run: (deadline: number) => {
      if (!prep) { prep = ticket!.result(); if (!prep) return false; ticket = null; }
      if (prep.local && !stamped) {
        stamp ??= this.grid.stampRegionJob(prep.cells, [(tx - this.tx0) * C, (ty - this.ty0) * C, 0], this.skipOpt);
        if (!stamp.run(deadline)) return false;
        stamped = true;
        k = prep.chunks.length;
      }
      if (k < 0) { this.grid.stampCells(prep.cells, [(tx - this.tx0) * C, (ty - this.ty0) * C, 0], this.skipOpt); k = 0; }
      for (; k < prep.chunks.length; k++) {
        if (k && performance.now() >= deadline) return false;
        const ch = prep.chunks[k]!;
        this.store.writeChunkPrepared(ch.c, ch.slabs, ch.tops);
      }
      if (after === undefined) { after = this.o.onLoad?.(t, this.ctx(t, prep.cells)) ?? null; if (after && performance.now() >= deadline) return false; }
      if (after && !after.run(deadline)) return false;
      this.loaded.add(`${tx},${ty}`);
      return true;
    } };
    let region: GeneratedRegion | null = null;
    return { run: (deadline: number) => {
      if (!stamp) {
        region = generateRegion(spec, { x0: tx * C, y0: ty * C, z0: 0, width: C, depth: C, height: spec.height });
        stamp = this.grid.stampRegionJob(region, [(tx - this.tx0) * C, (ty - this.ty0) * C, 0], this.skipOpt);
        if (performance.now() >= deadline) return false;
      }
      if (!stamped) { if (!stamp.run(deadline)) return false; stamped = true; }
      if (after === undefined) { after = this.o.onLoad?.(t, this.ctx(t, region!)) ?? null; if (after && performance.now() >= deadline) return false; }
      if (after && !after.run(deadline)) return false;
      this.loaded.add(`${tx},${ty}`);
      return true;
    } };
  }
}
