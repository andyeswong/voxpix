// StaticVoxels.dataVersions: la versión de los VÓXELES de cada trozo. versions sube también con touch (marcar para
// rehornear sin cambiar nada) y en el borde de un corrimiento; dataVersions solo cuando cambian sus vóxeles, y se corre con
// el trozo. Quien guarda una copia de los vóxeles (BakeWorker) la mira para no volver a mandar lo que no cambió
import { it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, CHUNK } from '../src/world/state';

const pal: Palette = { ramps: [{ name: 'piedra', colors: ['#202428', '#3a4048'] }, { name: 'tierra', colors: ['#402818', '#5a3a24'] }] };
const fill = (s: StaticVoxels) => { for (let y = 0; y < s.depth; y++) for (let x = 0; x < s.width; x++) for (let z = 0; z < 3 + ((x + y) % 4); z++) s.set(x, y, z, material((x >> 4) & 1, 1)); };

it('touch sube versions y no dataVersions; set, las losas y la copia girada suben las dos', () => {
  const s = new StaticVoxels(pal, 64, 64, 0, 31);
  fill(s);
  const c = 5, d0 = s.dataVersions[c]!, v0 = s.versions[c]!;
  expect(d0).toBeGreaterThan(0);
  s.touch(c);
  expect([s.versions[c]! > v0, s.dataVersions[c]]).toEqual([true, d0]);
  // set (también como escritura de vista)
  const x = (c % s.cols) * CHUNK + 3, y = Math.floor(c / s.cols) * CHUNK + 4;
  s.viewWrites = true; s.set(x, y, 20, material(0, 0)); s.viewWrites = false;
  const d1 = s.dataVersions[c]!;
  expect(d1).toBeGreaterThan(d0);
  // las losas (writeChunkPrepared)
  const e = s.exportChunkPrepared(c)!, t = new StaticVoxels(pal, 64, 64, 0, 31);
  t.writeChunkPrepared(c, e.slabs, e.tops);
  expect(t.dataVersions[c]).toBeGreaterThan(0);
  // la copia girada
  const r = new StaticVoxels(pal, 64, 64, 0, 31);
  r.copyRotatedChunk(s, 1, c);
  expect(Math.max(...r.dataVersions)).toBeGreaterThan(0);
});

it('dataVersions se corre con su trozo en shift y en shiftJob; lo que entra, a 0; el borde no sube', () => {
  for (const job of [false, true]) {
    const s = new StaticVoxels(pal, 64, 64, 0, 31);
    fill(s);
    for (let c = 0; c < s.cols * s.rows; c++) s.touch(c);
    const before = Array.from(s.dataVersions), C = s.cols;
    if (job) { const j = s.shiftJob(1, 0); while (!j.step()); j.commit(); } else s.shift(1, 0);
    for (let cy = 0; cy < s.rows; cy++) for (let cx = 0; cx < C; cx++) {
      const sx = cx + 1;
      expect([job, cx, cy, s.dataVersions[cy * C + cx]]).toEqual([job, cx, cy, sx < C ? before[cy * C + sx] : 0]);
    }
  }
});
