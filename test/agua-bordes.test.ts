// El agua llega a los bordes de la vista: en un mundo que es todo lago, cada fila de la vista tiene agua (antes se
// recortaban las de arriba y abajo: el rango de filas de celdas tenía las alturas de la superficie cruzadas)
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer, waterRows } from '../src/world/water';
import { bakeWorld } from '../src/world/bake';
import { frame2D } from '../src/world/frame2d';
import type { World } from '../src/world/build';

function lake(): World {
  const W = 200, D = 400;
  const model = new StaticVoxels({ ramps: [{ name: 'suelo', colors: ['#000000', '#101010', '#202020', '#303030'] }] }, W, D, -10, 20);
  const wet = new Uint8Array(W * D).fill(1), waterTop = new Int8Array(W * D).fill(1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) model.set(x, y, -6, material(0, 1));   // fondo hondo
  return { model, lights: [], width: W, depth: D, wet, waterTop, fountain: null };
}

describe('el agua en los bordes de la vista', () => {
  it('cada fila de una vista sobre un lago tiene agua', () => {
    const w = lake();
    const state = new WorldState(w.model, [], new WaterLayer(w));
    const b = bakeWorld(w, { topZ: 20, incline: 0.5 });
    const vw = 120, vh = 90;
    // Vistas dentro del lago: arriba (junto a su borde norte), en medio y abajo (junto al sur)
    const north = Math.ceil(b.cam.project(0, w.depth - 1, 1)[1]) + 2, south = Math.floor(b.cam.project(0, 0, 1)[1]) - 2;
    expect(south - north).toBeGreaterThan(vh * 1.5);
    for (const vy of [north, Math.floor((north + south - vh) / 2), south - vh]) {
      const img = frame2D(state, b, { vx: 40, vy, vw, vh, time: 0, lights: false, ambient: [1, 1, 1] });
      for (let row = 0; row < vh; row++) {
        let blue = 0;
        for (let x = 0; x < vw; x++) { const o = (row * vw + x) * 4; if (img[o + 2]! > img[o]! + 20) blue++; }
        expect(blue, `fila ${row} de la vista en vy = ${vy}`).toBeGreaterThan(vw / 2);
      }
    }
  });

  it('el rango de filas va de la superficie más alta (abajo de la vista) a la más baja (arriba)', () => {
    const originY = 300, a = 0.5, vy = 40, vh = 60;
    const [g0, g1] = waterRows(originY, a, vy, vh, 1000);
    const row = (sy: number, z: number) => Math.floor((originY - sy - z) / a / 2);
    // Abajo de la vista, el agua más alta posible (z = 30) es la fila más al sur que puede verse; arriba, la más baja
    expect(row(vy + vh, 30)).toBeGreaterThanOrEqual(g0);
    expect(row(vy, -15)).toBeLessThanOrEqual(g1);
  });
});
