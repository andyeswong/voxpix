// La lluvia y la nieve del clima en el cuadro: gotas y copos que caen inclinados por el viento hasta lo primero que hay en
// su columna (solo donde hay cielo de verdad encima), como puntos de efectos (los pinta quien pinta los efectos, igual en la
// CPU y la GPU); y lo que dejan: nieve sobre las caras de arriba y lo mojado, más oscuro. Todo sale del tick y de la semilla:
// no hay partículas guardadas, y no cambia ningún vóxel.
import { FX_STRIDE, type FxSource } from '../core';
import type { Baked } from './bake';
import { secIdx, sectionBorderAt, type SectionLayer } from './section';
import { lattice } from '../worldgen/noise';
import { climateTie, type ClimateTable, type WeatherFrame } from './climate';

export const FALL_MAX = 240;                         // gotas o copos como mucho (WeatherFrame.fall.max)
const RAIN = { speed: 230, height: 80, drift: 70, colors: [[154, 180, 216], [122, 148, 188]], points: 2, gap: 2 } as const;
const SNOW = { speed: 16, height: 64, drift: 12, colors: [[255, 255, 255], [228, 236, 246]], points: 1, gap: 0 } as const;

interface View { vx: number; vy: number; vw: number; vh: number; weather?: WeatherFrame | null }
// El búfer de puntos de cada horneado, que se reutiliza de un cuadro al siguiente
class Points implements FxSource {
  count = 0;
  packed = new Float32Array(256 * FX_STRIDE);
  add(x: number, y: number, z: number, c: readonly [number, number, number]): void {
    const q = this.count++ * FX_STRIDE;
    if (q + FX_STRIDE > this.packed.length) { const grown = new Float32Array(this.packed.length * 2); grown.set(this.packed); this.packed = grown; }
    const p = this.packed;
    p[q] = x; p[q + 1] = y; p[q + 2] = z; p[q + 3] = c[0]; p[q + 4] = c[1]; p[q + 5] = c[2]; p[q + 6] = 1; p[q + 7] = 0; p[q + 8] = 1;
  }
}
const buffers = new WeakMap<Baked, Points>();

// Los puntos de lo que cae en un cuadro, en ejes de la vista (null sin lluvia ni nieve). Vale hasta la llamada siguiente con
// el mismo horneado. sec: la capa del corte de este cuadro: en los píxeles que sustituye y en su borde dibujado no cae nada
export function fallSource(b: Baked, o: View, sec: SectionLayer | null): FxSource | null {
  const f = o.weather;
  if (!f?.fall) return null;
  const l = f.weather.levels(f.tick);
  if (l.rain <= 0 && l.snow <= 0) return null;
  const max = Math.max(0, Math.min(2000, Math.floor(f.fall.max ?? FALL_MAX)));
  let out = buffers.get(b);
  if (!out) buffers.set(b, (out = new Points()));
  out.count = 0;
  if (!max) return out;
  // (el tope es del conjunto: se reparte según lo que cae de cada cosa, así con las dos a la vez no se dobla)
  const sum = l.rain + l.snow, share = Math.min(1, 1 / sum);
  if (l.rain > 0) fall(b, o, f, RAIN, l.rain * share, max, 1, out, sec);
  if (l.snow > 0) fall(b, o, f, SNOW, l.snow * share, max, 2, out, sec);
  return out;
}

function fall(b: Baked, o: View, f: WeatherFrame, k: typeof RAIN | typeof SNOW, level: number, max: number, kind: number, out: Points, sec: SectionLayer | null): void {
  const s = f.solid ?? b.source, cam = f.camera ?? null, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const [ox, oy] = f.origin ?? [0, 0], base = cam ? cam.pointToWorld(0, 0) : [0, 0];
  const [Kx, Ky] = cam ? cam.dirToView(base[0]! + ox, base[1]! + oy) : [base[0]! + ox, base[1]! + oy];
  // (el giro de la vista al mundo como cuentas, sin crear nada por gota)
  const turn = f.solid && cam ? cam : null, [tx, ty] = turn ? turn.pointToWorld(0, 0) : [0, 0], [ux, uy] = turn ? turn.dirToWorld(1, 0) : [1, 0], [wxx, wyy] = turn ? turn.dirToWorld(0, 1) : [0, 1];
  const heightAt = (x: number, y: number): number => {              // en ejes de la vista: lo más alto de la columna, o null fuera
    let cx = Math.floor(x), cy = Math.floor(y);
    if (turn) { const px = cx + 0.5, py = cy + 0.5; cx = Math.floor(tx! + px * ux! + py * wxx!); cy = Math.floor(ty! + px * uy! + py * wyy!); }
    return cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth ? -Infinity : s.height[cy * s.width + cx]!;
  };
  // Lo que se ve: las columnas de la vista y las filas cuyo suelo o cuyo aire cae en ella
  const lo = (O - (o.vy + o.vh) - s.zMax - 1) / a, hi = (O - o.vy - s.zMin) / a;
  // El lado de la casilla: una gota por casilla, sin pasar del tope (y en pasos, para que no cambie al moverse la vista)
  const cell = Math.max(8, Math.ceil(Math.sqrt(((o.vw + 64) * (hi - lo + 32)) / max) / 4) * 4);
  const w = f.weather, lv = w.levels(f.tick), wind = cam ? cam.dirToView(lv.wind[0], lv.wind[1]) : lv.wind;
  const sx = wind[0]! * k.drift / k.speed * (kind === 2 ? 1.6 : 1), sy = wind[1]! * k.drift / k.speed * (kind === 2 ? 1.6 : 1);   // cuánto se va de lado por vóxel que baja
  const period = k.height / k.speed, secs = f.tick / 60, seed = (w.seed ^ (kind * 0x3d4d51cb)) | 0;
  const mx = Math.abs(sx) * k.height, cx0 = Math.floor((o.vx - 8 - mx + Kx) / cell), cx1 = Math.floor((o.vx + o.vw + 8 + mx + Kx) / cell);
  const cy0 = Math.floor((lo + Ky) / cell), cy1 = Math.floor((hi + Ky) / cell);
  let n = 0;
  for (let cy = cy0; cy <= cy1 && n < max; cy++) for (let cx = cx0; cx <= cx1 && n < max; cx++) {
    const phase = lattice(cx, cy, seed) + secs / period, turn = Math.floor(phase), t = phase - turn;
    const h1 = lattice(cx + turn * 7919, cy, seed + 1);
    if (h1 >= level) continue;
    // Donde acaba: un sitio de la casilla, otro en cada vuelta
    const lx = (cx + lattice(cx, cy + turn * 7919, seed + 2)) * cell - Kx, ly = (cy + lattice(cx, cy + turn * 104729, seed + 3)) * cell - Ky;
    const ground = heightAt(lx, ly);
    if (ground === -Infinity) continue;
    const down = (1 - t) * k.height;                                // lo que le falta por bajar
    const wob = kind === 2 ? Math.sin(secs * 1.7 + h1 * 40) * Math.min(3, down * 0.2) : 0;
    const c = k.colors[h1 * 16 % 1 < 0.5 ? 0 : 1]!;
    let drawn = false;
    for (let p = 0; p < k.points; p++) {
      const up = down + p * k.gap, x = lx - sx * up + wob, y = ly - sy * up, z = ground + up;
      const px = x, py = O - a * y - z;
      if (px < o.vx - 1 || py < o.vy - 2 || px >= o.vx + o.vw + 1 || py >= o.vy + o.vh + 2) continue;
      // (bajo un techo, no: tiene que estar por encima de todo lo de su columna)
      if (z < heightAt(x, y)) continue;
      if (sec && cutAt(sec, b, x, y, z)) continue;
      out.add(x, y, z, c);
      drawn = true;
    }
    if (drawn) n++;
  }
}

// ¿El píxel en que se pinta un punto es de lo que sustituye el corte, o de su borde dibujado?
const at3 = [0, 0, 0];
function cutAt(sec: SectionLayer, b: Baked, x: number, y: number, z: number): boolean {
  b.cam.projectTo(x, y, z, at3);
  const sx = Math.floor(at3[0]!), sy = Math.floor(at3[1]!), j = sy - sec.y;
  if (sx < sec.x || j < 0 || sx >= sec.x + sec.w || j >= sec.h) return false;
  return sec.mask[secIdx(sec, sx, j)] === 1 || sectionBorderAt(sec, sx, sy);
}

// ---- lo que dejan
export const SNOW_COLOR = [232, 238, 246] as const;
export const SNOW_MIX = 7 / 8;
export const WET_TOP = 0.34, WET_SIDE = 0.18;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// La nieve (en dieciseisavos de trama) y lo que quita lo mojado a las caras de arriba y a las demás (en 1/256), o null
export interface CoverLook { snow: number; wetTop: number; wetSide: number }
export function coverLook(b: Baked, f: WeatherFrame | null | undefined): CoverLook | null {
  if (!f?.cover || !b.sky) return null;
  const c = f.weather.cover, q = (v: number) => Math.floor(v * 256 + 0.5) / 256;
  const snow = Math.floor(c.snow * 16 + 0.5), wetTop = q(c.wet * WET_TOP), wetSide = q(c.wet * WET_SIDE);
  return snow || wetTop ? { snow, wetTop, wetSide } : null;
}
// Pinta la nieve y lo mojado sobre el color de un píxel de lo quieto (px[i..i + 2]): su cara, su cielo (0..5), su columna y su
// y en la vista. La misma cuenta, con enteros, que la GPU (FRAG_SCENE)
export function applyCover(px: Uint8ClampedArray, i: number, c: CoverLook, t: ClimateTable, face: number, sky: number, x: number, wy: number): void {
  if (face < 0 || face === 5 || sky <= 0) return;
  const wet = (face === 4 ? c.wetTop : c.wetSide) * (sky / 5);
  if (wet > 0) { const k = 1 - Math.floor(wet * 256 + 0.5) / 256; for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.floor(px[i + ch]! * k + 0.5); }
  if (face !== 4 || !c.snow) return;
  const bx = (x + t.kx) & 3, by = Math.floor(Math.fround(wy) + t.ky + climateTie) & 3;
  if (BAYER[by * 4 + bx]! >= c.snow - (5 - sky) * 4) return;
  for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.floor(px[i + ch]! + (SNOW_COLOR[ch]! - px[i + ch]!) * SNOW_MIX + 0.5);
}
// Lo de dentro de un corte no lleva nieve ni se moja, salvo que su cielo sea el del mundo sin cortar (SectionCut.worldSky)
export const coverInCut = (sec: SectionLayer | null): boolean => !!sec?.box?.worldSky;
