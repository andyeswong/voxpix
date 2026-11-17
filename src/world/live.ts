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
import type { Palette } from '../core';
import { StaticVoxels, WorldState, CHUNK } from './state';
import { BlockGrid, type BlockSet } from './blocks';
import type { Yaw } from './edit';
import { generateRegion, type RegionSpec } from './regiongen';
import { bakeWorld, shiftBakedJob, rebakeChangedJobs, type Baked, type ShiftJob, type ViewJob } from './bake';

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
  fill?(t: Trozo, ctx: TrozoCtx): { run(deadline: number): boolean } | void;
  onUnload?(t: Trozo, ctx: TrozoCtx): void;
  onLoad?(t: Trozo, ctx: TrozoCtx): void;
  onShift?(d: { cells: readonly [number, number]; voxels: readonly [number, number] }): void;
}

export class LiveWindow {
  readonly store: StaticVoxels;
  readonly state: WorldState;
  readonly grid: BlockGrid;
  baked: Baked;
  readonly T: number;                  // vóxeles por lado de un trozo
  tx0: number; ty0: number;            // la esquina de la ventana (trozos del mundo)
  private readonly o: Required<Pick<LiveWindowOptions, 'band'>> & LiveWindowOptions;
  private readonly m: { x: number; n: number; s: number };
  private readonly C: number;          // bloques por lado de un trozo
  private shiftJob: ShiftJob | null = null;
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
    this.baked = bakeWorld({ model: this.store, lights: this.state.lights, width: this.store.width, depth: this.store.depth }, { topZ: this.store.zMax + 1, ...(opts.bake ?? {}) });
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
  get busy(): boolean { return !!this.shiftJob || this.loading.length > 0 || !!this.loadJob; }

  // Cada cuadro: con el objetivo en (x, y) del MUNDO, decide si correr la ventana y mete su trabajo en la cola. Se corre un
  // trozo cada vez, hacia donde haga falta para que el del objetivo quede a margin trozos o más del borde
  update(x: number, y: number, budget: { push(job: ViewJob): void }): void {
    const [tx, ty] = this.trozoOf(x, y), m = this.m, { nx, ny } = this.o;
    let dx = 0, dy = 0;
    if (tx - this.tx0 < m.x) dx = -1; else if (this.tx0 + nx - 1 - tx < m.x) dx = 1;
    if (ty - this.ty0 < m.s) dy = -1; else if (this.ty0 + ny - 1 - ty < m.n) dy = 1;
    if ((dx || dy) && !this.shiftJob && !this.loading.length && !this.loadJob) this.startShift(dx, dy);
    if (this.shiftJob) budget.push(this.shiftJob);
    if (!this.shiftJob && this.loading.length && !this.loadJob) this.nextLoad();
    if (this.loadJob) budget.push(this.loadJob);
    // Lo escrito (los trozos que entraron, con lo del juego), a rehornear
    if (this.pendingRebake && !this.shiftJob) {
      this.pendingRebake = false;
      for (const j of rebakeChangedJobs(this.baked, this.state.lights)) budget.push(j);
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
    // En el cambio (el mismo cuadro que los vóxeles y la imagen): la rejilla, las entidades, las luces y el juego
    const k = this.T / CHUNK, job = shiftBakedJob(this.baked, dx * k, dy * k, { band: this.o.band, onSwitch: () => this.onSwitch(dx, dy) });
    this.shiftTo = [ntx, nty];
    // (envuelto: al acabar, el resto del corrimiento)
    this.shiftJob = { ...job, key: job.key, run: (deadline: number) => { const done = job.run(deadline); if (done) this.afterShift(dx, dy); return done; }, merge: job.merge, get done() { return job.done; }, get shift() { return job.shift; }, ms: job.ms };
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
    this.shiftJob = null; this.shiftTo = null;
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
    this.loadJob = { key: `trozo:${t[0]},${t[1]}`, priority: 70, run: (deadline: number) => {
      if (!job.run(deadline)) return false;
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
