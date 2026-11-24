// El rizado del agua con el clima: las ondas del viento (van con él y crecen con la ráfaga que pasa) y los anillos de la lluvia.
// Solo inclinan la superficie al pintarla (drawWater y FRAG_WATER): el simulador no se entera. Es una baldosa de WAVE_T x WAVE_T
// celdas de agua que se repite, fija en el mundo, calculada en la CPU 12 veces por segundo y leída igual por la CPU y la GPU.
import { lattice } from '../worldgen/noise';
import type { Baked } from './bake';
import { climateStep, type ClimateTable, type WeatherFrame } from './climate';

export const WAVE_T = 64;
export const WAVE_CELL = 2;                     // vóxeles por celda de agua (WATER_CELL)
const AMP = 0.2, RING = 0.3, Q = 1024;         // (los valores, en 1 / Q: exactos en float32)
const RINGS = 70;                               // anillos a la vez en una baldosa con lluvia a tope
const RING_S = 0.9, RING_R = 5;                 // lo que dura uno (segundos) y hasta dónde llega (celdas)

// data: por celda, la inclinación (x, y) del viento a fuerza 1 y la de los anillos. kx, ky: lo que se suma a la celda de la vista
export interface WaveTile { data: Float32Array; kx: number; ky: number; climate: ClimateTable; key: string }

const cache = new WeakMap<Baked, WaveTile>();
export function waveTile(b: Baked, f: WeatherFrame | null | undefined, c: ClimateTable | null): WaveTile | null {
  const amount = Math.max(0, Math.min(1, f?.waves ?? 0));
  if (!f || !c || amount <= 0) return null;
  // (en otro tick que la tabla del clima, para no hacer las dos cosas en el mismo cuadro)
  const tick = climateStep(f.tick + 2) - 2, l = f.weather.levels(tick), len = Math.hypot(l.wind[0], l.wind[1]);
  if (len <= 0 && l.rain <= 0) return null;
  const cam = f.camera ?? null, [ox, oy] = f.origin ?? [0, 0], base = cam ? cam.pointToWorld(0, 0) : [0, 0];
  const [Kx, Ky] = cam ? cam.dirToView(base[0]! + ox, base[1]! + oy) : [base[0]! + ox, base[1]! + oy];
  const mod = (v: number) => ((Math.floor(v / WAVE_CELL) % WAVE_T) + WAVE_T) % WAVE_T;
  const dir = len > 0 ? (cam ? cam.dirToView(l.wind[0] / len, l.wind[1] / len) : [l.wind[0] / len, l.wind[1] / len]) : [1, 0];
  const key = [f.weather.seed, tick, amount, dir, len > 0, l.rain, Kx, Ky].join(',');
  const hit = cache.get(b);
  if (hit && hit.key === key && hit.climate === c) return hit;
  let data: Float32Array;
  if (hit && hit.key === key) data = hit.data;
  else { data = new Float32Array(WAVE_T * WAVE_T * 4); if (len > 0) windWaves(data, dir[0]!, dir[1]!, tick, amount); if (l.rain > 0) rainRings(data, f.weather.seed, tick, l.rain, amount); }
  const t: WaveTile = { data, kx: mod(Kx), ky: mod(Ky), climate: c, key };
  cache.set(b, t);
  return t;
}

// Tres trenes de ondas con vueltas enteras en la baldosa (así casa consigo misma): el del viento y dos a sus lados
function windWaves(out: Float32Array, dx: number, dy: number, tick: number, amount: number): void {
  const sec = tick / 60, T = WAVE_T;
  for (const [turn, n, amp, hz] of [[0, 6, 0.5, 0.9], [0.55, 9, 0.3, 1.2], [-0.7, 11, 0.2, 1.5]] as const) {
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
    const ph = sec / RING_S + lattice(k, 1, seed ^ 0x71a), turn = Math.floor(ph), age = ph - turn;
    const cx = lattice(k, turn, seed ^ 0x3c5) * T, cy = lattice(k, turn, seed ^ 0x9b1) * T, r = 0.5 + age * RING_R, a = RING * amount * (1 - age);
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
