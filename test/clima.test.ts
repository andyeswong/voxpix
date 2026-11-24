// El clima (src/world/weather.ts): determinista, continuo al cambiar y sin depender de cada cuánto se llama
import { describe, expect, it } from 'vitest';
import { Weather, WIND_SPEED, type WeatherProgram } from '../src/world/weather';

const program: WeatherProgram = { period: 900, keys: [
  { at: 0, ticks: 100, levels: { rain: 1, clouds: 0.9, wind: [0.8, 0.2], gust: 0.7 } },
  { at: 315, ticks: 0, levels: { rain: 0, snow: 1 } },
  { at: 610, ticks: 200, levels: { snow: 0, clouds: 0, wind: [-0.4, 0.1] } },
] };
const sample = (w: Weather, t: number) => [w.levels(t), w.drift(t), w.cover, w.windAt(37, -410, t), w.cloudAt(37, -410, t)];

describe('el clima', () => {
  it('es el mismo con la misma semilla y otro con otra', () => {
    const mk = (seed: number) => { const w = new Weather({ seed, levels: { wind: [0.6, 0], gust: 1, clouds: 0.5 } }); return Array.from({ length: 40 }, (_, k) => [w.windAt(k * 31, k * 17, 500), w.cloudAt(k * 31, k * 17, 500)]); };
    expect(mk(4)).toEqual(mk(4));
    expect(mk(4)).not.toEqual(mk(5));
  });

  it('da lo mismo avanzado tick a tick que de golpe', () => {
    const a = new Weather({ seed: 3 }), b = new Weather({ seed: 3 });
    a.play(program, 0); b.play(program, 0);
    for (let t = 0; t <= 2500; t++) a.advance(t);
    b.advance(2500);
    expect(sample(b, 2500)).toEqual(sample(a, 2500));
    expect(b.exportState()).toEqual(a.exportState());
  });

  it('pasa de un clima a otro sin saltos, y las ráfagas tampoco saltan', () => {
    const w = new Weather({ seed: 1, levels: { wind: [1, 0], gust: 1, clouds: 0.5 } });
    const before = [w.levels(1000), w.drift(1000), w.windAt(5, 5, 1000), w.cloudAt(5, 5, 1000)];
    w.set({ wind: [-0.5, 0.5], rain: 1 }, 1000, 300);
    expect([w.levels(1000), w.drift(1000), w.windAt(5, 5, 1000), w.cloudAt(5, 5, 1000)]).toEqual(before);
    for (let t = 1000; t < 1400; t++) {
      expect(Math.abs(w.levels(t + 1).rain - w.levels(t).rain)).toBeLessThan(0.006);
      const p = w.drift(t), q = w.drift(t + 1);
      expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(WIND_SPEED / 60 + 1e-6);
      expect(Math.abs(w.windAt(5, 5, t + 1) - w.windAt(5, 5, t))).toBeLessThan(0.12);
    }
    expect(w.levels(1300)).toEqual({ wind: [-0.5, 0.5], gust: 1, rain: 1, snow: 0, clouds: 0.5, sun: 1 });
  });

  it('lo andado por el aire es la suma del viento de cada tick', () => {
    const w = new Weather({ seed: 1, levels: { wind: [0.2, 0] } });
    w.set({ wind: [1, -0.0] }, 10, 100);
    let sum = 0;
    for (let t = 0; t < 200; t += 0.1) sum += w.levels(t + 0.05).wind[0] * 0.1;
    // (antes del cambio, el viento de partida)
    expect(w.drift(200)[0]).toBeCloseTo((sum * WIND_SPEED) / 60, 0);
  });

  it('la ráfaga cruza el mapa en la dirección del viento, y sin viento no hay', () => {
    const w = new Weather({ seed: 9, levels: { wind: [0.5, 0], gust: 1 } });
    const v = (0.5 * WIND_SPEED) / 60;
    expect(w.windAt(100 + v * 60, 40, 60)).toBeCloseTo(w.windAt(100, 40, 0), 9);
    const all = Array.from({ length: 200 }, (_, k) => w.windAt(k * 40, 0, 0));
    expect(Math.max(...all) - Math.min(...all)).toBeGreaterThan(0.3);
    expect(new Weather({ seed: 9, levels: { gust: 1 } }).windAt(1, 2, 3)).toBe(0);
  });

  it('la fuerza no pasa de 1 y lo que no es un número se rechaza', () => {
    const w = new Weather({ seed: 9, levels: { wind: [30, 40], gust: 1, rain: 7 } });
    expect(w.levels(0).wind[0]).toBeCloseTo(0.6, 12);
    expect(w.levels(0).rain).toBe(1);
    for (let k = 0; k < 100; k++) expect(w.windAt(k * 33, k, 5)).toBeLessThanOrEqual(1);
    expect(() => w.set({ wind: [NaN, 0] }, 0)).toThrow();
  });

  it('las nubes: ninguna despejado, todo cubierto, y en medio un reparto', () => {
    const part = (c: number) => { const w = new Weather({ seed: 2, levels: { clouds: c } }); let s = 0; for (let k = 0; k < 900; k++) s += w.cloudAt((k % 30) * 60, Math.floor(k / 30) * 60, 0); return s / 900; };
    expect(part(0)).toBe(0);
    expect(part(1)).toBe(1);
    expect(part(0.5)).toBeGreaterThan(0.25);
    expect(part(0.5)).toBeLessThan(0.75);
    expect(part(0.3)).toBeLessThan(part(0.7));
  });

  it('nieva, se acumula y se derrite; llueve, se moja y se seca', () => {
    const w = new Weather({ seed: 2, levels: { snow: 1 } });
    w.advance(60 * 70);
    expect(w.cover.snow).toBe(1);
    w.set({ snow: 0, rain: 1 }, 60 * 70, 0);
    w.advance(60 * 100);
    expect(w.cover.wet).toBe(1);
    expect(w.cover.snow).toBeLessThan(1);
    w.set({ rain: 0 }, 60 * 100, 0);
    w.advance(60 * 400);
    expect(w.cover).toEqual({ snow: 0, wet: 0 });
  });

  it('se guarda y se recupera a mitad de un cambio y de un programa', () => {
    const a = new Weather({ seed: 8 });
    a.play(program, 40); a.advance(1237);
    const b = new Weather({ seed: 8 });
    b.importState(JSON.parse(JSON.stringify(a.exportState())));
    a.advance(3000); b.advance(3000);
    expect(sample(b, 3000)).toEqual(sample(a, 3000));
    const h = (w: Weather) => { const out: unknown[] = []; w.hashInto({ num: (n) => { out.push(n); }, bytes: () => {}, str: (s) => { out.push(s); } }); return out; };
    expect(h(b)).toEqual(h(a));
    a.set({ rain: 0.5 }, 3000);
    expect(h(b)).not.toEqual(h(a));
  });
});
