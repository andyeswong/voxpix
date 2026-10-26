// VISTA GIRADA (NARUTO): ver el mundo desde otro lado en cuartos de vuelta, sin que la simulación se entere.
//
// El render 2D (horneado, frame2D, compositor de la GPU, agua, gotas) está escrito para la cámara oblicua que mira al
// norte. En vez de generalizar cada fórmula, se gira EL MUNDO PARA LA VISTA: ViewCamera es la única que conoce la
// transformación, y WorldView le da al render un estado ya girado (los vóxeles estáticos, las entidades, las luces,
// el agua y las gotas) con la misma forma que el de verdad. El render no cambia; el oráculo CPU contra GPU sigue
// siendo el juez, en los 4 giros.
//
//   const view = new WorldView(state, 1);            // la cámara en el este, mirando al oeste
//   const baked = bakeWorld(view.bakeable(), { incline: 0.5 });
//   cada cuadro: const rs = view.frame();             // pone al día la vista (vóxeles que cambiaron, entidades...)
//                for (const j of rebakeChangedJobs(baked, rs.lights)) budget.push(j);
//                compositor.frame(rs, baked, opciones);
//   puntero:     view.voxelAt(baked, sx, sy) o view.pointAt(baked, sx, sy) dan coordenadas del MUNDO
//
// Cuartos: 0 = la cámara al sur mirando al norte (lo de siempre), 1 = al este mirando al oeste, 2 = al norte mirando
// al sur, 3 = al oeste mirando al este. En la vista, "arriba" es lejos de la cámara.
//
// FUERA DE ALCANCE (a propósito, sin cerrarles la puerta): el giro continuo y otras proyecciones u elevaciones.
// ViewCamera es el único sitio que sabe cómo se pasa del mundo a la vista: otra cámara sería otra implementación de
// esta clase, sin tocar el render ni el juego.
//
// Las paredes y lo que cambia con el lado de la cámara son CONTENIDO: el motor no decide qué pared es alta. El juego
// lo hace con un vestido (ViewDress): new WorldView(state, q, { dress }) o prepareViewJob(..., { dress }). El vestido
// cambia la copia de la vista (nunca el mundo), se vuelve a aplicar donde el mundo cambia y puede esconder luces
// (view.hideLight), que entonces ni se hornean ni se pintan.
import { CHUNK, StaticVoxels, type Entity, type RenderState, type WaterSurface, type DropSource, type WorldState } from './state';
import type { WorldLight } from './build';
import type { Bakeable, Baked, ViewJob } from './bake';
import { bakeWorld, bakeWorldJob, worldPointAt } from './bake';
import { unkey, type Palette } from '../core';
import { drawWater, WATER_CELL, type WaterLayer } from './water';
import { drawDrops, MAX_DROPS } from './particles';

export type Quarter = 0 | 1 | 2 | 3;

// La transformación entre el mundo (x este, y norte) y la vista girada. Tres formas, según lo que se transforma:
//   - celdas (índices de vóxel o de columna): la celda (x, y) va a la celda de la vista que la contiene;
//   - puntos (posiciones continuas: luces, gotas, el punto bajo el puntero): giro exacto del plano;
//   - direcciones (focos) y giros (el yaw de las entidades).
export class ViewCamera {
  readonly viewWidth: number;
  readonly viewDepth: number;
  constructor(readonly quarter: Quarter, readonly width: number, readonly depth: number) {
    const odd = quarter % 2 === 1;
    this.viewWidth = odd ? depth : width;
    this.viewDepth = odd ? width : depth;
  }

  cellToView(x: number, y: number): [number, number] {
    const W = this.width, D = this.depth;
    switch (this.quarter) {
      case 0: return [x, y];
      case 1: return [y, W - 1 - x];
      case 2: return [W - 1 - x, D - 1 - y];
      case 3: return [D - 1 - y, x];
    }
  }
  cellToWorld(vx: number, vy: number): [number, number] {
    const W = this.width, D = this.depth;
    switch (this.quarter) {
      case 0: return [vx, vy];
      case 1: return [W - 1 - vy, vx];
      case 2: return [W - 1 - vx, D - 1 - vy];
      case 3: return [vy, D - 1 - vx];
    }
  }
  pointToView(x: number, y: number): [number, number] {
    const W = this.width, D = this.depth;
    switch (this.quarter) {
      case 0: return [x, y];
      case 1: return [y, W - x];
      case 2: return [W - x, D - y];
      case 3: return [D - y, x];
    }
  }
  pointToWorld(vx: number, vy: number): [number, number] {
    const W = this.width, D = this.depth;
    switch (this.quarter) {
      case 0: return [vx, vy];
      case 1: return [W - vy, vx];
      case 2: return [W - vx, D - vy];
      case 3: return [vy, D - vx];
    }
  }
  dirToView(dx: number, dy: number): [number, number] {
    switch (this.quarter) {
      case 0: return [dx, dy];
      case 1: return [dy, -dx];
      case 2: return [-dx, -dy];
      case 3: return [-dy, dx];
    }
  }
  dirToWorld(dx: number, dy: number): [number, number] {
    switch (this.quarter) {
      case 0: return [dx, dy];
      case 1: return [-dy, dx];
      case 2: return [-dx, -dy];
      case 3: return [dy, -dx];
    }
  }
  // yaw en grados: 0 = mira al sur (a la cámara de siempre), 90 = al este
  yawToView(yaw: number): number { return (((yaw - 90 * this.quarter) % 360) + 360) % 360; }
  yawToWorld(yaw: number): number { return (((yaw + 90 * this.quarter) % 360) + 360) % 360; }
}

// Los vóxeles estáticos vistos desde la cámara: una copia girada que se pone al día con los trozos que cambian
// (así el horneado y el rehorneado por trozos funcionan igual, con sus versiones)
function rotatedStatic(src: StaticVoxels, cam: ViewCamera): StaticVoxels {
  const s = new StaticVoxels(src.palette, cam.viewWidth, cam.viewDepth, src.zMin, src.zMax);
  for (const [x, y, z, v] of src.entries()) { const [vx, vy] = cam.cellToView(x, y); s.set(vx, vy, z, v); }
  return s;
}

// El agua vista desde la cámara: su propia rejilla de celdas en ejes de la vista (con lados impares, las celdas
// giradas no caen sobre las del mundo), que toma de cada celda del mundo bajo su centro el fondo, si es pared, si es
// cuenca y, cada cuadro, la profundidad. La física sigue en el mundo.
class WaterView implements WaterSurface {
  readonly gw: number;
  readonly gh: number;
  readonly sim: { depth: Float32Array; ground: Float32Array; solid: Uint8Array };
  readonly basin: Uint8Array;
  private readonly map: Int32Array;
  constructor(private readonly src: WaterLayer, cam: ViewCamera) {
    this.gw = Math.ceil(cam.viewWidth / WATER_CELL);
    this.gh = Math.ceil(cam.viewDepth / WATER_CELL);
    const n = this.gw * this.gh;
    this.sim = { depth: new Float32Array(n), ground: new Float32Array(n), solid: new Uint8Array(n) };
    this.basin = new Uint8Array(n);
    this.map = new Int32Array(n);
    for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) {
      const i = gy * this.gw + gx;
      const [x, y] = cam.pointToWorld(Math.min(cam.viewWidth, gx * WATER_CELL + WATER_CELL / 2), Math.min(cam.viewDepth, gy * WATER_CELL + WATER_CELL / 2));
      const wx = Math.floor(Math.min(cam.width - 1e-6, x) / WATER_CELL), wy = Math.floor(Math.min(cam.depth - 1e-6, y) / WATER_CELL);
      const j = wx < 0 || wy < 0 || wx >= src.gw || wy >= src.gh ? -1 : wy * src.gw + wx;
      this.map[i] = j;
      if (j < 0) { this.sim.solid[i] = 1; continue; }
      this.sim.ground[i] = src.sim.ground[j]!;
      this.sim.solid[i] = src.sim.solid[j]!;
      this.basin[i] = src.isBasin(j) ? 1 : 0;
    }
  }
  refresh(): void {
    const d = this.src.sim.depth, out = this.sim.depth, m = this.map;
    for (let i = 0; i < m.length; i++) out[i] = m[i]! < 0 ? 0 : d[m[i]!]!;
  }
  get toneColors(): ReadonlyArray<readonly [number, number, number]> { return this.src.toneColors; }
  get tones(): ReadonlyArray<readonly [number, number, number]> { return this.src.toneColors; }
  isBasin(i: number): boolean { return this.basin[i] === 1; }
  draw(...args: Parameters<WaterSurface['draw']>): void { drawWater(this, ...args); }
}

// Las gotas vistas desde la cámara: sus posiciones giradas, cada cuadro
class DropsView implements DropSource {
  private readonly d = new Float32Array(MAX_DROPS * 8);
  private n = 0;
  constructor(private readonly src: DropSource, private readonly cam: ViewCamera) {}
  refresh(): void {
    this.n = this.src.count;
    for (let k = 0; k < this.n; k++) {
      const [x, y, z] = this.src.at(k);
      const [vx, vy] = this.cam.pointToView(x, y);
      this.d[k * 8] = vx; this.d[k * 8 + 1] = vy; this.d[k * 8 + 2] = z;
    }
  }
  get count(): number { return this.n; }
  at(k: number): [number, number, number] { const o = k * 8; return [this.d[o]!, this.d[o + 1]!, this.d[o + 2]!]; }
  draw(...args: Parameters<DropSource['draw']>): void { drawDrops(this.d, this.n, ...args); }
}

// Vestir la vista: el contenido que depende del lado de la cámara (bajar la pared de delante, quitar lo que tapa).
// Se llama sobre view.static (la copia de la vista, nunca el mundo) con changed = null la primera vez, antes de
// hornear, y después con los trozos de la vista que se acaban de volver a copiar del mundo (lo vestido en ellos se
// perdió). Puede poner view.hideLight para las luces que cuelgan de lo quitado: no se hornean ni se pintan.
export type ViewDress = (view: WorldView, changed: readonly number[] | null) => void;
export interface WorldViewOptions { dress?: ViewDress }

export class WorldView implements RenderState {
  readonly camera: ViewCamera;
  readonly static: StaticVoxels;
  entities: Entity[] = [];
  lights: WorldLight[] = [];
  readonly water: WaterSurface | null;
  readonly drops: DropSource;
  private synced: number;
  private readonly waterView: WaterView | null = null;
  private readonly dropsView: DropsView | null = null;
  private readonly dress: ViewDress | null;
  // Las luces que esta vista no enseña (las de lo que el vestido quitó): ni se hornean ni se pintan
  hideLight: ((light: WorldLight) => boolean) | null = null;

  // pre: los vóxeles ya copiados (los de prepareViewJob) y el reloj del mundo cuando se empezaron a copiar
  constructor(readonly state: WorldState, quarter: Quarter, opts: WorldViewOptions = {}, pre?: { static: StaticVoxels; since: number }) {
    const src = state.solid;
    this.camera = new ViewCamera(quarter, src.width, src.depth);
    this.dress = opts.dress ?? null;
    // Sin girar y sin vestir, el render ve el estado de verdad, sin copias. Vestida, la vista tiene su copia también
    // en el giro 0: el vestido no toca nunca el mundo de la simulación.
    this.static = quarter === 0 && !this.dress ? src : pre?.static ?? rotatedStatic(src, this.camera);
    if (quarter === 0) {
      this.water = state.water;
      this.drops = state.drops;
    } else {
      this.waterView = state.water ? new WaterView(state.water, this.camera) : null;
      this.dropsView = new DropsView(state.drops, this.camera);
      this.water = this.waterView;
      this.drops = this.dropsView;
    }
    this.synced = pre ? pre.since : src.clock;
    this.refresh();
    this.dress?.(this, null);
  }

  // ¿La vista tiene su propia copia de los vóxeles? (girada o vestida)
  get copied(): boolean { return this.static !== this.state.solid; }

  get quarter(): Quarter { return this.camera.quarter; }
  get palette(): Palette { return this.state.palette; }

  // Lo que se hornea: los vóxeles estáticos girados y las luces del mundo en ejes de la vista (bakeWorld solo hornea
  // las fijas)
  bakeable(): Bakeable {
    this.refresh();
    return { model: this.static, lights: this.lights, width: this.camera.viewWidth, depth: this.camera.viewDepth };
  }

  // Pone la vista al día con el mundo y la devuelve para el render: los vóxeles que cambiaron (el rehorneado los
  // encuentra con sus versiones, como siempre), las entidades, las luces, el agua y las gotas de este cuadro
  frame(): RenderState { this.refresh(); return this.copied || this.hideLight ? this : this.state; }

  private refresh(): void {
    const st = this.state, cam = this.camera;
    const src = st.solid;
    if (this.copied) {
      this.static.palette = src.palette;
      // Los trozos del mundo que cambiaron: se copian girados, y se vuelven a vestir los de la vista que tocan
      const changed = src.changedSince(this.synced);
      const touched = new Set<number>();
      for (const c of changed) {
        const cx = (c % src.cols) * CHUNK, cy = Math.floor(c / src.cols) * CHUNK;
        for (let y = cy; y < Math.min(src.depth, cy + CHUNK); y++) for (let x = cx; x < Math.min(src.width, cx + CHUNK); x++) {
          const [vx, vy] = cam.cellToView(x, y);
          for (let z = src.zMin; z <= src.zMax; z++) this.static.set(vx, vy, z, src.get(x, y, z));
          touched.add(Math.floor(vy / CHUNK) * this.static.cols + Math.floor(vx / CHUNK));
        }
      }
      this.synced = src.clock;
      if (touched.size && this.dress) this.dress(this, [...touched]);
    }
    const hide = this.hideLight;
    if (this.quarter === 0) { this.entities = st.entities; this.lights = hide ? st.lights.filter((l) => !hide(l)) : st.lights; return; }
    // Entidades: su celda y su giro en la vista (la entidad del mundo no se toca)
    this.entities = st.entities.map((e) => { const [x, y] = cam.cellToView(e.x, e.y); return { ...e, x, y, yaw: cam.yawToView(e.yaw) }; });
    // Luces: su punto y su foco en la vista (el mismo id: el mismo parpadeo)
    this.lights = (hide ? st.lights.filter((l) => !hide(l)) : st.lights).map((l) => {
      const [x, y] = cam.pointToView(l.x, l.y);
      const dir = l.dir ? [...cam.dirToView(l.dir[0], l.dir[1]), l.dir[2]] as const : undefined;
      return { ...l, x, y, ...(dir ? { dir } : {}) };
    });
    this.waterView?.refresh();
    this.dropsView?.refresh();
  }

  // Una caja del mundo (x0, y0, z0, x1, y1, z1, celdas incluidas) en ejes de esta vista: para Frame2DOptions.highlight
  viewBox(box: readonly [number, number, number, number, number, number]): [number, number, number, number, number, number] {
    const [ax, ay] = this.camera.cellToView(box[0], box[1]), [bx, by] = this.camera.cellToView(box[3], box[4]);
    return [Math.min(ax, bx), Math.min(ay, by), Math.min(box[2], box[5]), Math.max(ax, bx), Math.max(ay, by), Math.max(box[2], box[5])];
  }

  // ---- de la pantalla al mundo (puntero y toques)
  // El vóxel (en ejes del MUNDO) que se ve en un píxel de la imagen horneada de esta vista, o null
  voxelAt(b: Baked, sx: number, sy: number): [number, number, number] | null {
    if (sx < 0 || sy < 0 || sx >= b.width || sy >= b.height) return null;
    const k = b.pick[sy * b.width + sx]!;
    if (Number.isNaN(k)) return null;
    const [vx, vy, z] = unkey(k);
    const [x, y] = this.camera.cellToWorld(vx, vy);
    return [x, y, z];
  }
  // El punto exacto (en ejes del MUNDO) que se ve en un píxel, o null
  pointAt(b: Baked, sx: number, sy: number): [number, number, number] | null {
    if (sx < 0 || sy < 0 || sx >= b.width || sy >= b.height) return null;
    const p = worldPointAt(b, sx, sy);
    if (!p) return null;
    const [x, y] = this.camera.pointToWorld(p[0], p[1]);
    return [x, y, p[2]];
  }
}

// Un giro preparado sin congelar la vista: la copia girada de los vóxeles (por trozos del mundo) y su horneado, como
// UN trabajo que se reanuda (ViewJob; la cola con presupuesto de la vista lo reparte entre cuadros). Para tener los
// otros giros listos en segundo plano o hornear el siguiente antes de girar. Mientras no acaba, result() da null.
// Lo que cambie en el mundo mientras tanto lo recogen después view.frame() y rebakeChangedJobs, como siempre.
//
//   const prep = prepareViewJob(state, 2, { topZ: 40, incline: 0.5 });
//   budget.push(prep.job);                          // y al girar: const r = prep.result() (si es null, aún no está)
//
// Etapas (prep.stage()), y run() no pasa de una a otra en la misma llamada, para que el juego decida dónde cae cada
// una (p. ej. en la partida solo 'bake', y el resto en los respiros):
//   'copy'  la copia girada de los vóxeles, por trozos (reserva memoria que se queda: puede despertar al recolector);
//   'view'  la vista: el vestido entero y la rejilla del agua girada, de una vez;
//   'alloc' la reserva de los búferes del horneado (imagen, profundidad, vóxel, cara y rejilla de sombras), de una vez;
//   'bake'  el horneado por pasos que se adaptan a lo que tardan;
//   'done'.
export type PrepStage = 'copy' | 'view' | 'alloc' | 'bake' | 'done';
export function prepareViewJob(state: WorldState, quarter: Quarter, bakeOpts: Parameters<typeof bakeWorld>[1] = {}, viewOpts: WorldViewOptions = {}): { job: ViewJob; stage(): PrepStage; result(): { view: WorldView; baked: Baked } | null } {
  const src = state.solid;
  const cam = new ViewCamera(quarter, src.width, src.depth);
  const since = src.clock;
  const rotated = quarter === 0 && !viewOpts.dress ? null : new StaticVoxels(src.palette, cam.viewWidth, cam.viewDepth, src.zMin, src.zMax);
  const nChunks = src.cols * src.rows;
  let c = 0;
  let done: { view: WorldView; baked: Baked } | null = null;
  let bake: { baked: Baked; job: ViewJob } | null = null;
  let view: WorldView | null = null;
  const job: ViewJob = {
    key: `view:${quarter}`,
    run(deadline) {
      if (done) return true;
      switch (stage()) {
        case 'copy':
          // La copia girada, un trozo del mundo cada vez; al acabarla, se para (la etapa siguiente, en otra llamada)
          while (rotated && c < nChunks) {
            const cx = (c % src.cols) * CHUNK, cy = Math.floor(c / src.cols) * CHUNK;
            for (const [x, y, z, v] of src.entries({ x0: cx, y0: cy, x1: cx + CHUNK - 1, y1: cy + CHUNK - 1 })) { const [vx, vy] = cam.cellToView(x, y); rotated.set(vx, vy, z, v); }
            c++;
            if (performance.now() >= deadline) break;
          }
          return false;
        case 'view':
          view = new WorldView(state, quarter, viewOpts, rotated ? { static: rotated, since } : undefined);
          return false;
        case 'alloc':
          bake = bakeWorldJob(view!.bakeable(), bakeOpts, `bake:${quarter}`);
          return false;
        default:
          if (!bake!.job.run(deadline)) return false;
      }
      done = { view: view!, baked: bake!.baked };
      return true;
    },
  };
  function stage(): PrepStage {
    if (done) return 'done';
    if (rotated && c < nChunks) return 'copy';
    if (!view) return 'view';
    if (!bake) return 'alloc';
    return 'bake';
  }
  return { job, stage, result: () => done };
}
