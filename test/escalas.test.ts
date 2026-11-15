// Trepar (moveBodyLevels con up): un cuerpo que toca un vóxel de un material con ladder sube, baja o se queda sin
// caer; sale por arriba andando hacia el suelo de arriba; y un material sin ladder no cambia nada
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { moveBodyLevels, LEVEL_RULES, LADDER_SPEED, type LevelBody } from '../src/runtime/levels';

// Suelo a z = 16; un muro en x 30..37 hasta z = 40; contra su cara oeste (x = 29), una columna de escala de z 16 a 39
function wall(ladder: boolean): WorldState {
  const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }, { name: 'escala', colors: ['#3a2614', '#5a3c20', '#7a5430'], material: ladder ? 'escala' : 'atravesable' }] };
  const s = new StaticVoxels(PAL, 64, 64, 0, 63);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < (x >= 30 && x < 38 ? 40 : 16); z++) s.set(x, y, z, material(0, 1));
  for (let y = 28; y < 36; y++) for (let z = 16; z < 40; z++) s.set(29, y, z, material(1, 1));
  return new WorldState(s, [], null);
}
const body = (): LevelBody => ({ x: 25, y: 32, z: 16, r: 2, height: 12, vz: 0 });
const step = (w: WorldState, b: LevelBody, dx: number, up: number) => moveBodyLevels(w, b, dx, 0, false, LEVEL_RULES, up);

describe('trepar', () => {
  it('sube tocando la escala y sale arriba al suelo andando hacia él; nunca cuenta caída', () => {
    const w = wall(true), b = body();
    for (let t = 0; t < 20; t++) step(w, b, 0.5, 0);                          // contra la pared
    expect(b.x).toBeCloseTo(28, 3); expect(b.z).toBe(16);
    let landed = 0, climbed = 0;
    for (let t = 0; t < 200 && b.x < 32; t++) { const m = step(w, b, 0.5, 1); landed = Math.max(landed, m.landed); if (m.climbing) climbed++; }
    expect(climbed).toBeGreaterThan(40);                                        // 24 vóxeles a LADDER_SPEED
    expect(b.z).toBe(40); expect(b.x).toBeGreaterThan(30);                      // encima del muro
    expect(landed).toBe(0);
  });

  it('a media escala, sin entrada se queda (no cae); abajo baja hasta el suelo sin caída', () => {
    const w = wall(true), b = body();
    for (let t = 0; t < 20; t++) step(w, b, 0.5, 0);
    for (let t = 0; t < 30; t++) step(w, b, 0, 1);
    const z = b.z;
    expect(z).toBeCloseTo(16 + 30 * LADDER_SPEED, 6);
    for (let t = 0; t < 60; t++) expect(step(w, b, 0, 0).climbing).toBe(true);
    expect(b.z).toBe(z);
    let landed = 0;
    for (let t = 0; t < 60; t++) landed = Math.max(landed, step(w, b, 0, -1).landed);
    expect(b.z).toBe(16); expect(landed).toBe(0);
  });

  it('sin ladder en el material, lo mismo que antes: no trepa y up no hace nada', () => {
    const w = wall(false), a = body(), c = body();
    for (let t = 0; t < 60; t++) { const m = step(w, a, 0.5, 1); expect(m.climbing).toBe(false); moveBodyLevels(w, c, 0.5, 0, false, LEVEL_RULES); }
    expect([a.x, a.y, a.z, a.vz]).toEqual([c.x, c.y, c.z, c.vz]);
    expect(a.z).toBe(16);
  });

  it('determinista: la misma subida da los mismos pasos', () => {
    const trace = () => { const w = wall(true), b = body(), out: number[] = []; for (let t = 0; t < 120; t++) { step(w, b, 0.4, t % 50 < 40 ? 1 : 0); out.push(b.x, b.z); } return out; };
    expect(trace()).toEqual(trace());
  });
});
