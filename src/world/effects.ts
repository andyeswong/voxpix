// Los efectos y partículas (src/core/effects.ts) en el cuadro del mundo: se pintan con la misma cámara y prueba de
// profundidad que el resto, antes de las gotas, sin escribir profundidad (como la GPU: en un mismo píxel gana la
// última). Las que llevan luz se ven con luz propia y, hasta su tope, alumbran como luces dinámicas del mundo.
import { FX_STRIDE, type FxSource, type FxSystem } from '../core';
import type { Baked } from './bake';
import type { WorldLight } from './build';
import type { RenderState } from './state';
import { EMISSIVE_LIGHT } from './frame2d';

// Lo que un RenderState lleva de efectos: los sistemas que pintar (en orden) y las luces que dan (ya con tope)
export interface EffectsLayer {
  readonly sources: readonly FxSource[];
  lights(): readonly WorldLight[];
}

// Las luces de las partículas como luces dinámicas del mundo (una linterna sin parpadeo, con su color e intensidad)
export function fxWorldLights(fx: FxSystem, map?: (x: number, y: number) => [number, number], prefix = 'fx'): WorldLight[] {
  return fx.lights().map((l, k) => {
    const [x, y] = map ? map(l.x, l.y) : [l.x, l.y];
    return { id: `${prefix}-${k}`, kind: 'lantern', x, y, z: l.z, radius: l.radius, intensity: l.intensity, color: l.color, baked: false };
  });
}

// El estado para el render con las luces de los efectos sumadas a las del mundo (el mismo objeto si no hay ninguna)
export function withEffectLights(state: RenderState): RenderState {
  const fx = state.effects?.lights();
  if (!fx?.length) return state;
  return { entities: state.entities, lights: [...state.lights, ...fx], water: state.water, drops: state.drops, palette: state.palette, effects: state.effects };
}

export function drawEffectsLayer(fx: EffectsLayer, b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null,
  vx: number, vy: number, vw: number, vh: number): void {
  for (const s of fx.sources) drawEffects(s, b, view, depthBuf, total, vx, vy, vw, vh);
}

// Pinta los puntos de un efecto en la vista (CPU; la GPU hace lo mismo en compositor.ts)
export function drawEffects(src: FxSource, b: Baked, view: Uint8ClampedArray, depthBuf: Float32Array, total: Float32Array | null,
  vx: number, vy: number, vw: number, vh: number): void {
  const n = src.count, d = src.packed;
  for (let k = 0; k < n; k++) {
    const q = k * FX_STRIDE;
    const [sx, sy, depth] = b.cam.project(d[q]!, d[q + 1]!, d[q + 2]!);
    const tx = Math.floor(sx) - vx, ty = Math.floor(sy) - vy, px = d[q + 6]!, em = d[q + 7]! > 0;
    for (let j = 0; j < px; j++) for (let i = 0; i < px; i++) {
      const x = tx + i, y = ty + j;
      if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
      const t = y * vw + x;
      if (depth >= depthBuf[t]! - 0.3) continue;
      view[t * 4] = d[q + 3]!; view[t * 4 + 1] = d[q + 4]!; view[t * 4 + 2] = d[q + 5]!;
      if (em && total) total.fill(EMISSIVE_LIGHT, t * 3, t * 3 + 3);
    }
  }
}
