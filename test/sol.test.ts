// El sol (src/world/sunlight.ts): suma a lo que ve el cielo según la cara, con nubes que pasan, sin rehornear
import { describe, expect, it } from 'vitest';
import { box, material, Model, type Palette } from '../src/core';
import { bakeWorld } from '../src/world/bake';
import { frame2D, frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { daySun } from '../src/lighting/daycycle';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather, type WeatherLevels } from '../src/world/weather';
import { climateTable, type WeatherFrame } from '../src/world/climate';
import { cloudShade, sunLook, CLOUD_DARK } from '../src/world/sunlight';

const PAL: Palette = { ramps: [{ name: 'suelo', colors: ['#202020', '#606060', '#808080'] }] };
function setup(q: Quarter = 0, sky = true) {
  const s = new StaticVoxels(PAL, 160, 160, -4, 47);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) { for (let z = 0; z < 3; z++) s.set(x, y, z, material(0, 1)); if (x >= 40 && x < 80 && y >= 30 && y < 90) for (let z = 24; z < 27; z++) s.set(x, y, z, material(0, 2)); }
  const state = new WorldState(s, [], null, { seed: 1 }), view = new WorldView(state, q), b = bakeWorld(view.bakeable(), { topZ: 52, incline: 0.5, sky });
  return { s, state, view, b };
}
const W = (levels: Partial<WeatherLevels> = {}) => new Weather({ seed: 3, levels });
const SUN = { color: [1, 0.9, 0.7] as const, intensity: 0.5, dir: [0.3, -0.5, 0.8] as const };
const opts = (b: { width: number; height: number }, weather: WeatherFrame | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.4, 0.4, 0.4], weather });

describe('el sol', () => {
  it('sin pedirlo, sin cielo horneado, sin fuerza, de noche o bajo el horizonte, el cuadro de siempre', () => {
    const { b, state } = setup(), ref = frame2D(state, b, opts(b, null));
    for (const f of [{ weather: W(), tick: 0 }, { weather: W(), tick: 0, sunlight: null }, { weather: W(), tick: 0, sunlight: { ...SUN, intensity: 0 } }, { weather: W({ sun: 0 }), tick: 0, sunlight: SUN }, { weather: W(), tick: 0, sunlight: { ...SUN, dir: [0, 1, -0.1] as const } }, { weather: W(), tick: 0, sunlight: daySun(0.9) }])
      expect(frame2D(state, b, opts(b, f))).toEqual(ref);
    const dry = setup(0, false);
    expect(sunLook(dry.b, { weather: W(), tick: 0, sunlight: SUN })).toBeNull();
    expect(frame2D(state, b, opts(b, { weather: W(), tick: 0, sunlight: SUN }))).not.toEqual(ref);
  });
  it('suma según la cara y el cielo: nada bajo techo, y cada cara lo suyo', () => {
    const { b, state } = setup(), f = { weather: W(), tick: 0, sunlight: SUN };
    const ref = frame2DParts(state, b, opts(b, null)).total!, p = frame2DParts(state, b, opts(b, f)).total!, look = sunLook(b, f)!;
    let dark = 0, lit = 0;
    for (let t = 0; t < b.width * b.height; t++) {
      if (b.face[t]! < 0) continue;
      const add = p[t * 3]! - ref[t * 3]!;
      expect(add).toBeCloseTo(look.faces[b.face[t]! * 3]! * b.sky![t]! / 5, 5);
      if (b.sky![t] === 0) dark++; else if (add > 0.1) lit++;
    }
    expect(dark).toBeGreaterThan(100); expect(lit).toBeGreaterThan(1000);
  });
  it('en los 4 giros viene del mismo sitio del mundo', () => {
    // El sol al este: la cara este (0, en ejes del mundo) es la que más recibe, sea cual sea en la vista
    for (const q of [0, 1, 2, 3] as Quarter[]) {
      const { b, view } = setup(q), l = sunLook(b, { weather: W(), tick: 0, camera: view.camera, sunlight: { ...SUN, dir: [1, 0, 0.2] } })!;
      const best = [0, 1, 2, 3].reduce((m, i) => (l.faces[i * 3]! > l.faces[m * 3]! ? i : m), 0);
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const, [wx, wy] = view.camera.dirToWorld(dirs[best]![0], dirs[best]![1]);
      expect([wx + 0, wy + 0]).toEqual([1, 0]);
    }
  });
  it('las nubes: despejado nada, cubierto todo, y en medio un reparto que se mueve con el viento', () => {
    const { b } = setup(), at = (levels: Partial<WeatherLevels>, tick: number, origin: [number, number] = [0, 0]) => { const c = climateTable(b, opts(b, { weather: W(levels), tick, origin }))!; return Array.from({ length: 40 }, (_, k) => cloudShade(c, k * 4, 80)); };
    expect(at({ clouds: 0 }, 0).every((v) => v === 1)).toBe(true);
    expect(at({ clouds: 1 }, 0).every((v) => Math.abs(v - (1 - CLOUD_DARK)) < 1e-6)).toBe(true);
    const a = at({ clouds: 0.5, wind: [1, 0] }, 0), later = at({ clouds: 0.5, wind: [1, 0] }, 300);
    expect(later).not.toEqual(a);
    // y con la ventana corrida, la misma sombra en el mismo sitio del mundo
    const moved = at({ clouds: 0.5, wind: [1, 0] }, 300, [16, 0]);
    for (let k = 0; k < 30; k++) expect(moved[k]).toBeCloseTo(later[k + 4]!, 6);
    const all = [0, 60, 120, 180, 240, 400, 600, 900].flatMap((t) => at({ clouds: 0.5, wind: [1, 0] }, t));
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(0.4);
  });
  it('a una entidad le llega con el cielo de sus pies', () => {
    const run = (x: number, y: number, weather: WeatherFrame | null) => {
      const { b, state, s } = setup(), m = new Model({ ramps: [{ name: 'a', colors: ['#d0d0d0'] }] }, 'caja');
      box(m, -3, -3, 0, 3, 3, 8, material(0, 0));
      state.entities.add({ model: m, x, y, z: 3, facing: 0, castsShadow: false });
      void s;
      const p = frame2DParts(state, b, opts(b, weather)), ref = frame2DParts(setup().state, b, opts(b, null)).view;
      let sum = 0, n = 0;
      for (let t = 0; t < p.view.length / 4; t++) if (p.view[t * 4] === 208 && ref[t * 4] !== 208) { sum += p.total![t * 3]!; n++; }
      return sum / n;
    };
    const f = { weather: W(), tick: 0, sunlight: SUN };
    expect(run(120, 60, f) - run(120, 60, null)).toBeGreaterThan(0.1);
    // (al norte del techo lo tapa él; dentro, por el lado sur, se ve: sus pies con menos cielo)
    expect(run(60, 32, f) - run(60, 32, null)).toBeLessThan(0.25);
  });
  it('con velo en el corte, alpha 1 sigue siendo lo mismo que sin velo', () => {
    const { b, state, s } = setup();
    for (let x = 90; x < 130; x++) for (let y = 40; y < 50; y++) for (let z = 3; z < 24; z++) s.set(x, y, z, material(0, 1 + (z & 1)));
    const b2 = bakeWorld({ model: s, lights: [], width: 160, depth: 160 }, { topZ: 52, incline: 0.5, sky: true });
    void b;
    const cut = { x0: 80, x1: 140, y0: 0, y1: 44, zMin: 3, depth: 40 }, f = { weather: W({ clouds: 0.5 }), tick: 50, sunlight: SUN };
    const o = { ...opts(b2, f), cave: [0.1, 0.1, 0.1] as const };
    const plain = frame2D(state, b2, { ...o, section: cut }), veil = frame2D(state, b2, { ...o, section: { ...cut, ghost: { z: 10, alpha: 1 } } }), half = frame2D(state, b2, { ...o, section: { ...cut, ghost: { z: 10, alpha: 0.5 } } });
    expect(half).not.toEqual(plain);
    expect(veil).toEqual(plain);
  });
  it('daySun: sale por el este, al mediodía está arriba y fuerte, se pone por el oeste y de noche no hay', () => {
    expect(daySun(0.3).dir[0]).toBeGreaterThan(0.8);
    expect(daySun(0.7).dir[0]).toBeLessThan(-0.8);
    expect(daySun(0.5).dir[2]).toBeGreaterThan(0.85);
    expect(daySun(0.5).intensity).toBeCloseTo(0.55, 6);
    expect(daySun(0.27).color[2]).toBeLessThan(daySun(0.5).color[2]);
    for (const p of [0, 0.1, 0.25, 0.76, 0.99, -0.1]) expect(daySun(p).intensity).toBeCloseTo(0, 6);
  });
});
describe('el alcance de lo que mide la planta (reach 0)', () => {
  it('una baja y una alta de la misma rampa se mecen del todo en su punta', async () => {
    const { swayCode, swayTable, SWAY_UNIT } = await import('../src/world/sway'), { key } = await import('../src/core');
    const pal: Palette = { ramps: [PAL.ramps[0]!, { name: 'm', colors: ['#208020'], material: 'follaje', props: { sway: 2, anchor: 'root', reach: 0 } }] };
    const s = new StaticVoxels(pal, 16, 16, 0, 31), t = swayTable(pal)!;
    for (const [x, h] of [[1, 3], [2, 12]] as const) { s.set(x, 1, 0, material(0, 1)); for (let z = 1; z <= h; z++) s.set(x, 1, z, material(1, 0)); }
    const at = (x: number, z: number) => swayCode(t, s, key(x, 1, z));
    expect([at(1, 3), at(2, 12)]).toEqual([2 * SWAY_UNIT, 2 * SWAY_UNIT]);
    expect(at(1, 1)).toBe(Math.floor(2 * SWAY_UNIT / 3 + 0.5));
    expect(at(2, 6)).toBe(SWAY_UNIT);
  });
});
