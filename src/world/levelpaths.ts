// CAMINOS POR NIVELES (NARUTO): como PathField (paths.ts), pero cada celda puede tener varios suelos donde cabe un
// cuerpo de alto `height` (la superficie y un túnel debajo, los pisos de una casa): un nodo es una celda y uno de sus
// suelos. Se pasa a una celda vecina subiendo como mucho `step` y bajando como mucho `maxDrop`, y solo si el tramo de
// columna que recorre el cuerpo está libre (cae por un pozo, no atraviesa el techo de un túnel). Las distancias a una
// meta salen de un BFS hacia atrás, se guardan mientras no cambien la meta ni el mundo, y los cambios del mundo llegan
// por watchChanges y rehacen solo las celdas tocadas. Con `budget`, la búsqueda se reparte entre ticks (advance). Para
// cuerpos que se mueven con moveBodyLevels (src/runtime/levels.ts). docs/motor.md, "Caminos por niveles".
import { NO_FOOT, shiftGrid, type WorldState } from './state';
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
  // Búsqueda repartida: nodos por advance() (sin él, cada meta nueva se busca entera al pedirla). Ver advance()
  budget?: number;
  // Hasta dónde se busca: los nodos a más de `reach` pasos de la meta no tienen camino (dir null). Sin él, todo el campo.
  // En una ventana viva grande (288 x 352 celdas en 9 x 11 trozos), una meta que se mueve cuesta una búsqueda de todo
  // el campo cada vez que cambia de celda; con reach, ~π·reach² nodos
  reach?: number;
}

const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
// La dirección contraria de cada una de N8 (su índice)
const BACK = N8.map(([dx, dy]) => N8.findIndex(([ex, ey]) => ex === -dx && ey === -dy));

export class LevelPathField {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  readonly radius: number;
  readonly height: number;
  readonly step: number;
  readonly maxDrop: number;
  readonly L: number;
  readonly budget: number | undefined;
  readonly reach: number;
  private floor: Float64Array;          // por celda y nivel: el suelo (NO_FOOT: ninguno)
  private ceil: Float64Array;           // y su techo: la cara de abajo del primer vóxel que bloquea encima (Infinity: cielo)
  private dist: Int32Array;             // pasos hasta la meta (-1: sin camino)
  // Lo que da canMove de cada nodo a cada nodo de cada celda vecina: por nodo, dirección (N8) y nivel. 0: sin mirar,
  // 1: se pasa, 2: no. Se rellena al buscar y se borra donde cambia el mundo: una búsqueda nueva con el mundo igual
  // no vuelve a mirar columnas
  private moves: Uint8Array;
  private floors: Uint8Array;           // por celda: cuántos suelos tiene (van seguidos desde el nivel 0)
  private goal = '';
  private watch: ChangeWatch;
  private around: number[] = [];
  private offsets: number[] = [];       // desplazamientos del cuerpo que se prueban (el centro primero)

  constructor(readonly state: WorldState, o: LevelPathOptions = {}) {
    this.cell = o.cell ?? 4; this.radius = o.radius ?? 0; this.height = o.height ?? 16; this.step = o.step ?? 2;
    this.maxDrop = o.maxDrop ?? Infinity; this.L = o.levels ?? 4;
    this.budget = o.budget;
    this.reach = o.reach ?? Infinity;
    this.cols = Math.ceil(state.width / this.cell); this.rows = Math.ceil(state.depth / this.cell);
    this.floor = new Float64Array(this.cols * this.rows * this.L).fill(NO_FOOT);
    this.ceil = new Float64Array(this.cols * this.rows * this.L);
    this.dist = new Int32Array(this.cols * this.rows * this.L).fill(-1);
    this.floors = new Uint8Array(this.cols * this.rows);
    this.moves = new Uint8Array(this.cols * this.rows * this.L * 8 * this.L);
    const r = this.radius, span = Math.ceil(r);
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) if (Math.hypot(dx, dy) <= r) this.around.push(dx, dy);
    // Lo que el cuerpo sobresale de la celda por cada lado (la columna central es la c >> 1 de la celda)
    const lo = Math.max(0, span - (this.cell >> 1)), hi = Math.max(0, span - (this.cell - 1 - (this.cell >> 1)));
    const off: Array<[number, number]> = [];
    for (let dy = -hi; dy <= lo; dy++) for (let dx = -hi; dx <= lo; dx++) off.push([dx, dy]);
    off.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]) || p[1] - q[1] || p[0] - q[0]);
    for (const [dx, dy] of off) this.offsets.push(dx, dy);
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
    const st = this.state, s = st.solid, c = this.cell, mt = materialsOf(s.palette);
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
          if (this.fits(cx, cy, f)) { this.floor[base + n] = f; this.ceil[base + n] = roof; n++; }
        }
        air = 0; roof = z;
      }
      this.floors[j * this.cols + i] = n;
    }
  }

  // ¿Cabe el cuerpo de pie sobre f en la celda de la columna central (cx, cy)? Primero centrado; un cuerpo más ancho que
  // media celda sobresale de ella, y entonces se prueba también corrido dentro de lo que sobresale (que lo que sobra
  // quede de un lado): si no, una celda junto a una pared o a la cara de un escalón no sería nunca suelo y no se
  // podría subir ni un escalón. Con un cuerpo que cabe centrado, no se corre: lo de siempre
  private fits(cx: number, cy: number, f: number): boolean {
    const a = this.around, sh = this.offsets, s = this.state.solid;
    for (let q = 0; q < sh.length; q += 2) {
      const x = cx + sh[q]!, y = cy + sh[q + 1]!;
      if (x < 0 || y < 0 || x >= s.width || y >= s.depth) continue;
      let ok = true;
      for (let k = 0; k < a.length && ok; k += 2) if (!this.open(x + a[k]!, y + a[k + 1]!, f, f + this.height)) ok = false;
      if (ok) return true;
    }
    return false;
  }

  private sync(): void {
    const { boxes } = this.watch.take();
    if (!boxes.length) return;
    const c = this.cell, m = Math.ceil(this.radius) + 1;
    for (const b of boxes) this.redo(Math.max(0, Math.floor((b.x0 - m) / c)), Math.max(0, Math.floor((b.y0 - m) / c)),
      Math.min(this.cols - 1, Math.floor((b.x1 + m) / c)), Math.min(this.rows - 1, Math.floor((b.y1 + m) / c)));
    this.goal = '';
    // Lo que se estaba buscando era con el mundo de antes: se tira, y la meta se vuelve a pedir en el siguiente dir() o
    // path() (la respuesta que hay se queda hasta que acabe la siguiente)
    if (this.work) { this.spare = { dist: this.work.dist, q: this.work.q }; this.work = null; }
  }

  // Rehace los suelos de las celdas [i0, i1] x [j0, j1]; un paso entre dos celdas mira sus suelos, sus techos y las dos
  // de lado (en diagonal): todas a una celda como mucho de las rehechas. Se borra lo guardado de los pasos que salen de
  // ellas y de sus vecinas
  private redo(i0: number, j0: number, i1: number, j1: number): void {
    this.fill(i0, j0, i1, j1);
    const per = 8 * this.L * this.L;
    for (let j = Math.max(0, j0 - 1); j <= Math.min(this.rows - 1, j1 + 1); j++) {
      const a = (j * this.cols + Math.max(0, i0 - 1)) * per, z = (j * this.cols + Math.min(this.cols - 1, i1 + 1) + 1) * per;
      this.moves.fill(0, a, z);
    }
  }

  // LA VENTANA VIVA (LiveWindow.attach, o el onShift del juego): el mundo se corrió dx, dy vóxeles (lo que estaba en la x
  // pasa a x - dx; múltiplos de cell). Las celdas se corren con él (suelos, techos, pasos guardados y distancias); las
  // que entran quedan sin suelo hasta que se escriba su trozo (el aviso de watchChanges las rellena), y las del borde se
  // vuelven a mirar (su cuerpo ya no tiene vecinas fuera). La meta se vuelve a buscar en la consulta siguiente (va en
  // coordenadas de antes); con budget, mientras, contestan las distancias de antes, corridas
  shift(dx: number, dy: number): void {
    const c = this.cell, L = this.L, { cols, rows } = this;
    if (dx % c || dy % c) throw new Error(`LevelPathField.shift: ${dx}, ${dy} no son múltiplos de la celda (${c})`);
    const i = dx / c, j = dy / c;
    shiftGrid(this.floor, cols, rows, L, i, j, NO_FOOT);
    shiftGrid(this.ceil, cols, rows, L, i, j, 0);
    shiftGrid(this.dist, cols, rows, L, i, j, -1);
    shiftGrid(this.floors, cols, rows, 1, i, j, 0);
    shiftGrid(this.moves, cols, rows, 8 * L * L, i, j, 0);
    // El borde nuevo del lado que sale (eran celdas de dentro); el del lado que entra está vacío hasta que se escriba, y
    // los otros dos no cambian
    const b = Math.ceil((this.radius + 1) / c);
    if (i > 0) this.redo(0, 0, b - 1, rows - 1); else if (i < 0) this.redo(cols - b, 0, cols - 1, rows - 1);
    if (j > 0) this.redo(0, 0, cols - 1, b - 1); else if (j < 0) this.redo(0, rows - b, cols - 1, rows - 1);
    this.goal = '';
    if (this.work) { this.spare = { dist: this.work.dist, q: this.work.q }; this.work = null; }
    this.want = null; this.asked = '';
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

  // canMove guardado: de a a b, que está en la celda vecina d (índice en N8), nivel kb
  private move(a: number, d: number, b: number): boolean {
    const L = this.L, i = ((a * 8) + d) * L + (b % L);
    let v = this.moves[i]!;
    if (!v) this.moves[i] = v = this.canMove(a, b) ? 1 : 2;
    return v === 1;
  }

  // La búsqueda: un BFS hacia atrás desde la meta (y las celdas a `near` de ella) sobre `work`, por tandas de nodos.
  // Sin `budget`, de una vez al pedir otra meta; con `budget`, la sigue advance() y, mientras, se contesta con la
  // última acabada. Las dos dan las mismas distancias: el mismo orden de cola, partido o no
  private work: { key: string; dist: Int32Array; q: Int32Array; head: number; tail: number } | null = null;
  private spare: { dist: Int32Array; q: Int32Array } | null = null;      // búferes para la siguiente búsqueda
  private want: { key: string; to: LevelPoint; near: number } | null = null;

  private start(key: string, to: LevelPoint, near: number): void {
    const { cols, rows, L } = this, g = this.nodeOf(to);
    const buf = this.work ?? this.spare ?? { dist: new Int32Array(cols * rows * L), q: new Int32Array(cols * rows * L) };
    const w = { key, dist: buf.dist, q: buf.q, head: 0, tail: 0 };
    this.spare = null;
    const dist = w.dist, q = w.q;
    dist.fill(-1);
    this.work = w;
    if (g < 0) return;
    dist[g] = 0; q[w.tail++] = g;
    // Además, los de las celdas a `near` (en el mismo suelo, más o menos step)
    if (near > 0) {
      const span = Math.ceil(near / this.cell), gc = Math.floor(g / L), gx = gc % cols, gy = Math.floor(gc / cols), fg = this.floor[g]!;
      for (let y = gy - span; y <= gy + span; y++) for (let x = gx - span; x <= gx + span; x++) {
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        if (Math.hypot((x - gx) * this.cell, (y - gy) * this.cell) > near) continue;
        for (let k = 0; k < L; k++) { const n = (y * cols + x) * L + k, f = this.floor[n]!; if (f !== NO_FOOT && Math.abs(f - fg) <= this.step && dist[n]! < 0) { dist[n] = 0; q[w.tail++] = n; } }
      }
    }
  }

  // Saca hasta `nodes` nodos de la cola de la búsqueda en curso; true si acabó (y entonces pasa a ser la respuesta)
  private expand(nodes: number): boolean {
    const w = this.work;
    if (!w) return true;
    const { cols, rows, L } = this, dist = w.dist, q = w.q;
    let head = w.head, tail = w.tail;
    for (let left = nodes; head < tail && left > 0; left--) {
      const n = q[head++]!, cell = Math.floor(n / L), x = cell % cols, y = Math.floor(cell / cols);
      if (dist[n]! >= this.reach) continue;
      for (let d = 0; d < 8; d++) {
        const nx = x + N8[d]![0], ny = y + N8[d]![1];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const nc = ny * cols + nx, nb = nc * L, nf = this.floors[nc]!;
        for (let k = 0; k < nf; k++) {
          const m = nb + k;
          if (dist[m]! >= 0 || !this.move(m, BACK[d]!, n)) continue;
          dist[m] = dist[n]! + 1;
          q[tail++] = m;
        }
      }
    }
    w.head = head; w.tail = tail;
    if (head < tail) return false;
    // Acabada: sus distancias son la respuesta (y el búfer viejo queda para la siguiente)
    this.spare = { dist: this.dist, q: w.q };
    this.dist = w.dist; this.goal = w.key;
    this.work = null;
    return true;
  }

  private toward(to: LevelPoint, near: number): void {
    this.sync();
    const key = `${this.nodeOf(to)}:${near}`;
    if (this.budget === undefined) {
      if (key === this.goal) return;
      this.start(key, to, near);
      this.expand(Infinity);
      return;
    }
    // Repartida: se apunta lo que se quiere; advance() lo busca
    this.want = key === this.goal && !this.work ? null : { key, to, near };
    this.asked = key;
  }

  // Con `budget`: cuántos advance() seguidos lleva la respuesta sin ser la de la última meta pedida (0: al día). Una meta
  // que cambia más deprisa de lo que da la tanda lo hace crecer; con tanda de sobra, vuelve a 0. Para elegir la tanda
  // con un número
  get lag(): number { return this.behind; }
  private asked = '';
  private behind = 0;

  // Con `budget`: sigue la búsqueda pendiente, hasta `budget` nodos (o `nodes`). Una vez por tick, desde la
  // simulación: va por nodos, no por reloj, así que la misma partida da lo mismo en cualquier máquina. Si mientras se
  // busca piden otra meta, se acaba la que está en marcha y luego se empieza la nueva (si se empezara de cero cada vez,
  // una meta que se mueve deprisa no se acabaría nunca). Devuelve true si no queda nada pendiente
  advance(nodes = this.budget ?? Infinity): boolean {
    const idle = this.advanceSearch(nodes);
    this.behind = this.asked && this.asked !== this.goal ? this.behind + 1 : 0;
    return idle;
  }
  private advanceSearch(nodes: number): boolean {
    this.sync();
    if (!this.work) {
      const w = this.want;
      if (!w || w.key === this.goal) { this.want = null; return true; }
      this.start(w.key, w.to, w.near);
      this.want = null;
    }
    const done = this.expand(nodes);
    return done && (!this.want || this.want.key === this.goal);
  }

  private next(n: number): number {
    const { cols, rows, L, dist } = this, here = dist[n]!;
    if (here <= 0) return here === 0 ? -1 : -2;
    const cell = Math.floor(n / L), x = cell % cols, y = Math.floor(cell / cols);
    let best = -2, bd = here;
    for (let e = 0; e < 8; e++) {
      const nx = x + N8[e]![0], ny = y + N8[e]![1];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      for (let k = 0; k < L; k++) { const m = (ny * cols + nx) * L + k, d = dist[m]!; if (d >= 0 && d < bd && this.move(n, e, m)) { bd = d; best = m; } }
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
