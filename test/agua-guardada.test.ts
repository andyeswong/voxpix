// Guardar y cargar el agua que sigue al mundo (WaterLayer.follow): se pica la orilla de un lago, corre el agua, se
// guarda (encodeSnapshot) y se carga en un mundo nuevo, recién generado (su capa sale de los vóxeles de partida: la
// orilla sin picar). Los dos siguen igual tick a tick (la misma huella): la carga rehace el fondo de los vóxeles sin
// tocar la profundidad guardada, trae las cuencas ganadas y no despierta nada de más. Y una instantánea de antes, sin
// cuencas, carga con las del mundo de partida
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { clearBox } from '../src/world/edit';
import { encodeSnapshot, decodeSnapshot } from '../src/world/save';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const W = 64, D = 64, FLOOR = 40, BED = 34;
// El suelo hasta z 40 y un lago de x 16..39, y 20..43, con el fondo a z 34; el agua llega a ras del suelo
function generated() {
  const s = new StaticVoxels(PAL, W, D, 0, 63);
  const lake = (x: number, y: number) => x >= 16 && x < 40 && y >= 20 && y < 44;
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z < (lake(x, y) ? BED : FLOOR); z++) s.set(x, y, z, material(0, 1 + ((x + y) & 1)));
  const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (lake(x, y)) { wet[y * W + x] = 1; waterTop[y * W + x] = FLOOR; }
  const world = { model: s, lights: [], width: W, depth: D, wet, waterTop } as unknown as World;
  const water = new WaterLayer(world, { wallAbove: Infinity });
  const st = new WorldState(s, [], water, { seed: 5 });
  water.follow(st.watchChanges());
  return { st, water };
}

// La partida: picar la orilla este (una zanja que el lago llena) y la sur, y dejar correr
function played() {
  const g = generated();
  clearBox(g.st, { x0: 40, y0: 28, z0: 35, x1: 47, y1: 35, z1: 63 });
  for (let t = 0; t < 90; t++) g.st.step();
  clearBox(g.st, { x0: 22, y0: 14, z0: 36, x1: 29, y1: 19, z1: 63 });
  for (let t = 0; t < 30; t++) g.st.step();
  return g;
}

describe('agua guardada', () => {
  it('picar la orilla, guardar y cargar en un mundo nuevo: la misma huella en cada tick', () => {
    const a = played();
    expect(a.water.basinChanged()).toBe(true);                             // la zanja ganó cuencas
    expect(a.water.depthAt(44, 31)).toBeGreaterThan(0.5);                  // y tiene agua
    const bytes = encodeSnapshot(a.st.snapshot());
    const b = generated();
    b.st.restore(decodeSnapshot(bytes));
    expect(b.st.hash()).toBe(a.st.hash());
    expect(Array.from(b.water.sim.ground)).toEqual(Array.from(a.water.sim.ground));
    expect(Array.from(b.water.sim.solid)).toEqual(Array.from(a.water.sim.solid));
    expect(b.water.zRange).toEqual(a.water.zRange);
    for (let t = 0; t < 180; t++) {
      a.st.step(); b.st.step();
      expect(b.st.hash(), `tick ${t}`).toBe(a.st.hash());
    }
    // Y sigue igual al picar más después de cargar
    for (const g of [a, b]) clearBox(g.st, { x0: 40, y0: 36, z0: 36, x1: 45, y1: 41, z1: 63 });
    for (let t = 0; t < 60; t++) { a.st.step(); b.st.step(); expect(b.st.hash()).toBe(a.st.hash()); }
  });

  it('restaurar en el mismo mundo (calentar, deshacer) no despierta ni rehace nada: la misma huella después', () => {
    const a = played(), b = played();
    b.st.warmUp();
    for (let t = 0; t < 60; t++) { a.st.step(); b.st.step(); expect(b.st.hash()).toBe(a.st.hash()); }
  });

  it('una instantánea de antes, sin cuencas, carga con las del mundo de partida', () => {
    const a = played();
    const s = a.st.snapshot();
    delete s.water!.basin;
    const b = generated();
    b.st.restore(decodeSnapshot(encodeSnapshot(s)));
    expect(b.water.basinChanged()).toBe(false);
    expect(b.water.depthAt(44, 31)).toBeCloseTo(a.water.depthAt(44, 31), 6);   // la profundidad, la guardada
    for (let t = 0; t < 30; t++) b.st.step();
    expect(b.water.depthAt(20, 30)).toBeGreaterThan(1);                     // el lago sigue ahí
  });
});
