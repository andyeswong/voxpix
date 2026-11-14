// generateTerrain: determinista por semilla, capas por profundidad, vetas dentro de su capa y su franja, y estructuras
// plantadas con su separación (y la hierba bajo un tronco pasa a tierra: covered)
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateTerrain, type TerrainSpec } from '../src/world/terrain';
import { fbm, fbmN, valueNoise } from '../src/worldgen';

const N = 4;
const PAL: Palette = { ramps: ['piedra', 'tierra', 'hierba', 'carbon', 'tronco'].map((name, i) => ({ name, colors: [`#${i}0${i}0${i}0`, `#${i}4${i}4${i}4`, `#${i}8${i}8${i}8`] })).concat([{ name: 'hojas', colors: ['#103010', '#206020', '#40a040'], material: 'follaje' } as never]) };
const cube = (ramp: number) => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(ramp, 1)]); return o; };
const FILE: VoxsetFile = { format: 'voxpix-set', version: 1, name: 't', size: N, palette: PAL, blocks: [
  { id: 'piedra', voxels: cube(0) }, { id: 'tierra', voxels: cube(1) }, { id: 'hierba', voxels: cube(2), props: { covered: 'tierra' } },
  { id: 'carbon', voxels: cube(3) }, { id: 'tronco', voxels: cube(4) }, { id: 'hojas', voxels: cube(5) },
] };
const SPEC: TerrainSpec = {
  seed: 7,
  surface: { base: 6, amplitude: 3, scale: 9, octaves: 3 },
  layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],
  veins: [{ block: 'carbon', in: 'piedra', chance: 0.08, size: [1, 3], bz: [0, 5] }],
  scatter: [{ on: 'hierba', density: 0.02, spacing: 4, structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'tronco'], [0, 0, 3, 'tronco'], [-1, 0, 4, 'hojas'], [1, 0, 4, 'hojas'], [0, -1, 4, 'hojas'], [0, 1, 4, 'hojas'], [0, 0, 4, 'hojas'], [0, 0, 5, 'hojas']] }],
};
function make(spec: TerrainSpec) {
  const set = BlockSet.fromJSON(FILE);
  const st = new WorldState(new StaticVoxels(PAL, 32 * N, 32 * N, 0, 12 * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  const t = generateTerrain(spec, grid);
  return { st, grid, set, t };
}

describe('ruido exportado', () => {
  it('fbm es el de siempre (pesos 4, 2, 1) y fbmN con 3 octavas da lo mismo; todo en 0..1', () => {
    for (const [x, y] of [[0.3, 7.1], [12.5, -3.25], [100, 100]] as const) {
      expect(fbmN(x, y, 5, 3)).toBeCloseTo(fbm(x, y, 5), 12);
      const v = valueNoise(x, y, 9);
      expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1);
    }
  });
});

describe('generateTerrain', () => {
  it('la misma semilla da el mismo mundo (rejilla y vóxeles); otra semilla, otro', () => {
    const a = make(SPEC), b = make(SPEC), c = make({ ...SPEC, seed: 8 });
    expect(a.st.hash()).toBe(b.st.hash());
    expect(c.st.hash()).not.toBe(a.st.hash());
    expect(Array.from(a.t.heights)).toEqual(Array.from(b.t.heights));
  });

  it('las capas por profundidad, las vetas en su capa y su franja, y los árboles separados con la hierba de debajo tapada', () => {
    const { grid, set, t } = make(SPEC);
    const id = (s: string) => set.index(s);
    let trees = 0, coal = 0;
    const trunks: Array<[number, number]> = [];
    for (let by = 0; by < grid.rows; by++) for (let bx = 0; bx < grid.cols; bx++) {
      const h = t.heights[by * grid.cols + bx]!;
      expect(h).toBeGreaterThanOrEqual(3); expect(h).toBeLessThanOrEqual(9);
      const top = grid.get(bx, by, h);
      if (grid.get(bx, by, h + 1) === id('tronco')) { trees++; trunks.push([bx, by]); expect(top).toBe(id('tierra')); }
      else expect(top).toBe(id('hierba'));
      for (let bz = 0; bz < h; bz++) {
        const d = h - bz, b = grid.get(bx, by, bz);
        if (b === id('carbon')) { coal++; expect(d).toBeGreaterThanOrEqual(3); expect(bz).toBeLessThanOrEqual(5); }
        else expect(b).toBe(d < 3 ? id('tierra') : id('piedra'));
      }
    }
    expect(trees).toBeGreaterThan(0);
    expect(coal).toBeGreaterThan(0);
    for (let i = 0; i < trunks.length; i++) for (let j = i + 1; j < trunks.length; j++) {
      const [ax, ay] = trunks[i]!, [cx, cy] = trunks[j]!;
      expect(Math.abs(ax - cx) >= 4 || Math.abs(ay - cy) >= 4).toBe(true);
    }
    // Lo escrito en vóxeles es lo de la rejilla: el bloque de arriba de una columna
    expect(grid.topAt(0, 0)).toBeGreaterThanOrEqual(t.heights[0]!);
  });

  it('un bloque que no está en el set es un error que lo nombra', () => {
    expect(() => make({ ...SPEC, layers: [{ block: 'arena' }] })).toThrow(/arena/);
  });
});
