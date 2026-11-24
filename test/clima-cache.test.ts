// Lo que el clima guarda de un cuadro al siguiente (las gotas y la tabla) da lo mismo que hecho de nuevo, cambie lo que cambie; y
// el sol de cada píxel (cuánto lleva) en lo que lo tapa o lo lleva consigo
import { describe, expect, it } from 'vitest';
import { box, FX_STRIDE, material, Model, key, type Palette } from '../src/core';
import { bakeWorld, type Baked } from '../src/world/bake';
import { frame2DParts, shadeLayers, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather } from '../src/world/weather';
import { climateTable, type WeatherFrame } from '../src/world/climate';
import { fallSource } from '../src/world/precipitation';
import { sunQ, SUN_Q } from '../src/world/sunlight';
import { swayCode, swaySources, swayTable, SWAY_BARE } from '../src/world/sway';
import type { World } from '../src/world/build';

const PAL: Palette = { ramps: [
  { name: 'suelo', colors: ['#404040', '#606060'] }, { name: 'alga', colors: ['#108080', '#20c0c0'], material: 'follaje', props: { sway: 2, anchor: 'self', aquatic: true } },
  { name: 'flor', colors: ['#c02080', '#e040a0'], material: 'follaje', props: { snow: false } }, { name: 'copa', colors: ['#208020', '#30a030'], material: 'follaje', props: { sway: 3 } },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
function land(roof = 0): StaticVoxels {
  const s = new StaticVoxels(PAL, 128, 128, 0, 47);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) { for (let z = 0; z < 3; z++) s.set(x, y, z, material(0, (x + y) & 1)); if (x < roof) s.set(x, y, 30, material(0, 1)); }
  return s;
}
const bakeOf = (s: StaticVoxels) => bakeWorld({ model: s, lights: [], width: s.width, depth: s.depth }, { topZ: 52, incline: 0.5, sky: true });

describe('lo guardado da lo mismo que hecho de nuevo', () => {
  const a = land(), roofed = land(64), weather = new Weather({ seed: 3, levels: { rain: 1, wind: [0.5, 0.2], gust: 0.7, clouds: 0.5 } });
  const cams = ([0, 1, 2] as Quarter[]).map((q) => new WorldView(new WorldState(a, [], null), q).camera);
  const base = { vx: 0, vy: 0, vw: 64, vh: 64 }, f0: WeatherFrame = { weather, tick: 40, fall: { max: 200 } };
  const variants: Array<[string, Partial<typeof base>, Partial<WeatherFrame>]> = [['la vista en x', { vx: 33 }, {}], ['la vista en y', { vy: 40 }, {}], ['el alto', { vh: 100 }, {}], ['el ancho', { vw: 90 }, {}], ['el tope', {}, { fall: { max: 60 } }],
    ['el origen', {}, { origin: [40, 24] }], ['el origen en x, casillas enteras', {}, { origin: [48, 0] }], ['el origen en y', {}, { origin: [0, 64] }], ['los vóxeles del mundo', {}, { solid: roofed }], ['la cámara', {}, { camera: cams[1]! }], ['otra cámara', {}, { camera: cams[2]! }], ['el paso', {}, { tick: 90 }], ['el vaivén', {}, { sway: 0.5 }]];
  for (const [name, v, f] of variants) it(`cambiando ${name}`, () => {
    const old = bakeOf(a), fresh = bakeOf(a), o = { ...base, ...v, weather: { ...f0, ...f } };
    const pts = (b: Baked, oo: typeof base & { weather: WeatherFrame }) => { const s = fallSource(b, oo, null)!; return Array.from(s.packed.slice(0, s.count * FX_STRIDE)); };
    pts(old, { ...base, weather: f0 }); climateTable(old, { ...base, weather: f0 });
    expect(pts(old, o)).toEqual(pts(fresh, o));
    expect(climateTable(old, o)).toEqual(climateTable(fresh, o));
  });
  it('lo que cae llega hasta el borde de la vista aunque la vista no empiece en un múltiplo de 16', () => {
    const b = bakeOf(a);
    let edge = 0, far = 0;
    for (let tick = 0; tick < 240; tick += 2) { const s = fallSource(b, { ...base, vx: 15, weather: { ...f0, tick, fall: { max: 800 } } }, null)!; for (let k = 0; k < s.count; k++) { const x = s.packed[k * FX_STRIDE]!; if (x >= 66 && x < 79) edge++; if (x >= 20 && x < 33) far++; } }
    expect(edge).toBeGreaterThan(far * 0.5);
  });
});

describe('el sol de cada píxel', () => {
  const sunny = (dir: [number, number, number] = [0, 0, 1], intensity = 0.5): WeatherFrame => ({ weather: new Weather({ seed: 1 }), tick: 45, sunlight: { color: [1, 0.9, 0.7], intensity, dir } });
  const opts = (b: Baked, weather: WeatherFrame | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.4, 0.4, 0.4], weather });
  it('va en pasos de 1 / SUN_Q, y por encima de 1 da brillo', () => {
    for (const v of [0.1234, 0.5, 1.71]) expect(sunQ(v) * SUN_Q).toBe(Math.round(v * SUN_Q));
    const s = land(), st = new WorldState(s, [], null), b = bakeOf(s), o = opts(b, sunny([0, 0, 1], 2)), p = frame2DParts(st, b, o), l = shadeLayers(p.total!, o, b, p.depth, p.sun), i = (90 * b.width + 60) * 4;
    expect(l.add[i]).toBeGreaterThan(60);
  });
  it('lo que se mece lleva su sol', () => {
    const s = land();
    for (let z = 10; z < 18; z++) for (let y = 50; y < 58; y++) for (let x = 50; x < 58; x++) s.set(x, y, z, material(3, 0));
    const st = new WorldState(s, [], null), b = bakeOf(s), w = new Weather({ seed: 5, levels: { wind: [1, 0] } }), mk = (sway: number): WeatherFrame => ({ ...sunny([0.2, -0.9, 0.4]), weather: w, sway });
    const still = frame2DParts(st, b, opts(b, mk(0))).sun!.amount, moved = frame2DParts(st, b, opts(b, mk(1))).sun!.amount, from = swaySources(b, null, null, climateTable(b, opts(b, mk(1)))!, 0, 0, b.width, b.height)!;
    let d = 0;
    for (let t = 0; t < from.length; t++) { expect(moved[t]).toBe(still[t - (t % b.width) + from[t]!]); if (moved[t] !== still[t]) d++; }
    expect(d).toBeGreaterThan(5);
  });
  it('0 en lo que lleva luz propia (resalte, entidad emisiva, partícula, gota), y menos en la sombra de contacto', () => {
    const s = land(), st = new WorldState(s, [], null), b = bakeOf(s);
    const body = (emissive: boolean) => { const m = new Model({ ramps: [{ name: 'a', colors: ['#30f030'], ...(emissive ? { emissive: true } : {}) }] }, 'caja'); box(m, -3, -3, 0, 3, 3, 6, material(0, 0)); return m; };
    st.entities.add({ model: body(true), x: 30, y: 60, z: 3, facing: 0, castsShadow: false });
    st.entities.add({ model: body(false), x: 70, y: 60, z: 3, facing: 0, castsShadow: false });
    st.fx.burst({ burst: 1, life: [9, 9], speed: [0, 0], colors: ['#ff8030'], light: { radius: 2 } }, 100.5, 60, 8, 1);
    st.fx.burst({ burst: 1, life: [9, 9], speed: [0, 0], colors: ['#8080ff'] }, 110.5, 60, 8, 1);
    st.palette = { ...PAL };
    st.drops.emit(90.5, 60, 9, 0, 0, 0);
    const o: Frame2DOptions = { ...opts(b, sunny()), highlight: { box: [10, 100, 0, 14, 104, 2], color: [255, 0, 0], width: 1 } }, p = frame2DParts(st, b, o), a = p.sun!.amount;
    const at = (x: number, y: number, z: number) => { const [sx, sy] = b.cam.project(x, y, z); return a[Math.floor(sy) * b.width + Math.floor(sx)]!; };
    expect(at(30, 60, 9)).toBe(0);
    expect(at(70, 60, 9)).toBeGreaterThan(0.3); expect(at(70, 60, 9)).toBeLessThan(0.5);
    expect(at(100.5, 60, 8)).toBe(0);
    expect(at(110.5, 60, 8)).toBeCloseTo(0.5, 5);
    expect(at(90.5, 60, 9)).toBe(0);
    let hl = 0, contact = 0;
    for (let t = 0; t < a.length; t++) { if (p.view[t * 4] === 255 && p.view[t * 4 + 1] === 0) { hl++; expect(a[t]).toBe(0); } if (Math.abs(a[t]! - 0.35) < 1e-6) contact++; }
    expect(hl).toBeGreaterThan(5); expect(contact).toBeGreaterThan(5);
  });
  it('bajo el agua: donde se ve el fondo, el suyo; y la planta de agua, entre el suyo y el de la superficie', () => {
    const run = (top: number) => {
      const s = new StaticVoxels(PAL, 64, 64, 0, 31);
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < (x < 8 || y < 8 || x >= 56 || y >= 56 ? 10 : 2); z++) s.set(x, y, z, material(0, 0));
      for (let x = 20; x < 40; x++) for (let y = 24; y < 40; y++) for (let z = 2; z < top - 1; z++) s.set(x, y, z, material(1, 0));
      const wet = new Uint8Array(64 * 64), waterTop = new Int16Array(64 * 64);
      for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) { wet[y * 64 + x] = 1; waterTop[y * 64 + x] = top; }
      const water = new WaterLayer({ model: s, lights: [], width: 64, depth: 64, wet, waterTop, fountain: null } as unknown as World, { wallAbove: 9 }), b = bakeOf(s), f = sunny([0, -1, 0.15]);
      const wetP = frame2DParts(new WorldState(s, [], water), b, opts(b, f)), dryP = frame2DParts(new WorldState(s, [], null), b, opts(b, f));
      return { b, wet: wetP, dry: dryP };
    };
    // Honda: la cara del sur de las plantas (mucho sol) se ve a través de la superficie (poco)
    const deep = run(9), front: number[] = [];
    for (let t = 0; t < deep.b.width * deep.b.height; t++) if (deep.b.face[t] === 3 && deep.dry.sun!.amount[t]! > 0.4 && deep.wet.depth[t] !== deep.dry.depth[t]) front.push(deep.wet.sun!.amount[t]!);
    expect(front.length).toBeGreaterThan(10);
    for (const v of front) { expect(v).toBeGreaterThan(0.12); expect(v).toBeLessThan(0.42); }
    // Llana: donde se ve el fondo (la trama de la orilla), el sol del fondo tal cual
    const thin = run(3);
    let seen = 0;
    for (let t = 0; t < thin.b.width * thin.b.height; t++) if (thin.wet.depth[t] === thin.dry.depth[t] && thin.wet.view[t * 4] !== thin.dry.view[t * 4]) { seen++; expect(thin.wet.sun!.amount[t]).toBeCloseTo(thin.dry.sun!.amount[t]!, 2); }
    expect(seen).toBeGreaterThan(50);
  });
  it('el código de una rampa quieta que no toma nieve', () => {
    const s = new StaticVoxels(PAL, 16, 16, 0, 15);
    s.set(1, 1, 1, material(2, 0)); s.set(2, 1, 1, material(0, 0));
    const t = swayTable(PAL)!;
    expect(swayCode(t, s, key(1, 1, 1))).toBe(SWAY_BARE);
    expect(swayCode(t, s, key(2, 1, 1))).toBe(0);
  });
});
