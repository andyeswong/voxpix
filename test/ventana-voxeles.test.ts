// La ventana viva, 1 (src/world/window.ts): los vóxeles de la ventana. Una ventana de 3 x 3 trozos que se mueve por un mundo
// por regiones (también en negativo), corriendo el store (StaticVoxels.shift) y escribiendo en cualquier orden los trozos
// que entran, da los mismos vóxeles que el mundo fijo generado de una vez; fuera de la ventana, y en un trozo que aún no
// se escribió, aire
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateRegion, type RegionSpec } from '../src/world/regiongen';
import { WindowVoxels } from '../src/world/window';

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
const shuffle = <X,>(a: X[], seed: number) => { let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };

describe('ventana viva: los vóxeles de la ventana', () => {
  // El mundo fijo, de una vez (la región entera), en un StaticVoxels con el origen en el trozo T0
  const ref = new StaticVoxels(pal, NT * TV, NT * TV, 0, H * B - 1);
  new BlockGrid(new WorldState(ref, [], null), set).stampRegion(generateRegion(SPEC, { x0: T0 * TB, y0: T0 * TB, z0: 0, width: NT * TB, depth: NT * TB, height: H }));
  const refGet = (x: number, y: number, z: number) => ref.get(x - T0 * TV, y - T0 * TV, z);

  it('moviéndose (también en negativo) y escribiendo en desorden lo que entra: los mismos vóxeles que el mundo fijo', () => {
    const win = new WindowVoxels(pal, 3, 3, TV, 0, H * B - 1);
    const grid = new BlockGrid(new WorldState(win.store, [], null), set);
    const load = (tx: number, ty: number) => {
      const [cx, cy] = win.slotCell(tx, ty, B);
      grid.stampRegion(generateRegion(SPEC, { x0: tx * TB, y0: ty * TB, z0: 0, width: TB, depth: TB, height: H }), [cx, cy, 0]);
      win.markLoaded(tx, ty);
    };
    let solid = 0;
    for (const [k, [tx0, ty0]] of ([[0, 0], [-1, 0], [-2, -1], [-3, -3], [0, -2], [-1, -2], [0, 0]] as const).entries()) {
      const { entered, left } = win.moveTo(tx0, ty0);
      // Lo que entra todavía es aire; lo que se queda sigue
      for (const [tx, ty] of entered) expect(win.get(tx * TV + 5, ty * TV + 5, 10)).toBe(0);
      for (const [tx, ty] of left) expect(win.inWindow(tx, ty)).toBe(false);
      if (k === 0) expect(entered.length).toBe(9);
      for (const [tx, ty] of shuffle([...entered], k + 1)) load(tx, ty);
      // Toda la ventana, igual que el mundo fijo; y un borde de fuera, aire
      for (let y = ty0 * TV; y < (ty0 + 3) * TV; y++) for (let x = tx0 * TV; x < (tx0 + 3) * TV; x++) for (let z = 0; z < H * B; z += 3) {
        const a = win.get(x, y, z), r = refGet(x, y, z);
        if (a !== r) expect(`${x},${y},${z}: ${a}`).toBe(`${x},${y},${z}: ${r}`);
        if (a) solid++;
      }
      expect(win.get(tx0 * TV - 1, ty0 * TV + 3, 2)).toBe(0);
      expect(win.get((tx0 + 3) * TV, ty0 * TV + 3, 2)).toBe(0);
    }
    expect(solid).toBeGreaterThan(100000);
  });

  it('mover un trozo solo pide los que entran (una fila), y escribir en el mundo va a su ranura', () => {
    const win = new WindowVoxels(pal, 3, 3, TV, 0, H * B - 1);
    const grid = new BlockGrid(new WorldState(win.store, [], null), set);
    const fill = (es: Array<[number, number]>) => { for (const [tx, ty] of es) { const [cx, cy] = win.slotCell(tx, ty, B); grid.stampRegion(generateRegion(SPEC, { x0: tx * TB, y0: ty * TB, z0: 0, width: TB, depth: TB, height: H }), [cx, cy, 0]); win.markLoaded(tx, ty); } };
    fill(win.moveTo(-1, -1).entered);
    const m = win.moveTo(0, -1);
    expect(m.entered.map(([tx]) => tx)).toEqual([2, 2, 2]);
    expect(m.left.map(([tx]) => tx)).toEqual([-1, -1, -1]);
    fill(m.entered);
    // set en coordenadas del mundo: se lee igual, y en el store está a su distancia de la esquina (0, -1) de la ventana
    win.set(2 * TV + 7, -TV + 9, 40, material(0, 1));
    expect(win.get(2 * TV + 7, -TV + 9, 40)).toBe(material(0, 1));
    expect(win.store.get(2 * TV + 7, 9, 40)).toBe(material(0, 1));
    expect(() => win.set(5 * TV, 0, 1, 1)).toThrow();
  });
});
