// Fluido en VOLUMEN sobre una rejilla de vóxeles (autómata de masa, como los fluidos de juegos de vóxeles): cada
// celda tiene una masa de agua (1 = llena; un poco más abajo, comprimida, para que el agua pueda subir por vasos
// comunicantes). En cada paso el agua cae, se reparte con las 4 vecinas y, si está comprimida, sube. Conserva la
// masa. Las celdas sólidas (los vóxeles del modelo) no dejan pasar el agua.

const MAX = 1;            // masa de una celda llena
const COMPRESS = 0.02;    // cuánto más puede guardar la celda de abajo por cada celda de agua encima
const SPEED = 1;          // masa máxima que se mueve de una celda a otra en un paso
// Tensión superficial: una celda con esta masa o menos ya no se reparte hacia los lados. Sin esto, el agua sobre
// un suelo plano se extiende en una película infinitamente fina e invisible; con esto forma un charco.
const SPREAD_MIN = 0.5;

// Cuánta masa debe quedar abajo si dos celdas apiladas tienen `total` entre las dos
function stable(total: number): number {
  if (total <= MAX) return MAX;
  if (total < 2 * MAX + COMPRESS) return (MAX * MAX + total * COMPRESS) / (MAX + COMPRESS);
  return (total + COMPRESS) / 2;
}

export class VoxelFluid {
  readonly mass: Float32Array;
  readonly solid: Uint8Array;
  private next: Float32Array;

  // Rejilla de w x d x h celdas cuyo vóxel (0,0,0) es (x0, y0, z0) del modelo
  constructor(readonly x0: number, readonly y0: number, readonly z0: number, readonly w: number, readonly d: number, readonly h: number) {
    const n = w * d * h;
    this.mass = new Float32Array(n);
    this.next = new Float32Array(n);
    this.solid = new Uint8Array(n);
  }

  index(x: number, y: number, z: number): number {
    const lx = x - this.x0, ly = y - this.y0, lz = z - this.z0;
    if (lx < 0 || ly < 0 || lz < 0 || lx >= this.w || ly >= this.d || lz >= this.h) return -1;
    return (lz * this.d + ly) * this.w + lx;
  }

  add(x: number, y: number, z: number, amount: number): void {
    const i = this.index(x, y, z);
    if (i >= 0 && !this.solid[i]) this.mass[i] = this.mass[i]! + amount;
  }

  total(): number {
    let t = 0;
    for (let i = 0; i < this.mass.length; i++) t += this.mass[i]!;
    return t;
  }

  // Un paso del autómata. Devuelve cuánta masa se movió (0 = en reposo).
  step(): number {
    const { w, d, h, mass, solid } = this;
    const next = this.next;
    next.set(mass);
    let moved = 0;
    const WD = w * d;
    for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
      const i = (z * d + y) * w + x;
      if (solid[i]) continue;
      let remaining = mass[i]!;
      if (remaining <= 0) continue;
      const move = (j: number, flow: number) => {
        if (flow <= 0) return;
        if (flow > remaining) flow = remaining;
        next[i] = next[i]! - flow; next[j] = next[j]! + flow;
        remaining -= flow; moved += flow;
      };
      // 1) cae
      if (z > 0 && !solid[i - WD]) {
        const j = i - WD;
        let flow = stable(remaining + mass[j]!) - mass[j]!;
        if (flow > 0.1) flow *= 0.5;                       // suaviza la caída
        move(j, Math.min(SPEED, Math.max(0, flow)));
        if (remaining <= 0) continue;
      }
      // 2) se reparte con las vecinas del mismo nivel
      const sides: number[] = [];
      if (x > 0) sides.push(i - 1);
      if (x < w - 1) sides.push(i + 1);
      if (y > 0) sides.push(i - w);
      if (y < d - 1) sides.push(i + w);
      for (const j of sides) {
        if (solid[j] || remaining <= SPREAD_MIN) continue;
        let flow = Math.min((mass[i]! - mass[j]!) / 5, remaining - SPREAD_MIN);
        if (flow > 0.1) flow *= 0.5;
        move(j, Math.min(SPEED, Math.max(0, flow)));
        if (remaining <= 0) break;
      }
      if (remaining <= 0) continue;
      // 3) sube si está comprimida
      if (z < h - 1 && !solid[i + WD]) {
        const j = i + WD;
        let flow = remaining - stable(remaining + mass[j]!);
        if (flow > 0.1) flow *= 0.5;
        move(j, Math.min(SPEED, Math.max(0, flow)));
      }
    }
    mass.set(next);
    return moved;
  }

  // Celdas con agua suficiente para dibujarse como vóxel
  *wet(threshold = 0.35): Generator<[number, number, number, number]> {
    const { w, d, h, mass } = this;
    for (let z = 0; z < h; z++) for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) {
      const m = mass[(z * d + y) * w + x]!;
      if (m >= threshold) yield [x + this.x0, y + this.y0, z + this.z0, m];
    }
  }
}
