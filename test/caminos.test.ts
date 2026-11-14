// PathField y findPath: rodear un muro por su hueco, subir escalones de `step`, no bajar más de `maxDrop`, el radio del
// cuerpo, y el mundo que cambia (un muro abierto en partida, por watchChanges) sin rehacer el campo
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { PathField, findPath } from '../src/world/paths';
import { clearBox } from '../src/world/edit';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }] };
// Un suelo de 64 x 64 a z = 8 (lleno de 0 a 7)
function flat(): WorldState {
  const s = new StaticVoxels(PAL, 64, 64, 0, 40);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 8; z++) s.set(x, y, z, material(0, 1));
  return new WorldState(s, [], null);
}
const box = (st: WorldState, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => {
  for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) st.solid.set(x, y, z, material(0, 2));
};
const crosses = (p: Array<{ x: number; y: number }>, f: (q: { x: number; y: number }) => boolean) => p.some(f);

describe('caminos por el suelo', () => {
  it('rodea un muro alto por su hueco; sin hueco, no hay camino', () => {
    const st = flat();
    box(st, 0, 30, 8, 63, 33, 30);                                // un muro este-oeste, 23 de alto
    expect(findPath(st, { x: 10, y: 10 }, { x: 10, y: 50 })).toBeNull();
    clearBox(st, { x0: 48, y0: 30, z0: 8, x1: 55, y1: 33, z1: 30 });   // un hueco de 8
    const p = findPath(st, { x: 10, y: 10 }, { x: 10, y: 50 })!;
    expect(p).not.toBeNull();
    expect(crosses(p, (q) => q.y > 29 && q.y < 34 && q.x >= 48 && q.x <= 56)).toBe(true);
    expect(p.at(-1)).toMatchObject({ x: 10, y: 50 });
    // Una meta que no cae en el centro de su celda también se alcanza (su celda es la meta)
    expect(findPath(st, { x: 10, y: 10 }, { x: 13, y: 49 })?.at(-1)).toMatchObject({ x: 14, y: 50 });
  });

  it('un escalón de 8: con step 8 se sube por encima; con step 2 se rodea', () => {
    const st = flat();
    box(st, 0, 30, 8, 40, 33, 15);                                // un bordillo de 8 de alto que no llega al este
    const over = findPath(st, { x: 10, y: 10 }, { x: 10, y: 50 }, { step: 8 })!;
    expect(Math.max(...over.map((q) => q.x))).toBeLessThan(20);
    expect(over.some((q) => q.z === 16)).toBe(true);              // pisa encima del bordillo
    const around = findPath(st, { x: 10, y: 10 }, { x: 10, y: 50 }, { step: 2 })!;
    expect(Math.max(...around.map((q) => q.x))).toBeGreaterThan(40);
  });

  it('maxDrop: de una meseta de 16 se baja por la rampa si no se puede saltar', () => {
    const st = flat();
    box(st, 0, 0, 8, 63, 23, 23);                                 // meseta al sur, suelo a 24
    // Una rampa en el oeste: escalones de 2 de alto cada 4 de fondo (una celda), de y 24 a 55
    for (let k = 0; k < 8; k++) box(st, 0, 24 + 4 * k, 8, 7, 27 + 4 * k, 21 - 2 * k);
    const free = findPath(st, { x: 40, y: 10 }, { x: 40, y: 50 }, { step: 2 })!;
    expect(Math.min(...free.map((q) => q.x))).toBeGreaterThan(8);   // salta directamente
    const careful = findPath(st, { x: 40, y: 10 }, { x: 40, y: 50 }, { step: 2, maxDrop: 2 })!;
    expect(Math.min(...careful.map((q) => q.x))).toBeLessThan(8);   // baja por la rampa
    expect(findPath(st, { x: 40, y: 50 }, { x: 40, y: 10 }, { step: 2 })!.some((q) => q.x < 8)).toBe(true);   // y se sube por ella
  });

  it('el radio del cuerpo: un hueco de 4 deja pasar a uno de radio 1 y no a uno de radio 3', () => {
    const st = flat();
    box(st, 0, 30, 8, 63, 33, 30);
    clearBox(st, { x0: 32, y0: 30, z0: 8, x1: 35, y1: 33, z1: 30 });   // de 32 a 35: la celda de centro 34
    expect(findPath(st, { x: 10, y: 10 }, { x: 10, y: 50 }, { radius: 1 })).not.toBeNull();
    expect(findPath(st, { x: 10, y: 10 }, { x: 10, y: 50 }, { radius: 3 })).toBeNull();
  });

  it('el campo se pone al día con lo que cambia en el mundo (watchChanges), y dir apunta a la celda siguiente', () => {
    const st = flat();
    box(st, 0, 30, 8, 63, 33, 30);
    const f = new PathField(st);
    expect(f.dir({ x: 10, y: 10 }, { x: 10, y: 50 })).toBeNull();
    clearBox(st, { x0: 8, y0: 30, z0: 8, x1: 15, y1: 33, z1: 30 });
    const d = f.dir({ x: 10, y: 26 }, { x: 10, y: 50 })!;
    expect(d.y).toBeGreaterThan(0.7);                             // hacia el norte, por el hueco que ya está
    expect(f.at({ x: 10, y: 31 })).toMatchObject({ floor: 8 });
    expect(f.dir({ x: 10, y: 50 }, { x: 10, y: 50 })).toBeNull(); // ya está
    f.close();
  });
});
