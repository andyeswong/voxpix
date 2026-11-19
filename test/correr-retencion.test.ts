// shiftBakedJob no puede devolver un literal con accesores (get done, get shift, get prepared): V8 guarda los accesores de
// un literal en la forma oculta (map) del primer objeto creado ahí, colgada de la función que lo crea, y con ellos su
// contexto, que tiene el horneado. Así quedaba vivo para siempre el horneado del primer corrimiento (en el juego, uno de
// ~260 MB tras girar: FERN, con una instantánea del montón del navegador; la cadena acaba en AllocationSite → map →
// AccessorPair → get done → contexto → el horneado). Se comprueba la forma, no el recolector: forzar el gc desde node no
// daba un resultado estable aquí
import { it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels } from '../src/world/state';
import { bakeWorld, shiftBakedJob } from '../src/world/bake';

const pal: Palette = { ramps: [{ name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] }] };

it('ShiftJob: done, shift y prepared no son accesores propios del trabajo (están en su prototipo) y funcionan igual', () => {
  const s = new StaticVoxels(pal, 64, 64, 0, 31);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 8 + ((x >> 3) & 3); z++) s.set(x, y, z, material(0, 1 + ((x + y) & 1)));
  const b = bakeWorld({ model: s, lights: [], width: 64, depth: 64 }, { incline: 0.5 });
  const j = shiftBakedJob(b, 1, 0, { manual: true });
  for (const k of ['done', 'shift', 'prepared'] as const) {
    expect([k, Object.getOwnPropertyDescriptor(j, k)]).toEqual([k, undefined]);
    expect(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(j), k)?.get).toBe('function');
  }
  expect([j.done, j.prepared, j.shift]).toEqual([false, false, [1, 0]]);
  while (!j.run(Infinity));
  expect([j.done, j.prepared]).toEqual([false, true]);
  j.merge(1, 0);
  expect(j.shift).toEqual([2, 0]);
  while (!j.run(Infinity));
  expect(j.canCommit()).toBe(true);
  j.commit();
  expect([j.done, j.prepared]).toEqual([true, false]);
});
