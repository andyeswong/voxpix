// Adelantar la tabla del clima y la baldosa del agua no cambia lo que dan; y lo adelantado se tira si el clima o la vista cambian
import { expect, it } from 'vitest';
import { bakeWorld } from '../src/world/bake';
import { material } from '../src/core';
import { StaticVoxels } from '../src/world/state';
import { Weather } from '../src/world/weather';
import { climateAhead, climateTable, type WeatherFrame } from '../src/world/climate';
import { waveAhead, waveTile } from '../src/world/waves';

const bake = () => { const s = new StaticVoxels({ ramps: [{ name: 'a', colors: ['#808080'] }] }, 64, 64, 0, 15); for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) s.set(x, y, 0, material(0, 0)); return bakeWorld({ model: s, lights: [], width: 64, depth: 64 }, { incline: 0.5 }); };
it('con adelanto y sin él, las mismas tablas', () => {
  const a = bake(), c = bake(), mk = () => new Weather({ seed: 4, levels: { wind: [0.7, 0.3], gust: 1, clouds: 0.5, rain: 0.8 } }), wa = mk(), wc = mk();
  let ahead = 0;
  for (let tick = 0; tick < 120; tick++) {
    if (tick === 61) for (const w of [wa, wc]) w.set({ wind: [-0.5, 0.2], rain: 0.2 }, tick, 30);
    const vx = tick > 90 ? 20 : 0, o = (weather: Weather) => { const f: WeatherFrame = { weather, tick, waves: 1 }; return { vx, vy: 0, vw: 40, vh: 40, weather: f }; };
    const ta = climateTable(a, o(wa))!, tc = climateTable(c, o(wc))!;
    expect(ta).toEqual(tc);
    expect(waveTile(a, o(wa).weather, ta)!.data).toEqual(waveTile(c, o(wc).weather, tc)!.data);
    const before = climateTable(a, o(wa));
    climateAhead(a, o(wa)); waveAhead(a, o(wa).weather);
    expect(climateTable(a, o(wa))).toBe(before);     // (adelantar no cambia la de ahora)
    ahead++;
  }
  expect(ahead).toBe(120);
});
