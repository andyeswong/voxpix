// shiftGrid (state.ts): correr en su sitio una rejilla de W x H celdas de `per` elementos, contra una referencia celda a
// celda: tipados (copia de memoria) y arrays normales, todos los dx y dy (también los que se salen) y per 1 y 3
import { describe, it, expect } from 'vitest';
import { shiftGrid } from '../src/world/state';

function reference(a: ArrayLike<number>, W: number, H: number, per: number, dx: number, dy: number, fill: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let k = 0; k < per; k++) {
    const sx = x + dx, sy = y + dy;
    out.push(sx < 0 || sy < 0 || sx >= W || sy >= H ? fill : a[(sy * W + sx) * per + k]!);
  }
  return out;
}

describe('shiftGrid', () => {
  for (const [W, H] of [[7, 5], [1, 4], [6, 1], [9, 9]] as const) for (const per of [1, 3]) it(`${W} x ${H}, per ${per}: igual que la referencia con todos los dx y dy`, () => {
    let cases = 0;
    for (let dy = -H - 1; dy <= H + 1; dy++) for (let dx = -W - 1; dx <= W + 1; dx++) {
      const src = Array.from({ length: W * H * per }, (_, i) => i + 1);
      const want = reference(src, W, H, per, dx, dy, -7);
      const t = Float32Array.from(src);
      shiftGrid(t, W, H, per, dx, dy, -7);
      expect([dx, dy, [...t]]).toEqual([dx, dy, want]);
      const n = src.slice();
      shiftGrid(n, W, H, per, dx, dy, -7);
      expect([dx, dy, n]).toEqual([dx, dy, want]);
      cases++;
    }
    expect(cases).toBe((2 * H + 3) * (2 * W + 3));
  });
});
