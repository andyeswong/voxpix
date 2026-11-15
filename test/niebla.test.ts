// La niebla por altura (Frame2DOptions.fog): con una columna sobre un suelo plano y el foco en la cima, el suelo sale
// mezclado hacia el color y la cima no; cada píxel, con la mezcla que le toca a la z de lo que se ve en él (la de
// worldPointAt, calculada aquí aparte); sin niebla o con fuerza 0, el cuadro de siempre byte a byte; y el foco puede
// moverse en cada cuadro sin rehornear
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld, worldPointAt } from '../src/world/bake';
import { frame2D, type Frame2DOptions, type HeightFog } from '../src/world/frame2d';

const PAL = { ramps: [{ name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] }] };
const FLOOR = 8, TOP = 24;
// Suelo de 48 x 48 hasta z 8; una columna de 8 x 8 en el centro hasta z 24
function setup() {
  const s = new StaticVoxels(PAL, 48, 48, 0, 31);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const top = x >= 20 && x < 28 && y >= 20 && y < 28 ? TOP : FLOOR;
    for (let z = 0; z < top; z++) s.set(x, y, z, material(0, 1));
  }
  const st = new WorldState(s, [], null);
  const b = bakeWorld({ model: st.solid, lights: [], width: 48, depth: 48 }, { topZ: 31, incline: 0.5 });
  return { st, b };
}
const FOG: HeightFog = { focusZ: TOP, start: 2, full: 10, color: [200, 40, 120], strength: 0.8 };

describe('niebla por altura', () => {
  const { st, b } = setup();
  const o = (fog?: HeightFog | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: false, ambient: [1, 1, 1], ...(fog !== undefined ? { fog } : {}) });
  const plain = frame2D(st, b, o());

  it('sin niebla, null o fuerza 0: el cuadro de siempre', () => {
    expect(frame2D(st, b, o(null))).toEqual(plain);
    expect(frame2D(st, b, o({ ...FOG, strength: 0 }))).toEqual(plain);
  });

  it('el suelo sale mezclado del todo, la cima intacta, y cada píxel con la mezcla de su z', () => {
    const fogged = frame2D(st, b, o(FOG));
    let floor = 0, top = 0, side = 0;
    for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
      const i = (sy * b.width + sx) * 4, p = worldPointAt(b, sx, sy);
      if (!p) { expect(fogged.slice(i, i + 4)).toEqual(plain.slice(i, i + 4)); continue; }
      const z = p[2];
      // La mezcla esperada, aparte: 0 por encima de focusZ - start, fuerza por debajo de focusZ - full, en línea entre medias
      const k = Math.floor((z >= TOP - 2 ? 0 : z <= TOP - 10 ? 0.8 : 0.8 * (TOP - 2 - z) / 8) * 256 + 0.5) / 256;
      for (let c = 0; c < 3; c++) expect(fogged[i + c]).toBe(Math.floor(plain[i + c]! + (FOG.color[c]! - plain[i + c]!) * k + 0.5));
      if (Math.abs(z - FLOOR) < 1e-3) { floor++; expect(fogged[i]).not.toBe(plain[i]); }
      else if (Math.abs(z - TOP) < 1e-3) { top++; expect(fogged.slice(i, i + 4)).toEqual(plain.slice(i, i + 4)); }
      else if (k > 0 && k < 0.79) side++;
    }
    expect(floor).toBeGreaterThan(500);
    expect(top).toBeGreaterThan(30);
    expect(side).toBeGreaterThan(20);                              // el tramo en línea, en las caras de la columna
  });

  it('el foco se mueve sin rehornear: con el foco a ras del suelo, el suelo y la columna no cambian; más arriba, también la cima', () => {
    const low = frame2D(st, b, o({ ...FOG, focusZ: FLOOR + 2 }));
    let n = 0;
    for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
      const p = worldPointAt(b, sx, sy), i = (sy * b.width + sx) * 4;
      if (p && p[2] > FLOOR - 1e-3) { n++; expect(low.slice(i, i + 4)).toEqual(plain.slice(i, i + 4)); }
      else if (p) expect(low[i]).not.toBe(plain[i]);              // el canto del suelo, por debajo
    }
    expect(n).toBeGreaterThan(1000);
    const high = frame2D(st, b, o({ ...FOG, focusZ: TOP + 20 }));
    const [sx, sy] = b.cam.project(24, 24, TOP), i = (Math.floor(sy) * b.width + Math.floor(sx)) * 4;
    expect(high[i]).not.toBe(plain[i]);
  });
});
