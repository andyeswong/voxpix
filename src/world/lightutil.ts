// Una luz del mundo resuelta: el preset de su tipo con sus ajustes, y su intensidad con parpadeo en un instante.
// La usan todos (horneado, entidades, agua, modo vóxel), así la misma luz se ve igual en todas partes.
import { SOURCE_PRESETS, lightIntensity, lightOf } from '../lighting';
import { SPOT_SOFT, type Spot } from '../core';
import type { WorldLight } from './build';

export interface ResolvedLight {
  x: number; y: number; z: number;
  radius: number;
  color: readonly [number, number, number];
  intensity: number;           // con el parpadeo de ese instante
  base: number;                // sin parpadeo
  spot: Spot | null;           // si es un foco: su cono
}

export function spotOf(l: { dir?: readonly [number, number, number]; cone?: number }): Spot | null {
  if (!l.dir) return null;
  const len = Math.hypot(l.dir[0], l.dir[1], l.dir[2]) || 1;
  const half = ((l.cone ?? 45) * Math.PI) / 360;
  return { dir: [l.dir[0] / len, l.dir[1] / len, l.dir[2] / len], cosOuter: Math.cos(half), cosInner: Math.cos(half * SPOT_SOFT) };
}



export function resolveLight(l: WorldLight, time: number): ResolvedLight {
  const p = SOURCE_PRESETS[l.kind];
  const base = l.intensity ?? p.intensity;
  // El parpadeo sale de la semilla del id (como en el juego) y escala la intensidad propia de esta luz
  const flick = lightIntensity(lightOf({ id: String(l.id), kind: l.kind, x: 0, y: 0 }), time) / p.intensity;
  return { x: l.x, y: l.y, z: l.z, radius: l.radius ?? p.radius, color: l.color ?? p.color, intensity: base * flick, base, spot: spotOf(l) };
}
