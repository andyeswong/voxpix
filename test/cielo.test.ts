// El cielo del horneado (bakeWorld con { sky: true }): cuánto cielo ve cada cara (0..SKY_RAYS), rehecho por caja igual
// que hornearlo de cero (también con el corte de vista, en los 4 giros), por trabajos igual que de una vez, y la luz
// ambiente por nivel al componer (Frame2DOptions.cave); sin cave, todo como antes
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView } from '../src/world/view';
import { bakeWorld, bakeWorldJob, rebakeChanged, lightView, skyAmbient, SKY_RAYS } from '../src/world/bake';
import { frame2D } from '../src/world/frame2d';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080'] }] };
// Suelo a 16; un techo de y 20..35, x 16..47, a z 28..31 (un porche); fuera, al aire libre
function world(): WorldState {
  const s = new StaticVoxels(PAL, 64, 56, 0, 47);
  for (let y = 0; y < 56; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 16; z++) s.set(x, y, z, material(0, 1));
  for (let y = 20; y < 36; y++) for (let x = 16; x < 48; x++) for (let z = 28; z < 32; z++) s.set(x, y, z, material(0, 2));
  return new WorldState(s, [{ id: 'a', kind: 'torch', x: 30.5, y: 27.5, z: 22, baked: true }], null);
}
const OPTS = { topZ: 47, incline: 0.5, sky: true };
// El cielo del píxel donde se ve la cara de arriba del suelo en (x, y)
const skyAt = (b: ReturnType<typeof bakeWorld>, x: number, y: number) => { const [sx, sy] = b.cam.project(x + 0.5, y + 0.5, 16); return b.sky![Math.floor(sy) * b.width + Math.floor(sx)]!; };

describe('cielo horneado', () => {
  it('al aire libre todo el cielo; bajo el porche (el suelo que se ve, junto a su borde sur), poco; en la esquina, más', () => {
    const st = world(), b = bakeWorld({ model: st.solid, lights: st.lights, width: 64, depth: 56 }, OPTS);
    expect(skyAt(b, 5, 5)).toBe(SKY_RAYS);
    expect(skyAt(b, 31, 10)).toBe(SKY_RAYS);
    // (31, 21): techo encima y a los lados; solo el rayo hacia el sur sale (el techo está a 12: sin mirar arriba al
    // final del tramo, los rayos de lado contarían como cielo)
    expect(skyAt(b, 31, 21)).toBe(1);
    expect(skyAt(b, 46, 21)).toBe(2);                             // la esquina: también hacia el este
  });

  it('por trabajos da lo mismo que de una vez; rehecho por caja tras quitar parte del techo, lo mismo que de cero', () => {
    const st = world(), m = { model: st.solid, lights: st.lights, width: 64, depth: 56 };
    const b = bakeWorld(m, OPTS);
    const { baked, job } = bakeWorldJob(m, OPTS);
    while (!job.run(Infinity)) { /* */ }
    expect(baked.sky).toEqual(b.sky);
    for (let z = 28; z < 32; z++) for (let y = 24; y < 32; y++) for (let x = 24; x < 32; x++) st.solid.set(x, y, z, 0);   // un tragaluz
    rebakeChanged(b, st.lights);
    expect(b.sky).toEqual(bakeWorld(m, OPTS).sky);
    // Bajo el tragaluz: arriba y hacia el sur (los rayos de lado y el del norte acaban bajo el techo)
    expect(skyAt(b, 27, 27)).toBe(2);
  });

  for (const q of [0, 1, 2, 3] as const) it(`con el corte de vista, giro ${q}: el cielo rehecho es el de hornear sin esos vóxeles`, () => {
    const st = world(), view = new WorldView(st, q, { cut: true });
    const b = bakeWorld(view.bakeable(), OPTS);
    view.setCut({ x0: 10, y0: 15, x1: 40, y1: 40, zTop: 26 });
    rebakeChanged(b, view.frame().lights);
    const ref = world();
    for (let y = 15; y <= 40; y++) for (let x = 10; x <= 40; x++) for (let z = 26; z <= 47; z++) ref.solid.set(x, y, z, 0);
    expect(b.sky).toEqual(bakeWorld(new WorldView(ref, q).bakeable(), OPTS).sky);
  });

  it('la luz ambiente por nivel (la tabla de la GPU); sin cave, la de siempre', () => {
    const st = world(), b = bakeWorld({ model: st.solid, lights: [], width: 64, depth: 56 }, OPTS);
    const amb = [0.9, 0.9, 1] as const, cave = [0.1, 0.08, 0.12] as const;
    const t = skyAmbient(amb, cave);
    expect(Array.from(t.subarray(0, 3))).toEqual(Array.from(new Float32Array(cave)));
    expect(Array.from(t.subarray(SKY_RAYS * 3))).toEqual(Array.from(new Float32Array(amb)));
    const [sx, sy] = b.cam.project(31.5, 21.5, 16);
    const vx = Math.floor(sx) - 2, vy = Math.floor(sy) - 2;
    const lit = lightView(b, vx, vy, 4, 4, amb, 0, cave);
    const k = b.sky![(vy + 2) * b.width + vx + 2]!;
    expect(k).toBe(1);
    expect(Array.from(lit.subarray(2 * 4 * 3 + 2 * 3, 2 * 4 * 3 + 2 * 3 + 3))).toEqual(Array.from(t.subarray(k * 3, k * 3 + 3)));   // bajo el porche
    expect(Array.from(lightView(b, vx, vy, 4, 4, amb, 0).subarray(0, 3))).toEqual(Array.from(new Float32Array(amb)));
    // Y el cuadro entero: sin cave, el horneado con cielo da el mismo cuadro que sin cielo
    const plain = bakeWorld({ model: st.solid, lights: [], width: 64, depth: 56 }, { topZ: 47, incline: 0.5 });
    const o = { vx: 0, vy: Math.max(0, vy - 24), vw: 64, vh: 64, time: 0, lights: true, ambient: amb };   // con el porche
    expect(Buffer.from(frame2D(st, b, o)).equals(Buffer.from(frame2D(st, plain, o)))).toBe(true);
    expect(Buffer.from(frame2D(st, b, { ...o, cave })).equals(Buffer.from(frame2D(st, plain, o)))).toBe(false);
  });
});

describe('entidades y cielo', () => {
  it('una entidad bajo el porche toma el nivel del píxel de sus pies (más oscura); al aire libre, la misma que sin cueva', async () => {
    const { Model, box: fill } = await import('../src/core');
    const { entitySprite, entitySky, frame2D: f2 } = await import('../src/world/frame2d');
    const st = world(), b = bakeWorld({ model: st.solid, lights: [], width: 64, depth: 56 }, OPTS);
    const m = new Model({ ramps: [{ name: 'p', colors: ['#402020', '#a05050', '#e0a0a0'] }] }, 'bicho');
    fill(m, -1, -1, 0, 1, 1, 5, material(0, 1));
    const amb = [0.9, 0.9, 1] as const, cave = [0.1, 0.08, 0.12] as const;
    const at = (x: number, y: number) => { st.entities.length = 0; const id = st.entities.add({ model: m, x, y, z: 16, facing: 0, castsShadow: false }); return st.entities.find((e) => e.id === id)!; };
    const [sx, sy] = b.cam.project(31.5, 22, 16);
    const o = { vx: Math.max(0, Math.floor(sx) - 32), vy: Math.max(0, Math.floor(sy) - 32), vw: 64, vh: 64, time: 0, lights: true, ambient: amb };
    // Bajo el porche (junto a su borde sur, donde se ve)
    const e1 = at(31, 21), d1 = entitySprite(b, e1, { ...o, cave });
    expect(entitySky(b, d1, { ...o, cave })).toBe(b.sky![d1.fy * b.width + d1.fx]);
    expect(entitySky(b, d1, { ...o, cave })).toBeLessThan(SKY_RAYS);
    expect(entitySky(b, d1, o)).toBe(SKY_RAYS);                   // sin cave, como siempre
    const dark = f2(st, b, { ...o, cave }), lit = f2(st, b, o);
    const [ex, ey] = [d1.fx - o.vx, d1.fy - o.vy - 3];            // un píxel del cuerpo, encima de los pies
    const lum = (img: Uint8ClampedArray) => img[(ey * 64 + ex) * 4]! + img[(ey * 64 + ex) * 4 + 1]! + img[(ey * 64 + ex) * 4 + 2]!;
    expect(lum(dark)).toBeLessThan(lum(lit));
    // Al aire libre: con cave o sin él, los píxeles de la entidad (los que cambian al ponerla) son los mismos
    const [ox, oy] = b.cam.project(5.5, 5, 16);
    const o2 = { ...o, vx: Math.max(0, Math.floor(ox) - 32), vy: Math.max(0, Math.floor(oy) - 32) };
    st.entities.length = 0;
    const bare = f2(st, b, o2);
    at(5, 5);
    const withC = f2(st, b, { ...o2, cave }), without = f2(st, b, o2);
    let body = 0;
    for (let i = 0; i < 64 * 64; i++) {
      const isBody = [0, 1, 2].some((c) => without[i * 4 + c] !== bare[i * 4 + c]);
      if (!isBody) continue;
      body++;
      for (let c = 0; c < 3; c++) expect(withC[i * 4 + c]).toBe(without[i * 4 + c]);
    }
    expect(body).toBeGreaterThan(10);
  });
});
