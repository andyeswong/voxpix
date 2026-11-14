// moveBodyLevels: andar por un túnel bajo un techo, caer por un hueco (y cuánto), saltar un bloque, chocar con un techo
// al saltar, no pasar por una pared, y que sea determinista
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { moveBodyLevels, footBelow, LEVEL_RULES, type LevelBody } from '../src/runtime/levels';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }] };
// Roca maciza hasta z = 40 con un túnel este-oeste de y 20..27 y z 16..31 (suelo a 16, techo a 32)
function cave(): WorldState {
  const s = new StaticVoxels(PAL, 64, 64, 0, 63);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 40; z++) {
    if (y >= 20 && y < 28 && z >= 16 && z < 32) continue;
    s.set(x, y, z, material(0, 1));
  }
  return new WorldState(s, [], null);
}
const body = (x: number, y: number, z: number): LevelBody => ({ x, y, z, r: 2, height: 12, vz: 0 });
const run = (w: WorldState, b: LevelBody, ticks: number, dx: number, dy: number, jump = () => false) => {
  let landed = 0;
  for (let t = 0; t < ticks; t++) landed = Math.max(landed, moveBodyLevels(w, b, dx, dy, jump()).landed);
  return landed;
};

describe('moverse por niveles', () => {
  it('footBelow: el suelo bajo una z, también debajo de un techo', () => {
    const w = cave();
    expect(footBelow(w, 10, 24, 63)).toBe(40);                   // arriba
    expect(footBelow(w, 10, 24, 30)).toBe(16);                   // en el túnel
    expect(footBelow(w, 10, 10, 30)).toBe(30);                   // dentro de la roca: el vóxel de debajo
  });

  it('anda por el túnel bajo el techo sin subirse a él, y no atraviesa la pared del fondo', () => {
    const w = cave(), b = body(5, 24, 16);
    run(w, b, 120, 0.5, 0);
    expect(b.x).toBeGreaterThan(55); expect(b.z).toBe(16);
    const y0 = b.y;
    run(w, b, 40, 0, 0.5);                                        // contra la pared norte del túnel
    expect(b.y).toBeLessThan(28 - 2 + 0.01); expect(b.y).toBeGreaterThanOrEqual(y0);
  });

  it('cae por un hueco con gravedad y dice cuánto cayó', () => {
    const w = cave();
    for (let z = 32; z < 40; z++) for (let y = 22; y < 26; y++) for (let x = 30; x < 34; x++) w.solid.set(x, y, z, 0);   // un pozo al túnel
    const b = { ...body(32, 24, 40), r: 1.5 };
    const landed = run(w, b, 120, 0, 0);
    expect(b.z).toBe(16); expect(landed).toBe(24);
  });

  it('al aire libre salta un escalón de 8 que andando no sube; en el túnel, el techo corta el salto', () => {
    const w = cave();
    for (let z = 40; z < 48; z++) for (let y = 0; y < 64; y++) for (let x = 40; x < 64; x++) w.solid.set(x, y, z, material(0, 2));   // un escalón de 8 arriba
    const b = body(30, 10, 40);
    run(w, b, 60, 0.5, 0);
    expect(b.x).toBeLessThan(40); expect(b.z).toBe(40);           // andando, no
    let k = 0;
    run(w, b, 80, 0.5, 0, () => (k++ % 30) === 0);
    expect(b.x).toBeGreaterThan(40); expect(b.z).toBe(48);
    expect(b.x).toBeLessThanOrEqual(62);                          // el borde del mundo es pared
    // En el túnel (suelo 16, techo 32) con 12 de alto quedan 4: el salto no pasa de ahí
    const c = body(10, 24, 16);
    let top = 0;
    moveBodyLevels(w, c, 0, 0, true);
    for (let t = 0; t < 40; t++) { moveBodyLevels(w, c, 0, 0); top = Math.max(top, c.z); }
    expect(top).toBeLessThanOrEqual(20); expect(top).toBeGreaterThan(17);
    expect(c.z).toBe(16);
  });

  it('el mismo recorrido da el mismo resultado', () => {
    const go = () => { const w = cave(), b = body(5, 24, 16); let k = 0; run(w, b, 200, 0.37, 0.05, () => (k++ % 17) === 0); return [b.x, b.y, b.z, b.vz]; };
    expect(go()).toEqual(go());
    expect(LEVEL_RULES.step).toBe(2);
  });
});
