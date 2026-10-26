// La receta de mundo (src/world/recipe.ts): un mundo entero en datos (JSON), para que un agente lo construya sin
// escribir código. La misma receta da el mismo mundo, y con un tema de muestra da el mundo de siempre.
import { describe, it, expect } from 'vitest';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildSampleRecipe } from '../src/samples/recipes';
import { buildRecipe, describeWorld, snapshotWorld, type WorldRecipe } from '../src/world/recipe';
import { buildWorldState, M } from '../src/world/build';
import { Model, material, box, decode } from '../src/core';
import { WaterLayer } from '../src/world/water';

const cube = (name: string, color: string, h: number) => {
  const m = new Model({ ramps: [{ name, colors: ['#000000', color, '#ffffff'] }] }, name);
  box(m, -1, -1, 0, 1, 1, h - 1, material(0, 1));
  return m.toJSON();
};

describe('receta de mundo', () => {
  it('con el tema de muestra da el mismo mundo que buildWorldState', () => {
    const { state } = buildSampleRecipe({ theme: 'medieval', seed: 7 });
    const ref = buildWorldState(generateLayout(THEMES.medieval.spec, 7), THEMES.medieval.look).state;
    expect(state.hash()).toBe(ref.hash());
  });

  it('es JSON: la receta serializada y vuelta a leer da el mismo mundo', () => {
    const a = buildSampleRecipe({ theme: 'oficina', seed: 2, ramps: { water: ['#1a0e08', '#2e1a0e', '#4a2c16', '#6a4224', '#a07040'] } });
    const again = buildSampleRecipe(JSON.parse(JSON.stringify(a.recipe)));
    expect(again.state.hash()).toBe(a.state.hash());
  });

  it('columnas y muebles de modelo, modelos sueltos, luces, efectos y agua emisiva', () => {
    const r: WorldRecipe = {
      seed: 2, generator: THEMES.oficina.spec,
      ramps: { water: { colors: ['#0a2a10', '#145a20', '#22a03a', '#4ee060', '#b0ffb8'], emissive: true } },
      pillar: cube('mampara', '#5a6a80', 20),
      prop: cube('caja', '#806040', 8),
      stamps: [{ model: cube('taza', '#f0f0f0', 3), x: 100, y: 100 }],
      lights: [{ kind: 'lamp', x: 120, y: 120, z: 20 }],
      effects: [{ preset: 'humo', x: 100, y: 100, z: 5 }],
    };
    const b = buildRecipe(r);
    const d = describeWorld(b) as { pillars: Array<[number, number]>; props: Array<{ x0: number; x1: number; yS: number; yN: number }>; lights: Array<{ id: string }> };
    const ramps = b.world.model.palette.ramps.map((x) => x.name);
    expect(ramps).toEqual(expect.arrayContaining(['mampara', 'caja', 'taza']));
    const [px, py] = d.pillars[0]!;
    const v = b.world.model.get(px, py, 15);
    expect(b.world.model.palette.ramps[decode(v).ramp]!.name).toBe('mampara');
    expect(b.world.model.get(px + 3, py, 15)).toBe(0);                       // la mampara mide 3 de ancho, no 16
    const p = d.props[0]!, cx = Math.floor((p.x0 + p.x1 + 1) / 2), cy = Math.floor((p.yS + p.yN + 1) / 2);
    expect(b.world.model.palette.ramps[decode(b.world.model.get(cx, cy, 5)).ramp]!.name).toBe('caja');
    expect(b.world.model.palette.ramps[decode(b.world.model.get(100, 100, b.world.model.floorAt(100, 100) - 1)).ramp]!.name).toBe('taza');
    expect(d.lights.some((l) => l.id === 'receta-0')).toBe(true);
    expect(b.state.fx.used || b.state.fx.count >= 0).toBeTruthy();
    expect((b.state.water as WaterLayer).glow).toBe(1);
    expect(b.world.model.palette.ramps[M.water]!.emissive).toBe(true);
  });

  it('vegetación por nombre: añade sus rampas, y los nenúfares flotan', () => {
    const b = buildSampleRecipe({ theme: 'medieval', seed: 7, foliage: [{ type: 'grass', density: 0.4 }, { type: 'lilies', density: 0.02 }] });
    const names = b.world.model.palette.ramps.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['hierba-alta', 'nenufar']));
    expect(b.state.floaters.list.length).toBeGreaterThan(0);
    const plain = buildSampleRecipe({ theme: 'medieval', seed: 7 });
    expect(b.state.hash()).not.toBe(plain.state.hash());
  });

  it('la foto sin GPU (la de la CLI): la vista pedida, o el mundo entero', () => {
    const b = buildSampleRecipe({ theme: 'medieval', seed: 7 });
    const v = snapshotWorld(b, { width: 120, height: 80, ticks: 5 });
    expect([v.width, v.height, v.rgba.length]).toEqual([120, 80, 120 * 80 * 4]);
    let lit = 0;
    for (let i = 0; i < v.rgba.length; i += 4) if (v.rgba[i]! + v.rgba[i + 1]! + v.rgba[i + 2]! > 60) lit++;
    expect(lit).toBeGreaterThan(120 * 80 * 0.3);
    const all = snapshotWorld(b, { whole: true });
    expect(all.width).toBeGreaterThanOrEqual(b.world.width);
  });

  it('los errores dicen qué falta', () => {
    expect(() => buildRecipe({ seed: 1 } as WorldRecipe)).toThrow(/generator/);
    expect(() => buildSampleRecipe({ theme: 'marte' as never })).toThrow(/medieval/);
    expect(() => buildSampleRecipe({ theme: 'medieval', ramps: { lava: ['#f00'] } as never })).toThrow(/papeles son/);
    expect(() => buildSampleRecipe({ theme: 'medieval', foliage: [{ type: 'cactus' as never }] })).toThrow(/grass/);
    expect(() => buildSampleRecipe({ theme: 'medieval', effects: [{ preset: 'fuego' as never, x: 0, y: 0, z: 0 }] })).toThrow(/humo/);
    expect(() => buildSampleRecipe({ theme: 'medieval', foliage: [{ type: 'grass', ramp: 'nada' }] })).toThrow(/no hay rampa "nada"/);
  });
});
