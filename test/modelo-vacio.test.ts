// Una entidad con un modelo sin vóxeles que da sombra: no entra en shadowCasters (sin cuerpo no hay sombra; en la GPU
// su caja vacía rompía el cuadro: syncOcc con tamaño -Infinity) ni se pinta (onView: tampoco su sombra de contacto),
// se avisa una vez, y el cuadro es el mismo que sin ella. Y occupancy con giros negativos, de más de una vuelta o que no son un número
import { describe, it, expect, vi } from 'vitest';
import { Model, material, box } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D, shadowCasters, occupancy, type Frame2DOptions } from '../src/world/frame2d';

const PAL = { ramps: [{ name: 'a', colors: ['#404040', '#808080', '#c0c0c0'] }] };
function setup() {
  const s = new StaticVoxels(PAL, 32, 32, 0, 15);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) s.set(x, y, 0, material(0, 1));
  const st = new WorldState(s, [{ id: 't', kind: 'torch', x: 16, y: 16, z: 6 }], null);
  const b = bakeWorld({ model: s, lights: st.lights, width: 32, depth: 32 }, { topZ: 16 });
  return { st, b };
}
const body = () => { const m = new Model(PAL, 'cubo'); box(m, 0, 0, 0, 2, 1, 4, material(0, 2)); return m; };

describe('entidad de modelo vacío', () => {
  it('no da sombra, se avisa una vez, y el cuadro es el mismo que sin ella', () => {
    const { st, b } = setup();
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.5, 0.5, 0.5] };
    st.entities.add({ model: body(), x: 12, y: 14, z: 1 });
    const before = frame2D(st, b, o);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const empty = new Model(PAL, 'vacio');
    st.entities.add({ model: empty, x: 18, y: 14, z: 1, castsShadow: true });
    expect(shadowCasters(st, b, o).map((e) => e.model)).not.toContain(empty);
    expect(shadowCasters(st, b, o)).toHaveLength(1);
    expect(frame2D(st, b, o)).toEqual(before);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('sin vóxeles'))).toHaveLength(1);
    warn.mockRestore();
    expect(occupancy(empty, 0).empty).toBe(true);
    expect(occupancy(body(), 0).empty).toBe(false);
  });

  it('occupancy: un giro negativo o de más de una vuelta es su cuarto; uno que no es un número, el 0', () => {
    const m = body();
    expect(occupancy(m, -90).set).toEqual(occupancy(m, 270).set);
    expect(occupancy(m, 450).set).toEqual(occupancy(m, 90).set);
    expect(occupancy(m, NaN).set).toEqual(occupancy(m, 0).set);
    expect(occupancy(m, Infinity).min).toEqual(occupancy(m, 0).min);
    expect(Number.isFinite(occupancy(m, NaN).max[0])).toBe(true);
  });
});
