import type { SunLook } from './sunlight';
import type { ClimateTable } from './climate';
import type { WaveTile } from './waves';

// Lo que el cuadro le pide al agua al pintarla (drawWater y FRAG_WATER): además de lo de siempre
export interface WaterLook {
  // Por píxel de la vista: 1 donde lo que quedó es una planta de agua (MaterialProps.aquatic), que se ve a través del agua
  clear?: Uint8Array | null;
  sun?: { look: SunLook; table: ClimateTable } | null;   // el sol sobre la superficie (sunlight.ts)
  waves?: WaveTile | null;      // el rizado del viento y la lluvia (waves.ts)
}

// Cuánto tapa el agua lo que está `gap` más lejos que su superficie en el mismo píxel (0 nada, 1 todo): por la altura de
// agua que tiene encima. En pasos de 1/64: la misma cuenta, exacta, en la CPU y la GPU
export const CLEAR_BASE = 0.3, CLEAR_STEP = 0.04, CLEAR_MAX = 0.8;
export function seenThrough(gap: number, a: number, f1: number, f2: number): number {
  const down = Math.abs((a * gap) / (f1 - a * f2));
  return Math.floor(Math.min(CLEAR_MAX, CLEAR_BASE + CLEAR_STEP * down) * 64 + 0.5) / 64;
}
