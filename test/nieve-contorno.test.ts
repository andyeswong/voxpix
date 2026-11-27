// La nieve no toma el contorno interior (outline 'both'): ese contorno se pinta en el píxel de detrás de un salto de
// profundidad, que guarda la cara de arriba del suelo, y la trama lo punteaba. coverLine rehace la regla del render con
// la resta en float32 (la de la GPU): aquí se cuenta en cuántos píxeles no coincide con lo que marcó el horneado
import { describe, expect, it } from 'vitest';
import { material, type Palette } from '../src/core';
import { bakeWorld, type Baked } from '../src/world/bake';
import { frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { Weather } from '../src/world/weather';
import { coverLine, coverLook } from '../src/world/precipitation';
import { sectionLayer, sectionAt } from '../src/world/section';

const LINE = '#0a0b0d';
const PAL: Palette = { ramps: [{ name: 'suelo', colors: ['#202020', '#606060', '#808080'] }, { name: 'tronco', colors: ['#2a1a10', '#6a4a30', '#8a6a50'] }] };
const S = 96;
// Un suelo de 3 de alto con columnas ("troncos") de alturas distintas, un escalón y una losa en el aire: saltos de profundidad de todo tipo
function setup(q: Quarter, outline: 'both' | 'outer' | 'none', incline = 0.5) {
  const s = new StaticVoxels(PAL, S, S, -4, 31);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const h = x > 60 ? 6 : 3;
    for (let z = 0; z < h; z++) s.set(x, y, z, material(0, 1 + ((x + y) & 1)));
    if (x % 13 < 3 && y % 11 < 3 && x < 56) for (let z = 3; z < 8 + ((x * 7 + y) % 9); z++) s.set(x, y, z, material(1, 1));
    // una losa en el aire: debajo de su canto se ve el suelo de detrás (el vecino más cerca, encima)
    if (x >= 18 && x < 32 && y >= 70 && y < 76) for (let z = 10; z < 12; z++) s.set(x, y, z, material(1, 2));
  }
  const state = new WorldState(s, [], null, { seed: 1 }), view = new WorldView(state, q);
  return { state, view, b: bakeWorld(view.bakeable(), { topZ: 36, incline, sky: true, outline, ...(outline !== 'none' ? { outlineColor: LINE } : {}) }) };
}
const snowed = (snow: number, wet = 0) => { const w = new Weather({ seed: 3, levels: {} }); w.importState({ ...w.exportState(), snow, wet }); return w; };
const opts = (b: Baked, w: Weather | null): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8], weather: w ? { weather: w, tick: 0, cover: true } : null });
const isLine = (b: Baked, i: number) => b.rgba[i * 4] === 0x0a && b.rgba[i * 4 + 1] === 0x0b && b.rgba[i * 4 + 2] === 0x0d && b.depth[i] !== Infinity;

describe('la nieve y el contorno interior', () => {
  for (const q of [0, 1, 2, 3] as Quarter[]) {
    it(`el contorno interior no toma nieve; el resto, como siempre (giro ${q})`, () => {
      const { state, b } = setup(q, 'both'), ref = frame2DParts(state, b, opts(b, null)).view;
      let lines = 0, open = 0, missed = 0;
      for (const k of [5, 10, 16]) {
        const p = frame2DParts(state, b, opts(b, snowed(k / 16))).view;
        let on = 0;
        for (let i = 0; i < b.width * b.height; i++) {
          if (b.face[i] !== 4 || b.sky![i] !== 5) continue;
          const changed = p[i * 4] !== ref[i * 4];
          if (isLine(b, i)) { if (k === 16) lines++; expect([i, changed]).toEqual([i, false]); continue; }
          open++; if (changed) on++;
          // lo de fuera del contorno sigue tomando la nieve entera
          if (k === 16 && !changed) missed++;
        }
        expect(on).toBeGreaterThan(0);
      }
      expect(lines).toBeGreaterThan(100);
      expect(missed).toBe(0);
      expect(open).toBeGreaterThan(1000);
    });
  }

  it('coverLine (en float32) y el horneado (en double) marcan los mismos píxeles: los que no, contados', () => {
    let marked = 0, differ = 0;
    for (const q of [0, 1, 2, 3] as Quarter[]) for (const incline of [0.5, 0.6, 1]) {
      const { b } = setup(q, 'both', incline), gap = coverLook(b, { weather: snowed(0.5), tick: 0, cover: true })!.gap;
      expect(gap).toBeGreaterThan(0);
      for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const i = y * b.width + x;
        if (b.depth[i] === Infinity) continue;
        const baked = isLine(b, i), ours = coverLine(b, null, x, y, b.depth[i]!, gap);
        if (baked) marked++;
        if (baked !== ours) differ++;
      }
    }
    console.log(`contorno interior: ${marked} píxeles marcados al hornear, ${differ} distintos con la resta en float32`);
    expect(marked).toBeGreaterThan(1000);
    expect(differ).toBeLessThanOrEqual(Math.ceil(marked / 1000));
  });

  it('con la capa del corte: los vecinos que sustituye cuentan con su profundidad', () => {
    const { state, b } = setup(0, 'both');
    // (con el cielo del mundo, lo de dentro del corte también toma nieve: ahí los vecinos son de la capa)
    const cut = { x0: 10, x1: 50, y0: 20, y1: 60, zMin: 4, depth: 40, worldSky: true }, L = sectionLayer(b, cut)!;
    expect(L).toBeTruthy();
    const ref = frame2DParts(state, b, { ...opts(b, null), section: cut }).view;
    const p = frame2DParts(state, b, { ...opts(b, snowed(1)), section: cut }).view, c = coverLook(b, { weather: snowed(1), tick: 0, cover: true })!;
    // (la regla escrita aquí aparte: cada píxel y cada vecino con la profundidad que se ve en él, la de la capa donde la sustituye)
    const seenDepth = (x: number, y: number) => { const si = sectionAt(L, x, y); return si >= 0 ? L.depth[si]! : b.depth[y * b.width + x]!; };
    const lineAt = (x: number, y: number, under: (x: number, y: number) => number) => {
      const lim = Math.fround(seenDepth(x, y) - c.gap);
      return [[0, -1], [-1, 0], [1, 0], [0, 1]].some(([dx, dy]) => { const nx = x + dx!, ny = y + dy!; return nx >= 0 && ny >= 0 && nx < b.width && ny < b.height && under(nx, ny) < lim; });
    };
    let seen = 0, lines = 0, byCut = 0;
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
      const si = sectionAt(L, x, y);
      if (si < 0 || L.mask[si] !== 1 || L.face[si] !== 4 || !L.sky || !L.sky[si]) continue;
      // dentro del corte, con nieve entera: el contorno según los vecinos que se ven no toma nieve; lo demás con todo el
      // cielo, sí (con menos cielo, según la trama)
      const line = lineAt(x, y, seenDepth), changed = p[(y * b.width + x) * 4] !== ref[(y * b.width + x) * 4];
      if (line) expect([x, y, changed]).toEqual([x, y, false]);
      else if (L.sky[si] === 5) expect([x, y, changed]).toEqual([x, y, true]);
      expect(coverLine(b, L, x, y, L.depth[si]!, c.gap)).toBe(line);
      if (line) lines++;
      if (line !== lineAt(x, y, (nx, ny) => b.depth[ny * b.width + nx]!)) byCut++;
      seen++;
    }
    console.log(`dentro del corte: ${seen} píxeles de arriba con cielo, ${lines} de contorno, ${byCut} en los que lo que se ve en el vecino cambia la respuesta`);
    expect(seen).toBeGreaterThan(50);
    expect(lines).toBeGreaterThan(0);
    expect(byCut).toBeGreaterThan(0);
  });

  it("sin 'both' (o sin contorno), lo de antes: gap 0 y la nieve igual que sin mirar el contorno", () => {
    for (const outline of ['outer', 'none'] as const) {
      const { state, b } = setup(1, outline);
      expect(coverLook(b, { weather: snowed(0.5), tick: 0, cover: true })!.gap).toBe(0);
      const p = frame2DParts(state, b, opts(b, snowed(1))).view, ref = frame2DParts(state, b, opts(b, null)).view;
      let n = 0;
      for (let i = 0; i < b.width * b.height; i++) if (b.face[i] === 4 && b.sky![i] === 5) { n++; expect(p[i * 4] !== ref[i * 4]).toBe(true); }
      expect(n).toBeGreaterThan(1000);
    }
  });
});
