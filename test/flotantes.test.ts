// Lo que flota (src/world/floaters.ts): lo mueve el agua y nada más. No bloquea, no gasta el azar del mundo, no sale
// del agua, y entra en la instantánea.
import { describe, it, expect } from 'vitest';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorldState, worldWaterDepth, type World } from '../src/world/build';
import { lilyPadModels, planFoliage, FOLIAGE_RAMPS } from '../src/core';
import type { WorldState } from '../src/world/state';

// El medieval con nenúfares flotando en sus lagos
function pond(withFloaters: boolean): { world: World; state: WorldState } {
  return buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval', {
    decorate: (w) => {
      if (!withFloaters) return;
      const m = w.model, models = lilyPadModels(structuredClone(FOLIAGE_RAMPS.nenufar!));
      const p = planFoliage(m, 0, 0, m.width - 1, m.depth - 1, m.zMax, { type: 'lilies', ramp: 0, zMin: m.zMin, waterDepth: worldWaterDepth(w), density: 0.01, seed: 3 });
      w.floaters = p.floats.map(([x, y, k]) => ({ x, y, model: models[k]!, yaw: k * 45 }));
    },
  });
}

describe('flotantes', () => {
  it('en agua quieta se quedan donde están, sobre la superficie', () => {
    const { state } = pond(true);
    expect(state.floaters.list.length).toBeGreaterThan(50);
    const before = state.floaters.list.map((f) => [f.x, f.y]);
    for (let t = 0; t < 120; t++) state.step();
    const moved = state.floaters.list.filter((f, i) => Math.hypot(f.x - before[i]![0]!, f.y - before[i]![1]!) > 0.5).length;
    expect(moved).toBeLessThan(state.floaters.list.length * 0.1);       // solo los que caen donde la fuente agita el agua
    for (const f of state.floaters.list) {
      const e = state.entities.get(f.id)!;
      expect(e.z).toBeCloseTo(state.water!.surfaceAt(f.x, f.y), 0);
      expect(String(f.id)).toMatch(/^flota-\d+$/);
    }
  });

  it('un pisotón los aparta, y nunca salen del agua', () => {
    const { state } = pond(true);
    const w = state.water!;
    // El flotante más lejos de la orilla, y un pisotón a 3 vóxeles al oeste
    const f = [...state.floaters.list].sort((a, b) => w.depthAt(b.x, b.y) - w.depthAt(a.x, a.y))[0]!;
    const x0 = f.x, y0 = f.y;
    for (let t = 0; t < 90; t++) {
      if (t % 15 === 0) state.events.disturb(x0 - 3, y0, 3, 3);
      state.step();
    }
    expect(f.x - x0).toBeGreaterThan(0.5);                                 // se fue hacia el este, lejos del pisotón
    for (const g of state.floaters.list) expect(w.depthAt(g.x, g.y)).toBeGreaterThan(0.05);
  });

  it('no cambian la colisión, los disparos ni el azar del mundo', () => {
    const a = pond(true).state, b = pond(false).state;
    for (let t = 0; t < 60; t++) { a.step(); b.step(); }
    expect(a.snapshot().rng).toBe(b.snapshot().rng);
    for (const f of a.floaters.list.slice(0, 20)) {
      const e = a.entities.get(f.id)!;
      expect(a.solidAt(e.x + 0.5, e.y + 0.5, e.z + 0.5)).toBe(b.solidAt(e.x + 0.5, e.y + 0.5, e.z + 0.5));
      expect(a.groundAt(e.x, e.y)).toBe(b.groundAt(e.x, e.y));
      expect(a.raycast([e.x - 6, e.y + 0.5, e.z + 0.5], [e.x + 6, e.y + 0.5, e.z + 0.5])).toEqual(b.raycast([e.x - 6, e.y + 0.5, e.z + 0.5], [e.x + 6, e.y + 0.5, e.z + 0.5]));
      expect(e.castsShadow).toBe(false);
    }
    // Las entidades numéricas del juego siguen su secuencia: los flotantes no la tocan
    expect(a.entities.next).toBe(b.entities.next);
  });

  it('la instantánea los guarda y los devuelve igual; la huella los cuenta, y sin flotantes no cambia', () => {
    const { state } = pond(true);
    for (let t = 0; t < 30; t++) { if (t === 3) state.events.disturb(state.floaters.list[0]!.x - 2, state.floaters.list[0]!.y, 3, 3); state.step(); }
    const snap = state.snapshot(), h = state.hash();
    for (let t = 0; t < 30; t++) state.step();
    state.restore(snap);
    expect(state.hash()).toBe(h);
    // Lo mismo desde cero, dos veces: determinista
    const x = pond(true).state, y = pond(true).state;
    for (let t = 0; t < 40; t++) { x.step(); y.step(); }
    expect(x.hash()).toBe(y.hash());
    expect(pond(true).state.hash()).not.toBe(pond(false).state.hash());
  });
});
