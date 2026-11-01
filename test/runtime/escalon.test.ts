import { describe, it, expect } from 'vitest';
import { material } from '../../src/core';
import { StaticVoxels, WorldState } from '../../src/world/state';
import { moveBody, restZ, type Body } from '../../src/runtime/body';

// Subir escalones en diagonal: en un mismo movimiento el primer eje puede subir un escalón y el segundo tiene que
// comprobar con los pies ya arriba. Si la altura se tomara solo al final del movimiento, el segundo eje vería los pies
// abajo y el cuerpo se clavaría en una escalera que sí se sube (16 de 405 recorridos distintos, FERN 2026-10-31).
describe('escalones en diagonal', () => {
  // Sala de 120x120 con suelo en z = 1; escalera: +2 al cruzar x = 40 y otros +2 al cruzar además y = 40
  function sala(): WorldState {
    const s = new StaticVoxels({ ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060'] }] }, 120, 120, -4, 30);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) {
      const top = x >= 40 && x < 60 && y < 60 ? (y >= 40 ? 5 : 3) : 1;
      for (let z = 0; z < top; z++) s.set(x, y, z, material(0, 1));
    }
    return new WorldState(s, [], null);
  }

  it('cruzando la escalera en diagonal no se clava en el borde', () => {
    const w = sala();
    const b: Body = { x: 28, y: 33, z: 0, r: 6 };
    b.z = restZ(w, b.x, b.y, b.r);
    const v = 0.9 / Math.SQRT2;
    for (let i = 0; i < 60; i++) moveBody(w, b, v, v);
    // Con la altura por eje llega a x ≈ 66; con la altura solo al final se quedaba en x ≈ 42, contra el primer borde
    expect(b.x).toBeGreaterThan(60);
  });
});
