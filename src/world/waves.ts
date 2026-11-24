// El rizado del agua con el clima: las ondas del viento (van con él y crecen con la ráfaga que pasa) y los anillos de la lluvia.
// Solo inclinan la superficie al pintarla (drawWater y FRAG_WATER): el simulador no se entera. Es una baldosa de WAVE_T x WAVE_T
// celdas de agua que se repite, fija en el mundo, calculada en la CPU 12 veces por segundo y leída igual por la CPU y la GPU.
import { hash30, HASH_ONE } from '../worldgen/noise';
import type { Baked } from './bake';
import type { Weather } from './weather';
import { climateStepTicks, viewOffset, type ClimateTable, type WeatherFrame } from './climate';

export const WAVE_T = 64;
export const WAVE_CELL = 2;                     // vóxeles por celda de agua (WATER_CELL)
const AMP = 0.2, RING = 0.3, Q = 1024;         // (los valores, en 1 / Q: exactos en float32)
const RINGS = 70;                               // anillos a la vez en una baldosa con lluvia a tope
const RING_S = 0.9, RING_R = 5;                 // lo que dura uno (segundos) y hasta dónde llega (celdas)

// data: por celda, la inclinación (x, y) del viento a fuerza 1 y la de los anillos. kx, ky: lo que se suma a la celda de la vista
export interface WaveTile { data: Float32Array; kx: number; ky: number; climate: ClimateTable }

// Los datos de una baldosa, y la baldosa a medias: un tren de ondas o los anillos por paso (run)
interface Want { weather: Weather; rev: number; tick: number; amount: number; dx: number; dy: number; rain: number }
const same = (a: Want, b: Want): boolean => a.weather === b.weather && a.rev === b.rev && a.tick === b.tick && a.amount === b.amount && a.dx === b.dx && a.dy === b.dy && a.rain === b.rain;
class Building {
  readonly data = new Float32Array(WAVE_T * WAVE_T * 4);
  private step = 0;
  constructor(readonly want: Want) {}
  run(steps: number): void {
    const { weather, tick, amount, dx, dy, rain } = this.want;
    for (; steps > 0 && this.step < 4; steps--, this.step++) {
      if (this.step < 3) { if (dx || dy) windWave(this.data, WAVES[this.step]!, dx, dy, tick, amount); } else if (rain > 0) rainRings(this.data, weather.seed, tick, rain, amount);
    }
  }
}
// (en otro tick que la tabla del clima, para no hacer las dos cosas en el mismo cuadro)
const waveStep = (f: WeatherFrame): number => { const n = climateStepTicks(f), k = n >> 1; return Math.floor((f.tick + k) / n) * n - k; };
function wantOf(f: WeatherFrame, tick: number): Want | null {
  const amount = Math.max(0, Math.min(1, f.waves ?? 0));
  if (amount <= 0) return null;
  const l = f.weather.levels(tick), len = Math.hypot(l.wind[0], l.wind[1]);
  if (len <= 0 && l.rain <= 0) return null;
  const [dx, dy] = len <= 0 ? [0, 0] : f.camera ? f.camera.dirToView(l.wind[0] / len, l.wind[1] / len) : [l.wind[0] / len, l.wind[1] / len];
  return { weather: f.weather, rev: f.weather.revision, tick, amount, dx, dy, rain: l.rain };
}
const cache = new WeakMap<Baked, { want: Want; data: Float32Array; next: Building | null }>();
export function waveTile(b: Baked, f: WeatherFrame | null | undefined, c: ClimateTable | null): WaveTile | null {
  const want = f && c ? wantOf(f, waveStep(f)) : null;
  if (!want) return null;
  let hit = cache.get(b);
  if (!hit || !same(hit.want, want)) {
    const build = hit?.next && same(hit.next.want, want) ? hit.next : new Building(want);
    build.run(4);
    cache.set(b, (hit = { want, data: build.data, next: null }));
  }
  const [Kx, Ky] = viewOffset(f!), mod = (v: number) => ((Math.floor(v / WAVE_CELL) % WAVE_T) + WAVE_T) % WAVE_T;
  return { data: hit.data, kx: mod(Kx), ky: mod(Ky), climate: c! };
}
// Adelanta la baldosa del paso siguiente (como climateAhead)
export function waveAhead(b: Baked, f: WeatherFrame | null | undefined): void {
  const hit = f && cache.get(b), want = hit ? wantOf(f, waveStep(f) + climateStepTicks(f)) : null;
  if (!hit || !want) return;
  if (!hit.next || !same(hit.next.want, want)) hit.next = new Building(want);
  hit.next.run(1);
}

// Tres trenes de ondas con vueltas enteras en la baldosa (así casa consigo misma): el del viento y dos a sus lados
const WAVES = [[0, 6, 0.5, 0.9], [0.55, 9, 0.3, 1.2], [-0.7, 11, 0.2, 1.5]] as const;
function windWave(out: Float32Array, [turn, n, amp, hz]: (typeof WAVES)[number], dx: number, dy: number, tick: number, amount: number): void {
  const sec = tick / 60, T = WAVE_T;
  {
    const ux = dx * Math.cos(turn) - dy * Math.sin(turn), uy = dx * Math.sin(turn) + dy * Math.cos(turn);
    const kx = Math.round(ux * n), ky = Math.round(uy * n), kl = Math.hypot(kx, ky) || 1;
    const wx = new Float32Array(T), wy = new Float32Array(T);
    for (let i = 0; i < T; i++) {
      const s = Math.cos(2 * Math.PI * (i / T - sec * hz)) * amp * AMP * 1.4 * amount;
      wx[i] = Math.round(s * kx / kl * Q) / Q; wy[i] = Math.round(s * ky / kl * Q) / Q;
    }
    for (let y = 0, o = 0; y < T; y++) for (let x = 0, i = (ky * y) & (T - 1); x < T; x++, o += 4, i = (i + kx) & (T - 1)) { out[o] = out[o]! + wx[i]!; out[o + 1] = out[o + 1]! + wy[i]!; }
  }
}
// Los anillos: cada uno nace en un sitio de la baldosa, crece y se apaga, y vuelve a nacer en otro
function rainRings(out: Float32Array, seed: number, tick: number, rain: number, amount: number): void {
  const T = WAVE_T, sec = tick / 60, n = Math.round(RINGS * rain);
  for (let k = 0; k < n; k++) {
    const ph = sec / RING_S + hash30(k, 1, seed ^ 0x71a) / HASH_ONE, turn = Math.floor(ph), age = ph - turn;
    const cx = hash30(k, turn, seed ^ 0x3c5) / HASH_ONE * T, cy = hash30(k, turn, seed ^ 0x9b1) / HASH_ONE * T, r = 0.5 + age * RING_R, a = RING * amount * (1 - age);
    for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++) for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
      const ex = x + 0.5 - cx, ey = y + 0.5 - cy, d = Math.sqrt(ex * ex + ey * ey), q = 1 - Math.abs(d - r);
      if (q <= 0 || d < 1e-6) continue;
      const o = ((((y % T) + T) % T) * T + (((x % T) + T) % T)) * 4;
      out[o + 2] = out[o + 2]! + Math.round(a * q * ex / d * Q) / Q; out[o + 3] = out[o + 3]! + Math.round(a * q * ey / d * Q) / Q;
    }
  }
}
// La inclinación de una celda de agua de la vista
export function waveSlope(t: WaveTile, gx: number, gy: number, wind: number, ch: 0 | 1): number {
  const o = (((gy + t.ky) & (WAVE_T - 1)) * WAVE_T + ((gx + t.kx) & (WAVE_T - 1))) * 4 + ch;
  return t.data[o]! * wind + t.data[o + 2]!;
}
