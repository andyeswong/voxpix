// finishShift (state.ts), tras shift y shiftJob: los trozos que entran y los del borde nuevo (un vecino que estaba dentro
// queda fuera) reciben versión nueva, en orden de filas, con su caja entera como cambiada; los del borde, además, sin
// máscaras de lo expuesto. Contra el criterio escrito a mano, para todos los corrimientos de una rejilla pequeña
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { CHUNK, StaticVoxels } from '../src/world/state';

const PAL = { ramps: [{ name: 'piedra', colors: ['#303030', '#606060', '#909090'] }] };

// Lo que tiene que marcarse, en el orden en que se marca: [trozo, borde]
function expected(C: number, R: number, dcx: number, dcy: number): Array<[number, boolean]> {
  const inOld = (x: number, y: number) => x >= 0 && y >= 0 && x < C && y < R;
  const out: Array<[number, boolean]> = [];
  for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) {
    const entered = !inOld(cx + dcx, cy + dcy);
    const edge = !entered && ((cx === 0 && inOld(cx - 1 + dcx, cy + dcy)) || (cx === C - 1 && inOld(cx + 1 + dcx, cy + dcy)) ||
      (cy === 0 && inOld(cx + dcx, cy - 1 + dcy)) || (cy === R - 1 && inOld(cx + dcx, cy + 1 + dcy)));
    if (entered || edge) out.push([cy * C + cx, edge]);
  }
  return out;
}

type Priv = { versions: Uint32Array; seg: Int32Array; segN: Uint8Array; expoAt: Float64Array; nz: number; clock: number };

describe('correr: lo que entra y el borde nuevo', () => {
  for (const [C, R] of [[5, 4], [1, 3], [4, 1], [6, 6]] as const) for (const byJob of [false, true]) it(`${C} x ${R} trozos${byJob ? ', por pasos' : ''}: cada corrimiento marca lo esperado, en orden`, () => {
    let cases = 0;
    for (let dcy = -R - 1; dcy <= R + 1; dcy++) for (let dcx = -C - 1; dcx <= C + 1; dcx++) {
      if (!dcx && !dcy) continue;
      const s = new StaticVoxels(PAL, C * CHUNK, R * CHUNK, 0, 31);
      for (let y = 0; y < R * CHUNK; y += 3) for (let x = 0; x < C * CHUNK; x += 3) s.set(x, y, 2, material(0, 1));
      s.forEachExposed(() => {});
      const p = s as unknown as Priv, clock0 = p.clock;
      if (byJob) { const j = s.shiftJob(dcx, dcy); while (!j.step()); j.commit(); } else s.shift(dcx, dcy);
      const got: Array<[number, boolean]> = [];
      const marked = [...p.versions.keys()].filter((c) => p.versions[c]! > clock0).sort((a, b) => p.versions[a]! - p.versions[b]!);
      for (const c of marked) {
        // (la caja: el trozo entero, y solo ella)
        const o = c * (p.seg.length / (C * R)), cx = c % C, cy = (c - cx) / C;
        expect([dcx, dcy, c, p.segN[c], [...p.seg.subarray(o + 1, o + 7)]]).toEqual([dcx, dcy, c, 1, [cx * CHUNK, cy * CHUNK, 0, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1, 31]]);
        let stamped = false;
        for (let k = 0; k < p.nz; k++) if (p.expoAt[c * p.nz + k] !== -1) stamped = true;
        got.push([c, !stamped && !!expected(C, R, dcx, dcy).find(([e, b]) => e === c && b)]);
      }
      expect([dcx, dcy, got]).toEqual([dcx, dcy, expected(C, R, dcx, dcy)]);
      cases++;
    }
    expect(cases).toBeGreaterThan(8);
  });
});
