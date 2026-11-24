// El viento en la vegetación (src/world/sway.ts): qué se mece, cuánto, qué queda en el hueco, y que nada más cambia
import { describe, expect, it } from 'vitest';
import { key, material, type Palette } from '../src/core';
import { bakeWorld, rebakeChanged, shiftBaked, type Baked } from '../src/world/bake';
import { frame2D, frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather } from '../src/world/weather';
import type { SectionLayer } from '../src/world/section';
import { climateTable, type ClimateTable, type WeatherFrame } from '../src/world/climate';
import { swayCode, swayShift, swaySources, swayTable, SWAY_AQUATIC, SWAY_UNIT } from '../src/world/sway';

const PAL: Palette = { ramps: [
  { name: 'suelo', colors: ['#202020', '#404040', '#606060', '#707070'] },
  { name: 'tronco', colors: ['#3a2010', '#5a3018'] },
  { name: 'copa', colors: ['#104010', '#208020'], material: 'follaje', props: { sway: 3, anchor: 'self' } },
  { name: 'mata', colors: ['#801010', '#c02020'], material: 'follaje', props: { sway: 3, anchor: 'root', reach: 8 } },
  { name: 'liana', colors: ['#101080', '#2020c0'], material: 'follaje', props: { sway: 2, anchor: 'top', reach: 4 } },
  { name: 'alga', colors: ['#108080', '#20c0c0'], material: 'follaje', props: { sway: 1, aquatic: true } },
] };
const [SUELO, TRONCO, COPA, MATA, LIANA, ALGA] = [0, 1, 2, 3, 4, 5].map((r) => material(r, 1)) as [number, number, number, number, number, number];

function world(w = 64, d = 64): StaticVoxels {
  const s = new StaticVoxels(PAL, w, d, -4, 31);
  for (let y = 0; y < d; y++) for (let x = 0; x < w; x++) s.set(x, y, 0, material(0, 1 + ((x * 3 + y * 5) % 3)));
  // Un árbol, unas matas sueltas de una columna y un techo con una liana
  for (let z = 1; z < 12; z++) s.set(20, 30, z, TRONCO);
  for (let z = 10; z < 16; z++) for (let y = 27; y <= 33; y++) for (let x = 16; x <= 24; x++) if (s.get(x, y, z) === 0) s.set(x, y, z, COPA);
  for (const [x, y] of [[36, 20], [42, 34], [8, 12], [50, 44]] as const) for (let z = 1; z < 10; z++) s.set(x, y, z, MATA);
  return s;
}
function setup(q: Quarter = 0, outline?: 'both') {
  const s = world(), state = new WorldState(s, [], null, { seed: 1 });
  const view = new WorldView(state, q), b = bakeWorld(view.bakeable(), { topZ: 40, incline: 0.5, sky: true, ...(outline ? { outline } : {}) });
  return { s, state, view, b };
}
const strong = () => new Weather({ seed: 5, levels: { wind: [1, 0], gust: 0 } });
const opts = (b: Baked, weather?: WeatherFrame | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8], ...(weather !== undefined ? { weather } : {}) });
const pickRamp = (b: Baked, i: number) => { const k = b.pick[i]!; return Number.isNaN(k) ? -1 : Math.floor((b.source.get(...unk(k)) - 1) / 16); };
const unk = (k: number): [number, number, number] => { const z = (k % 4096) - 2048, r = Math.floor(k / 4096), y = (r % 4096) - 2048; return [Math.floor(r / 4096) - 2048, y, z]; };
// Un tick en que algo se corre de verdad
const TICKS = [0, 15, 30, 45, 60, 75];

describe('el vaivén', () => {
  it('sin clima, en calma o sin rampas que se mezan, el cuadro es el de siempre byte a byte', () => {
    const { state, b } = setup();
    const ref = frame2D(state, b, opts(b));
    expect(frame2D(state, b, opts(b, null))).toEqual(ref);
    expect(frame2D(state, b, opts(b, { weather: new Weather({ seed: 5 }), tick: 33 }))).toEqual(ref);
    expect(frame2D(state, b, opts(b, { weather: strong(), tick: 33, sway: 0 }))).toEqual(ref);
    expect(swayTable({ ramps: PAL.ramps.slice(0, 2) })).toBeNull();
  });

  it('el código: la copa entera, la mata según su altura, lo que cuelga desde arriba, el tronco nada', () => {
    const t = swayTable(PAL)!, s = new StaticVoxels(PAL, 16, 16, 0, 31), at = (x: number, y: number, z: number) => swayCode(t, s, key(x, y, z));
    s.set(1, 1, 0, SUELO);
    for (let z = 1; z < 12; z++) s.set(1, 1, z, MATA);
    s.set(2, 1, 0, SUELO); s.set(2, 1, 8, MATA);                        // la flor de al lado, sin nada debajo
    s.set(3, 1, 20, SUELO); for (let z = 14; z < 20; z++) s.set(3, 1, z, LIANA);
    s.set(4, 1, 5, COPA); s.set(5, 1, 5, TRONCO); s.set(6, 1, 5, ALGA);
    expect([1, 4, 8, 11].map((z) => at(1, 1, z))).toEqual([3 / 8, 12 / 8, 3, 3].map((v) => v * SWAY_UNIT));
    expect(at(2, 1, 8)).toBe(at(1, 1, 8));
    expect([19, 18, 16, 14].map((z) => at(3, 1, z))).toEqual([0.5, 1, 2, 2].map((v) => v * SWAY_UNIT));
    expect(at(4, 1, 5)).toBe(3 * SWAY_UNIT);
    expect(at(5, 1, 5)).toBe(0);
    expect(at(6, 1, 5)).toBe(SWAY_AQUATIC | SWAY_UNIT);
    expect(swayCode(t, s, NaN)).toBe(0);
    expect(swayShift(3 * SWAY_UNIT, 1)).toBe(3);
    expect(swayShift(3 * SWAY_UNIT, -1)).toBe(-3);
    expect(swayShift(SWAY_UNIT, 0.49)).toBe(0);
    expect(swayShift(SWAY_AQUATIC, 1)).toBe(0);
  });

  it('se mece la copa y la punta de la mata, y no el suelo, ni el tronco, ni la raíz; el pick no cambia', () => {
    const { b } = setup(), pick = b.pick.slice();
    let moved = 0, root = 0;
    for (const tick of TICKS) {
      const from = swaySources(b, null, null, climateTable(b, opts(b, { weather: strong(), tick }))!, 0, 0, b.width, b.height);
      if (!from) continue;
      for (let t = 0; t < from.length; t++) {
        const x = t % b.width, src = t - x + from[t]!;
        if (from[t] === x) continue;
        moved++;
        // lo que llega de otra columna, o es algo que se mece, o llena el hueco de algo que se meció
        const a = pickRamp(b, src), h = pickRamp(b, t);
        expect(a === 2 || a === 3 || h === 2 || h === 3).toBe(true);
        if (a === 3 && unk(b.pick[src]!)[2] <= 1) root++;
      }
    }
    expect(moved).toBeGreaterThan(200);
    expect(root).toBe(0);
    expect(b.pick).toEqual(pick);
  });

  it('una mata de un píxel de ancho se corre entera: ni se ensancha ni deja hueco', () => {
    const { b, state } = setup();
    const base = frame2DParts(state, b, opts(b)).view;
    let checked = 0;
    for (const tick of TICKS) {
      const from = swaySources(b, null, null, climateTable(b, opts(b, { weather: strong(), tick }))!, 0, 0, b.width, b.height);
      if (!from) continue;
      const view = frame2DParts(state, b, opts(b, { weather: strong(), tick })).view;
      for (let y = 0; y < b.height; y++) {
        const n = (v: Uint8ClampedArray | null) => { let c = 0; for (let x = 0; x < b.width; x++) if (pickRamp(b, y * b.width + (v ? from[y * b.width + x]! : x)) === 3) c++; return c; };
        expect(n(view)).toBe(n(null));
      }
      for (let t = 0; t < from.length; t++) { for (let c = 0; c < 4; c++) expect(view[t * 4 + c]).toBe(base[(t - (t % b.width) + from[t]!) * 4 + c]); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('lo que está delante tapa lo que se mece, y la profundidad del cuadro es la del vóxel quieto', () => {
    const { b, state, s } = setup();
    for (let z = 1; z < 20; z++) for (let y = 14; y < 16; y++) for (let x = 37; x < 41; x++) s.set(x, y, z, TRONCO);       // un pilar delante de la mata de x 36
    rebakeChanged(b, []);
    for (const tick of TICKS) {
      const from = swaySources(b, null, null, climateTable(b, opts(b, { weather: strong(), tick }))!, 0, 0, b.width, b.height);
      if (!from) continue;
      const p = frame2DParts(state, b, opts(b, { weather: strong(), tick }));
      for (let t = 0; t < from.length; t++) {
        expect(p.depth[t]).toBe(b.depth[t - (t % b.width) + from[t]!]);
        if (pickRamp(b, t) === 1) expect(from[t]).toBe(t % b.width);           // el pilar no lo tapa nada de detrás
      }
    }
  });

  it('con la ventana corrida y el origen al día, el mismo sitio del mundo se mece igual', () => {
    const a = setup(), w = new Weather({ seed: 5, levels: { wind: [0.7, 0.4], gust: 1 } });
    for (const tick of TICKS) for (const [x, y] of [[20, 30], [36, 20], [50, 44]] as const) {
      const c0 = climateTable(a.b, opts(a.b, { weather: w, tick }))!;
      const { b } = setup();
      const c1 = climateTable(b, opts(b, { weather: w, tick, origin: [16, -48] }))!;
      expect(leanOf(c1, x - 16, y + 48)).toBe(leanOf(c0, x, y));
    }
    void shiftBaked;
  });
  it('en los 4 giros es el mismo viento: el sitio del mundo, con la inclinación de su vista', () => {
    const w = new Weather({ seed: 5, levels: { wind: [1, 0], gust: 1 } });
    const force = ([0, 1, 2, 3] as Quarter[]).map((q) => {
      const { view, b } = setup(q), c = climateTable(b, opts(b, { weather: w, tick: 40, camera: view.camera }))!;
      // (los centros de las casillas de 16 x 32 no coinciden al girar un cuarto: se comparan los giros 0 y 2)
      const [vx, vy] = view.camera.pointToView(24, 24);
      return at(c, vx, vy, 2);
    });
    expect(force[2]).toBe(force[0]);
    expect(force[1]).toBeGreaterThan(0);
    const lean = ([0, 2] as Quarter[]).map((q) => { const { view, b } = setup(q), c = climateTable(b, opts(b, { weather: new Weather({ seed: 5, levels: { wind: [1, 0] } }), tick: 40, camera: view.camera }))!; let s = 0; for (let i = 0; i < c.w * c.h; i++) s += c.data[i * 4]!; return s / (c.w * c.h); });
    expect(lean[0]).toBeGreaterThan(0.2);
    expect(lean[1]).toBeLessThan(-0.2);
  });

  // Una tabla del clima hecha a mano: la misma inclinación en todas partes
  const flat = (lean: number): ClimateTable => ({ x0: 0, y0: 0, w: 1, h: 1, kx: 0, ky: 0, data: Float32Array.of(lean, lean, 1, 0), sway: true, levels: new Weather({ seed: 1 }).levels(0), key: `plano${lean}` });
  it('hacia dónde: con inclinación 1 la punta va 3 píxeles a la derecha, con -1 a la izquierda, y el hueco sale del lado de donde viene', () => {
    const { b } = setup();
    for (const lean of [1, -1]) {
      const from = swaySources(b, null, null, flat(lean), 0, 0, b.width, b.height)!;
      let tips = 0, holes = 0;
      for (let t = 0; t < from.length; t++) {
        const x = t % b.width;
        if (pickRamp(b, t) !== 3 || unk(b.pick[t]!)[2] !== 9) continue;
        expect(from[t + 3 * lean]).toBe(x);                                    // la punta llega a su sitio
        tips++;
        expect(from[t]).toBe(x - lean);                                        // y en el suyo queda lo quieto de al lado
        holes++;
      }
      expect(tips).toBeGreaterThan(2);
      expect(holes).toBe(tips);
    }
  });
  it('el hueco no se llena con algo que está más cerca, y sin nada que lo llene queda lo que había', () => {
    const { b, s } = setup();
    // Un pilar delante, pegado a la mata de x 36 por la izquierda
    for (let z = 1; z < 24; z++) for (let y = 10; y < 13; y++) for (let x = 25; x < 36; x++) s.set(x, y, z, TRONCO);
    rebakeChanged(b, []);
    const from = swaySources(b, null, null, flat(1), 0, 0, b.width, b.height)!;
    let n = 0;
    for (let t = 0; t < from.length; t++) if (pickRamp(b, t) === 3 && unk(b.pick[t]!)[0] === 36 && unk(b.pick[t]!)[2] === 9) { if (pickRamp(b, t - 1) !== 1) continue; expect(from[t]).toBe(t % b.width); n++; }
    expect(n).toBeGreaterThan(0);
  });
  it('la mitad de vaivén es la mitad de inclinación, y cambiar de viento rehace la tabla', () => {
    const { b } = setup(), w = strong();
    const full = climateTable(b, opts(b, { weather: w, tick: 45 }))!.data.slice(), half = climateTable(b, opts(b, { weather: w, tick: 45, sway: 0.5 }))!.data.slice();
    expect(full.some((v, i) => i % 4 === 0 && Math.abs(v) > 0.3)).toBe(true);
    for (let i = 0; i < full.length; i += 4) expect(Math.abs(half[i]! - full[i]! / 2)).toBeLessThanOrEqual(1 / 256);
    climateTable(b, opts(b, { weather: w, tick: 45 }));
    w.set({ wind: [0, 1] }, 45, 0);
    expect(climateTable(b, opts(b, { weather: w, tick: 45 }))!.data).not.toEqual(full);
  });
  it('lo que se mece lleva su luz: la del píxel del que sale', () => {
    const s = world(), state = new WorldState(s, [{ id: 'l', kind: 'torch', x: 40.5, y: 16.5, z: 8 }], null, { seed: 1 });
    const b = bakeWorld({ model: s, lights: [...state.lights], width: 64, depth: 64 }, { topZ: 40, incline: 0.5 });
    const o = { ...opts(b, { weather: strong(), tick: 45 }), ambient: [0.2, 0.2, 0.2] as const };
    const still = frame2DParts(state, b, { ...o, weather: null }).total!, p = frame2DParts(state, b, o).total!;
    const from = swaySources(b, null, null, climateTable(b, o)!, 0, 0, b.width, b.height)!;
    let diff = 0;
    for (let t = 0; t < from.length; t++) { const q = t - (t % b.width) + from[t]!; for (let c = 0; c < 3; c++) { expect(p[t * 3 + c]).toBe(still[q * 3 + c]); if (p[t * 3 + c] !== still[t * 3 + c]) diff++; } }
    expect(diff).toBeGreaterThan(20);
  });
  it('en el corte: lo de dentro no sale, lo de fuera no entra, y los píxeles con velo no se mecen', () => {
    const { b } = setup();
    // Una capa a mano: las columnas x0..x1 de la imagen, sustituidas por lo mismo que había
    const layer = (x0: number, x1: number, on: boolean): SectionLayer => {
      const w = x1 - x0 + 1, h = b.height, mask = new Uint8Array(w * h).fill(1), depth = new Float32Array(w * h), pick = new Float64Array(w * h);
      for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) { depth[y * w + x - x0] = b.depth[y * b.width + x]!; pick[y * w + x - x0] = b.pick[y * b.width + x]!; }
      return { x: x0, y: 0, w, h, rw: w, ox: 0, mask, depth, pick, ghost: on ? { on: new Uint8Array(w * h).fill(1) } : null } as unknown as SectionLayer;
    };
    // (la mata de x 36 entra en la capa; la de x 42, fuera, a 2 de su borde)
    const L = layer(30, 40, false), V = layer(30, 40, true);
    let seen = 0, out = 0;
    for (const lean of [1, -1]) {
      const from = swaySources(b, L, null, flat(lean), 0, 0, b.width, b.height)!, veiled = swaySources(b, V, V.ghost!.on, flat(lean), 0, 0, b.width, b.height)!;
      const inL = (x: number) => x >= 30 && x <= 40;
      for (let t = 0; t < from.length; t++) {
        const x = t % b.width;
        if (inL(x) !== inL(from[t]!)) out++;
        if (inL(x) && from[t] !== x && pickRamp(b, t - x + from[t]!) === 3) seen++;
        if (inL(x)) expect(veiled[t]).toBe(x);
      }
    }
    expect(out).toBe(0);
    expect(seen).toBeGreaterThan(5);
  });

  it('con contorno y en los 4 giros sigue habiendo algo que se mece', () => {
    for (const q of [0, 1, 2, 3] as Quarter[]) {
      const { b, state, view } = setup(q, 'both');
      const ref = frame2D(view.frame(), b, opts(b));
      const changed = TICKS.some((tick) => { const f = frame2D(view.frame(), b, opts(b, { weather: new Weather({ seed: 5, levels: { wind: [0.7, 0.7], gust: 0 } }), tick, camera: view.camera })); return f.some((v, i) => v !== ref[i]); });
      expect(changed).toBe(true);
      void state;
    }
  });
});

function at(c: NonNullable<ReturnType<typeof climateTable>>, x: number, y: number, ch: number): number {
  const i = Math.floor((x + c.kx) / 16) - c.x0, j = Math.floor((y + c.ky) / 32) - c.y0;
  expect(i >= 0 && j >= 0 && i < c.w && j < c.h).toBe(true);
  return c.data[(j * c.w + i) * 4 + ch]!;
}
function leanOf(c: NonNullable<ReturnType<typeof climateTable>>, x: number, y: number): number {
  const i = Math.floor((x + c.kx) / 16) - c.x0, j = Math.floor((y + c.ky) / 32) - c.y0;
  return c.data[(Math.max(0, Math.min(c.h - 1, j)) * c.w + Math.max(0, Math.min(c.w - 1, i))) * 4]!;
}
