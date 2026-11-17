// CAMINOS SOBRE EL SUELO (NARUTO, a partir del campo de caminos del juego de ejemplo): una rejilla de celdas de
// `cell` vóxeles sobre las columnas del mundo, con el suelo de cada una (footing: lo más alto que se pisa) y si cabe en
// ella un cuerpo de radio `radius`. Se pasa de una celda a una vecina (8 vecinas, sin cortar esquinas) si se sube como
// mucho `step` y se baja como mucho `maxDrop`. Las distancias a una meta salen de un BFS hacia atrás y se rehacen solo
// cuando cambia la meta o el mundo; los cambios del mundo llegan por watchChanges y rehacen solo las celdas tocadas.
// Solo superficie: una celda tiene un suelo (el de arriba), así que no ve túneles ni cuevas.
// docs/motor.md, "Caminos".
import { NO_FOOT, shiftGrid, type WorldState } from './state';
import type { ChangeWatch } from './changes';

export interface Point { x: number; y: number }
export interface PathOptions {
  cell?: number;        // lado de la celda, en vóxeles (4)
  radius?: number;      // radio del cuerpo, en vóxeles: cabe si todas las columnas a esa distancia se pisan (0: el centro)
  step?: number;        // lo más que sube de una celda a otra, y lo más que puede sobresalir el suelo bajo el cuerpo (2)
  maxDrop?: number;     // lo más que baja de una celda a otra (Infinity)
  reach?: number;       // hasta cuántos pasos de la meta se busca (Infinity); más lejos, sin camino. Ver LevelPathField
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

export class PathField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly radius: number;
  readonly step: number;
  readonly maxDrop: number;
  readonly reach: number;
  private floor: Float64Array;          // el suelo de cada celda (NO_FOOT: no se puede estar)
  private dist: Int32Array;             // pasos hasta la meta (-1: sin camino)
  private goal = '';
  private watch: ChangeWatch;
  private around: number[] = [];        // las columnas del cuerpo, relativas al centro de la celda

  constructor(readonly state: WorldState, o: PathOptions = {}) {
    this.cell = o.cell ?? 4; this.radius = o.radius ?? 0; this.step = o.step ?? 2; this.maxDrop = o.maxDrop ?? Infinity;
    this.reach = o.reach ?? Infinity;
    this.cols = Math.ceil(state.width / this.cell); this.rows = Math.ceil(state.depth / this.cell);
    this.floor = new Float64Array(this.cols * this.rows);
    this.dist = new Int32Array(this.cols * this.rows).fill(-1);
    const r = this.radius, span = Math.ceil(r);
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dy) <= r) this.around.push(dx, dy);
    this.fill(0, 0, this.cols - 1, this.rows - 1);
    this.watch = state.watchChanges();
  }

  // Deja de oír los cambios del mundo (al tirar el campo)
  close(): void { this.watch.close(); }

  // El suelo de la celda: el del centro, si todo el cuerpo se pisa ahí y nada bajo él sobresale más de step
  private fill(i0: number, j0: number, i1: number, j1: number): void {
    const st = this.state, c = this.cell, a = this.around;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cx = Math.min(st.width - 1, i * c + (c >> 1)), cy = Math.min(st.depth - 1, j * c + (c >> 1));
      let g = st.footing(cx, cy);
      if (g !== NO_FOOT) for (let k = 0; k < a.length; k += 2) {
        const x = cx + a[k]!, y = cy + a[k + 1]!;
        const h = x < 0 || y < 0 || x >= st.width || y >= st.depth ? NO_FOOT : st.footing(x, y);
        if (h === NO_FOOT || h - g > this.step) { g = NO_FOOT; break; }
      }
      this.floor[j * this.cols + i] = g;
    }
  }

  // LA VENTANA VIVA (LiveWindow.attach, o el onShift del juego): el mundo se corrió dx, dy vóxeles (lo que estaba en la x
  // pasa a x - dx; múltiplos de cell). Las celdas se corren con él; las que entran quedan sin suelo hasta que se escriba
  // su trozo (el aviso de watchChanges las rellena), y las del borde se vuelven a mirar (su cuerpo ya no tiene vecinas
  // fuera). La meta se vuelve a buscar en la consulta siguiente (va en coordenadas de antes)
  shift(dx: number, dy: number): void {
    const c = this.cell;
    if (dx % c || dy % c) throw new Error(`PathField.shift: ${dx}, ${dy} no son múltiplos de la celda (${c})`);
    const i = dx / c, j = dy / c;
    shiftGrid(this.floor, this.cols, this.rows, 1, i, j, NO_FOOT);
    shiftGrid(this.dist, this.cols, this.rows, 1, i, j, -1);
    // El borde nuevo del lado que sale (eran celdas de dentro); el del lado que entra está vacío hasta que se escriba, y
    // los otros dos no cambian
    const b = Math.ceil((this.radius + 1) / c);
    if (i > 0) this.fill(0, 0, b - 1, this.rows - 1); else if (i < 0) this.fill(this.cols - b, 0, this.cols - 1, this.rows - 1);
    if (j > 0) this.fill(0, 0, this.cols - 1, b - 1); else if (j < 0) this.fill(0, this.rows - b, this.cols - 1, this.rows - 1);
    this.goal = '';
  }

  // Pone al día las celdas que tocan lo que cambió en el mundo desde la última vez (lo llaman las consultas)
  private sync(): void {
    const { boxes } = this.watch.take();
    if (!boxes.length) return;
    const c = this.cell, m = Math.ceil(this.radius) + 1;
    for (const b of boxes) this.fill(Math.max(0, Math.floor((b.x0 - m) / c)), Math.max(0, Math.floor((b.y0 - m) / c)),
      Math.min(this.cols - 1, Math.floor((b.x1 + m) / c)), Math.min(this.rows - 1, Math.floor((b.y1 + m) / c)));
    this.goal = '';
  }

  private index(p: Point): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor(p.y / this.cell))) * this.cols + Math.min(this.cols - 1, Math.max(0, Math.floor(p.x / this.cell)));
  }

  // ¿Se puede pasar de la celda a a la vecina b? (alturas; en diagonal, también por las dos de lado)
  private canMove(a: number, b: number): boolean {
    const fa = this.floor[a]!, fb = this.floor[b]!;
    if (fa === NO_FOOT || fb === NO_FOOT || fb - fa > this.step || fa - fb > this.maxDrop) return false;
    const ax = a % this.cols, bx = b % this.cols;
    if (ax !== bx && (a - ax) !== (b - bx)) {
      const s1 = (a - ax) + bx, s2 = (b - bx) + ax;   // las dos celdas de lado
      for (const s of [s1, s2]) { const fs = this.floor[s]!; if (fs === NO_FOOT || fs - fa > this.step || fa - fs > this.maxDrop) return false; }
    }
    return true;
  }

  // Las distancias (en pasos de celda) hasta las celdas a `near` vóxeles o menos de `to`. Se rehacen si cambió la meta
  // o el mundo
  private toward(to: Point, near: number): void {
    this.sync();
    const key = `${this.index(to)}:${near}`;
    if (key === this.goal) return;
    this.goal = key;
    const { cols, rows, cell: c } = this, dist = this.dist;
    dist.fill(-1);
    const q = new Int32Array(cols * rows);
    let head = 0, tail = 0;
    const span = Math.ceil(near / c) + 1, gx = Math.floor(to.x / c), gy = Math.floor(to.y / c);
    for (let y = gy - span; y <= gy + span; y++) for (let x = gx - span; x <= gx + span; x++) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const k = y * cols + x;
      // La celda de la meta, y las que tengan el centro a `near` o menos
      if (this.floor[k] === NO_FOOT || (!(x === gx && y === gy) && Math.hypot(x * c + c / 2 - to.x, y * c + c / 2 - to.y) > near)) continue;
      dist[k] = 0; q[tail++] = k;
    }
    // Hacia atrás: m entra en la cola si desde m se puede ir a k
    while (head < tail) {
      const k = q[head++]!, x = k % cols, y = (k - x) / cols;
      if (dist[k]! >= this.reach) continue;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const m = ny * cols + nx;
        if (dist[m]! >= 0 || !this.canMove(m, k)) continue;
        dist[m] = dist[k]! + 1;
        q[tail++] = m;
      }
    }
  }

  // Hacia dónde ir (unitario, en x e y del mundo) desde `from` para llegar a `to` por el camino más corto; null si ya
  // está a `near` o menos, o si no hay camino. Un cuerpo en una celda sin camino (encajado) va a la vecina más cercana
  // que lo tenga (a 2 o menos)
  dir(from: Point, to: Point, near = 0): Point | null {
    this.toward(to, near);
    const next = this.next(this.index(from));
    if (next < 0) return null;
    const c = this.cell, tx = (next % this.cols) * c + c / 2 - from.x, ty = Math.floor(next / this.cols) * c + c / 2 - from.y;
    const l = Math.hypot(tx, ty) || 1;
    return { x: tx / l, y: ty / l };
  }

  private next(k: number): number {
    const { cols, rows, dist } = this, here = dist[k]!;
    if (here === 0) return -1;
    const kx = k % cols, ky = (k - kx) / cols, span = here >= 0 ? 1 : 2;
    let best = -1, bd = here >= 0 ? here : Infinity;
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) {
      const nx = kx + dx, ny = ky + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const m = ny * cols + nx, d = dist[m]!;
      if (d >= 0 && d < bd && (here < 0 || this.canMove(k, m))) { bd = d; best = m; }
    }
    return best;
  }

  // El camino entero de `from` a `to`: los centros de las celdas (con su suelo en z), o null si no hay
  path(from: Point, to: Point, near = 0): Array<{ x: number; y: number; z: number }> | null {
    this.toward(to, near);
    let k = this.index(from);
    if (this.dist[k]! < 0) return null;
    const c = this.cell, out: Array<{ x: number; y: number; z: number }> = [];
    for (let guard = 0; guard < this.cols * this.rows; guard++) {
      out.push({ x: (k % this.cols) * c + c / 2, y: Math.floor(k / this.cols) * c + c / 2, z: this.floor[k]! });
      if (this.dist[k] === 0) return out;
      k = this.next(k);
      if (k < 0) return null;
    }
    return null;
  }

  // Lo que el campo sabe de una celda (para dibujarlo o depurar): su suelo (null si no se puede estar) y sus pasos a la
  // meta de la última consulta (-1 sin camino)
  at(p: Point): { floor: number | null; dist: number } {
    this.sync();
    const k = this.index(p), f = this.floor[k]!;
    return { floor: f === NO_FOOT ? null : f, dist: this.dist[k]! };
  }
}

// Un camino suelto (sin guardar el campo): para pocas consultas. Para muchos cuerpos hacia la misma meta, un PathField
export function findPath(state: WorldState, from: Point, to: Point, o: PathOptions & { near?: number } = {}): Array<{ x: number; y: number; z: number }> | null {
  const f = new PathField(state, o);
  try { return f.path(from, to, o.near ?? 0); } finally { f.close(); }
}
