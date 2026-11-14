// DayCycle: la hora sale del tick (determinista), las claves se interpolan y dan la vuelta a medianoche
import { describe, it, expect } from 'vitest';
import { DayCycle } from '../src/lighting';

const KEYS = [
  { at: 0, ambient: [0.08, 0.1, 0.2] as const, background: [10, 12, 30] as const },
  { at: 0.25, ambient: [0.6, 0.5, 0.45] as const },
  { at: 0.5, ambient: [1, 1, 1] as const, background: [120, 170, 230] as const },
  { at: 0.75, ambient: [0.6, 0.4, 0.35] as const },
];

describe('ciclo del día', () => {
  const day = new DayCycle({ ticksPerDay: 1000, keys: KEYS, start: 0.5, smooth: false });
  it('la hora, el día y las claves exactas', () => {
    expect(day.phase(0)).toBe(0.5);
    expect(day.phase(500)).toBe(0);
    expect(day.day(499)).toBe(0); expect(day.day(500)).toBe(1);
    expect(day.ambient(0)).toEqual([1, 1, 1]);
    expect(day.ambient(500)).toEqual([0.08, 0.1, 0.2]);
  });
  it('entre claves interpola, y de la última a la primera da la vuelta a medianoche', () => {
    expect(day.ambient(125)[0]).toBeCloseTo(0.8);                 // a medio camino de 0,5 a 0,75
    expect(day.ambient(375)[0]).toBeCloseTo(0.34);                // de 0,75 (0,6) a 1 = 0 (0,08)
    expect(day.isNight(500)).toBe(true); expect(day.isNight(0)).toBe(false);
  });
  it('el fondo solo con las claves que lo dicen; suave por defecto (coseno)', () => {
    expect(day.background(0)).toEqual([120, 170, 230]);
    expect(day.background(250)![2]).toBeCloseTo(130);             // a medio camino de 230 a 30
    const soft = new DayCycle({ ticksPerDay: 1000, keys: KEYS });
    expect(soft.ambient(625)[0]).toBeCloseTo(0.8);                // a mitad, el coseno da lo mismo
    // A un cuarto del tramo de mediodía (1) a la tarde (0,6): recto 0,9; con coseno aún no ha bajado tanto
    expect(soft.ambient(562.5)[0]).toBeCloseTo(1 - 0.4 * (1 - Math.cos(Math.PI / 4)) / 2);
    expect(() => new DayCycle({ ticksPerDay: 0, keys: KEYS })).toThrow();
  });
});
