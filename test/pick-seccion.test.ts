// pickBlock con el corte al componer (section.ts): el bloque bajo el puntero es el que se PINTA en ese píxel. Con una
// sección, lo de la caja no se pinta (se ve lo de detrás), así que no se puede picar; lo que la sección destapa, sí.
// - Una zanja de un bloque de hondo con el personaje dentro: en la imagen horneada la pared de delante tapa el suelo
//   de las dos celdas más cercanas (el rayo baja 0,5 por vóxel: un bloque de hondo tapa dos de suelo), y ningún píxel
//   apunta a ellas. Con la sección alrededor del personaje se pintan, y se pican.
// - Bajo tierra (un túnel tapado): la sección destapa el túnel; lo que se pica es lo del túnel, y el fondo sin nada
//   detrás no pica nada.
// En los dos giros de la cámara, con la capa de sectionLayer y con la de SectionPainter (en anillo).
import { describe, it, expect } from 'vitest';
import { material, unkey, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, pickBlock } from '../src/world/blocks';
import { bakeWorld, type Baked } from '../src/world/bake';
import { WorldView, type Quarter } from '../src/world/view';
import { sectionAround, sectionLayer, SectionPainter, secIdx, type SectionLayer } from '../src/world/section';

const N = 8;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
] };
const cube = (ramp: number): Array<[number, number, number, number]> => {
  const out: Array<[number, number, number, number]> = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push([x, y, z, material(ramp, 1 + ((x + y + z) % 2))]);
  return out;
};
const COLS = 12, ROWS = 16, LAYERS = 7;

// Tierra hasta la capa `ground` (incluida) y lo que diga `air` quitado
function world(ground: number, air: (bx: number, by: number, bz: number) => boolean) {
  const set = new BlockSet('prueba', N, PAL);
  set.add('piedra', cube(0)); set.add('tierra', cube(1));
  const st = new WorldState(new StaticVoxels(PAL, COLS * N, ROWS * N, 0, LAYERS * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  for (let bz = 0; bz <= ground; bz++) for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++)
    if (!air(bx, by, bz)) grid.set(bx, by, bz, bz < 2 ? 1 : 2);
  return { st, grid };
}

// La sección como la pinta el cuadro, alrededor del personaje (x, y del mundo, pies en z)
function layers(view: WorldView, b: Baked, x: number, y: number, z: number): Array<[string, SectionLayer]> {
  const cut = sectionAround(view.camera, x, y, z, 32);
  const L = sectionLayer(b, cut)!;
  const p = new SectionPainter(b, { ahead: 0, behind: 0 });
  p.set(cut, 0); p.paintAll();
  expect(p.ready()).toBe(true);
  return [['sectionLayer', L], ['SectionPainter', p.layer()!]];
}

// Las celdas que algún píxel pica (con su cara), en toda la imagen
function pickable(grid: BlockGrid, view: WorldView, b: Baked, sec?: SectionLayer): Set<string> {
  const out = new Set<string>();
  for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
    const p = pickBlock(grid, view, b, sx, sy, sec);
    if (p) out.add(`${p.cell}|${p.face}`);
  }
  return out;
}

// En cada píxel, pickBlock da la celda del vóxel que se pinta: el de la capa donde la capa sustituye, el horneado fuera
function paintedMatches(grid: BlockGrid, view: WorldView, b: Baked, L: SectionLayer): number {
  let n = 0;
  for (let j = 0; j < L.h; j++) for (let sx = L.x; sx < L.x + L.w; sx++) {
    const sy = L.y + j, q = secIdx(L, sx, j);
    if (!L.mask[q]) continue;
    const k = L.pick[q]!, p = pickBlock(grid, view, b, sx, sy, L);
    if (Number.isNaN(k)) { expect([sx, sy, p]).toEqual([sx, sy, null]); continue; }
    const [vx, vy, vz] = unkey(k), [wx, wy] = view.camera.cellToWorld(vx, vy);
    expect([sx, sy, p?.cell]).toEqual([sx, sy, grid.cellOf(wx, wy, vz)]);
    n++;
  }
  return n;
}

describe('pickBlock con la sección: se pica lo que se pinta', () => {
  for (const q of [0, 1] as Quarter[]) {
    it(`zanja de un bloque de hondo, giro ${q}: el suelo bajo el personaje se pica con la sección`, () => {
      // La zanja: la columna bx 5, by 6..8, en la capa 3 (el suelo es la capa 2); el personaje en la celda (5, 7)
      const { st, grid } = world(3, (bx, by, bz) => bz === 3 && bx === 5 && by >= 6 && by <= 8);
      const view = new WorldView(st, q);
      const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
      const floor = (by: number) => `5,${by},2|0,0,1`;
      // Sin sección, el suelo de la celda del personaje no lo apunta ningún píxel (la pared de delante lo tapa)
      const plain = pickable(grid, view, b);
      expect(plain.has(floor(7))).toBe(false);
      for (const [name, L] of layers(view, b, 5 * N + 4, 7 * N + 4, 3 * N)) {
        const cut = pickable(grid, view, b, L);
        expect([name, cut.has(floor(7))]).toEqual([name, true]);
        // y la pared de delante, que la sección quita, ya no se pica desde ningún píxel que la sección sustituye
        expect(paintedMatches(grid, view, b, L)).toBeGreaterThan(50);
      }
    });

    it(`bajo tierra, giro ${q}: la sección destapa un túnel y se pica lo del túnel`, () => {
      // Un túnel este-oeste tapado (by 7..8, capas 2..3) bajo dos capas de tierra; el personaje en (5, 8), pies en la capa 2
      const { st, grid } = world(5, (bx, by, bz) => bz >= 2 && bz <= 3 && (by === 7 || by === 8 || (q === 1 && bx >= 4 && bx <= 6 && by >= 3 && by <= 12)));
      const view = new WorldView(st, q);
      const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
      const plain = pickable(grid, view, b);
      // Sin sección, el suelo del túnel no lo apunta ningún píxel
      expect(plain.has('5,8,1|0,0,1')).toBe(false);
      for (const [name, L] of layers(view, b, 5 * N + 4, 8 * N + 4, 2 * N)) {
        const cut = pickable(grid, view, b, L);
        // El suelo del túnel bajo el personaje, desde arriba
        expect([name, cut.has('5,8,1|0,0,1')]).toEqual([name, true]);
        expect(paintedMatches(grid, view, b, L)).toBeGreaterThan(50);
      }
    });
  }

  it('sin sección (o con null), lo de siempre', () => {
    const { st, grid } = world(3, (bx, by, bz) => bz === 3 && bx === 5 && by >= 6 && by <= 8);
    const view = new WorldView(st, 0);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    for (let sy = 0; sy < b.height; sy += 3) for (let sx = 0; sx < b.width; sx += 3)
      expect(pickBlock(grid, view, b, sx, sy, null)).toEqual(pickBlock(grid, view, b, sx, sy));
  });
});
