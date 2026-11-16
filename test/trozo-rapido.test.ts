// El camino rápido de un trozo nuevo (BlockGrid.stampRegion + StaticVoxels.writeChunkSlabs): deja los mismos vóxeles,
// alturas, celdas y luces que applyRegion, también escribiendo encima de lo que había (un trozo que se reutiliza), y
// los mismos avisos de cambio (la caja del trozo). Si la región no cae en trozos de vóxeles enteros, hace applyRegion
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, applyRegion, type RegionSpec } from '../src/world/regiongen';

const B = 8, ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'tronco', 'hojas', 'flor', 'antorcha'];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${(30 + i * 20).toString(16)}2020`, `#${(40 + i * 20).toString(16)}3030`] })) };
// Bloques con textura (dos tonos alternos), la hierba con variante tapada (tierra) y una antorcha que emite
const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, (x + y + z) % 2)]); return o; };
const file = { format: 'voxpix-set', version: 1, name: 't', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: id === 'flor' ? [[3, 3, 0, material(i, 0)], [3, 3, 1, material(i, 1)]] : cube(i), ...(id === 'hierba' ? { props: { covered: 'tierra' } } : id === 'antorcha' ? { props: { emits: { kind: 'torch' } } } : {}) })) } as unknown as VoxsetFile;
const set = BlockSet.fromJSON(file);
const T = (id: string) => set.index(id);
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) leaves.push([dx, dy, 4, T('hojas')]);
const SPEC: RegionSpec = {
  seed: 9, width: 64, depth: 64, height: 8,
  surface: { base: 4, amplitude: 2, scale: 6 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 1 }, { material: T('piedra') }],
  seaLevel: 3, water: T('agua'), shore: { material: T('arena') },
  veins: [{ material: T('carbon'), in: [T('piedra')], z: [0, 3], density: 0.1, size: [2, 4] }],
  caves: { count: 6, z: [1, 3], length: [8, 16], radius: [1, 1.5] },
  scatter: [
    { on: [T('hierba')], density: 0.05, spacing: 3, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves] },
    { on: [T('hierba')], density: 0.1, structure: [[0, 0, 1, T('flor')]] },
    { on: [T('arena')], density: 0.05, structure: [[0, 0, 1, T('antorcha')]] },
  ],
};
const mk = (cols: number, rows: number) => { const s = new StaticVoxels(pal, cols * B, rows * B, 0, 8 * B - 1); const st = new WorldState(s, [], null); return { s, st, grid: new BlockGrid(st, set) }; };
const same = (a: ReturnType<typeof mk>, b: ReturnType<typeof mk>) => {
  const ea = a.s.exportChunks(), eb = b.s.exportChunks();
  for (let c = 0; c < ea.length; c++) expect(Array.from(eb[c]!.data ?? []), `trozo ${c}`).toEqual(Array.from(ea[c]!.data ?? []));
  expect(Array.from(b.s.height)).toEqual(Array.from(a.s.height));
  const ga = a.grid.exportState(), gb = b.grid.exportState();
  expect(Array.from(gb.cells)).toEqual(Array.from(ga.cells));
  expect(b.st.lights.map((l) => [l.kind, l.x, l.y, l.z])).toEqual(a.st.lights.map((l) => [l.kind, l.x, l.y, l.z]));
};

describe('trozo rápido desde bloques', () => {
  it('lo mismo que applyRegion, trozo a trozo, con árboles, flores, antorchas y agua sin escribir', () => {
    const a = mk(32, 32), b = mk(32, 32);
    for (const [x, y] of [[0, 0], [16, 0], [0, 16], [16, 16]] as const) {
      const r = generateRegion(SPEC, { x0: 40 + x, y0: -8 + y, z0: 0, width: 16, depth: 16, height: 8 });
      applyRegion(r, a.grid, [x, y, 0], { skip: [T('agua')] });
      b.grid.stampRegion(r, [x, y, 0], { skip: [T('agua')] });
    }
    expect(a.st.lights.length).toBeGreaterThan(0);
    same(a, b);
  });

  it('por pasos (stampRegionJob): un paso por llamada con el plazo vencido, y al acabar lo mismo', () => {
    const a = mk(16, 16), b = mk(16, 16);
    const r = generateRegion(SPEC, { x0: 70, y0: 20, z0: 0, width: 16, depth: 16, height: 8 });
    a.grid.stampRegion(r);
    const job = b.grid.stampRegionJob(r);
    let calls = 0;
    while (!job.run(0)) calls++;
    expect(calls + 1).toBe(1 + 8 * 8 + r.touching.length);                 // las celdas, 64 trozos de vóxeles y cada estructura
    same(a, b);
  });

  it('encima de lo que había (un trozo que se reutiliza), igual que applyRegion sobre esa misma rejilla', () => {
    const a = mk(16, 16), b = mk(16, 16);
    const r1 = generateRegion(SPEC, { x0: 0, y0: 0, z0: 0, width: 16, depth: 16, height: 8 });
    const r2 = generateRegion(SPEC, { x0: 160, y0: 32, z0: 0, width: 16, depth: 16, height: 8 });
    applyRegion(r1, a.grid); b.grid.stampRegion(r1);
    // applyRegion sobre lo que hay no limpia lo que la región deja en aire: la referencia es la rejilla vaciada antes
    const ref = mk(16, 16);
    applyRegion(r2, ref.grid);
    b.grid.stampRegion(r2);
    same(ref, b);
  });

  it('avisa del trozo cambiado, y si la región no cae en trozos de vóxeles enteros hace applyRegion', () => {
    const b = mk(16, 16), w = b.st.watchChanges();
    b.grid.stampRegion(generateRegion(SPEC, { x0: 0, y0: 0, z0: 0, width: 4, depth: 4, height: 8 }));
    const boxes = w.take().boxes;
    expect(boxes.length).toBe(4);                                              // 4 x 4 bloques de 8 = 2 x 2 trozos de 16
    for (const bx of boxes) { expect(bx.z0).toBe(0); expect(bx.z1).toBe(63); expect(bx.x1 - bx.x0).toBe(15); }
    const a = mk(16, 16), c = mk(16, 16);
    const odd = generateRegion(SPEC, { x0: 3, y0: 5, z0: 0, width: 5, depth: 3, height: 8 });
    applyRegion(odd, a.grid, [1, 1, 0]); c.grid.stampRegion(odd, [1, 1, 0]);
    same(a, c);
  });
});
