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
// El juego: onUnload(t, read) cuando un trozo sale (para guardar sus diferencias; read(x, y, z) en coordenadas del mundo,
// aún con lo de ese trozo), onLoad(t, write) cuando entra, ya generado y escrito, antes de hornearlo (para poner las
// diferencias guardadas; write en coordenadas del mundo), y onShift(dx, dy) cuando el origen local se corre (en vóxeles).
import type { Palette } from '../core';
import { StaticVoxels, WorldState, CHUNK } from './state';
import { BlockGrid, type BlockSet } from './blocks';
import { generateRegion, type RegionSpec } from './regiongen';
import { bakeWorld, shiftBakedJob, rebakeChangedJobs, type Baked, type ShiftJob, type ViewJob } from './bake';

export type Trozo = readonly [number, number];
export interface LiveWindowOptions {
  blocks: BlockSet;
  spec: RegionSpec;                    // el mundo (generateRegion); height en bloques
  nx: number; ny: number;              // trozos de la ventana
  chunk?: number;                      // bloques por lado de un trozo (16)
  center?: Trozo;                      // el trozo del mundo donde empieza el objetivo (la ventana, centrada en él)
  bake?: Parameters<typeof bakeWorld>[1];
  // Trozos que tiene que haber entre el del objetivo y el borde de la ventana; al quedar menos, se corre (2)
  margin?: number;
  band?: number;                       // filas de la imagen por paso al correrla (shiftBakedJob)
  onUnload?(t: Trozo, read: (x: number, y: number, z: number) => number): void;
  onLoad?(t: Trozo, write: (x: number, y: number, z: number, v: number) => void): void;
  onShift?(dx: number, dy: number): void;
}

export class LiveWindow {
  readonly store: StaticVoxels;
  readonly state: WorldState;
  readonly grid: BlockGrid;
  baked: Baked;
  readonly T: number;                  // vóxeles por lado de un trozo
  tx0: number; ty0: number;            // la esquina de la ventana (trozos del mundo)
  private readonly o: Required<Pick<LiveWindowOptions, 'margin' | 'band'>> & LiveWindowOptions;
  private readonly C: number;          // bloques por lado de un trozo
  private shiftJob: ShiftJob | null = null;
  private shiftTo: Trozo | null = null;
  private loading: Trozo[] = [];       // los que entraron y faltan por escribir
  private loadJob: ViewJob | null = null;
  private loaded = new Set<string>();

  constructor(opts: LiveWindowOptions) {
    this.o = { margin: 2, band: 32, ...opts };
    this.C = opts.chunk ?? 16;
    const B = opts.blocks.size;
    this.T = this.C * B;
    if (this.T % CHUNK) throw new Error(`LiveWindow: el trozo (${this.T} vóxeles) tiene que ser múltiplo de ${CHUNK}`);
    const [cx, cy] = opts.center ?? [0, 0];
    this.tx0 = cx - Math.floor(opts.nx / 2); this.ty0 = cy - Math.floor(opts.ny / 2);
    this.store = new StaticVoxels(opts.blocks.palette as Palette, opts.nx * this.T, opts.ny * this.T, 0, opts.spec.height * B - 1);
    this.state = new WorldState(this.store, [], null);
    this.grid = new BlockGrid(this.state, opts.blocks);
    for (let ty = this.ty0; ty < this.ty0 + opts.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + opts.nx; tx++) {
      const job = this.loadTrozoJob([tx, ty]);
      while (!job.run(Infinity));
    }
    this.baked = bakeWorld({ model: this.store, lights: this.state.lights, width: this.store.width, depth: this.store.depth }, { topZ: this.store.zMax + 1, ...(opts.bake ?? {}) });
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
    const [tx, ty] = this.trozoOf(x, y), m = this.o.margin, { nx, ny } = this.o;
    let dx = 0, dy = 0;
    if (tx - this.tx0 < m) dx = -1; else if (this.tx0 + nx - 1 - tx < m) dx = 1;
    if (ty - this.ty0 < m) dy = -1; else if (this.ty0 + ny - 1 - ty < m) dy = 1;
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
      this.o.onUnload?.([tx, ty], (x, y, z) => { const [lx, ly] = this.toLocal(x, y); return this.store.get(lx, ly, z); });
      this.loaded.delete(`${tx},${ty}`);
    }
    const k = this.T / CHUNK, job = shiftBakedJob(this.baked, dx * k, dy * k, { band: this.o.band });
    this.shiftTo = [ntx, nty];
    // (envuelto: al acabar, el resto del corrimiento)
    this.shiftJob = { ...job, key: job.key, run: (deadline: number) => { const done = job.run(deadline); if (done) this.afterShift(dx, dy); return done; }, merge: job.merge, get done() { return job.done; }, get shift() { return job.shift; }, ms: job.ms };
  }

  private afterShift(dx: number, dy: number): void {
    const [ntx, nty] = this.shiftTo!, DX = dx * this.T, DY = dy * this.T, { nx, ny } = this.o;
    this.shiftJob = null; this.shiftTo = null;
    // Las entidades y las luces, en el marco nuevo (las del mundo no cambian)
    for (const e of [...this.state.entities]) this.state.entities.move(e.id, e.x - DX, e.y - DY, e.z, e.yaw);
    for (const l of this.state.lights) { l.x -= DX; l.y -= DY; }
    this.o.onShift?.(DX, DY);
    // Los que entran, del centro hacia fuera
    const old = [ntx - dx, nty - dy], entered: Trozo[] = [];
    for (let ty = nty; ty < nty + ny; ty++) for (let tx = ntx; tx < ntx + nx; tx++) {
      if (tx >= old[0]! && tx < old[0]! + nx && ty >= old[1]! && ty < old[1]! + ny) continue;
      entered.push([tx, ty]);
    }
    this.tx0 = ntx; this.ty0 = nty;
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
    let stamp: { run(deadline: number): boolean } | null = null;
    return { run: (deadline: number) => {
      if (!stamp) {
        const r = generateRegion(spec, { x0: tx * C, y0: ty * C, z0: 0, width: C, depth: C, height: spec.height });
        stamp = this.grid.stampRegionJob(r, [(tx - this.tx0) * C, (ty - this.ty0) * C, 0]);
        if (performance.now() >= deadline) return false;
      }
      if (!stamp.run(deadline)) return false;
      this.o.onLoad?.(t, (x, y, z, v) => { const [lx, ly] = this.toLocal(x, y); this.store.set(lx, ly, z, v); });
      this.loaded.add(`${tx},${ty}`);
      return true;
    } };
  }
}
