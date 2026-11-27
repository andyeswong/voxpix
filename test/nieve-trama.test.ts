// La trama de la nieve mientras cuaja (src/world/precipitation.ts, applyCover): va por filas de la imagen, no por la y del
// mundo. Con incline 0,5 cada fila salta 2 en y y por la y solo salían dos filas de la Bayer, a rayas verticales. Cada 4 x 4
// de suelo abierto lleva justo la nieve que toca, con cualquier incline y en los 4 giros, y la trama sigue al mundo cuando la
// ventana se corre
import { describe, expect, it } from 'vitest';
import { material, type Palette } from '../src/core';
import { bakeWorld, type Baked } from '../src/world/bake';
import { frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather } from '../src/world/weather';

const PAL: Palette = { ramps: [{ name: 'suelo', colors: ['#202020', '#606060', '#808080'] }] };
const S = 96;
// Un suelo plano de 3 de alto, desplazado dy en y (lo que hace una ventana que se corre: el mundo entra por un lado)
function setup(q: Quarter, incline: number, dy = 0) {
  const s = new StaticVoxels(PAL, S, S, -4, 23);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let z = 0; z < 3; z++) s.set(x, y, z, material(0, 1 + ((x + y + dy) & 1)));
  const state = new WorldState(s, [], null, { seed: 1 }), view = new WorldView(state, q);
  return { state, view, b: bakeWorld(view.bakeable(), { topZ: 28, incline, sky: true }) };
}
const snowed = (snow: number) => { const w = new Weather({ seed: 3, levels: {} }); w.importState({ ...w.exportState(), snow, wet: 0 }); return w; };
const opts = (b: Baked, w: Weather | null, origin?: [number, number]): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8], weather: w ? { weather: w, tick: 0, cover: true, ...(origin ? { origin } : {}) } : null });
// 1 donde hay nieve; -1 donde no es suelo abierto (cara de arriba con todo el cielo)
function mask(st: ReturnType<typeof setup>, snow: number, origin?: [number, number]): Int8Array {
  const { state, b } = st, ref = frame2DParts(state, b, opts(b, null)).view, p = frame2DParts(state, b, opts(b, snowed(snow), origin)).view;
  const m = new Int8Array(b.width * b.height);
  for (let i = 0; i < m.length; i++) m[i] = b.face[i] !== 4 || b.sky![i] !== 5 ? -1 : p[i * 4] !== ref[i * 4] ? 1 : 0;
  return m;
}

describe('la trama de la nieve', () => {
  for (const incline of [0.5, 0.6, 1]) for (const q of [0, 1, 2, 3] as Quarter[]) {
    it(`cada 4 x 4 de suelo abierto lleva justo la nieve que toca (incline ${incline}, giro ${q})`, () => {
      const st = setup(q, incline), W = st.b.width, H = st.b.height;
      for (const k of [1, 4, 6, 8, 11, 15]) {
        const m = mask(st, k / 16);
        let blocks = 0;
        for (let y = 0; y + 4 <= H; y += 3) for (let x = 0; x + 4 <= W; x += 3) {
          let n = 0, open = true;
          for (let j = 0; j < 4 && open; j++) for (let i = 0; i < 4; i++) { const v = m[(y + j) * W + x + i]!; if (v < 0) { open = false; break; } n += v; }
          if (!open) continue;
          blocks++;
          expect([k, x, y, n]).toEqual([k, x, y, k]);
        }
        expect(blocks).toBeGreaterThan(50);
        // y en todo el suelo abierto, la parte con nieve es la cantidad (más o menos lo que no llena un 4 x 4 del borde)
        let on = 0, open = 0;
        for (const v of m) if (v >= 0) { open++; on += v; }
        expect(Math.abs(on / open - k / 16)).toBeLessThan(0.01);
      }
    });
  }

  it('al correrse la ventana, cada punto del mundo lleva la nieve que llevaba', () => {
    // (incline 0,5 con dy 2 corre la imagen 1 fila; incline 1 con dy 3, 3 filas: un desfase impar)
    for (const [incline, dy] of [[0.5, 2], [1, 3], [0.5, 8]] as const) {
      const a = setup(0, incline), b = setup(0, incline, dy), rows = Math.round(incline * dy), W = a.b.width;
      expect(b.b.width).toBe(W);
      for (const k of [4, 8, 11]) {
        const m0 = mask(a, k / 16), m1 = mask(b, k / 16, [0, dy]);
        let same = 0;
        // (el punto de la fila y de la primera es la fila y + rows de la segunda: lo que era y + dy ahora es y)
        for (let y = 0; y + rows < a.b.height; y++) for (let x = 0; x < W; x++) {
          const v0 = m0[y * W + x]!, v1 = m1[(y + rows) * W + x]!;
          if (v0 < 0 || v1 < 0) continue;
          expect([incline, k, x, y, v1]).toEqual([incline, k, x, y, v0]);
          same++;
        }
        expect(same).toBeGreaterThan(500);
      }
    }
  });
});
