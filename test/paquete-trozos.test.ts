// Trozos empaquetados en un solo búfer (StaticVoxels.packChunk / unpackChunk, ChunkPackWriter / Reader): lo que se escribe
// al otro lado es lo mismo que con exportChunkPrepared + writeChunkPrepared (losas vacías, de un solo valor, con paleta, la
// última losa a medias, un trozo vacío), varios trozos en el mismo búfer; y un trozo que no cabe (una losa a 2 bytes) no
// escribe nada
import { it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, ChunkPackWriter, ChunkPackReader, CHUNK } from '../src/world/state';

const pal: Palette = { ramps: [{ name: 'piedra', colors: ['#202428', '#3a4048'] }, { name: 'tierra', colors: ['#402818', '#5a3a24'] }, { name: 'hierba', colors: ['#204018', '#305a24'] }] };
// (z 0..40: tres losas, la última de 9)
const make = () => new StaticVoxels(pal, 64, 64, 0, 40);
const fill = (s: StaticVoxels) => {
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const cx = x >> 4, cy = y >> 4;
    if (cx === 3 && cy === 3) continue;                                              // un trozo vacío
    for (let z = 0; z < 16; z++) s.set(x, y, z, material(0, 0));                     // la losa de abajo, de un solo valor
    for (let z = 16; z < 20 + ((x * 7 + y * 3) % 9); z++) s.set(x, y, z, material((x + z) % 3, (y + z) % 2));
    if (cx === 1 && cy === 2) for (let z = 32; z <= 40; z++) s.set(x, y, z, material(2, 1));   // la de arriba, llena
  }
};
const same = (a: StaticVoxels, b: StaticVoxels, c: number) => {
  const X = (c % a.cols) * CHUNK, Y = Math.floor(c / a.cols) * CHUNK;
  for (let y = Y; y < Y + CHUNK; y++) for (let x = X; x < X + CHUNK; x++) {
    expect(a.height[y * a.width + x]).toBe(b.height[y * b.width + x]);
    for (let z = 0; z <= 40; z++) if (a.get(x, y, z) !== b.get(x, y, z)) return false;
  }
  return true;
};

it('empaquetados en un búfer, varios trozos seguidos: lo mismo que exportar y escribir losa a losa', () => {
  const s = make();
  fill(s);
  const w = new ChunkPackWriter(), at: number[] = [];
  const n = s.cols * s.rows;
  for (let c = 0; c < n; c++) { at.push(w.n); expect(s.packChunk(c, w)).toBe(true); }
  const a = make(), b = make();
  for (let c = 0; c < n; c++) {
    a.unpackChunk(c, new ChunkPackReader(w.buffer, at[c]!));
    const e = s.exportChunkPrepared(c)!;
    b.writeChunkPrepared(c, e.slabs, e.tops);
  }
  for (let c = 0; c < n; c++) { expect(same(a, b, c)).toBe(true); expect(same(a, s, c)).toBe(true); }
  // (lo de un solo valor no ocupa 4096 bytes: el búfer es menos de lo que eran los de las losas)
  let sep = 0;
  for (let c = 0; c < n; c++) { const e = s.exportChunkPrepared(c)!; sep += e.tops.byteLength; for (const sl of e.slabs) if (sl) sep += sl.d.byteLength + sl.pal.byteLength; }
  expect(w.n).toBeLessThan(sep);
  // y la versión de datos sube al escribirlo
  expect(a.dataVersions[5]).toBeGreaterThan(0);
});

it('un trozo con una losa a 2 bytes no se empaqueta: false y nada escrito', () => {
  const s = make();
  fill(s);
  // (más de 256 valores distintos en una losa del trozo 0)
  for (let i = 0; i < 300; i++) s.set(i % 16, Math.floor(i / 16) % 16, 16 + Math.floor(i / 256), 1 + i);
  expect(s.exportChunkPrepared(0)).toBeNull();
  const w = new ChunkPackWriter();
  expect(s.packChunk(1, w)).toBe(true);
  const n = w.n;
  expect(s.packChunk(0, w)).toBe(false);
  expect(w.n).toBe(n);
});
