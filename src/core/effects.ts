// EFECTOS Y PARTÍCULAS (pedido de Andrés): puntos de 1 o 2 píxeles con velocidad, vida y una rampa de color, que
// salen de emisores descritos con datos (sin código). Lo mismo sirve para lo puramente visual (chispas, humo, polvo,
// lluvia: no toca el mundo ni su huella) y para lo que es de la simulación (va en la instantánea y la huella de quien
// lo use). Todo es determinista: el azar es el que se le da al sistema, y los topes descartan siempre lo mismo.
//
// Unidades: vóxeles y segundos, en los ejes del modelo (z hacia arriba). Los efectos ya hechos están en FX_PRESETS.
import { rgbOf } from './palette';

export type FxShape = 'point' | 'box' | 'disc';
export type FxCollide = 'none' | 'stop' | 'bounce' | 'die';

export interface EmitterSpec {
  shape?: FxShape;                               // de dónde salen: un punto (por defecto), una caja o un disco
  extent?: readonly [number, number, number];    // caja: medio ancho en x, y, z · disco: [radio, -, -]
  rate?: number;                                 // partículas por segundo mientras el emisor está encendido
  burst?: number;                                // cuántas salen de golpe al crear el emisor (y en burst())
  life: readonly [number, number];               // vida de cada una, en segundos (mín, máx)
  speed: readonly [number, number];              // rapidez al salir (mín, máx)
  dir?: readonly [number, number, number];       // hacia dónde salen (por defecto, arriba)
  spread?: number;                               // apertura del cono alrededor de dir, en grados (180: a todos lados)
  gravity?: number;                              // vóxeles/s² hacia abajo (negativo: sube, como el humo)
  drag?: number;                                 // frenado por segundo (0: nada)
  wind?: readonly [number, number, number];      // aceleración constante
  wobble?: number;                               // vaivén horizontal (nieve, hojas), en vóxeles/s
  colors: readonly string[];                     // la rampa a lo largo de la vida: el primero al nacer
  px?: 1 | 2;                                    // tamaño en pantalla
  // Luz: la partícula se ve con luz propia y, hasta el tope de luces, alumbra lo que tiene cerca
  light?: { radius: number; intensity?: number; color?: readonly [number, number, number] };
  collide?: FxCollide;                           // con los vóxeles que bloquean: atravesar, pararse, rebotar o morir
}

// Los efectos ya hechos. Generales: quien los usa decide cuándo y dónde.
export const FX_PRESETS = {
  chispas: { burst: 14, life: [0.25, 0.6], speed: [40, 90], spread: 70, gravity: 200, drag: 1, colors: ['#ffffff', '#ffe27a', '#ff9a3c', '#c8401e'], light: { radius: 10, intensity: 0.8, color: [1, 0.7, 0.3] }, collide: 'bounce' },
  humo: { rate: 10, life: [1.4, 2.4], speed: [4, 8], spread: 25, gravity: -6, drag: 0.6, wobble: 3, colors: ['#8a8794', '#6e6b78', '#55525e', '#3e3c46'], px: 2 },
  polvo: { burst: 10, shape: 'disc', extent: [2, 0, 0], life: [0.35, 0.7], speed: [8, 16], spread: 75, gravity: 40, drag: 2.5, colors: ['#b49a74', '#94795a', '#6e5a44'], collide: 'stop' },
  brasas: { rate: 7, life: [1, 2], speed: [6, 12], spread: 30, gravity: -10, drag: 0.4, wobble: 4, colors: ['#ffd36a', '#ff8a2a', '#d0461c', '#6a2a1a'], light: { radius: 6, intensity: 0.5, color: [1, 0.55, 0.22] } },
  lluvia: { rate: 160, shape: 'box', extent: [40, 40, 0], life: [1.5, 1.5], speed: [120, 140], dir: [0.12, 0.05, -1], spread: 2, colors: ['#9ab4d8', '#7a94bc'], collide: 'die' },
  nieve: { rate: 40, shape: 'box', extent: [40, 40, 0], life: [5, 7], speed: [5, 9], dir: [0, 0, -1], spread: 10, wobble: 5, colors: ['#ffffff', '#e4ecf6'], collide: 'stop' },
  hojas: { rate: 3, shape: 'box', extent: [10, 10, 0], life: [3, 5], speed: [3, 6], dir: [0, 0, -1], spread: 20, wobble: 8, colors: ['#6a9a3a', '#a8a43a', '#c4762e'], collide: 'stop' },
  burbujas: { rate: 6, shape: 'disc', extent: [2, 0, 0], life: [0.8, 1.4], speed: [6, 10], spread: 12, gravity: -4, wobble: 2, colors: ['#d8f2ff', '#9ad0f0'] },
} as const satisfies Record<string, EmitterSpec>;
export type FxPreset = keyof typeof FX_PRESETS;

export function fxSpec(s: EmitterSpec | FxPreset): EmitterSpec {
  if (typeof s !== 'string') return s;
  const p = FX_PRESETS[s];
  if (!p) throw new Error(`efecto desconocido: ${s} (hay ${Object.keys(FX_PRESETS).join(', ')})`);
  return p as EmitterSpec;
}

export interface FxOptions {
  maxAlive?: number;          // tope de partículas vivas: al llegar, las nuevas no nacen (siempre las mismas)
  maxLights?: number;         // tope de partículas que alumbran: las primeras vivas (en el orden del sistema)
}
export const FX_MAX_ALIVE = 2000;
export const FX_MAX_LIGHTS = 8;

// Un punto que pintar: posición, color, tamaño y si lleva luz propia
export const FX_STRIDE = 8;      // x, y, z, r, g, b, px, emisiva (en FxSystem.pack)

// Lo que pide un efecto para pintarse: lo da FxSystem y lo da una vista girada (con las posiciones en sus ejes)
export interface FxSource {
  readonly count: number;
  readonly packed: Float32Array;      // count * FX_STRIDE
}

interface Resolved {
  spec: EmitterSpec;
  rgb: Array<readonly [number, number, number]>;
  dir: [number, number, number];
  cosSpread: number;
}

interface Emitter { id: number; spec: number; x: number; y: number; z: number; on: boolean; acc: number }

const P = 10;     // por partícula: x, y, z, vx, vy, vz, edad, vida, spec, fase

export class FxSystem implements FxSource {
  readonly maxAlive: number;
  maxLights: number;
  private d: Float32Array;
  private n = 0;
  private specs: Resolved[] = [];
  private specIndex = new Map<EmitterSpec, number>();
  private emitters: Emitter[] = [];
  private nextId = 1;
  dropped = 0;                      // las que no nacieron por el tope (para medir)
  used = false;                     // alguna vez emitió (así quien lo hashea puede no hacerlo si nunca se usó)
  private buf = new Float32Array(0);
  private packedN = 0;
  private dirty = false;

  // `rand`: el azar (el del mundo para lo de la simulación; uno propio con semilla para lo visual)
  constructor(private readonly rand: () => number, o: FxOptions = {}) {
    this.maxAlive = Math.max(0, Math.floor(o.maxAlive ?? FX_MAX_ALIVE));
    this.maxLights = Math.max(0, Math.floor(o.maxLights ?? FX_MAX_LIGHTS));
    this.d = new Float32Array(this.maxAlive * P);
  }

  get alive(): number { return this.n; }
  get count(): number { if (this.dirty) this.pack(); return this.packedN; }
  get packed(): Float32Array { if (this.dirty) this.pack(); return this.buf; }

  // ---- emisores
  add(spec: EmitterSpec | FxPreset, x: number, y: number, z: number): number {
    const e: Emitter = { id: this.nextId++, spec: this.resolve(fxSpec(spec)), x, y, z, on: true, acc: 0 };
    this.emitters.push(e);
    const b = this.specs[e.spec]!.spec.burst ?? 0;
    for (let k = 0; k < b; k++) this.spawn(e.spec, x, y, z);
    return e.id;
  }
  move(id: number, x: number, y: number, z: number): void { const e = this.emitter(id); e.x = x; e.y = y; e.z = z; }
  setOn(id: number, on: boolean): void { this.emitter(id).on = on; }
  remove(id: number): void { this.emitters = this.emitters.filter((e) => e.id !== id); }
  get emitterCount(): number { return this.emitters.length; }
  list(): Array<{ id: number; x: number; y: number; z: number; on: boolean; spec: EmitterSpec }> {
    return this.emitters.map((e) => ({ id: e.id, x: e.x, y: e.y, z: e.z, on: e.on, spec: this.specs[e.spec]!.spec }));
  }
  // Una ráfaga sin emisor (un golpe, una muerte): `count` partículas, o las del burst del efecto
  burst(spec: EmitterSpec | FxPreset, x: number, y: number, z: number, count?: number): void {
    const s = this.resolve(fxSpec(spec));
    const c = count ?? this.specs[s]!.spec.burst ?? 8;
    for (let k = 0; k < c; k++) this.spawn(s, x, y, z);
  }
  clear(): void { this.n = 0; this.emitters = []; this.dirty = true; }

  private emitter(id: number): Emitter {
    const e = this.emitters.find((m) => m.id === id);
    if (!e) throw new Error(`no hay emisor ${id}`);
    return e;
  }

  private resolve(spec: EmitterSpec): number {
    const hit = this.specIndex.get(spec);
    if (hit !== undefined) return hit;
    if (!spec.colors?.length) throw new Error('un efecto necesita al menos un color');
    if (!(spec.life?.[1] > 0)) throw new Error('un efecto necesita vida (life: [mín, máx] en segundos)');
    const d = spec.dir ?? [0, 0, 1], len = Math.hypot(d[0], d[1], d[2]) || 1;
    const r: Resolved = {
      spec, rgb: spec.colors.map((c) => rgbOf(c)),
      dir: [d[0] / len, d[1] / len, d[2] / len],
      cosSpread: Math.cos((Math.min(180, Math.max(0, spec.spread ?? 30)) * Math.PI) / 180),
    };
    this.specs.push(r);
    this.specIndex.set(spec, this.specs.length - 1);
    return this.specs.length - 1;
  }

  private spawn(si: number, x: number, y: number, z: number): void {
    const R = this.specs[si]!, s = R.spec, rand = this.rand;
    this.used = true;
    // El azar se gasta igual nazca o no (así el tope no cambia lo que sale después)
    let ox = 0, oy = 0, oz = 0;
    const u1 = rand(), u2 = rand(), u3 = rand();
    if (s.shape === 'box') { const e = s.extent ?? [1, 1, 1]; ox = (u1 * 2 - 1) * e[0]; oy = (u2 * 2 - 1) * e[1]; oz = (u3 * 2 - 1) * e[2]; }
    else if (s.shape === 'disc') { const rr = (s.extent?.[0] ?? 1) * Math.sqrt(u1), a = u2 * Math.PI * 2; ox = Math.cos(a) * rr; oy = Math.sin(a) * rr; }
    // Una dirección uniforme dentro del cono: cos del ángulo entre 1 y cosSpread, y un giro alrededor de dir
    const ct = 1 - rand() * (1 - R.cosSpread), st = Math.sqrt(Math.max(0, 1 - ct * ct)), ph = rand() * Math.PI * 2;
    const sp = s.speed[0] + rand() * (s.speed[1] - s.speed[0]);
    const life = s.life[0] + rand() * (s.life[1] - s.life[0]);
    const phase = rand() * Math.PI * 2;
    if (this.n >= this.maxAlive) { this.dropped++; return; }
    const [dx, dy, dz] = R.dir;
    // Una base perpendicular a dir
    const ax = Math.abs(dz) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let px = dy * ax[2]! - dz * ax[1]!, py = dz * ax[0]! - dx * ax[2]!, pz = dx * ax[1]! - dy * ax[0]!;
    const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
    const qx = dy * pz - dz * py, qy = dz * px - dx * pz, qz = dx * py - dy * px;
    const c = Math.cos(ph) * st, sn = Math.sin(ph) * st;
    const vx = (dx * ct + px * c + qx * sn) * sp, vy = (dy * ct + py * c + qy * sn) * sp, vz = (dz * ct + pz * c + qz * sn) * sp;
    this.d.set([x + ox, y + oy, z + oz, vx, vy, vz, 0, life, si, phase], this.n++ * P);
    this.dirty = true;
  }

  // Avanza `dt` segundos. `solid`: lo que bloquea (para collide), en celdas de vóxel
  step(dt: number, solid?: (x: number, y: number, z: number) => boolean): void {
    // Los emisores encendidos: rate por segundo, con lo que sobra para el siguiente paso
    for (const e of this.emitters) {
      const rate = this.specs[e.spec]!.spec.rate ?? 0;
      if (!e.on || rate <= 0) continue;
      e.acc += rate * dt;
      while (e.acc >= 1) { e.acc -= 1; this.spawn(e.spec, e.x, e.y, e.z); }
    }
    const d = this.d;
    for (let k = 0; k < this.n; k++) {
      const o = k * P, s = this.specs[d[o + 8]!]!.spec;
      const age = d[o + 6]! + dt;
      d[o + 6] = age;
      if (age >= d[o + 7]!) { this.kill(k); k--; continue; }
      let vx = d[o + 3]!, vy = d[o + 4]!, vz = d[o + 5]!;
      const stopped = vx === 0 && vy === 0 && vz === 0 && s.collide === 'stop' && age > dt;
      if (stopped) continue;
      vz -= (s.gravity ?? 0) * dt;
      if (s.wind) { vx += s.wind[0] * dt; vy += s.wind[1] * dt; vz += s.wind[2] * dt; }
      if (s.drag) { const f = Math.max(0, 1 - s.drag * dt); vx *= f; vy *= f; vz *= f; }
      let wx = 0, wy = 0;
      if (s.wobble) { const ph = d[o + 9]!; wx = Math.cos(age * 2.7 + ph) * s.wobble; wy = Math.sin(age * 1.9 + ph * 1.3) * s.wobble * 0.6; }
      const x = d[o]!, y = d[o + 1]!, z = d[o + 2]!;
      let nx = x + (vx + wx) * dt, ny = y + (vy + wy) * dt, nz = z + vz * dt;
      const mode = s.collide ?? 'none';
      if (mode !== 'none' && solid && solid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        if (mode === 'die') { this.kill(k); k--; continue; }
        if (mode === 'stop') { nx = x; ny = y; nz = z; vx = vy = vz = 0; }
        else {
          // Rebote: el eje que choca se invierte (con pérdida); los demás siguen
          if (solid(Math.floor(nx), Math.floor(y), Math.floor(z))) { vx = -vx * 0.4; nx = x; }
          if (solid(Math.floor(x), Math.floor(ny), Math.floor(z))) { vy = -vy * 0.4; ny = y; }
          if (solid(Math.floor(x), Math.floor(y), Math.floor(nz))) { vz = -vz * 0.4; vx *= 0.7; vy *= 0.7; nz = z; }
          if (solid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) { nx = x; ny = y; nz = z; }
        }
      }
      d[o] = nx; d[o + 1] = ny; d[o + 2] = nz; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    }
    this.dirty = true;
  }

  // Quitar: la última ocupa su sitio (como las gotas)
  private kill(k: number): void {
    this.n--;
    if (k !== this.n) this.d.copyWithin(k * P, this.n * P, this.n * P + P);
    this.dirty = true;
  }

  // Lo que se pinta: posición, color de su edad, tamaño y luz propia (FX_STRIDE por partícula)
  private pack(): void {
    if (this.buf.length < this.n * FX_STRIDE) this.buf = new Float32Array(Math.max(256, this.n * 2) * FX_STRIDE);
    const d = this.d, out = this.buf;
    for (let k = 0; k < this.n; k++) {
      const o = k * P, q = k * FX_STRIDE, R = this.specs[d[o + 8]!]!;
      const t = d[o + 6]! / d[o + 7]!;
      const c = R.rgb[Math.min(R.rgb.length - 1, Math.floor(t * R.rgb.length))]!;
      out[q] = d[o]!; out[q + 1] = d[o + 1]!; out[q + 2] = d[o + 2]!;
      out[q + 3] = c[0]; out[q + 4] = c[1]; out[q + 5] = c[2];
      out[q + 6] = R.spec.px ?? 1; out[q + 7] = R.spec.light ? 1 : 0;
    }
    this.packedN = this.n;
    this.dirty = false;
  }

  // Las partículas que alumbran (como mucho maxLights: las primeras en el orden del sistema), con la intensidad que
  // les queda (se apagan al morir)
  lights(): Array<{ x: number; y: number; z: number; radius: number; intensity: number; color: readonly [number, number, number] }> {
    const out: ReturnType<FxSystem['lights']> = [];
    const d = this.d;
    for (let k = 0; k < this.n && out.length < this.maxLights; k++) {
      const o = k * P, l = this.specs[d[o + 8]!]!.spec.light;
      if (!l) continue;
      const left = 1 - d[o + 6]! / d[o + 7]!;
      out.push({ x: d[o]!, y: d[o + 1]!, z: d[o + 2]!, radius: l.radius, intensity: (l.intensity ?? 1) * left, color: l.color ?? [1, 0.8, 0.5] });
    }
    return out;
  }

  // ---- estado (para quien lo lleva en su instantánea y su huella): las partículas y los emisores. Las especificaciones
  // van por índice: quien restaura usa el mismo sistema (las mismas que ya vio).
  exportState(): FxState {
    return { data: this.d.slice(0, this.n * P), n: this.n, emitters: this.emitters.map((e) => ({ ...e })), nextId: this.nextId, used: this.used };
  }
  importState(s: FxState): void {
    this.d.fill(0); this.d.set(s.data); this.n = s.n;
    this.emitters = s.emitters.map((e) => ({ ...e })); this.nextId = s.nextId; this.used = s.used;
    this.dirty = true;
  }
}

export interface FxState {
  data: Float32Array; n: number;
  emitters: Array<{ id: number; spec: number; x: number; y: number; z: number; on: boolean; acc: number }>;
  nextId: number; used: boolean;
}

// mulberry32 con semilla: el azar propio de los efectos visuales (no gasta el del mundo)
export function fxRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
