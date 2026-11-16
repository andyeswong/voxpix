// Los criterios de lectura del icono de la mochila a 16 px, medidos sobre el icono mismo (sin verlo):
// docs/runbooks/diseno-para-16-px.md. El icono es el de la barra: celda de 16, contorno 'both' de color fijo
import { describe, it, expect } from 'vitest';
import { modelIcon } from '../src/core';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/mochila/mochila.voxset.json';

const OUT = '#07070a';
const set = BlockSet.fromJSON(file as unknown as VoxsetFile);
const icon = modelIcon(set.get(set.index('mochila')).model, { cell: 16, outline: 'both', outlineColor: OUT });
const N = icon.size;
const px = (x: number, y: number) => Array.from(icon.rgba.subarray((y * N + x) * 4, (y * N + x) * 4 + 4));
const lum = (p: number[]) => 0.299 * p[0]! + 0.587 * p[1]! + 0.114 * p[2]!;
// Interior: opaco y no contorno
const inner = (x: number, y: number) => { const p = px(x, y); return p[3]! > 0 && !(p[0] === 7 && p[1] === 7 && p[2] === 10); };

describe('icono de la mochila a 16 px', () => {
  it('silueta, bloques de color, banda oscura arriba y hebilla 2 x 2', () => {
    let x0 = N, x1 = -1, y0 = N, y1 = -1, n = 0, light = 0, flap = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (px(x, y)[3]! > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (!inner(x, y)) continue;
      n++;
      const L = lum(px(x, y));
      if (L >= 120) light++; else if (L >= 45 && L <= 56) flap++;
    }
    // Filas con mayoría oscura (la solapa), seguidas, arriba
    const dark: number[] = [];
    for (let y = 0; y < N; y++) {
      let k = 0, d = 0;
      for (let x = 0; x < N; x++) if (inner(x, y)) { k++; if (lum(px(x, y)) <= 56) d++; }
      if (k && d * 2 > k) dark.push(y);
    }
    // La hebilla: algún 2 x 2 de luminancia >= 190
    let buckle = 0;
    for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++)
      if ([[0, 0], [1, 0], [0, 1], [1, 1]].every(([dx, dy]) => inner(x + dx!, y + dy!) && lum(px(x + dx!, y + dy!)) >= 190)) buckle++;
    expect([x1 - x0 + 1, y1 - y0 + 1]).toEqual([10, 12]);                // la losa: casi todo el ancho de la celda
    expect((light + flap) / n).toBeGreaterThanOrEqual(0.8);              // bloques de color grandes, pocos tonos sueltos
    expect(dark.length).toBeGreaterThanOrEqual(3);
    expect(dark.every((y, i) => i === 0 || y === dark[i - 1]! + 1)).toBe(true);
    expect(dark[0]! - y0).toBeLessThanOrEqual(3);
    expect(buckle).toBeGreaterThan(0);
    expect(icon.hash).toBe('a65fb30c');                                   // el mismo de la barra: si cambia, se vuelve a medir
  });
});
