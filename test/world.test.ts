import { describe, it, expect } from 'vitest';
import { Model, material, box, render } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D } from '../src/world/frame2d';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const ENT = { ramps: [{ name: 'cuerpo', colors: ['#400000', '#800000', '#c00000', '#ff0000', '#ff8080'] }] };

// Un mundo pequeño: suelo, una columna y una entidad (una caja roja de 5x3x9)
function smallWorld(): { state: WorldState; world: World } {
  const s = new StaticVoxels(structuredClone(PAL), 64, 48, -4, 20);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) s.set(x, y, 0, material(0, (x + y) % 3 ? 2 : 1));
  for (let z = 1; z < 14; z++) for (let y = 30; y < 34; y++) for (let x = 40; x < 44; x++) s.set(x, y, z, material(0, 3));
  const state = new WorldState(s, [], null);
  const m = new Model(ENT);
  box(m, -2, -1, 0, 2, 1, 8, material(0, 2));
  state.addEntity('caja', m, 22, 20, 1, 0);
  const world = { model: s, lights: [], width: 64, depth: 48 } as unknown as World;
  return { state, world };
}

describe('un solo mundo', () => {
  it('la vista compuesta es lo estático más las entidades (con su paleta añadida a la del mundo)', () => {
    const { state } = smallWorld();
    const v = state.view({ x0: 0, y0: 0, x1: 63, y1: 47 });
    const all = [...v.entries()];
    expect(all.length).toBe(state.solid.size + 5 * 3 * 9);
    // La entidad usa la rampa que se le añadió a la paleta del mundo (la 2)
    expect(v.palette.ramps[2]!.name).toBe('cuerpo');
    expect(v.get(22, 20, 1)).toBe(WorldState.remap(state.entities[0]!, material(0, 2)));
  });

  it('el modo 2D (horneado + entidad encima) dibuja lo mismo que renderizar el mundo entero de una vez', () => {
    const { state, world } = smallWorld();
    const b = bakeWorld(world, { topZ: 20, incline: 0.5 });
    // En el horneado la iluminación por cara y la oclusión ambiental cambian tonos; para comparar formas y
    // profundidad usamos el mismo render sin luz en los dos lados
    const flatOpts = { ...b.options, flat: true, ao: false, pick: false };
    const whole = render(state.view({ x0: 0, y0: 0, x1: 63, y1: 47 }), flatOpts);
    const bakedFlat = render(state.solid, flatOpts);
    const b2 = { ...b, rgba: bakedFlat.rgba, depth: bakedFlat.depth };
    const two = frame2D(state, b2, { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: false, ambient: [1, 1, 1] });
    let diff = 0, opaque = 0;
    for (let i = 0; i < b.width * b.height; i++) {
      if (!whole.rgba[i * 4 + 3]) continue;
      opaque++;
      if (whole.rgba[i * 4] !== two[i * 4] || whole.rgba[i * 4 + 1] !== two[i * 4 + 1] || whole.rgba[i * 4 + 2] !== two[i * 4 + 2]) diff++;
    }
    // Iguales salvo, como mucho, algún píxel del borde de los pies (empate de profundidad con el suelo)
    expect(diff).toBeLessThanOrEqual(3);
    expect(opaque).toBeGreaterThan(1000);
    // Y la entidad está: hay píxeles rojos
    let red = 0;
    for (let i = 0; i < b.width * b.height; i++) if (two[i * 4]! > 150 && two[i * 4 + 1]! < 60) red++;
    expect(red).toBeGreaterThan(20);
  });

  it('las entidades giran en el modo vóxel a la vuelta de 90° más cercana', () => {
    const { state } = smallWorld();
    state.entities[0]!.yaw = 90;
    const v = state.view({ x0: 0, y0: 0, x1: 63, y1: 47 });
    // La caja es de 5 de ancho (x) y 3 de fondo (y): girada 90°, ocupa 3 en x y 5 en y
    expect(v.get(22 + 1, 20, 1)).not.toBe(0);
    expect(v.get(22 + 2, 20, 1)).toBe(0);
    expect(v.get(22, 20 + 2, 1)).not.toBe(0);
  });

  it('el agua que consulta el juego es la misma que ve el modo vóxel (un nivel real)', async () => {
    const { generateLayout } = await import('../src/worldgen');
    const { THEMES } = await import('../src/content/themes');
    const { buildWorldState } = await import('../src/world/build');
    const { state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval');
    // Una celda con agua: su columna en la vista llega justo hasta la superficie que da la consulta
    const w = state.water!;
    let found = false;
    for (let i = 0; i < w.sim.depth.length && !found; i++) {
      if (w.sim.solid[i] || w.sim.depth[i]! < 2) continue;
      const gx = i % w.gw, gy = Math.floor(i / w.gw);
      const x = gx * 2, y = gy * 2;                         // ejes del modelo, como todo el mundo
      const v = state.view({ x0: x - 1, y0: y - 1, x1: x + 1, y1: y + 1 });
      const top = Math.round(state.waterAt(x, y)!.surface) - 1;
      expect(v.get(x, y, top)).not.toBe(0);
      expect(v.get(x, y, top + 1)).toBe(0);
      // Y si el agua se mueve, las dos cosas cambian juntas
      w.pour(x, y, 3);
      const top2 = Math.round(state.waterAt(x, y)!.surface) - 1;
      expect(top2).toBeGreaterThan(top);
      expect(state.view({ x0: x - 1, y0: y - 1, x1: x + 1, y1: y + 1 }).get(x, y, top2)).not.toBe(0);
      found = true;
    }
    expect(found).toBe(true);
  });
});
