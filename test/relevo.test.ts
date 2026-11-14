// Cambios que llegan antes de que acaben los trabajos de luz del cambio anterior (el jugador pica más rápido de lo que
// la cola rehace las luces, o un corte que se escribe por trozos): en la cola de FrameBudget, el trabajo de luz nuevo
// no sustituye al viejo (perdería sus cambios), y al acabar todo da lo mismo que hornear de cero. Y una luz quitada
// mientras un trabajo suyo espera no vuelve
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, LightList } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs, type Baked } from '../src/world/bake';
import { FrameBudget, type ViewJob } from '../src/view/budget';

function ground(): StaticVoxels {
  const s = new StaticVoxels({ ramps: [{ name: 'p', colors: ['#202020', '#606060', '#a0a0a0'] }] }, 64, 64, 0, 40);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 16 + ((x >> 3) % 2) * 6; z++) s.set(x, y, z, material(0, 1));
  return s;
}
const hole = (s: StaticVoxels, x0: number, y0: number) => { for (let z = 10; z < 22; z++) for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) s.set(x, y, z, 0); };
const queue = (q: FrameBudget) => (q as unknown as { queue: ViewJob[] }).queue;
// Unas pocas unidades de cada trabajo de la cola (plazo vencido)
const nudge = (q: FrameBudget, n: number) => { for (const j of queue(q).slice()) for (let k = 0; k < n; k++) if (j.run(-1)) { queue(q).splice(queue(q).indexOf(j), 1); break; } };
const drain = (q: FrameBudget) => { let g = 0; while (queue(q).length && g++ < 100000) for (const j of queue(q).slice()) if (j.run(Infinity)) queue(q).splice(queue(q).indexOf(j), 1); };
const weights = (b: Baked) => b.lights.map((l) => [l.light.id, Array.from(l.weight)]).sort((p, q) => String(p[0]).localeCompare(String(q[0])));

describe('cambios seguidos con trabajos de luz a medias', () => {
  it('el trabajo nuevo no sustituye al que está a medias, y al acabar es lo de hornear de cero', () => {
    const s = ground(), ls = new LightList();
    ls.addFixed({ id: 'a', kind: 'torch', x: 32.5, y: 32.5, z: 30 });
    const opts = { topZ: 40, incline: 0.5 };
    const b = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, { ...opts, warmExposure: false });
    const q = new FrameBudget(1);
    hole(s, 8, 8);
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    // Los recuadros, acabados (cada llamada hace al menos una unidad; cuántas, según lo que haya que preparar), y la luz,
    // unas pocas unidades: a medias
    for (const j of queue(q).filter((x) => x.key.startsWith('rect:'))) { while (!j.run(-1)); queue(q).splice(queue(q).indexOf(j), 1); }
    nudge(q, 4);
    expect(queue(q).map((j) => j.key)).toEqual(['light:a#' + queue(q)[0]!.key.split('#')[1]]);   // la luz, a medias
    hole(s, 54, 54);
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    expect(queue(q).filter((j) => j.key.startsWith('light:a')).length).toBe(2);
    // Y otro cambio más antes de que el segundo empiece: se le suma (no hay un tercero)
    hole(s, 30, 54);
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    expect(queue(q).filter((j) => j.key.startsWith('light:a')).length).toBe(2);
    drain(q);
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts)));
  });

  it('una luz quitada mientras un trabajo suyo espera en la cola no vuelve', () => {
    const s = ground(), ls = new LightList();
    ls.addFixed({ id: 'a', kind: 'torch', x: 32.5, y: 32.5, z: 30 });
    ls.addFixed({ id: 'b', kind: 'lamp', x: 12.5, y: 40.5, z: 28 });
    const b = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, { topZ: 40, incline: 0.5 });
    const q = new FrameBudget(1);
    hole(s, 20, 20);
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    ls.removeFixed('a');
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    drain(q);
    expect(b.lights.map((l) => l.light.id)).toEqual(['b']);
  });
  it('un cambio con la preparación de la luz a medias (entre la sombra de una caja y la de otra) acaba igual que hornear de cero', () => {
    const s = ground(), ls = new LightList();
    ls.addFixed({ id: 'a', kind: 'torch', x: 32.5, y: 32.5, z: 30 });
    const opts = { topZ: 40, incline: 0.5 };
    const b = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts);
    const q = new FrameBudget(1);
    // Tres hoyos en trozos distintos en un mismo cambio: tres cajas, tres sombras que preparar
    hole(s, 20, 20); hole(s, 40, 22); hole(s, 26, 42);
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    // Los recuadros, enteros; la luz, de llamada en llamada con el plazo vencido: la zona y la lista, y una sombra
    for (const j of queue(q).filter((x) => x.key.startsWith('rect:'))) { while (!j.run(Infinity)); queue(q).splice(queue(q).indexOf(j), 1); }
    const light = queue(q).find((x) => x.key.startsWith('light:a'))!;
    expect(light.run(-1)).toBe(false);
    expect(light.run(-1)).toBe(false);
    // Otro cambio con la luz a medias de preparar
    hole(s, 44, 40);
    for (const j of rebakeChangedJobs(b, ls)) q.push(j);
    drain(q);
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts)));
  });
});
