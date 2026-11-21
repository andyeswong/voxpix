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
import { CHUNK, StaticVoxels, shiftGrid, type Entity, type RenderState, type WaterSurface, type DropSource, type WorldState } from './state';
import type { WorldLight } from './build';
import type { Bakeable, Baked, ViewJob } from './bake';
import { bakeWorld, bakeWorldJob, worldPointAt } from './bake';
import { unkey, type Palette } from '../core';
import { drawWater, WATER_CELL, WATER_TILE, type WaterLayer } from './water';
import { drawDrops, MAX_DROPS } from './particles';
import { FX_STRIDE, type FxSource } from '../core';
import { fxWorldLights, type EffectsLayer } from './effects';

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
  if (StaticVoxels.slabCopyable(src, cam.quarter)) { s.copyRotatedSlabs(src, cam.quarter, 0, src.cols * src.rows * src.nz); return s; }
  for (const [x, y, z, v] of src.entries()) { const [vx, vy] = cam.cellToView(x, y); s.set(vx, vy, z, v); }
  return s;
}

// El agua vista desde la cámara: su propia rejilla de celdas en ejes de la vista (con lados impares, las celdas
// giradas no caen sobre las del mundo), que toma de cada celda del mundo bajo su centro el fondo, si es pared, si es
// cuenca y, cada cuadro, la profundidad. La física sigue en el mundo.
const OPS_LOG = 64;
class WaterView implements WaterSurface {
  readonly gw: number;
  readonly gh: number;
  readonly sim: { depth: Float32Array; ground: Float32Array; solid: Uint8Array };
  readonly basin: Uint8Array;
  private readonly map: Int32Array;
  // Lo copiado: hasta qué cambio del agua (WaterLayer.changesSince), si falta la primera copia entera, y las columnas del
  // mundo cuyo corte cambió desde la última (en celdas del agua; x0 > x1: ninguna)
  private seq = 0;
  private full = true;
  private readonly cutBox = Int32Array.of(0x7fffffff, 0x7fffffff, -1, -1);
  // Celdas recorridas por la última copia (para medir y probar)
  visited = 0;
  // Lo que cambió del fondo, las paredes y las cuencas (lo que la GPU guarda en una textura), para staticSince: un
  // registro de corrimientos (en celdas de la vista) y cajas de celdas cambiadas, con su versión
  private sv = 0;
  private readonly ops: Array<{ v: number; shift: readonly [number, number] | null; box: readonly [number, number, number, number] | null }> = [];
  // Los corrimientos de la capa que esta vista corrió consigo (shift): si la capa se corrió sin ella, se copia entera
  private shifts = 0;
  // La caja de lo que cambió del fondo en la copia de este cuadro (celdas de la vista; x0 > x1: nada)
  private readonly sbox = new Int32Array(4);
  // hideAbove (opcional, con el corte de la vista): por columna del MUNDO, desde qué z está cortada. El agua de una celda
  // cuya superficie pasa de ahí no se dibuja (como lo cortado)
  constructor(private readonly src: WaterLayer, private readonly cam: ViewCamera, private readonly hideAbove: ((x: number, y: number) => number) | null = null) {
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
      // (map: la celda de la rejilla del agua, wy * gw + wx; su sitio en los arrays, en el anillo, es src.sim.at(wx, wy))
      const j = wx < 0 || wy < 0 || wx >= src.gw || wy >= src.gh ? -1 : wy * src.gw + wx;
      this.map[i] = j;
      if (j < 0) { this.sim.solid[i] = 1; continue; }
      const p = src.sim.at(wx, wy);
      this.sim.ground[i] = src.sim.ground[p]!;
      this.sim.solid[i] = src.sim.solid[p]!;
      this.basin[i] = src.isBasin(p) ? 1 : 0;
    }
  }
  // Cada cuadro: la profundidad, y también el fondo, la pared y la cuenca (cambian si el agua sigue al mundo:
  // WaterLayer.follow); con corte, sin el agua que queda por encima de lo cortado. Solo las celdas de la vista que caen
  // en lo que cambió desde la copia anterior (WaterLayer.changesSince, y las columnas cuyo corte cambió): con el agua
  // quieta, nada. Copiar una celda de más no cambia nada (es la misma copia)
  refresh(): void {
    if (this.shifts !== this.src.shiftCount) { this.shifts = this.src.shiftCount; this.full = true; }
    // Lo que cambió, por baldosas (changedTiles), y las columnas cuyo corte cambió
    const ch = this.src.changedTiles(this.seq);
    this.seq = ch.seq;
    this.visited = 0;
    this.sbox[0] = this.gw; this.sbox[1] = this.gh; this.sbox[2] = -1; this.sbox[3] = -1;
    const c = this.cutBox;
    // (la copia entera apunta, como cualquiera, la caja de lo que cambió del fondo: quien lo guarda sube solo eso)
    if (this.full || ch.all) { this.full = false; this.copy(0, 0, this.gw - 1, this.gh - 1); }
    else {
      const T = WATER_TILE, tx = this.src.tilesX;
      for (const k of ch.tiles) {
        const x0 = (k % tx) * T, y0 = Math.floor(k / tx) * T;
        this.copyWorld(x0, y0, Math.min(this.src.gw - 1, x0 + T - 1), Math.min(this.src.gh - 1, y0 + T - 1));
      }
      if (c[0]! <= c[2]!) this.copyWorld(c[0]!, c[1]!, c[2]!, c[3]!);
    }
    c[0] = c[1] = 0x7fffffff; c[2] = c[3] = -1;
    const b = this.sbox;
    if (b[2]! >= 0) this.log(null, [b[0]!, b[1]!, b[2]!, b[3]!]);
  }
  // Una caja de celdas del mundo, copiada en las celdas de la vista que la cubren (sus esquinas giradas); en los giros, con
  // una de margen: con lados impares las celdas giradas no caen justo sobre las del mundo
  private copyWorld(x0: number, y0: number, x1: number, y1: number): void {
    if (this.cam.quarter === 0) { this.copy(x0, y0, x1, y1); return; }
    const [ax, ay] = this.cam.pointToView(x0 * WATER_CELL, y0 * WATER_CELL), [bx, by] = this.cam.pointToView((x1 + 1) * WATER_CELL, (y1 + 1) * WATER_CELL);
    this.copy(Math.floor(Math.min(ax, bx) / WATER_CELL) - 1, Math.floor(Math.min(ay, by) / WATER_CELL) - 1, Math.ceil(Math.max(ax, bx) / WATER_CELL) + 1, Math.ceil(Math.max(ay, by) / WATER_CELL) + 1);
  }
  // Las columnas del mundo (vóxeles, extremos incluidos) cuyo corte cambió: su agua se vuelve a copiar
  cutChanged(x0: number, y0: number, x1: number, y1: number): void {
    const c = this.cutBox, g = WATER_CELL;
    c[0] = Math.min(c[0]!, Math.floor(x0 / g)); c[1] = Math.min(c[1]!, Math.floor(y0 / g)); c[2] = Math.max(c[2]!, Math.floor(x1 / g)); c[3] = Math.max(c[3]!, Math.floor(y1 / g));
  }
  private copy(gx0: number, gy0: number, gx1: number, gy1: number): void {
    const s = this.src.sim, out = this.sim, m = this.map, hide = this.hideAbove, gw = this.src.gw;
    gx0 = Math.max(0, gx0); gy0 = Math.max(0, gy0); gx1 = Math.min(this.gw - 1, gx1); gy1 = Math.min(this.gh - 1, gy1);
    this.visited += Math.max(0, gx1 - gx0 + 1) * Math.max(0, gy1 - gy0 + 1);
    // (la caja de lo que cambió del fondo, las paredes y las cuencas: se junta en sbox y refresh la apunta una vez)
    const sb = this.sbox;
    let bx0 = sb[0]!, by0 = sb[1]!, bx1 = sb[2]!, by1 = sb[3]!;
    // En el giro 0 sin corte, las celdas de la vista son las del mundo (map es la identidad): por filas, sin map ni at()
    if (this.cam.quarter === 0 && !hide && this.gw === gw) {
      const [ox, oy] = s.origin, H = this.src.gh, sg = s.ground, ss = s.solid, sd = s.depth, sbs = this.src.basin;
      for (let gy = gy0; gy <= gy1; gy++) {
        let py = gy + oy; if (py >= H) py -= H;
        const row = py * gw;
        let px = gx0 + ox; if (px >= gw) px -= gw;
        for (let gx = gx0, i = gy * gw + gx0; gx <= gx1; gx++, i++) {
          const p = row + px;
          const g = sg[p]!, so = ss[p]!, ba = sbs[p] === 1 ? 1 : 0;
          if (out.ground[i] !== g || out.solid[i] !== so || this.basin[i] !== ba) {
            if (gx < bx0) bx0 = gx; if (gx > bx1) bx1 = gx; if (gy < by0) by0 = gy; if (gy > by1) by1 = gy;
            out.ground[i] = g; out.solid[i] = so; this.basin[i] = ba;
          }
          out.depth[i] = sd[p]!;
          if (++px === gw) px = 0;
        }
      }
      sb[0] = bx0; sb[1] = by0; sb[2] = bx1; sb[3] = by1;
      return;
    }
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const i = gy * this.gw + gx, j = m[i]!;
      if (j < 0) { out.depth[i] = 0; continue; }
      const wx = j % gw, wy = (j - wx) / gw, p = s.at(wx, wy);
      const g = s.ground[p]!, so = s.solid[p]!, ba = this.src.isBasin(p) ? 1 : 0;
      if (out.ground[i] !== g || out.solid[i] !== so || this.basin[i] !== ba) {
        if (gx < bx0) bx0 = gx; if (gx > bx1) bx1 = gx; if (gy < by0) by0 = gy; if (gy > by1) by1 = gy;
        out.ground[i] = g; out.solid[i] = so; this.basin[i] = ba;
      }
      let d = s.depth[p]!;
      if (hide && d > 0 && s.ground[p]! + d > hide(wx * WATER_CELL + 1, wy * WATER_CELL + 1)) d = 0;
      out.depth[i] = d;
    }
    sb[0] = bx0; sb[1] = by0; sb[2] = bx1; sb[3] = by1;
  }

  private log(shift: readonly [number, number] | null, box: readonly [number, number, number, number] | null): void {
    this.ops.push({ v: ++this.sv, shift, box });
    if (this.ops.length > OPS_LOG) this.ops.shift();
  }

  // LA VENTANA VIVA (WorldView.shift): el mundo se corrió dx, dy vóxeles (múltiplos de la celda). La copia se corre
  // igual (en ejes de la vista) y lo que entra queda como la franja de la capa (seco, pared, sin cuenca) hasta que se
  // copie lo que cargue; la relación entre las celdas de la vista y las del mundo (map) no cambia: las dos rejillas son
  // de la misma ventana. Apunta el corrimiento para quien guarda el fondo (la GPU, staticSince)
  shift(dx: number, dy: number): void {
    if (!dx && !dy) return;
    const [vdx, vdy] = this.cam.dirToView(dx, dy);
    if (vdx % WATER_CELL || vdy % WATER_CELL) { this.full = true; return; }
    const cx = vdx / WATER_CELL, cy = vdy / WATER_CELL, W = this.gw, H = this.gh;
    shiftGrid(this.sim.depth, W, H, 1, cx, cy, 0);
    shiftGrid(this.sim.ground, W, H, 1, cx, cy, 0);
    shiftGrid(this.sim.solid, W, H, 1, cx, cy, 1);
    shiftGrid(this.basin, W, H, 1, cx, cy, 0);
    this.shifts++;
    this.log([cx, cy], null);
  }

  // Lo que cambió del fondo, las paredes y las cuencas desde la versión v (0 al empezar), para quien lo guarda en una
  // textura: el corrimiento total (en celdas de la vista: la celda (x, y) pasa a tener lo de (x + dx, y + dy); lo que
  // entra, pared seca) y la caja de celdas que hay que volver a subir después de correr, en las coordenadas de ahora; o
  // all si el registro no llega tan atrás (o la copia se rehízo entera)
  staticSince(v: number): { v: number; all: boolean; shift: [number, number] | null; box: [number, number, number, number] | null } {
    if (v === this.sv) return { v, all: false, shift: null, box: null };
    if (!this.ops.length || this.ops[0]!.v > v + 1) return { v: this.sv, all: true, shift: null, box: null };
    let sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    // De la más nueva a la más vieja: cada caja, corrida por los corrimientos que vinieron después
    for (let k = this.ops.length - 1; k >= 0 && this.ops[k]!.v > v; k--) {
      const o = this.ops[k]!;
      if (o.shift) { sx += o.shift[0]; sy += o.shift[1]; continue; }
      const b = o.box!;
      x0 = Math.min(x0, b[0] - sx); y0 = Math.min(y0, b[1] - sy); x1 = Math.max(x1, b[2] - sx); y1 = Math.max(y1, b[3] - sy);
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(this.gw - 1, x1); y1 = Math.min(this.gh - 1, y1);
    return { v: this.sv, all: false, shift: sx || sy ? [sx, sy] : null, box: x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null };
  }
  get zRange(): readonly [number, number] { return this.src.zRange; }
  get groundVersion(): number { return this.src.groundVersion; }
  get toneColors(): ReadonlyArray<readonly [number, number, number]> { return this.src.toneColors; }
  get tones(): ReadonlyArray<readonly [number, number, number]> { return this.src.toneColors; }
  get glow(): number { return this.src.glow; }
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

// Los efectos vistos desde la cámara: sus puntos girados, cada cuadro (las luces, giradas al pedirlas)
class FxView implements FxSource {
  packed = new Float32Array(0);
  count = 0;
  constructor(private readonly cam: ViewCamera) {}
  refresh(src: FxSource): void {
    this.count = src.count;
    const d = src.packed, n = this.count * FX_STRIDE;
    if (this.packed.length < n) this.packed = new Float32Array(Math.max(256 * FX_STRIDE, n * 2));
    this.packed.set(d.subarray(0, n));
    for (let q = 0; q < n; q += FX_STRIDE) {
      const [x, y] = this.cam.pointToView(d[q]!, d[q + 1]!);
      this.packed[q] = x; this.packed[q + 1] = y;
    }
  }
}

// Vestir la vista: el contenido que depende del lado de la cámara (bajar la pared de delante, quitar lo que tapa).
// Se llama sobre view.static (la copia de la vista, nunca el mundo) con changed = null la primera vez, antes de
// hornear, y después con los trozos de la vista que se acaban de volver a copiar del mundo (lo vestido en ellos se
// perdió). Puede poner view.hideLight para las luces que cuelgan de lo quitado: no se hornean ni se pintan.
export type ViewDress = (view: WorldView, changed: readonly number[] | null) => void;
// cut: la vista lleva su copia de los vóxeles también en el giro 0 para poder CORTAR (setCut): esconder lo que queda por
// encima de una altura dentro de una caja, para ver un túnel, una cueva o un interior desde arriba
export interface WorldViewOptions { dress?: ViewDress; cut?: boolean }
// Un corte en ejes del MUNDO: las columnas x0..x1, y0..y1 (incluidas) pierden sus vóxeles de z >= zTop
export interface ViewCut { x0: number; y0: number; x1: number; y1: number; zTop: number }

export class WorldView implements RenderState {
  readonly camera: ViewCamera;
  readonly static: StaticVoxels;
  entities: Entity[] = [];
  lights: WorldLight[] = [];
  water: WaterSurface | null = null;
  drops!: DropSource;
  effects: EffectsLayer | null = null;
  private fxViews: FxView[] = [];
  private synced: number;
  private waterView: WaterView | null = null;
  private dropsView: DropsView | null = null;
  private readonly hideWater: ((x: number, y: number) => number) | null;
  private readonly cutOpt: boolean;
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
    this.static = quarter === 0 && !this.dress && !opts.cut ? src : pre?.static ?? rotatedStatic(src, this.camera);
    // Con corte, el agua también va por la rejilla de la vista (en el giro 0, la misma que la del mundo): así lo que queda
    // por encima de lo cortado no se dibuja
    this.hideWater = opts.cut ? (x: number, y: number) => this.appliedAt(Math.min(src.width - 1, x), Math.min(src.depth - 1, y)) : null;
    this.cutOpt = !!opts.cut;
    if (quarter === 0) this.drops = state.drops;
    else { this.dropsView = new DropsView(state.drops, this.camera); this.drops = this.dropsView; }
    this.setupWater();
    this.synced = pre ? pre.since : src.clock;
    this.refresh();
    this.dress?.(this, null);
  }

  // La copia girada ya está al día con el mundo (la ventana viva: los dos se corrieron igual en el mismo momento): lo que
  // cambió de versión al correrse no se vuelve a copiar
  markSynced(): void { this.synced = this.state.solid.clock; }

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
  // (en el giro 0 sin copia, el estado tal cual; con agua de la vista, WaterView de una capa que se corre, la vista: si no,
  // el render leería la rejilla del agua en anillo como si estuviera en orden)
  frame(): RenderState { this.refresh(); return this.copied || this.hideLight || this.waterView ? this : this.state; }

  private refresh(): void {
    const st = this.state, cam = this.camera;
    const src = st.solid;
    if (this.copied) {
      this.static.palette = src.palette;
      // Los trozos del mundo que cambiaron: se copian girados, y se vuelven a vestir los de la vista que tocan
      const changed = src.changedSince(this.synced);
      const touched = new Set<number>();
      // Sin vestido, por losas (un trozo entero, µs por losa): después de picar o al escribir un trozo entero (la ventana
      // viva) no se va vóxel a vóxel. En cualquier giro, con corte o sin él (la ventana viva con view: { cut: true }: antes
      // cada trozo escrito eran ~1,5 M vóxeles uno a uno, 3,5 s de 4,8 en la carga tras morir en la página de FERN): con
      // corte, se copia el trozo entero y se vuelve a esconder lo que el corte tiene escondido en sus columnas, como lo hace
      // applyCut. (La imagen distinta que salía de vez en cuando con esto era del cielo, no de la copia: 57ad404)
      if (!this.dress && StaticVoxels.slabCopyable(src, this.quarter)) {
        for (const c of changed) {
          this.static.copyRotatedChunk(src, this.quarter, c);
          if (!this.applied || this.uncut(c)) continue;
          const cx = (c % src.cols) * CHUNK, cy = Math.floor(c / src.cols) * CHUNK;
          this.static.viewWrites = true;
          try {
            for (let y = cy; y < Math.min(src.depth, cy + CHUNK); y++) for (let x = cx; x < Math.min(src.width, cx + CHUNK); x++) {
              const cz = this.appliedAt(x, y);
              if (cz === Infinity) continue;
              const [vx, vy] = cam.cellToView(x, y);
              for (let z = Math.max(src.zMin, cz); z <= src.zMax; z++) if (this.static.get(vx, vy, z)) this.static.set(vx, vy, z, 0);
            }
          } finally { this.static.viewWrites = false; }
        }
        changed.length = 0;
        this.synced = src.clock;
      }
      for (const c of changed) {
        const cx = (c % src.cols) * CHUNK, cy = Math.floor(c / src.cols) * CHUNK;
        for (let y = cy; y < Math.min(src.depth, cy + CHUNK); y++) for (let x = cx; x < Math.min(src.width, cx + CHUNK); x++) {
          const [vx, vy] = cam.cellToView(x, y);
          const cz = this.appliedAt(x, y);
          for (let z = src.zMin; z <= src.zMax; z++) this.static.set(vx, vy, z, z >= cz ? 0 : src.get(x, y, z));
          touched.add(Math.floor(vy / CHUNK) * this.static.cols + Math.floor(vx / CHUNK));
        }
      }
      this.synced = src.clock;
      if (touched.size && this.dress) this.dress(this, [...touched]);
    }
    const hide = this.hideLight;
    if (this.quarter === 0) { this.waterView?.refresh(); this.entities = st.entities; this.lights = hide ? st.lights.filter((l) => !hide(l)) : st.lights; this.effects = st.effects; return; }
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
    // Los efectos, girados (mismo orden de sistemas y de puntos)
    const srcs = st.effects.sources;
    while (this.fxViews.length < srcs.length) this.fxViews.push(new FxView(cam));
    srcs.forEach((s, k) => this.fxViews[k]!.refresh(s));
    const views = this.fxViews.slice(0, srcs.length), map = (x: number, y: number) => cam.pointToView(x, y);
    this.effects = {
      sources: views,
      lights: () => [...(st.effectsOn ? fxWorldLights(st.fx, map) : []), ...fxWorldLights(st.simFx, map, 'fxs')],
    };
  }

  // ---- el corte
  // Lo que se quiere: una o varias cajas (recortadas al mundo), y la forma en que se pidió (para currentCut)
  private cut: ViewCut[] = [];
  private cutAsked: ViewCut | ViewCut[] | null = null;
  private applied: Float32Array | null = null;   // por columna del mundo, desde qué z está cortada en la copia (Infinity: nada)
  // Lo que falta por repasar: recuadros de columnas del mundo, y por dónde va el repaso (recuadro y columna dentro)
  private pending: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  private cursor = 0;
  private pendingAt = 0;
  get currentCut(): ViewCut | ViewCut[] | null {
    const c = this.cutAsked;
    return c === null ? null : Array.isArray(c) ? c.map((b) => ({ ...b })) : { ...c };
  }
  // Desde qué z se quiere esconder la columna (x, y) del mundo (Infinity: nada). Con varias cajas, la más baja
  private cutTopAt(x: number, y: number): number {
    let top = Infinity;
    for (const c of this.cut) if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1 && c.zTop < top) top = c.zTop;
    return top;
  }
  // LA VENTANA VIVA (LiveWindow, en el cambio de cada corrimiento): el mundo se corrió dx, dy vóxeles (lo que estaba en
  // la x pasa a x - dx) y la copia de la vista ya se corrió con su horneado. Se corre el corte: desde qué z está
  // escondida cada columna, las cajas (recortadas a la ventana: nunca cubren lo que entra, que queda sin esconder) y lo
  // pendiente, que sigue repasando el cutJob que esté en la cola
  shift(dx: number, dy: number): void {
    const src = this.state.solid, W = src.width, D = src.depth;
    if (this.applied) shiftGrid(this.applied, W, D, 1, dx, dy, Infinity);
    // (el agua de la vista se corre con ella; la capa se corre aparte, como Attached de la ventana)
    this.waterView?.shift(dx, dy);
    const mv = <T extends { x0: number; y0: number; x1: number; y1: number }>(b: T): T => ({ ...b, x0: b.x0 - dx, x1: b.x1 - dx, y0: b.y0 - dy, y1: b.y1 - dy });
    const clip = <T extends { x0: number; y0: number; x1: number; y1: number }>(b: T): T => ({ ...b, x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(W - 1, b.x1), y1: Math.min(D - 1, b.y1) });
    const inside = (b: { x0: number; y0: number; x1: number; y1: number }) => b.x0 <= b.x1 && b.y0 <= b.y1;
    if (this.cutAsked) this.cutAsked = Array.isArray(this.cutAsked) ? this.cutAsked.map(mv) : mv(this.cutAsked);
    this.cut = this.cut.map((b) => clip(mv(b))).filter(inside);
    // (lo pendiente, desde el principio de su caja: repasar una columna que ya tiene su corte no hace nada)
    this.pending = this.pending.map((b) => clip(mv(b))).filter(inside);
    this.cursor = 0; this.pendingAt = 0;
  }

  // El agua de la vista: la del mundo tal cual en el giro 0 sin corte; si no (girada, con corte, o una capa que se corre,
  // movable, que está en anillo), su copia en ejes de la vista (WaterView)
  private setupWater(): void {
    const w = this.state.water;
    if (this.camera.quarter === 0 && !(w && (this.cutOpt || w.movable))) { this.waterView = null; this.water = w; return; }
    this.waterView = w ? new WaterView(w, this.camera, this.hideWater) : null;
    this.water = this.waterView;
  }
  // El agua del mundo cambió (state.water puesto después de crear la vista: LiveWindow.setWater): la vista la toma
  useWater(): void { this.setupWater(); this.waterView?.refresh(); }

  // ¿Ninguna columna del trozo c del mundo está escondida en la copia?
  private uncut(c: number): boolean {
    const src = this.state.solid, cx = (c % src.cols) * CHUNK, cy = Math.floor(c / src.cols) * CHUNK, W = src.width;
    for (let y = cy; y < Math.min(src.depth, cy + CHUNK); y++) for (let x = cx; x < Math.min(W, cx + CHUNK); x++) if (this.applied![y * W + x] !== Infinity) return false;
    return true;
  }

  // Desde qué z está escondida ya en la copia
  private appliedAt(x: number, y: number): number {
    return this.applied ? this.applied[y * this.state.solid.width + x]! : Infinity;
  }

  // Pone, mueve o quita (null) el corte DE UNA VEZ: en la copia de la vista, las columnas de cada caja pierden lo que
  // tienen de su zTop para arriba (una columna en dos cajas, desde la más baja), y las que salen lo recuperan del mundo.
  // Solo se reescriben las columnas cuyo corte cambia (las de las cajas que entran, salen o cambian; una caja que se
  // queda igual no se repasa), así que rebakeChangedJobs rehace solo eso. Varias cajas sirven, por ejemplo, para un
  // corte de casa de muñecas: la de siempre hasta el techo y la mitad del lado de la cámara hasta los pies. Para no
  // parar el cuadro, cutJob. La vista tiene que tener copia (new WorldView(state, q, { cut: true }), o estar girada o
  // vestida). Devuelve cuántas columnas se reescribieron
  setCut(cut: ViewCut | readonly ViewCut[] | null): number {
    this.want(cut);
    return this.applyCut(Infinity).columns;
  }

  // Lo mismo como un trabajo de la cola (FrameBudget): reescribe columnas hasta el plazo de cada cuadro, y lo que va
  // cambiando lo recoge rebakeChangedJobs. Si llega otro corte antes de acabar, el trabajo nuevo (misma key) sigue
  // desde donde está: el resultado es el mismo que con setCut
  cutJob(cut: ViewCut | readonly ViewCut[] | null): ViewJob {
    this.want(cut);
    return { key: 'view-cut', priority: 0, run: (deadline: number) => this.applyCut(deadline).done };
  }

  private want(cut: ViewCut | readonly ViewCut[] | null): void {
    if (!this.copied) throw new Error('para cortar, la vista necesita su copia de los vóxeles: new WorldView(state, giro, { cut: true })');
    this.refresh();
    const src = this.state.solid, old = this.cut;
    const list = cut === null ? [] : Array.isArray(cut) ? cut : [cut as ViewCut];
    this.cutAsked = cut === null ? null : Array.isArray(cut) ? cut.map((b) => ({ ...b })) : { ...(cut as ViewCut) };
    this.cut = list.map((c) => ({ x0: Math.max(0, Math.min(c.x0, c.x1)), y0: Math.max(0, Math.min(c.y0, c.y1)), x1: Math.min(src.width - 1, Math.max(c.x0, c.x1)), y1: Math.min(src.depth - 1, Math.max(c.y0, c.y1)), zTop: c.zTop }));
    // Lo que hay que repasar: lo pendiente, y las cajas que cambian (las viejas que ya no están y las nuevas que no
    // estaban). Una columna cuyo corte cambia está en una de ellas
    const same = (a: ViewCut, b: ViewCut) => a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1 && a.zTop === b.zTop;
    const changed = [...old.filter((b) => !this.cut.some((c) => same(b, c))), ...this.cut.filter((c) => !old.some((b) => same(b, c)))];
    for (const b of changed) {
      if (b.x0 > b.x1 || b.y0 > b.y1) continue;
      if (!this.pending.some((p) => p.x0 === b.x0 && p.y0 === b.y0 && p.x1 === b.x1 && p.y1 === b.y1)) this.pending.push({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    }
    this.cursor = 0; this.pendingAt = 0;
    if (this.cut.length && !this.applied) this.applied = new Float32Array(src.width * src.depth).fill(Infinity);
  }

  // Repasa columnas de lo pendiente hasta el plazo (una por lo menos): reescribe las que no tienen el corte que toca
  private applyCut(deadline: number): { done: boolean; columns: number } {
    if (!this.pending.length) return { done: true, columns: 0 };
    const src = this.state.solid, cam = this.camera;
    let cols = 0, out = false;
    let wx0 = Infinity, wy0 = Infinity, wx1 = -1, wy1 = -1;           // las columnas reescritas (para el agua)
    const touched = new Set<number>();
    // Escrituras de vista: esconder y destapar no es cambiar el mundo (StaticVoxels.viewWrites)
    this.static.viewWrites = true;
    try {
    while (this.pendingAt < this.pending.length && !out) {
      const p = this.pending[this.pendingAt]!, w = p.x1 - p.x0 + 1, n = w * (p.y1 - p.y0 + 1);
      while (this.cursor < n) {
        const x = p.x0 + (this.cursor % w), y = p.y0 + Math.floor(this.cursor / w);
        this.cursor++;
        const was = this.appliedAt(x, y), now = this.cutTopAt(x, y);
        if (was === now) continue;
        const [vx, vy] = cam.cellToView(x, y);
        for (let z = Math.max(src.zMin, Math.min(was, now)); z <= src.zMax; z++) this.static.set(vx, vy, z, z >= now ? 0 : src.get(x, y, z));
        if (this.applied) this.applied[y * src.width + x] = now;
        if (x < wx0) wx0 = x; if (x > wx1) wx1 = x; if (y < wy0) wy0 = y; if (y > wy1) wy1 = y;
        touched.add(Math.floor(vy / CHUNK) * this.static.cols + Math.floor(vx / CHUNK));
        cols++;
        if ((cols & 15) === 0 && performance.now() >= deadline) { out = true; break; }
      }
      if (this.cursor >= n) { this.pendingAt++; this.cursor = 0; }
    }
    } finally { this.static.viewWrites = false; }
    if (wx1 >= 0) this.waterView?.cutChanged(wx0, wy0, wx1, wy1);
    if (touched.size && this.dress) this.dress(this, [...touched]);
    if (this.pendingAt >= this.pending.length) { this.pending = []; this.pendingAt = 0; this.cursor = 0; return { done: true, columns: cols }; }
    return { done: false, columns: cols };
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
//   'copy'  la copia girada de los vóxeles, por losas (copyRotatedSlabs; vóxel a vóxel por trozos si el ancho o el
//           fondo no son múltiplos de CHUNK). Reserva memoria que se queda: puede despertar al recolector;
//   'view'  la vista: el vestido entero y la rejilla del agua girada, de una vez;
//   'alloc' la reserva de los búferes del horneado (imagen, profundidad, vóxel, cara y rejilla de sombras), de una vez;
//   'bake'  el horneado por pasos que se adaptan a lo que tardan;
//   'done'.
export type PrepStage = 'copy' | 'view' | 'alloc' | 'bake' | 'done';
export function prepareViewJob(state: WorldState, quarter: Quarter, bakeOpts: Parameters<typeof bakeWorld>[1] = {}, viewOpts: WorldViewOptions = {}): { job: ViewJob; stage(): PrepStage; result(): { view: WorldView; baked: Baked } | null } {
  const src = state.solid;
  const cam = new ViewCamera(quarter, src.width, src.depth);
  const since = src.clock;
  // La vista tiene su copia si está girada, vestida o con corte (WorldView): se hace aquí, por partes
  const rotated = quarter === 0 && !viewOpts.dress && !viewOpts.cut ? null : new StaticVoxels(src.palette, cam.viewWidth, cam.viewDepth, src.zMin, src.zMax);
  // Por losas (copyRotatedSlabs: cada una, unos µs) si los trozos caen enteros en los de la copia; si no, vóxel a vóxel
  // por trozos, como antes
  const bySlab = StaticVoxels.slabCopyable(src, quarter);
  const units = bySlab ? src.cols * src.rows * src.nz : src.cols * src.rows;
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
          while (rotated && c < units) {
            if (bySlab) { rotated.copyRotatedSlabs(src, quarter, c, c + 1); c++; }
            else {
              const cx = (c % src.cols) * CHUNK, cy = Math.floor(c / src.cols) * CHUNK;
              for (const [x, y, z, v] of src.entries({ x0: cx, y0: cy, x1: cx + CHUNK - 1, y1: cy + CHUNK - 1 })) { const [vx, vy] = cam.cellToView(x, y); rotated.set(vx, vy, z, v); }
              c++;
            }
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
    if (rotated && c < units) return 'copy';
    if (!view) return 'view';
    if (!bake) return 'alloc';
    return 'bake';
  }
  return { job, stage, result: () => done };
}
