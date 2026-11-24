// El clima en el cuadro (Frame2DOptions.weather): una tabla pequeña por casillas de la vista, calculada en la CPU y leída
// igual por la CPU y la GPU (así las dos dan lo mismo): cuánto inclina el aire lo que se mece, la fuerza del viento y la
// sombra de las nubes. Las casillas están fijas en el mundo: correr la ventana o girar la vista no las mueve.
import type { Baked } from './bake';
import type { StaticVoxels } from './state';
import type { Weather, WeatherLevels } from './weather';
import { lattice } from '../worldgen/noise';

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
  fall?: { max?: number } | null;
  solid?: StaticVoxels;
  // Lo que dejan, con un horneado con cielo: nieve sobre las caras de arriba y lo mojado (Weather.cover)
  cover?: boolean;
}

export const CLIMATE_W = 128, CLIMATE_H = 64;       // las casillas que caben en la tabla
export const CLIMATE_CX = 16, CLIMATE_CY = 32;      // lo que cubre cada una, en vóxeles de la vista
const STEP = 5;                                     // ticks entre dos posturas de lo que se mece (12 por segundo)
const SWAY_HZ = 0.85, CURRENT_HZ = 0.35;
const Q = 256;                                      // los valores van en 1 / Q: exactos en float32

export interface ClimateTable {
  x0: number; y0: number; w: number; h: number;     // la primera casilla y cuántas
  kx: number; ky: number;                           // lo que se suma a la x y la y de la vista antes de dividir
  data: Float32Array;                               // w * h * 4: inclinación, inclinación de lo de agua, viento, nubes
  sway: boolean;
  levels: WeatherLevels;
  key: string;
}
export const climateTie = 1 / 1024;

const cache = new WeakMap<Baked, ClimateTable>();
// La tabla de un cuadro (null sin clima). Cambia 12 veces por segundo, o al moverse la vista a otras casillas
export function climateTable(b: Baked, o: { vx: number; vy: number; vw: number; vh: number; weather?: WeatherFrame | null }): ClimateTable | null {
  const f = o.weather;
  if (!f) return null;
  const tick = Math.floor(f.tick / STEP) * STEP, w = f.weather, cam = f.camera ?? null, [ox, oy] = f.origin ?? [0, 0];
  const l = w.levels(tick);
  // El punto v de la vista es, en el plano del mundo girado como ella, v + K
  const base = cam ? cam.pointToWorld(0, 0) : [0, 0] as const;
  const toView = (x: number, y: number): [number, number] => (cam ? cam.dirToView(x, y) : [x, y]);
  const [Kx, Ky] = toView(base[0]! + ox, base[1]! + oy);
  const mod = (v: number, m: number) => ((v % m) + m) % m;
  const kx = mod(Kx, CLIMATE_CX), ky = mod(Ky, CLIMATE_CY);
  const a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const yLo = (O - (o.vy + o.vh) - b.source.zMax - 1) / a - 4, yHi = (O - o.vy - b.source.zMin) / a + 4;
  const x0 = Math.floor((o.vx - 8 + kx) / CLIMATE_CX), y0 = Math.floor((yLo + ky) / CLIMATE_CY);
  const nw = Math.max(1, Math.min(CLIMATE_W, Math.floor((o.vx + o.vw + 8 + kx) / CLIMATE_CX) - x0 + 1));
  const nh = Math.max(1, Math.min(CLIMATE_H, Math.floor((yHi + ky) / CLIMATE_CY) - y0 + 1));
  const amount = Math.max(0, Math.min(1, f.sway ?? 1));
  const key = [w.seed, tick, x0, y0, nw, nh, Kx, Ky, amount, l.wind, l.gust, l.clouds, w.drift(tick)].join(',');
  const hit = cache.get(b);
  if (hit && hit.key === key) return hit;
  const data = new Float32Array(nw * nh * 4), gust = w.gustField(tick), cloud = w.cloudField(tick);
  const len = Math.hypot(l.wind[0], l.wind[1]), ux = len > 0 ? l.wind[0] / len : 0, uy = len > 0 ? l.wind[1] / len : 0, lean = toView(ux, uy)[0];
  const wholeX = (Kx - kx) / CLIMATE_CX, wholeY = (Ky - ky) / CLIMATE_CY, sec = tick / 60;
  for (let j = 0; j < nh; j++) for (let i = 0; i < nw; i++) {
    const cx = x0 + i + wholeX, cy = y0 + j + wholeY;                              // la casilla en el plano del mundo girado
    const rx = (cx + 0.5) * CLIMATE_CX, ry = (cy + 0.5) * CLIMATE_CY;
    const [wx, wy] = cam ? cam.dirToWorld(rx, ry) : [rx, ry];
    const g = gust(wx, wy), k = (j * nw + i) * 4;
    const jit = lattice(Math.floor(wx / CLIMATE_CX), Math.floor(wy / CLIMATE_CX), w.seed) * 0.35, along = (wx * ux + wy * uy) / 130;
    const turn = 2 * Math.PI;
    const s1 = Math.sin(turn * (sec * SWAY_HZ - along + jit)), s2 = Math.sin(turn * (sec * CURRENT_HZ - (wx + wy) / 90 + jit));
    const air = g * (0.5 * lean + 0.5 * s1);
    data[k] = Math.round(air * amount * Q) / Q;
    data[k + 1] = Math.round((0.5 * s2 + 0.35 * air) * amount * Q) / Q;
    data[k + 2] = Math.round(g * Q) / Q;
    data[k + 3] = Math.round(cloud(wx, wy) * Q) / Q;
  }
  const t: ClimateTable = { x0, y0, w: nw, h: nh, kx, ky, data, sway: amount > 0, levels: l, key };
  cache.set(b, t);
  return t;
}

// La casilla de un punto de la vista (su índice en data)
export function climateCell(c: ClimateTable, vx: number, vy: number): number {
  const i = Math.floor((vx + c.kx) / CLIMATE_CX) - c.x0, j = Math.floor((Math.fround(vy) + c.ky + climateTie) / CLIMATE_CY) - c.y0;
  return (Math.max(0, Math.min(c.h - 1, j)) * c.w + Math.max(0, Math.min(c.w - 1, i))) * 4;
}
export const climateLean = (c: ClimateTable, vx: number, vy: number, aquatic: boolean): number => c.data[climateCell(c, vx, vy) + (aquatic ? 1 : 0)]!;
