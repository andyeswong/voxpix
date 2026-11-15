// El ejemplo del minero enano (models/enano, hecho con scripts/enano.js en el editor): se carga como lo carga un juego
// (clipsFromFile), con sus clips quieto, andar y atacar; ningún cuadro vacío; y la caja de TODOS los cuadros de todos
// los clips cabe en 6 x 6 x 14 (un cuerpo de radio 3 y alto 15, que baja por un pozo de 1 x 1 bloques de 8)
import { describe, it, expect } from 'vitest';
import { clipsFromFile, type ModelFileV3 } from '../src/core';
import file from '../models/enano/enano.voxpix.json';

describe('ejemplo: minero enano', () => {
  it('clips, cuadros y caja', () => {
    const clips = clipsFromFile(file as unknown as ModelFileV3);
    expect(clips.map((c) => [c.name, c.loop, c.frames.length])).toEqual([['quieto', true, 2], ['andar', true, 5], ['atacar', false, 4]]);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const c of clips) for (const f of c.frames) {
      let n = 0;
      for (const [x, y, z] of f.model.entries()) {
        n++;
        lo[0] = Math.min(lo[0]!, x); lo[1] = Math.min(lo[1]!, y); lo[2] = Math.min(lo[2]!, z);
        hi[0] = Math.max(hi[0]!, x); hi[1] = Math.max(hi[1]!, y); hi[2] = Math.max(hi[2]!, z);
      }
      expect(n, `${c.name}: un cuadro vacío`).toBeGreaterThan(100);
    }
    expect(hi.map((h, i) => h - lo[i]! + 1)).toEqual([6, 6, 14]);
    expect(lo[2]).toBe(0);                                         // los pies en z = 0
  });
});
