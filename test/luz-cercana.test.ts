// rebakeChangedJobs con near: una luz puesta junto al jugador va con prioridad cercana (la de los recuadros: su
// distancia en pantalla) y se hace con el presupuesto cercano; una lejos, no. Solo cambia el orden: los pesos acaban
// iguales que hornear de cero. Con nearLights: false, como antes (detrás de todo)
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, LightList } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs, LIGHT_PRIORITY, type Baked } from '../src/world/bake';
import { FrameBudget, type ViewJob } from '../src/view/budget';

function ground(): StaticVoxels {
  const s = new StaticVoxels({ ramps: [{ name: 'p', colors: ['#202020', '#606060', '#a0a0a0'] }] }, 96, 96, 0, 40);
  for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) for (let z = 0; z < 16 + ((x >> 3) % 2) * 6; z++) s.set(x, y, z, material(0, 1));
  return s;
}
const weights = (b: Baked) => b.lights.map((l) => [l.light.id, Array.from(l.weight)]).sort((p, q) => String(p[0]).localeCompare(String(q[0])));
const OPTS = { topZ: 40, incline: 0.5 };
const player = { x: 20, y: 20 };

describe('luz cercana', () => {
  it('la antorcha puesta junto al jugador va con prioridad cercana; la lejana, detrás; y acaban como hornear de cero', () => {
    const s = ground(), ls = new LightList();
    const b = bakeWorld({ model: s, lights: ls, width: 96, depth: 96 }, OPTS);
    ls.addFixed({ id: 'cerca', kind: 'torch', x: 22.5, y: 21.5, z: 24 });
    ls.addFixed({ id: 'lejos', kind: 'torch', x: 84.5, y: 84.5, z: 24 });
    const jobs = rebakeChangedJobs(b, ls, { near: player });
    const pr = (id: string) => jobs.find((j) => j.key.startsWith(`light:${id}`))!.priority!;
    expect(pr('cerca')).toBeLessThan(64);
    expect(pr('lejos')).toBeGreaterThan(64);
    // Con la cola de verdad (cercano 8 de 3): la de cerca acaba antes que la de lejos
    let clock = 0;
    const q = new FrameBudget(3, () => clock, { ms: 8, below: 64 });
    const done: string[] = [];
    for (const j of jobs) q.push({ key: j.key, priority: j.priority, run: (d: number) => { const r = j.run(Infinity); clock += 5; if (r) done.push(j.key.split(/[:#]/)[1]!); return r; } } as ViewJob);
    for (let f = 0; f < 50 && q.pending; f++) q.run();
    expect(done).toEqual(['cerca', 'lejos']);
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 96, depth: 96 }, OPTS)));
  });

  it('una luz cercana espera a sus recuadros (no se adelanta a lo que tiene que aparecer) y acaba igual', () => {
    const s = ground(), ls = new LightList();
    ls.addFixed({ id: 't', kind: 'torch', x: 22.5, y: 21.5, z: 30 });
    const b = bakeWorld({ model: s, lights: ls, width: 96, depth: 96 }, OPTS);
    for (let z = 10; z < 22; z++) for (let y = 18; y < 22; y++) for (let x = 18; x < 22; x++) s.set(x, y, z, 0);   // un hoyo junto a la luz
    const jobs = rebakeChangedJobs(b, ls, { near: player });
    const light = jobs.find((j) => j.key.startsWith('light:t'))!, rect = jobs.find((j) => j.key.startsWith('rect:'))!;
    expect(light.priority!).toBeLessThan(64);
    expect(light.run(Infinity)).toBe(false);                      // espera: el recuadro no se ha publicado
    while (!rect.run(Infinity));
    for (const j of jobs) if (j !== rect) while (!j.run(Infinity));
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 96, depth: 96 }, OPTS)));
  });

  it('con nearLights: false, las luces van detrás de todo, como antes', () => {
    const s = ground(), ls = new LightList();
    const b = bakeWorld({ model: s, lights: ls, width: 96, depth: 96 }, OPTS);
    ls.addFixed({ id: 'cerca', kind: 'torch', x: 22.5, y: 21.5, z: 24 });
    const jobs = rebakeChangedJobs(b, ls, { near: player, nearLights: false });
    expect(jobs.find((j) => j.key.startsWith('light:cerca'))!.priority!).toBeGreaterThanOrEqual(LIGHT_PRIORITY);
  });
});
