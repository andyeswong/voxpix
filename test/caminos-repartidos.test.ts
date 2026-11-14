// LevelPathField con la búsqueda repartida (budget + advance): las mismas distancias que buscando de una vez, con
// cualquier tamaño de tanda; mientras busca, contesta con la última acabada; una meta que cambia en cada tick acaba
// igual; un cambio del mundo a media búsqueda la rehace. Y lo que guarda de cada paso (canMove) da lo mismo que un campo
// nuevo después de picar
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { LevelPathField, type LevelPoint } from '../src/world/levelpaths';
import { clearBox } from '../src/world/edit';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }] };
// Relieve en escalones de 4 (de 24 a 32), un túnel este-oeste (y 20..27, z 8..19) con un pozo a él, y unos pilares
function world(): WorldState {
  const s = new StaticVoxels(PAL, 64, 48, 0, 63);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
    const top = 24 + 4 * (((x >> 3) + (y >> 3)) % 3);
    for (let z = 0; z < top; z++) {
      const tunnel = y >= 20 && y < 28 && x >= 4 && x < 60 && z >= 8 && z < 20;
      const shaft = y >= 20 && y < 28 && x >= 52 && x < 60 && z >= 20;
      if (!tunnel && !shaft) s.set(x, y, z, material(0, 1));
    }
    if ((x & 15) === 7 && (y & 15) === 7) for (let z = top; z < top + 6; z++) s.set(x, y, z, material(0, 2));
  }
  return new WorldState(s, [], null);
}
const O = { cell: 4, radius: 1, height: 10, step: 8, maxDrop: 24 };
const dist = (f: LevelPathField) => Array.from((f as unknown as { dist: Int32Array }).dist);
const top = (st: WorldState, x: number, y: number) => st.solid.height[Math.floor(y) * st.solid.width + Math.floor(x)]!;
const at = (st: WorldState, x: number, y: number): LevelPoint => ({ x, y, z: top(st, x, y) });
const GOALS: Array<[number, number, number]> = [[10, 10, 0], [54, 40, 0], [30, 22, 12], [60, 6, 8], [6, 44, 0]];

describe('caminos por niveles, búsqueda repartida', () => {
  it('con cualquier tanda (1, 7, 100 nodos), las mismas distancias que de una vez', () => {
    const st = world();
    const whole = new LevelPathField(st, O);
    for (const budget of [1, 7, 100]) {
      const part = new LevelPathField(st, { ...O, budget });
      for (const [x, y, near] of GOALS) {
        const g = at(st, x, y);
        whole.dir(at(st, 2, 2), g, near);
        part.dir(at(st, 2, 2), g, near);
        let calls = 0;
        while (!part.advance()) calls++;
        expect(dist(part)).toEqual(dist(whole));
        if (budget === 1) expect(calls).toBeGreaterThan(100);    // de verdad repartida
      }
      part.close();
    }
    whole.close();
  });

  it('mientras busca, contesta con la última acabada; sin ninguna acabada, null', () => {
    const st = world();
    const f = new LevelPathField(st, { ...O, budget: 5 });
    const from = at(st, 2, 2), a = at(st, 60, 44), b = at(st, 6, 44);
    expect(f.dir(from, a)).toBeNull();                          // nada buscado todavía
    while (!f.advance());
    const toA = f.dir(from, a);
    expect(toA).not.toBeNull();
    // Otra meta: hasta que acabe, la dirección es la de a
    expect(f.dir(from, b)).toEqual(toA);
    f.advance();
    expect(f.dir(from, b)).toEqual(toA);
    while (!f.advance());
    const ref = new LevelPathField(st, O);
    expect(f.dir(from, b)).toEqual(ref.dir(from, b));
    f.close(); ref.close();
  });

  it('una meta que cambia en cada tick acaba igual: la búsqueda en marcha no se tira, y la última se busca después', () => {
    const st = world();
    const f = new LevelPathField(st, { ...O, budget: 200 });
    const from = at(st, 2, 2);
    let last = at(st, 10, 30);
    for (let t = 0; t < 40; t++) {
      last = at(st, 10 + t, 30 - (t >> 2));
      f.dir(from, last);
      f.advance();
    }
    while (!f.advance());
    const ref = new LevelPathField(st, O);
    ref.dir(from, last);
    expect(dist(f)).toEqual(dist(ref));
    f.close(); ref.close();
  });

  it('un cambio del mundo a media búsqueda la tira y la rehace con el mundo nuevo', () => {
    const st = world();
    const f = new LevelPathField(st, { ...O, budget: 50 });
    const from = at(st, 10, 10), goal = at(st, 30, 24);
    f.dir(from, goal);
    f.advance(); f.advance();
    clearBox(st, { x0: 24, y0: 16, z0: 20, x1: 39, y1: 31, z1: 63 });   // un hoyo hasta el túnel
    f.dir(from, goal);
    while (!f.advance());
    const ref = new LevelPathField(st, O);
    ref.dir(from, goal);
    expect(dist(f)).toEqual(dist(ref));
    f.close(); ref.close();
  });

  it('lo guardado de cada paso, tras picar y poner, da lo mismo que un campo nuevo', () => {
    const st = world();
    const f = new LevelPathField(st, O);
    // Algunas a media celda: lo que cambia de una celda también cambia los pasos que llegan a ella desde las vecinas
    const digs: Array<[number, number, number, number]> = [[8, 8, 4, 30], [40, 20, 6, 22], [52, 22, 8, 10], [20, 36, 4, 28], [14, 26, 3, 24], [30, 10, 2, 26], [46, 38, 3, 20]];
    for (const [x, y, w, z] of digs) {
      for (const [gx, gy, near] of GOALS) f.dir(at(st, 2, 2), at(st, gx, gy), near);    // llena lo guardado
      clearBox(st, { x0: x, y0: y, z0: z, x1: x + w - 1, y1: y + w - 1, z1: 63 });
      if (x === 40) for (let k = 0; k < 6; k++) st.solid.set(30 + k, 22, 20, material(0, 1));   // y algo puesto
      const ref = new LevelPathField(st, O);
      for (const [gx, gy, near] of GOALS) {
        f.dir(at(st, 2, 2), at(st, gx, gy), near);
        ref.dir(at(st, 2, 2), at(st, gx, gy), near);
        expect(dist(f)).toEqual(dist(ref));
        expect(f.path(at(st, 2, 2), at(st, gx, gy), near)).toEqual(ref.path(at(st, 2, 2), at(st, gx, gy), near));
      }
      ref.close();
    }
    f.close();
  });
  it('un pilar en el centro de una celda: el paso que llega desde la vecina (guardado en ella) también se rehace', () => {
    const s = new StaticVoxels(PAL, 32, 32, 0, 31);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let z = 0; z < 8; z++) s.set(x, y, z, material(0, 1));
    const st = new WorldState(s, [], null);
    const o = { cell: 4, radius: 0, height: 4, step: 2 };
    const f = new LevelPathField(st, o);
    const from = { x: 2, y: 10, z: 8 }, to = { x: 30, y: 10, z: 8 };
    f.dir(from, to);                                             // guarda los pasos de la fila, entre ellos (1,2) -> (2,2)
    for (let z = 8; z < 12; z++) s.set(10, 10, z, material(0, 1));   // la celda (2,2) sube a 12: no se sube con step 2
    const ref = new LevelPathField(st, o);
    expect(f.path(from, to)).toEqual(ref.path(from, to));
    expect(dist(f)).toEqual(dist(ref));
    f.close(); ref.close();
  });
});
