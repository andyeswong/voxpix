import { describe, it, expect } from 'vitest';
import { ShallowWater } from '../src/fluid/shallow';

function basin(w: number, h: number): ShallowWater {
  const s = new ShallowWater(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) s.solid[i] = 1;
  }
  return s;
}

describe('agua de superficie', () => {
  it('conserva el volumen', () => {
    const s = basin(30, 20);
    for (let y = 5; y < 10; y++) for (let x = 5; x < 12; x++) s.depth[y * 30 + x] = 4;
    s.wakeAll();
    const v0 = s.totalVolume();
    for (let i = 0; i < 600; i++) s.step(1 / 60);
    expect(s.totalVolume()).toBeCloseTo(v0, 2);
    // y de verdad se movió: el agua llegó lejos de donde estaba
    expect(s.depth[15 * 30 + 25]!).toBeGreaterThan(0.1);
  });

  it('en reposo no gasta: un lago quieto no tiene celdas activas, y una perturbación solo despierta su zona', () => {
    const s = basin(100, 100);
    for (let i = 0; i < 10000; i++) s.depth[i] = s.solid[i] ? 0 : 3;
    s.wakeAll();
    for (let i = 0; i < 200; i++) s.step(1 / 60);
    expect(s.activeCount).toBe(0);
    s.disturb(50, 50, 2, 0.5);
    s.step(1 / 60);
    expect(s.activeCount).toBeGreaterThan(0);
    expect(s.activeCount).toBeLessThan(2000);
  });

  it('una columna de agua se nivela: al final la superficie es plana', () => {
    const s = basin(24, 24);
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) s.depth[y * 24 + x] = 20;
    s.wakeAll();
    for (let i = 0; i < 2400; i++) s.step(1 / 60);
    let min = Infinity, max = -Infinity;
    for (let y = 1; y < 23; y++) for (let x = 1; x < 23; x++) { const d = s.depth[y * 24 + x]!; min = Math.min(min, d); max = Math.max(max, d); }
    expect(max - min).toBeLessThan(0.05);
  });

  it('no sube una pendiente: el agua se queda en la parte baja', () => {
    const s = basin(30, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 30; x++) s.ground[y * 30 + x] = x >= 15 ? 6 : 0;
    for (let y = 1; y < 9; y++) for (let x = 1; x < 15; x++) s.depth[y * 30 + x] = 3;
    s.wakeAll();
    for (let i = 0; i < 1200; i++) s.step(1 / 60);
    let high = 0;
    for (let y = 1; y < 9; y++) for (let x = 15; x < 29; x++) high += s.depth[y * 30 + x]!;
    expect(high).toBeLessThan(0.01);
  });

  it('una perturbación hace una onda que se aleja y conserva el agua', () => {
    const s = basin(40, 40);
    for (let i = 0; i < 1600; i++) s.depth[i] = s.solid[i] ? 0 : 3;
    const v0 = s.totalVolume();
    s.disturb(20, 20, 2, 1);
    expect(s.totalVolume()).toBeCloseTo(v0, 3);
    for (let i = 0; i < 20; i++) s.step(1 / 60);
    // A 8 celdas ya se nota la onda
    expect(Math.abs(s.depth[20 * 40 + 28]! - 3)).toBeGreaterThan(0.001);
    for (let i = 0; i < 3000; i++) s.step(1 / 60);
    expect(Math.abs(s.depth[20 * 40 + 28]! - 3)).toBeLessThan(0.02);   // y se calma
  });
});

import { VoxelFluid } from '../src/fluid/voxel';

describe('fluido en volumen (vóxeles)', () => {
  // Un vaso de 6x6 por dentro con paredes y suelo sólidos
  function cup(): VoxelFluid {
    const f = new VoxelFluid(0, 0, 0, 8, 8, 12);
    for (let z = 0; z < 12; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      if (z === 0 || x === 0 || y === 0 || x === 7 || y === 7) f.solid[f.index(x, y, z)] = 1;
    return f;
  }

  it('cae, llena el fondo y conserva la masa', () => {
    const f = cup();
    for (let i = 0; i < 36; i++) f.add(3, 3, 10, 1);             // 36 celdas de agua soltadas desde arriba
    const m0 = f.total();
    for (let i = 0; i < 800; i++) f.step();
    expect(f.total()).toBeCloseTo(m0, 3);
    // 36 de agua en un fondo de 6x6 = una capa llena en z = 1 y nada arriba
    let layer1 = 0, above = 0;
    for (let y = 1; y < 7; y++) for (let x = 1; x < 7; x++) { layer1 += f.mass[f.index(x, y, 1)]!; above += f.mass[f.index(x, y, 3)]!; }
    expect(layer1).toBeGreaterThan(30);
    expect(above).toBeLessThan(0.5);
  });

  it('no atraviesa las paredes', () => {
    const f = cup();
    for (let i = 0; i < 100; i++) f.add(3, 3, 5, 1);
    for (let i = 0; i < 500; i++) f.step();
    for (let z = 0; z < 12; z++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++)
      if (f.solid[f.index(x, y, z)]) expect(f.mass[f.index(x, y, z)]).toBe(0);
  });

  it('llega al reposo: las celdas que se ven mojadas dejan de cambiar', () => {
    const f = cup();
    for (let i = 0; i < 50; i++) f.add(2, 2, 9, 1);
    const snap = () => [...f.wet(0.35)].map(([x, y, z]) => `${x},${y},${z}`).join(' ');
    for (let i = 0; i < 1500; i++) f.step();
    const a = snap();
    for (let i = 0; i < 200; i++) f.step();
    expect(snap()).toBe(a);
    expect(a.length).toBeGreaterThan(0);
  });

  it('sobre un suelo plano forma un charco visible, no una película invisible', () => {
    const f = new VoxelFluid(0, 0, 0, 40, 40, 6);
    for (let i = 0; i < 20; i++) f.add(20, 20, 4, 1);
    for (let i = 0; i < 2000; i++) f.step();
    const wet = [...f.wet(0.35)];
    expect(wet.length).toBeGreaterThan(10);
    expect(wet.length).toBeLessThan(45);                  // 20 de agua: como mucho ~40 celdas de media agua
  });
});
