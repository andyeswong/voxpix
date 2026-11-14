// BlockSet y BlockGrid: el catálogo, la rejilla, sus variantes tapadas, la luz que emite un bloque, la instantánea y la
// huella, el rehorneado y pickBlock en los giros de la cámara
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, pickBlock, type VoxsetFile } from '../src/world/blocks';
import { bakeWorld, rebakeChanged } from '../src/world/bake';
import { WorldView } from '../src/world/view';

const N = 4;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
  { name: 'hierba', colors: ['#10301a', '#2e7038', '#68b060'] },
  { name: 'hojas', colors: ['#103010', '#206020', '#40a040'], material: 'follaje' },
  { name: 'llama', colors: ['#a04010', '#f0a020', '#fff0a0'], emissive: true, material: 'atravesable' },
] };
const cube = (ramp: number, tone = 1): Array<[number, number, number, number]> => {
  const out: Array<[number, number, number, number]> = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push([x, y, z, material(ramp, tone)]);
  return out;
};
function file(): VoxsetFile {
  // Un "bloque" asimétrico (madera solo en x = 0) para ver el giro
  const marked = cube(0).map(([x, y, z]): [number, number, number, number] => [x, y, z, material(x === 0 ? 1 : 0, 1)]);
  return {
    format: 'voxpix-set', version: 1, name: 'prueba', size: N, palette: PAL,
    blocks: [
      { id: 'piedra', voxels: marked },
      { id: 'tierra', voxels: cube(1) },
      { id: 'hierba', voxels: cube(2), props: { covered: 'tierra' } },
      { id: 'hojas', voxels: cube(3) },
      { id: 'antorcha', voxels: [[1, 1, 0, material(4, 1)], [1, 1, 1, material(4, 2)], [1, 1, 2, material(4, 2)]], props: { emits: { kind: 'torch' } } },
    ],
  };
}
function world(): { st: WorldState; grid: BlockGrid; set: BlockSet } {
  const s = new StaticVoxels(PAL, 32, 32, 0, 23);
  const st = new WorldState(s, [], null);
  const set = BlockSet.fromJSON(file());
  const grid = new BlockGrid(st, set);
  grid.fill([0, 0, 0], [7, 7, 1], set.index('tierra'));
  grid.fill([0, 0, 2], [7, 7, 2], set.index('hierba'));
  return { st, grid, set };
}

describe('BlockSet', () => {
  it('las propiedades salen de las rampas; decir otra cosa es un error; covered tiene que existir; ida y vuelta', () => {
    const set = BlockSet.fromJSON(file());
    expect(set.ids()).toEqual(['piedra', 'tierra', 'hierba', 'hojas', 'antorcha']);
    expect(set.get(set.index('piedra')).props).toMatchObject({ solid: true, light: 'blocks', emissive: false });
    expect(set.get(set.index('hojas')).props).toMatchObject({ solid: false, light: 'passes' });
    expect(set.get(set.index('antorcha')).props).toMatchObject({ solid: false, emissive: true, emits: { kind: 'torch' } });
    expect(() => set.index('oro')).toThrow(/piedra, tierra/);
    const bad = file(); bad.blocks[3]!.props = { solid: true };
    expect(() => BlockSet.fromJSON(bad)).toThrow(/hojas.*solid/);
    const bad2 = file(); bad2.blocks[2]!.props = { covered: 'barro' };
    expect(() => BlockSet.fromJSON(bad2)).toThrow(/barro/);
    expect(BlockSet.fromJSON(JSON.parse(JSON.stringify(set.toJSON()))).toJSON()).toEqual(set.toJSON());
  });
});

describe('BlockGrid', () => {
  it('poner y quitar: la rejilla, los vóxeles, la caja que cambió, topAt y cellOf', () => {
    const { st, grid, set } = world();
    const stone = set.index('piedra');
    expect(grid.cols).toBe(8); expect(grid.layers).toBe(6);
    expect(grid.topAt(3, 3)).toBe(2);
    // Tapa la hierba de debajo, que pasa a tierra: la caja llega hasta ella
    expect(grid.set(3, 3, 3, stone)).toEqual({ x0: 12, y0: 12, z0: 8, x1: 15, y1: 15, z1: 15 });
    expect(grid.get(3, 3, 3)).toBe(stone);
    expect(st.solid.get(12, 13, 14)).toBe(material(1, 1));       // x = 0 del bloque: la marca
    expect(st.solid.get(13, 13, 14)).toBe(material(0, 1));
    expect(grid.topAt(3, 3)).toBe(3);
    expect(grid.cellOf(13, 14, 12)).toEqual([3, 3, 3]);
    expect(grid.cellOf(40, 0, 0)).toBeNull();
    expect(grid.set(3, 3, 3, stone)).toBeNull();
    expect(grid.set(3, 3, 3, 0)).toEqual({ x0: 12, y0: 12, z0: 12, x1: 15, y1: 15, z1: 15 });
    expect(st.solid.get(12, 13, 14)).toBe(0);
  });

  it('girado 90: la marca de x = 0 pasa a y = 0 (lo que miraba al oeste mira al sur)', () => {
    const { st, grid, set } = world();
    grid.set(1, 1, 3, set.index('piedra'), 90);
    for (let x = 4; x < 8; x++) expect(st.solid.get(x, 4, 13)).toBe(material(1, 1));
    expect(st.solid.get(4, 5, 13)).toBe(material(0, 1));
  });

  it('la hierba con un bloque sólido encima pasa a tierra; las hojas (no sólidas) no la tapan', () => {
    const { grid, set } = world();
    grid.set(2, 2, 3, set.index('hojas'));
    expect(grid.get(2, 2, 2)).toBe(set.index('hierba'));
    grid.set(4, 4, 3, set.index('piedra'));
    expect(grid.get(4, 4, 2)).toBe(set.index('tierra'));
    // Poner hierba bajo un sólido ya la pone tapada
    grid.set(4, 4, 3, 0); grid.set(4, 4, 2, 0); grid.set(4, 4, 3, set.index('piedra'));
    grid.set(4, 4, 2, set.index('hierba'));
    expect(grid.get(4, 4, 2)).toBe(set.index('tierra'));
  });

  it('la antorcha pone su luz fija al colocarse y la quita al picarla', () => {
    const { st, grid, set } = world();
    grid.set(5, 5, 3, set.index('antorcha'));
    const fixed = st.lights.filter((l) => l.baked !== false);
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ kind: 'torch', x: 22, y: 22, z: 16 });
    grid.set(5, 5, 3, 0);
    expect(st.lights).toHaveLength(0);
  });

  it('entra en la instantánea y la huella: restore deja rejilla, vóxeles y luces como estaban', () => {
    const { st, grid, set } = world();
    const snap = st.snapshot(), h0 = st.hash();
    grid.set(5, 5, 3, set.index('antorcha'));
    grid.set(1, 1, 2, 0);
    expect(st.hash()).not.toBe(h0);
    st.restore(snap);
    expect(st.hash()).toBe(h0);
    expect(grid.get(1, 1, 2)).toBe(set.index('hierba'));
    expect(grid.get(5, 5, 3)).toBe(0);
    expect(st.lights).toHaveLength(0);
    // Y otra vez la antorcha: su luz se puede quitar después (el mapa de luces volvió con la instantánea)
    grid.set(5, 5, 3, set.index('antorcha')); grid.set(5, 5, 3, 0);
    expect(st.lights).toHaveLength(0);
  });

  it('rehornear tras poner y picar bloques da lo mismo que hornear de cero', () => {
    const { st, grid, set } = world();
    const opts = { topZ: 23, incline: 0.5 };
    const b = bakeWorld({ model: st.solid, lights: st.lights, width: 32, depth: 32 }, opts);
    grid.set(3, 3, 3, set.index('piedra'), 180); grid.set(6, 2, 2, 0); grid.set(1, 6, 3, set.index('antorcha'));
    rebakeChanged(b, st.lights);
    const f = bakeWorld({ model: st.solid, lights: st.lights, width: 32, depth: 32 }, opts);
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(f.rgba.buffer))).toBe(true);
    expect(b.lights.map((l) => [l.light.id, Array.from(l.weight)])).toEqual(f.lights.map((l) => [l.light.id, Array.from(l.weight)]));
  });

  it('pickBlock: el bloque y la cara bajo el puntero, también con la cámara girada', () => {
    const { st, grid } = world();
    for (const q of [0, 1] as const) {
      const view = new WorldView(st, q);
      const baked = bakeWorld(view.bakeable(), { topZ: 23, incline: 0.5 });
      // El centro de la cara de arriba del bloque (2, 5, 2) (la hierba), en la imagen de esta vista
      const [vx, vy] = view.camera.cellToView(2 * N + 2, 5 * N + 2);
      const [sx, sy] = baked.cam.project(vx + 0.5, vy + 0.5, 3 * N);
      expect(pickBlock(grid, view, baked, Math.floor(sx), Math.floor(sy))).toEqual({ cell: [2, 5, 2], face: [0, 0, 1] });
    }
  });
});
