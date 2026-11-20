// LevelPathField: el primer shift no paga la memoria nueva de moves (sus páginas se escriben al construir). Con el
// tamaño de una ventana viva de 11 x 13 trozos (1408 x 1664 vóxeles: moves son 18 MB), sin ese toque el primer shift
// cuesta ~10 veces lo que los siguientes
import { describe, it, expect } from 'vitest';
import { StaticVoxels, WorldState } from '../src/world/state';
import { LevelPathField } from '../src/world/levelpaths';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }] };

describe('caminos por niveles: la memoria de moves', () => {
  it('el primer shift no cuesta más del doble que los siguientes', () => {
    const st = new WorldState(new StaticVoxels(PAL, 1408, 1664, 0, 15), [], null);
    const f = new LevelPathField(st, { cell: 4, levels: 4, radius: 1, height: 14, step: 8, maxDrop: 64, budget: 1000 });
    const ms: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t = performance.now();
      f.shift(k % 2 ? -128 : 128, 0);
      ms.push(performance.now() - t);
    }
    const rest = ms.slice(1).sort((a, b) => a - b), median = rest[rest.length >> 1]!;
    expect(ms[0], `primer shift ${ms[0]!.toFixed(1)} ms; los siguientes, mediana ${median.toFixed(1)}`).toBeLessThanOrEqual(2 * median);
    f.close();
  }, 30_000);
});
