// Agua de superficie (aguas someras) por el método de las "tuberías virtuales" (Mei, Decaudin y Hu, 2007):
// cada celda tiene el alto del fondo (terreno) y la profundidad del agua; entre celdas vecinas hay un flujo que
// crece con la diferencia de altura de la superficie. Conserva la masa (el agua no se crea ni se pierde salvo
// que se añada o quite a propósito) y se lleva bien con una rejilla 2D grande: es lineal en celdas.
//
// Unidades: alturas en vóxeles, celdas de `cell` vóxeles de lado, tiempo en segundos.
//
// EN ANILLO (para una ventana que se corre con el mundo, live.ts): la celda (x, y) de la rejilla está en el sitio físico
// ((x + ox) mod w, (y + oy) mod h) de los arrays. shift(dx, dy) corre el origen y limpia solo la franja que entra (seca y
// pared, hasta que se cargue), sin copiar nada. Sin correrse, el origen es (0, 0) y el índice es y * w + x, como siempre.
// Los arrays (ground, depth, solid) se leen por índice físico: at(x, y) lo da, y xy(i) lo deshace.

export interface ShallowOptions {
  gravity?: number;      // vóxeles/s²
  damping?: number;      // 0..1 por segundo: cuánto se frena el flujo (más = se calma antes)
  cell?: number;         // vóxeles por celda
}

// Cuánto más alta (en vóxeles) tiene que estar el agua de una celda dormida que la de su vecina despierta para
// despertarla: con menos, lo que bajaría en un subpaso no llega a lo que la mantiene despierta (2e-4 con k = 1/120 *
// 400 / 2: 0,0144), y se volvería a dormir sin moverse
const UPHILL = 0.02;
const FROZEN_TILE = 8;      // lado (celdas) de los cubos de despiertas congeladas fuera del foco

export class ShallowWater {
  readonly w: number;
  readonly h: number;
  readonly cell: number;
  readonly ground: Float32Array;   // alto del fondo
  readonly depth: Float32Array;    // profundidad del agua
  readonly solid: Uint8Array;      // 1 = pared: no entra ni sale agua
  private fl: Float32Array; private fr: Float32Array; private ft: Float32Array; private fb: Float32Array;
  private g: number;
  private damping: number;
  // Reposo: solo se calculan las celdas despiertas (y sus vecinas). Un lago en calma no cuesta nada; una
  // perturbación despierta su zona, y las celdas se vuelven a dormir cuando dejan de moverse.
  private awake: Uint16Array;
  private active: Uint8Array;
  private list: Int32Array;
  private count = 0;
  // Las celdas con awake > 0 (y quizá alguna ya dormida, hasta el siguiente paso): así un paso sin nada despierto no
  // recorre la rejilla. El orden no cuenta: cada fase del paso es independiente celda a celda
  private woken: Int32Array;
  private inWoken: Uint8Array;
  private nWoken = 0;
  // Celdas recorridas por el último paso (para medir, y para probar que en reposo no recorre la rejilla)
  visited = 0;
  // Las dormidas que hay que despertar al acabar el paso (uphill)
  private uphillList: Int32Array;
  private inUphill: Uint8Array;
  private nUphill = 0;
  // El anillo: el sitio físico de la celda (0, 0)
  private ox = 0;
  private oy = 0;
  // EL FOCO: las celdas de la rejilla (x0, y0, x1, y1, extremos incluidos) que se calculan; null, todas. Dentro, el paso es
  // el de siempre, con lo de fuera como pared (ni entra ni sale agua por su borde). Fuera, lo despierto se queda congelado
  // (despierto, con sus flujos) y sigue donde estaba al volver a entrar. Sin foco, o con todo dentro, lo de siempre
  // (las despiertas de fuera, congeladas, no se recorren en cada paso: van a cubos por baldosa de FROZEN_TILE celdas y
  // vuelven a la lista al entrar su baldosa en el foco, al correrse la rejilla o al volver a una instantánea)
  get focus(): [number, number, number, number] | null { return this.focusRect; }
  set focus(f: [number, number, number, number] | null) {
    this.focusRect = f ? [f[0], f[1], f[2], f[3]] : null;
    if (!this.nFrozen) return;
    if (!f) { this.thawAll(); return; }
    const T = FROZEN_TILE, X = this.frozenX;
    for (const [k, cells] of this.frozen) {
      const tx = k % X, ty = (k - tx) / X, x0 = tx * T, y0 = ty * T;
      if (x0 + T - 1 < f[0] || x0 > f[2] || y0 + T - 1 < f[1] || y0 > f[3]) continue;
      for (const i of cells) this.woken[this.nWoken++] = i;
      this.nFrozen -= cells.length;
      this.frozen.delete(k);
    }
  }
  private focusRect: [number, number, number, number] | null = null;
  private readonly frozen = new Map<number, number[]>();
  private nFrozen = 0;
  private readonly frozenX: number;
  // Todas las congeladas, de vuelta a la lista de despiertas (siguen marcadas en inWoken: nunca salieron de ella)
  private thawAll(): void {
    for (const cells of this.frozen.values()) for (const i of cells) this.woken[this.nWoken++] = i;
    this.frozen.clear(); this.nFrozen = 0;
  }
  // (para medir y probar) cuántas despiertas hay congeladas fuera del foco
  get frozenCount(): number { return this.nFrozen; }
  // (para medir y probar) cuántas hay en la lista de despiertas (las que se recorren en cada paso)
  get wokenCount(): number { return this.nWoken; }

  constructor(w: number, h: number, opts: ShallowOptions = {}) {
    this.w = w; this.h = h;
    this.frozenX = Math.ceil(w / FROZEN_TILE);
    this.cell = opts.cell ?? 2;
    this.g = opts.gravity ?? 400;
    this.damping = opts.damping ?? 0.6;
    const n = w * h;
    this.ground = new Float32Array(n);
    this.depth = new Float32Array(n);
    this.solid = new Uint8Array(n);
    this.fl = new Float32Array(n); this.fr = new Float32Array(n); this.ft = new Float32Array(n); this.fb = new Float32Array(n);
    this.active = new Uint8Array(n);
    this.awake = new Uint16Array(n);
    this.list = new Int32Array(n);
    this.woken = new Int32Array(n);
    this.inWoken = new Uint8Array(n);
    this.uphillList = new Int32Array(n);
    this.inUphill = new Uint8Array(n);
    this.wakeAll();
  }

  // El origen del anillo (para medir y probar)
  get origin(): [number, number] { return [this.ox, this.oy]; }
  // El índice físico de la celda (x, y) de la rejilla (0 <= x < w, 0 <= y < h)
  at(x: number, y: number): number {
    let px = x + this.ox, py = y + this.oy;
    if (px >= this.w) px -= this.w;
    if (py >= this.h) py -= this.h;
    return py * this.w + px;
  }
  // La celda (x, y) de la rejilla de un índice físico
  xy(i: number): [number, number] {
    const px = i % this.w, py = (i - px) / this.w;
    let x = px - this.ox, y = py - this.oy;
    if (x < 0) x += this.w;
    if (y < 0) y += this.h;
    return [x, y];
  }

  // Corre la rejilla dx, dy celdas: la celda (x, y) pasa a tener lo que tenía (x + dx, y + dy). Lo que entra (la franja
  // del lado hacia el que se corre) queda seco, quieto y de pared (no entra ni sale agua) con el fondo a 0, hasta que se
  // cargue. Sin copiar: corre el origen y limpia la franja. Un corrimiento de todo el ancho o más lo limpia todo
  shift(dx: number, dy: number): void {
    if (!dx && !dy) return;
    // (las congeladas están en cubos por coordenadas de la rejilla, que cambian: de vuelta a la lista. Correr los cubos con
    // la rejilla salía más caro, medido, que esto más volver a repartirlas en el paso siguiente)
    this.thawAll();
    const { w, h } = this;
    this.ox = (((this.ox + dx) % w) + w) % w;
    this.oy = (((this.oy + dy) % h) + h) % h;
    const cx = Math.max(-w, Math.min(w, dx)), cy = Math.max(-h, Math.min(h, dy));
    if (cx > 0) this.clear(w - cx, 0, w - 1, h - 1); else if (cx < 0) this.clear(0, 0, -cx - 1, h - 1);
    if (cy > 0) this.clear(0, h - cy, w - 1, h - 1); else if (cy < 0) this.clear(0, 0, w - 1, -cy - 1);
  }
  private clear(x0: number, y0: number, x1: number, y1: number): void {
    // (por tramos seguidos de los arrays: una fila de la rejilla son uno o dos, según dé la vuelta en el anillo; con
    // fill, que no depende de que el bucle esté optimizado: el primer corrimiento de una partida corre en frío)
    this.runs(x0, y0, x1, y1, (a, z) => {
      this.ground.fill(0, a, z); this.depth.fill(0, a, z); this.solid.fill(1, a, z);
      this.fl.fill(0, a, z); this.fr.fill(0, a, z); this.ft.fill(0, a, z); this.fb.fill(0, a, z); this.awake.fill(0, a, z);
    });
  }
  // Las celdas [x0, x1] x [y0, y1] de la rejilla como tramos [a, z) de índices físicos seguidos
  runs(x0: number, y0: number, x1: number, y1: number, f: (a: number, z: number) => void): void {
    if (x0 > x1) return;
    for (let y = y0; y <= y1; y++) {
      const a = this.at(x0, y), z = this.at(x1, y);
      if (z >= a) { f(a, z + 1); continue; }
      const row = a - (a % this.w);
      f(a, row + this.w); f(row, z + 1);
    }
  }

  // Sin flujos en la celda del índice físico i (lo cargado nace quieto)
  clearFlow(i: number): void { this.fl[i] = this.fr[i] = this.ft[i] = this.fb[i] = 0; }

  private woke(i: number): void { if (!this.inWoken[i]) { this.inWoken[i] = 1; this.woken[this.nWoken++] = i; } }

  // Despierta todas las celdas mojadas (al empezar o tras cambiar el agua a mano)
  wakeAll(): void {
    for (let i = 0; i < this.awake.length; i++) if (this.depth[i]! > 0) { this.awake[i] = 60; this.woke(i); }
  }

  wake(cx: number, cy: number, radius: number): void {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.h - 1, Math.ceil(cy + radius)); y++)
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.w - 1, Math.ceil(cx + radius)); x++) { const i = this.at(x, y); this.awake[i] = 90; this.woke(i); }
  }

  // Todo lo que define el estado del fluido (para snapshot, restore y hash). Las matrices de trabajo (active, list)
  // no cuentan: se rehacen en cada paso a partir de awake.
  // En el orden de la rejilla (y * w + x), corrida o no
  exportState(): { depth: Float32Array; fl: Float32Array; fr: Float32Array; ft: Float32Array; fb: Float32Array; awake: Uint16Array } {
    return { depth: this.logical(this.depth), fl: this.logical(this.fl), fr: this.logical(this.fr), ft: this.logical(this.ft), fb: this.logical(this.fb), awake: this.logical(this.awake) };
  }
  // Un array en el orden de la rejilla (sin anillo, una copia tal cual)
  logical<T extends Float32Array | Uint16Array | Uint8Array>(a: T): T {
    const out = a.slice() as T;
    if (!this.ox && !this.oy) return out;
    const { w, h } = this;
    for (let y = 0; y < h; y++) {
      const py = (y + this.oy) % h, tail = w - this.ox;
      out.set(a.subarray(py * w + this.ox, py * w + w), y * w);
      out.set(a.subarray(py * w, py * w + this.ox), y * w + tail);
    }
    return out;
  }

  // Vuelve a una instantánea (en el orden de la rejilla): el fondo y las paredes no van en ella; los que haya se pasan al
  // orden de la rejilla con el origen en (0, 0)
  importState(s: ReturnType<ShallowWater['exportState']>): void {
    this.thawAll();
    if (this.ox || this.oy) { this.ground.set(this.logical(this.ground)); this.solid.set(this.logical(this.solid)); this.ox = 0; this.oy = 0; }
    this.depth.set(s.depth); this.fl.set(s.fl); this.fr.set(s.fr); this.ft.set(s.ft); this.fb.set(s.fb); this.awake.set(s.awake);
    for (let k = 0; k < this.nWoken; k++) this.inWoken[this.woken[k]!] = 0;
    this.nWoken = 0;
    for (let i = 0; i < this.awake.length; i++) if (this.awake[i]) this.woke(i);
  }

  // Las celdas que se calcularon en el último paso (las despiertas y sus vecinas)
  activeCells(): Int32Array { return this.list.subarray(0, this.count); }

  // Cuántas celdas se están calculando (para medir)
  get activeCount(): number { return this.count; }

  // Si la celda está despierta (moviéndose o recién movida): su superficie puede estar rebotando, no en reposo
  isAwake(i: number): boolean { return this.awake[i]! > 0; }
  surface(i: number): number {
    return this.ground[i]! + this.depth[i]!;
  }

  totalVolume(): number {
    let v = 0;
    for (let i = 0; i < this.depth.length; i++) v += this.depth[i]!;
    return v;
  }

  // Lista de celdas a calcular: las despiertas y sus vecinas
  private markActive(): void {
    const { w, h, active, awake, list, woken, inWoken } = this;
    // (en el anillo: x0, y0 son la columna y la fila físicas de la celda 0 de la rejilla y xl, yl las de la última)
    const ox = this.ox, oy = this.oy, wl = (h - 1) * w;
    // (el foco: las celdas de la rejilla que se calculan; sin foco, toda. bounded: un foco que deja algo fuera; si no, los
    // bordes son los de la rejilla y no hace falta la x y la y de la rejilla de cada celda)
    const f = this.focus, fx0 = f ? f[0] : 0, fy0 = f ? f[1] : 0, fx1 = f ? f[2] : w - 1, fy1 = f ? f[3] : h - 1;
    const bounded = fx0 > 0 || fy0 > 0 || fx1 < w - 1 || fy1 < h - 1;
    const xl = ox ? ox - 1 : w - 1, yl = oy ? oy - 1 : h - 1;
    for (let k = 0; k < this.count; k++) active[list[k]!] = 0;
    let n = 0;
    // Las despiertas, de su lista; las que se durmieron salen de ella
    let m = 0;
    this.visited = this.nWoken;
    for (let k = 0; k < this.nWoken; k++) {
      const i = woken[k]!;
      if (!awake[i]) { inWoken[i] = 0; continue; }
      woken[m++] = i;
      const px = i % w, py = (i - px) / w;
      let eL: boolean, eR: boolean, eT: boolean, eB: boolean;
      if (bounded) {
        let lx = px - ox, ly = py - oy;
        if (lx < 0) lx += w; if (ly < 0) ly += h;
        // (fuera del foco: sigue despierta, congelada, sin calcularse ni ella ni sus vecinas; a su cubo, fuera de la lista)
        if (lx < fx0 || lx > fx1 || ly < fy0 || ly > fy1) {
          m--;
          const key = Math.floor(lx / FROZEN_TILE) + Math.floor(ly / FROZEN_TILE) * this.frozenX;
          let b = this.frozen.get(key);
          if (!b) this.frozen.set(key, (b = []));
          b.push(i); this.nFrozen++;
          continue;
        }
        eL = lx > fx0; eR = lx < fx1; eT = ly > fy0; eB = ly < fy1;
      } else { eL = px !== ox; eR = px !== xl; eT = py !== oy; eB = py !== yl; }
      // (ella y sus vecinas, a la lista)
      if (!active[i]) { active[i] = 1; list[n++] = i; }
      if (eL) { const j = px > 0 ? i - 1 : i + w - 1; if (!active[j]) { active[j] = 1; list[n++] = j; } }
      if (eR) { const j = px < w - 1 ? i + 1 : i - w + 1; if (!active[j]) { active[j] = 1; list[n++] = j; } }
      if (eT) { const j = py > 0 ? i - w : i + wl; if (!active[j]) { active[j] = 1; list[n++] = j; } }
      if (eB) { const j = py < h - 1 ? i + w : i - wl; if (!active[j]) { active[j] = 1; list[n++] = j; } }
    }
    this.nWoken = m;
    this.count = n;
  }

  step(dt: number): void {
    const { w, h, depth, ground, solid, fl, fr, ft, fb, active } = this;
    const l = this.cell;
    const k = dt * this.g / l;                       // A*g/l con A = l² y el volumen dividido por l²
    const damp = Math.max(0, 1 - this.damping * dt);
    this.markActive();
    const { list, awake, woken, inWoken } = this;
    const n = this.count;
    let nw = this.nWoken;
    const ox = this.ox, oy = this.oy, wl = (h - 1) * w;
    // (el foco: una vecina fuera de él es como pared, en los dos pasos: ni sale ni entra agua por su borde. Sin un foco que
    // deje algo fuera, los bordes son los de la rejilla: sin la x y la y de la rejilla de cada celda)
    const f = this.focus, fx0 = f ? f[0] : 0, fy0 = f ? f[1] : 0, fx1 = f ? f[2] : w - 1, fy1 = f ? f[3] : h - 1;
    const bounded = fx0 > 0 || fy0 > 0 || fx1 < w - 1 || fy1 < h - 1;
    const xl = ox ? ox - 1 : w - 1, yl = oy ? oy - 1 : h - 1;
    // 1) flujos hacia las 4 vecinas según la diferencia de superficie
    for (let q = 0; q < n; q++) {
      const i = list[q]!;
      const px = i % w, py = (i - px) / w;
      // Solo las despiertas mandan agua; sus vecinas solo la reciben (así nunca sale agua hacia una celda que no se
      // va a actualizar en este paso, y la masa se conserva)
      if (solid[i] || !awake[i]) { fl[i] = fr[i] = ft[i] = fb[i] = 0; continue; }
      const s = ground[i]! + depth[i]!;
      // Las vecinas (en el anillo) y si existen (no en el borde de la rejilla ni del foco)
      let hasL: boolean, hasR: boolean, hasT: boolean, hasB: boolean;
      if (bounded) {
        let lx = px - ox, ly = py - oy;
        if (lx < 0) lx += w; if (ly < 0) ly += h;
        hasL = lx > fx0; hasR = lx < fx1; hasT = ly > fy0; hasB = ly < fy1;
      } else { hasL = px !== ox; hasR = px !== xl; hasT = py !== oy; hasB = py !== yl; }
      const iL = px > 0 ? i - 1 : i + w - 1, iR = px < w - 1 ? i + 1 : i - w + 1, iT = py > 0 ? i - w : i + wl, iB = py < h - 1 ? i + w : i - wl;
      let L = hasL && !solid[iL] ? Math.max(0, fl[i]! * damp + k * (s - ground[iL]! - depth[iL]!)) : 0;
      let R = hasR && !solid[iR] ? Math.max(0, fr[i]! * damp + k * (s - ground[iR]! - depth[iR]!)) : 0;
      let T = hasT && !solid[iT] ? Math.max(0, ft[i]! * damp + k * (s - ground[iT]! - depth[iT]!)) : 0;
      let B = hasB && !solid[iB] ? Math.max(0, fb[i]! * damp + k * (s - ground[iB]! - depth[iB]!)) : 0;
      // No puede salir más agua de la que hay
      const out = (L + R + T + B) * dt;
      if (out > depth[i]! && out > 0) { const sc = depth[i]! / out; L *= sc; R *= sc; T *= sc; B *= sc; }
      fl[i] = L; fr[i] = R; ft[i] = T; fb[i] = B;
      // Una vecina dormida con agua más alta: solo las despiertas mandan agua, así que dormida no bajaría nunca hacia
      // aquí (el nivel se quedaría en escalón). Se despierta al acabar el paso (no a mitad: el orden no debe contar)
      if (hasL && !awake[iL]) this.uphill(iL, s); if (hasR && !awake[iR]) this.uphill(iR, s);
      if (hasT && !awake[iT]) this.uphill(iT, s); if (hasB && !awake[iB]) this.uphill(iB, s);
    }
    // 2) profundidad: lo que entra de las vecinas menos lo que sale. Una celda que ya no se mueve se va durmiendo.
    for (let q = 0; q < n; q++) {
      const i = list[q]!;
      // Una pared no tiene agua que mover: si la despertaron (wake no mira si es pared), se duerme como una celda quieta
      if (solid[i]) { if (awake[i]! > 0) awake[i] = awake[i]! - 1; continue; }
      const px = i % w, py = (i - px) / w;
      let eL: boolean, eR: boolean, eT: boolean, eB: boolean;
      if (bounded) {
        let lx = px - ox, ly = py - oy;
        if (lx < 0) lx += w; if (ly < 0) ly += h;
        eL = lx > fx0; eR = lx < fx1; eT = ly > fy0; eB = ly < fy1;
      } else { eL = px !== ox; eR = px !== xl; eT = py !== oy; eB = py !== yl; }
      const inflow = (eL ? fr[px > 0 ? i - 1 : i + w - 1]! : 0) + (eR ? fl[px < w - 1 ? i + 1 : i - w + 1]! : 0)
        + (eT ? fb[py > 0 ? i - w : i + wl]! : 0) + (eB ? ft[py < h - 1 ? i + w : i - wl]! : 0);
      const outflow = fl[i]! + fr[i]! + ft[i]! + fb[i]!;
      const delta = dt * (inflow - outflow);
      depth[i] = Math.max(0, depth[i]! + delta);
      if (Math.abs(delta) > 2e-4 || outflow > 0.02) { awake[i] = 60; if (!inWoken[i]) { inWoken[i] = 1; woken[nw++] = i; } }
      else if (awake[i]! > 0) awake[i] = awake[i]! - 1;
    }
    this.nWoken = nw;
    // Las celdas dormidas no guardan flujo (si no, al despertar empujarían agua vieja)
    for (let q = 0; q < n; q++) { const i = list[q]!; if (!awake[i]) fl[i] = fr[i] = ft[i] = fb[i] = 0; }
    // Las dormidas con agua más alta que una vecina despierta, para el paso siguiente
    for (let k2 = 0; k2 < this.nUphill; k2++) { const j = this.uphillList[k2]!; this.inUphill[j] = 0; if (!awake[j]) { awake[j] = 60; this.woke(j); } }
    this.nUphill = 0;
  }

  // j, vecina de una celda despierta con superficie s: si está dormida, sin pared y con su agua por encima de s más de lo
  // que la dormiría (UPHILL), se apunta para despertarla
  private uphill(j: number, s: number): void {
    if (this.awake[j] || this.solid[j] || this.inUphill[j] || !(this.depth[j]! > 0)) return;
    if (this.ground[j]! + this.depth[j]! - s <= UPHILL) return;
    this.inUphill[j] = 1; this.uphillList[this.nUphill++] = j;
  }

  // Empuja el agua desde (cx, cy) hacia fuera, sin crear ni perder: baja el centro y sube un anillo alrededor
  disturb(cx: number, cy: number, radius: number, amount: number): void {
    const { w, h, depth, solid } = this;
    const inner: number[] = [], ring: number[] = [];
    for (let y = Math.floor(cy - radius * 2); y <= Math.ceil(cy + radius * 2); y++) for (let x = Math.floor(cx - radius * 2); x <= Math.ceil(cx + radius * 2); x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = this.at(x, y);
      if (solid[i] || depth[i]! <= 0.05) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius) inner.push(i); else if (d <= radius * 2) ring.push(i);
    }
    if (!inner.length || !ring.length) return;
    this.wake(cx, cy, radius * 6);
    let taken = 0;
    for (const i of inner) { const t = Math.min(depth[i]! * 0.5, amount); depth[i] = depth[i]! - t; taken += t; }
    for (const i of ring) depth[i] = depth[i]! + taken / ring.length;
  }

  // Velocidad del agua en una celda (unidades del mundo por segundo): el flujo neto de las caras, entre la profundidad.
  // Para lo que flota (world/floaters.ts). ft va hacia y - 1 y fb hacia y + 1.
  flow(x: number, y: number): [number, number] {
    const { w, h, fl, fr, ft, fb } = this;
    if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0];
    const i = this.at(x, y), d = Math.max(0.3, this.depth[i]!);
    const fx = (fr[i]! - fl[i]!) + (x > 0 ? fr[this.at(x - 1, y)]! : 0) - (x < w - 1 ? fl[this.at(x + 1, y)]! : 0);
    const fy = (fb[i]! - ft[i]!) + (y > 0 ? fb[this.at(x, y - 1)]! : 0) - (y < h - 1 ? ft[this.at(x, y + 1)]! : 0);
    return [fx * 0.5 * this.cell / d, fy * 0.5 * this.cell / d];
  }

  // Inclinación de la superficie en una celda (para iluminarla): diferencias centradas
  slope(x: number, y: number): [number, number] {
    const { w, h } = this;
    const s = (xx: number, yy: number) => {
      const cx = Math.max(0, Math.min(w - 1, xx)), cy = Math.max(0, Math.min(h - 1, yy));
      const i = this.at(cx, cy);
      return this.solid[i] || this.depth[i]! <= 0.01 ? this.surface(this.at(x, y)) : this.surface(i);
    };
    return [(s(x + 1, y) - s(x - 1, y)) / (2 * this.cell), (s(x, y + 1) - s(x, y - 1)) / (2 * this.cell)];
  }
}
