// Editar el mundo en partida: stampModel, clearBox, la prioridad de FrameBudget y near en rebakeChangedJobs
import { describe, it, expect } from 'vitest';
import { material, Model } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { stampModel, clearBox, turnCell, type Yaw } from '../src/world/edit';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { FrameBudget, type ViewJob } from '../src/view/budget';

const STONE = { name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080'] };
const WOOD = { name: 'madera', colors: ['#301808', '#603818', '#905828'] };

function world(): WorldState {
  const s = new StaticVoxels({ ramps: [WOOD, STONE] }, 64, 64, 0, 31);       // la piedra es la rampa 1 del mundo
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 8; z++) s.set(x, y, z, material(1, 1));
  return new WorldState(s, [], null);
}
// Un bloque de 4x4x4 de piedra (rampa 0 de SU paleta) con un vóxel de madera en una esquina
function block(): Model {
  const m = new Model({ ramps: [{ ...STONE, colors: [...STONE.colors] }, WOOD] }, 'bloque');
  for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) m.set(x, y, z, material(0, 2));
  m.set(0, 0, 3, material(1, 1));
  return m;
}

describe('stampModel y clearBox', () => {
  it('pone el modelo con sus rampas pasadas a las del mundo y da la caja de lo que cambió; repetir no cambia nada', () => {
    const st = world(), m = block();
    expect(stampModel(st, m, 10, 12, 8)).toEqual({ x0: 10, y0: 12, z0: 8, x1: 13, y1: 15, z1: 11 });
    expect(st.solid.get(11, 13, 9)).toBe(material(1, 2));       // piedra: rampa 0 del modelo -> 1 del mundo
    expect(st.solid.get(10, 12, 11)).toBe(material(0, 1));      // madera: 1 -> 0
    expect(stampModel(st, m, 10, 12, 8)).toBeNull();
    // Metido en el suelo (piedra de otro tono): cambia todo; y otra vez, nada
    expect(stampModel(st, m, 30, 30, 4)).toEqual({ x0: 30, y0: 30, z0: 4, x1: 33, y1: 33, z1: 7 });
    expect(stampModel(st, m, 30, 30, 4)).toBeNull();
  });

  it('girado: 4 cuartos de vuelta vuelven al sitio, y 90 lleva el sur al este', () => {
    for (const [x, y] of [[0, 0], [3, -2], [-5, 7]] as const) {
      let p: [number, number] = [x, y];
      for (let k = 0; k < 4; k++) p = turnCell(p[0], p[1], 90);
      expect(p).toEqual([x, y]);
    }
    const st = world(), m = new Model({ ramps: [STONE] });
    m.set(0, -1, 0, material(0, 1));                             // un vóxel al sur del origen
    stampModel(st, m, 20, 20, 8, 90 as Yaw);
    expect(st.solid.get(20, 20, 8)).toBe(material(1, 1));        // al este del origen: la celda (0, 0) girada
    expect(turnCell(0, -1, 90)).toEqual([0, 0]);
  });

  it('una rampa que no está en el mundo es un error claro', () => {
    const st = world(), m = new Model({ ramps: [{ name: 'oro', colors: ['#aa8800', '#ffdd00'] }] });
    m.set(0, 0, 0, material(0, 1));
    expect(() => stampModel(st, m, 0, 0, 10)).toThrow(/oro/);
  });

  it('clearBox vacía y da la caja de lo que estaba lleno; watchChanges la ve; rehornear da lo mismo que de cero', () => {
    const st = world();
    const b = bakeWorld({ model: st.solid, lights: [], width: 64, depth: 64 }, { topZ: 31, incline: 0.5 });
    const watch = st.watchChanges();
    expect(clearBox(st, { x0: 5, y0: 5, z0: 4, x1: 8, y1: 8, z1: 20 })).toEqual({ x0: 5, y0: 5, z0: 4, x1: 8, y1: 8, z1: 7 });
    expect(clearBox(st, { x0: 5, y0: 5, z0: 4, x1: 8, y1: 8, z1: 20 })).toBeNull();
    expect(watch.take().boxes).toEqual([{ x0: 5, y0: 5, z0: 4, x1: 8, y1: 8, z1: 7, cause: 'voxels' }]);
    for (const j of rebakeChangedJobs(b, [])) while (!j.run(Infinity)) { /* */ }
    const f = bakeWorld({ model: st.solid, lights: [], width: 64, depth: 64 }, { topZ: 31, incline: 0.5 });
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(f.rgba.buffer))).toBe(true);
  });
});

describe('lo cercano primero', () => {
  it('FrameBudget: los de prioridad más baja van antes; los que no la llevan, detrás y en su orden', () => {
    const order: string[] = [];
    const job = (key: string, priority?: number): ViewJob => ({ key, priority, run: () => { order.push(key); return true; } });
    const q = new FrameBudget(1000);
    q.push(job('a')); q.push(job('b')); q.push(job('c', 5)); q.push(job('d', 1)); q.push(job('e', 5));
    q.push(job('a', 3));                                          // la misma key: sustituye y se recoloca
    q.run();
    expect(order).toEqual(['d', 'a', 'c', 'e', 'b']);
  });

  it('rebakeChangedJobs con near: el recuadro del cambio cercano antes que el lejano', () => {
    const st = world();
    const b = bakeWorld({ model: st.solid, lights: [], width: 64, depth: 64 }, { topZ: 31, incline: 0.5 });
    clearBox(st, { x0: 2, y0: 2, z0: 6, x1: 3, y1: 3, z1: 7 });
    clearBox(st, { x0: 58, y0: 58, z0: 6, x1: 59, y1: 59, z1: 7 });
    const jobs = rebakeChangedJobs(b, [], { near: { x: 59, y: 59 } });
    expect(jobs.length).toBe(2);
    const q = new FrameBudget(1000), done: string[] = [];
    for (const j of jobs) q.push({ ...j, key: j.key, run: (d) => { const r = j.run(d); if (r) done.push(j.key); return r; } });
    q.run();
    const near = jobs.find((j) => j.priority === Math.min(...jobs.map((x) => x.priority!)))!;
    expect(done[0]).toBe(near.key);
    expect(near.key).toMatch(/^rect:5\d,/);
  });
});
