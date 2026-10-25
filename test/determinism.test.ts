import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorld, buildWorldState } from '../src/world/build';
import { WaterLayer } from '../src/world/water';
import { Model, material, box } from '../src/core';
import { WorldState } from '../src/world/state';

// Una partida corta con eventos: pisotones en el agua, gotas, una entidad que se mueve
function play(seed: number, ticks: number, variant = 0): { state: WorldState; hashes: string[] } {
  const { state, world } = buildWorldState(generateLayout(THEMES.medieval.spec, seed), 'medieval');
  const m = new Model({ ramps: [{ name: 'x', colors: ['#ff0000'] }] });
  box(m, -1, -1, 0, 1, 1, 6, material(0, 0));
  const e = state.addEntity('cuerpo', m, 100, 100, 1);
  const w = state.water!;
  let wet: [number, number] = [0, 0];
  for (let i = 0; i < w.sim.depth.length; i++) if (!w.sim.solid[i] && w.sim.depth[i]! > 2) { wet = [(i % w.gw) * 2, Math.floor(i / w.gw) * 2]; break; }
  const hashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    if (t === 20) state.events.disturb(wet[0], wet[1], 0.4 + variant * 0.1, 3);   // por debajo del tope (la mitad de la profundidad)
    if (t === 40) state.events.splash(wet[0], wet[1], 1, 25, 90);
    if (t % 10 === 0) { e.x += 1; e.yaw = (e.yaw + 45) % 360; }
    state.step();
    if (t % 50 === 49) hashes.push(state.hash());
  }
  void world;
  return { state, hashes };
}

describe('simulación determinista', () => {
  it('misma semilla y mismos eventos: la misma huella en cada control', () => {
    const a = play(7, 200), b = play(7, 200);
    expect(a.hashes).toEqual(b.hashes);
    expect(new Set(a.hashes).size).toBe(a.hashes.length);      // y el estado cambia de verdad entre controles
  });

  it('un evento distinto cambia la huella', () => {
    expect(play(7, 100).hashes.at(-1)).not.toBe(play(7, 100, 0.5).hashes.at(-1));
  });

  it('otra semilla, otra partida', () => {
    expect(play(7, 60).hashes.at(-1)).not.toBe(play(8, 60).hashes.at(-1));
  });

  it('snapshot y restore: guardar, seguir, volver y repetir da lo mismo', () => {
    const { state } = play(7, 100);
    const snap = state.snapshot();
    for (let t = 0; t < 120; t++) state.step();
    const h1 = state.hash();
    state.restore(snap);
    for (let t = 0; t < 120; t++) state.step();
    expect(state.hash()).toBe(h1);
  });

  it('la simulación no lee el reloj ni Math.random', () => {
    const files = ['src/world/state.ts', 'src/world/water.ts', 'src/world/particles.ts',
      ...readdirSync('src/fluid').map((f) => `src/fluid/${f}`), ...readdirSync('src/worldgen').map((f) => `src/worldgen/${f}`)];
    for (const f of files) {
      const code = readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/Math\.random|performance\.now|Date\.now/);
    }
  });
});

describe('calentar step', () => {
  it('warmUp deja el mundo exactamente como estaba', () => {
    const layout = generateLayout(THEMES.medieval.spec, 7);
    const world = buildWorld(layout, 'medieval');
    const s = new WorldState(world.model, world.lights, new WaterLayer(world, 'medieval'), { seed: layout.seed, fountain: world.fountain });
    const before = s.hash();
    s.warmUp();
    expect(s.hash()).toBe(before);
  });
});
