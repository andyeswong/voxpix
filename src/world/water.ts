// El agua del escenario como FLUIDO: un simulador de superficie (ShallowWater) sobre las cuencas del mundo de
// vóxeles, dibujado cada cuadro encima del mundo horneado con la misma cámara, y lo que hace la luz con ella:
//   - reflejo: el rayo reflejado se busca hacia arriba en la profundidad de lo ya dibujado (en esta proyección
//     se queda en la misma columna de pantalla); las ondas lo deforman;
//   - brillo especular de cada fuente según la normal de la superficie (punto en agua quieta, destellos con ondas);
//   - cáusticas: el fondo que se ve a través del agua recibe la luz que las ondas enfocan;
//   - refracción: el fondo se ve desplazado según la inclinación de la superficie.
import { ShallowWater } from '../fluid/shallow';
import { rgbOf, spotFactor } from '../core';
import { resolveLight } from './lightutil';
import type { World, WorldLight } from './build';
import type { Baked } from './bake';
import { worldPalette, M } from './build';

const CELL = 2;                                   // vóxeles por celda del simulador
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const REFLECT = 0.38;                             // cuánto del reflejo se ve (de arriba, el agua refleja poco)
const MARCH = 40;                                 // píxeles que sube como mucho el rayo reflejado (de 2 en 2, y afina al dar con algo)

export class WaterLayer {
  readonly sim: ShallowWater;
  readonly gw: number;
  readonly gh: number;
  private tones: Array<[number, number, number]>;
  private basin: Uint8Array;                      // 1 = celda de cuenca (si no, suelo seco: el agua se empapa)
  private fountainIn: number[] = [];              // celdas donde cae el agua del cuenco
  private fountainOut: number[] = [];             // desagüe

  // Rejilla de celdas de CELL x CELL vóxeles en ejes del modelo: la celda (gx, gy) cubre x en [gx*CELL, gx*CELL+CELL)
  // e y en [gy*CELL, gy*CELL+CELL) (gy crece hacia el norte). El fondo de cada celda sale de la rejilla de alturas
  // de los vóxeles del mundo; lo que sube más de WALL_Z (paredes, columnas, el fuste) o no tiene suelo, no deja pasar el agua.
  constructor(private world: World, theme: Parameters<typeof worldPalette>[0]) {
    this.gw = Math.ceil(world.width / CELL);
    this.gh = Math.ceil(world.depth / CELL);
    this.sim = new ShallowWater(this.gw, this.gh, { cell: CELL, damping: 0.9 });
    this.basin = new Uint8Array(this.gw * this.gh);
    const { wet, waterTop, width: W } = world;
    const height = world.model.height, zMin = world.model.zMin;
    const WALL_Z = 8;
    for (let gy = 0; gy < this.gh; gy++) for (let gx = 0; gx < this.gw; gx++) {
      const i = gy * this.gw + gx;
      // El fondo de la celda: el más alto de sus vóxeles (así el agua no se cuela por un borde)
      let g = -128, top = -128, anyWet = false, hole = false;
      for (let dy = 0; dy < CELL; dy++) for (let dx = 0; dx < CELL; dx++) {
        const x = gx * CELL + dx, y = gy * CELL + dy;
        if (x >= W || y >= world.depth) continue;
        const j = y * W + x;
        if (height[j]! <= zMin) hole = true;
        g = Math.max(g, height[j]!);
        if (wet[j]) { anyWet = true; top = Math.max(top, waterTop[j]!); }
      }
      this.sim.ground[i] = g;
      if (hole || g > WALL_Z) this.sim.solid[i] = 1;
      else if (anyWet) { this.basin[i] = 1; if (top > g) this.sim.depth[i] = top - g; }
    }
    this.sim.wakeAll();
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
    this.tones = worldPalette(theme).ramps[M.water]!.colors.map(rgbOf);
  }

  private cellOf(x: number, y: number): number {
    const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
    return gx < 0 || gy < 0 || gx >= this.gw || gy >= this.gh ? -1 : gy * this.gw + gx;
  }

  // Los 5 tonos del agua (RGB) y si una celda es de cuenca (para quien la dibuja por su cuenta, como la GPU)
  get toneColors(): ReadonlyArray<readonly [number, number, number]> { return this.tones; }
  isBasin(i: number): boolean { return this.basin[i] === 1; }

  // Todo en ejes del modelo (x este, y norte)
  depthAt(x: number, y: number): number { const i = this.cellOf(x, y); return i < 0 ? 0 : this.sim.depth[i]!; }
  surfaceAt(x: number, y: number): number { const i = this.cellOf(x, y); return i < 0 ? 0 : this.sim.surface(i); }

  // Algo que se mueve dentro del agua la empuja (ondas). Con fuerza, el agua salta el borde y moja el suelo.
  disturb(x: number, y: number, amount: number, radius = 1.5): void {
    this.sim.disturb(x / CELL, y / CELL, radius, amount);
  }

  // Añade agua en un punto (las gotas que caen)
  pour(x: number, y: number, amount: number): void {
    const i = this.cellOf(x, y);
    if (i < 0 || this.sim.solid[i]) return;
    this.sim.depth[i] = this.sim.depth[i]! + amount;
    this.sim.wake(i % this.gw, Math.floor(i / this.gw), 3);
  }

  // Centros (ejes del modelo) de las celdas donde cae el agua del cuenco de la fuente
  fountainLanding(k: number): [number, number] | null {
    if (!this.fountainIn.length) return null;
    const i = this.fountainIn[k % this.fountainIn.length]!;
    return [(i % this.gw) * CELL + 1, Math.floor(i / this.gw) * CELL + 1];
  }

  // Un paso de simulación de `dt` (el mundo lo llama con 1/60 fijo): exactamente round(dt * 120) subpasos de 1/120,
  // sin acumular tiempo, así la misma partida da siempre el mismo agua
  step(dt: number): void {
    const { sim, basin } = this;
    const f = this.world.fountain;
    for (let n = Math.max(1, Math.round(dt * 120)); n > 0; n--) {
      // Fuente: el desagüe saca lo que sobra por encima de su nivel (lo que cae lo añaden las gotas con pour)
      if (f) for (const i of this.fountainOut) {
        const over = sim.surface(i) - f.level;
        if (over > 0) sim.depth[i] = Math.max(0, sim.depth[i]! - over * 0.3);
      }
      sim.step(1 / 120);
    }
    // El agua que salta al suelo seco se empapa poco a poco
    const soak = Math.min(dt, 0.05) * 0.3;
    for (let i = 0; i < basin.length; i++) if (!basin[i] && sim.depth[i]! > 0) sim.depth[i] = sim.depth[i]! < 0.03 ? 0 : sim.depth[i]! - soak * Math.max(0.25, sim.depth[i]!);
  }

  // Dibuja el agua en la vista (vx, vy, vw, vh de la imagen horneada). `view` y `depthBuf` tienen lo ya dibujado
  // (mundo + personajes); `total` (opcional) es la luz por píxel de la vista, que aquí se completa.
  // `worldLights`: todas las luces del mundo (fijas y dinámicas)
  draw(b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null, vx: number, vy: number, vw: number, vh: number,
    ambient: readonly [number, number, number], time: number, worldLights: readonly WorldLight[], reflect = true): void {
    const { sim, gw, gh, world } = this;
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
    const white = this.tones[4]!;
    // Altura de la superficie de una vecina (los bordes secos o sólidos cuentan como la propia celda)
    const sAt = (j: number, own: number) => (sim.solid[j] || sim.depth[j]! <= 0.01 ? own : sim.ground[j]! + sim.depth[j]!);

    const gx0 = Math.max(0, Math.floor(vx / CELL) - 1), gx1 = Math.min(gw - 1, Math.ceil((vx + vw) / CELL) + 1);
    // Filas de celdas que pueden caer en la vista (la superficie va de z = -12 a 12)
    const yOf = (sy: number, z: number) => (originY - sy - z) / a;
    const gy0 = Math.max(0, Math.floor(yOf(vy + vh, -12) / CELL) - 2), gy1 = Math.min(gh - 1, Math.ceil(yOf(vy, 12) / CELL) + 2);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const i = gy * gw + gx;
      const d = sim.depth[i]!;
      if (sim.solid[i] || d < 0.04) continue;
      const zs = sim.ground[i]! + d;
      const north = gy * CELL + CELL, south = gy * CELL;
      const sy0 = Math.round(originY - a * north - zs), sy1 = Math.max(sy0 + 1, Math.round(originY - a * south - zs));
      const ymid = (north + south) / 2;
      const depthHere = ymid * f1 + zs * f2;
      // Normal y curvatura de la superficie
      const sE = gx < gw - 1 ? sAt(i + 1, zs) : zs, sW = gx > 0 ? sAt(i - 1, zs) : zs;
      const sN = gy < gh - 1 ? sAt(i + gw, zs) : zs, sS = gy > 0 ? sAt(i - gw, zs) : zs;
      const sx = (sE - sW) / (2 * CELL), sy = (sN - sS) / (2 * CELL);
      const lap = (sE + sW + sS + sN - 4 * zs) / (CELL * CELL);
      const nx = -sx, ny = -sy, nz = 1, nl = Math.hypot(nx, ny, nz);
      const key = (nx * -0.5 + ny * 0.5 + nz * 0.7) / nl - 0.7;
      let tone = d > 4.5 ? 2 : 3;
      if (key > 0.04) tone += 1; else if (key < -0.04) tone -= 1;
      const steep = Math.hypot(sx, sy);
      if (steep > 0.45) tone = 4;                                         // espuma en las crestas
      if (d < 0.6 && !this.basin[i]) tone = 3;                            // suelo mojado: una película clara
      tone = Math.max(0, Math.min(4, tone));
      const tc = this.tones[tone]!, r = tc[0], g = tc[1], bl = tc[2];
      // Opaca donde es honda; la trama (transparencia) solo en la orilla y en el suelo mojado
      const alpha = !this.basin[i] ? Math.min(0.6, d) : d >= 1.5 ? 1 : Math.min(1, 0.45 + d * 0.35 + (tone === 4 ? 0.4 : 0));
      // Luz difusa en la superficie, su brillo especular, y la que atraviesa hasta el fondo (cáusticas)
      let lr = ambient[0] * 1.25, lg = ambient[1] * 1.25, lb = ambient[2] * 1.3, spec = 0, sr = 0, sg = 0, sb = 0;
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
          const o = t * 4, q = t * 3;
          if (BAYER[(px & 3) + ((sy & 3) << 2)]! / 16 >= alpha) {
            // Se ve el fondo a través del agua: refractado, algo azulado y con las cáusticas
            const t2 = ty * vw + Math.max(0, Math.min(vw - 1, tx + shift));
            view[o] = srcView[t2 * 4]! * 0.85; view[o + 1] = srcView[t2 * 4 + 1]! * 0.92; view[o + 2] = Math.min(255, srcView[t2 * 4 + 2]! * 1.05);
            if (total && srcTotal) for (let c = 0; c < 3; c++) total[q + c] = ambient[c]! + (srcTotal[t2 * 3 + c]! - ambient[c]!) * caustic;
            continue;
          }
          // Superficie: su color, el reflejo de lo que tiene encima y el brillo de las fuentes
          let cr = r, cg = g, cb = bl, ltr = lr + sr, ltg = lg + sg, ltb = lb + sb;
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
              const m = REFLECT * (tone === 4 ? 0.3 : 1);
              cr += (srcView[rt * 4]! - cr) * m; cg += (srcView[rt * 4 + 1]! - cg) * m; cb += (srcView[rt * 4 + 2]! - cb) * m;
              if (srcTotal) { ltr += (srcTotal[rt * 3]! - ltr) * m; ltg += (srcTotal[rt * 3 + 1]! - ltg) * m; ltb += (srcTotal[rt * 3 + 2]! - ltb) * m; }
              break;
            }
          }
          if (spec > 0.35) { cr = white[0]; cg = white[1]; cb = white[2]; }
          view[o] = cr; view[o + 1] = cg; view[o + 2] = cb;
          depthBuf[t] = depthHere;
          if (total) { total[q] = ltr; total[q + 1] = ltg; total[q + 2] = ltb; }
        }
      }
    }
  }
}
