// LA VENTANA VIVA, 1: el toro de vóxeles (NARUTO, fase 4, 3a).
//
// Un mundo sin bordes se tiene en memoria a trozos: una ventana de nx x ny trozos alrededor del objetivo. Los vóxeles de
// la ventana van en un StaticVoxels de nx x ny ranuras (store), y el trozo del mundo (tx, ty) vive en la ranura
// (tx mod nx, ty mod ny). Avanzar un trozo es escribir los que entran en las ranuras que dejan los que salen: no se
// copia ni se traslada nada. El juego y la simulación siguen en coordenadas del MUNDO (sin tope, también negativas):
// la ventana traduce con el módulo al leer y al escribir. StaticVoxels no cambia.
//
// El tamaño del trozo (trozo, en vóxeles) es múltiplo de CHUNK: así cada trozo del mundo cae en trozos de vóxeles
// enteros del store (y BlockGrid.stampRegion los escribe de una vez). Escribir un trozo que entra: con un BlockGrid
// sobre el store y la ranura como sitio (slotCell). Lo de una ranura que todavía no tiene su trozo no es del mundo
// (holds dice qué trozo tiene cada ranura).
import type { Palette, VoxelSource } from '../core';
import { StaticVoxels, CHUNK } from './state';

const mod = (a: number, n: number) => ((a % n) + n) % n;

export class WindowVoxels implements VoxelSource {
  readonly store: StaticVoxels;
  readonly W: number;                 // ancho y fondo de la ventana en vóxeles
  readonly D: number;
  // La ventana: los trozos del mundo tx0..tx0 + nx - 1, ty0..ty0 + ny - 1
  tx0 = 0;
  ty0 = 0;
  // Qué trozo del mundo tiene cada ranura (sy * nx + sx), o null
  private held: Array<[number, number] | null>;

  constructor(readonly palette: Palette, readonly nx: number, readonly ny: number, readonly trozo: number, readonly zMin: number, readonly zMax: number) {
    if (trozo % CHUNK !== 0) throw new Error(`el trozo (${trozo}) tiene que ser múltiplo de ${CHUNK}`);
    this.W = nx * trozo; this.D = ny * trozo;
    this.store = new StaticVoxels(palette, this.W, this.D, zMin, zMax);
    this.held = new Array(nx * ny).fill(null);
  }

  // La ranura del trozo del mundo (tx, ty), y su esquina en vóxeles del store
  slot(tx: number, ty: number): [number, number] { return [mod(tx, this.nx), mod(ty, this.ny)]; }
  slotOrigin(tx: number, ty: number): [number, number] { const [sx, sy] = this.slot(tx, ty); return [sx * this.trozo, sy * this.trozo]; }
  // La celda de un BlockGrid (con bloques de `block` vóxeles) sobre el store donde empieza la ranura de (tx, ty)
  slotCell(tx: number, ty: number, block: number): [number, number] { const [x, y] = this.slotOrigin(tx, ty); return [x / block, y / block]; }

  // ¿El trozo (tx, ty) está en la ventana? ¿Y su ranura lo tiene ya escrito?
  inWindow(tx: number, ty: number): boolean { return tx >= this.tx0 && tx < this.tx0 + this.nx && ty >= this.ty0 && ty < this.ty0 + this.ny; }
  holds(tx: number, ty: number): boolean { const [sx, sy] = this.slot(tx, ty); const h = this.held[sy * this.nx + sx]; return !!h && h[0] === tx && h[1] === ty; }
  // Apunta que la ranura de (tx, ty) ya tiene su trozo (después de escribirlo)
  markLoaded(tx: number, ty: number): void {
    if (!this.inWindow(tx, ty)) throw new Error(`el trozo ${tx}, ${ty} no está en la ventana (${this.tx0}, ${this.ty0})`);
    const [sx, sy] = this.slot(tx, ty);
    this.held[sy * this.nx + sx] = [tx, ty];
  }

  // Mueve la ventana a (tx0, ty0). Devuelve los trozos que salen (sus ranuras quedan para los que entran) y los que
  // entran (hay que escribirlos y markLoaded), los de entrada ordenados del centro hacia fuera
  moveTo(tx0: number, ty0: number): { left: Array<[number, number]>; entered: Array<[number, number]> } {
    const left: Array<[number, number]> = [], entered: Array<[number, number]> = [];
    const was = (tx: number, ty: number) => tx >= this.tx0 && tx < this.tx0 + this.nx && ty >= this.ty0 && ty < this.ty0 + this.ny;
    for (let ty = this.ty0; ty < this.ty0 + this.ny; ty++) for (let tx = this.tx0; tx < this.tx0 + this.nx; tx++) {
      if (tx >= tx0 && tx < tx0 + this.nx && ty >= ty0 && ty < ty0 + this.ny) continue;
      if (this.holds(tx, ty)) { const [sx, sy] = this.slot(tx, ty); this.held[sy * this.nx + sx] = null; }
      left.push([tx, ty]);
    }
    for (let ty = ty0; ty < ty0 + this.ny; ty++) for (let tx = tx0; tx < tx0 + this.nx; tx++) if (!was(tx, ty) || !this.holds(tx, ty)) entered.push([tx, ty]);
    this.tx0 = tx0; this.ty0 = ty0;
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
    const tx = Math.floor(x / this.trozo), ty = Math.floor(y / this.trozo);
    if (tx < this.tx0 || tx >= this.tx0 + this.nx || ty < this.ty0 || ty >= this.ty0 + this.ny) return 0;
    const sx = mod(tx, this.nx), sy = mod(ty, this.ny), h = this.held[sy * this.nx + sx];
    if (!h || h[0] !== tx || h[1] !== ty) return 0;
    return this.store.get(sx * this.trozo + (x - tx * this.trozo), sy * this.trozo + (y - ty * this.trozo), z);
  }
  set(x: number, y: number, z: number, value: number): void {
    const tx = Math.floor(x / this.trozo), ty = Math.floor(y / this.trozo);
    if (!this.has(x, y)) throw new Error(`el vóxel ${x}, ${y} no está en un trozo escrito de la ventana`);
    const [sx, sy] = this.slot(tx, ty);
    this.store.set(sx * this.trozo + (x - tx * this.trozo), sy * this.trozo + (y - ty * this.trozo), z, value);
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
