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
import { shiftGrid, CHUNK, type StaticVoxels } from './state';
import type { GeneratedRegion } from './regiongen';
import { cloudShade } from './sunlight';
import { waveSlope } from './waves';
import { climateCell } from './climate';
import { seenThrough, type WaterLook } from './waterlook';
import { windowContains, type SectionWindow } from './section';

const CELL = 2;                                   // vóxeles por celda del simulador
const TILE = 8;                                   // celdas por lado de una baldosa de lo que cambió (changedTiles)
const TILE_LOG = 1 << 16;                         // baldosas cambiadas que guarda la lista (changedTiles)
const TILE_SHIFTS = 64;                           // corrimientos que guarda
export const WATER_TILE = TILE;
const CHANGE_LOG = 256;                           // ticks que guarda el registro de cambios (changesSince)
export const WATER_CELL = CELL;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const REFLECT = 0.38;                             // cuánto del reflejo se ve (de arriba, el agua refleja poco)
const MARCH = 40;                                 // píxeles que sube como mucho el rayo reflejado (de 2 en 2, y afina al dar con algo)

// Opciones del agua. wallAbove: una celda cuyo fondo pasa de esa altura es pared (el agua no entra). Por defecto 8, lo
// de una sala baja; en un terreno alto, más que lo más alto del mundo (Infinity): el relieve ya contiene el agua
export interface WaterOptions {
  wallAbove?: number;
  // asleep: la capa nace dormida (sin esto, nace con todo lo mojado despierto y tarda ~30 ticks en dormirse, y esos
  // ticks son los más caros de la partida). Solo si el agua nace en reposo: ninguna celda mojada puede echar agua a
  // una vecina (la superficie plana en cada lago, como la de mapWater) y no hay fuente. Si no, se ignora con un aviso
  // y nace despierta, como siempre (bornAsleep dice qué pasó). Cambia la huella (las despiertas están en ella); por
  // defecto, como siempre
  asleep?: boolean;
  // movable: la capa se corre con la ventana viva (shift, LiveWindow.attach). Sus vistas la leen por WaterView también en
  // el giro 0 (la rejilla corrida está en anillo; drawWater la lee en orden)
  movable?: boolean;
  // unloaded: nace sin cargar, toda seca y de pared (una ventana que carga el agua por trozos con load); no lee el agua de
  // partida del mundo (wet / waterTop pueden ir vacíos)
  unloaded?: boolean;
}

// El agua de una región generada (regiongen) cuyo material `water` no se escribió en la rejilla (LiveWindowOptions.skip,
// stampRegion con skip): la superficie de cada columna de vóxeles (la cara de arriba de la celda de agua más alta de su
// columna de bloques), para WaterLayer.load. at: la celda de la rejilla donde se puso la región (TrozoCtx.at); N: el
// lado del bloque; origin: el de la rejilla (vóxeles). Las coordenadas que recibe son vóxeles locales del mundo
// (water: un tipo, o varios: el agua y lo que convive con ella, BlockSet.waterTypes)
export function regionWater(r: GeneratedRegion, water: number | readonly number[], N: number, at: readonly [number, number, number], origin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): (x: number, y: number) => number | null {
  const { width: W, depth: D, height: H } = r.region, top = new Int16Array(W * D).fill(-32768), isWater = new Set(typeof water === 'number' ? [water] : water);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    for (let z = H - 1; z >= 0; z--) if (isWater.has(r.cells[(z * D + y) * W + x]!)) { top[y * W + x] = origin.z + (at[2] + z + 1) * N; break; }
  }
  return (x, y) => {
    const bx = Math.floor((x - origin.x) / N) - at[0], by = Math.floor((y - origin.y) / N) - at[1];
    if (bx < 0 || by < 0 || bx >= W || by >= D) return null;
    const t = top[by * W + bx]!;
    return t === -32768 ? null : t;
  };
}

// El agua guardada de un recuadro (WaterLayer.save / load): w x h celdas, por filas
export interface WaterChunk { w: number; h: number; depth: Float32Array; basin: Uint8Array }

// El agua de un recuadro de una ventana por trozos hecha de BLOQUES (vóxeles de agua, que se pintarían opacos): los
// quita de los vóxeles y da la superficie de cada columna (la cara de arriba del vóxel de agua más alto) para
// WaterLayer.load. isWater dice qué vóxeles son agua. Mira cada columna desde arriba y para en el primer vóxel que no es
// agua: el agua que se ve desde el cielo (la de una cueva bajo tierra se queda como vóxeles). Va antes de hornear el
// trozo (onLoad / fill). through (opcional): vóxeles que conviven con el agua (una planta): no se quitan ni paran la cuenta,
// y los que tienen agua al lado cuentan como agua
export function takeWaterVoxels(s: StaticVoxels, x0: number, y0: number, x1: number, y1: number, isWater: (v: number) => boolean, through?: (v: number) => boolean): (x: number, y: number) => number | null {
  const w = x1 - x0 + 1, h = y1 - y0 + 1, top = new Int16Array(w * h).fill(-32768);
  // (la superficie de los que conviven con el agua, antes de quitar nada)
  const by = through ? (x: number, y: number, z: number) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isWater(s.get(x + dx!, y + dy!, z))) : null;
  if (through && by) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    for (let z = s.height[y * s.width + x]! - 1; z >= s.zMin; z--) {
      const v = s.get(x, y, z);
      if (!v) continue;
      if (!through(v)) break;
      if (by(x, y, z)) { top[(y - y0) * w + x - x0] = z + 1; break; }
    }
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    for (let z = s.height[y * s.width + x]! - 1; z >= s.zMin; z--) {
      const v = s.get(x, y, z);
      if (!v) continue;
      if (through?.(v)) continue;
      if (!isWater(v)) break;
      s.set(x, y, z, 0);
      const k = (y - y0) * w + x - x0;
      if (top[k] === -32768) top[k] = z + 1;
    }
  }
  return (x, y) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return null;
    const t = top[(y - y0) * w + x - x0]!;
    return t === -32768 ? null : t;
  };
}

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
  readonly bornAsleep: boolean;                    // si nació dormida (WaterOptions.asleep, con el agua en reposo)
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
  // Los corrimientos (shift), con el número de cajas cerradas cuando se hicieron: las cajas de antes se corren con ellos
  private shiftLog: Array<{ at: number; cx: number; cy: number }> = [];
  // Lo que cambió, por baldosas de TILE x TILE celdas de la rejilla: la época (tileEpoch) en que se apuntó cada una
  readonly tilesX: number;
  readonly tilesY: number;
  private readonly tileVer: Uint32Array;
  // La lista de las que cambiaron (una vez por tick cada una), circular, y los corrimientos con su sitio en ella
  private readonly tileLog = new Int32Array(TILE_LOG);
  private tileLogN = 0;
  private readonly tileShifts: Array<{ tdx: number; tdy: number; all: boolean }> = [];
  private tileShiftBase = 0;                       // el número del primer corrimiento que guarda tileShifts
  private readonly tileSeen: Uint32Array;
  private tileSeenStamp = 0;
  private tileEpoch = 1;
  // Las baldosas con alguna celda activa en el último subpaso (tx + ty * tilesX), sin repetir: una baldosa de agua es un
  // trozo de vóxeles (CHUNK / CELL celdas), así que son los trozos donde el agua se movió (WorldState.step)
  private stepTiles: Int32Array;
  private nStepTiles = 0;
  private readonly stepSeen: Uint32Array;
  private stepSeenStamp = 0;
  movedTiles(): Int32Array { return this.stepTiles.subarray(0, this.nStepTiles); }
  private shifts = 0;
  // Cuántas veces se corrió (quien copia la rejilla y no se corrió con ella la copia entera)
  get shiftCount(): number { return this.shifts; }
  // Si la capa se corre con una ventana (shift): entonces las vistas la leen siempre por WaterView (en el anillo)
  readonly movable: boolean;

  // Rejilla de celdas de CELL x CELL vóxeles en ejes del modelo: la celda (gx, gy) cubre x en [gx*CELL, gx*CELL+CELL)
  // e y en [gy*CELL, gy*CELL+CELL) (gy crece hacia el norte). El fondo de cada celda sale de la rejilla de alturas
  // de los vóxeles del mundo; lo que sube más de WALL_Z (paredes, columnas, el fuste) o no tiene suelo, no deja pasar el agua.
  constructor(private world: World, opts: WaterOptions = {}) {
    this.wallAbove = opts.wallAbove ?? WALL_Z;
    this.movable = !!opts.movable;
    this.gw = Math.ceil(world.width / CELL);
    this.gh = Math.ceil(world.depth / CELL);
    this.sim = new ShallowWater(this.gw, this.gh, { cell: CELL, damping: 0.9 });
    // (una baldosa de lo que cambió es un trozo de vóxeles: WorldState.step marca los trozos por baldosas, movedTiles)
    if (TILE * CELL !== CHUNK) throw new Error(`WaterLayer: la baldosa (${TILE} celdas de ${CELL}) no es un trozo (${CHUNK})`);
    this.tilesX = Math.ceil(this.gw / TILE); this.tilesY = Math.ceil(this.gh / TILE);
    this.tileVer = new Uint32Array(this.tilesX * this.tilesY);
    this.tileSeen = new Uint32Array(this.tilesX * this.tilesY);
    this.stepTiles = new Int32Array(this.tilesX * this.tilesY);
    this.stepSeen = new Uint32Array(this.tilesX * this.tilesY);
    this.basin = new Uint8Array(this.gw * this.gh);
    const { wet, waterTop, width: W } = world;
    // Sin cargar (una ventana que se carga por trozos, load): todo seco y de pared
    if (opts.unloaded) this.sim.solid.fill(1);
    else {
      const wetTop = (x: number, y: number) => (wet[y * W + x] ? waterTop[y * W + x]! : null);
      for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) this.initCell(gx, gy, wetTop);
    }
    this.basin0 = this.basin.slice();
    this.soakList = new Int32Array(this.gw * this.gh);
    this.inSoak = new Uint8Array(this.gw * this.gh);
    this.soakAll();
    const still = opts.asleep ? (world.fountain ? 'tiene fuente' : this.restless()) : null;
    if (opts.asleep && still) console.warn(`WaterLayer: asleep ignorado, el agua no nace en reposo (${still}); nace despierta`);
    this.bornAsleep = !!opts.asleep && !still;
    if (!this.bornAsleep) this.sim.wakeAll();
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

  // Una celda desde los vóxeles del mundo y el agua de partida (la superficie de cada columna con agua, o null): el fondo
  // es el más alto de sus vóxeles (así el agua no se cuela por un borde); lo que sube más de wallAbove o no tiene suelo es
  // pared; con agua en alguna columna, cuenca, con la profundidad hasta la superficie más alta. Sin flujos ni despierta
  private initCell(gx: number, gy: number, wetTop: ((x: number, y: number) => number | null) | null): void {
    const world = this.world, W = world.width, zMin = world.model.zMin, sim = this.sim, i = sim.at(gx, gy);
    let g = -128, top = -128, anyWet = false, hole = false;
    for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) {
      const x = gx * CELL + dx, y = gy * CELL + dy;
      if (x >= W || y >= world.depth) continue;
      const hh = world.model.floorAt(x, y);       // el follaje no es fondo: el agua lo cubre
      if (hh <= zMin) hole = true;
      g = Math.max(g, hh);
      const t = wetTop ? wetTop(x, y) : null;
      if (t !== null) { anyWet = true; top = Math.max(top, t); }
    }
    sim.ground[i] = g; sim.solid[i] = 0; sim.depth[i] = 0; this.basin[i] = 0;
    if (hole || g > this.wallAbove) sim.solid[i] = 1;
    else if (anyWet) { this.basin[i] = 1; if (top > g) sim.depth[i] = top - g; }
  }

  // LA VENTANA POR TROZOS: cargar el agua de un recuadro (vóxeles locales, extremos incluidos, en celdas enteras) que
  // acaba de escribirse. El fondo y las paredes salen de los vóxeles; el agua, de lo guardado al descargarlo (save) o,
  // la primera vez, de `surface`: la superficie del agua de cada columna (o null si no tiene), como el agua de partida
  // del constructor (cargar todo por trozos da lo mismo que construir de una vez). Lo cargado nace quieto; el borde del
  // recuadro (las celdas de los dos lados) se despierta, para que el agua de aquí y la de al lado se igualen si no lo están
  load(x0: number, y0: number, x1: number, y1: number, src: { surface?: ((x: number, y: number) => number | null) | null; saved?: WaterChunk | null } = {}): void {
    this.loadJob(x0, y0, x1, y1, src, Infinity).run(0);
  }

  // Lo mismo que load, como trabajo por pasos: `rows` filas de celdas por llamada (por unidades, no por reloj: el agua es
  // de la simulación y no lee el reloj; el plazo de la cola no se mira). Para cargar el trozo en la cola sin pagarlo de
  // una vez (LiveWindow: onLoad lo devuelve y la ventana lo corre dentro del trabajo del trozo, antes de darlo por
  // escrito). Lo cargado a medias es pared seca en las filas que faltan. La ventana no puede correrse mientras tanto
  loadJob(x0: number, y0: number, x1: number, y1: number, src: { surface?: ((x: number, y: number) => number | null) | null; saved?: WaterChunk | null } = {}, rows = 32): { run(deadline: number): boolean } {
    const { sim, gw, gh } = this;
    if (x0 % CELL || y0 % CELL || (x1 + 1) % CELL || (y1 + 1) % CELL) throw new Error(`WaterLayer.load: el recuadro ${x0},${y0}..${x1},${y1} no es de celdas enteras (${CELL})`);
    const gx0 = Math.max(0, x0 / CELL), gy0 = Math.max(0, y0 / CELL), gx1 = Math.min(gw - 1, (x1 + 1) / CELL - 1), gy1 = Math.min(gh - 1, (y1 + 1) / CELL - 1);
    if (gx0 > gx1 || gy0 > gy1) return { run: () => true };
    const saved = src.saved ?? null;
    if (saved && (saved.w !== gx1 - gx0 + 1 || saved.h !== gy1 - gy0 + 1)) throw new Error(`WaterLayer.load: lo guardado es de ${saved.w} x ${saved.h} celdas y el recuadro de ${gx1 - gx0 + 1} x ${gy1 - gy0 + 1}`);
    const shifts = this.shifts, surface = saved ? null : src.surface ?? null;
    let gy = gy0, lo = Infinity, hi = -Infinity;
    return { run: () => {
      if (this.shifts !== shifts) throw new Error('WaterLayer.loadJob: la capa se corrió con la carga a medias');
      for (let n = 0; gy <= gy1; gy++, n++) {
        if (n >= rows) return false;
        for (let gx = gx0; gx <= gx1; gx++) {
          const i = sim.at(gx, gy);
          this.initCell(gx, gy, surface);
          if (saved && !sim.solid[i]) { const k = (gy - gy0) * saved.w + gx - gx0; this.basin[i] = saved.basin[k]!; sim.depth[i] = saved.depth[k]!; }
          sim.clearFlow(i);
          this.basin0[i] = this.basin[i]!;
          this.soakMaybe(i);
          if (this.basin[i] && !sim.solid[i]) { const g = sim.ground[i]!; lo = Math.min(lo, g - 4); hi = Math.max(hi, g + sim.depth[i]! + 8); }
        }
        // (lo de la fila, para quien copia: ya es agua de verdad)
        this.changed(gx0, gy, gx1, gy);
      }
      this.zRange = [Math.floor(Math.min(this.zRange[0], lo)), Math.ceil(Math.max(this.zRange[1], hi))];
      // El borde, de los dos lados
      for (let by = gy0 - 1; by <= gy1 + 1; by++) for (let bx = gx0 - 1; bx <= gx1 + 1; bx++) {
        if (bx >= gx0 + 1 && bx <= gx1 - 1 && by >= gy0 + 1 && by <= gy1 - 1) continue;
        if (bx < 0 || by < 0 || bx >= gw || by >= gh) continue;
        const i = sim.at(bx, by);
        if (sim.depth[i]! > 0) sim.wake(bx, by, 0);
      }
      this.groundVersion++;
      return true;
    } };
  }


  // Lo que hay que guardar del agua de un recuadro al descargarlo (onUnload), para load: la profundidad y la cuenca de
  // cada celda (sin flujos: vuelve quieta). null si no tiene agua ni cuenca (no hace falta guardar nada)
  save(x0: number, y0: number, x1: number, y1: number): WaterChunk | null {
    const { sim, gw, gh } = this;
    const gx0 = Math.max(0, Math.floor(x0 / CELL)), gy0 = Math.max(0, Math.floor(y0 / CELL)), gx1 = Math.min(gw - 1, Math.floor(x1 / CELL)), gy1 = Math.min(gh - 1, Math.floor(y1 / CELL));
    if (gx0 > gx1 || gy0 > gy1) return null;
    const w = gx1 - gx0 + 1, h = gy1 - gy0 + 1, depth = new Float32Array(w * h), basin = new Uint8Array(w * h);
    let any = false;
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const i = sim.at(gx, gy), k = (gy - gy0) * w + gx - gx0;
      depth[k] = sim.solid[i] ? 0 : sim.depth[i]!; basin[k] = this.basin[i]!;
      if (depth[k]! > 0 || basin[k]) any = true;
    }
    return any ? { w, h, depth, basin } : null;
  }

  // Por qué el agua no está en reposo (una celda mojada más alta que una vecina a la que puede echar agua), o null
  private restless(): string | null {
    const { sim, gw, gh } = this;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const i = sim.at(gx, gy);
      if (sim.solid[i] || !(sim.depth[i]! > 0)) continue;
      const s = sim.ground[i]! + sim.depth[i]!;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = gx + ox, ny = gy + oy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = sim.at(nx, ny);
        if (!sim.solid[j] && s > sim.ground[j]! + sim.depth[j]!) return `la celda ${gx},${gy} puede echar agua a ${nx},${ny}`;
      }
    }
    return null;
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
  // celda que queda por debajo del agua de una vecina de cuenca pasa a ser cuenca (no se empapa). Y desde ella, como el
  // agua: las vecinas sin pared con el fondo por debajo de ese nivel también, y las suyas (un canal abierto a un lago
  // y la fosa en que acaba, aunque se picara antes y esté fuera de la caja); si no, se empaparían para siempre y el
  // lago se iría vaciando por ellas sin dormirse nunca
  syncGround(box: { x0: number; y0: number; x1: number; y1: number } | ReadonlyArray<{ x0: number; y0: number; x1: number; y1: number }>): void {
    const { sim } = this, boxes = Array.isArray(box) ? box : [box as { x0: number; y0: number; x1: number; y1: number }];
    // 1) el fondo, la pared y la profundidad de todas las cajas (las de un paso juntas: una zanja que cruza trozos llega
    //    en varias, y la cuenca tiene que ver el fondo nuevo de todas)
    const cells: number[] = [];
    for (const b of boxes) {
      const gx0 = Math.max(0, Math.floor(b.x0 / CELL)), gx1 = Math.min(this.gw - 1, Math.floor(b.x1 / CELL));
      const gy0 = Math.max(0, Math.floor(b.y0 / CELL)), gy1 = Math.min(this.gh - 1, Math.floor(b.y1 / CELL));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const i = sim.at(gx, gy);
        const [g, hole] = this.groundOf(gx, gy);
        // La superficie que se conserva: la del agua que hay. Una celda seca no tiene (picarla no crea agua: el hoyo lo
        // llena lo que le llegue de sus vecinas)
        const surface = sim.solid[i] || !(sim.depth[i]! > 0) ? -Infinity : sim.ground[i]! + sim.depth[i]!;
        sim.ground[i] = g;
        sim.solid[i] = hole || g > this.wallAbove ? 1 : 0;
        sim.depth[i] = sim.solid[i] ? 0 : Math.max(0, surface - g);
        cells.push(i);
        sim.wake(gx, gy, 3);
      }
      this.changed(gx0, gy0, gx1, gy1);
    }
    // 2) la cuenca: una celda por debajo del agua de una vecina de cuenca pasa a serlo, y desde ella, como el agua, las
    //    vecinas sin pared con el fondo por debajo de ese nivel, y las suyas
    const flood: number[] = [], floodLevel: number[] = [];
    for (const i of cells) {
      if (sim.solid[i] || this.basin[i]) continue;
      const [gx, gy] = sim.xy(i);
      let level = -Infinity;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = gx + ox, ny = gy + oy;
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const j = sim.at(nx, ny);
        if (this.basin[j] && !sim.solid[j] && sim.depth[j]! > 0.04) level = Math.max(level, sim.ground[j]! + sim.depth[j]!);
      }
      if (sim.ground[i]! < level) { this.basin[i] = 1; flood.push(i); floodLevel.push(level); }
    }
    for (let k = 0; k < flood.length; k++) {
      const i = flood[k]!, level = floodLevel[k]!, [gx, gy] = sim.xy(i);
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = gx + ox, ny = gy + oy;
        if (nx < 0 || ny < 0 || nx >= this.gw || ny >= this.gh) continue;
        const j = sim.at(nx, ny);
        if (this.basin[j] || sim.solid[j] || !(sim.ground[j]! < level)) continue;
        this.basin[j] = 1; flood.push(j); floodLevel.push(level);
        this.changedCell(j);
      }
    }
    for (const i of cells) this.soakMaybe(i);
    this.groundVersion++;
    // (el tramo de alturas, ensanchado con lo tocado y lo inundado: recorrer la rejilla entera en cada syncGround era el
    // 10 % del paso del agua en una ventana grande que sigue al mundo. No se estrecha: es dónde se busca agua al pintar)
    this.widenWith(cells); this.widenWith(flood);
  }
  private widenWith(cells: ReadonlyArray<number>): void {
    let lo = this.zRange[0], hi = this.zRange[1];
    for (const i of cells) {
      if (!this.basin[i] || this.sim.solid[i]) continue;
      const g = this.sim.ground[i]!;
      lo = Math.min(lo, g - 4); hi = Math.max(hi, g + this.sim.depth[i]! + 8);
    }
    this.zRange = [Math.floor(lo), Math.ceil(hi)];
  }

  // Apunta que cambiaron las celdas de la caja (en celdas, extremos incluidos): en el registro de cajas y en sus baldosas
  private changed(gx0: number, gy0: number, gx1: number, gy1: number): void {
    this.markTiles(gx0, gy0, gx1, gy1);
    this.logBox(gx0, gy0, gx1, gy1);
  }
  private logBox(gx0: number, gy0: number, gx1: number, gy1: number): void {
    const c = this.cur;
    if (gx0 < c[0]!) c[0] = Math.max(0, gx0); if (gy0 < c[1]!) c[1] = Math.max(0, gy0);
    if (gx1 > c[2]!) c[2] = Math.min(this.gw - 1, gx1); if (gy1 > c[3]!) c[3] = Math.min(this.gh - 1, gy1);
  }
  private changedCell(i: number): void { const [gx, gy] = this.sim.xy(i); this.changed(gx, gy, gx, gy); }
  // Las baldosas de TILE x TILE celdas de la caja: a la lista de las cambiadas
  private markTiles(gx0: number, gy0: number, gx1: number, gy1: number): void {
    const tx0 = Math.max(0, Math.floor(gx0 / TILE)), ty0 = Math.max(0, Math.floor(gy0 / TILE));
    const tx1 = Math.min(this.tilesX - 1, Math.floor(gx1 / TILE)), ty1 = Math.min(this.tilesY - 1, Math.floor(gy1 / TILE)), v = this.tileEpoch;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.markTile(ty * this.tilesX + tx, v);
  }
  // Una baldosa cambió (v: la época de ahora, que sube con cada lectura, changedTiles): la primera vez desde la última
  // lectura, a la lista de las cambiadas. (Por época y no por tick: si se lee a mitad de un tick y la baldosa vuelve a
  // cambiar, tiene que volver a la lista)
  private markTile(k: number, v: number): void {
    if (this.tileVer[k] === v) return;
    this.tileVer[k] = v;
    this.tileLog[this.tileLogN % TILE_LOG] = k;
    this.tileLogN++;
  }
  // Las baldosas (de TILE x TILE celdas, tx + ty * tilesX, en las coordenadas de ahora) que cambiaron desde `seq` (el que
  // dio la llamada anterior; 0 al empezar), sin repetir. Más fino que la caja de changesSince: con agua despierta en varios
  // sitios lejanos, la caja los cubre a todos y lo de en medio. Sale de una lista de las que cambiaron (sin recorrerlas
  // todas); las de antes de un corrimiento salen corridas con él (y las que salieron de la rejilla, no). all: la lista no
  // llega tan atrás, o hubo un corrimiento que no es de baldosas enteras: quien copia, todo
  changedTiles(seq: number): { seq: number; all: boolean; tiles: number[] } {
    this.tileEpoch++;
    const n = this.tileLogN;
    if (n - seq > TILE_LOG) return { seq: n, all: true, tiles: [] };
    const out: number[] = [], seen = this.tileSeen, stamp = ++this.tileSeenStamp, X = this.tilesX, Y = this.tilesY;
    let ox = 0, oy = 0;
    for (let e = n - 1; e >= seq; e--) {
      const k = this.tileLog[e % TILE_LOG]!;
      // (un corrimiento: lo de antes de él sale corrido; uno que no es de baldosas enteras, o ya olvidado, todo)
      if (k < 0) {
        const r = this.tileShifts[-1 - k - this.tileShiftBase];
        if (!r || r.all) return { seq: n, all: true, tiles: [] };
        ox += r.tdx; oy += r.tdy;
        continue;
      }
      const tx = (k % X) - ox, ty = Math.floor(k / X) - oy;
      if (tx < 0 || ty < 0 || tx >= X || ty >= Y) continue;
      const k2 = ty * X + tx;
      if (seen[k2] === stamp) continue;
      seen[k2] = stamp; out.push(k2);
    }
    return { seq: n, all: false, tiles: out };
  }
  private closeChanges(): void {
    const c = this.cur;
    if (c[0]! > c[2]!) return;
    this.log.set(c, (this.logN % CHANGE_LOG) * 4);
    this.logN++;
    c[0] = c[1] = 0x7fffffff; c[2] = c[3] = -1;
  }
  // Lo que cambió desde `seq` (el seq que dio la llamada anterior; 0 al empezar): la caja de celdas que lo cubre (null
  // si nada), o all si el registro ya no llega tan atrás. Lo del tick en curso sale siempre (también la vez siguiente)
  // Las cajas de antes de un corrimiento salen corridas con él (en las coordenadas de ahora, recortadas a la rejilla)
  changesSince(seq: number): { seq: number; all: boolean; box: [number, number, number, number] | null } {
    if (this.logN - seq > CHANGE_LOG) return { seq: this.logN, all: true, box: null };
    const sl = this.shiftLog;
    if (sl.length === CHANGE_LOG && sl[0]!.at > seq) return { seq: this.logN, all: true, box: null };
    let x0 = this.cur[0]!, y0 = this.cur[1]!, x1 = this.cur[2]!, y1 = this.cur[3]!;
    // (de la más nueva a la más vieja, sumando los corrimientos que van quedando detrás)
    let ox = 0, oy = 0, si = sl.length - 1;
    for (let k = this.logN - 1; k >= seq; k--) {
      while (si >= 0 && sl[si]!.at > k) { ox += sl[si]!.cx; oy += sl[si]!.cy; si--; }
      const o = (k % CHANGE_LOG) * 4, l = this.log;
      const a0 = Math.max(0, l[o]! - ox), b0 = Math.max(0, l[o + 1]! - oy), a1 = Math.min(this.gw - 1, l[o + 2]! - ox), b1 = Math.min(this.gh - 1, l[o + 3]! - oy);
      if (a0 > a1 || b0 > b1) continue;
      if (a0 < x0) x0 = a0; if (b0 < y0) y0 = b0; if (a1 > x1) x1 = a1; if (b1 > y1) y1 = b1;
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
  exportState(): WaterState { return { ...this.sim.exportState(), basin: this.sim.logical(this.basin) }; }

  // Vuelve a una instantánea (WorldState.restore, con los vóxeles ya restaurados). La profundidad, los flujos y las
  // despiertas guardadas son la verdad: no se tocan ni se despierta nada más. Las cuencas, las guardadas (una
  // instantánea de antes, sin ellas, deja las del mundo de partida). Si la capa sigue al mundo (follow), el fondo y
  // las paredes se rehacen de los vóxeles restaurados y lo pendiente de syncGround se descarta: la restauración ya
  // trae agua y mundo coherentes (un syncGround conservando la superficie metería agua de más donde se picó)
  importState(s: WaterState): void {
    // (corrida: las cuencas de partida pasan al orden de la rejilla, como el fondo y las paredes en sim.importState)
    if (this.sim.origin[0] || this.sim.origin[1]) this.basin0.set(this.sim.logical(this.basin0));
    this.sim.importState(s);
    this.basin.set(s.basin ?? this.basin0);
    this.soakAll();
    if (this.watch) {
      this.watch.take();
      const { sim } = this;
      for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) {
        const i = sim.at(gx, gy), [g, hole] = this.groundOf(gx, gy);
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

  // LA VENTANA VIVA (Attached de LiveWindow): el mundo se corrió dx, dy vóxeles (lo que estaba en x pasa a x - dx),
  // múltiplos de la celda. La rejilla se corre en anillo (ShallowWater.shift, sin copiar) y lo que entra queda seco y de
  // pared, sin cuenca, hasta que se cargue (load). Las vistas que copian la rejilla la copian entera la próxima vez
  shift(dx: number, dy: number): void {
    if (!dx && !dy) return;
    if (!this.movable) throw new Error('WaterLayer.shift: la capa no es movable (WaterOptions.movable)');
    if (dx % CELL || dy % CELL) throw new Error(`WaterLayer.shift: ${dx}, ${dy} no es múltiplo de la celda (${CELL})`);
    const cx = dx / CELL, cy = dy / CELL, { gw, gh, sim } = this;
    sim.shift(cx, cy);
    const bx = Math.max(-gw, Math.min(gw, cx)), by = Math.max(-gh, Math.min(gh, cy));
    const clear = (x0: number, y0: number, x1: number, y1: number) => sim.runs(x0, y0, x1, y1, (a, z) => { this.basin.fill(0, a, z); this.basin0.fill(0, a, z); });
    if (bx > 0) clear(gw - bx, 0, gw - 1, gh - 1); else if (bx < 0) clear(0, 0, -bx - 1, gh - 1);
    if (by > 0) clear(0, gh - by, gw - 1, gh - 1); else if (by < 0) clear(0, 0, gw - 1, -by - 1);
    // (la fuente no se corre: es de los escenarios de una pieza)
    this.fountainIn = []; this.fountainOut = [];
    // Lo apuntado hasta aquí (en las coordenadas de antes) se cierra, y el corrimiento queda apuntado: changesSince corre
    // esas cajas. Lo que cambió es la franja que entra (quien copia se corre por su cuenta: WaterView.shift)
    this.closeChanges();
    // (las baldosas se corren con la rejilla si el corrimiento es de baldosas enteras; si no, todas cambiaron. La franja
    // que entra la marcan las cajas de abajo)
    // (la lista de las cambiadas apunta el corrimiento como una entrada más, negativa: las de antes salen corridas en
    // changedTiles. Uno que no es de baldosas enteras: todo)
    const aligned = !(cx % TILE || cy % TILE);
    if (aligned) shiftGrid(this.tileVer, this.tilesX, this.tilesY, 1, cx / TILE, cy / TILE, 0); else this.tileVer.fill(0);
    this.tileShifts.push({ tdx: aligned ? cx / TILE : 0, tdy: aligned ? cy / TILE : 0, all: !aligned });
    if (this.tileShifts.length > TILE_SHIFTS) { this.tileShifts.shift(); this.tileShiftBase++; }
    this.tileLog[this.tileLogN % TILE_LOG] = -1 - (this.tileShiftBase + this.tileShifts.length - 1);
    this.tileLogN++;
    this.shiftLog.push({ at: this.logN, cx, cy });
    if (this.shiftLog.length > CHANGE_LOG) this.shiftLog.shift();
    this.shifts++;
    if (bx > 0) this.changed(gw - bx, 0, gw - 1, gh - 1); else if (bx < 0) this.changed(0, 0, -bx - 1, gh - 1);
    if (by > 0) this.changed(0, gh - by, gw - 1, gh - 1); else if (by < 0) this.changed(0, 0, gw - 1, -by - 1);
    this.closeChanges();
    this.groundVersion++;
  }

  // EL FOCO (para una ventana grande): solo se simula el agua a r vóxeles o menos de (x, y) (un recuadro, en celdas
  // enteras); lo de fuera queda congelado (lo despierto sigue despierto y quieto, no se empapa ni pierde ni gana agua) y
  // retoma donde estaba al entrar en el foco. Dentro, lo de siempre, con el borde del foco como pared. null: todo
  setFocus(x: number | null, y = 0, r = 0): void {
    if (x === null) { this.sim.focus = null; return; }
    const { gw, gh } = this;
    const x0 = Math.max(0, Math.floor((x - r) / CELL)), y0 = Math.max(0, Math.floor((y - r) / CELL));
    const x1 = Math.min(gw - 1, Math.floor((x + r) / CELL)), y1 = Math.min(gh - 1, Math.floor((y + r) / CELL));
    this.sim.focus = x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : [0, 0, -1, -1];
  }

  // Escuchar los cambios de vóxeles del mundo (picar, poner) y rehacer el fondo de lo tocado en cada step. Sin esto, el
  // agua no se entera (como siempre): quien quiera que siga al mundo lo pide
  follow(watch: ChangeWatch): void { this.watch = watch; }

  private cellOf(x: number, y: number): number {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    return gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh ? -1 : this.sim.at(gx, gy);
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
    for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) {
      const i = this.sim.at(gx, gy), o = gy * this.gw + gx;
      const d = this.sim.depth[i]!;
      const wet = !this.sim.solid[i] && d >= 0.04;
      surface[o] = wet ? this.sim.ground[i]! + d : NaN;
      depth[o] = wet ? d : 0;
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
    const [gx, gy] = this.sim.xy(i);
    this.sim.wake(gx, gy, 3);
  }

  // Centros (ejes del modelo) de las celdas donde cae el agua del cuenco de la fuente
  fountainLanding(k: number): [number, number] | null {
    if (!this.fountainIn.length) return null;
    const [gx, gy] = this.sim.xy(this.fountainIn[k % this.fountainIn.length]!);
    return [gx * CELL + 1, gy * CELL + 1];
  }

  // Un paso de simulación de `dt` (el mundo lo llama con 1/60 fijo): exactamente round(dt * 120) subpasos de 1/120,
  // sin acumular tiempo, así la misma partida da siempre el mismo agua
  step(dt: number): void {
    // (lo que escribe la ventana al cargar un trozo, 'load', no: su fondo y su agua los pone load)
    if (this.watch) { const boxes = this.watch.take().boxes.filter((b) => b.cause !== 'load'); if (boxes.length) this.syncGround(boxes); }
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
      const act = sim.activeCells(), depth = sim.depth, inSoak = this.inSoak, list = this.soakList, gw = this.gw, gh = this.gh;
      const [ox, oy] = sim.origin, tv = this.tileVer, tilesX = this.tilesX, stamp = this.tileEpoch;
      let ax0 = gw, ay0 = this.gh, ax1 = -1, ay1 = -1;
      // (las baldosas de las activas de este subpaso, sin repetir: las del último las lee WorldState.step, stepTiles)
      const seen = this.stepSeen, sst = ++this.stepSeenStamp;
      this.nStepTiles = 0;
      for (let q = 0; q < act.length; q++) {
        const i = act[q]!;
        if (!inSoak[i] && !basin[i] && depth[i]! > 0) { inSoak[i] = 1; list[this.nSoak++] = i; }
        let x = i % gw, y = (i - x) / gw;
        x -= ox; if (x < 0) x += gw; y -= oy; if (y < 0) y += gh;
        if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; if (y < ay0) ay0 = y; if (y > ay1) ay1 = y;
        const k = Math.floor(y / TILE) * tilesX + Math.floor(x / TILE);
        if (tv[k] !== stamp) this.markTile(k, stamp);
        if (seen[k] !== sst) { seen[k] = sst; this.stepTiles[this.nStepTiles++] = k; }
      }
      if (ax1 >= 0) this.logBox(ax0, ay0, ax1, ay1);
    }
    // El agua que salta al suelo seco se empapa poco a poco (cada celda por su cuenta: el orden no cuenta)
    const soak = Math.min(dt, 0.05) * 0.3, list = this.soakList, depth = sim.depth;
    let m = 0;
    this.soakVisited = this.nSoak;
    const fc = sim.focus;
    for (let k = 0; k < this.nSoak; k++) {
      const i = list[k]!;
      if (basin[i] || !(depth[i]! > 0)) { this.inSoak[i] = 0; continue; }
      // (fuera del foco, congelado: no se empapa; sigue en la lista)
      if (fc) { const [x, y] = sim.xy(i); if (x < fc[0] || x > fc[2] || y < fc[1] || y > fc[3]) { list[m++] = i; continue; } }
      depth[i] = depth[i]! < 0.03 ? 0 : depth[i]! - soak * Math.max(0.25, depth[i]!);
      this.changedCell(i);
      if (depth[i]! > 0) list[m++] = i; else this.inSoak[i] = 0;
    }
    this.nSoak = m;
    this.closeChanges();
  }

  draw(b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    ambient: readonly [number, number, number], time: number, worldLights: readonly WorldLight[], reflect = true, cut: CutBox | null = null, look: WaterLook | null = null): void {
    // (drawWater lee la rejilla en el orden y * gw + x: corrida, se dibuja por una vista, WaterView)
    if (this.sim.origin[0] || this.sim.origin[1]) throw new Error('WaterLayer.draw: la capa está corrida (anillo); se dibuja con una WorldView (WaterView)');
    drawWater(this, b, view, depthBuf, total, vx, vy, vw, vh, ambient, time, worldLights, reflect, cut, look);
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

// Qué recuadros de la profundidad subir a la GPU en un cuadro: vis, lo que se ve ahora (celdas, extremos incluidos);
// valid, lo que se vio y quedó al día el cuadro anterior (null: nada); ch, lo de depthSince desde entonces (null: sin
// registro). Sin registro, con un corrimiento, un registro que no llega o nada al día: lo que se ve, entero. Si no: lo
// que cambió (recortado a lo que se ve, lo hace quien sube) y lo que entra en la vista (columnas y filas de vis fuera de
// valid). Lo de fuera de la vista no se mantiene al día: al entrar, se sube
export function waterDepthRects(ch: { all: boolean; shift: readonly [number, number] | null; box: readonly [number, number, number, number] | null } | null,
  valid: readonly [number, number, number, number] | null, vis: readonly [number, number, number, number]): Array<[number, number, number, number]> {
  const [gx0, gy0, gx1, gy1] = vis;
  if (!ch || ch.all || ch.shift || !valid) return [[gx0, gy0, gx1, gy1]];
  const out: Array<[number, number, number, number]> = [];
  if (ch.box) out.push([...ch.box] as [number, number, number, number]);
  if (gx0 < valid[0]) out.push([gx0, gy0, Math.min(gx1, valid[0] - 1), gy1]);
  if (gx1 > valid[2]) out.push([Math.max(gx0, valid[2] + 1), gy0, gx1, gy1]);
  if (gy0 < valid[1]) out.push([gx0, gy0, gx1, Math.min(gy1, valid[1] - 1)]);
  if (gy1 > valid[3]) out.push([gx0, Math.max(gy0, valid[3] + 1), gx1, gy1]);
  return out;
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
// El corte al componer (section.ts): el agua dentro de la caja, desde zMin, no se dibuja; con ventana (la forma del
// corte en la imagen), solo deja de dibujarse en los píxeles de dentro
export interface CutBox { x0: number; x1: number; y0: number; y1: number; zMin: number; window?: SectionWindow | null }

export function drawWater(w: WaterGrid, b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    ambient: readonly [number, number, number], time: number, worldLights: readonly WorldLight[], reflect = true, cut: CutBox | null = null, look: WaterLook | null = null): void {
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
    const win = cut && gx * CELL >= cut.x0 && gx * CELL <= cut.x1 && gy * CELL >= cut.y0 && gy * CELL <= cut.y1 && zs >= cut.zMin ? cut.window ?? true : null;
    if (win === true) continue;
    const north = gy * CELL + CELL, south = gy * CELL;
    const sy0 = Math.round(originY - a * north - zs), sy1 = Math.max(sy0 + 1, Math.round(originY - a * south - zs));
    const ymid = (north + south) / 2;
    const depthHere = ymid * f1 + zs * f2;
    // Normal y curvatura de la superficie
    const sE = gx < gw - 1 ? sAt(i + 1, zs) : zs, sW = gx > 0 ? sAt(i - 1, zs) : zs;
    const sN = gy < gh - 1 ? sAt(i + gw, zs) : zs, sS = gy > 0 ? sAt(i - gw, zs) : zs;
    let sx = (sE - sW) / (2 * CELL), sy = (sN - sS) / (2 * CELL);
    if (look?.waves && (d >= 0.6 || w.basin[i])) {
      const wv = look.waves, wind = wv.climate.data[climateCell(wv.climate, gx * CELL + 1, gy * CELL + 1) + 2]!;
      sx += waveSlope(wv, gx, gy, wind, 0); sy += waveSlope(wv, gx, gy, wind, 1);
    }
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
    if (total && look?.sun) {
      const { look: s, table } = look.sun, k = cloudShade(table, gx * CELL + 1, gy * CELL + 1);
      lr += s.faces[12]! * k; lg += s.faces[13]! * k; lb += s.faces[14]! * k;
    }
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
        if (win && windowContains(win, px, sy)) continue;             // el agua de la caja, por la ventana del corte
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
        // Lo sumergido que se ve a través del agua (MaterialProps.aquatic): más teñido cuanto más hondo
        if (look?.clear?.[t]) {
          const k = seenThrough(srcDepth[t]! - depthHere, a, f1, f2);
          const mix = (u: number, c: number) => Math.floor(u + (c - u) * k + 0.5);
          cr = mix(srcView[o]!, cr); cg = mix(srcView[o + 1]!, cg); cb = mix(srcView[o + 2]!, cb);
          if (srcTotal) { ltr = srcTotal[q]! + (ltr - srcTotal[q]!) * k; ltg = srcTotal[q + 1]! + (ltg - srcTotal[q + 1]!) * k; ltb = srcTotal[q + 2]! + (ltb - srcTotal[q + 2]!) * k; }
        }
        if (spec > 0.35) { cr = white[0]; cg = white[1]; cb = white[2]; }
        view[o] = cr; view[o + 1] = cg; view[o + 2] = cb; view[o + 3] = 255;
        depthBuf[t] = depthHere;
        if (total) { total[q] = ltr; total[q + 1] = ltg; total[q + 2] = ltb; }
      }
    }
  }
}
