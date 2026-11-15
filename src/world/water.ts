// El agua del escenario como FLUIDO: un simulador de superficie (ShallowWater) sobre las cuencas del mundo de
// vóxeles, dibujado cada cuadro encima del mundo horneado con la misma cámara, y lo que hace la luz con ella:
//   - reflejo: el rayo reflejado se busca hacia arriba en la profundidad de lo ya dibujado (en esta proyección
//     se queda en la misma columna de pantalla); las ondas lo deforman;
//   - brillo especular de cada fuente según la normal de la superficie (punto en agua quieta, destellos con ondas);
//   - cáusticas: el fondo que se ve a través del agua recibe la luz que las ondas enfocan;
//   - refracción: el fondo se ve desplazado según la inclinación de la superficie.
// Su color es la rampa del agua de la paleta del mundo (la que se llama agua o water; si no hay, el azul por defecto), y si esa
// rampa es emisiva la superficie brilla sola: la luz del mundo no la oscurece (un líquido tóxico, lava...).
import { ShallowWater } from '../fluid/shallow';
import { rgbOf, rampMaterial, spotFactor, type Palette, type FpWater } from '../core';
import { resolveLight } from './lightutil';
import type { World, WorldLight } from './build';
import type { ChangeWatch } from './changes';
import type { Baked } from './bake';
import { DEFAULT_WORLD_RAMPS } from './build';

const CELL = 2;                                   // vóxeles por celda del simulador
const CHANGE_LOG = 256;                           // ticks que guarda el registro de cambios (changesSince)
export const WATER_CELL = CELL;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const REFLECT = 0.38;                             // cuánto del reflejo se ve (de arriba, el agua refleja poco)
const MARCH = 40;                                 // píxeles que sube como mucho el rayo reflejado (de 2 en 2, y afina al dar con algo)

// Opciones del agua. wallAbove: una celda cuyo fondo pasa de esa altura es pared (el agua no entra). Por defecto 8, lo
// de una sala baja; en un terreno alto, más que lo más alto del mundo (Infinity): el relieve ya contiene el agua
export interface WaterOptions { wallAbove?: number }

// El estado del agua en la instantánea: el del simulador y las cuencas (opcional: las instantáneas de antes no lo traen)
export type WaterState = ReturnType<ShallowWater['exportState']> & { basin?: Uint8Array };

export class WaterLayer {
  readonly sim: ShallowWater;
  // Las alturas entre las que puede haber superficie de agua: la de siempre (-16..32) o más, si las cuencas del mundo
  // están más altas o más hondas (la GPU y drawWater solo buscan agua en ese tramo)
  zRange: [number, number] = [WATER_ZMIN, WATER_ZMAX];
  private readonly wallAbove: number;
  private watch: ChangeWatch | null = null;
  readonly gw: number;
  readonly gh: number;
  readonly tones: Array<[number, number, number]>;
  readonly glow: number;                           // luz mínima de la superficie: 1 si la rampa del agua es emisiva, 0 si no
  readonly basin: Uint8Array;                      // 1 = celda de cuenca (si no, suelo seco: el agua se empapa)
  groundVersion = 0;                               // sube al cambiar el fondo, las paredes o las cuencas
  private readonly basin0: Uint8Array;             // las cuencas del mundo de partida (las ganadas jugando no están)
  private fountainIn: number[] = [];              // celdas donde cae el agua del cuenco
  // Las celdas mojadas fuera de cuenca (las que se empapan), en lista: así el empapado no recorre la rejilla. Entra
  // toda celda que pueda mojarse fuera de cuenca: las del paso (activeCells), pour, syncGround e importState. Quien
  // escriba sim.depth a mano fuera de cuenca, que use pour
  private soakList: Int32Array;
  private inSoak: Uint8Array;
  private nSoak = 0;
  soakVisited = 0;                                 // celdas recorridas por el último empapado (para medir y probar)
  // Qué celdas cambiaron (profundidad, fondo, pared o cuenca), para quien copia la rejilla (WaterView): una caja por
  // tick en un registro circular, y la del tick en curso abierta (changesSince)
  private readonly log = new Int32Array(CHANGE_LOG * 4);
  private logN = 0;                                // cajas cerradas desde el principio
  private readonly cur = Int32Array.of(0x7fffffff, 0x7fffffff, -1, -1);
  private fountainOut: number[] = [];             // desagüe

  // Rejilla de celdas de CELL x CELL vóxeles en ejes del modelo: la celda (gx, gy) cubre x en [gx*CELL, gx*CELL+CELL)
  // e y en [gy*CELL, gy*CELL+CELL) (gy crece hacia el norte). El fondo de cada celda sale de la rejilla de alturas
  // de los vóxeles del mundo; lo que sube más de WALL_Z (paredes, columnas, el fuste) o no tiene suelo, no deja pasar el agua.
  constructor(private world: World, opts: WaterOptions = {}) {
    this.wallAbove = opts.wallAbove ?? WALL_Z;
    this.gw = Math.ceil(world.width / CELL);
    this.gh = Math.ceil(world.depth / CELL);
    this.sim = new ShallowWater(this.gw, this.gh, { cell: CELL, damping: 0.9 });
    this.basin = new Uint8Array(this.gw * this.gh);
    const { wet, waterTop, width: W } = world;
    const zMin = world.model.zMin;
    const height = (x: number, y: number) => world.model.floorAt(x, y);   // el follaje no es fondo: el agua lo cubre
    for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) {
      const i = gy * this.gw + gx;
      // El fondo de la celda: el más alto de sus vóxeles (así el agua no se cuela por un borde)
      let g = -128, top = -128, anyWet = false, hole = false;
      for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) {
        const x = gx * CELL + dx, y = gy * CELL + dy;
        if (x >= W || y >= world.depth) continue;
        const j = y * W + x;
        const hh = height(x, y);
        if (hh <= zMin) hole = true;
        g = Math.max(g, hh);
        if (wet[j]) { anyWet = true; top = Math.max(top, waterTop[j]!); }
      }
      this.sim.ground[i] = g;
      if (hole || g > this.wallAbove) this.sim.solid[i] = 1;
      else if (anyWet) { this.basin[i] = 1; if (top > g) this.sim.depth[i] = top - g; }
    }
    this.basin0 = this.basin.slice();
    this.soakList = new Int32Array(this.gw * this.gh);
    this.inSoak = new Uint8Array(this.gw * this.gh);
    this.soakAll();
    this.sim.wakeAll();
    this.widenRange();
    const f = world.fountain;
    if (f) {
      const cx = f.x / CELL, cy = f.y / CELL;
      for (let gy = Math.floor(cy - 10); gy <= Math.ceil(cy + 10); gy++) for (let gx = Math.floor(cx - 10); gx <= Math.ceil(cx + 10); gx++) {
        const d = Math.hypot(gx + 0.5 - cx, gy + 0.5 - cy) * CELL;
        const i = gy * this.gw + gx;
        if (!this.basin[i]) continue;
        if (d > 5.5 && d < 8) this.fountainIn.push(i);       // bajo el borde del cuenco
        else if (d > 11 && d < 14) this.fountainOut.push(i);  // desagüe junto al borde del pilón
      }
    }
    const pal = world.model.palette;
    const ramp = pal.ramps.find((r) => /^(agua|water)$/i.test(r.name));
    const colors = ramp?.colors.length ? ramp.colors : DEFAULT_WORLD_RAMPS.water;
    // Cinco tonos (del hondo a la espuma): una rampa más corta repite sus extremos, una más larga se muestrea
    this.tones = [0, 1, 2, 3, 4].map((k) => rgbOf(colors[Math.round((k * (colors.length - 1)) / 4)]!));
    this.glow = ramp && rampMaterial(ramp).emissive ? 1 : 0;
  }

  // El tramo de alturas con agua posible: el de siempre, ensanchado a las cuencas (su fondo y su superficie) con margen
  private widenRange(): void {
    let lo = WATER_ZMIN, hi = WATER_ZMAX;
    for (let i = 0; i < this.basin.length; i++) {
      if (!this.basin[i] || this.sim.solid[i]) continue;
      const g = this.sim.ground[i]!;
      lo = Math.min(lo, g - 4); hi = Math.max(hi, g + this.sim.depth[i]! + 8);
    }
    this.zRange = [Math.floor(lo), Math.ceil(hi)];
  }

  // El fondo (y si es pared) de las celdas que tocan la caja de vóxeles, otra vez desde el mundo: tras picar o poner.
  // La superficie del agua se queda donde estaba (un hoyo junto al agua se llena, poner un bloque la desplaza), y una
  // celda que queda por debajo del agua de una vecina de cuenca pasa a ser cuenca (no se empapa)
  syncGround(box: { x0: number; y0: number; x1: number; y1: number }): void {
    const { sim } = this;
    const gx0 = Math.max(0, Math.floor(box.x0 / CELL)), gx1 = Math.min(this.gw - 1, Math.floor(box.x1 / CELL));
    const gy0 = Math.max(0, Math.floor(box.y0 / CELL)), gy1 = Math.min(this.gh - 1, Math.floor(box.y1 / CELL));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const i = gy * this.gw + gx;
      const [g, hole] = this.groundOf(gx, gy);
      const surface = sim.solid[i] ? -Infinity : sim.ground[i]! + sim.depth[i]!;
      sim.ground[i] = g;
      sim.solid[i] = hole || g > this.wallAbove ? 1 : 0;
      sim.depth[i] = sim.solid[i] ? 0 : Math.max(0, surface - g);
      if (!sim.solid[i] && !this.basin[i]) {
        let level = -Infinity;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = gx + ox, ny = gy + oy;
          if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
          const j = ny * this.gw + nx;
          if (this.basin[j] && !sim.solid[j] && sim.depth[j]! > 0.04) level = Math.max(level, sim.ground[j]! + sim.depth[j]!);
        }
        if (g < level) this.basin[i] = 1;
      }
      this.soakMaybe(i);
      sim.wake(gx, gy, 3);
    }
    this.groundVersion++;
    this.changed(gx0, gy0, gx1, gy1);
    this.widenRange();
  }

  // Apunta que cambiaron las celdas de la caja (en celdas, extremos incluidos)
  private changed(gx0: number, gy0: number, gx1: number, gy1: number): void {
    const c = this.cur;
    if (gx0 < c[0]!) c[0] = Math.max(0, gx0); if (gy0 < c[1]!) c[1] = Math.max(0, gy0);
    if (gx1 > c[2]!) c[2] = Math.min(this.gw - 1, gx1); if (gy1 > c[3]!) c[3] = Math.min(this.gh - 1, gy1);
  }
  private changedCell(i: number): void { const gx = i % this.gw, gy = (i - gx) / this.gw; this.changed(gx, gy, gx, gy); }
  private closeChanges(): void {
    const c = this.cur;
    if (c[0]! > c[2]!) return;
    this.log.set(c, (this.logN % CHANGE_LOG) * 4);
    this.logN++;
    c[0] = c[1] = 0x7fffffff; c[2] = c[3] = -1;
  }
  // Lo que cambió desde `seq` (el seq que dio la llamada anterior; 0 al empezar): la caja de celdas que lo cubre (null
  // si nada), o all si el registro ya no llega tan atrás. Lo del tick en curso sale siempre (también la vez siguiente)
  changesSince(seq: number): { seq: number; all: boolean; box: [number, number, number, number] | null } {
    if (this.logN - seq > CHANGE_LOG) return { seq: this.logN, all: true, box: null };
    let x0 = this.cur[0]!, y0 = this.cur[1]!, x1 = this.cur[2]!, y1 = this.cur[3]!;
    for (let k = seq; k < this.logN; k++) {
      const o = (k % CHANGE_LOG) * 4, l = this.log;
      if (l[o]! < x0) x0 = l[o]!; if (l[o + 1]! < y0) y0 = l[o + 1]!; if (l[o + 2]! > x1) x1 = l[o + 2]!; if (l[o + 3]! > y1) y1 = l[o + 3]!;
    }
    return { seq: this.logN, all: false, box: x0 <= x1 ? [x0, y0, x1, y1] : null };
  }

  private soakMaybe(i: number): void {
    if (!this.inSoak[i] && !this.basin[i] && this.sim.depth[i]! > 0) { this.inSoak[i] = 1; this.soakList[this.nSoak++] = i; }
  }
  // La lista de lo que se empapa, otra vez desde toda la rejilla (al empezar y al cargar)
  private soakAll(): void {
    for (let k = 0; k < this.nSoak; k++) this.inSoak[this.soakList[k]!] = 0;
    this.nSoak = 0;
    for (let i = 0; i < this.basin.length; i++) this.soakMaybe(i);
  }

  // El fondo de una celda desde los vóxeles del mundo (el más alto de los suyos) y si tiene un agujero sin suelo
  private groundOf(gx: number, gy: number): [number, boolean] {
    const W = this.world.width, zMin = this.world.model.zMin;
    let g = -128, hole = false;
    for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) {
      const x = gx * CELL + dx, y = gy * CELL + dy;
      if (x >= W || y >= this.world.depth) continue;
      const hh = this.world.model.floorAt(x, y);
      if (hh <= zMin) hole = true;
      g = Math.max(g, hh);
    }
    return [g, hole];
  }

  // El estado del agua para la instantánea del mundo: el del simulador (profundidad, flujos, despiertas) y las cuencas
  exportState(): WaterState { return { ...this.sim.exportState(), basin: this.basin.slice() }; }

  // Vuelve a una instantánea (WorldState.restore, con los vóxeles ya restaurados). La profundidad, los flujos y las
  // despiertas guardadas son la verdad: no se tocan ni se despierta nada más. Las cuencas, las guardadas (una
  // instantánea de antes, sin ellas, deja las del mundo de partida). Si la capa sigue al mundo (follow), el fondo y
  // las paredes se rehacen de los vóxeles restaurados y lo pendiente de syncGround se descarta: la restauración ya
  // trae agua y mundo coherentes (un syncGround conservando la superficie metería agua de más donde se picó)
  importState(s: WaterState): void {
    this.sim.importState(s);
    this.basin.set(s.basin ?? this.basin0);
    this.soakAll();
    if (this.watch) {
      this.watch.take();
      const { sim } = this;
      for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) {
        const i = gy * this.gw + gx, [g, hole] = this.groundOf(gx, gy);
        sim.ground[i] = g;
        sim.solid[i] = hole || g > this.wallAbove ? 1 : 0;
      }
    }
    this.groundVersion++;
    this.changed(0, 0, this.gw - 1, this.gh - 1);
    this.widenRange();
  }

  // ¿Hay cuencas ganadas jugando (distintas de las del mundo de partida)? Solo entonces entran en la huella
  basinChanged(): boolean {
    for (let i = 0; i < this.basin.length; i++) if (this.basin[i] !== this.basin0[i]) return true;
    return false;
  }

  // Escuchar los cambios de vóxeles del mundo (picar, poner) y rehacer el fondo de lo tocado en cada step. Sin esto, el
  // agua no se entera (como siempre): quien quiera que siga al mundo lo pide
  follow(watch: ChangeWatch): void { this.watch = watch; }

  private cellOf(x: number, y: number): number {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    return gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh ? -1 : gy * this.gw + gx;
  }

  // Los 5 tonos del agua (RGB) y si una celda es de cuenca (para quien la dibuja por su cuenta, como la GPU)
  get toneColors(): ReadonlyArray<readonly [number, number, number]> { return this.tones; }
  isBasin(i: number): boolean { return this.basin[i] === 1; }

  // Todo en ejes del modelo (x este, y norte)
  depthAt(x: number, y: number): number { const i = this.cellOf(x, y); return i < 0 ? 0 : this.sim.depth[i]!; }
  surfaceAt(x: number, y: number): number { const i = this.cellOf(x, y); return i < 0 ? 0 : this.sim.surface(i); }

  // El agua para la primera persona (src/core/explore.ts): la superficie (NaN si está seca) y la profundidad por celda,
  // con la rampa del agua de la paleta del mundo. null si la paleta no tiene rampa llamada agua o water
  firstPersonWater(palette: Palette): FpWater | null {
    const ramp = palette.ramps.findIndex((r) => /^(agua|water)$/i.test(r.name));
    if (ramp < 0) return null;
    const n = this.gw * this.gh, surface = new Float32Array(n), depth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = this.sim.depth[i]!;
      const wet = !this.sim.solid[i] && d >= 0.04;
      surface[i] = wet ? this.sim.ground[i]! + d : NaN;
      depth[i] = wet ? d : 0;
    }
    return { cell: CELL, gw: this.gw, gh: this.gh, surface, depth, ramp };
  }

  // Para lo que flota: hacia dónde va el agua y cuánto se inclina su superficie, en un punto del mundo
  flowAt(x: number, y: number): [number, number] { return this.sim.flow(Math.floor(x / CELL), Math.floor(y / CELL)); }
  slopeAt(x: number, y: number): [number, number] {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    return gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh ? [0, 0] : this.sim.slope(gx, gy);
  }

  // Algo que se mueve dentro del agua la empuja (ondas). Con fuerza, el agua salta el borde y moja el suelo.
  disturb(x: number, y: number, amount: number, radius = 1.5): void {
    this.sim.disturb(x / CELL, y / CELL, radius, amount);
    const cx = x / CELL, cy = y / CELL;
    this.changed(Math.floor(cx - radius * 2), Math.floor(cy - radius * 2), Math.ceil(cx + radius * 2), Math.ceil(cy + radius * 2));
  }

  // Añade agua en un punto (las gotas que caen)
  pour(x: number, y: number, amount: number): void {
    const i = this.cellOf(x, y);
    if (i < 0 || this.sim.solid[i]) return;
    this.sim.depth[i] = this.sim.depth[i]! + amount;
    this.soakMaybe(i);
    this.changedCell(i);
    this.sim.wake(i % this.gw, Math.floor(i / this.gw), 3);
  }

  // Centros (ejes del modelo) de las celdas donde cae el agua del cuenco de la fuente
  fountainLanding(k: number): [number, number] | null {
    if (!this.fountainIn.length) return null;
    const i = this.fountainIn[k % this.fountainIn.length]!;
    return [(i % this.gw) * CELL + 1, Math.floor(i / this.gw) * CELL + 1];
  }

  // Un paso de simulación de `dt` (el mundo lo llama con 1/60 fijo): exactamente round(dt * 120) subpasos de 1/120,
  // sin acumular tiempo, así la misma partida da siempre el mismo agua
  step(dt: number): void {
    if (this.watch) for (const b of this.watch.take().boxes) this.syncGround(b);
    const { sim, basin } = this;
    const f = this.world.fountain;
    for (let n = Math.max(1, Math.round(dt * 120)); n > 0; n--) {
      // Fuente: el desagüe saca lo que sobra por encima de su nivel (lo que cae lo añaden las gotas con pour)
      if (f) for (const i of this.fountainOut) {
        const over = sim.surface(i) - f.level;
        if (over > 0) { sim.depth[i] = Math.max(0, sim.depth[i]! - over * 0.3); this.changedCell(i); }
      }
      sim.step(1 / 120);
      // Lo que pudo mojarse fuera de cuenca en este subpaso (solo las celdas que calculó), y su caja
      const act = sim.activeCells(), depth = sim.depth, inSoak = this.inSoak, list = this.soakList, gw = this.gw;
      let ax0 = gw, ay0 = this.gh, ax1 = -1, ay1 = -1;
      for (let q = 0; q < act.length; q++) {
        const i = act[q]!;
        if (!inSoak[i] && !basin[i] && depth[i]! > 0) { inSoak[i] = 1; list[this.nSoak++] = i; }
        const x = i % gw, y = (i - x) / gw;
        if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
      }
      if (ax1 >= 0) this.changed(ax0, ay0, ax1, ay1);
    }
    // El agua que salta al suelo seco se empapa poco a poco (cada celda por su cuenta: el orden no cuenta)
    const soak = Math.min(dt, 0.05) * 0.3, list = this.soakList, depth = sim.depth;
    let m = 0;
    this.soakVisited = this.nSoak;
    for (let k = 0; k < this.nSoak; k++) {
      const i = list[k]!;
      if (basin[i] || !(depth[i]! > 0)) { this.inSoak[i] = 0; continue; }
      depth[i] = depth[i]! < 0.03 ? 0 : depth[i]! - soak * Math.max(0.25, depth[i]!);
      this.changedCell(i);
      if (depth[i]! > 0) list[m++] = i; else this.inSoak[i] = 0;
    }
    this.nSoak = m;
    this.closeChanges();
  }

  draw(b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    ambient: readonly [number, number, number], time: number, worldLights: readonly WorldLight[], reflect = true): void {
    drawWater(this, b, view, depthBuf, total, vx, vy, vw, vh, ambient, time, worldLights, reflect);
  }
}

// Las filas de celdas cuyo agua puede caer en la vista (filas vy..vy+vh de la imagen horneada). Por abajo de la vista
// se ve la fila más al sur con la superficie más ALTA, y por arriba la más al norte con la más BAJA (estaban cruzadas:
// el agua desaparecía en la franja de arriba y en la de abajo)
export const WATER_ZMIN = -16, WATER_ZMAX = 32;
const WALL_Z = 8;
export function waterRows(originY: number, a: number, vy: number, vh: number, gh: number, range: readonly [number, number] = [WATER_ZMIN, WATER_ZMAX]): [number, number] {
  const yOf = (sy: number, z: number) => (originY - sy - z) / a;
  return [Math.max(0, Math.floor(yOf(vy + vh, range[1]) / CELL) - 2), Math.min(gh - 1, Math.ceil(yOf(vy, range[0]) / CELL) + 2)];
}

// Cuánto de "hondo" tiene una celda para su color: 0 hasta DEEP_FROM de profundidad media (la de las celdas con agua
// a DEEP_R o menos), 1 desde DEEP_TO
export const DEEP_FROM = 3, DEEP_TO = 6, DEEP_R = 2;
function deepness(sim: WaterGrid['sim'], gw: number, gh: number, gx: number, gy: number): number {
  let sum = 0, n = 0;
  for (let dy = -DEEP_R; dy <= DEEP_R; dy++) for (let dx = -DEEP_R; dx <= DEEP_R; dx++) {
    const x = gx + dx, y = gy + dy;
    if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
    const j = y * gw + x, dd = sim.depth[j]!;
    if (sim.solid[j] || dd < 0.04) continue;
    sum += dd; n++;
  }
  return Math.max(0, Math.min(1, (sum / n - DEEP_FROM) / (DEEP_TO - DEEP_FROM)));
}

// La rejilla que dibuja drawWater: la del simulador del mundo (WaterLayer) o la de una vista girada (view.ts)
export interface WaterGrid {
  readonly gw: number;
  readonly gh: number;
  readonly sim: { readonly depth: Float32Array; readonly ground: Float32Array; readonly solid: Uint8Array };
  readonly basin: Uint8Array;
  readonly tones: ReadonlyArray<readonly [number, number, number]>;
  readonly glow?: number;
  readonly zRange?: readonly [number, number];     // las alturas con agua posible (por defecto WATER_ZMIN..WATER_ZMAX)
}

// Dibuja el agua en la vista (vx, vy, vw, vh de la imagen horneada). `view` y `depthBuf` tienen lo ya dibujado
// (mundo + personajes); `total` (opcional) es la luz por píxel de la vista, que aquí se completa.
// `worldLights`: todas las luces del mundo (fijas y dinámicas)
export function drawWater(w: WaterGrid, b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    ambient: readonly [number, number, number], time: number, worldLights: readonly WorldLight[], reflect = true): void {
  const { sim, gw, gh } = w;
  const a = b.options.oblique?.y ?? 1;
  const originY = b.options.originY;
  const f1 = b.cam.fwd[1], f2 = b.cam.fwd[2];
  // El rayo reflejado sube por la misma columna de pantalla: por píxel avanza tPerPx, y su profundidad crece dPerT por t
  const tPerPx = 1 / (a * f1 - f2), dPerT = f1 * f1 - f2 * f2;
  const lights = worldLights.map((l) => {
    const p = resolveLight(l, time);
    return { x: l.x, y: l.y, z: l.z, r: p.radius, c: p.color, k: p.intensity, spot: p.spot };
  });
  // Hacia la cámara (para el brillo especular)
  const vlen = Math.hypot(f1, f2), Vy = -f1 / vlen, Vz = -f2 / vlen;
  // Lo de debajo y de alrededor, tal como estaba antes del agua (para el reflejo y la refracción)
  const srcView = view.slice(), srcDepth = depthBuf.slice(), srcTotal = total ? total.slice() : null;
  const white = w.tones[4]!;
  // Altura de la superficie de una vecina (los bordes secos o sólidos cuentan como la propia celda)
  const sAt = (j: number, own: number) => (sim.solid[j] || sim.depth[j]! <= 0.01 ? own : sim.ground[j]! + sim.depth[j]!);

  const gx0 = Math.max(0, Math.floor(vx / CELL) - 1), gx1 = Math.min(gw - 1, Math.ceil((vx + vw) / CELL) + 1);
  const [gy0, gy1] = waterRows(originY, a, vy, vh, gh, w.zRange);
  for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
    const i = gy * gw + gx;
    const d = sim.depth[i]!;
    if (sim.solid[i] || d < 0.04) continue;
    const zs = sim.ground[i]! + d;
    const north = gy * CELL + CELL, south = gy * CELL;
    const sy0 = Math.round(originY - a * north - zs), sy1 = Math.max(sy0 + 1, Math.round(originY - a * south - zs));
    const ymid = (north + south) / 2;
    const depthHere = ymid * f1 + zs * f2;
    // Normal y curvatura de la superficie
    const sE = gx < gw - 1 ? sAt(i + 1, zs) : zs, sW = gx > 0 ? sAt(i - 1, zs) : zs;
    const sN = gy < gh - 1 ? sAt(i + gw, zs) : zs, sS = gy > 0 ? sAt(i - gw, zs) : zs;
    const sx = (sE - sW) / (2 * CELL), sy = (sN - sS) / (2 * CELL);
    const lap = (sE + sW + sS + sN - 4 * zs) / (CELL * CELL);
    const nx = -sx, ny = -sy, nz = 1, nl = Math.hypot(nx, ny, nz);
    const key = (nx * -0.5 + ny * 0.5 + nz * 0.7) / nl - 0.7;
    // Lo hondo, más oscuro: con la profundidad media de la celda y sus vecinas con agua, y pasando de un tono al otro
    // con trama entre DEEP_FROM y DEEP_TO (un corte seco sobre un fondo en escalones dibujaba picos)
    const deepT = deepness(sim, gw, gh, gx, gy);
    const lean = key > 0.04 ? 1 : key < -0.04 ? -1 : 0;
    const steep = Math.hypot(sx, sy);
    const foam = steep > 0.45;                                         // espuma en las crestas
    const film = d < 0.6 && !w.basin[i];                               // suelo mojado: una película clara
    const toneAt = (px: number, sy: number) => film ? 3 : foam ? 4 : Math.max(0, Math.min(4, (BAYER[(px & 3) + ((sy & 3) << 2)]! / 16 < deepT ? 2 : 3) + lean));
    // Opaca donde es honda; la trama (transparencia) solo en la orilla y en el suelo mojado
    const alphaFor = (tn: number) => (!w.basin[i] ? Math.min(0.6, d) : d >= 1.5 ? 1 : Math.min(1, 0.45 + d * 0.35 + (tn === 4 ? 0.4 : 0)));
    // Luz difusa en la superficie, su brillo especular, y la que atraviesa hasta el fondo (cáusticas)
    const glow = w.glow ?? 0;
    let lr = Math.max(glow, ambient[0] * 1.25), lg = Math.max(glow, ambient[1] * 1.25), lb = Math.max(glow, ambient[2] * 1.3), spec = 0, sr = 0, sg = 0, sb = 0;
    const caustic = 1 + Math.max(-0.6, Math.min(2.5, -lap * 6));
    if (total) for (const l of lights) {
      const cx = gx * CELL + 1, cy = gy * CELL + 1;
      const dx = l.x - cx, dy = l.y - cy, dz = l.z - zs;
      if (dx > l.r || dx < -l.r || dy > l.r || dy < -l.r) continue;
      const dist = Math.hypot(dx, dy, dz);
      if (dist >= l.r) continue;
      const kk = (1 - dist / l.r) ** 2 * l.k * spotFactor(l.spot, -dx, -dy, -dz);
      if (kk <= 0) continue;
      const Lx = dx / dist, Ly = dy / dist, Lz = dz / dist;
      const ndl = Math.max(0, (nx * Lx + ny * Ly + nz * Lz) / nl);
      lr += l.c[0] * kk * (0.4 + 0.6 * ndl); lg += l.c[1] * kk * (0.4 + 0.6 * ndl); lb += l.c[2] * kk * (0.4 + 0.6 * ndl);
      // Blinn-Phong: el vector medio entre la luz y la cámara
      const hx = Lx, hy = Ly + Vy, hz = Lz + Vz, hl = Math.hypot(hx, hy, hz);
      const ndh = Math.max(0, (nx * hx + ny * hy + nz * hz) / (nl * hl));
      const sp = ndh ** 160 * kk * 3;                                   // brillo concentrado: destellos, no manchas
      if (sp > 0.02) { spec += sp; sr += l.c[0] * sp; sg += l.c[1] * sp; sb += l.c[2] * sp; }
    }
    const shift = Math.max(-2, Math.min(2, Math.round(sx * 5)));        // las ondas desplazan el fondo y el reflejo
    for (let sy = sy0; sy < sy1; sy++) {
      const ty = sy - vy;
      if (ty < 0 || ty >= vh) continue;
      for (let px = gx * CELL; px < gx * CELL + CELL; px++) {
        const tx = px - vx;
        if (tx < 0 || tx >= vw) continue;
        const t = ty * vw + tx;
        if (depthHere >= srcDepth[t]! - 0.3) continue;                // lo que hay delante (orilla, personaje) tapa el agua
        const o = t * 4, q = t * 3;
        const tn = toneAt(px, sy);
        if (BAYER[(px & 3) + ((sy & 3) << 2)]! / 16 >= alphaFor(tn)) {
          // Se ve el fondo a través del agua: refractado, algo azulado y con las cáusticas
          const t2 = ty * vw + Math.max(0, Math.min(vw - 1, tx + shift));
          view[o] = srcView[t2 * 4]! * 0.85; view[o + 1] = srcView[t2 * 4 + 1]! * 0.92; view[o + 2] = Math.min(255, srcView[t2 * 4 + 2]! * 1.05); view[o + 3] = 255;
          if (total && srcTotal) for (let c = 0; c < 3; c++) total[q + c] = ambient[c]! + (srcTotal[t2 * 3 + c]! - ambient[c]!) * caustic;
          continue;
        }
        // Superficie: su color, el reflejo de lo que tiene encima y el brillo de las fuentes
        const tc = w.tones[tn]!;
        let cr = tc[0], cg = tc[1], cb = tc[2], ltr = lr + sr, ltg = lg + sg, ltb = lb + sb;
        const col = Math.max(0, Math.min(vw - 1, tx + shift));
        if (reflect) for (let k = 2; k <= MARCH; k += 2) {
          if (ty - k < 0) break;
          const sdk = srcDepth[(ty - k) * vw + col]!;
          if (!(sdk !== Infinity && sdk < depthHere + k * tPerPx * dPerT - 0.5)) continue;
          // Dio con algo: ¿ya lo tocaba un píxel antes?
          const k1 = k - 1, prev = srcDepth[(ty - k1) * vw + col]!;
          const kk = prev !== Infinity && prev < depthHere + k1 * tPerPx * dPerT - 0.5 ? k1 : k;
          const rt = (ty - kk) * vw + col;
          {
            const m = REFLECT * (tn === 4 ? 0.3 : 1);
            cr += (srcView[rt * 4]! - cr) * m; cg += (srcView[rt * 4 + 1]! - cg) * m; cb += (srcView[rt * 4 + 2]! - cb) * m;
            if (srcTotal) { ltr += (srcTotal[rt * 3]! - ltr) * m; ltg += (srcTotal[rt * 3 + 1]! - ltg) * m; ltb += (srcTotal[rt * 3 + 2]! - ltb) * m; }
            break;
          }
        }
        if (spec > 0.35) { cr = white[0]; cg = white[1]; cb = white[2]; }
        view[o] = cr; view[o + 1] = cg; view[o + 2] = cb; view[o + 3] = 255;
        depthBuf[t] = depthHere;
        if (total) { total[q] = ltr; total[q + 1] = ltg; total[q + 2] = ltb; }
      }
    }
  }
}
