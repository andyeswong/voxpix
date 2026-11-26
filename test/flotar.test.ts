// Lo que flota se mece con el rizado del agua (MaterialProps.afloat, waves.ts rideLean) y la corriente de lo de agua crece
// con el agua movida (WeatherFrame.still)
import { describe, expect, it } from 'vitest';
import { key, material, type Palette } from '../src/core';
import { bakeWorld } from '../src/world/bake';
import { frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { WorldView } from '../src/world/view';
import { Weather, type WeatherLevels } from '../src/world/weather';
import { climateTable, type ClimateTable } from '../src/world/climate';
import { rideLean, waveTile, RIDE_GAIN, WAVE_T, type WaveTile } from '../src/world/waves';
import { swayCode, swaySources, swayTable, SWAY_AFLOAT, SWAY_UNIT } from '../src/world/sway';
import type { World } from '../src/world/build';

const PAL: Palette = { ramps: [
  { name: 'suelo', colors: ['#302010', '#604020'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'], material: 'follaje' },
  { name: 'hoja', colors: ['#20a020', '#40e040'], material: 'follaje', props: { sway: 2, anchor: 'self', afloat: true } },
  { name: 'quieta', colors: ['#a0a020', '#e0e040'], material: 'follaje', props: { afloat: true } },
  { name: 'mata', colors: ['#801010', '#c02020'], material: 'follaje', props: { sway: 2, anchor: 'self' } },
] };
// La misma paleta sin afloat: lo que flota va con el aire como antes
const AIR: Palette = { ramps: PAL.ramps.map((r) => (r.name === 'hoja' ? { ...r, props: { sway: 2, anchor: 'self' } } : r)) };
const [SUELO, HOJA, QUIETA, MATA] = [0, 2, 3, 4].map((r) => material(r, 1)) as [number, number, number, number];

// Una tabla del clima de una casilla y una baldosa de rizado hechas a mano
const flat = (air: number, wind = 1): ClimateTable => ({ x0: 0, y0: 0, w: 1, h: 1, kx: 0, ky: 0, data: Float32Array.of(air, air, wind, 0), sway: true });
function tile(c: ClimateTable, at: (gx: number, gy: number) => [number, number] = () => [0, 0]): WaveTile {
  const data = new Float32Array(WAVE_T * WAVE_T * 4);
  for (let gy = 0; gy < WAVE_T; gy++) for (let gx = 0; gx < WAVE_T; gx++) { const [wx, rx] = at(gx, gy), o = (gy * WAVE_T + gx) * 4; data[o] = wx; data[o + 2] = rx; }
  return { data, kx: 0, ky: 0, climate: c };
}

describe('lo que flota y el rizado', () => {
  it('el código lleva el bit de flotar solo si además se mece', () => {
    const t = swayTable(PAL)!, s = new StaticVoxels(PAL, 8, 8, 0, 15);
    s.set(1, 1, 2, HOJA); s.set(2, 1, 2, QUIETA); s.set(3, 1, 2, MATA);
    expect(swayCode(t, s, key(1, 1, 2))).toBe(SWAY_AFLOAT | (2 * SWAY_UNIT));
    expect(swayCode(t, s, key(2, 1, 2))).toBe(0);
    expect(swayCode(t, s, key(3, 1, 2))).toBe(2 * SWAY_UNIT);
    expect(t.anyAfloat).toBe(true);
    expect(swayTable(AIR)!.anyAfloat).toBe(false);
  });

  it('la inclinación es la del rizado en x de la celda de debajo, con su viento, por RIDE_GAIN', () => {
    // celda (5, 3): tren 0.25 y anillos 0.125; el resto, nada
    const w = tile(flat(0, 0.5), (gx, gy) => (gx === 5 && gy === 3 ? [0.25, 0.125] : [0, 0]));
    expect(rideLean(w, 10, 7)).toBe(RIDE_GAIN * (0.25 * 0.5 + 0.125));
    expect(rideLean(w, 11, 6.5)).toBe(RIDE_GAIN * (0.25 * 0.5 + 0.125));
    expect(rideLean(w, 12, 7)).toBe(0);
    expect(rideLean(w, 10, 8)).toBe(0);
    // la baldosa se repite: la celda 5 + 64
    expect(rideLean(w, 10 + 2 * WAVE_T, 7)).toBe(rideLean(w, 10, 7));
    // y con el desfase de la vista (kx, ky)
    expect(rideLean({ ...w, kx: 1, ky: 0 }, 8, 7)).toBe(rideLean(w, 10, 7));
  });

  // Un estanque: suelo a z 2 y agua hasta 8; hojas flotando a z 8 y una mata en la orilla
  function pond(p: Palette) {
    const s = new StaticVoxels(p, 48, 48, 0, 31);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) for (let z = 0; z < (x < 8 || y < 8 || x >= 40 || y >= 40 ? 10 : 2); z++) s.set(x, y, z, SUELO);
    for (const [x, y] of [[16, 16], [17, 16], [16, 17], [26, 22], [27, 22], [30, 30]] as const) s.set(x, y, 8, HOJA);
    for (let z = 10; z < 14; z++) s.set(4, 20, z, MATA);
    const wet = new Uint8Array(48 * 48), waterTop = new Int16Array(48 * 48);
    for (let y = 8; y < 40; y++) for (let x = 8; x < 40; x++) { wet[y * 48 + x] = 1; waterTop[y * 48 + x] = 8; }
    const world = { model: s, lights: [], width: 48, depth: 48, wet, waterTop, fountain: null } as unknown as World;
    const state = new WorldState(s, [], new WaterLayer(world, { wallAbove: 9 }), { seed: 1 });
    const view = new WorldView(state, 0), b = bakeWorld(view.bakeable(), { topZ: 32, incline: 0.5 });
    return { s, state, view, b };
  }
  const opts = (b: ReturnType<typeof pond>['b'], levels: Partial<WeatherLevels>, tick: number, waves: number): Frame2DOptions => ({
    vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8],
    weather: { weather: new Weather({ seed: 3, levels }), tick, waves },
  });
  const WIND: Partial<WeatherLevels> = { wind: [0.9, 0.2], gust: 0.3 };

  it('sin rizado (waves 0) lo que flota va con el aire: el cuadro es byte a byte el de la misma rampa sin afloat', () => {
    const a = pond(PAL), r = pond(AIR);
    for (const tick of [12, 40, 77]) {
      const fa = frame2DParts(a.view.frame(), a.b, opts(a.b, WIND, tick, 0)), fr = frame2DParts(r.view.frame(), r.b, opts(r.b, WIND, tick, 0));
      expect(fa.view).toEqual(fr.view);
    }
  });

  it('con rizado, las hojas se corren según la ola de su celda y la mata de la orilla según el aire, como antes', () => {
    const a = pond(PAL);
    let differ = 0, leafShifts = new Set<number>();
    for (const tick of [12, 24, 36, 48, 60, 72]) {
      const o = opts(a.b, WIND, tick, 1), clim = climateTable(a.b, o)!;
      const waves = waveTile(a.b, o.weather, clim)!;
      expect(waves).not.toBeNull();
      // (null: nada se corre, cada píxel sale del suyo)
      const W = a.b.width, n = W * a.b.height, id = (f: Int32Array | null) => f ?? Int32Array.from({ length: n }, (_, t) => t % W);
      const from = id(swaySources(a.b, null, null, clim, 0, 0, W, a.b.height, waves)), air = id(swaySources(a.b, null, null, clim, 0, 0, W, a.b.height));
      for (let t = 0; t < from.length; t++) {
        const k = a.b.pick[from[t]! + (t - (t % a.b.width))]!;
        if (Number.isNaN(k)) continue;
        const v = a.s.get(...unk(k));
        if (v === MATA) expect(from[t]).toBe(air[t]);                            // la mata, igual con y sin rizado
        if (v === HOJA) { leafShifts.add(t % a.b.width - from[t]!); if (from[t] !== air[t]) differ++; }
      }
    }
    expect(differ).toBeGreaterThan(0);                                          // el rizado manda, no el aire
    expect([...leafShifts].some((d) => d !== 0)).toBe(true);
    expect([...leafShifts].every((d) => Math.abs(d) <= 3)).toBe(true);          // SWAY_MAX
  });

  it('con el agua quieta no se mueven, y con rizado solo cambia de dónde sale lo de las hojas', () => {
    const a = pond(PAL), r = pond(AIR);
    const calm = opts(a.b, {}, 30, 1);
    expect(swaySources(a.b, null, null, climateTable(a.b, calm)!, 0, 0, a.b.width, a.b.height, waveTile(a.b, calm.weather, climateTable(a.b, calm)))).toBeNull();
    const o = opts(a.b, WIND, 36, 1);
    const clim = climateTable(a.b, o)!, from = swaySources(a.b, null, null, clim, 0, 0, a.b.width, a.b.height, waveTile(a.b, o.weather, clim))!;
    const fromAir = swaySources(r.b, null, null, climateTable(r.b, o)!, 0, 0, r.b.width, r.b.height)!;
    for (let t = 0; t < from.length; t++) {
      if (from[t] === fromAir[t]) continue;
      // donde difiere de dónde sale el píxel, lo que sale (en uno u otro) es una hoja, o el hueco que dejó
      const y = t - (t % a.b.width), ks = [a.b.pick[from[t]! + y]!, r.b.pick[fromAir[t]! + y]!, a.b.pick[t]!];
      expect(ks.some((k) => !Number.isNaN(k) && a.s.get(...unk(k)) === HOJA)).toBe(true);
    }
  });
});

describe('la corriente de lo de agua', () => {
  const PALQ: Palette = { ramps: [{ name: 'suelo', colors: ['#302010', '#604020'] }, { name: 'alga', colors: ['#108080', '#20c0c0'], material: 'follaje', props: { sway: 1, aquatic: true } }] };
  function table(levels: Partial<WeatherLevels>, tick: number, still?: number) {
    const s = new StaticVoxels(PALQ, 64, 64, 0, 15);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) s.set(x, y, 0, material(0, 1));
    const state = new WorldState(s, [], null, { seed: 1 }), b = bakeWorld(new WorldView(state, 0).bakeable(), { topZ: 16, incline: 0.5 });
    return climateTable(b, { vx: 0, vy: 0, vw: b.width, vh: b.height, weather: { weather: new Weather({ seed: 9, levels }), tick, ...(still !== undefined ? { still } : {}) } })!;
  }
  const maxOf = (c: ClimateTable, ch: number) => { let m = 0; for (let i = ch; i < c.data.length; i += 4) m = Math.max(m, Math.abs(c.data[i]!)); return m; };
  const S = 0.25;
  it('sin still, la de siempre: no depende del agua movida', () => {
    for (const tick of [0, 37, 111]) {
      expect(table({}, tick).data).toEqual(table({}, tick, 1).data);
      const calm = table({}, tick).data, wet = table({ rain: 1 }, tick).data;
      for (let i = 1; i < calm.length; i += 4) expect(wet[i]).toBe(calm[i]);
    }
  });
  it('con still, el agua quieta queda en esa parte; con lluvia o viento a tope, entera', () => {
    let still = 0, rain = 0;
    for (let tick = 0; tick < 600; tick += 37) { still = Math.max(still, maxOf(table({}, tick, S), 1)); rain = Math.max(rain, maxOf(table({ rain: 1 }, tick, S), 1)); }
    expect(still).toBeLessThanOrEqual(0.5 * S + 1 / 256);
    expect(still).toBeGreaterThan(0.5 * S * 0.8);                              // y algo se mueve
    expect(rain).toBeGreaterThan(0.45);
    // la lluvia no inclina el aire
    expect(maxOf(table({ rain: 1 }, 37, S), 0)).toBe(0);
  });
});

const unk = (k: number): [number, number, number] => { const z = (k % 4096) - 2048, r = Math.floor(k / 4096), y = (r % 4096) - 2048; return [Math.floor(r / 4096) - 2048, y, z]; };
