// StaticVoxels.shift (la ventana viva): una ventana de 3 x 3 trozos que se corre por un mundo por regiones (también en
// negativo) y escribe los trozos que entran da, en cada sitio, lo mismo que una ventana hecha de nuevo ahí: vóxeles,
// alturas, suelo de pisar y lo expuesto (con las máscaras ya hechas antes de correrla: las del borde nuevo se rehacen)
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, type RegionSpec } from '../src/world/regiongen';

const B = 8, ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'tronco', 'hojas', 'flor'];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${(30 + i * 20).toString(16)}2020`, `#${(40 + i * 20).toString(16)}3030`] })) };
const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, (x + y + z) % 2)]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 't', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: id === 'flor' ? [[3, 3, 0, material(i, 0)], [3, 3, 1, material(i, 1)]] : cube(i), ...(id === 'hierba' ? { props: { covered: 'tierra' } } : {}) })) } as unknown as VoxsetFile);
const T = (id: string) => set.index(id);
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) leaves.push([dx, dy, 4, T('hojas')]);
const H = 8;
const SPEC: RegionSpec = {
  seed: 5, width: 48, depth: 48, height: H,
  surface: { base: 4, amplitude: 2, scale: 6 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 1 }, { material: T('piedra') }],
  seaLevel: 3, water: T('agua'), shore: { material: T('arena') },
  veins: [{ material: T('carbon'), in: [T('piedra')], z: [0, 3], density: 0.1, size: [2, 4] }],
  caves: { count: 6, z: [1, 3], length: [8, 16], radius: [1, 1.5] },
  scatter: [
    { on: [T('hierba')], density: 0.05, spacing: 3, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves] },
    { on: [T('hierba')], density: 0.1, structure: [[0, 0, 1, T('flor')]] },
  ],
};
const TB = 4, TV = TB * B;                       // un trozo: 4 x 4 bloques = 32 x 32 vóxeles (2 x 2 trozos de vóxeles)
const T0 = -3, NT = 6;                           // el mundo fijo: los trozos -3..2 en x y en y

const N = 3, WV = N * TV, ZT = H * B - 1;
const stamp = (s: StaticVoxels, tx: number, ty: number, ltx: number, lty: number) =>
  new BlockGrid(new WorldState(s, [], null), set).stampRegion(generateRegion(SPEC, { x0: tx * TB, y0: ty * TB, z0: 0, width: TB, depth: TB, height: H }), [ltx * TB, lty * TB, 0]);
// Una ventana hecha de nuevo con su esquina en el trozo (tx0, ty0)
const fresh = (tx0: number, ty0: number) => {
  const s = new StaticVoxels(pal, WV, WV, 0, ZT);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) stamp(s, tx0 + i, ty0 + j, i, j);
  return s;
};
const exposed = (s: StaticVoxels) => { const o: number[] = []; s.forEachExposed((x, y, z, v) => o.push(x, y, z, v)); return o; };

describe('StaticVoxels.shift', () => {
  it('correrse y escribir lo que entra da lo mismo que la ventana hecha de nuevo', () => {
    let tx0 = 0, ty0 = 0;
    const live = fresh(tx0, ty0);
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, -1], [-2, 0], [0, -2], [1, 1], [3, 0], [0, -1]] as const) {
      exposed(live);                                                         // las máscaras, hechas antes de correrla
      live.floorAt(5, 5);                                                    // y la rejilla de pisar
      live.shift(dx * TB * B / 16, dy * TB * B / 16);
      const nx = tx0 + dx, ny = ty0 + dy;
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const tx = nx + i, ty = ny + j;
        if (tx >= tx0 && tx < tx0 + N && ty >= ty0 && ty < ty0 + N) continue;  // ya estaba
        stamp(live, tx, ty, i, j);
      }
      tx0 = nx; ty0 = ny;
      const ref = fresh(tx0, ty0);
      for (let z = 0; z <= ZT; z += 2) for (let y = 0; y < WV; y++) for (let x = 0; x < WV; x++)
        if (live.get(x, y, z) !== ref.get(x, y, z)) expect(`${tx0},${ty0}: ${x},${y},${z} = ${live.get(x, y, z)}`).toBe(`${ref.get(x, y, z)}`);
      expect(Array.from(live.height)).toEqual(Array.from(ref.height));
      for (let y = 0; y < WV; y += 3) for (let x = 0; x < WV; x += 3) expect(live.floorAt(x, y)).toBe(ref.floorAt(x, y));
      expect(exposed(live)).toEqual(exposed(ref));
    }
  });

  it('lo que entra queda cambiado (versión nueva y su caja entera) y lo que se queda, no', () => {
    const live = fresh(0, 0), v0 = live.clock;
    live.shift(2, 0);
    const C = live.cols;
    for (let cy = 0; cy < live.rows; cy++) for (let cx = 0; cx < C; cx++) {
      const changed = live.changedSince(v0).includes(cy * C + cx);
      expect(changed).toBe(cx >= C - 2);
    }
  });
});
