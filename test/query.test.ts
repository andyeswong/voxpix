import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorldState } from '../src/world/build';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060'] }] };

// Suelo de 40x30 (cara de arriba en z = 1), una columna de 4x4 de alto 12 y un escalón de 2 de alto
function room(): WorldState {
  const s = new StaticVoxels(PAL, 40, 30, -4, 20);
  for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) s.set(x, y, 0, material(0, 1));
  for (let z = 1; z <= 12; z++) for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) s.set(x, y, z, material(0, 2));
  for (let y = 20; y < 25; y++) for (let x = 25; x < 30; x++) { s.set(x, y, 1, material(0, 2)); s.set(x, y, 2, material(0, 2)); }
  return new WorldState(s, [], null);
}

describe('consultas del mundo (WorldQuery)', () => {
  it('solidAt y groundAt: enteros, la cara de arriba del sólido más alto', () => {
    const w = room();
    expect(w.solidAt(5, 5, 0)).toBe(true);
    expect(w.solidAt(5, 5, 1)).toBe(false);
    expect(w.groundAt(5, 5)).toBe(1);
    expect(w.groundAt(11.7, 12.2)).toBe(13);
    expect(w.groundAt(26, 21)).toBe(3);
    expect(Number.isInteger(w.groundAt(3.4, 7.9))).toBe(true);
  });

  it('groundAt sigue a los cambios: poner encima sube, quitar el de arriba baja al siguiente', () => {
    const w = room();
    w.solid.set(5, 5, 6, material(0, 0));
    expect(w.groundAt(5, 5)).toBe(7);
    w.solid.set(5, 5, 6, 0);
    expect(w.groundAt(5, 5)).toBe(1);
    w.solid.set(5, 5, 0, 0);
    expect(w.groundAt(5, 5)).toBe(w.solid.zMin);          // sin nada: vacío
  });

  it('standable: sube un escalón de 2, no una columna; no pisa el vacío ni fuera del mundo', () => {
    const w = room();
    expect(w.standable(5, 5, 1, 2)).toBe(true);
    expect(w.standable(26, 21, 1, 2)).toBe(true);          // escalón de 2
    expect(w.standable(26, 21, 1, 1)).toBe(false);         // con paso de 1, no
    expect(w.standable(11, 11, 1, 2)).toBe(false);         // la columna
    expect(w.standable(-1, 5, 1, 2)).toBe(false);
    w.solid.set(7, 7, 0, 0);
    expect(w.standable(7, 7, 1, 2)).toBe(false);           // agujero
  });

  it('raycast: da con la columna, en su cara, con la normal hacia fuera', () => {
    const w = room();
    const r = w.raycast([2, 12, 5], [30, 12, 5]);
    expect(r).not.toBeNull();
    expect(r!.hit[0]).toBeCloseTo(10, 5);
    expect(r!.normal).toEqual([-1, 0, 0]);
    expect(w.raycast([2, 2, 5], [30, 2, 5])).toBeNull();   // por un sitio libre no da con nada
  });

  it('en un nivel real: el agua honda no se pisa y el borde de la fuente tampoco', () => {
    const { state, world } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval');
    const w = state.water!;
    let deep: [number, number] | null = null;
    for (let i = 0; i < w.sim.depth.length && !deep; i++) if (!w.sim.solid[i] && w.sim.depth[i]! > 4.6) deep = [(i % w.gw) * 2, Math.floor(i / w.gw) * 2];
    expect(deep).not.toBeNull();
    expect(state.waterAt(deep![0], deep![1])!.depth).toBeGreaterThan(4.5);
    expect(state.standable(deep![0], deep![1], state.groundAt(deep![0], deep![1]), 2)).toBe(false);
    const f = world.fountain!;
    // Desde el suelo de fuera, el borde (alto 5) no se sube; el agua de dentro sí está en el mismo sitio que dibuja el modo vóxel
    expect(state.standable(f.x + f.radius + 1, f.y, 1, 2)).toBe(false);
    expect(state.waterAt(f.x + 6, f.y)!.surface).toBeCloseTo(f.level, 1);
  });
});
