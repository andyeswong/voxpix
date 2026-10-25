// Agua de superficie (aguas someras) por el método de las "tuberías virtuales" (Mei, Decaudin y Hu, 2007):
// cada celda tiene el alto del fondo (terreno) y la profundidad del agua; entre celdas vecinas hay un flujo que
// crece con la diferencia de altura de la superficie. Conserva la masa (el agua no se crea ni se pierde salvo
// que se añada o quite a propósito) y se lleva bien con una rejilla 2D grande: es lineal en celdas.
//
// Unidades: alturas en vóxeles, celdas de `cell` vóxeles de lado, tiempo en segundos.

export interface ShallowOptions {
  gravity?: number;      // vóxeles/s²
  damping?: number;      // 0..1 por segundo: cuánto se frena el flujo (más = se calma antes)
  cell?: number;         // vóxeles por celda
}

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

  constructor(w: number, h: number, opts: ShallowOptions = {}) {
    this.w = w; this.h = h;
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
    this.wakeAll();
  }

  // Despierta todas las celdas mojadas (al empezar o tras cambiar el agua a mano)
  wakeAll(): void {
    for (let i = 0; i < this.awake.length; i++) if (this.depth[i]! > 0) this.awake[i] = 60;
  }

  wake(cx: number, cy: number, radius: number): void {
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(this.h - 1, Math.ceil(cy + radius)); y++)
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.w - 1, Math.ceil(cx + radius)); x++) this.awake[y * this.w + x] = 90;
  }

  // Todo lo que define el estado del fluido (para snapshot, restore y hash). Las matrices de trabajo (active, list)
  // no cuentan: se rehacen en cada paso a partir de awake.
  exportState(): { depth: Float32Array; fl: Float32Array; fr: Float32Array; ft: Float32Array; fb: Float32Array; awake: Uint16Array } {
    return { depth: this.depth.slice(), fl: this.fl.slice(), fr: this.fr.slice(), ft: this.ft.slice(), fb: this.fb.slice(), awake: this.awake.slice() };
  }

  importState(s: ReturnType<ShallowWater['exportState']>): void {
    this.depth.set(s.depth); this.fl.set(s.fl); this.fr.set(s.fr); this.ft.set(s.ft); this.fb.set(s.fb); this.awake.set(s.awake);
  }

  // Las celdas que se calcularon en el último paso (las despiertas y sus vecinas)
  activeCells(): Int32Array { return this.list.subarray(0, this.count); }

  // Cuántas celdas se están calculando (para medir)
  get activeCount(): number { return this.count; }

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
    const { w, h, active, awake, list } = this;
    for (let k = 0; k < this.count; k++) active[list[k]!] = 0;
    let n = 0;
    const add = (j: number) => { if (!active[j]) { active[j] = 1; list[n++] = j; } };
    for (let i = 0; i < awake.length; i++) {
      if (!awake[i]) continue;
      const x = i % w, y = (i - x) / w;
      add(i);
      if (x > 0) add(i - 1);
      if (x < w - 1) add(i + 1);
      if (y > 0) add(i - w);
      if (y < h - 1) add(i + w);
    }
    this.count = n;
  }

  step(dt: number): void {
    const { w, h, depth, ground, solid, fl, fr, ft, fb, active } = this;
    const l = this.cell;
    const k = dt * this.g / l;                       // A*g/l con A = l² y el volumen dividido por l²
    const damp = Math.max(0, 1 - this.damping * dt);
    this.markActive();
    const { list, awake } = this;
    const n = this.count;
    // 1) flujos hacia las 4 vecinas según la diferencia de superficie
    for (let q = 0; q < n; q++) {
      const i = list[q]!;
      const x = i % w, y = (i - x) / w;
      // Solo las despiertas mandan agua; sus vecinas solo la reciben (así nunca sale agua hacia una celda que no se
      // va a actualizar en este paso, y la masa se conserva)
      if (solid[i] || !awake[i]) { fl[i] = fr[i] = ft[i] = fb[i] = 0; continue; }
      const s = ground[i]! + depth[i]!;
      let L = x > 0 && !solid[i - 1] ? Math.max(0, fl[i]! * damp + k * (s - ground[i - 1]! - depth[i - 1]!)) : 0;
      let R = x < w - 1 && !solid[i + 1] ? Math.max(0, fr[i]! * damp + k * (s - ground[i + 1]! - depth[i + 1]!)) : 0;
      let T = y > 0 && !solid[i - w] ? Math.max(0, ft[i]! * damp + k * (s - ground[i - w]! - depth[i - w]!)) : 0;
      let B = y < h - 1 && !solid[i + w] ? Math.max(0, fb[i]! * damp + k * (s - ground[i + w]! - depth[i + w]!)) : 0;
      // No puede salir más agua de la que hay
      const out = (L + R + T + B) * dt;
      if (out > depth[i]! && out > 0) { const sc = depth[i]! / out; L *= sc; R *= sc; T *= sc; B *= sc; }
      fl[i] = L; fr[i] = R; ft[i] = T; fb[i] = B;
    }
    // 2) profundidad: lo que entra de las vecinas menos lo que sale. Una celda que ya no se mueve se va durmiendo.
    for (let q = 0; q < n; q++) {
      const i = list[q]!;
      if (solid[i]) continue;
      const x = i % w, y = (i - x) / w;
      const inflow = (x > 0 ? fr[i - 1]! : 0) + (x < w - 1 ? fl[i + 1]! : 0) + (y > 0 ? fb[i - w]! : 0) + (y < h - 1 ? ft[i + w]! : 0);
      const outflow = fl[i]! + fr[i]! + ft[i]! + fb[i]!;
      const delta = dt * (inflow - outflow);
      depth[i] = Math.max(0, depth[i]! + delta);
      if (Math.abs(delta) > 2e-4 || outflow > 0.02) awake[i] = 60;
      else if (awake[i]! > 0) awake[i] = awake[i]! - 1;
    }
    // Las celdas dormidas no guardan flujo (si no, al despertar empujarían agua vieja)
    for (let q = 0; q < n; q++) { const i = list[q]!; if (!awake[i]) fl[i] = fr[i] = ft[i] = fb[i] = 0; }
  }

  // Empuja el agua desde (cx, cy) hacia fuera, sin crear ni perder: baja el centro y sube un anillo alrededor
  disturb(cx: number, cy: number, radius: number, amount: number): void {
    const { w, h, depth, solid } = this;
    const inner: number[] = [], ring: number[] = [];
    for (let y = Math.floor(cy - radius * 2); y <= Math.ceil(cy + radius * 2); y++) for (let x = Math.floor(cx - radius * 2); x <= Math.ceil(cx + radius * 2); x++) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
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

  // Inclinación de la superficie en una celda (para iluminarla): diferencias centradas
  slope(x: number, y: number): [number, number] {
    const { w, h } = this;
    const s = (xx: number, yy: number) => {
      const cx = Math.max(0, Math.min(w - 1, xx)), cy = Math.max(0, Math.min(h - 1, yy));
      const i = cy * w + cx;
      return this.solid[i] || this.depth[i]! <= 0.01 ? this.surface(y * w + x) : this.surface(i);
    };
    return [(s(x + 1, y) - s(x - 1, y)) / (2 * this.cell), (s(x, y + 1) - s(x, y - 1)) / (2 * this.cell)];
  }
}
