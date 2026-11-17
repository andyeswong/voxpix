// EL MUNDO: la única fuente de verdad del juego. Lo leen igual los dos renderizadores (el 2D horneado del juego y
// el vóxel 3D) y la lógica (colisión, agua bajo los pies). Contiene:
//   - vóxeles estáticos en trozos de CHUNK x CHUNK (editables; cada trozo lleva su versión para volver a hornearlo);
//   - el agua: un fluido sobre la misma rejilla (WaterLayer: altura por columna en lagos y charcos);
//   - entidades: un modelo de vóxeles con posición y giro (MAIA, después los demás);
//   - fuentes de luz y gotas.
// Un solo sistema de coordenadas: ejes del modelo (x hacia el este, y hacia el norte, z hacia arriba; 1 unidad =
// 1 vóxel = 1 píxel). La única conversión es la cámara.
//
// SIMULACIÓN DETERMINISTA (acordado con FERN): el runtime lleva el tick (entrada -> mover entidades -> eventos ->
// world.step()). step() avanza 1/60 s fijo, sin reloj ni Math.random: el azar es un mulberry32 del estado, sembrado
// con la semilla de la partida. Misma semilla y mismos eventos dan la misma huella (hash).
import type { Palette, VoxelSource } from '../core';
import { decode, key, unkey, materialsOf, type MaterialTable } from '../core';
import type { WorldLight, Fountain } from './build';
import type { WaterLayer, WaterState } from './water';
import { Drops } from './particles';
import { FxSystem, fxRandom, type FxState } from '../core/effects';
import { fxWorldLights, type EffectsLayer } from './effects';
import { Floaters } from './floaters';
import { ObjectLayer, type ObjectsState } from './objects';
import { ChangeFeed, type ChangeWatch, type Box3 } from './changes';

export const CHUNK = 16;

// footAt y footing: la columna no se pisa. Un entero y no NaN: el suelo sale de una función que V8 no siempre
// incrusta, y un double devuelto así se guarda en el montón en cada llamada (basura por celda en moveBody, FERN
// 2026-11-02); los enteros pequeños no. Ninguna altura de vóxel llega a él
export const NO_FOOT = -1_000_000_000;

// Unas caras (direcciones) con su clave: forEachExposed con ellas da solo los vóxeles con aire delante de alguna
export interface FaceSet { key: number; dirs: ReadonlyArray<readonly [number, number, number]> }

// Una losa preparada para StaticVoxels.writeChunkPrepared (como una losa de 1 byte por dentro)
export interface PreparedSlab { d: Uint8Array; pal: Uint16Array; palN: number; count: number }

// Vóxeles estáticos en trozos. Un TROZO es una columna de CHUNK x CHUNK con toda la altura (zMin..zMax): es la
// unidad de las versiones, de changedSince, de watchChanges y del rehorneado. Por dentro, cada trozo se guarda en
// LOSAS de CHUNK x CHUNK x SLAB vóxeles, y cada losa ocupa solo lo que necesita:
//   - nada: toda aire, o toda del mismo valor (uni[s]: la roca de un terreno, el aire de encima);
//   - 1 byte por vóxel con una paleta propia (pal[s]) mientras la losa tenga como mucho 256 valores distintos;
//   - 2 bytes por vóxel si tiene más.
// get/set/entries no cambian por fuera, ni el orden de entries (trozo, z, y, x), ni exportChunks (la columna entera
// de siempre, así la instantánea y la huella son las mismas byte a byte).
export const SLAB = 16;           // get usa desplazamientos de 4 bits: CHUNK y SLAB tienen que ser 16
const SEGS = 4;
const SLAB_CELLS = CHUNK * CHUNK * SLAB;
const PAL_LOOKUP = new Uint16Array(65536);           // writeChunkSlabs: valor -> entrada de la paleta + 1 (0: no está)

// Para la copia girada por losas: dónde cae cada celda (ly, lx) de una capa de 16 x 16 al girar `q` cuartos (índice
// ly * 16 + lx -> el girado), y el trozo de la copia donde cae cada trozo (como ViewCamera.cellToView, con ancho y
// fondo múltiplos de CHUNK)
const ROT_PERM = [0, 1, 2, 3].map((q) => {
  const t = new Uint16Array(256);
  for (let ly = 0; ly < CHUNK; ly++) for (let lx = 0; lx < CHUNK; lx++) {
    const M = CHUNK - 1;
    const [vx, vy] = q === 0 ? [lx, ly] : q === 1 ? [ly, M - lx] : q === 2 ? [M - lx, M - ly] : [M - ly, lx];
    t[(ly << 4) | lx] = (vy << 4) | vx;
  }
  return t;
});
function rotChunk(q: number, cx: number, cy: number, cols: number, rows: number, dcols: number): number {
  const [vx, vy] = q === 0 ? [cx, cy] : q === 1 ? [cy, cols - 1 - cx] : q === 2 ? [cols - 1 - cx, rows - 1 - cy] : [rows - 1 - cy, cx];
  return vy * dcols + vx;
}

export class StaticVoxels implements VoxelSource {
  readonly cols: number;
  readonly rows: number;
  readonly zh: number;
  readonly nz: number;                                  // losas por trozo
  private data: Array<Uint8Array | Uint16Array | null>;   // por losa (trozo * nz + losa)
  private pal: Array<Uint16Array | null>;                 // la paleta de las losas de 1 byte
  private palN: Uint16Array;                              // cuántas entradas usa esa paleta
  private uni: Uint16Array;                               // el valor de toda la losa cuando no tiene datos
  private count: Uint16Array;                             // vóxeles llenos de cada losa
  // Por losa, qué vóxeles tienen alguna cara al aire: por fila (capa z y fila y), un bit por x. Se calcula al pedirlo
  // (forEachExposed) y vale mientras no cambien el trozo ni sus 4 vecinos (su versión) ni se importe el mundo (la
  // época): una franja del rehorneado vuelve a recorrer las mismas losas, y las de un corte hondo son casi todo
  // vóxeles enterrados
  private expo: Array<Uint16Array | null> = [];
  private expoOk: Array<Uint8Array | null> = [];  // qué filas de la máscara están hechas (se hacen al pedirlas)
  private expoAt: Float64Array = new Float64Array(0);
  // Lo mismo, pero contando solo unas caras (las que miran a la cámara: forEachExposed con faces): un vóxel con aire solo
  // por otras caras no pinta nada. Un juego de máscaras para una lista de caras (expoKey); con otra, se rehacen
  private expoF: Array<Uint16Array | null> = [];
  private expoFOk: Array<Uint8Array | null> = [];
  private expoFAt: Float64Array = new Float64Array(0);
  private expoKey = -1;
  private epoch = 0;
  private alloc: Uint8Array;                              // el trozo tuvo algún vóxel alguna vez (exportChunks)
  // La CAJA de lo cambiado en cada trozo, por tramos de la historia (para rehornear solo eso, changedBox): hasta
  // SEGS tramos por trozo, cada uno [versión del último cambio, x0, y0, z0, x1, y1, z1]. Un tramo empieza donde acaba
  // el anterior (el primero, en 0), así que juntos cubren toda la historia del trozo; si no caben, se funden los dos
  // más viejos (su caja crece, nunca se pierde un cambio). cut() cierra los tramos abiertos: lo que cambie después va
  // a un tramo nuevo, y quien pregunte desde ese momento tiene una caja ajustada
  private seg: Int32Array;
  private segN: Uint8Array;
  private cutAt = 0;
  // Sello (valor del reloj) del último cambio de VÓXELES de cada trozo. El reloj lo comparten los cambios de agua y
  // entidades (WorldState.changedSince), así una versión dice "todo lo anterior a este momento"
  readonly versions: Uint32Array;
  // Por trozo, la versión del último cambio que vino del mundo (no de una escritura de vista: ver viewWrites)
  private worldVersions: Uint32Array;
  // Mientras está a true, set escribe como VISTA: cuenta para el rehorneado como cualquier cambio, pero no como cambio
  // del mundo (worldChangedSince). Lo pone la vista al cortar (WorldView.setCut/cutJob): esconder lo de encima de la
  // cabeza no es picar, y el rehorneado lo trata distinto (las luces que toca de rebote no van con prioridad cercana)
  viewWrites = false;
  // ¿Cambió el trozo c por el mundo (no solo por escrituras de vista) después de la versión v?
  worldChangedSince(c: number, v: number): boolean { return this.worldVersions[c]! > v; }
  clock = 0;
  // Si está puesto, oye cada cambio de vóxel (antes de hacerse): buildWorld lo usa para saber qué pinta cada mueble
  onSet: ((x: number, y: number, z: number, old: number, value: number) => void) | null = null;
  // Los oyentes de cambios del mundo (changes.ts; lo pone WorldState): cada vóxel que cambia de verdad se les avisa
  feed: ChangeFeed | null = null;
  // Altura de la cara de arriba del vóxel sólido más alto de cada columna (índice y * width + x); zMin si no hay
  readonly height: Int16Array;

  constructor(public palette: Palette, readonly width: number, readonly depth: number, readonly zMin: number, readonly zMax: number) {
    this.cols = Math.ceil(width / CHUNK);
    this.rows = Math.ceil(depth / CHUNK);
    this.zh = zMax - zMin + 1;
    this.nz = Math.ceil(this.zh / SLAB);
    const n = this.cols * this.rows * this.nz;
    this.data = new Array(n).fill(null);
    this.pal = new Array(n).fill(null);
    this.palN = new Uint16Array(n);
    this.uni = new Uint16Array(n);
    this.count = new Uint16Array(n);
    this.alloc = new Uint8Array(this.cols * this.rows);
    this.seg = new Int32Array(this.cols * this.rows * SEGS * 7);
    this.segN = new Uint8Array(this.cols * this.rows);
    this.versions = new Uint32Array(this.cols * this.rows);
    this.worldVersions = new Uint32Array(this.cols * this.rows);
    this.height = new Int16Array(width * depth).fill(zMin);
    this.expo = new Array(this.cols * this.rows * this.nz).fill(null);
    this.expoOk = new Array(this.cols * this.rows * this.nz).fill(null);
    this.expoAt = new Float64Array(this.cols * this.rows * this.nz).fill(-1);
    this.expoF = new Array(this.cols * this.rows * this.nz).fill(null);
    this.expoFOk = new Array(this.cols * this.rows * this.nz).fill(null);
    this.expoFAt = new Float64Array(this.cols * this.rows * this.nz).fill(-1);
  }

  // Vóxeles que caben en la losa s de un trozo (la última puede ser más baja)
  private cap(s: number): number {
    return CHUNK * CHUNK * Math.min(SLAB, this.zh - s * SLAB);
  }

  // (sin crear nada: el render la llama para cada vecino de cada vóxel)
  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth || z < this.zMin || z > this.zMax) return 0;
    // CHUNK y SLAB son 16: desplazamientos en vez de divisiones (es la función más llamada del motor)
    const zz = z - this.zMin;
    const si = ((y >> 4) * this.cols + (x >> 4)) * this.nz + (zz >> 4);
    const d = this.data[si];
    if (!d) return this.uni[si]!;
    const i = ((zz & 15) << 8) | ((y & 15) << 4) | (x & 15);
    const p = this.pal[si];
    return p ? p[d[i]!]! : d[i]!;
  }

  set(x: number, y: number, z: number, value: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth || z < this.zMin || z > this.zMax) throw new Error(`vóxel fuera del mundo: ${x},${y},${z}`);
    const zz = z - this.zMin;
    const c = Math.floor(y / CHUNK) * this.cols + Math.floor(x / CHUNK);
    const s = Math.floor(zz / SLAB), si = c * this.nz + s;
    const i = ((zz % SLAB) * CHUNK + (y % CHUNK)) * CHUNK + (x % CHUNK);
    const d0 = this.data[si];
    const old = d0 ? (this.pal[si] ? this.pal[si]![d0[i]!]! : d0[i]!) : this.uni[si]!;
    if (old === value) return;
    if (this.onSet) this.onSet(x, y, z, old, value);
    this.write(si, i, value);
    if (value) this.alloc[c] = 1;
    if (!old) this.count[si]!++;
    else if (!value) this.count[si]!--;
    if (this.count[si] === 0) { this.data[si] = null; this.pal[si] = null; this.uni[si] = 0; }
    else if (this.count[si] === this.cap(s)) this.tryUniform(si, s);
    this.versions[c] = ++this.clock;
    if (!this.viewWrites) this.worldVersions[c] = this.clock;
    this.note(c, x, y, z);
    const watchers = this.feed?.list;
    if (watchers) for (const w of watchers) w.voxel(c, x, y, z);
    if (this.fgrid) this.fgrid.dirty[y * this.width + x] = 1;
    // Rejilla de alturas: subir es directo; si se vacía el de arriba del todo, se busca el siguiente hacia abajo
    const h = y * this.width + x;
    if (value && z + 1 > this.height[h]!) this.height[h] = z + 1;
    else if (!value && z + 1 === this.height[h]) {
      let t = z - 1;
      while (t >= this.zMin && !this.get(x, y, t)) t--;
      this.height[h] = t >= this.zMin ? t + 1 : this.zMin;
    }
  }

  // Escribe de una vez TODAS las losas del trozo c (un trozo nuevo: lo que tuviera se pierde). slabs[s]: los valores de
  // la losa s en el orden de dentro de la losa ((z & 15) << 8 | (y & 15) << 4 | x & 15), o null si toda es aire. Para
  // generar trozos enteros sin pasar vóxel a vóxel por set: deja los mismos vóxeles, alturas y avisos (una caja por el
  // trozo entero) que escribirlos con set, con una sola versión. Con onSet puesto no vale (no avisaría vóxel a vóxel)
  // tops (opcional): por columna del trozo ((y & 15) << 4 | x & 15), la cara de arriba del más alto (z + 1; zMin si no
  // hay), si quien compone las losas ya la sabe; si no, se busca
  writeChunkSlabs(c: number, slabs: ReadonlyArray<Uint16Array | null>, tops?: Int16Array): void {
    if (this.onSet) throw new Error('writeChunkSlabs no avisa a onSet: escribe con set');
    let any = false;
    for (let s = 0; s < this.nz; s++) {
      const si = c * this.nz + s, v = slabs[s] ?? null, n = this.cap(s);
      this.data[si] = null; this.pal[si] = null; this.uni[si] = 0; this.count[si] = 0; this.palN[si] = 0;
      if (!v) continue;
      let filled = 0, first = v[0]!, same = true;
      for (let j = 0; j < n; j++) { const w = v[j]!; if (w) filled++; if (w !== first) same = false; }
      if (!filled) continue;
      any = true;
      this.count[si] = filled;
      if (same) { this.uni[si] = first; continue; }                         // llena y toda igual: sin datos
      // Paleta de 1 byte mientras quepa (en el orden en que aparecen); si no, 2 bytes. La tabla de búsqueda (valor ->
      // entrada + 1) es una sola para todas las losas: se limpia lo que se usó
      const p = new Uint16Array(256), d = new Uint8Array(SLAB_CELLS), idx = PAL_LOOKUP;
      let k = 0, wide = false;
      for (let j = 0; j < n; j++) {
        const w = v[j]!;
        let e = idx[w]!;
        if (!e) { if (k === 256) { wide = true; break; } p[k++] = w; e = idx[w] = k; }
        d[j] = e - 1;
      }
      for (let q = 0; q < k; q++) idx[p[q]!] = 0;
      if (wide) { const w = new Uint16Array(SLAB_CELLS); w.set(v.subarray(0, n)); this.data[si] = w; }
      else { this.data[si] = d; this.pal[si] = p; this.palN[si] = k; }
    }
    if (any) this.alloc[c] = 1;
    this.finishWritten(c, tops);
  }

  // Lo mismo que writeChunkSlabs con las losas ya preparadas por quien las compone (como una losa de 1 byte por dentro):
  // sus índices (null: toda la losa es pal[0]), su paleta, cuántas entradas usa y cuántos vóxeles llenos tiene. Así no
  // se vuelve a recorrer cada vóxel para hacer la paleta y contar
  writeChunkPrepared(c: number, slabs: ReadonlyArray<PreparedSlab | null>, tops: Int16Array): void {
    if (this.onSet) throw new Error('writeChunkPrepared no avisa a onSet: escribe con set');
    let any = false;
    for (let s = 0; s < this.nz; s++) {
      const si = c * this.nz + s, v = slabs[s] ?? null;
      this.data[si] = null; this.pal[si] = null; this.uni[si] = 0; this.count[si] = 0; this.palN[si] = 0;
      if (!v || !v.count) continue;
      any = true;
      this.count[si] = v.count;
      // La entrada 0 de la paleta es el aire (los huecos); llena de un solo valor, la losa queda sin datos
      if (v.count === this.cap(s) && v.palN === 2) { this.uni[si] = v.pal[1]!; continue; }
      this.data[si] = v.d; this.pal[si] = v.pal; this.palN[si] = v.palN;
    }
    if (any) this.alloc[c] = 1;
    this.finishWritten(c, tops);
  }

  // Lo común de escribir un trozo entero: alturas, versión, caja de lo cambiado y avisos
  private finishWritten(c: number, tops?: Int16Array): void {
    const cx = c % this.cols, cy = Math.floor(c / this.cols);
    const x0 = cx * CHUNK, y0 = cy * CHUNK, x1 = Math.min(this.width, x0 + CHUNK) - 1, y1 = Math.min(this.depth, y0 + CHUNK) - 1;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let h: number;
      if (tops) h = tops[((y & 15) << 4) | (x & 15)]!;
      else { let t = this.zMax; while (t >= this.zMin && !this.get(x, y, t)) t--; h = t >= this.zMin ? t + 1 : this.zMin; }
      this.height[y * this.width + x] = h;
      if (this.fgrid) this.fgrid.dirty[y * this.width + x] = 1;
    }
    this.versions[c] = ++this.clock;
    if (!this.viewWrites) this.worldVersions[c] = this.clock;
    this.note(c, x0, y0, this.zMin); this.note(c, x1, y1, this.zMax);
    const watchers = this.feed?.list;
    if (watchers) for (const w of watchers) { w.voxel(c, x0, y0, this.zMin); w.voxel(c, x1, y1, this.zMax); }
  }

  // Apunta el vóxel (x, y, z) del trozo c, que acaba de cambiar con la versión this.clock, en su tramo abierto
  private note(c: number, x: number, y: number, z: number): void {
    const S = this.seg, base = c * SEGS * 7;
    let n = this.segN[c]!;
    if (n > 0) {
      const o = base + (n - 1) * 7;
      if (S[o]! > this.cutAt) {
        S[o] = this.clock;
        if (x < S[o + 1]!) S[o + 1] = x; if (y < S[o + 2]!) S[o + 2] = y; if (z < S[o + 3]!) S[o + 3] = z;
        if (x > S[o + 4]!) S[o + 4] = x; if (y > S[o + 5]!) S[o + 5] = y; if (z > S[o + 6]!) S[o + 6] = z;
        return;
      }
    }
    if (n === SEGS) {
      // Se funden los dos más viejos: el tramo 0 acaba donde acababa el 1 y su caja es la de los dos
      const a = base, b = base + 7;
      S[a] = S[b]!;
      for (let k = 1; k <= 3; k++) S[a + k] = Math.min(S[a + k]!, S[b + k]!);
      for (let k = 4; k <= 6; k++) S[a + k] = Math.max(S[a + k]!, S[b + k]!);
      S.copyWithin(b, b + 7, base + SEGS * 7);
      n--;
    }
    const o = base + n * 7;
    S[o] = this.clock; S[o + 1] = x; S[o + 2] = y; S[o + 3] = z; S[o + 4] = x; S[o + 5] = y; S[o + 6] = z;
    this.segN[c] = n + 1;
  }

  // La caja (en vóxeles, extremos incluidos) que contiene todo lo que cambió en el trozo c después de la versión v,
  // o null si nada. Puede ser más grande que lo cambiado (tramos fundidos), nunca más pequeña
  changedBox(c: number, v: number): Box3 | null {
    const S = this.seg, base = c * SEGS * 7, n = this.segN[c]!;
    let r: Box3 | null = null;
    for (let k = 0; k < n; k++) {
      const o = base + k * 7;
      if (!(S[o]! > v)) continue;
      if (!r) r = { x0: S[o + 1]!, y0: S[o + 2]!, z0: S[o + 3]!, x1: S[o + 4]!, y1: S[o + 5]!, z1: S[o + 6]! };
      else {
        r.x0 = Math.min(r.x0, S[o + 1]!); r.y0 = Math.min(r.y0, S[o + 2]!); r.z0 = Math.min(r.z0, S[o + 3]!);
        r.x1 = Math.max(r.x1, S[o + 4]!); r.y1 = Math.max(r.y1, S[o + 5]!); r.z1 = Math.max(r.z1, S[o + 6]!);
      }
    }
    return r;
  }

  // Cierra los tramos abiertos (lo llama quien acaba de leer las cajas, como el rehorneado)
  cut(): void {
    this.cutAt = this.clock;
  }

  // Escribe un valor en una losa, creando sus datos (de 1 byte) si no tenía, o pasándola a 2 bytes si su paleta se llena
  private write(si: number, i: number, value: number): void {
    let d = this.data[si];
    if (!d) {
      d = this.data[si] = new Uint8Array(SLAB_CELLS);
      const p = this.pal[si] = new Uint16Array(256);
      p[0] = this.uni[si]!; this.palN[si] = 1;
    }
    let p = this.pal[si];
    if (!p) { d[i] = value; return; }
    let n = this.palN[si]!, k = 0;
    while (k < n && p[k] !== value) k++;
    if (k === n) {
      // repack hace una paleta nueva (y cambia los índices): se sigue con esa, no con la de antes
      if (n === 256) { this.repack(si); p = this.pal[si]!; n = this.palN[si]!; }
      if (n === 256) {
        // Más de 256 valores distintos en uso: la losa pasa a 2 bytes por vóxel
        const w = new Uint16Array(SLAB_CELLS);
        for (let j = 0; j < SLAB_CELLS; j++) w[j] = p[d[j]!]!;
        w[i] = value;
        this.data[si] = w; this.pal[si] = null;
        return;
      }
      p[n] = value; this.palN[si] = n + 1; k = n;
    }
    d[i] = k;
  }

  // Quita de la paleta de una losa los valores que ya no usa ningún vóxel
  private repack(si: number): void {
    const d = this.data[si] as Uint8Array, p = this.pal[si]!;
    const map = new Int16Array(256).fill(-1), q = new Uint16Array(256);
    let n = 0;
    for (let j = 0; j < SLAB_CELLS; j++) {
      const k = d[j]!;
      if (map[k]! < 0) { map[k] = n; q[n++] = p[k]!; }
      d[j] = map[k]!;
    }
    this.pal[si] = q; this.palN[si] = n;
  }

  // Una losa llena: si todos sus vóxeles valen lo mismo, se queda sin datos
  private tryUniform(si: number, s: number): void {
    const d = this.data[si];
    if (!d) return;
    const n = this.cap(s), first = d[0]!;
    for (let j = 1; j < n; j++) if (d[j] !== first) return;
    const p = this.pal[si];
    this.uni[si] = p ? p[first]! : first;
    this.data[si] = null; this.pal[si] = null;
  }

  // Trozos (con su versión) para snapshot y hash: cada uno, la columna entera de zMin a zMax como siempre (null si
  // nunca tuvo un vóxel); importChunks rehace la rejilla de alturas
  exportChunks(): Array<{ version: number; data: Uint16Array | null }> {
    const out: Array<{ version: number; data: Uint16Array | null }> = [];
    for (let c = 0; c < this.versions.length; c++) {
      if (!this.alloc[c]) { out.push({ version: this.versions[c]!, data: null }); continue; }
      const col = new Uint16Array(CHUNK * CHUNK * this.zh);
      for (let s = 0; s < this.nz; s++) {
        const si = c * this.nz + s, d = this.data[si], p = this.pal[si], n = this.cap(s), o = s * SLAB_CELLS;
        if (!d) { if (this.uni[si]) col.fill(this.uni[si]!, o, o + n); continue; }
        if (!p) { col.set(d.subarray(0, n), o); continue; }
        if (this.palN[si] === 1) { if (p[0]) col.fill(p[0], o, o + n); continue; }
        for (let j = 0; j < n; j++) col[o + j] = p[d[j]!]!;
      }
      out.push({ version: this.versions[c]!, data: col });
    }
    return out;
  }

  importChunks(cs: Array<{ version: number; data: Uint16Array | null }>): void {
    this.epoch++;                                    // las máscaras de lo expuesto ya no valen
    cs.forEach((ch, c) => {
      this.versions[c] = ch.version;
      this.worldVersions[c] = ch.version;
      this.alloc[c] = ch.data ? 1 : 0;
      // Lo cambiado en el trozo pasa a ser el trozo entero (no se sabe qué vóxeles eran)
      const cx = c % this.cols, cy = Math.floor(c / this.cols), o = c * SEGS * 7;
      this.segN[c] = ch.version > 0 ? 1 : 0;
      this.seg.set([ch.version, cx * CHUNK, cy * CHUNK, this.zMin, Math.min(this.width, (cx + 1) * CHUNK) - 1, Math.min(this.depth, (cy + 1) * CHUNK) - 1, this.zMax], o);
      for (let s = 0; s < this.nz; s++) {
        const si = c * this.nz + s, n = this.cap(s), o = s * SLAB_CELLS;
        this.data[si] = null; this.pal[si] = null; this.uni[si] = 0; this.count[si] = 0;
        if (!ch.data) continue;
        let filled = 0;
        for (let j = 0; j < n; j++) {
          const v = ch.data[o + j]!;
          if (!v) continue;
          filled++;
          this.write(si, j, v);
        }
        this.count[si] = filled;
        if (filled === n) this.tryUniform(si, s);
      }
    });
    this.height.fill(this.zMin);
    for (const [x, y, z] of this.entries()) { const h = y * this.width + x; if (z + 1 > this.height[h]!) this.height[h] = z + 1; }
    this.fgrid = null;
  }

  // ---- la copia girada (WorldView, prepareViewJob): losa a losa, sin pasar por set
  // ¿Se puede copiar src girado `quarter` cuartos por losas? Hace falta que cada trozo caiga entero en un trozo de la
  // copia: sin girar, siempre; girado, con ancho y fondo múltiplos de CHUNK. Si no, se copia vóxel a vóxel (set)
  static slabCopyable(src: StaticVoxels, quarter: number): boolean {
    return quarter === 0 || (src.width % CHUNK === 0 && src.depth % CHUNK === 0);
  }

  // Copia en esta (recién hecha, del tamaño girado) las losas [from, to) de src (en su orden: trozo * nz + losa),
  // giradas `quarter` cuartos como ViewCamera.cellToView. Cada losa se copia de una vez: sus datos con los índices
  // girados dentro de la capa de 16 x 16 (la misma paleta), y la de un solo valor, ese valor. Al acabar las losas de un
  // trozo: su altura por columna (de lo copiado), su versión y su caja de cambios (el trozo entero, como importChunks).
  // El contenido es el mismo que copiando vóxel a vóxel; el reloj y las versiones, no (cuentan trozos, no vóxeles)
  copyRotatedSlabs(src: StaticVoxels, quarter: number, from: number, to: number): void {
    if (!StaticVoxels.slabCopyable(src, quarter)) throw new Error('copia por losas: ancho o fondo no múltiplo del trozo');
    const perm = ROT_PERM[quarter]!, nz = this.nz;
    for (let si = from; si < to; si++) {
      const c = Math.floor(si / nz), s = si - c * nz, cx = c % src.cols, cy = Math.floor(c / src.cols);
      const dc = rotChunk(quarter, cx, cy, src.cols, src.rows, this.cols), di = dc * nz + s;
      this.count[di] = src.count[si]!;
      const d = src.data[si];
      if (!d) { this.uni[di] = src.uni[si]!; }
      else {
        const out = d instanceof Uint8Array ? new Uint8Array(SLAB_CELLS) : new Uint16Array(SLAB_CELLS);
        for (let base = 0; base < SLAB_CELLS; base += 256) for (let k = 0; k < 256; k++) out[base | perm[k]!] = d[base | k]!;
        this.data[di] = out;
        const p = src.pal[si];
        if (p) { this.pal[di] = p.slice(); this.palN[di] = src.palN[si]!; }
      }
      if (s === nz - 1) this.finishChunk(dc);
    }
  }

  // Después de copiar las losas del trozo c: la altura de sus columnas (lo más alto lleno), y, si tiene algo, su versión
  // y su caja de cambios
  private finishChunk(c: number): void {
    const nz = this.nz, X = (c % this.cols) * CHUNK, Y = Math.floor(c / this.cols) * CHUNK;
    let any = false;
    for (let s = 0; s < nz; s++) if (this.count[c * nz + s]) { any = true; break; }
    if (!any) return;
    for (let ly = 0; ly < CHUNK; ly++) for (let lx = 0; lx < CHUNK; lx++) {
      let h = this.zMin;
      for (let s = nz - 1; s >= 0 && h === this.zMin; s--) {
        const si = c * nz + s;
        if (!this.count[si]) continue;
        const d = this.data[si], hs = Math.min(SLAB, this.zh - s * SLAB);
        if (!d) { h = this.zMin + s * SLAB + hs; break; }
        const p = this.pal[si];
        for (let lz = hs - 1; lz >= 0; lz--) {
          const i = (lz << 8) | (ly << 4) | lx;
          if (p ? p[d[i]!] : d[i]) { h = this.zMin + s * SLAB + lz + 1; break; }
        }
      }
      this.height[(Y + ly) * this.width + X + lx] = h;
    }
    this.alloc[c] = 1;
    this.versions[c] = this.worldVersions[c] = ++this.clock;
    const o = c * SEGS * 7;
    this.segN[c] = 1;
    this.seg.set([this.clock, X, Y, this.zMin, Math.min(this.width, X + CHUNK) - 1, Math.min(this.depth, Y + CHUNK) - 1, this.zMax], o);
  }

  // ---- los materiales (materials.ts): lo que no es fondo (bed) no cuenta para el agua, y lo que no bloquea (blocks)
  // se atraviesa andando. Las dos alturas se calculan por columna al pedirlas; si la paleta no tiene materiales
  // especiales son la rejilla height.
  private fgrid: { mt: MaterialTable; floor: Int16Array; walk: Int16Array; noClimb: Uint8Array; dirty: Uint8Array } | null = null;
  private foliageGrid() {
    const mt = materialsOf(this.palette);
    if (!mt) return null;
    if (this.fgrid?.mt !== mt) {
      const n = this.width * this.depth;
      this.fgrid = { mt, floor: new Int16Array(n), walk: new Int16Array(n), noClimb: new Uint8Array(n), dirty: new Uint8Array(n).fill(1) };
    }
    return this.fgrid;
  }
  private column(g: NonNullable<StaticVoxels['fgrid']>, x: number, y: number, h: number): void {
    let floor = this.zMin, walk = this.zMin, noClimb = 0;
    for (let z = this.height[h]! - 1; z >= this.zMin && (floor === this.zMin || walk === this.zMin); z--) {
      const v = this.get(x, y, z);
      if (!v) continue;
      if (floor === this.zMin && g.mt.bed[v]) floor = z + 1;
      if (walk === this.zMin && g.mt.blocks[v]) { walk = z + 1; noClimb = g.mt.climb[v] ? 0 : 1; }
    }
    g.floor[h] = floor; g.walk[h] = walk; g.noClimb[h] = noClimb; g.dirty[h] = 0;
  }
  // La cara de arriba del vóxel más alto que no es follaje (el fondo del agua)
  floorAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return this.zMin;
    const h = y * this.width + x, g = this.foliageGrid();
    if (!g) return this.height[h]!;
    if (g.dirty[h]) this.column(g, x, y, h);
    return g.floor[h]!;
  }
  // La cara de arriba del vóxel más alto que no se atraviesa andando (donde se apoya el pie)
  walkAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return this.zMin;
    const h = y * this.width + x, g = this.foliageGrid();
    if (!g) return this.height[h]!;
    if (g.dirty[h]) this.column(g, x, y, h);
    return g.walk[h]!;
  }
  // Donde se apoya el pie en la columna (walkAt), o NO_FOOT si no se pisa: vacía, fuera del mundo o de un material que
  // no se sube. Es hasColumn + climbableAt + walkAt en una consulta, para moveBody, que la pide por cada celda que pisa
  footAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return NO_FOOT;
    const h = y * this.width + x;
    if (!(this.height[h]! > this.zMin)) return NO_FOOT;
    const g = this.foliageGrid();
    if (!g) return this.height[h]!;
    if (g.dirty[h]) this.column(g, x, y, h);
    return g.noClimb[h] ? NO_FOOT : g.walk[h]!;
  }
  // ¿Se puede pisar lo de arriba de la columna? No si es de un material que no se sube (un arbusto): la columna es
  // como una pared, a cualquier altura
  climbableAt(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return true;
    const h = y * this.width + x, g = this.foliageGrid();
    if (!g) return true;
    if (g.dirty[h]) this.column(g, x, y, h);
    return !g.noClimb[h];
  }
  // ¿Bloquea el paso este valor de vóxel? (todo lo lleno, menos el follaje que se atraviesa)
  blocks(v: number): boolean {
    if (!v) return false;
    const mt = materialsOf(this.palette);
    return !mt || mt.blocks[v] === 1;
  }

  chunkOf(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return -1;
    return Math.floor(y / CHUNK) * this.cols + Math.floor(x / CHUNK);
  }

  // Trozos (índices) cuyos vóxeles cambiaron después de la versión v
  changedSince(v: number): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.versions.length; c++) if (this.versions[c]! > v) out.push(c);
    return out;
  }

  // Lo que ocupan los vóxeles en memoria (las losas con datos, sus paletas y las rejillas por columna)
  get byteLength(): number {
    let n = this.height.byteLength + this.versions.byteLength + this.alloc.byteLength;
    n += this.palN.byteLength + this.uni.byteLength + this.count.byteLength;
    for (const d of this.data) if (d) n += d.byteLength;
    for (const p of this.pal) if (p) n += p.byteLength;
    return n;
  }

  // ¿Hay algún sólido en la columna?
  hasColumn(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.depth && this.height[y * this.width + x]! > this.zMin;
  }

  // Vóxeles llenos de una región (en orden fijo: trozo, z, y, x). Recorre solo la parte de cada trozo que cae en la
  // región, no el trozo entero: una franja estrecha y alta (el rehorneado por columnas) toca muchos trozos.
  *entries(region?: { x0: number; y0: number; x1: number; y1: number }): Generator<[number, number, number, number]> {
    yield* this.walk(region, false);
  }

  // Como entries, pero sin (casi todos) los vóxeles enterrados: los que tienen sus 6 vecinos llenos no tienen ninguna
  // cara a la vista y no pintan nada. Se saltan por losas: una losa llena rodeada de losas llenas no se recorre, y de
  // una llena solo se dan las capas que tocan a una vecina que no lo está. Lo que da es un superconjunto de los
  // vóxeles con alguna cara al aire, en el mismo orden que entries: el render da los mismos píxeles con las dos.
  *exposedEntries(region?: { x0: number; y0: number; x1: number; y1: number }): Generator<[number, number, number, number]> {
    yield* this.walk(region, true);
  }

  // exposedEntries sin generador: llama a fn con cada uno, en el mismo orden (es lo que usa el render). La región puede
  // limitar también la altura (z0..z1, extremos incluidos)
  // remember: false, sin hacer ni mirar la máscara de lo expuesto: da todo lo de las losas a medio llenar (un
  // superconjunto: el render da los mismos píxeles). Para recorrer UNA vez todo el mundo (el horneado inicial), donde
  // hacer las máscaras de todas las losas cuesta más que lo que ahorran (en un navegador frenado, el render del
  // horneado subía un 70 %)
  forEachExposed(fn: (x: number, y: number, z: number, v: number) => void, region?: { x0: number; y0: number; x1: number; y1: number; z0?: number; z1?: number }, remember = true, faces?: FaceSet): void {
    const r = region ?? { x0: 0, y0: 0, x1: this.width - 1, y1: this.depth - 1 };
    const rz0 = Math.max(this.zMin, r.z0 ?? this.zMin), rz1 = Math.min(this.zMax, r.z1 ?? this.zMax);
    if (rz0 > rz1) return;
    const s0 = (rz0 - this.zMin) >> 4, s1 = (rz1 - this.zMin) >> 4;
    const CC = CHUNK * CHUNK;
    for (let cy = Math.max(0, Math.floor(r.y0 / CHUNK)); cy <= Math.min(this.rows - 1, Math.floor(r.y1 / CHUNK)); cy++)
      for (let cx = Math.max(0, Math.floor(r.x0 / CHUNK)); cx <= Math.min(this.cols - 1, Math.floor(r.x1 / CHUNK)); cx++) {
        const lx0 = Math.max(0, r.x0 - cx * CHUNK), lx1 = Math.min(CHUNK - 1, r.x1 - cx * CHUNK);
        const ly0 = Math.max(0, r.y0 - cy * CHUNK), ly1 = Math.min(CHUNK - 1, r.y1 - cy * CHUNK);
        const c = cy * this.cols + cx;
        // Lo más alto que hay en las columnas de la región dentro de este trozo (la rejilla de alturas): por encima todo
        // es aire y no se recorre. En una franja estrecha de un corte hondo, las losas a medio llenar son casi todo aire
        let top = this.zMin;
        for (let ly = ly0; ly <= ly1; ly++) {
          const row = (cy * CHUNK + ly) * this.width + cx * CHUNK;
          for (let lx = lx0; lx <= lx1; lx++) { const h = this.height[row + lx]!; if (h > top) top = h; }
        }
        for (let s = s0; s <= s1; s++) {
          const si = c * this.nz + s, d = this.data[si], p = this.pal[si], u = this.uni[si]!;
          if (!d && !u) continue;
          const hs = Math.min(SLAB, this.zh - s * SLAB), z0 = s * SLAB + this.zMin, X = cx * CHUNK, Y = cy * CHUNK;
          if (z0 >= top) break;
          const lzA = Math.max(0, rz0 - z0), lzB = Math.min(hs - 1, rz1 - z0, top - 1 - z0);
          let open = -1;
          if (this.count[si] === this.cap(s)) {
            open = (this.full(cx - 1, cy, s) ? 0 : 1) | (this.full(cx + 1, cy, s) ? 0 : 2) | (this.full(cx, cy - 1, s) ? 0 : 4) |
              (this.full(cx, cy + 1, s) ? 0 : 8) | (this.full(cx, cy, s - 1) ? 0 : 16) | (this.full(cx, cy, s + 1) ? 0 : 32);
            if (!open) continue;
          }
          if (!remember) {
            // Como antes de las máscaras: de una losa llena, sus capas de borde; de una a medio llenar, todo
            for (let lz = lzA; lz <= lzB; lz++) {
              const zEdge = open >= 0 && ((lz === 0 && open & 16) || (lz === hs - 1 && open & 32));
              for (let ly = ly0; ly <= ly1; ly++) {
                const yEdge = zEdge || (open >= 0 && ((ly === 0 && open & 4) || (ly === CHUNK - 1 && open & 8)));
                const row = lz * CC + ly * CHUNK;
                for (let lx = lx0; lx <= lx1; lx++) {
                  if (open >= 0 && !yEdge && !((lx === 0 && open & 1) || (lx === CHUNK - 1 && open & 2))) continue;
                  const v = d ? (p ? p[d[row + lx]!]! : d[row + lx]!) : u;
                  if (v) fn(X + lx, Y + ly, z0 + lz, v);
                }
              }
            }
            continue;
          }
          // Solo los vóxeles con alguna cara al aire (la máscara de la losa), en el mismo orden: z, y, x
          const { m: mask, ok } = this.exposure(cx, cy, s, faces), range = ((1 << (lx1 + 1)) - 1) & ~((1 << lx0) - 1);
          for (let lz = lzA; lz <= lzB; lz++) for (let ly = ly0; ly <= ly1; ly++) {
            const r = (lz << 4) | ly;
            if (!ok[r]) { mask[r] = this.exposureRow(si, s, cx, cy, lz, ly, faces); ok[r] = 1; }
            let bits = mask[r]! & range;
            const row = lz * CC + ly * CHUNK;
            while (bits) {
              const lx = 31 - Math.clz32(bits & -bits);
              bits &= bits - 1;
              fn(X + lx, Y + ly, z0 + lz, d ? (p ? p[d[row + lx]!]! : d[row + lx]!) : u);
            }
          }
        }
      }
  }

  // ¿Tiene sus 6 vecinos llenos? Entonces no enseña ninguna cara y el render no pinta nada con él: exposedEntries y
  // forEachExposed se lo saltan. Antes solo se saltaban losas enteras llenas, y de una losa a medio llenar (la de la
  // superficie, la de un túnel, la del borde de un corte) se daban todos sus vóxeles: en una franja del rehorneado con
  // un corte hondo eran ~20.000-30.000 recorridos para ~2.000 caras. Dentro de la losa se mira su array; en el borde, get
  private buried(d: Uint8Array | Uint16Array | undefined | null, p: Uint16Array | undefined | null, lx: number, ly: number, lz: number, hs: number, x: number, y: number, z: number): boolean {
    if (lx > 0 && lx < CHUNK - 1 && ly > 0 && ly < CHUNK - 1 && lz > 0 && lz < hs - 1) {
      if (!d) return true;                                         // losa de un solo valor (llena): todo lleno alrededor
      const i = (lz << 8) | (ly << 4) | lx;
      return p
        ? !!(p[d[i - 1]!] && p[d[i + 1]!] && p[d[i - CHUNK]!] && p[d[i + CHUNK]!] && p[d[i - 256]!] && p[d[i + 256]!])
        : !!(d[i - 1] && d[i + 1] && d[i - CHUNK] && d[i + CHUNK] && d[i - 256] && d[i + 256]);
    }
    return !!(this.get(x - 1, y, z) && this.get(x + 1, y, z) && this.get(x, y - 1, z) && this.get(x, y + 1, z) && this.get(x, y, z - 1) && this.get(x, y, z + 1));
  }

  // La máscara de lo expuesto de la losa s del trozo (cx, cy), al día. Por filas: cuando cambia el trozo o un vecino
  // solo se borra qué filas están hechas, y cada fila se calcula la primera vez que alguien la pide (una franja
  // estrecha pide las suyas, no la losa entera)
  private exposure(cx: number, cy: number, s: number, faces?: FaceSet): { m: Uint16Array; ok: Uint8Array } {
    const c = cy * this.cols + cx, si = c * this.nz + s, V = this.versions;
    let at = V[c]!;
    if (cx > 0) at = Math.max(at, V[c - 1]!);
    if (cx < this.cols - 1) at = Math.max(at, V[c + 1]!);
    if (cy > 0) at = Math.max(at, V[c - this.cols]!);
    if (cy < this.rows - 1) at = Math.max(at, V[c + this.cols]!);
    at += this.epoch * 4294967296;
    if (faces) {
      if (faces.key !== this.expoKey) { this.expoKey = faces.key; this.expoFAt.fill(-1); }
      let m = this.expoF[si], ok = this.expoFOk[si];
      if (!m || !ok) { m = this.expoF[si] = new Uint16Array(SLAB * CHUNK); ok = this.expoFOk[si] = new Uint8Array(SLAB * CHUNK); }
      if (this.expoFAt[si] !== at) { ok.fill(0); this.expoFAt[si] = at; }
      return { m, ok };
    }
    let m = this.expo[si], ok = this.expoOk[si];
    if (!m || !ok) { m = this.expo[si] = new Uint16Array(SLAB * CHUNK); ok = this.expoOk[si] = new Uint8Array(SLAB * CHUNK); }
    if (this.expoAt[si] !== at) { ok.fill(0); this.expoAt[si] = at; }
    return { m, ok };
  }
  // Deja hechas, como mucho `rows`, las filas de la máscara de lo expuesto que forEachExposed va a pedir en esa región
  // (la misma región, con su z0..z1): quien recorre por pasos con plazo (el rehorneado por franjas) prepara primero lo
  // que tiene que recalcular, que después del cambio de una zona entera (un corte) es mucho, y el recorrido ya no paga
  // ese pico. Va por filas y no por reloj (aquí no se lee el reloj: es del mundo). Devuelve true si ya está todo
  warmExposed(region: { x0: number; y0: number; x1: number; y1: number; z0?: number; z1?: number }, rows: number, faces?: FaceSet): boolean {
    const r = region, rz0 = Math.max(this.zMin, r.z0 ?? this.zMin), rz1 = Math.min(this.zMax, r.z1 ?? this.zMax);
    if (rz0 > rz1) return true;
    const s0 = (rz0 - this.zMin) >> 4, s1 = (rz1 - this.zMin) >> 4;
    let made = 0;
    for (let cy = Math.max(0, Math.floor(r.y0 / CHUNK)); cy <= Math.min(this.rows - 1, Math.floor(r.y1 / CHUNK)); cy++)
      for (let cx = Math.max(0, Math.floor(r.x0 / CHUNK)); cx <= Math.min(this.cols - 1, Math.floor(r.x1 / CHUNK)); cx++) {
        const lx0 = Math.max(0, r.x0 - cx * CHUNK), lx1 = Math.min(CHUNK - 1, r.x1 - cx * CHUNK);
        const ly0 = Math.max(0, r.y0 - cy * CHUNK), ly1 = Math.min(CHUNK - 1, r.y1 - cy * CHUNK);
        let top = this.zMin;
        for (let ly = ly0; ly <= ly1; ly++) {
          const row = (cy * CHUNK + ly) * this.width + cx * CHUNK;
          for (let lx = lx0; lx <= lx1; lx++) { const h = this.height[row + lx]!; if (h > top) top = h; }
        }
        const c = cy * this.cols + cx;
        for (let s = s0; s <= s1; s++) {
          const si = c * this.nz + s, d = this.data[si], u = this.uni[si]!;
          if (!d && !u) continue;
          const hs = Math.min(SLAB, this.zh - s * SLAB), z0 = s * SLAB + this.zMin;
          if (z0 >= top) break;
          if (this.count[si] === this.cap(s)) {
            const open = (this.full(cx - 1, cy, s) ? 0 : 1) | (this.full(cx + 1, cy, s) ? 0 : 2) | (this.full(cx, cy - 1, s) ? 0 : 4) |
              (this.full(cx, cy + 1, s) ? 0 : 8) | (this.full(cx, cy, s - 1) ? 0 : 16) | (this.full(cx, cy, s + 1) ? 0 : 32);
            if (!open) continue;
          }
          const lzA = Math.max(0, rz0 - z0), lzB = Math.min(hs - 1, rz1 - z0, top - 1 - z0);
          const { m, ok } = this.exposure(cx, cy, s, faces);
          for (let lz = lzA; lz <= lzB; lz++) for (let ly = ly0; ly <= ly1; ly++) {
            const q = (lz << 4) | ly;
            if (ok[q]) continue;
            m[q] = this.exposureRow(si, s, cx, cy, lz, ly, faces); ok[q] = 1;
            if (++made >= rows) return false;
          }
        }
      }
    return true;
  }

  // La fila (lz, ly) de la máscara de la losa si: un bit por x con vóxel y alguna cara al aire
  // Cuántas filas de lo expuesto se han hecho (para medir, y para probar que no se rehace lo hecho)
  exposureRows = 0;
  private exposureRow(si: number, s: number, cx: number, cy: number, lz: number, ly: number, faces?: FaceSet): number {
    this.exposureRows++;
    const d = this.data[si], p = this.pal[si], u = this.uni[si]!;
    const hs = Math.min(SLAB, this.zh - s * SLAB), z0 = s * SLAB + this.zMin, X = cx * CHUNK, Y = cy * CHUNK, row = (lz << 8) | (ly << 4);
    let bits = 0;
    for (let lx = 0; lx < CHUNK; lx++) {
      const v = d ? (p ? p[d[row + lx]!]! : d[row + lx]!) : u;
      if (!v) continue;
      if (faces) {
        // Con aire delante de alguna de esas caras (dentro de la losa, su array; en el borde, get)
        const x = X + lx, y = Y + ly, z = z0 + lz;
        for (const [dx, dy, dz] of faces.dirs) {
          const nx = lx + dx, ny = ly + dy, nz = lz + dz;
          const w = nx >= 0 && nx < CHUNK && ny >= 0 && ny < CHUNK && nz >= 0 && nz < hs
            ? (d ? (p ? p[d[(nz << 8) | (ny << 4) | nx]!]! : d[(nz << 8) | (ny << 4) | nx]!) : u)
            : this.get(x + dx, y + dy, z + dz);
          if (!w) { bits |= 1 << lx; break; }
        }
      } else if (!this.buried(d, p, lx, ly, lz, hs, X + lx, Y + ly, z0 + lz)) bits |= 1 << lx;
    }
    return bits;
  }

  private full(cx: number, cy: number, s: number): boolean {
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows || s < 0 || s >= this.nz) return false;
    const si = (cy * this.cols + cx) * this.nz + s;
    return this.count[si] === this.cap(s);
  }

  private *walk(region: { x0: number; y0: number; x1: number; y1: number } | undefined, exposed: boolean): Generator<[number, number, number, number]> {
    const r = region ?? { x0: 0, y0: 0, x1: this.width - 1, y1: this.depth - 1 };
    const CC = CHUNK * CHUNK;
    for (let cy = Math.max(0, Math.floor(r.y0 / CHUNK)); cy <= Math.min(this.rows - 1, Math.floor(r.y1 / CHUNK)); cy++)
      for (let cx = Math.max(0, Math.floor(r.x0 / CHUNK)); cx <= Math.min(this.cols - 1, Math.floor(r.x1 / CHUNK)); cx++) {
        const lx0 = Math.max(0, r.x0 - cx * CHUNK), lx1 = Math.min(CHUNK - 1, r.x1 - cx * CHUNK);
        const ly0 = Math.max(0, r.y0 - cy * CHUNK), ly1 = Math.min(CHUNK - 1, r.y1 - cy * CHUNK);
        const c = cy * this.cols + cx;
        for (let s = 0; s < this.nz; s++) {
          const si = c * this.nz + s, d = this.data[si], p = this.pal[si], u = this.uni[si]!;
          if (!d && !u) continue;
          const hs = Math.min(SLAB, this.zh - s * SLAB), z0 = s * SLAB + this.zMin;
          // Losa llena: qué caras de la losa dan a una vecina que no lo está (esas capas pueden tener caras al aire)
          let open = 0x3f;
          if (exposed && this.count[si] === this.cap(s)) {
            open = (this.full(cx - 1, cy, s) ? 0 : 1) | (this.full(cx + 1, cy, s) ? 0 : 2) | (this.full(cx, cy - 1, s) ? 0 : 4) |
              (this.full(cx, cy + 1, s) ? 0 : 8) | (this.full(cx, cy, s - 1) ? 0 : 16) | (this.full(cx, cy, s + 1) ? 0 : 32);
            if (!open) continue;
          } else open = -1;
          for (let lz = 0; lz < hs; lz++) {
            const zEdge = open >= 0 && ((lz === 0 && open & 16) || (lz === hs - 1 && open & 32));
            for (let ly = ly0; ly <= ly1; ly++) {
              const yEdge = zEdge || (open >= 0 && ((ly === 0 && open & 4) || (ly === CHUNK - 1 && open & 8)));
              const row = lz * CC + ly * CHUNK;
              for (let lx = lx0; lx <= lx1; lx++) {
                if (open >= 0 && !yEdge && !((lx === 0 && open & 1) || (lx === CHUNK - 1 && open & 2))) continue;
                const v = d ? (p ? p[d[row + lx]!]! : d[row + lx]!) : u;
                if (v && !(exposed && this.buried(d, p, lx, ly, lz, hs, cx * CHUNK + lx, cy * CHUNK + ly, z0 + lz))) yield [cx * CHUNK + lx, cy * CHUNK + ly, z0 + lz, v];
              }
            }
          }
        }
      }
  }

  get size(): number {
    let n = 0;
    for (let si = 0; si < this.count.length; si++) n += this.count[si]!;
    return n;
  }
}

export type EntityId = number | string;
export type LightId = number | string;

export type ShadowMode = boolean | 'always';

export interface Entity {
  id: EntityId;              // numérico si lo da entities.add; un nombre si viene de addEntity (compatibilidad)
  modelId: number;           // en el registro de modelos del mundo (lo serializable)
  model: VoxelSource;        // su modelo, en sus propios ejes (los pies en el origen)
  x: number;                 // posición de los pies en el mundo (ejes del modelo)
  y: number;
  z: number;
  yaw: number;               // hacia dónde mira, en grados: 0 = sur (a la cámara), 90 = este. Es el `facing` de la API
  // Da sombra de verdad con las luces del mundo. Como mucho MAX_CASTERS por cuadro (frame2d.ts): las 'always'
  // siempre (p. ej. el personaje), y el resto de las true, por cercanía al centro de la vista
  castsShadow: ShadowMode;
  rampOffset: number;        // dónde empiezan sus rampas en la paleta del mundo
  // Tinte plano temporal (r, g, b de 0 a 1), p. ej. el destello de un golpe: sus vóxeles se pintan de ese color, con
  // luz propia, y el contorno se queda. Solo aspecto: no entra en la huella ni hace falta guardarlo (lo pone la vista)
  tint?: readonly [number, number, number] | null;
  // Fantasma: ya no es de la partida (un objeto que se durmió y sigue dibujado hasta que se vea su rehorneado). Lleva
  // la versión del mundo a partir de la cual sobra; no entra en la instantánea ni en la huella (objects.dropGhosts)
  ghost?: number;
}

// Las entidades del mundo: un array (se recorre y se busca como siempre) con add / move / remove
export class EntityList extends Array<Entity> {
  static override get [Symbol.species]() { return Array; }
  owner!: WorldState;
  next = 1;
  add(o: { model: VoxelSource | number; x: number; y: number; z: number; facing?: number; castsShadow?: ShadowMode; id?: EntityId }): EntityId {
    const w = this.owner;
    w.touchArea(o.x, o.y, ENTITY_REACH);
    const modelId = typeof o.model === 'number' ? o.model : w.models.register(o.model);
    const model = w.models.get(modelId);
    const id = o.id ?? this.next++;
    this.push({ id, modelId, model, x: o.x, y: o.y, z: o.z, yaw: o.facing ?? 0, castsShadow: o.castsShadow ?? true, rampOffset: w.models.rampOffset(modelId) });
    this.indexed = -1;
    return id;
  }
  // Por id con un índice (con cientos de entidades, buscar en la lista en cada move costaba O(n) por llamada). El
  // índice se rehace si la lista cambió por fuera (restore la vacía y la vuelve a llenar)
  private index = new Map<EntityId, Entity>();
  private indexed = -1;
  get(id: EntityId): Entity | undefined {
    if (this.indexed !== this.length) this.reindex();
    const e = this.index.get(id);
    if (e && e.id === id) return e;
    this.reindex();
    return this.index.get(id);
  }
  reindex(): void {
    this.index.clear();
    for (const e of this) this.index.set(e.id, e);
    this.indexed = this.length;
  }
  move(id: EntityId, x: number, y: number, z: number, facing?: number): void {
    const e = this.get(id);
    if (!e) throw new Error(`no hay entidad ${id}`);
    this.owner.touchArea(e.x, e.y, ENTITY_REACH);
    e.x = x; e.y = y; e.z = z;
    if (facing !== undefined) e.yaw = facing;
    this.owner.touchArea(x, y, ENTITY_REACH);
  }
  // Cambia el modelo de una entidad (p. ej. el cuadro de su walk). Un modelo nuevo se registra; con el mismo id no
  // hace nada (ni marca la zona), así se puede llamar en cada tick
  // El tinte plano de una entidad (null lo quita); ver Entity.tint
  setTint(id: EntityId, color: readonly [number, number, number] | null): void {
    const e = this.get(id);
    if (!e) throw new Error(`no hay entidad ${id}`);
    e.tint = color ? [Math.round(color[0] * 255) / 255, Math.round(color[1] * 255) / 255, Math.round(color[2] * 255) / 255] : null;
  }
  setModel(id: EntityId, model: VoxelSource | number): void {
    const e = this.get(id);
    if (!e) throw new Error(`no hay entidad ${id}`);
    const w = this.owner;
    const modelId = typeof model === 'number' ? model : w.models.register(model);
    if (modelId === e.modelId) return;
    e.modelId = modelId;
    e.model = w.models.get(modelId);
    e.rampOffset = w.models.rampOffset(modelId);
    w.touchArea(e.x, e.y, ENTITY_REACH);
  }
  remove(id: EntityId): void {
    const i = this.findIndex((e) => e.id === id);
    if (i >= 0) { this.owner.touchArea(this[i]!.x, this[i]!.y, ENTITY_REACH); this.splice(i, 1); this.indexed = -1; }
  }
}

// Zona (en planta) que marca una entidad al moverse: su cuerpo y su sombra cercana
const ENTITY_REACH = 24;

// Las luces del mundo: las fijas del worldgen (baked: se hornean) y las que se añaden en partida (dinámicas: se suman
// cada cuadro en su radio). Un array con add / move / remove.
export class LightList extends Array<WorldLight> {
  static override get [Symbol.species]() { return Array; }
  next = 1;
  add(o: Omit<WorldLight, 'id' | 'baked'> & { id?: LightId }): LightId {
    const id = o.id ?? this.next++;
    this.push({ ...o, id, baked: false, ...(o.follow ? { owner: o.follow.entity } : {}) });
    if (o.follow) this.owner?.placeFollowers();
    return id;
  }
  // Una luz FIJA puesta en partida (una antorcha que se coloca): no se mueve y se hornea como las del escenario. El
  // rehorneado (rebakeChangedJobs con estas luces) la hornea en su zona aunque no cambie ningún vóxel
  addFixed(o: Omit<WorldLight, 'id' | 'baked' | 'follow' | 'owner'> & { id?: LightId }): LightId {
    const id = o.id ?? this.next++;
    if (this.get(id)) throw new Error(`ya hay una luz ${id}`);
    this.push({ ...o, id, baked: true });
    return id;
  }
  // Quita una luz fija: el rehorneado siguiente la deshornea (sus pesos dejan de sumar)
  removeFixed(id: LightId): void {
    const l = this.get(id);
    if (!l) throw new Error(`no hay luz ${id}`);
    if (l.baked === false) throw new Error(`la luz ${id} es dinámica: se quita con remove`);
    this.remove(id);
  }
  owner?: WorldState;
  get(id: LightId): WorldLight | undefined { return this.find((l) => l.id === id); }
  move(id: LightId, x: number, y: number, z: number): void {
    const l = this.get(id);
    if (!l) throw new Error(`no hay luz ${id}`);
    if (l.baked) throw new Error(`la luz ${id} está horneada: las fijas no se mueven`);
    l.x = x; l.y = y; l.z = z;
  }
  // Apunta un foco (o lo vuelve foco): dirección en ejes del modelo y, si se da, la apertura del cono en grados
  aim(id: LightId, dir: readonly [number, number, number], cone?: number): void {
    const l = this.get(id);
    if (!l) throw new Error(`no hay luz ${id}`);
    if (l.baked) throw new Error(`la luz ${id} está horneada: las fijas no se apuntan`);
    l.dir = [dir[0], dir[1], dir[2]];
    if (cone !== undefined) l.cone = cone;
  }
  remove(id: LightId): void {
    const i = this.findIndex((l) => l.id === id);
    if (i >= 0) this.splice(i, 1);
  }
}

// Registro de modelos: el estado guarda ids (serializable); las rampas de cada modelo se suman una vez a la paleta
export class ModelRegistry {
  private list: VoxelSource[] = [];
  private offsets: number[] = [];
  // Los modelos que comparten paleta (p. ej. los cuadros de una animación) comparten sus rampas en la del mundo
  private paletteOffset = new Map<object, number>();
  // Cuántas rampas son del mundo (las de los modelos van detrás); null mientras no se haya sumado ninguna
  private own: number | null = null;
  private ownPalette: Palette | null = null;
  constructor(private owner: WorldState) {}
  // La paleta de las rampas propias del mundo, para modelos hechos con sus vóxeles (un trozo que cae, un objeto
  // despierto): sus valores valen tal cual (desplazamiento 0) y no carga con las rampas de los modelos, que en una
  // partida pasan de MAX_RAMPS. Siempre el mismo objeto mientras no cambien las rampas propias.
  worldPalette(): Palette {
    const w = this.owner, n = this.own ?? w.palette.ramps.length;
    const cur = this.ownPalette;
    if (!cur || cur.ramps.length !== n || cur.ramps.some((r, i) => r !== w.palette.ramps[i]) || cur.outline !== w.palette.outline) {
      this.ownPalette = { ...w.palette, ramps: w.palette.ramps.slice(0, n) };
    }
    return this.ownPalette!;
  }
  register(model: VoxelSource): number {
    const i = this.list.indexOf(model);
    if (i >= 0) return i;
    const w = this.owner;
    let off = this.paletteOffset.get(model.palette);
    // Con la paleta del propio mundo (p. ej. un trozo del mundo que cae, world/fall.ts): sus rampas ya están
    if (off === undefined && (model.palette === w.palette || model.palette === this.ownPalette)) off = 0;
    if (off === undefined) {
      off = w.palette.ramps.length;
      this.own ??= off;
      this.paletteOffset.set(model.palette, off);
      w.palette = { ...w.palette, ramps: [...w.palette.ramps, ...model.palette.ramps] };
      w.solid.palette = w.palette;
    }
    this.offsets.push(off);
    this.list.push(model);
    return this.list.length - 1;
  }
  get(id: number): VoxelSource {
    const m = this.list[id];
    if (!m) throw new Error(`no hay modelo ${id}`);
    return m;
  }
  rampOffset(id: number): number { return this.offsets[id]!; }
}

export interface ViewRegion { x0: number; y0: number; x1: number; y1: number }

// Lo que el render 2D lee del mundo (frame2D, el compositor de la GPU): el estado de verdad lo cumple, y también una
// vista girada (view.ts), que da lo mismo en ejes de la vista
export interface WaterSurface {
  readonly gw: number;
  readonly gh: number;
  readonly sim: { readonly depth: Float32Array; readonly ground: Float32Array; readonly solid: Uint8Array };
  readonly toneColors: ReadonlyArray<readonly [number, number, number]>;
  readonly glow?: number;            // luz mínima de la superficie (1: un líquido que brilla solo)
  readonly zRange?: readonly [number, number];   // alturas con agua posible (WaterLayer.zRange); sin él, -16..32
  // Sube cada vez que cambian el fondo, las paredes o las cuencas (WaterLayer.syncGround, importState): quien los copie
  // (la GPU) los vuelve a copiar. Sin él, no cambian nunca
  readonly groundVersion?: number;
  isBasin(i: number): boolean;
  draw(b: import('./bake').Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    ambient: readonly [number, number, number], time: number, worldLights: readonly WorldLight[], reflect?: boolean, cut?: { x0: number; x1: number; y0: number; y1: number; zMin: number } | null): void;
}
export interface DropSource {
  readonly count: number;
  at(k: number): [number, number, number];
  draw(b: import('./bake').Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    color: readonly [number, number, number], light: readonly [number, number, number]): void;
}
export interface RenderState {
  readonly entities: readonly Entity[];
  readonly lights: readonly WorldLight[];
  readonly water: WaterSurface | null;
  readonly drops: DropSource;
  readonly palette: Palette;
  // Efectos y partículas (src/core/effects.ts): opcional, sin ellos el cuadro es el de siempre
  readonly effects?: EffectsLayer | null;
}

export class WorldState {
  palette: Palette;
  readonly entities = new EntityList();
  // Sello del último cambio de AGUA o ENTIDADES de cada trozo (mismo reloj que los vóxeles)
  readonly dynamicVersions: Uint32Array;
  readonly lights = new LightList();
  readonly models: ModelRegistry;
  readonly drops: Drops;
  // Efectos VISUALES (chispas, humo, lluvia...): con su propio azar, fuera de la instantánea y de la huella; encenderlos
  // o apagarlos (effectsOn) no cambia la partida. Leen los vóxeles para chocar, nunca los cambian.
  readonly fx: FxSystem;
  effectsOn = true;
  // Partículas de SIMULACIÓN genéricas (las gotas son las primeras, en `drops`): con el azar del mundo, en la
  // instantánea y, si alguna vez se usaron, en la huella (así un mundo sin ellas da la huella de siempre)
  readonly simFx: FxSystem;
  // Lo que bloquea a una partícula: los vóxeles que no se atraviesan y lo que hay bajo el fondo
  readonly fxSolid = (x: number, y: number, z: number): boolean => {
    const s = this.solid;
    if (z < s.zMin) return true;
    if (x < 0 || y < 0 || x >= s.width || y >= s.depth || z > s.zMax) return false;
    return s.blocks(s.get(x, y, z));
  };
  // Lo que se pinta de los efectos (los visuales solo si están encendidos) y sus luces, cada sistema con su tope
  readonly effects: EffectsLayer;
  // Lo que flota en el agua (nenúfares...): entidades que mueve el agua (floaters.ts)
  readonly floaters: Floaters = new Floaters(this);
  // Muebles, columnas... que se pueden mover o romper (objects.ts): de quién es cada vóxel, su peso y su vida
  readonly objects: ObjectLayer;
  // Los oyentes de "esta zona cambió" (changes.ts): watchChanges()
  readonly changes: ChangeFeed;
  tick = 0;
  private rngState: number;

  constructor(readonly solid: StaticVoxels, lights: WorldLight[], public water: WaterLayer | null,
    opts: { seed?: number; fountain?: Fountain | null; fx?: import('../core/effects').FxOptions } = {}) {
    this.palette = solid.palette;
    this.models = new ModelRegistry(this);
    this.objects = new ObjectLayer(this);
    this.changes = new ChangeFeed(
      () => ({ x0: 0, y0: 0, z0: solid.zMin, x1: solid.width - 1, y1: solid.depth - 1, z1: solid.zMax }),
      () => this.solid.clock);
    solid.feed = this.changes;
    this.dynamicVersions = new Uint32Array(solid.versions.length);
    this.entities.owner = this;
    this.lights.owner = this;
    // Las del worldgen son fijas: se hornean
    for (const l of lights) this.lights.push({ ...l, baked: l.baked ?? true });
    this.rngState = (opts.seed ?? 1) >>> 0;
    this.fountain = opts.fountain ?? null;
    this.drops = new Drops(() => this.random());
    this.fx = new FxSystem(fxRandom(((opts.seed ?? 1) ^ 0x9e3779b9) >>> 0), opts.fx);
    this.simFx = new FxSystem(() => this.random(), opts.fx);
    const self = this;
    this.effects = {
      get sources() { return self.effectsOn ? [self.fx, self.simFx] : [self.simFx]; },
      lights: () => [...(this.effectsOn ? fxWorldLights(this.fx) : []), ...fxWorldLights(this.simFx, undefined, 'fxs')],
    };
  }

  readonly fountain: Fountain | null;

  // mulberry32 (el mismo de src/sim/rng), con el estado a la vista para snapshot y hash
  random(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---- eventos: lo que el juego le hace al mundo dentro del tick (los llama el runtime antes de step)
  readonly events = {
    // Algo empuja el agua (pisar, un golpe): ondas; con fuerza, el agua salta el borde
    disturb: (x: number, y: number, force: number, radius = 1.5) => { this.water?.disturb(x, y, force, radius); this.floaters.push(x, y, force, radius); },
    // Añade agua en un punto
    pour: (x: number, y: number, amount: number) => { this.water?.pour(x, y, amount); },
    // Gotas que saltan desde (x, y, z)
    splash: (x: number, y: number, z: number, count: number, force: number) => { this.drops.splash(x, y, z, count, force); },
  };

  get width(): number { return this.solid.width; }
  get depth(): number { return this.solid.depth; }

  // Compatibilidad: una entidad con nombre (lo mismo que entities.add con id = nombre). Devuelve la entidad.
  addEntity(id: string, model: VoxelSource, x: number, y: number, z = 0, yaw = 0): Entity {
    this.entities.add({ id, model, x, y, z, facing: yaw });
    return this.entities.get(id)!;
  }

  entity(id: EntityId): Entity | undefined { return this.entities.get(id); }

  // Material de una entidad en la paleta del mundo
  static remap(e: Entity, v: number): number {
    const { ramp, tone } = decode(v);
    return (e.rampOffset + ramp) * 16 + tone + 1;
  }

  // ---- lo que ve un renderizador: lo estático, las entidades y el agua, compuestos al vuelo y sin copias
  view(region: ViewRegion, opts: { entities?: boolean; water?: boolean } = {}): VoxelSource {
    const withEntities = opts.entities ?? true, withWater = opts.water ?? true;
    const ent = new Map<number, number>();
    const entList: Array<[number, number, number, number]> = [];
    if (withEntities) for (const e of this.entities) {
      // En vóxeles, el giro va a la vuelta de 90° más cercana (el 2D gira libre)
      const turns = ((Math.round(e.yaw / 90) % 4) + 4) % 4;
      const c = [1, 0, -1, 0][turns]!, s = [0, 1, 0, -1][turns]!;
      const ox = Math.round(e.x), oy = Math.round(e.y), oz = Math.round(e.z);
      for (const [x, y, z, v] of e.model.entries()) {
        const wx = ox + x * c - y * s, wy = oy + x * s + y * c, wz = oz + z;
        const vv = WorldState.remap(e, v);
        ent.set(key(wx, wy, wz), vv);
        entList.push([wx, wy, wz, vv]);
      }
    }
    const water = withWater ? this.waterColumns(region) : null;
    const solid = this.solid;
    const self = this;
    return {
      get palette() { return self.palette; },
      get(x: number, y: number, z: number): number {
        const s = solid.get(x, y, z);
        if (s) return s;
        if (!ent.size && !water) return 0;
        const k = key(x, y, z);
        return ent.get(k) ?? water?.get(k) ?? 0;
      },
      *entries() {
        for (const v of solid.entries(region)) yield v;
        for (const v of entList) if (!solid.get(v[0], v[1], v[2])) yield v;
        if (water) for (const [k, v] of water) {
          const [x, y, z] = unkey(k);
          if (!solid.get(x, y, z) && !ent.has(k)) yield [x, y, z, v];
        }
      },
    };
  }

  // El agua de una región como vóxeles: cada columna desde el fondo hasta la superficie de ahora
  waterColumns(region: ViewRegion): Map<number, number> {
    const out = new Map<number, number>();
    const w = this.water;
    if (!w) return out;
    const waterRamp = this.palette.ramps.findIndex((r) => r.name === 'agua');
    if (waterRamp < 0) return out;
    const sim = w.sim;
    const gx0 = Math.max(0, Math.floor(region.x0 / 2) - 1), gx1 = Math.min(w.gw - 1, Math.ceil(region.x1 / 2) + 1);
    const gy0 = Math.max(0, Math.floor(region.y0 / 2) - 1), gy1 = Math.min(w.gh - 1, Math.ceil(region.y1 / 2) + 1);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const i = gy * w.gw + gx;
      const d = sim.depth[i]!;
      if (d < 0.05 || sim.solid[i]) continue;
      const x0 = gx * 2, y0 = gy * 2;
      if (x0 + 1 < region.x0 || x0 > region.x1 || y0 + 1 < region.y0 || y0 > region.y1) continue;
      const g = sim.ground[i]!, top = Math.round(g + d) - 1;
      for (let z = g + 1; z <= top; z++) {
        const tone = z === top ? 3 : top - z > 3 ? 1 : 2;
        const v = waterRamp * 16 + tone + 1;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) out.set(key(x0 + dx, y0 + dy, z), v);
      }
    }
    return out;
  }

  // ---- consultas del juego (WorldQuery, acordada con FERN). Todo en ejes del modelo: x este, y norte, z arriba.

  // ¿Vóxel sólido estático? (paredes, columnas, muebles, el pilón de la fuente)
  // (la hierba y las flores se atraviesan; los arbustos, follaje con blocks, no)
  solidAt(x: number, y: number, z: number): boolean {
    return this.solid.blocks(this.solid.get(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  // Altura (entera) de la cara de arriba del sólido más alto de la columna: donde se apoya el pie. El agua no
  // cuenta: sus alturas fraccionarias solo salen por waterAt. El follaje que se atraviesa tampoco.
  groundAt(x: number, y: number): number {
    const g = this.solid.walkAt(Math.floor(x), Math.floor(y));
    // Los objetos despiertos (objects.ts) no están en los vóxeles: su huella cuenta aparte
    return this.objects.awake.length ? this.objects.topOver(Math.floor(x), Math.floor(y), g) : g;
  }

  // Agua en la columna: profundidad y altura de la superficie (null si está seca)
  waterAt(x: number, y: number): { depth: number; surface: number } | null {
    const w = this.water;
    if (!w) return null;
    const depth = w.depthAt(x, y);
    return depth > 0.01 ? { depth, surface: w.surfaceAt(x, y) } : null;
  }

  // ¿Cabe un pie en (x, y) viniendo de la altura feetZ? Sube como mucho `step`; bajar, lo que sea (sin vacío).
  // El agua más honda que `maxWater` no se puede pisar, ni lo que no se sube (materials.ts, climb: los arbustos)
  // moveBody (runtime/body.ts) hace lo mismo celda a celda con footing y waterDepthAt: si cambia aquí, cambia allí
  standable(x: number, y: number, feetZ: number, step: number, maxWater = 4.5): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    const g = this.footing(xi, yi);
    if (g === NO_FOOT || !(g - feetZ <= step)) return false;
    const d = this.waterDepthAt(xi, yi);
    return !(d > 0.01 && d > maxWater);
  }

  // El suelo de la columna (xi, yi) para un pie, con los objetos despiertos, o NO_FOOT si no se pisa (StaticVoxels.footAt)
  footing(xi: number, yi: number): number {
    const g = this.solid.footAt(xi, yi);
    return g !== NO_FOOT && this.objects.awake.length ? this.objects.topOver(xi, yi, g) : g;
  }

  // La profundidad del agua sin crear objeto (0 si no hay agua); waterAt la da a partir de 0,01
  waterDepthAt(x: number, y: number): number {
    return this.water ? this.water.depthAt(x, y) : 0;
  }

  // Primer vóxel sólido estático en el segmento de `from` a `to` (DDA): el punto de entrada y la normal de la cara
  raycast(from: [number, number, number], to: [number, number, number]): { hit: [number, number, number]; normal: [number, number, number] } | null {
    const [px, py, pz] = from;
    const dx = to[0] - px, dy = to[1] - py, dz = to[2] - pz;
    let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
    const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
    const ddx = sx ? Math.abs(1 / dx) : Infinity, ddy = sy ? Math.abs(1 / dy) : Infinity, ddz = sz ? Math.abs(1 / dz) : Infinity;
    let mx = sx ? (sx > 0 ? x + 1 - px : px - x) * ddx : Infinity;
    let my = sy ? (sy > 0 ? y + 1 - py : py - y) * ddy : Infinity;
    let mz = sz ? (sz > 0 ? z + 1 - pz : pz - z) * ddz : Infinity;
    if (this.solid.blocks(this.solid.get(x, y, z))) return { hit: [px, py, pz], normal: [0, 0, 0] };
    for (let i = 0; i < 4096; i++) {
      let t: number, normal: [number, number, number];
      if (mx <= my && mx <= mz) { t = mx; x += sx; mx += ddx; normal = [-sx, 0, 0]; }
      else if (my <= mz) { t = my; y += sy; my += ddy; normal = [0, -sy, 0]; }
      else { t = mz; z += sz; mz += ddz; normal = [0, 0, -sz]; }
      if (t > 1) return null;
      if (this.solid.blocks(this.solid.get(x, y, z))) return { hit: [px + dx * t, py + dy * t, pz + dz * t], normal };
    }
    return null;
  }

  // ---- qué ha cambiado (para rehornear y subir a la GPU solo eso)

  // Versión actual del mundo: guardarla y después preguntar changedSince(esa versión)
  get version(): number { return this.solid.clock; }

  // Marca como cambiados (agua o entidades) los trozos que toca un círculo en planta
  touchArea(x: number, y: number, r: number): void {
    const s = this.solid;
    const stamp = ++s.clock;
    for (let cy = Math.max(0, Math.floor((y - r) / CHUNK)); cy <= Math.min(s.rows - 1, Math.floor((y + r) / CHUNK)); cy++)
      for (let cx = Math.max(0, Math.floor((x - r) / CHUNK)); cx <= Math.min(s.cols - 1, Math.floor((x + r) / CHUNK)); cx++)
        this.dynamicVersions[cy * s.cols + cx] = stamp;
  }

  // Trozos que cambiaron después de la versión v: vóxeles, agua o entidades (o solo vóxeles, para el horneado)
  changedSince(v: number, what: 'all' | 'voxels' = 'all'): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.solid.versions.length; c++)
      if (this.solid.versions[c]! > v || (what === 'all' && this.dynamicVersions[c]! > v)) out.push(c);
    return out;
  }

  // Un tick de simulación: 1/60 s fijo
  // Las luces que van con una entidad, en su sitio: el offset (y la dirección) girados con su facing. Si la entidad ya
  // no está, la luz se queda donde estaba.
  placeFollowers(): void {
    for (const l of this.lights) {
      const f = l.follow;
      if (!f) continue;
      const e = this.entities.get(f.entity);
      if (!e) continue;
      const a = (e.yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const rot = (v: readonly [number, number, number]): [number, number, number] => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
      const o = rot(f.offset);
      l.x = e.x + 0.5 + o[0]; l.y = e.y + o[1]; l.z = e.z + o[2];
      if (f.dir) l.dir = rot(f.dir);
    }
  }

  step(): void {
    const dt = TICK;
    // La fuente: un chorro de gotas que cae del borde del cuenco al pilón (con el azar del mundo)
    const f = this.fountain;
    if (f) for (let k = 0; k < 3; k++) {
      const ang = this.random() * Math.PI * 2, sp = 10 + this.random() * 8;
      this.drops.emit(f.x + Math.cos(ang) * 6.5, f.y + Math.sin(ang) * 6.5, f.bowl.z + 2, Math.cos(ang) * sp, Math.sin(ang) * sp, 8 + this.random() * 10, 0.012);
    }
    this.water?.step(dt);
    if (this.water) {
      // Las celdas de agua que se movieron marcan su trozo
      const w = this.water, s = this.solid;
      let stamp = 0;
      for (const i of w.sim.activeCells()) {
        const c = s.chunkOf((i % w.gw) * 2, Math.floor(i / w.gw) * 2);
        if (c < 0) continue;
        if (!stamp) stamp = ++s.clock;
        this.dynamicVersions[c] = stamp;
      }
    }
    this.drops.step(dt, this.water, (x, y) => this.groundAt(x, y));
    this.floaters.step(dt, this.water);
    this.objects.step(dt);
    this.simFx.step(dt, this.fxSolid);
    if (this.effectsOn) this.fx.step(dt, this.fxSolid);
    this.placeFollowers();
    this.tick++;
  }

  // Calienta el JIT de step (agua, gotas, salpicaduras): sin esto el primer tick de la partida tarda ~10 ms en vez de
  // ~0,7 (lo midió FERN). Da unos ticks con un pisotón y vuelve exactamente al estado de antes (misma huella).
  warmUp(ticks = 6): void {
    const s = this.snapshot();
    const w = this.water;
    for (let k = 0; k < ticks; k++) {
      if (w && k === 0) for (let i = 0; i < w.gw * w.gh; i += 97) {
        if (w.sim.depth[i]! <= 1) continue;
        const x = (i % w.gw) * 2 + 1, y = Math.floor(i / w.gw) * 2 + 1;
        this.events.disturb(x, y, 2.8, 3);
        this.events.splash(x, y, w.surfaceAt(x, y), 40, 105);
        break;
      }
      this.step();
    }
    this.restore(s);
  }

  // ---- instantánea y huella
  snapshot(): WorldSnapshot {
    return {
      tick: this.tick, rng: this.rngState,
      chunks: this.solid.exportChunks(),
      water: this.water ? this.water.exportState() : null,
      drops: this.drops.exportState(),
      floaters: this.floaters.exportState(),
      simFx: this.simFx.exportState(),
      objects: this.objects.exportState(),
      entities: [...this.entities].filter((e) => e.ghost === undefined).sort((a, b) => byId(a.id, b.id)).map((e) => ({ id: e.id, modelId: e.modelId, x: e.x, y: e.y, z: e.z, yaw: e.yaw, castsShadow: e.castsShadow })),
      lights: [...this.lights].sort((a, b) => byId(a.id, b.id)).map((l) => ({ ...l })),
      next: { entity: this.entities.next, light: this.lights.next },
      clock: this.solid.clock, dynamicVersions: this.dynamicVersions.slice(),
      ...(this.parts.size ? { parts: Object.fromEntries([...this.parts].map(([k, p]) => [k, p.exportState()])) } : {}),
    };
  }

  // PARTES del estado que añade quien construye (una rejilla de bloques, lo que sea): entran en la instantánea, en
  // restore y en la huella, en el orden de su nombre. Un mundo sin partes da la huella de siempre
  readonly parts = new Map<string, StatePart>();
  addPart(name: string, part: StatePart): void {
    if (this.parts.has(name)) throw new Error(`ya hay una parte "${name}" en el mundo`);
    this.parts.set(name, part);
  }

  // Suscribirse a las zonas del mundo que cambian (changes.ts): take() da las cajas desde la vez anterior
  watchChanges(): ChangeWatch { return this.changes.add(); }

  restore(s: WorldSnapshot): void {
    const watchers = this.changes.list;
    if (watchers) for (const w of watchers) w.everything();
    this.tick = s.tick; this.rngState = s.rng;
    this.solid.importChunks(s.chunks);
    this.drops.importState(s.drops);
    this.floaters.importState(s.floaters);
    this.simFx.importState(s.simFx);
    if (s.objects) this.objects.importState(s.objects);
    // Las entidades y luces vuelven a ser exactamente las de la instantánea (las nuevas se van, las quitadas vuelven)
    this.entities.length = 0;
    for (const se of s.entities) {
      const model = this.models.get(se.modelId);
      this.entities.push({ id: se.id, modelId: se.modelId, model, x: se.x, y: se.y, z: se.z, yaw: se.yaw, castsShadow: se.castsShadow, rampOffset: this.models.rampOffset(se.modelId) });
    }
    this.lights.length = 0;
    this.lights.push(...s.lights.map((l) => ({ ...l })));
    this.entities.next = s.next.entity; this.lights.next = s.next.light;
    this.entities.reindex();
    this.solid.clock = s.clock; this.dynamicVersions.set(s.dynamicVersions);
    for (const [k, p] of this.parts) if (s.parts && k in s.parts) p.importState(s.parts[k]);
    // El agua al final, con los vóxeles ya restaurados (rehace su fondo de ellos si sigue al mundo)
    if (this.water && s.water) this.water.importState(s.water);
  }

  // Huella (FNV-1a de 32 bits) de todo el estado, en un orden fijo
  hash(): string {
    const h = new Fnv();
    const s = this.snapshot();
    h.num(s.tick); h.num(s.rng);
    for (const c of s.chunks) { h.num(c.version); if (c.data) h.bytes(c.data); else h.num(-1); }
    if (s.water) for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake'] as const) h.bytes(s.water[k]);
    // Las cuencas, solo si se ganó alguna jugando (así un mundo sin ellas da la huella de siempre)
    if (s.water?.basin && this.water?.basinChanged()) h.bytes(s.water.basin);
    h.num(s.drops.n); h.bytes(s.drops.data);
    // Los flotantes, solo si alguna vez hubo (así un mundo sin ellos da la huella de siempre)
    if (s.floaters.next > 1) { h.num(s.floaters.next); for (const f of s.floaters.list) { h.str(String(f.id)); h.f64(f.x); h.f64(f.y); h.f64(f.vx); h.f64(f.vy); h.f64(f.yaw); } }
    // Las partículas de simulación genéricas, solo si alguna vez hubo
    if (s.simFx.used) {
      h.num(s.simFx.n); h.bytes(s.simFx.data); h.num(s.simFx.nextId);
      for (const e of s.simFx.emitters) { h.num(e.id); h.num(e.spec); h.f64(e.x); h.f64(e.y); h.f64(e.z); h.num(e.on ? 1 : 0); h.f64(e.acc); }
    }
    // Los objetos, solo si alguna vez hubo
    if (s.objects && s.objects.next > 1) {
      h.num(s.objects.next);
      for (const o of s.objects.list) { h.num(o.id); h.str(o.kind); h.num(o.x); h.num(o.y); h.num(o.z); h.bytes(o.cells); h.bytes(o.under); h.f64(o.hp); h.f64(o.maxHp); h.str(o.lights.join(',')); }
    }
    for (const e of s.entities) { h.str(String(e.id)); h.num(e.modelId); h.f64(e.x); h.f64(e.y); h.f64(e.z); h.f64(e.yaw); h.num(e.castsShadow === 'always' ? 2 : e.castsShadow ? 1 : 0); }
    for (const l of s.lights) { h.str(String(l.id)); h.str(l.kind); h.f64(l.x); h.f64(l.y); h.f64(l.z); h.num(l.baked ? 1 : 0); h.f64(l.intensity ?? -1); h.f64(l.radius ?? -1); h.f64(l.dir?.[0] ?? 9); h.f64(l.dir?.[1] ?? 9); h.f64(l.dir?.[2] ?? 9); h.f64(l.cone ?? -1); h.str(String(l.owner ?? '')); h.str(l.follow ? JSON.stringify(l.follow) : ''); }
    h.num(s.next.entity); h.num(s.next.light);
    h.num(s.clock); h.bytes(s.dynamicVersions);
    for (const k of [...this.parts.keys()].sort()) { h.str(k); this.parts.get(k)!.hashInto(h); }
    return h.hex();
  }
}

export const TICK = 1 / 60;

// Una parte del estado añadida al mundo (WorldState.addPart). exportState da una copia que no cambia después
export interface StatePart {
  exportState(): unknown;
  importState(s: unknown): void;
  hashInto(h: StateHasher): void;
}
export interface StateHasher { num(n: number): void; bytes(a: ArrayBufferView): void; str(s: string): void }

export interface WorldSnapshot {
  tick: number;
  rng: number;
  chunks: Array<{ version: number; data: Uint16Array | null }>;
  water: WaterState | null;                     // con basin (las cuencas) desde que se guardan; las de antes no lo traen
  drops: { data: Float32Array; n: number };
  floaters: ReturnType<Floaters['exportState']>;
  simFx: FxState;
  objects?: ObjectsState;                       // opcional: las instantáneas de antes no lo traen
  entities: Array<{ id: EntityId; modelId: number; x: number; y: number; z: number; yaw: number; castsShadow: ShadowMode }>;
  lights: WorldLight[];
  next: { entity: number; light: number };
  clock: number;
  dynamicVersions: Uint32Array;
  parts?: Record<string, unknown>;              // las partes añadidas (addPart), si hay
}

// FNV-1a de 32 bits sobre los bytes, en orden
class Fnv {
  private h = 0x811c9dc5;
  private buf = new DataView(new ArrayBuffer(8));
  bytes(a: ArrayBufferView): void {
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let h = this.h;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 0x01000193);
    this.h = h >>> 0;
  }
  num(n: number): void { this.buf.setInt32(0, n | 0); this.bytes(new Uint8Array(this.buf.buffer, 0, 4)); }
  f64(n: number): void { this.buf.setFloat64(0, n); this.bytes(new Uint8Array(this.buf.buffer, 0, 8)); }
  str(s: string): void { for (let i = 0; i < s.length; i++) this.num(s.charCodeAt(i)); this.num(0); }
  hex(): string { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}

// Orden estable de ids (números antes que nombres)
function byId(a: EntityId, b: EntityId): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
