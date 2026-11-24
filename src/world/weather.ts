// EL CLIMA: viento, lluvia, nieve, nubes y sol, como números deterministas. Todo sale de una semilla y del tick de la
// simulación, sin reloj ni azar suelto: la misma partida da el mismo clima en cualquier máquina. Aquí no se pinta nada:
// el que pinta lee estos números (Frame2DOptions.weather), y el que simula, si quiere, también.
//
// Los sitios van en coordenadas del MUNDO (vóxeles, x este, y norte). En una ventana que se corre, quien llama suma el
// origen de la ventana: así una ráfaga o la sombra de una nube no saltan al correrla.
//
// Es una parte de estado (StatePart). Si solo se usa para pintar, no hace falta meterlo en el mundo; si la simulación lo
// lee (el viento empuja algo, la lluvia apaga algo), state.addPart('weather', clima) lo lleva a la instantánea y la huella.
// docs/motor.md, "El clima".
import type { StatePart, StateHasher } from './state';
import { lattice } from '../worldgen/noise';

export interface WeatherLevels {
  wind: readonly [number, number];    // hacia dónde va, en el plano del mundo; su largo (0..1) es la fuerza
  gust: number;                       // 0..1: cuánto cambia la fuerza de un sitio a otro y con el tiempo
  rain: number;
  snow: number;
  clouds: number;                     // 0 despejado, 1 cubierto
  sun: number;                        // 0..1: la fuerza del sol (antes de las nubes)
}
export const CALM: WeatherLevels = { wind: [0, 0], gust: 0, rain: 0, snow: 0, clouds: 0, sun: 1 };

// Un programa: qué clima se pone en cada tick (contado desde que empieza) y en cuántos ticks se llega a él. Con period,
// se repite
export interface WeatherKey { at: number; ticks?: number; levels: Partial<WeatherLevels> }
export interface WeatherProgram { keys: readonly WeatherKey[]; period?: number }

export interface WeatherOptions {
  seed: number;
  levels?: Partial<WeatherLevels>;    // el clima de partida
  snowSeconds?: number;               // segundos de nieve a tope hasta cubrirlo todo (60)
  meltSeconds?: number;               // y en derretirse con sol a tope (90)
  wetSeconds?: number;                // de lluvia a tope hasta estar todo mojado (12)
  drySeconds?: number;                // y en secarse con sol a tope (40)
}

const TPS = 60;
export const WIND_SPEED = 90;                // vóxeles por segundo a los que viaja el aire con fuerza 1
export const CLOUD_SPEED = 0.35;             // y las nubes, esta fracción
const GUST_SIZE = 160, CLOUD_SIZE = 220;     // el lado de una ráfaga y el de una nube (vóxeles)
export const COVER_STEP = 30;                // cada cuántos ticks se actualiza lo acumulado (nieve, humedad)

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const ease = (u: number): number => u * u * (3 - 2 * u);
const easeSum = (u: number): number => u * u * u - (u * u * u * u) / 2;     // la integral de ease de 0 a u

// valueNoise (worldgen/noise.ts), con las cuatro esquinas de la última casilla guardadas: los mismos valores
function noiseReader(seed: number): (x: number, y: number) => number {
  let px = NaN, py = NaN, a = 0, b = 0, c = 0, d = 0;
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 !== px || y0 !== py) { px = x0; py = y0; a = lattice(x0, y0, seed); b = lattice(x0 + 1, y0, seed); c = lattice(x0, y0 + 1, seed); d = lattice(x0 + 1, y0 + 1, seed); }
    const fx = x - x0, fy = y - y0, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  };
}
// Suma a out el ruido (valueNoise) de n sitios en línea, por k
function addNoise(out: Float64Array, n: number, x: number, y: number, sx: number, sy: number, seed: number, k: number): void {
  let px = 0x7fffffff, py = 0x7fffffff, a = 0, b = 0, c = 0, d = 0;
  for (let i = 0; i < n; i++) {
    const ux = x + i * sx, uy = y + i * sy, x0 = Math.floor(ux), y0 = Math.floor(uy);
    if (x0 !== px || y0 !== py) { px = x0; py = y0; a = lattice(x0, y0, seed); b = lattice(x0 + 1, y0, seed); c = lattice(x0, y0 + 1, seed); d = lattice(x0 + 1, y0 + 1, seed); }
    const fx = ux - x0, fy = uy - y0, ex = fx * fx * (3 - 2 * fx), ey = fy * fy * (3 - 2 * fy);
    out[i] = out[i]! + k * ((a * (1 - ex) + b * ex) * (1 - ey) + (c * (1 - ex) + d * ex) * ey);
  }
}
function fill(base: WeatherLevels, p: Partial<WeatherLevels>): WeatherLevels {
  const w = p.wind ?? base.wind, l = Math.hypot(w[0], w[1]), k = l > 1 ? 1 / l : 1;
  const n = (v: number | undefined, d: number) => clamp01(v ?? d);
  const out: WeatherLevels = { wind: [w[0] * k, w[1] * k], gust: n(p.gust, base.gust), rain: n(p.rain, base.rain), snow: n(p.snow, base.snow), clouds: n(p.clouds, base.clouds), sun: n(p.sun, base.sun) };
  for (const v of [out.wind[0], out.wind[1], out.gust, out.rain, out.snow, out.clouds, out.sun]) if (!Number.isFinite(v)) throw new Error('el clima tiene un valor que no es un número');
  return out;
}

export interface WeatherState {
  from: WeatherLevels; to: WeatherLevels; t0: number; t1: number;
  drift: [number, number];
  snow: number; wet: number; step: number;
  program: WeatherProgram | null; programAt: number; next: number;
}

export class Weather implements StatePart {
  readonly seed: number;
  revision = 0;                              // sube cada vez que cambia el clima puesto: quien guarda algo de un tick lo mira
  private from: WeatherLevels;
  private to: WeatherLevels;
  private t0 = 0;
  private t1 = 0;
  private dx = 0;                            // lo andado por el aire hasta t0
  private dy = 0;
  private snowCover = 0;
  private wetness = 0;
  private stepN = 0;                         // pasos de lo acumulado ya hechos
  private program: WeatherProgram | null = null;
  private programAt = 0;
  private next = 0;
  private readonly rate: { snow: number; melt: number; wet: number; dry: number };

  constructor(o: WeatherOptions) {
    this.seed = o.seed | 0;
    this.from = this.to = fill(CALM, o.levels ?? {});
    const dt = COVER_STEP / TPS;
    this.rate = { snow: dt / (o.snowSeconds ?? 60), melt: dt / (o.meltSeconds ?? 90), wet: dt / (o.wetSeconds ?? 12), dry: dt / (o.drySeconds ?? 40) };
  }

  // Pasa a ese clima desde el del tick dicho, en `ticks` ticks (0: de golpe). Lo que no se dice se queda en el que había.
  // Las ráfagas y las nubes siguen donde estaban: solo cambia hacia dónde y cómo de deprisa van
  set(target: Partial<WeatherLevels>, tick: number, ticks = 600): void {
    this.advance(tick);                      // (lo acumulado y el programa, hasta aquí con el clima de antes)
    this.change(target, tick, ticks);
  }
  private change(target: Partial<WeatherLevels>, tick: number, ticks = 600): void {
    const now = this.levels(tick), [dx, dy] = this.drift(tick);
    this.from = now; this.to = fill(now, target);
    this.dx = dx; this.dy = dy;
    this.t0 = tick; this.t1 = tick + Math.max(0, ticks);
    this.revision++;
  }

  // Sigue un programa desde ese tick (null: deja el clima que haya). Lo aplica advance
  play(p: WeatherProgram | null, tick: number): void {
    if (p && !p.keys.length) throw new Error('el programa del clima está vacío');
    if (p) for (let i = 1; i < p.keys.length; i++) if (p.keys[i]!.at < p.keys[i - 1]!.at) throw new Error('las claves del programa del clima no van en orden');
    if (p?.period !== undefined && !(p.period > p.keys[p.keys.length - 1]!.at)) throw new Error('el periodo del programa del clima tiene que pasar de su última clave');
    this.program = p; this.programAt = tick; this.next = 0;
  }

  // Lleva el clima hasta ese tick: las claves del programa que tocan (cada una en SU tick) y lo acumulado. Da lo mismo
  // llamarlo en cada tick que de tarde en tarde
  advance(tick: number): void {
    for (let due = this.dueAt(); ; due = this.dueAt()) {
      const at = (this.stepN + 1) * COVER_STEP;
      if (due <= tick && due <= at) {
        const p = this.program!, k = p.keys[this.next % p.keys.length]!;
        this.next++;
        this.change(k.levels, due, k.ticks);
      } else if (at <= tick) { this.coverStep(at); this.stepN++; } else return;
    }
  }
  private dueAt(): number {
    const p = this.program;
    if (!p) return Infinity;
    const n = p.keys.length, lap = Math.floor(this.next / n);
    if (lap && p.period === undefined) return Infinity;
    return this.programAt + p.keys[this.next % n]!.at + lap * (p.period ?? 0);
  }
  private coverStep(tick: number): void {
    const l = this.levels(tick), r = this.rate, sun = l.sun * (1 - l.clouds);
    this.snowCover = clamp01(this.snowCover + l.snow * r.snow - (1 - l.snow) * (0.15 + 0.85 * Math.max(sun, l.rain)) * r.melt);
    this.wetness = clamp01(this.wetness + l.rain * r.wet - (1 - l.rain) * (0.25 + 0.75 * sun) * r.dry);
  }

  levels(tick: number): WeatherLevels {
    if (tick >= this.t1) return this.to;
    const k = ease(clamp01((tick - this.t0) / (this.t1 - this.t0))), a = this.from, b = this.to;
    const m = (p: number, q: number) => p + (q - p) * k;
    return { wind: [m(a.wind[0], b.wind[0]), m(a.wind[1], b.wind[1])], gust: m(a.gust, b.gust), rain: m(a.rain, b.rain), snow: m(a.snow, b.snow), clouds: m(a.clouds, b.clouds), sun: m(a.sun, b.sun) };
  }
  // Lo acumulado hasta el último advance: cuánta nieve hay en el suelo y cómo de mojado está (0..1)
  get cover(): { snow: number; wet: number } { return { snow: this.snowCover, wet: this.wetness }; }

  // Lo que ha andado el aire hasta ese tick (vóxeles): con él viajan las ráfagas y las nubes. Es la suma del viento, así
  // que cambiar de viento no hace saltar nada
  drift(tick: number): [number, number] {
    const n = Math.max(0, tick - this.t0), span = this.t1 - this.t0, v = WIND_SPEED / TPS, a = this.from.wind, b = this.to.wind;
    const move = (c: 0 | 1): number => {
      if (span <= 0) return b[c] * n;
      const u = Math.min(1, n / span);
      return span * (a[c] * u + (b[c] - a[c]) * easeSum(u)) + b[c] * Math.max(0, n - span);
    };
    return [this.dx + move(0) * v, this.dy + move(1) * v];
  }

  // La fuerza del viento en un sitio (0..1): la del clima con la ráfaga que pasa por ahí
  windAt(x: number, y: number, tick: number): number {
    return this.gustField(tick)(x, y);
  }
  // Lo mismo para muchos sitios del mismo tick
  // (los dos valores de ruido llevan su memoria de la última casilla: leídos seguidos por filas salen casi gratis)
  gustField(tick: number): (x: number, y: number) => number {
    const l = this.levels(tick), [dx, dy] = this.drift(tick), base = Math.hypot(l.wind[0], l.wind[1]), s = this.seed ^ 0x57a9;
    if (base <= 0) return () => 0;
    const n1 = noiseReader(s), n2 = noiseReader(s + 1);
    return (x, y) => clamp01(base * (1 + l.gust * 1.6 * (n1((x - dx) / GUST_SIZE, (y - dy) / GUST_SIZE) * 0.75 + n2((x - dx) / (GUST_SIZE / 4), (y - dy) / (GUST_SIZE / 4)) * 0.25 - 0.5)));
  }
  // Las dos cosas en n sitios en línea desde (x, y) de (sx, sy) en (sx, sy), sin crear nada por sitio: lo mismo, valor a valor
  fieldRow(tick: number, x: number, y: number, sx: number, sy: number, n: number, gustOut: Float64Array, cloudOut: Float64Array): void {
    const l = this.levels(tick), [dx, dy] = this.drift(tick), base = Math.hypot(l.wind[0], l.wind[1]), g = l.gust, c = l.clouds, cut = 1 - c, s1 = this.seed ^ 0x57a9, s2 = this.seed ^ 0x2c1d;
    if (base > 0) { gustOut.fill(0, 0, n); addNoise(gustOut, n, (x - dx) / GUST_SIZE, (y - dy) / GUST_SIZE, sx / GUST_SIZE, sy / GUST_SIZE, s1, 0.75); addNoise(gustOut, n, (x - dx) / (GUST_SIZE / 4), (y - dy) / (GUST_SIZE / 4), sx / (GUST_SIZE / 4), sy / (GUST_SIZE / 4), s1 + 1, 0.25); }
    for (let i = 0; i < n; i++) { const v = base > 0 ? base * (1 + g * 1.6 * (gustOut[i]! - 0.5)) : 0; gustOut[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
    if (c <= 0 || c >= 1) { cloudOut.fill(c <= 0 ? 0 : 1, 0, n); return; }
    const ox = dx * CLOUD_SPEED, oy = dy * CLOUD_SPEED;
    cloudOut.fill(0, 0, n);
    addNoise(cloudOut, n, (x - ox) / CLOUD_SIZE, (y - oy) / CLOUD_SIZE, sx / CLOUD_SIZE, sy / CLOUD_SIZE, s2, 0.7);
    addNoise(cloudOut, n, (x - ox) / (CLOUD_SIZE / 3), (y - oy) / (CLOUD_SIZE / 3), sx / (CLOUD_SIZE / 3), sy / (CLOUD_SIZE / 3), s2 + 1, 0.3);
    for (let i = 0; i < n; i++) { const v = (cloudOut[i]! - cut) / 0.12 + 0.5; cloudOut[i] = v < 0 ? 0 : v > 1 ? 1 : v; }
  }
  // Cuánto tapan las nubes el sol en un sitio (0 nada, 1 del todo): manchas que viajan con el viento
  cloudField(tick: number): (x: number, y: number) => number {
    const c = this.levels(tick).clouds, [dx, dy] = this.drift(tick), ox = dx * CLOUD_SPEED, oy = dy * CLOUD_SPEED, s = this.seed ^ 0x2c1d;
    if (c <= 0) return () => 0;
    if (c >= 1) return () => 1;
    // (el umbral baja al nublarse: a 0 no pasa ninguna y a 1, todo)
    const cut = 1 - c;
    const n1 = noiseReader(s), n2 = noiseReader(s + 1);
    return (x, y) => {
      const n = n1((x - ox) / CLOUD_SIZE, (y - oy) / CLOUD_SIZE) * 0.7 + n2((x - ox) / (CLOUD_SIZE / 3), (y - oy) / (CLOUD_SIZE / 3)) * 0.3;
      return clamp01((n - cut) / 0.12 + 0.5);
    };
  }
  cloudAt(x: number, y: number, tick: number): number { return this.cloudField(tick)(x, y); }

  // ---- parte del estado del mundo (opcional: WorldState.addPart)
  exportState(): WeatherState {
    return { from: this.from, to: this.to, t0: this.t0, t1: this.t1, drift: [this.dx, this.dy], snow: this.snowCover, wet: this.wetness, step: this.stepN, program: this.program, programAt: this.programAt, next: this.next };
  }
  importState(v: unknown): void {
    const s = v as WeatherState;
    this.from = s.from; this.to = s.to; this.t0 = s.t0; this.t1 = s.t1;
    [this.dx, this.dy] = s.drift;
    this.snowCover = s.snow; this.wetness = s.wet; this.stepN = s.step;
    this.revision++;
    this.program = s.program; this.programAt = s.programAt; this.next = s.next;
  }
  hashInto(h: StateHasher): void {
    for (const l of [this.from, this.to]) for (const v of [l.wind[0], l.wind[1], l.gust, l.rain, l.snow, l.clouds, l.sun]) h.num(v);
    for (const v of [this.seed, this.t0, this.t1, this.dx, this.dy, this.snowCover, this.wetness, this.stepN, this.programAt, this.next]) h.num(v);
    h.str(this.program ? JSON.stringify(this.program) : '');
  }
}
