// La lluvia y la nieve del clima en el cuadro: gotas y copos que caen inclinados por el viento hasta lo primero que hay en
// su columna (solo donde hay cielo de verdad encima), como puntos de efectos (los pinta quien pinta los efectos, igual en la
// CPU y la GPU); y lo que dejan: nieve sobre las caras de arriba y lo mojado, más oscuro. Todo sale del tick y de la semilla:
// no hay partículas guardadas, y no cambia ningún vóxel.
import { FX_STRIDE, type FxSource } from '../core';
import type { Baked } from './bake';
import { secIdx, sectionBorderAt, type SectionLayer } from './section';
import { hash30, HASH_ONE } from '../worldgen/noise';
import { climateTie, rateTicks, viewOffset, type ClimateTable, type WeatherFrame } from './climate';

export const FALL_MAX = 350;                         // gotas o copos como mucho (WeatherFrame.fall.max)
const RAIN = { speed: 230, height: 80, drift: 70, colors: [[154, 180, 216], [122, 148, 188]], points: 3, gap: 1.6 } as const;
const SNOW = { speed: 16, height: 64, drift: 12, colors: [[255, 255, 255], [228, 236, 246]], points: 1, gap: 0 } as const;

const SNAP = 16;
interface View { vx: number; vy: number; vw: number; vh: number; weather?: WeatherFrame | null }
// El búfer de puntos de cada horneado, que se reutiliza de un cuadro al siguiente
class Points implements FxSource {
  // packed0: todos los del paso (all); packed, count: los de este cuadro (con un corte, sin los que caen en él)
  packed0 = new Float32Array(1024 * FX_STRIDE);
  all = 0;
  packed = this.packed0;
  count = 0;
  private cutBuf = new Float32Array(0);
  private at = new Float64Array(0);
  // De qué salieron
  tick = NaN; vx = 0; vy = 0; vw = 0; vh = 0; rev = 0; max = 0; Kx = 0; Ky = 0;
  weather: WeatherFrame['weather'] | null = null;
  solid: WeatherFrame['solid'] = undefined;
  cam: WeatherFrame['camera'] = null;
  // El aspecto: por lluvia y nieve, los dos colores y si llevan luz propia
  readonly look = new Float64Array(14);
  private static readonly tmp = new Float64Array(14);
  private static fill(out: Float64Array, f: NonNullable<WeatherFrame['fall']>): void {
    for (let k = 0; k < 2; k++) {
      const l = k ? f.snow : f.rain, c = l?.colors ?? (k ? SNOW : RAIN).colors;
      for (let i = 0; i < 2; i++) for (let ch = 0; ch < 3; ch++) out[k * 7 + i * 3 + ch] = c[i]![ch]!;
      out[k * 7 + 6] = l?.glow ? 1 : 0;
    }
  }
  sameLook(f: NonNullable<WeatherFrame['fall']>): boolean { const t = Points.tmp; Points.fill(t, f); for (let i = 0; i < 14; i++) if (t[i] !== this.look[i]) return false; return true; }
  setLook(f: NonNullable<WeatherFrame['fall']>): void { Points.fill(this.look, f); }
  room(n: number): void { if (n * FX_STRIDE > this.packed0.length) { const grown = new Float32Array(n * 2 * FX_STRIDE); grown.set(this.packed0); this.packed0 = grown; } }
  // Los de este cuadro: con un corte, sin los puntos cuyo píxel es de lo que sustituye o de su borde dibujado
  select(b: Baked, sec: SectionLayer | null): void {
    const d = this.packed0, n = this.all;
    if (!sec) { this.packed = d; this.count = n; return; }
    if (this.at.length < n * 3) { this.at = new Float64Array(n * 6); this.cutBuf = new Float32Array(n * 2 * FX_STRIDE); }
    const at = this.at, out = this.cutBuf;
    b.cam.projectMany(d, n, FX_STRIDE, at);
    let w = 0;
    for (let k = 0; k < n; k++) {
      const sx = Math.floor(at[k * 3]!), sy = Math.floor(at[k * 3 + 1]!), j = sy - sec.y;
      if (sx >= sec.x && j >= 0 && sx < sec.x + sec.w && j < sec.h && (sec.mask[secIdx(sec, sx, j)] === 1 || sectionBorderAt(sec, sx, sy))) continue;
      for (let c = 0, q = k * FX_STRIDE; c < FX_STRIDE; c++) out[w++] = d[q + c]!;
    }
    this.packed = out; this.count = w / FX_STRIDE;
  }
}
const buffers = new WeakMap<Baked, Points>();

// Los puntos de lo que cae en un cuadro, en ejes de la vista (null sin lluvia ni nieve). Vale hasta la llamada siguiente con
// el mismo horneado. sec: la capa del corte de este cuadro: en los píxeles que sustituye y en su borde dibujado no cae nada
export function fallSource(b: Baked, o: View, sec: SectionLayer | null): FxSource | null {
  const f = o.weather;
  if (!f?.fall) return null;
  // A 30 veces por segundo (WeatherFrame.rate), y para un recuadro que va de 16 en 16 píxeles: mientras no cambian, los puntos son los mismos
  // (los de fuera de la vista los quita quien pinta; un vóxel que cambia lo nota el paso siguiente)
  const step = rateTicks(f.rate?.fall ?? 30), tick = Math.floor(f.tick / step) * step;
  const l = f.weather.levels(tick);
  if (l.rain <= 0 && l.snow <= 0) return null;
  const vx = Math.floor(o.vx / SNAP) * SNAP, vy = Math.floor(o.vy / SNAP) * SNAP, v: View = { vx, vy, vw: o.vw + SNAP, vh: o.vh + SNAP };
  const max = Math.max(0, Math.min(2000, Math.floor(f.fall.max ?? FALL_MAX)));
  let out = buffers.get(b);
  if (!out) buffers.set(b, (out = new Points()));
  if (!max) { out.count = 0; out.all = 0; out.tick = NaN; return out; }
  const [Kx, Ky] = viewOffset(f);
  if (out.tick === tick && out.vx === vx && out.vy === vy && out.vw === v.vw && out.vh === v.vh && out.rev === f.weather.revision && out.weather === f.weather && out.max === max && out.Kx === Kx && out.Ky === Ky && out.solid === f.solid && out.cam === (f.camera ?? null) && out.sameLook(f.fall)) { out.select(b, sec); return out; }
  out.tick = tick; out.vx = vx; out.vy = vy; out.vw = v.vw; out.vh = v.vh; out.rev = f.weather.revision; out.weather = f.weather; out.max = max; out.Kx = Kx; out.Ky = Ky; out.solid = f.solid; out.cam = f.camera ?? null;
  out.setLook(f.fall);
  out.all = 0;
  // (el tope es del conjunto: se reparte según lo que cae de cada cosa, así con las dos a la vez no se dobla)
  const sum = l.rain + l.snow, share = Math.min(1, 1 / sum);
  if (l.rain > 0) fall(b, v, f, tick, Kx, Ky, RAIN, l.rain * share, max, 1, out);
  if (l.snow > 0) fall(b, v, f, tick, Kx, Ky, SNOW, l.snow * share, max, 2, out);
  out.select(b, sec);
  return out;
}

// (sin crear nada por gota: lo que sale de los ruidos son enteros, y las alturas también)
function fall(b: Baked, o: View, f: WeatherFrame, tick: number, Kx: number, Ky: number, k: typeof RAIN | typeof SNOW, level: number, max: number, kind: number, out: Points): void {
  const s = f.solid ?? b.source, cam = f.camera ?? null, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  // (el giro de la vista al mundo como cuentas, sin crear nada por gota)
  const turn = f.solid && cam ? cam : null, [tx, ty] = turn ? turn.pointToWorld(0, 0) : [0, 0], [ux, uy] = turn ? turn.dirToWorld(1, 0) : [1, 0], [wxx, wyy] = turn ? turn.dirToWorld(0, 1) : [0, 1];
  const ax = tx!, ay = ty!, bx = ux!, by = uy!, cx_ = wxx!, cy_ = wyy!, sw = s.width, sd = s.depth, heights = s.height, turned = !!turn;
  // Lo que se ve: las columnas de la vista y las filas cuyo suelo o cuyo aire cae en ella
  const lo = (O - (o.vy + o.vh) - s.zMax - 1) / a, hi = (O - o.vy - s.zMin) / a;
  // El lado de la casilla: una gota por casilla, sin pasar del tope (y en pasos, para que no cambie al moverse la vista)
  const cell = Math.max(8, Math.ceil(Math.sqrt(((o.vw + 64) * (hi - lo + 32)) / max) / 4) * 4);
  const w = f.weather, lv = w.levels(tick), wind = cam ? cam.dirToView(lv.wind[0], lv.wind[1]) : lv.wind;
  const sx = wind[0]! * k.drift / k.speed * (kind === 2 ? 1.6 : 1), sy = wind[1]! * k.drift / k.speed * (kind === 2 ? 1.6 : 1);   // cuánto se va de lado por vóxel que baja
  const period = k.height / k.speed, secs = tick / 60, seed = (w.seed ^ (kind * 0x3d4d51cb)) | 0;
  const mx = Math.abs(sx) * k.height, cx0 = Math.floor((o.vx - 8 - mx + Kx) / cell), cx1 = Math.floor((o.vx + o.vw + 8 + mx + Kx) / cell);
  const cy0 = Math.floor((lo + Ky) / cell), cy1 = Math.floor((hi + Ky) / cell);
  const wantH = level * HASH_ONE;
  out.room(out.all + max * k.points);
  const d = out.packed0, look = out.look, glow = look[(kind - 1) * 7 + 6]!;
  let q = out.all * FX_STRIDE, n = 0;
  for (let cy = cy0; cy <= cy1 && n < max; cy++) for (let cx = cx0; cx <= cx1 && n < max; cx++) {
    const phase = hash30(cx, cy, seed) / HASH_ONE + secs / period, lap = Math.floor(phase), t = phase - lap;
    const h1 = hash30(cx + lap * 7919, cy, seed + 1);
    if (h1 >= wantH) continue;
    // Donde acaba: un sitio de la casilla, otro en cada vuelta
    const lx = (cx + hash30(cx, cy + lap * 7919, seed + 2) / HASH_ONE) * cell - Kx, ly = (cy + hash30(cx, cy + lap * 104729, seed + 3) / HASH_ONE) * cell - Ky;
    const down = (1 - t) * k.height;                                // lo que le falta por bajar
    const wob = kind === 2 ? Math.sin(secs * 1.7 + h1 / HASH_ONE * 40) * Math.min(3, down * 0.2) : 0;
    const c = (kind - 1) * 7 + ((h1 >> 8) & 1) * 3;
    let ground = 0, drawn = false;
    // (p -1: la columna donde acaba; después, cada punto, que tiene que estar por encima de todo lo de la suya: bajo un techo, no)
    for (let p = -1; p < k.points; p++) {
      const up = p < 0 ? 0 : down + p * k.gap, x = p < 0 ? lx : lx - sx * up + wob, y = ly - sy * up, z = ground + up;
      if (p >= 0) { const py = O - a * y - z; if (x < o.vx - 1 || py < o.vy - 2 || x >= o.vx + o.vw + 1 || py >= o.vy + o.vh + 2) continue; }
      let gx = Math.floor(x), gy = Math.floor(y);
      if (turned) { const px = gx + 0.5, py = gy + 0.5; gx = Math.floor(ax + px * bx + py * cx_); gy = Math.floor(ay + px * by + py * cy_); }
      const inside = gx >= 0 && gy >= 0 && gx < sw && gy < sd;
      if (p < 0) { if (!inside) break; ground = heights[gy * sw + gx]!; continue; }
      if (inside && z < heights[gy * sw + gx]!) continue;
      d[q] = x; d[q + 1] = y; d[q + 2] = z; d[q + 3] = look[c]!; d[q + 4] = look[c + 1]!; d[q + 5] = look[c + 2]!; d[q + 6] = 1; d[q + 7] = glow; d[q + 8] = 1;
      q += FX_STRIDE;
      drawn = true;
    }
    if (drawn) n++;
  }
  out.all = q / FX_STRIDE;
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
// (bare: de una rampa que no toma nieve, MaterialProps.snow)
// Pinta la nieve y lo mojado sobre el color de un píxel de lo quieto (px[i..i + 2]): su cara, su cielo (0..5), su columna y su
// y en la vista. La misma cuenta, con enteros, que la GPU (FRAG_SCENE)
export function applyCover(px: Uint8ClampedArray, i: number, c: CoverLook, t: ClimateTable, face: number, sky: number, x: number, wy: number, bare = false): void {
  if (face < 0 || face === 5 || sky <= 0) return;
  const wet = (face === 4 ? c.wetTop : c.wetSide) * (sky / 5);
  if (wet > 0) { const k = 1 - Math.floor(wet * 256 + 0.5) / 256; for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.floor(px[i + ch]! * k + 0.5); }
  if (face !== 4 || !c.snow || bare) return;
  const bx = (x + t.kx) & 3, by = Math.floor(Math.fround(wy) + t.ky + climateTie) & 3;
  if (BAYER[by * 4 + bx]! >= c.snow - (5 - sky) * 4) return;
  for (let ch = 0; ch < 3; ch++) px[i + ch] = Math.floor(px[i + ch]! + (SNOW_COLOR[ch]! - px[i + ch]!) * SNOW_MIX + 0.5);
}
// Lo de dentro de un corte no lleva nieve ni se moja, salvo que su cielo sea el del mundo sin cortar (SectionCut.worldSky)
export const coverInCut = (sec: SectionLayer | null): boolean => !!sec?.box?.worldSky;
