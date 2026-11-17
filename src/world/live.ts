// LA VENTANA VIVA (NARUTO, fase 4, 3a): un mundo sin bordes alrededor de un objetivo. Una ventana de nx x ny trozos
// (cada uno de `chunk` x `chunk` bloques del set) se genera por regiones (regiongen.ts), se escribe de una vez por trozo
// (BlockGrid.stampRegionJob), se hornea, y se corre cuando el objetivo se acerca a un borde (shiftBakedJob: la imagen y
// los vóxeles por pasos en la cola, sin copiar ni rehornear lo que se queda). Todo el trabajo va a la FrameBudget de la
// vista: nunca un trozo entero en un cuadro si no cabe.
//
// Dos marcos de coordenadas: las del MUNDO (sin tope, también negativas: el trozo (tx, ty) empieza en tx * T, ty * T
// vóxeles) y las LOCALES del WorldState de la ventana (state, grid, baked: la esquina de la ventana en (0, 0)). toLocal /
// toWorld pasan de unas a otras. Al correrse la ventana, las entidades y las luces del state se corren con ella (sus
// coordenadas locales cambian; las del mundo no).
//
// El juego:
// - fill(t, ctx) (opcional): escribe él el trozo t que entra (lo generado y sus diferencias guardadas, hornos, cofres...)
//   y devuelve un trabajo de la cola (o nada, si lo hizo ya). Sin fill, LiveWindow lo genera (generateRegion), lo escribe
//   (stampRegionJob) y llama a onLoad(t, ctx). Lo uno o lo otro va ANTES de hornear el trozo.
// - onUnload(t, ctx): el trozo t sale; aún está en la rejilla (ctx.read, ctx.cell), para guardar sus diferencias y
//   quitar sus entidades. Se llama antes de correr nada.
// - onShift({ cells, voxels }): el origen local se corrió: lo que estaba en la x local pasa a x - voxels[0] (y en celdas,
//   bx - cells[0]); igual en y. Las entidades y las luces del state ya van corridas; lo demás que guarde el juego en
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
import type { Palette } from '../core';
import { StaticVoxels, WorldState, CHUNK } from './state';
import { BlockGrid, type BlockSet } from './blocks';
import type { Yaw } from './edit';
import { generateRegion, type RegionSpec } from './regiongen';
import { bakeWorld, shiftBakedJob, rebakeChangedJobs, type Baked, type ShiftJob, type ViewJob, type RebakeShape } from './bake';
import { WorldView, type Quarter } from './view';

export type Trozo = readonly [number, number];
// Lo que se le da al juego por trozo, en coordenadas del MUNDO
export interface TrozoCtx {
  grid: BlockGrid;
  at: readonly [number, number, number];                       // la celda local (de grid) de la esquina del trozo
  read(x: number, y: number, z: number): number;               // vóxel
  write(x: number, y: number, z: number, v: number): void;
  cell(bx: number, by: number, bz: number): [number, Yaw];     // [bloque, giro en grados]
  setCell(bx: number, by: number, bz: number, block: number, yaw?: Yaw): void;
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
  fill?(t: Trozo, ctx: TrozoCtx): { run(deadline: number): boolean } | void;
  onUnload?(t: Trozo, ctx: TrozoCtx): void;
  onLoad?(t: Trozo, ctx: TrozoCtx): void;
  onShift?(d: { cells: readonly [number, number]; voxels: readonly [number, number] }): void;
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

  constructor(opts: LiveWindowOptions) {
    this.o = { band: 32, ...opts };
    const mg = opts.margin ?? 2;
    this.m = typeof mg === 'number' ? { x: mg, n: mg, s: mg } : mg;
    if (opts.nx < 2 * this.m.x + 1 || opts.ny < this.m.n + this.m.s + 1) throw new Error(`LiveWindow: la ventana (${opts.nx} x ${opts.ny}) no cabe los márgenes (${JSON.stringify(this.m)}): hace falta ${2 * this.m.x + 1} x ${this.m.n + this.m.s + 1}`);
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
    for (let ty = this.ty0; ty < this.ty0 + opts.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + opts.nx; tx++) {
      const job = this.loadTrozoJob([tx, ty]);
      while (!job.run(Infinity));
    }
    for (const q of new Set<Quarter>([0, ...(opts.quarters ?? [])])) {
      const view = new WorldView(this.state, q);
      this.views.set(q, { view, baked: bakeWorld(view.bakeable(), { topZ: this.store.zMax + 1, ...(opts.bake ?? {}) }) });
    }
  }

  // Cambia al giro q (ya horneado y al día): view y baked pasan a ser los suyos
  turn(q: Quarter): void {
    if (!this.views.has(q)) throw new Error(`LiveWindow: el giro ${q} no está horneado (quarters: ${this.quarters.join(', ')})`);
    this.quarter = q;
  }

  // Lo del trozo t para el juego (en coordenadas del mundo)
  ctx(t: Trozo): TrozoCtx {
    const C = this.C, cx0 = this.tx0 * C, cy0 = this.ty0 * C;
    return {
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
  // ¿Hay trabajo de la ventana en marcha (corrimiento o trozos por escribir)?
  get busy(): boolean { return !!this.shiftJobs || this.loading.length > 0 || !!this.loadJob; }

  // Cada cuadro: con el objetivo en (x, y) del MUNDO, decide si correr la ventana y mete su trabajo en la cola. Se corre un
  // trozo cada vez, hacia donde haga falta para que el del objetivo quede a margin trozos o más del borde
  update(x: number, y: number, budget: { push(job: ViewJob): void }): void {
    const [tx, ty] = this.trozoOf(x, y), m = this.m, { nx, ny } = this.o;
    let dx = 0, dy = 0;
    if (tx - this.tx0 < m.x) dx = -1; else if (this.tx0 + nx - 1 - tx < m.x) dx = 1;
    if (ty - this.ty0 < m.s) dy = -1; else if (this.ty0 + ny - 1 - ty < m.n) dy = 1;
    if ((dx || dy) && !this.shiftJobs && !this.loading.length && !this.loadJob) this.startShift(dx, dy);
    if (this.shiftJob) budget.push(this.shiftJob);
    if (!this.shiftJobs && this.loading.length && !this.loadJob) this.nextLoad();
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
      for (const j of rebakeChangedJobs(baked, lights, { shape: this.o.rebake ?? { band: 16, rows: 64, merge: true } })) budget.push(q === 0 ? j : { key: `g${q}/${j.key}`, run: (d: number) => j.run(d), ...(j.priority !== undefined ? { priority: j.priority } : {}) });
    }
  }

  // Corre la ventana dx, dy trozos: el juego guarda lo que sale (aún en el store), y el trabajo de la cola hace el resto
  private startShift(dx: number, dy: number): void {
    const { nx, ny } = this.o, ntx = this.tx0 + dx, nty = this.ty0 + dy;
    for (let ty = this.ty0; ty < this.ty0 + ny; ty++) for (let tx = this.tx0; tx < this.tx0 + nx; tx++) {
      if (tx >= ntx && tx < ntx + nx && ty >= nty && ty < nty + ny) continue;
      this.o.onUnload?.([tx, ty], this.ctx([tx, ty]));
      this.loaded.delete(`${tx},${ty}`);
    }
    // Cada giro, su imagen en sus ejes (el corrimiento es una dirección); el cambio lo hace trySwitch, de todos a la vez
    const k = this.T / CHUNK;
    this.shiftTo = [ntx, nty];
    this.shiftDir = [dx, dy];
    this.shiftJobs = [...this.views].map(([q, { view, baked }]) => {
      const [vx, vy] = view.camera.dirToView(dx, dy);
      return { q, job: shiftBakedJob(baked, vx * k, vy * k, { band: this.o.band, manual: true, key: `shift:g${q}` }) };
    });
    // Un trabajo de la cola: prepara los giros (el que se ve, primero) y, cuando están todos, el cambio
    this.shiftSpent = 0;
    this.shiftJob = { key: 'shift', run: (deadline: number) => {
      const a = performance.now();
      try {
        const jobs = [...this.shiftJobs!].sort((a, b) => +(b.q === this.quarter) - +(a.q === this.quarter));
        for (const s of jobs) if (!s.job.prepared && !s.job.run(deadline)) return false;
        return this.trySwitch();
      } finally { this.shiftSpent += performance.now() - a; }
    } };
  }
  private shiftDir: [number, number] = [0, 0];
  // Lo que pidió el último cambio (para el banco): ms de todo el cambio
  lastSwitchMs = 0;
  // Para el banco: ms de CPU por trozo escrito (en sus llamadas), por corrimiento preparado y por cambio, y los que esperan
  readonly stats = { loadMs: [] as number[], shiftMs: [] as number[], switchMs: [] as number[] };
  get queued(): number { return this.loading.length + (this.loadJob ? 1 : 0); }
  private shiftSpent = 0;

  // El cambio, de todos los giros a la vez (y en el mismo momento la rejilla, las entidades, las luces y el juego): si
  // alguno aún no puede (rehorneado a medias, o hay que volver a prepararlo), se espera
  private trySwitch(): boolean {
    const t0 = performance.now();
    // Las copias giradas, al día con el mundo antes de correrlas
    for (const { view } of this.views.values()) view.frame();
    for (const s of this.shiftJobs!) if (!s.job.canCommit()) return false;
    for (const s of this.shiftJobs!) s.job.commit();
    const [dx, dy] = this.shiftDir;
    this.onSwitch(dx, dy);
    // (los dos se corrieron igual: lo que entra, vacío en los dos)
    for (const { view } of this.views.values()) view.markSynced();
    this.lastSwitchMs = performance.now() - t0;
    this.stats.switchMs.push(this.lastSwitchMs); this.stats.shiftMs.push(this.shiftSpent);
    this.afterShift(dx, dy);
    return true;
  }

  private onSwitch(dx: number, dy: number): void {
    const DX = dx * this.T, DY = dy * this.T;
    this.grid.shift(dx * this.C, dy * this.C);
    // Las entidades y las luces, en el marco nuevo (las del mundo no cambian)
    for (const e of [...this.state.entities]) this.state.entities.move(e.id, e.x - DX, e.y - DY, e.z, e.yaw);
    for (const l of this.state.lights) { l.x -= DX; l.y -= DY; }
    this.tx0 += dx; this.ty0 += dy;
    this.o.onShift?.({ cells: [dx * this.C, dy * this.C], voxels: [DX, DY] });
  }

  private afterShift(dx: number, dy: number): void {
    const [ntx, nty] = this.shiftTo!, { nx, ny } = this.o;
    this.shiftJobs = null; this.shiftJob = null; this.shiftTo = null;
    // Los que entran, del centro hacia fuera
    const old = [ntx - dx, nty - dy], entered: Trozo[] = [];
    for (let ty = nty; ty < nty + ny; ty++) for (let tx = ntx; tx < ntx + nx; tx++) {
      if (tx >= old[0]! && tx < old[0]! + nx && ty >= old[1]! && ty < old[1]! + ny) continue;
      entered.push([tx, ty]);
    }
    const cx = ntx + (nx - 1) / 2, cy = nty + (ny - 1) / 2;
    entered.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    this.loading.push(...entered);
  }

  // El siguiente trozo por escribir: generarlo, escribirlo por pasos y, al acabar, lo del juego y el rehorneado
  private nextLoad(): void {
    const t = this.loading.shift()!;
    const job = this.loadTrozoJob(t);
    let spent = 0;
    this.loadJob = { key: `trozo:${t[0]},${t[1]}`, priority: 70, run: (deadline: number) => {
      const a = performance.now(), ok = job.run(deadline);
      spent += performance.now() - a;
      if (!ok) return false;
      this.stats.loadMs.push(spent);
      this.loadJob = null;
      // Rehornear lo escrito (y lo del juego): sus trabajos, a la cola en la próxima update
      this.pendingRebake = true;
      return true;
    } };
  }
  private pendingRebake = false;

  // Generar y escribir el trozo t (en su sitio de la ventana), y lo del juego
  private loadTrozoJob(t: Trozo): { run(deadline: number): boolean } {
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
    return { run: (deadline: number) => {
      if (!stamp) {
        const r = generateRegion(spec, { x0: tx * C, y0: ty * C, z0: 0, width: C, depth: C, height: spec.height });
        stamp = this.grid.stampRegionJob(r, [(tx - this.tx0) * C, (ty - this.ty0) * C, 0]);
        if (performance.now() >= deadline) return false;
      }
      if (!stamp.run(deadline)) return false;
      this.o.onLoad?.(t, this.ctx(t));
      this.loaded.add(`${tx},${ty}`);
      return true;
    } };
  }
}
