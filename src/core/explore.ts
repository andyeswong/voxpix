// EXPLORAR (NARUTO, pedido de Andrés): caminar por dentro de un modelo, una escena o un mundo en primera persona, con
// un personaje invisible de la altura que se quiera. Aquí está la referencia en la CPU: el render con perspectiva por
// trazado de rayos en la rejilla de vóxeles (Amanatides-Woo), con la paleta cerrada como el render de siempre (el sol
// mueve el tono dentro de la rampa, con su sombra en unidades enteras de los materiales y la oclusión ambiental), y el
// caminante (colisión, gravedad, escalones). La GPU (src/view/gpu/voxrender.ts, firstPerson) hace lo mismo por píxel.
//
// Ejes como siempre: x este, y norte, z arriba. yaw en grados: 0 mira al norte (+y), 90 al este. pitch: + hacia arriba.
import { decode, rampOf, foliageSunDepth } from './palette';
import { DIR_VECTORS, finishRender, type Rendered } from './render';
import { materialsOf, SUN_UNIT, SUN_OPAQUE } from './materials';
import { key, type VoxelSource, type Bounds } from './model';

export interface FpCamera {
  x: number; y: number; z: number;   // el ojo
  yaw: number;                       // grados: 0 norte, 90 este
  pitch: number;                     // grados: + arriba (de -89 a 89)
  fov?: number;                      // campo de visión horizontal en grados (70 por defecto)
}

export interface FpOptions {
  width: number; height: number;
  sun?: readonly [number, number, number];   // hacia dónde está el sol (ejes del mundo); por defecto alto, del sureste
  shadows?: boolean;
  ao?: boolean;
  maxDist?: number;                  // hasta dónde llega la vista (vóxeles)
  outline?: 'none' | 'outer' | 'both';
  thresholds?: { lit: number; mid: number };
  bounds?: Bounds;                   // la caja del modelo (si no, se calcula)
}

export const FP_SUN: readonly [number, number, number] = [0.45, -0.55, 0.7];
export const FP_FOV = 70;
const FP_MAX_DIST = 192;

// La base de la cámara: hacia delante, derecha y arriba
export function fpBasis(cam: FpCamera): { f: [number, number, number]; r: [number, number, number]; u: [number, number, number] } {
  const y = (cam.yaw * Math.PI) / 180, p = (Math.max(-89, Math.min(89, cam.pitch)) * Math.PI) / 180;
  const f: [number, number, number] = [Math.sin(y) * Math.cos(p), Math.cos(y) * Math.cos(p), Math.sin(p)];
  const r: [number, number, number] = [Math.cos(y), -Math.sin(y), 0];
  const u: [number, number, number] = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

// El rayo del píxel (i, j) de una imagen W x H (centro del píxel)
export function fpRay(cam: FpCamera, W: number, H: number, i: number, j: number): [number, number, number] {
  const { f, r, u } = fpBasis(cam);
  const th = Math.tan(((cam.fov ?? FP_FOV) * Math.PI) / 360), tv = th * (H / W);
  const a = ((i + 0.5) / W) * 2 - 1, b = 1 - ((j + 0.5) / H) * 2;
  return [f[0] + r[0] * a * th + u[0] * b * tv, f[1] + r[1] * a * th + u[1] * b * tv, f[2] + r[2] * a * th + u[2] * b * tv];
}

export function boundsOf(model: VoxelSource): Bounds | null {
  let b: Bounds | null = null;
  for (const [x, y, z] of model.entries()) {
    if (!b) b = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
    else { b.minX = Math.min(b.minX, x); b.maxX = Math.max(b.maxX, x); b.minY = Math.min(b.minY, y); b.maxY = Math.max(b.maxY, y); b.minZ = Math.min(b.minZ, z); b.maxZ = Math.max(b.maxZ, z); }
  }
  return b;
}

// El primer vóxel lleno que cruza el rayo desde (ox, oy, oz) en la dirección d: su celda, la cara por la que entra
// (índice en DIR_VECTORS) y la distancia. null si sale de la caja o pasa de maxDist.
export function fpHit(model: VoxelSource, b: Bounds, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): { x: number; y: number; z: number; face: number; t: number; v: number } | null {
  const len = Math.hypot(dx, dy, dz);
  dx /= len; dy /= len; dz /= len;
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const ddx = sx ? Math.abs(1 / dx) : Infinity, ddy = sy ? Math.abs(1 / dy) : Infinity, ddz = sz ? Math.abs(1 / dz) : Infinity;
  let mx = sx ? (sx > 0 ? x + 1 - ox : ox - x) * ddx : Infinity;
  let my = sy ? (sy > 0 ? y + 1 - oy : oy - y) * ddy : Infinity;
  let mz = sz ? (sz > 0 ? z + 1 - oz : oz - z) * ddz : Infinity;
  // Si el ojo ya está dentro de un vóxel, no se ve ese (como estar pegado a la pared)
  let face = -1, t = 0;
  for (let k = 0; k < 4096; k++) {
    if (mx <= my && mx <= mz) { t = mx; x += sx; mx += ddx; face = sx > 0 ? 1 : 0; }
    else if (my <= mz) { t = my; y += sy; my += ddy; face = sy > 0 ? 3 : 2; }
    else { t = mz; z += sz; mz += ddz; face = sz > 0 ? 5 : 4; }
    if (t > maxDist) return null;
    // Fuera de la caja y alejándose: ya no hay nada
    if ((sx > 0 && x > b.maxX) || (sx < 0 && x < b.minX) || (sy > 0 && y > b.maxY) || (sy < 0 && y < b.minY) || (sz > 0 && z > b.maxZ) || (sz < 0 && z < b.minZ)) return null;
    const v = model.get(x, y, z);
    if (v) return { x, y, z, face, t, v };
  }
  return null;
}

// La imagen en primera persona: color (paleta cerrada), profundidad (distancia) y qué vóxel y cara hay en cada píxel
export function renderFirstPerson(model: VoxelSource, cam: FpCamera, o: FpOptions): Rendered {
  const { width: W, height: H } = o;
  const b = o.bounds ?? boundsOf(model);
  const color = new Int32Array(W * H).fill(-1), depth = new Float32Array(W * H).fill(Infinity);
  const pickKey = new Float64Array(W * H).fill(NaN), pickFace = new Int8Array(W * H).fill(-1);
  const opts = { width: W, height: H, originX: 0, originY: 0, outline: o.outline ?? 'none' } as const;
  if (!b) return finishRender(model.palette, opts, color, depth, pickKey, pickFace);
  const pal = model.palette, mt = materialsOf(pal);
  const th = o.thresholds ?? { lit: 0.72, mid: 0.3 };
  const sunL = Math.hypot(...(o.sun ?? FP_SUN));
  const L = (o.sun ?? FP_SUN).map((c) => c / sunL) as [number, number, number];
  const maxDist = o.maxDist ?? FP_MAX_DIST;
  const filled = (x: number, y: number, z: number) => model.get(x, y, z) !== 0;
  const cache = new Map<number, number>();
  // El tono de una cara: como toneFor de render.ts, con la normal de la cara (sin suavizar)
  const toneOf = (x: number, y: number, z: number, f: number, v: number): number => {
    const ck = key(x, y, z) * 8 + f;
    const hit = cache.get(ck);
    if (hit !== undefined) return hit;
    const n = DIR_VECTORS[f]!;
    let I = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
    if ((o.shadows ?? true) && inShadow(x + n[0], y + n[1], z + n[2])) I = Math.min(I, th.mid - 0.01);
    let level = I >= th.lit ? 1 : I >= th.mid ? 0 : -1;
    if (o.ao ?? true) {
      const [u, w] = PLANE[f]!;
      let occ = 0;
      for (let p = -1; p <= 1; p++) for (let q = -1; q <= 1; q++) {
        if (!p && !q) continue;
        if (filled(x + n[0] + p * u[0] + q * w[0], y + n[1] + p * u[1] + q * w[1], z + n[2] + p * u[2] + q * w[2])) occ++;
      }
      if (occ >= 5) level -= 1;
    }
    const { ramp, tone } = decode(v);
    const out = ramp * 16 + Math.max(0, Math.min(rampOf(pal, ramp).colors.length - 1, tone + level));
    cache.set(ck, out);
    return out;
  };
  // La sombra del sol: como inShadow de render.ts (lo que deja pasar luz gasta sus unidades)
  const inShadow = (cx: number, cy: number, cz: number): boolean => {
    const need = mt ? foliageSunDepth(cx, cy, cz) * SUN_UNIT : 0;
    let spent = 0, x = cx, y = cy, z = cz;
    const sx = Math.sign(L[0]), sy = Math.sign(L[1]), sz = Math.sign(L[2]);
    const tdx = sx ? Math.abs(1 / L[0]) : Infinity, tdy = sy ? Math.abs(1 / L[1]) : Infinity, tdz = sz ? Math.abs(1 / L[2]) : Infinity;
    let tx = tdx / 2, ty = tdy / 2, tz = tdz / 2;
    for (let i = 0; i < 128; i++) {
      if (tx <= ty && tx <= tz) { x += sx; tx += tdx; } else if (ty <= tz) { y += sy; ty += tdy; } else { z += sz; tz += tdz; }
      if ((sx > 0 && x > b.maxX) || (sx < 0 && x < b.minX) || (sy > 0 && y > b.maxY) || (sy < 0 && y < b.minY) || (sz > 0 && z > b.maxZ) || (sz < 0 && z < b.minZ)) return false;
      const v = model.get(x, y, z);
      if (v) {
        const c = mt ? mt.sun[v]! : SUN_OPAQUE;
        if (c === SUN_OPAQUE) return true;
        spent += c;
        if (spent >= need) return true;
      }
    }
    return false;
  };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const d = fpRay(cam, W, H, i, j);
    const h = fpHit(model, b, cam.x, cam.y, cam.z, d[0], d[1], d[2], maxDist);
    if (!h) continue;
    const p = j * W + i;
    color[p] = toneOf(h.x, h.y, h.z, h.face, h.v);
    depth[p] = h.t;
    pickKey[p] = key(h.x, h.y, h.z);
    pickFace[p] = h.face;
  }
  return finishRender(pal, opts, color, depth, pickKey, pickFace);
}

const PLANE: Array<[[number, number, number], [number, number, number]]> = [
  [[0, 1, 0], [0, 0, 1]], [[0, 1, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 0, 1]], [[1, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 1, 0]], [[1, 0, 0], [0, 1, 0]],
];

// ---- el caminante: un cuerpo invisible (una caja de radio x radio x altura) que anda, cae y sube escalones

export interface WalkInput {
  forward: number;      // -1..1 (hacia donde mira)
  strafe: number;       // -1..1 (derecha +)
  jump?: boolean;
  fly?: boolean;        // sin gravedad: sube con jump, baja con down
  down?: boolean;
  run?: boolean;
}

export class Walker {
  x: number; y: number; z: number;     // los pies (centro de la base)
  vz = 0;
  yaw = 0; pitch = 0;
  onGround = false;
  height: number;
  radius: number;
  speed: number;                        // vóxeles por segundo
  stepUp = 1;                           // sube escalones de hasta esto sin saltar
  gravity = 40;
  constructor(x: number, y: number, z: number, opts: { height?: number; radius?: number; speed?: number } = {}) {
    this.x = x; this.y = y; this.z = z;
    this.height = opts.height ?? 1;
    this.radius = opts.radius ?? Math.min(0.3, this.height * 0.3);
    this.speed = opts.speed ?? 4 + this.height * 1.5;
  }

  // El ojo: un poco por debajo de la coronilla
  eye(): FpCamera { return { x: this.x, y: this.y, z: this.z + this.height * 0.9, yaw: this.yaw, pitch: this.pitch }; }

  // ¿La caja del cuerpo, con los pies en (x, y, z), toca algo que bloquea?
  collides(solid: (x: number, y: number, z: number) => boolean, x: number, y: number, z: number): boolean {
    const r = this.radius, e = 1e-4;
    for (let cz = Math.floor(z + e); cz <= Math.floor(z + this.height - e); cz++)
      for (let cy = Math.floor(y - r + e); cy <= Math.floor(y + r - e); cy++)
        for (let cx = Math.floor(x - r + e); cx <= Math.floor(x + r - e); cx++) if (solid(cx, cy, cz)) return true;
    return false;
  }

  step(dt: number, input: WalkInput, solid: (x: number, y: number, z: number) => boolean): void {
    const yr = (this.yaw * Math.PI) / 180;
    const fx = Math.sin(yr), fy = Math.cos(yr), rx = Math.cos(yr), ry = -Math.sin(yr);
    let mx = input.forward * fx + input.strafe * rx, my = input.forward * fy + input.strafe * ry;
    const ml = Math.hypot(mx, my);
    if (ml > 1) { mx /= ml; my /= ml; }
    const sp = this.speed * (input.run ? 2 : 1) * dt;
    // Horizontal, eje por eje; si choca y sobre el escalón cabe, sube
    for (const [ax, ay] of [[mx * sp, 0], [0, my * sp]] as const) {
      if (!ax && !ay) continue;
      const nx = this.x + ax, ny = this.y + ay;
      if (!this.collides(solid, nx, ny, this.z)) { this.x = nx; this.y = ny; continue; }
      if ((this.onGround || input.fly) && !this.collides(solid, nx, ny, this.z + this.stepUp)) {
        // subir: a la altura justa del escalón
        let up = this.z + this.stepUp;
        while (up - 0.25 >= this.z && !this.collides(solid, nx, ny, Math.floor(up - 0.25 + 1e-4))) up = Math.floor(up - 0.25 + 1e-4);
        this.x = nx; this.y = ny; this.z = Math.max(this.z, Math.ceil(up - 1e-4));
      }
    }
    // Vertical
    if (input.fly) {
      this.vz = 0;
      const dz = ((input.jump ? 1 : 0) - (input.down ? 1 : 0)) * sp;
      if (dz && !this.collides(solid, this.x, this.y, this.z + dz)) this.z += dz;
      this.onGround = this.collides(solid, this.x, this.y, this.z - 0.01);
      return;
    }
    if (this.onGround && input.jump) this.vz = Math.sqrt(2 * this.gravity * Math.max(1.2, this.height * 1.1));
    this.vz -= this.gravity * dt;
    const dz = this.vz * dt;
    if (!this.collides(solid, this.x, this.y, this.z + dz)) { this.z += dz; this.onGround = false; }
    else {
      if (dz < 0) { this.z = Math.ceil(this.z + dz - 1e-4); while (this.collides(solid, this.x, this.y, this.z)) this.z += 1; this.onGround = true; }
      this.vz = 0;
    }
  }
}
