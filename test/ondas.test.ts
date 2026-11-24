// El rizado del agua con el viento y la lluvia (src/world/waves.ts): solo al pintar, orientado con el viento y fijo en el mundo
import { describe, expect, it } from 'vitest';
import { material, type Palette } from '../src/core';
import { bakeWorld } from '../src/world/bake';
import { frame2D, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather, type WeatherLevels } from '../src/world/weather';
import { climateTable, type WeatherFrame } from '../src/world/climate';
import { waveTile, waveSlope, WAVE_T } from '../src/world/waves';
import type { World } from '../src/world/build';

const PAL: Palette = { ramps: [{ name: 'tierra', colors: ['#302010', '#604020'] }, { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] }] };
function pool(q: Quarter = 0) {
  const s = new StaticVoxels(PAL, 160, 160, 0, 31);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) for (let z = 0; z < (x < 8 || y < 8 || x >= 152 || y >= 152 ? 10 : 2); z++) s.set(x, y, z, material(0, 1));
  const wet = new Uint8Array(160 * 160), waterTop = new Int16Array(160 * 160);
  for (let y = 8; y < 152; y++) for (let x = 8; x < 152; x++) { wet[y * 160 + x] = 1; waterTop[y * 160 + x] = 8; }
  const water = new WaterLayer({ model: s, lights: [], width: 160, depth: 160, wet, waterTop, fountain: null } as unknown as World, { wallAbove: 9 }), state = new WorldState(s, [], water, { seed: 1 });
  const view = new WorldView(state, q), b = bakeWorld(view.bakeable(), { topZ: 32, incline: 0.5 });
  const o = (weather: WeatherFrame | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8], weather });
  return { state, view, b, o, water };
}
const W = (levels: Partial<WeatherLevels>) => new Weather({ seed: 3, levels });
const tile = (p: ReturnType<typeof pool>, f: WeatherFrame) => waveTile(p.b, f, climateTable(p.b, p.o(f)));

describe('el rizado del agua', () => {
  it('sin pedirlo, en calma o en seco, el cuadro de siempre; y el simulador no se entera', () => {
    const p = pool(), ref = frame2D(p.state, p.b, p.o(null)), sim = p.water.exportState();
    for (const f of [{ weather: W({ wind: [1, 0], rain: 1 }), tick: 40 }, { weather: W({}), tick: 40, waves: 1 }, { weather: W({ wind: [1, 0], rain: 1 }), tick: 40, waves: 0 }]) expect(frame2D(p.state, p.b, p.o(f))).toEqual(ref);
    expect(frame2D(p.state, p.b, p.o({ weather: W({ wind: [1, 0] }), tick: 40, waves: 1 }))).not.toEqual(ref);
    expect(p.water.exportState()).toEqual(sim);
  });
  it('las ondas van de cara al viento, y en cada giro, al de su vista', () => {
    const lean = (q: Quarter, wind: [number, number]) => {
      const p = pool(q), t = tile(p, { weather: W({ wind }), tick: 40, waves: 1, camera: p.view.camera })!;
      let ax = 0, ay = 0;
      for (let i = 0; i < t.data.length; i += 4) { ax += Math.abs(t.data[i]!); ay += Math.abs(t.data[i + 1]!); }
      return ax / ay;
    };
    expect(lean(0, [1, 0])).toBeGreaterThan(1.3);
    expect(lean(0, [0, 1])).toBeLessThan(1 / 1.3);
    expect(lean(1, [1, 0])).toBeLessThan(1 / 1.3);
    expect(lean(2, [1, 0])).toBeGreaterThan(1.3);
  });
  it('más viento, más ondas en el cuadro; la mitad de waves, la mitad', () => {
    const p = pool(), ref = frame2D(p.state, p.b, p.o(null));
    const n = (wind: number) => frame2D(p.state, p.b, p.o({ weather: W({ wind: [wind, 0] }), tick: 40, waves: 1 })).reduce((a, v, i) => a + (v !== ref[i] ? 1 : 0), 0);
    expect(n(1)).toBeGreaterThan(n(0.5));
    expect(n(0.5)).toBeGreaterThanOrEqual(n(0.1));
    const a = tile(p, { weather: W({ wind: [1, 0] }), tick: 40, waves: 1 })!.data.slice(), h = tile(p, { weather: W({ wind: [1, 0] }), tick: 40, waves: 0.5 })!.data;
    for (let i = 0; i < a.length; i++) expect(Math.abs(h[i]! - a[i]! / 2)).toBeLessThan(2 / 1024);
  });
  it('la lluvia hace anillos sin viento; más lluvia, más; y la baldosa casa consigo misma', () => {
    const p = pool(), rings = (rain: number) => tile(p, { weather: W({ rain }), tick: 40, waves: 1 })!.data.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0);
    expect(rings(1)).toBeGreaterThan(rings(0.3) * 2);
    const t = tile(p, { weather: W({ rain: 1 }), tick: 40, waves: 1 })!;
    expect(t.data.some((v, i) => i % 4 < 2 && v !== 0)).toBe(false);       // (sin viento, nada del viento)
    expect(waveSlope(t, 3, 5, 0, 0)).toBe(waveSlope(t, 3 + WAVE_T, 5 - WAVE_T, 0, 0));
  });
  it('con la ventana corrida, el mismo sitio del mundo lleva la misma onda', () => {
    const p = pool(), weather = W({ wind: [0.8, 0.3], rain: 0.6 }), a = tile(p, { weather, tick: 40, waves: 1 })!, a0 = Array.from({ length: 30 }, (_, k) => waveSlope(a, 20 + k, 11, 1, 0));
    const c = tile(p, { weather, tick: 40, waves: 1, origin: [16, -32] })!;
    expect(Array.from({ length: 30 }, (_, k) => waveSlope(c, 12 + k, 27, 1, 0))).toEqual(a0);
  });
});
