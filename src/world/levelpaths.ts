// CAMINOS POR NIVELES (NARUTO): como PathField (paths.ts), pero cada celda puede tener varios suelos donde cabe un
// cuerpo de alto `height` (la superficie y un túnel debajo, los pisos de una casa): un nodo es una celda y uno de sus
// suelos. Se pasa a una celda vecina subiendo como mucho `step` y bajando como mucho `maxDrop`, y solo si el tramo de
// columna que recorre el cuerpo está libre (cae por un pozo, no atraviesa el techo de un túnel). Las distancias a una
// meta salen de un BFS hacia atrás, se guardan mientras no cambien la meta ni el mundo, y los cambios del mundo llegan
// por watchChanges y rehacen solo las celdas tocadas. Para cuerpos que se mueven con moveBodyLevels
// (src/runtime/levels.ts). docs/motor.md, "Caminos por niveles".
import { NO_FOOT, type WorldState } from './state';
import { materialsOf } from '../core';
import type { ChangeWatch } from './changes';

export interface LevelPoint { x: number; y: number; z: number }
export interface LevelPathOptions {
  cell?: number;        // lado de la celda, en vóxeles (4)
  radius?: number;      // radio del cuerpo (0: solo la columna del centro)
  height?: number;      // alto del cuerpo (16)
  step?: number;        // lo más que sube de una celda a otra (2)
  maxDrop?: number;     // lo más que baja (Infinity)
  levels?: number;      // suelos por celda como mucho, de arriba abajo (4)
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

export class LevelPathField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly radius: number;
  readonly height: number;
  readonly step: number;
  readonly maxDrop: number;
  readonly L: number;
  private floor: Float64Array;          // por celda y nivel: el suelo (NO_FOOT: ninguno)
  private ceil: Float64Array;           // y su techo: la cara de abajo del primer vóxel que bloquea encima (Infinity: cielo)
  private dist: Int32Array;             // pasos hasta la meta (-1: sin camino)
  private goal = '';
  private watch: ChangeWatch;
  private around: number[] = [];

  constructor(readonly state: WorldState, o: LevelPathOptions = {}) {
    this.cell = o.cell ?? 4; this.radius = o.radius ?? 0; this.height = o.height ?? 16; this.step = o.step ?? 2;
    this.maxDrop = o.maxDrop ?? Infinity; this.L = o.levels ?? 4;
    this.cols = Math.ceil(state.width / this.cell); this.rows = Math.ceil(state.depth / this.cell);
    this.floor = new Float64Array(this.cols * this.rows * this.L).fill(NO_FOOT);
    this.ceil = new Float64Array(this.cols * this.rows * this.L);
    this.dist = new Int32Array(this.cols * this.rows * this.L).fill(-1);
    const r = this.radius, span = Math.ceil(r);
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dy) <= r) this.around.push(dx, dy);
    this.fill(0, 0, this.cols - 1, this.rows - 1);
    this.watch = state.watchChanges();
  }

  close(): void { this.watch.close(); }

  private blocks(x: number, y: number, z: number): boolean {
    const s = this.state.solid;
    if (x < 0 || y < 0 || x >= s.width || y >= s.depth) return true;
    if (z < s.zMin || z > s.zMax) return false;
    const v = s.get(x, y, z), mt = materialsOf(s.palette);
    return !!v && (!mt || mt.blocks[v] === 1);
  }
  // ¿Nada que bloquee en la columna (x, y) entre z0 y z1 (sin z1)?
  private open(x: number, y: number, z0: number, z1: number): boolean {
    for (let z = Math.floor(z0); z < Math.ceil(z1); z++) if (this.blocks(x, y, z)) return false;
    return true;
  }

  // Los suelos de cada celda: bajando por la columna del centro, la cara de arriba de cada vóxel que bloquea con hueco
  // para el cuerpo encima (y que no sea de los que no se suben), de arriba abajo, hasta L; y que el cuerpo entero (las
  // columnas a su radio) quepa ahí
  private fill(i0: number, j0: number, i1: number, j1: number): void {
    const st = this.state, s = st.solid, c = this.cell, a = this.around, mt = materialsOf(s.palette);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const base = (j * this.cols + i) * this.L;
      for (let k = 0; k < this.L; k++) this.floor[base + k] = NO_FOOT;
      const cx = Math.min(s.width - 1, i * c + (c >> 1)), cy = Math.min(s.depth - 1, j * c + (c >> 1));
      let air = Infinity, n = 0, roof = Infinity;                  // aire seguido encima (el cielo, infinito) y su techo
      for (let z = Math.min(s.zMax, s.height[cy * s.width + cx]! - 1); z >= s.zMin && n < this.L; z--) {
        const v = s.get(cx, cy, z);
        if (!v || (mt && !mt.blocks[v])) { air++; continue; }
        const f = z + 1;
        if (air >= this.height && (!mt || mt.climb[v])) {
          let fits = true;
          for (let k = 0; k < a.length && fits; k += 2) if (!this.open(cx + a[k]!, cy + a[k + 1]!, f, f + this.height)) fits = false;
          if (fits) { this.floor[base + n] = f; this.ceil[base + n] = roof; n++; }
        }
        air = 0; roof = z;
      }
    }
  }

  private sync(): void {
    const { boxes } = this.watch.take();
    if (!boxes.length) return;
    const c = this.cell, m = Math.ceil(this.radius) + 1;
    for (const b of boxes) this.fill(Math.max(0, Math.floor((b.x0 - m) / c)), Math.max(0, Math.floor((b.y0 - m) / c)),
      Math.min(this.cols - 1, Math.floor((b.x1 + m) / c)), Math.min(this.rows - 1, Math.floor((b.y1 + m) / c)));
    this.goal = '';
  }

  private cellOf(p: { x: number; y: number }): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / this.cell))) * this.cols + Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.cell)));
  }
  // El nodo de un punto: su celda y el suelo más cercano a su z (de los que no quedan por encima de z + step)
  private nodeOf(p: LevelPoint): number {
    const c = this.cellOf(p), base = c * this.L;
    let best = -1, bd = Infinity;
    for (let k = 0; k < this.L; k++) {
      const f = this.floor[base + k]!;
      if (f === NO_FOOT || f > p.z + this.step) continue;
      const d = Math.abs(f - p.z);
      if (d < bd) { bd = d; best = base + k; }
    }
    return best;
  }

  // ¿De un nodo a otro de una celda vecina? Alturas; y el cuerpo pasa a la altura mayor de los dos suelos: cada columna
  // del centro libre desde su suelo hasta esa altura más el alto (sube en una, cae en la otra), y en diagonal las dos de
  // lado libres a esa altura
  private canMove(a: number, b: number): boolean {
    const fa = this.floor[a]!, fb = this.floor[b]!;
    if (fa === NO_FOOT || fb === NO_FOOT || fb - fa > this.step || fa - fb > this.maxDrop) return false;
    const L = this.L, ca = Math.floor(a / L), cb = Math.floor(b / L), top = Math.max(fa, fb), hi = top + this.height;
    const s = this.state.solid, c = this.cell;
    const col = (cell: number): [number, number] => [Math.min(s.width - 1, (cell % this.cols) * c + (c >> 1)), Math.min(s.depth - 1, Math.floor(cell / this.cols) * c + (c >> 1))];
    // Las del centro: el techo de cada suelo (lo que hay libre encima)
    if (this.ceil[a]! < hi || this.ceil[b]! < hi) return false;
    const ax = ca % this.cols, bx = cb % this.cols;
    if (ax !== bx && ca - ax !== cb - bx) for (const cell of [(ca - ax) + bx, (cb - bx) + ax]) {
      // De lado: un suelo de esa celda cuyo hueco cubra el paso; si no lo hay (no se guardan todos), se mira la columna
      let ok = false;
      for (let k = 0; k < L && !ok; k++) { const n = cell * L + k, f = this.floor[n]!; if (f !== NO_FOOT && f <= top && this.ceil[n]! >= hi) ok = true; }
      if (!ok) { const [x, y] = col(cell); if (!this.open(x, y, top, hi)) return false; }
    }
    return true;
  }

  private toward(to: LevelPoint, near: number): void {
    this.sync();
    const g = this.nodeOf(to), key = `${g}:${near}`;
    if (key === this.goal) return;
    this.goal = key;
    const { cols, rows, L, dist } = this;
    dist.fill(-1);
    if (g < 0) return;
    const q = new Int32Array(cols * rows * L);
    let head = 0, tail = 0;
    dist[g] = 0; q[tail++] = g;
    // Además, los de las celdas a `near` (en el mismo suelo, más o menos step)
    if (near > 0) {
      const span = Math.ceil(near / this.cell), gc = Math.floor(g / L), gx = gc % cols, gy = Math.floor(gc / cols), fg = this.floor[g]!;
      for (let y = gy - span; y <= gy + span; y++) for (let x = gx - span; x <= gx + span; x++) {
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (Math.hypot((x - gx) * this.cell, (y - gy) * this.cell) > near) continue;
        for (let k = 0; k < L; k++) { const n = (y * cols + x) * L + k, f = this.floor[n]!; if (f !== NO_FOOT && Math.abs(f - fg) <= this.step && dist[n]! < 0) { dist[n] = 0; q[tail++] = n; } }
      }
    }
    while (head < tail) {
      const n = q[head++]!, cell = Math.floor(n / L), x = cell % cols, y = Math.floor(cell / cols);
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nb = (ny * cols + nx) * L;
        for (let k = 0; k < L; k++) {
          const m = nb + k;
          if (dist[m]! >= 0 || this.floor[m] === NO_FOOT || !this.canMove(m, n)) continue;
          dist[m] = dist[n]! + 1;
          q[tail++] = m;
        }
      }
    }
  }

  private next(n: number): number {
    const { cols, rows, L, dist } = this, here = dist[n]!;
    if (here <= 0) return here === 0 ? -1 : -2;
    const cell = Math.floor(n / L), x = cell % cols, y = Math.floor(cell / cols);
    let best = -2, bd = here;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      for (let k = 0; k < L; k++) { const m = (ny * cols + nx) * L + k, d = dist[m]!; if (d >= 0 && d < bd && this.canMove(n, m)) { bd = d; best = m; } }
    }
    return best;
  }

  private point(n: number): LevelPoint {
    const cell = Math.floor(n / this.L), c = this.cell;
    return { x: (cell % this.cols) * c + c / 2, y: Math.floor(cell / this.cols) * c + c / 2, z: this.floor[n]! };
  }

  // Hacia dónde ir (unitario en x e y) desde `from` para llegar a `to`; null si ya está (a `near`) o no hay camino
  dir(from: LevelPoint, to: LevelPoint, near = 0): { x: number; y: number } | null {
    this.toward(to, near);
    const n = this.nodeOf(from);
    if (n < 0) return null;
    const m = this.next(n);
    if (m < 0) return null;
    const p = this.point(m), tx = p.x - from.x, ty = p.y - from.y, l = Math.hypot(tx, ty) || 1;
    return { x: tx / l, y: ty / l };
  }

  // El camino entero: los centros de las celdas con su suelo, o null si no hay
  path(from: LevelPoint, to: LevelPoint, near = 0): LevelPoint[] | null {
    this.toward(to, near);
    let n = this.nodeOf(from);
    if (n < 0 || this.dist[n]! < 0) return null;
    const out: LevelPoint[] = [];
    for (let guard = 0; guard < this.dist.length; guard++) {
      out.push(this.point(n));
      if (this.dist[n] === 0) return out;
      n = this.next(n);
      if (n < 0) return null;
    }
    return null;
  }

  // Los suelos de la celda de un punto (de arriba abajo), para depurar o dibujar
  floorsAt(p: { x: number; y: number }): number[] {
    this.sync();
    const base = this.cellOf(p) * this.L, out: number[] = [];
    for (let k = 0; k < this.L; k++) { const f = this.floor[base + k]!; if (f !== NO_FOOT) out.push(f); }
    return out;
  }
}
