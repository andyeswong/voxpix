// Frame2DOptions.background = 'transparent': donde no hay nada, alfa 0 y color 0; el mundo, igual que con el fondo de
// siempre; lo que se pinta encima del cielo (una entidad, unas chispas) sale opaco. Sin la opción, el cuadro de siempre
import { describe, it, expect } from 'vitest';
import { Model, material, box } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D, frame2DParts, type Frame2DOptions } from '../src/world/frame2d';

const PAL = { ramps: [{ name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] }] };
function setup() {
  const s = new StaticVoxels(PAL, 32, 32, 0, 31);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let z = 0; z < 4; z++) s.set(x, y, z, material(0, 1));
  const st = new WorldState(s, [{ id: 't', kind: 'torch', x: 16, y: 16, z: 8 }], null);
  const b = bakeWorld({ model: s, lights: st.lights, width: 32, depth: 32 }, { topZ: 31 });
  return { st, b };
}

describe('fondo transparente', () => {
  // Con luz ambiente por encima de 1, el brillo suave suma algo también donde no hay nada: con fondo transparente, eso
  // también sale a 0
  for (const [lights, amb] of [[true, 0.6], [false, 0.6], [true, 1.6]] as const) it(`${lights ? 'con' : 'sin'} luces, ambiente ${amb}: mundo igual, fondo con alfa 0 y color 0, y encima del cielo, opaco`, () => {
    const { st, b } = setup();
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights, ambient: [amb, amb, amb] };
    // Una entidad alta en el borde de atrás (su cabeza cae sobre el cielo) y chispas muy arriba
    const m = new Model(PAL, 'poste'); box(m, 0, 0, 0, 1, 1, 26, material(0, 3));
    st.entities.add({ model: m, x: 16, y: 31, z: 4, castsShadow: false });
    st.fx.burst({ burst: 12, life: [5, 5], speed: [0, 0], colors: ['#ffcc33'] }, 6, 30, 28);
    st.step();
    const fxOnSky = st.fx.count;
    const plain = frame2D(st, b, o);
    const clear = frame2D(st, b, { ...o, background: 'transparent' });
    const { depth } = frame2DParts(st, b, o);
    let sky = 0, opaqueOnSky = 0;
    for (let t = 0; t < b.width * b.height; t++) {
      const i = t * 4, empty = !b.rgba[i + 3];
      if (!empty) { expect(clear.slice(i, i + 4)).toEqual(plain.slice(i, i + 4)); continue; }
      if (clear[i + 3]) {
        opaqueOnSky++;                                              // algo pintado encima del cielo: como sin la opción
        expect(clear.slice(i, i + 4)).toEqual(plain.slice(i, i + 4));
      } else {
        sky++;
        expect([clear[i], clear[i + 1], clear[i + 2]]).toEqual([0, 0, 0]);
        expect(depth[t]).toBe(Infinity);
      }
    }
    expect(sky).toBeGreaterThan(500);
    expect(opaqueOnSky).toBeGreaterThan(10);
    expect(fxOnSky).toBeGreaterThan(0);
    // Las chispas sobre el cielo también salen opacas: con los efectos apagados hay menos píxeles opacos sobre el cielo
    st.effectsOn = false;
    const noFx = frame2D(st, b, { ...o, background: 'transparent' });
    st.effectsOn = true;
    let withoutFx = 0;
    for (let t = 0; t < b.width * b.height; t++) if (!b.rgba[t * 4 + 3] && noFx[t * 4 + 3]) withoutFx++;
    expect(opaqueOnSky).toBeGreaterThan(withoutFx);
  });
});
