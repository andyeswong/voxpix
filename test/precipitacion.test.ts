// La lluvia y la nieve del clima (src/world/precipitation.ts): dónde caen, con qué tope, y lo que dejan
import { describe, expect, it } from 'vitest';
import { FX_STRIDE, material, type Palette } from '../src/core';
import { bakeWorld, type Baked } from '../src/world/bake';
import { frame2D, frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather, type WeatherLevels } from '../src/world/weather';
import type { WeatherFrame } from '../src/world/climate';
import { coverLook, fallSource } from '../src/world/precipitation';
import { sectionLayer, sectionAt, sectionBorderAt, crossWindow } from '../src/world/section';

const PAL: Palette = { ramps: [{ name: 'suelo', colors: ['#202020', '#606060', '#808080'] }, { name: 'techo', colors: ['#402010', '#704020'] }] };
// Un suelo y, sobre x 40..79, y 30..89, un techo a z 24
function setup(q: Quarter = 0, sky = true) {
  const s = new StaticVoxels(PAL, 128, 128, -4, 47);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { for (let z = 0; z < 3; z++) s.set(x, y, z, material(0, 1)); if (x >= 40 && x < 80 && y >= 30 && y < 90) for (let z = 24; z < 27; z++) s.set(x, y, z, material(1, 1)); }
  const state = new WorldState(s, [], null, { seed: 1 }), view = new WorldView(state, q), b = bakeWorld(view.bakeable(), { topZ: 52, incline: 0.5, sky });
  return { s, state, view, b };
}
const W = (levels: Partial<WeatherLevels>) => new Weather({ seed: 3, levels });
const opts = (b: Baked, weather: WeatherFrame | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8], weather });
const points = (b: Baked, f: WeatherFrame) => { const s = fallSource(b, opts(b, f), null); const o: Array<[number, number, number]> = []; if (s) for (let k = 0; k < s.count; k++) o.push([s.packed[k * FX_STRIDE]!, s.packed[k * FX_STRIDE + 1]!, s.packed[k * FX_STRIDE + 2]!]); return o; };

describe('lo que cae', () => {
  it('nada sin pedirlo, sin lluvia o con tope 0; y el cuadro, el de siempre', () => {
    const { b, state } = setup(), ref = frame2D(state, b, opts(b, null));
    expect(frame2D(state, b, opts(b, { weather: W({ rain: 1 }), tick: 7 }))).toEqual(ref);
    expect(frame2D(state, b, opts(b, { weather: W({}), tick: 7, fall: {} }))).toEqual(ref);
    expect(frame2D(state, b, opts(b, { weather: W({ rain: 1 }), tick: 7, fall: { max: 0 } }))).toEqual(ref);
    expect(frame2D(state, b, opts(b, { weather: W({ rain: 1 }), tick: 7, fall: {} }))).not.toEqual(ref);
  });
  it('solo con cielo encima: nunca bajo el techo, y sí encima de él', () => {
    const { b } = setup();
    let over = 0, n = 0;
    for (const levels of [{ rain: 1, wind: [1, 0.3] }, { snow: 1, wind: [-0.7, 0.6] }] as Array<Partial<WeatherLevels>>) for (let tick = 0; tick < 120; tick += 7) for (const [x, y, z] of points(b, { weather: W(levels), tick, fall: {} })) {
      n++;
      const under = x >= 40 && x < 80 && y >= 30 && y < 90;
      if (under) { expect(z).toBeGreaterThanOrEqual(27); over++; } else if (x >= 0 && y >= 0 && x < 128 && y < 128) expect(z).toBeGreaterThanOrEqual(3);
    }
    expect(n).toBeGreaterThan(500);
    expect(over).toBeGreaterThan(50);
  });
  it('con tope, también con lluvia y nieve a la vez', () => {
    const { b } = setup();
    for (const max of [10, 60]) for (let tick = 0; tick < 60; tick += 5) {
      expect(points(b, { weather: W({ rain: 1 }), tick, fall: { max } }).length).toBeLessThanOrEqual(max * 3);
      expect(points(b, { weather: W({ snow: 1 }), tick, fall: { max } }).length).toBeLessThanOrEqual(max);
    }
    const both = points(b, { weather: W({ rain: 1, snow: 1 }), tick: 20, fall: { max: 60 } }).length, one = points(b, { weather: W({ rain: 1 }), tick: 20, fall: { max: 60 } }).length;
    expect(both).toBeLessThan(one);
  });
  it('más lluvia, más gotas; y el viento las inclina', () => {
    const { b } = setup();
    const count = (rain: number) => { let n = 0; for (let t = 0; t < 60; t += 4) n += points(b, { weather: W({ rain }), tick: t, fall: {} }).length; return n; };
    expect(count(0.9)).toBeGreaterThan(count(0.4) * 1.5);
    const lean = (wind: [number, number]) => { const p = points(b, { weather: W({ rain: 1, wind }), tick: 20, fall: {} }); let s = 0, m = 0; for (let k = 0; k + 1 < p.length; k++) if (Math.abs(p[k + 1]![2] - p[k]![2] - 1.6) < 1e-3) { s += p[k + 1]![0] - p[k]![0]; m++; } return s / m; };
    expect(lean([1, 0])).toBeLessThan(-0.2);            // la de más arriba, más atrás
    expect(lean([-1, 0])).toBeGreaterThan(0.2);
    expect(Math.abs(lean([0, 0]))).toBeLessThan(1e-6);
  });
  it('con la ventana corrida (origen al día), las mismas gotas en el mismo sitio del mundo', () => {
    const { b } = setup(), weather = W({ rain: 1, wind: [0.5, 0.2] });
    const inner = (p: Array<[number, number, number]>, dx: number) => p.map(([x, y, z]) => [x + dx, y, z].map((v) => Math.round(v * 100)).join()).filter((k) => { const [x, y] = k.split(',').map(Number) as [number, number]; return x > 8100 && x < 12000 && y > 3000 && y < 8000; }).sort();
    const a = inner(points(b, { weather, tick: 33, fall: {}, origin: [0, 0] }), 0), c = inner(points(b, { weather, tick: 33, fall: {}, origin: [0, 0] }), 0);
    expect(c).toEqual(a);
    expect(a.length).toBeGreaterThan(3);
    // El mismo mundo con su (0, 0) en el vóxel 16 del otro: las columnas de x 16.. son las de 0..
    const s2 = new StaticVoxels(PAL, 128, 128, -4, 47);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let z = -4; z <= 47; z++) { const v = b.source.get(x + 16, y, z); if (v) s2.set(x, y, z, v); }
    const b2 = bakeWorld({ model: s2, lights: [], width: 128, depth: 128 }, { topZ: 52, incline: 0.5 });
    expect(inner(points(b2, { weather, tick: 33, fall: {}, origin: [16, 0] }), 16).length).toBeGreaterThan(3);
    for (const k of inner(points(b2, { weather, tick: 33, fall: {}, origin: [16, 0] }), 16)) expect(a).toContain(k);
  });
  it('con un corte, ninguna encima de lo que sustituye ni de su borde, también lo que cae por delante del tejado quitado', () => {
    const { b, state } = setup(), cut = { x0: 30, x1: 90, y0: 0, y1: 60, zMin: 3, depth: 40 };
    const [wx, wy] = b.cam.project(60, 60, 12), window = crossWindow(wx, wy, { arm: 24, r: 24, border: { color: '#ffd666', width: 2 } });
    for (const section of [cut, { ...cut, window }]) for (const levels of [{ rain: 1 }, { snow: 1 }]) {
      const L = sectionLayer(b, section)!;
      let without = 0, sub = 0;
      for (let q = 0; q < L.mask.length; q++) if (L.mask[q] === 1) sub++;
      expect(sub).toBeGreaterThan(100);
      for (let tick = 0; tick < 60; tick += 6) {
        const f: WeatherFrame = { weather: W(levels), tick, fall: { max: 1500 } }, o = { ...opts(b, f), section };
        const hits = (sec: typeof L | null) => { const s = fallSource(b, o, sec)!; let n = 0; for (let k = 0; k < s.count; k++) { const [sx, sy] = b.cam.project(s.packed[k * FX_STRIDE]!, s.packed[k * FX_STRIDE + 1]!, s.packed[k * FX_STRIDE + 2]!); const x = Math.floor(sx), y = Math.floor(sy), q = sectionAt(L, x, y); if ((q >= 0 && L.mask[q] === 1) || sectionBorderAt(L, x, y)) n++; } return n; };
        without += hits(null);
        expect(hits(L)).toBe(0);
        const dry = frame2DParts(state, b, { ...opts(b, null), section }).view, wet = frame2DParts(state, b, o).view;
        for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) { const q = sectionAt(L, x, y); if (q >= 0 && L.mask[q] === 1) expect(wet[(y * b.width + x) * 4]).toBe(dry[(y * b.width + x) * 4]); }
      }
      expect(without).toBeGreaterThan(5);      // (sin la regla, caían encima)
    }
  });
  it('en los 4 giros, ninguna bajo el techo del mundo; con solid, aunque la vista esté cortada', () => {
    for (const q of [0, 1, 2, 3] as Quarter[]) {
      const { b, view, s } = setup(q);
      for (const solid of [undefined, s]) for (let tick = 0; tick < 40; tick += 9) for (const [x, y, z] of points(b, { weather: W({ rain: 1, wind: [0.4, 0.4] }), tick, fall: {}, camera: view.camera, ...(solid ? { solid } : {}) })) {
        const [wx, wy] = view.camera.pointToWorld(x, y);
        if (wx > 40.01 && wx < 79.99 && wy > 30.01 && wy < 89.99) expect(z).toBeGreaterThanOrEqual(27);
      }
    }
    // La vista, con el techo cortado: sin solid llueve dentro; con él, no
    const { b, s } = setup(), cut = new StaticVoxels(PAL, 128, 128, -4, 47);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let z = -4; z < 20; z++) { const v = s.get(x, y, z); if (v) cut.set(x, y, z, v); }
    const bc = bakeWorld({ model: cut, lights: [], width: 128, depth: 128 }, { topZ: 52, incline: 0.5 });
    const inside = (solid?: StaticVoxels) => { let n = 0; for (let t = 0; t < 60; t += 3) n += points(bc, { weather: W({ rain: 1 }), tick: t, fall: {}, ...(solid ? { solid } : {}) }).filter(([x, y, z]) => x >= 40 && x < 80 && y >= 30 && y < 90 && z < 24).length; return n; };
    expect(inside()).toBeGreaterThan(10);
    expect(inside(s)).toBe(0);
    void b;
  });
});

describe('lo que dejan', () => {
  const covered = (snow: number, wet: number) => { const w = W({}); w.importState({ ...w.exportState(), snow, wet }); return w; };
  it('sin cielo horneado, sin pedirlo o sin nada acumulado, nada', () => {
    const { b, state } = setup(), dry = setup(0, false), ref = frame2D(state, b, opts(b, null));
    expect(coverLook(dry.b, { weather: covered(1, 1), tick: 0, cover: true })).toBeNull();
    expect(frame2D(state, b, opts(b, { weather: covered(1, 1), tick: 0 }))).toEqual(ref);
    expect(frame2D(state, b, opts(b, { weather: covered(0, 0), tick: 0, cover: true }))).toEqual(ref);
  });
  it('la nieve: solo caras de arriba con cielo, más cuanta más hay; y no cambia ningún vóxel', () => {
    const { b, state, s } = setup(), ref = frame2DParts(state, b, opts(b, null)).view, v0 = s.exportChunks();
    let last = -1;
    for (const snow of [0.2, 0.5, 1]) {
      const p = frame2DParts(state, b, opts(b, { weather: covered(snow, 0), tick: 0, cover: true })).view;
      let n = 0, top = 0;
      for (let t = 0; t < b.width * b.height; t++) {
        const changed = [0, 1, 2].some((c) => p[t * 4 + c] !== ref[t * 4 + c]);
        if (b.face[t] === 4 && b.sky![t] === 5) { top++; if (snow === 1) expect(p[t * 4]).toBeGreaterThan(200); }
        if (changed) { n++; expect(b.face[t]).toBe(4); expect(b.sky![t]!).toBeGreaterThan(0); }
      }
      expect(n).toBeGreaterThan(last);
      expect(top).toBeGreaterThan(1000);
      last = n;
    }
    expect(s.exportChunks()).toEqual(v0);
  });
  it('con menos cielo cuaja menos: junto al techo, después que a campo abierto', () => {
    const { b, state } = setup(), ref = frame2DParts(state, b, opts(b, null)).view, p = frame2DParts(state, b, opts(b, { weather: covered(0.6, 0), tick: 0, cover: true })).view;
    const part = (sky: number) => { let n = 0, m = 0; for (let t = 0; t < b.width * b.height; t++) if (b.face[t] === 4 && b.sky![t] === sky) { m++; if (p[t * 4] !== ref[t * 4]) n++; } return n / m; };
    expect(part(5)).toBeGreaterThan(0.5);
    expect(part(4)).toBeLessThan(part(5) - 0.15);
  });
  it('lo mojado: oscurece lo que ve el cielo, más arriba que a los lados; lo de bajo techo, no', () => {
    const { b, state } = setup(), ref = frame2DParts(state, b, opts(b, null)).view, p = frame2DParts(state, b, opts(b, { weather: covered(0, 1), tick: 0, cover: true })).view;
    let dark = 0, under = 0;
    for (let t = 0; t < b.width * b.height; t++) {
      if (b.face[t]! < 0) continue;
      if (b.sky![t] === 0) { under++; expect(p[t * 4]).toBe(ref[t * 4]); }
      else { expect(p[t * 4]).toBeLessThan(ref[t * 4]!); dark++; }
    }
    expect(dark).toBeGreaterThan(1000); expect(under).toBeGreaterThan(100);
    const ratio = (f: number) => { for (let t = 0; t < b.width * b.height; t++) if (b.face[t] === f && b.sky![t] === 5) return p[t * 4]! / ref[t * 4]!; return NaN; };
    expect(ratio(4)).toBeLessThan(0.75);
    const side = (() => { for (let t = 0; t < b.width * b.height; t++) if (b.face[t] === 3 && b.sky![t]! >= 3) return p[t * 4]! / ref[t * 4]!; return NaN; })();
    expect(side).toBeGreaterThan(ratio(4));
  });
  it('dentro de un corte, nada; con el cielo del mundo (worldSky), lo que lo ve', () => {
    const { b, state } = setup(), cut = { x0: 0, x1: 127, y0: 0, y1: 60, zMin: 3, depth: 40 };
    for (const worldSky of [false, true]) {
      const section = { ...cut, ...(worldSky ? { worldSky } : {}) }, L = sectionLayer(b, section)!;
      const ref = frame2DParts(state, b, { ...opts(b, null), section }).view, p = frame2DParts(state, b, { ...opts(b, { weather: covered(1, 1), tick: 0, cover: true }), section }).view;
      let inCut = 0, sub = 0;
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) { const q = sectionAt(L, x, y); if (q < 0 || L.mask[q] !== 1) continue; sub++; const t = (y * b.width + x) * 4; if (p[t] !== ref[t]) inCut++; }
      expect(sub).toBeGreaterThan(100);
      if (worldSky) expect(inCut).toBeGreaterThan(0); else expect(inCut).toBe(0);
    }
  });
});
