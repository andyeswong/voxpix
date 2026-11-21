// LA VENTANA VIVA, 1: los vóxeles de la ventana (fase 4, 3a).
//
// Un mundo sin bordes se tiene en memoria a trozos: una ventana de nx x ny trozos alrededor del objetivo. Sus vóxeles van
// en un StaticVoxels (store) con la esquina de la ventana en (0, 0): el trozo del mundo (tx, ty) está en
// ((tx - tx0) * trozo, (ty - ty0) * trozo). Mover la ventana es StaticVoxels.shift: las losas se corren por referencia
// (no se copia ningún vóxel; solo las alturas), y los trozos que entran quedan vacíos para escribirlos. El juego y la
// simulación siguen en coordenadas del MUNDO (sin tope, también negativas): la ventana resta su esquina al leer y al
// escribir.
//
// El tamaño del trozo (trozo, en vóxeles) es múltiplo de CHUNK: así cada trozo del mundo cae en trozos de vóxeles
// enteros del store (y BlockGrid.stampRegion los escribe de una vez). Escribir un trozo que entra: con un BlockGrid
// sobre el store y slotCell como sitio. Un trozo de la ventana que todavía no se escribió no es del mundo (holds).
import type { Palette, VoxelSource } from '../core';
import { StaticVoxels, CHUNK } from './state';


export class WindowVoxels implements VoxelSource {
  readonly store: StaticVoxels;
  readonly W: number;                 // ancho y fondo de la ventana en vóxeles
  readonly D: number;
  // La ventana: los trozos del mundo tx0..tx0 + nx - 1, ty0..ty0 + ny - 1
  tx0 = 0;
  ty0 = 0;
  // Los trozos del mundo ya escritos ("tx,ty")
  private held = new Set<string>();

  constructor(readonly palette: Palette, readonly nx: number, readonly ny: number, readonly trozo: number, readonly zMin: number, readonly zMax: number) {
    if (trozo % CHUNK !== 0) throw new Error(`el trozo (${trozo}) tiene que ser múltiplo de ${CHUNK}`);
    this.W = nx * trozo; this.D = ny * trozo;
    this.store = new StaticVoxels(palette, this.W, this.D, zMin, zMax);
  }

  // Dónde está en el store el trozo del mundo (tx, ty) (en vóxeles), y la celda de un BlockGrid sobre el store con
  // bloques de `block` vóxeles
  slotOrigin(tx: number, ty: number): [number, number] { return [(tx - this.tx0) * this.trozo, (ty - this.ty0) * this.trozo]; }
  slotCell(tx: number, ty: number, block: number): [number, number] { const [x, y] = this.slotOrigin(tx, ty); return [x / block, y / block]; }

  // ¿El trozo (tx, ty) está en la ventana? ¿Y ya está escrito?
  inWindow(tx: number, ty: number): boolean { return tx >= this.tx0 && tx < this.tx0 + this.nx && ty >= this.ty0 && ty < this.ty0 + this.ny; }
  holds(tx: number, ty: number): boolean { return this.held.has(`${tx},${ty}`); }
  // Apunta que el trozo (tx, ty) ya está escrito
  markLoaded(tx: number, ty: number): void {
    if (!this.inWindow(tx, ty)) throw new Error(`el trozo ${tx}, ${ty} no está en la ventana (${this.tx0}, ${this.ty0})`);
    this.held.add(`${tx},${ty}`);
  }

  // Mueve la ventana a (tx0, ty0) (StaticVoxels.shift). Devuelve los trozos que salen y los que entran (hay que
  // escribirlos y markLoaded), los de entrada ordenados del centro hacia fuera
  moveTo(tx0: number, ty0: number): { left: Array<[number, number]>; entered: Array<[number, number]> } {
    const left: Array<[number, number]> = [], entered: Array<[number, number]> = [];
    const now = (tx: number, ty: number) => tx >= tx0 && tx < tx0 + this.nx && ty >= ty0 && ty < ty0 + this.ny;
    for (let ty = this.ty0; ty < this.ty0 + this.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + this.nx; tx++) {
      if (now(tx, ty)) continue;
      this.held.delete(`${tx},${ty}`);
      left.push([tx, ty]);
    }
    const k = this.trozo / CHUNK;
    this.store.shift((tx0 - this.tx0) * k, (ty0 - this.ty0) * k);
    this.tx0 = tx0; this.ty0 = ty0;
    for (let ty = ty0; ty < ty0 + this.ny; ty++) for (let tx = tx0; tx < tx0 + this.nx; tx++) if (!this.holds(tx, ty)) entered.push([tx, ty]);
    const cx = tx0 + (this.nx - 1) / 2, cy = ty0 + (this.ny - 1) / 2;
    entered.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy) || a[1] - b[1] || a[0] - b[0]);
    return { left, entered };
  }

  // ¿El vóxel del mundo (x, y) cae en un trozo de la ventana que ya está escrito?
  has(x: number, y: number): boolean {
    const tx = Math.floor(x / this.trozo), ty = Math.floor(y / this.trozo);
    return this.inWindow(tx, ty) && this.holds(tx, ty);
  }

  // Vóxeles en coordenadas del MUNDO. Fuera de la ventana, o en un trozo que aún no se escribió, aire
  get(x: number, y: number, z: number): number {
    if (!this.has(x, y)) return 0;
    return this.store.get(x - this.tx0 * this.trozo, y - this.ty0 * this.trozo, z);
  }
  set(x: number, y: number, z: number, value: number): void {
    if (!this.has(x, y)) throw new Error(`el vóxel ${x}, ${y} no está en un trozo escrito de la ventana`);
    this.store.set(x - this.tx0 * this.trozo, y - this.ty0 * this.trozo, z, value);
  }

  // Los llenos de la ventana, en coordenadas del mundo (trozo a trozo escrito)
  *entries(): Iterable<[number, number, number, number]> {
    for (let ty = this.ty0; ty < this.ty0 + this.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + this.nx; tx++) {
      if (!this.holds(tx, ty)) continue;
      const [ox, oy] = this.slotOrigin(tx, ty);
      for (let z = this.zMin; z <= this.zMax; z++) for (let ly = 0; ly < this.trozo; ly++) for (let lx = 0; lx < this.trozo; lx++) {
        const v = this.store.get(ox + lx, oy + ly, z);
        if (v) yield [tx * this.trozo + lx, ty * this.trozo + ly, z, v];
      }
    }
  }
}
