// Plantas que conviven con el agua: el agua no las borra ni las toma por fondo, ellas no borran el agua, y se ven a través
import { describe, expect, it } from 'vitest';
import { material, type Palette } from '../src/core';
import { bakeWorld } from '../src/world/bake';
import { BlockGrid, BlockSet, type VoxsetFile } from '../src/world/blocks';
import { frame2DParts, type Frame2DOptions } from '../src/world/frame2d';
import { generateRegion, applyRegion, type RegionSpec } from '../src/world/regiongen';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer, regionWater, takeWaterVoxels } from '../src/world/water';
import { WorldView, type Quarter } from '../src/world/view';
import { seenThrough, CLEAR_BASE, CLEAR_MAX } from '../src/world/waterlook';
import type { World } from '../src/world/build';

const PAL: Palette = { ramps: [
  { name: 'tierra', colors: ['#302010', '#604020'] }, { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'], material: 'follaje' },
  { name: 'alga', colors: ['#a01010', '#f02020'], material: 'follaje', props: { sway: 2, anchor: 'root', reach: 6, aquatic: true } },
  { name: 'junco', colors: ['#a01010', '#f02020'], material: 'follaje' },
] };
const N = 4, cube = (r: number) => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(r, 1)]); return o; };
const post = (r: number) => Array.from({ length: N }, (_, z) => [1, 1, z, material(r, 1)] as [number, number, number, number]);
const file = (): VoxsetFile => ({ format: 'voxpix-set', version: 1, name: 't', size: N, palette: PAL, blocks: [
  { id: 'tierra', voxels: cube(0) }, { id: 'agua', voxels: cube(1) }, { id: 'alga', voxels: post(2), props: { waterlogged: true } },
] });
// Una cuenca de 32 x 32 con 6 de agua sobre el suelo, y una planta de alto h en (16, 16)
function pool(ramp: number, h: number) {
  const s = new StaticVoxels(PAL, 48, 48, 0, 31);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) for (let z = 0; z < (x < 8 || y < 8 || x >= 40 || y >= 40 ? 10 : 2); z++) s.set(x, y, z, material(0, 1));
  for (let z = 2; z < 2 + h; z++) for (const [x, y] of [[16, 16], [17, 16], [30, 24]] as const) s.set(x, y, z, material(ramp, 1));
  const wet = new Uint8Array(48 * 48), waterTop = new Int16Array(48 * 48);
  for (let y = 8; y < 40; y++) for (let x = 8; x < 40; x++) { wet[y * 48 + x] = 1; waterTop[y * 48 + x] = 8; }
  const world = { model: s, lights: [], width: 48, depth: 48, wet, waterTop, fountain: null } as unknown as World;
  const water = new WaterLayer(world, { wallAbove: 9 }), state = new WorldState(s, [], water, { seed: 1 });
  return { s, state, water };
}
const frame = (q: Quarter, ramp: number, h: number) => {
  const { state } = pool(ramp, h), view = new WorldView(state, q), b = bakeWorld(view.bakeable(), { topZ: 32, incline: 0.5 });
  const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8] };
  return frame2DParts(view.frame(), b, o);
};

describe('plantas en el agua', () => {
  it('el agua no las toma por fondo ni pared, y correr el agua no las borra', () => {
    const { s, state, water } = pool(2, 5);
    expect(water.depthAt(16, 16)).toBe(6);
    const before = s.get(16, 16, 4);
    water.disturb(16, 16, 2, 4);
    for (let t = 0; t < 120; t++) state.step();
    expect(s.get(16, 16, 4)).toBe(before);
    expect(water.depthAt(16, 16)).toBeGreaterThan(4);
  });
  it('ponerlas y quitarlas con el agua siguiendo al mundo no cambia el agua', () => {
    const { s, state, water } = pool(2, 0);
    water.follow(state.watchChanges());
    const before = water.exportState().depth.slice();
    for (let z = 2; z < 7; z++) s.set(20, 20, z, material(2, 1));
    water.step(1 / 60);
    expect(water.depthAt(20, 20)).toBe(6);
    for (let z = 2; z < 7; z++) s.set(20, 20, z, 0);
    water.step(1 / 60);
    expect(water.exportState().depth).toEqual(before);
  });
  it('se ven a través del agua honda, en los 4 giros; lo que no es de agua, no', () => {
    for (const q of [0, 1, 2, 3] as Quarter[]) {
      const none = frame(q, 2, 0), aq = frame(q, 2, 5), plain = frame(q, 3, 5);
      const diff = (f: typeof none) => { let n = 0; for (let t = 0; t < f.view.length / 4; t++) if (f.view[t * 4]! - none.view[t * 4]! > 20) n++; return n; };
      expect(diff(aq)).toBeGreaterThan(6);
      expect(diff(plain)).toBe(0);
      expect(aq.depth).toEqual(none.depth);        // la superficie sigue siendo la del agua
    }
  });
  it('cuanto más hondas, más teñidas, hasta un tope', () => {
    const k = [0, 2, 6, 40].map((g) => seenThrough(g, 0.5, 0.8, -0.6));
    expect(k[0]).toBeCloseTo(CLEAR_BASE, 1);
    expect(k[1]).toBeGreaterThanOrEqual(k[0]!); expect(k[2]).toBeGreaterThan(k[1]!);
    expect(k[3]).toBeCloseTo(CLEAR_MAX, 1);
  });

  it('su celda cuenta como agua al cargar un trozo', () => {
    const set = BlockSet.fromJSON(file()), [T, A, P] = ['tierra', 'agua', 'alga'].map((i) => set.index(i)) as [number, number, number];
    expect(set.get(P).props.waterlogged).toBe(true);
    expect(BlockSet.fromJSON(set.toJSON()).waterTypes(A)).toEqual([A, P]);
    const r = { region: { x0: 0, y0: 0, z0: 0, width: 2, depth: 1, height: 3 }, cells: Uint16Array.from([T, T, A, A, P, A]), heights: new Int16Array(2), sown: [], touching: [], structures: [] };
    const o = { x: 0, y: 0, z: 0 };
    expect(regionWater(r, A, N, [0, 0, 0], o)(1, 1)).toBe(8);
    expect(regionWater(r, set.waterTypes(A), N, [0, 0, 0], o)(1, 1)).toBe(12);
    expect(regionWater(r, set.waterTypes(A), N, [0, 0, 0], o)(5, 1)).toBe(12);
    expect(() => { const f = file(); f.blocks[0]!.props = { waterlogged: true }; BlockSet.fromJSON(f); }).toThrow(/bed/);
  });
  it('quitar los vóxeles de agua las deja, con la superficie donde estaba', () => {
    const s = new StaticVoxels(PAL, 16, 16, 0, 15), isWater = (v: number) => Math.floor((v - 1) / 16) === 1, plant = (v: number) => Math.floor((v - 1) / 16) === 2;
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) s.set(x, y, z, material(z < 2 ? 0 : 1, 1));
    for (let z = 2; z < 8; z++) s.set(5, 5, z, material(2, 1));                  // hasta la superficie
    for (let z = 2; z < 11; z++) s.set(9, 9, z, material(2, 1));                 // y por encima
    const top = takeWaterVoxels(s, 0, 0, 15, 15, isWater, plant);
    for (const [x, y] of [[0, 0], [5, 5], [9, 9], [15, 15]] as const) expect(top(x, y)).toBe(8);
    expect(s.get(5, 5, 4)).toBe(material(2, 1));
    expect(s.get(4, 5, 4)).toBe(0);
  });
  it('se siembran en el fondo del agua, con celdas de agua, y solo ahí', () => {
    const spec: RegionSpec = { seed: 3, width: 48, depth: 48, height: 12, surface: { base: 5, amplitude: 3, scale: 9 }, strata: [{ material: 1 }], seaLevel: 6, water: 2,
      scatter: [{ on: [1], density: 0.3, inWater: true, structure: [[0, 0, 1, 3]] }] };
    const r = generateRegion(spec, { x0: 0, y0: 0, z0: 0, width: 32, depth: 32, height: 12 });
    expect(r.sown.length).toBeGreaterThan(10);
    for (const p of r.sown) expect(r.cells[((p.z + 1) * 32 + p.y) * 32 + p.x]).toBe(2);
    const set = BlockSet.fromJSON(file()), st = new WorldState(new StaticVoxels(PAL, 128, 128, 0, 47), [], null), grid = new BlockGrid(st, set);
    applyRegion(r, grid, [0, 0, 0], { skip: [2] });
    for (const p of r.sown) expect(grid.get(p.x, p.y, p.z + 1)).toBe(3);
    expect(generateRegion({ ...spec, scatter: [{ on: [1], density: 0.3, structure: [[0, 0, 1, 3]] }] }, r.region).sown.some((p) => r.cells[((p.z + 1) * 32 + p.y) * 32 + p.x] === 2)).toBe(false);
  });
});
