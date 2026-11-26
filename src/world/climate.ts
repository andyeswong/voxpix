// El clima en el cuadro (Frame2DOptions.weather): una tabla pequeña por casillas de la vista, calculada en la CPU y leída
// igual por la CPU y la GPU (así las dos dan lo mismo): cuánto inclina el aire lo que se mece, la fuerza del viento y la
// sombra de las nubes. Las casillas están fijas en el mundo: correr la ventana o girar la vista no las mueve.
import type { Baked } from './bake';
import type { StaticVoxels } from './state';
import type { Weather } from './weather';
import { hash30, HASH_ONE } from '../worldgen/noise';

export interface FallLook { colors?: readonly [readonly [number, number, number], readonly [number, number, number]]; glow?: boolean }
// El clima de un cuadro. tick: el de la simulación. origin: el vóxel del mundo que es el (0, 0) del horneado sin girar (la
// ventana que se corre). camera: la de la vista girada (WorldView.camera)
export interface WeatherFrame {
  weather: Weather;
  tick: number;
  origin?: readonly [number, number];
  camera?: { pointToWorld(x: number, y: number): [number, number]; dirToView(x: number, y: number): [number, number]; dirToWorld(x: number, y: number): [number, number] } | null;
  sway?: number;                             // 0..1: cuánto se mece lo que se mece (1)
  // Lluvia y nieve que caen (precipitation.ts): como mucho max a la vez. solid: los vóxeles del mundo sin girar ni cortar, de
  // donde sale lo alto de cada columna (por defecto, los del horneado)
  // rain, snow: los dos colores (0..255) entre los que sale cada gota o copo, y glow: con luz propia (se ven igual de noche)
  fall?: { max?: number; rain?: FallLook; snow?: FallLook } | null;
  solid?: StaticVoxels;
  // Lo que dejan, con un horneado con cielo: nieve sobre las caras de arriba y lo mojado (Weather.cover)
  cover?: boolean;
  // El sol (sunlight.ts), con un horneado con cielo: su color, su fuerza y hacia dónde está (ejes del mundo, hacia el sol).
  // daySun (lighting/daycycle.ts) da los tres de una hora del día. null: sin sol, lo de siempre
  sunlight?: { color: readonly [number, number, number]; intensity: number; dir?: readonly [number, number, number] } | null;
  // Cuántas veces por segundo cambian la tabla del clima y las olas (tables, 12) y lo que cae (fall, 30): menos, más barato
  rate?: { tables?: number; fall?: number };
  waves?: number;                            // 0..1: cuánto rizan el agua el viento y la lluvia (0)
  // 0..1: la corriente de lo de agua (MaterialProps.aquatic) con el agua quieta, en partes de la entera; crece hasta ella
  // con el viento de la casilla o la lluvia (1: siempre entera, lo de siempre)
  still?: number;
}

export const CLIMATE_W = 128, CLIMATE_H = 64;       // las casillas que caben en la tabla
export const CLIMATE_CX = 16, CLIMATE_CY = 32;      // lo que cubre cada una, en vóxeles de la vista
const SWAY_HZ = 0.85, CURRENT_HZ = 0.35;
const Q = 256;                                      // los valores van en 1 / Q: exactos en float32

export interface ClimateTable {
  x0: number; y0: number; w: number; h: number;     // la primera casilla y cuántas
  kx: number; ky: number;                           // lo que se suma a la x y la y de la vista antes de dividir
  data: Float32Array;                               // w * h * 4: inclinación, inclinación de lo de agua, viento, nubes
  sway: boolean;
}
// Ticks entre dos pasos a hz veces por segundo
export const rateTicks = (hz: number): number => (hz > 0 ? Math.max(1, Math.min(600, Math.round(60 / hz))) : 600);
export const climateStepTicks = (f: WeatherFrame): number => rateTicks(f.rate?.tables ?? 12);
// El tick del paso en que está el cuadro
export const climateStep = (f: WeatherFrame): number => { const n = climateStepTicks(f); return Math.floor(f.tick / n) * n; };
export const climateTie = 1 / 1024;

// Los datos de los que sale una tabla (con los mismos, la misma)
interface Want { tick: number; rev: number; weather: Weather; x0: number; y0: number; w: number; h: number; Kx: number; Ky: number; amount: number; still: number; cam: WeatherFrame['camera'] }
const same = (a: Want, b: Want): boolean => a.tick === b.tick && a.rev === b.rev && a.weather === b.weather && a.x0 === b.x0 && a.y0 === b.y0 && a.w === b.w && a.h === b.h && a.Kx === b.Kx && a.Ky === b.Ky && a.amount === b.amount && a.still === b.still && a.cam === b.cam;
const GUST = new Float64Array(CLIMATE_W), CLOUD = new Float64Array(CLIMATE_W);
// Una tabla a medias: se hace por filas (run), de una vez o por adelantado
class Building {
  readonly data: Float32Array;
  private row = 0;
  private readonly ux: number;
  private readonly uy: number;
  private readonly lean: number;
  constructor(readonly want: Want, readonly kx: number, readonly ky: number) {
    const { weather, tick, cam } = want, l = weather.levels(tick), len = Math.hypot(l.wind[0], l.wind[1]);
    this.data = new Float32Array(want.w * want.h * 4);
    this.ux = len > 0 ? l.wind[0] / len : 0; this.uy = len > 0 ? l.wind[1] / len : 0;
    this.lean = cam ? cam.dirToView(this.ux, this.uy)[0] : this.ux;
  }
  run(rows: number): void {
    const { want, data, ux, uy, lean, kx, ky } = this, { x0, y0, w, h, Kx, Ky, amount, cam, weather } = want;
    // (la lluvia solo hace falta con still < 1: levels crea objetos en las transiciones)
    const still = want.still, rain = still < 1 ? weather.levels(want.tick).rain : 0;
    const wholeX = (Kx - kx) / CLIMATE_CX, wholeY = (Ky - ky) / CLIMATE_CY, sec = want.tick / 60, turn = 2 * Math.PI;
    // (el giro de la vista al mundo, sin crear nada por casilla)
    const [ax, ay] = cam ? cam.dirToWorld(1, 0) : [1, 0], [bx, by] = cam ? cam.dirToWorld(0, 1) : [0, 1];
    for (const end = Math.min(h, this.row + rows); this.row < end; this.row++) {
     const j = this.row, fx = (x0 + wholeX + 0.5) * CLIMATE_CX, fy = (y0 + j + wholeY + 0.5) * CLIMATE_CY;
     weather.fieldRow(want.tick, fx * ax! + fy * bx!, fx * ay! + fy * by!, CLIMATE_CX * ax!, CLIMATE_CX * ay!, w, GUST, CLOUD);
     for (let i = 0; i < w; i++) {
      const rx = (x0 + i + wholeX + 0.5) * CLIMATE_CX, ry = (y0 + j + wholeY + 0.5) * CLIMATE_CY;         // el plano del mundo girado
      const wx = rx * ax! + ry * bx!, wy = rx * ay! + ry * by!, g = GUST[i]!, k = (j * w + i) * 4;
      const jit = hash30(Math.floor(wx / CLIMATE_CX), Math.floor(wy / CLIMATE_CX), weather.seed) / HASH_ONE * 0.35, along = (wx * ux + wy * uy) / 130;
      const s1 = Math.sin(turn * (sec * SWAY_HZ - along + jit)), s2 = Math.sin(turn * (sec * CURRENT_HZ - (wx + wy) / 90 + jit));
      const air = g * (0.5 * lean + 0.5 * s1);
      data[k] = Math.round(air * amount * Q) / Q;
      const stir = still + (1 - still) * Math.min(1, g + rain);              // (still 1: 1, la corriente de siempre)
      data[k + 1] = Math.round((0.5 * stir * s2 + 0.35 * air) * amount * Q) / Q;
      data[k + 2] = Math.round(g * Q) / Q;
      data[k + 3] = Math.round(CLOUD[i]! * Q) / Q;
     }
    }
  }
  finish(): ClimateTable {
    this.run(Infinity);
    const { x0, y0, w, h, amount } = this.want;
    return { x0, y0, w, h, kx: this.kx, ky: this.ky, data: this.data, sway: amount > 0 };
  }
}
interface View { vx: number; vy: number; vw: number; vh: number; weather?: WeatherFrame | null }
const mod = (v: number, m: number): number => ((v % m) + m) % m;
// El punto v de la vista es, en el plano del mundo girado como ella, v + K
export function viewOffset(f: WeatherFrame): [number, number] {
  const cam = f.camera ?? null, [ox, oy] = f.origin ?? [0, 0];
  if (!cam) return [ox, oy];
  const base = cam.pointToWorld(0, 0);
  return cam.dirToView(base[0] + ox, base[1] + oy);
}
function wantOf(b: Baked, o: View, f: WeatherFrame, tick: number): Want {
  const [Kx, Ky] = viewOffset(f), kx = mod(Kx, CLIMATE_CX), ky = mod(Ky, CLIMATE_CY);
  const a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const yLo = (O - (o.vy + o.vh) - b.source.zMax - 1) / a - 4, yHi = (O - o.vy - b.source.zMin) / a + 4;
  const x0 = Math.floor((o.vx - 8 + kx) / CLIMATE_CX), y0 = Math.floor((yLo + ky) / CLIMATE_CY);
  return { tick, rev: f.weather.revision, weather: f.weather, x0, y0, Kx, Ky, cam: f.camera ?? null, amount: Math.max(0, Math.min(1, f.sway ?? 1)), still: Math.max(0, Math.min(1, f.still ?? 1)),
    w: Math.max(1, Math.min(CLIMATE_W, Math.floor((o.vx + o.vw + 8 + kx) / CLIMATE_CX) - x0 + 1)), h: Math.max(1, Math.min(CLIMATE_H, Math.floor((yHi + ky) / CLIMATE_CY) - y0 + 1)) };
}
const cache = new WeakMap<Baked, { want: Want; table: ClimateTable; next: Building | null }>();
// La tabla de un cuadro (null sin clima). Cambia 12 veces por segundo (WeatherFrame.rate), o al moverse la vista a otras casillas
export function climateTable(b: Baked, o: View): ClimateTable | null {
  const f = o.weather;
  if (!f) return null;
  const want = wantOf(b, o, f, climateStep(f)), hit = cache.get(b);
  if (hit && same(hit.want, want)) return hit.table;
  // (si es la que se estaba haciendo por adelantado, solo lo que le falte)
  const build = hit?.next && same(hit.next.want, want) ? hit.next : new Building(want, mod(want.Kx, CLIMATE_CX), mod(want.Ky, CLIMATE_CY));
  const table = build.finish();
  cache.set(b, { want, table, next: null });
  return table;
}
// Adelanta la tabla del paso siguiente unas filas, para que el cuadro en que cambia no la pague entera. Con esto o sin esto
// las tablas son las mismas: si el clima o la vista cambian antes, lo adelantado se tira
export function climateAhead(b: Baked, o: View): void {
  const f = o.weather, hit = f && cache.get(b);
  if (!hit) return;
  const step = climateStepTicks(f), want = wantOf(b, o, f, climateStep(f) + step);
  if (!hit.next || !same(hit.next.want, want)) hit.next = new Building(want, mod(want.Kx, CLIMATE_CX), mod(want.Ky, CLIMATE_CY));
  hit.next.run(Math.ceil(want.h / Math.max(1, step - 1)));
}

// La casilla de un punto de la vista (su índice en data)
export function climateCell(c: ClimateTable, vx: number, vy: number): number {
  const i = Math.floor((vx + c.kx) / CLIMATE_CX) - c.x0, j = Math.floor((Math.fround(vy) + c.ky + climateTie) / CLIMATE_CY) - c.y0;
  return (Math.max(0, Math.min(c.h - 1, j)) * c.w + Math.max(0, Math.min(c.w - 1, i))) * 4;
}
export const climateLean = (c: ClimateTable, vx: number, vy: number, aquatic: boolean): number => c.data[climateCell(c, vx, vy) + (aquatic ? 1 : 0)]!;
