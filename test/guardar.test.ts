// Guardar y cargar: la instantánea a bytes y de vuelta da la misma huella (también con agua, gotas, entidades y una
// rejilla de bloques), los bytes son siempre los mismos, y contra la base (el mundo de partida) solo va lo cambiado
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateTerrain } from '../src/world/terrain';
import { encodeSnapshot, decodeSnapshot } from '../src/world/save';

describe('guardar y cargar', () => {
  it('un mundo con agua, gotas, luces y entidades: ida y vuelta con la misma huella, y los mismos bytes', () => {
    const make = () => buildWorldState(generateLayout(THEMES.medieval.spec, 7), THEMES.medieval.look).state;
    const a = make();
    for (let t = 0; t < 30; t++) { if (t === 5) a.events.splash(200, 200, 2, 12, 3); a.step(); }
    a.lights.add({ kind: 'lantern', x: 180, y: 170, z: 6 });
    const bytes = encodeSnapshot(a.snapshot());
    expect(encodeSnapshot(a.snapshot())).toEqual(bytes);
    const b = make();
    b.restore(decodeSnapshot(bytes));
    expect(b.hash()).toBe(a.hash());
    expect(encodeSnapshot(b.snapshot())).toEqual(bytes);
    // Y sigue igual al avanzar los dos
    for (let t = 0; t < 10; t++) { a.step(); b.step(); }
    expect(b.hash()).toBe(a.hash());
  });

  const N = 8;
  const PAL: Palette = { ramps: ['piedra', 'tierra', 'hierba'].map((name, i) => ({ name, colors: [`#${i}0${i}0${i}0`, `#${i}4${i}4${i}4`, `#${i}8${i}8${i}8`] })) };
  const cube = (r: number) => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(r, (x + y + z) % 3)]); return o; };
  const FILE: VoxsetFile = { format: 'voxpix-set', version: 1, name: 't', size: N, palette: PAL, blocks: [{ id: 'piedra', voxels: cube(0) }, { id: 'tierra', voxels: cube(1) }, { id: 'hierba', voxels: cube(2), props: { covered: 'tierra' } }] };
  function blocks() {
    const st = new WorldState(new StaticVoxels(PAL, 48 * N, 48 * N, 0, 12 * N - 1), [], null);
    const grid = new BlockGrid(st, BlockSet.fromJSON(FILE));
    generateTerrain({ seed: 7, surface: { base: 6, amplitude: 3, scale: 9 }, layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }] }, grid);
    return { st, grid };
  }

  it('un mundo de bloques: entero ocupa poco; contra la base (el mundo recién generado), solo lo cambiado', () => {
    const { st, grid } = blocks();
    const base = st.snapshot();
    const whole = encodeSnapshot(base);
    expect(whole.length).toBeLessThan(1_000_000);                // 384 x 384 x 96 vóxeles (unos 6 MB en memoria)
    // Una partida: picar unos bloques y poner tierra
    for (let k = 0; k < 6; k++) grid.set(10 + k, 12, grid.topAt(10 + k, 12), 0);
    grid.set(30, 30, grid.topAt(30, 30) + 1, grid.blocks.index('tierra'));
    const diff = encodeSnapshot(st.snapshot(), base);
    expect(diff.length).toBeLessThan(whole.length / 10);
    expect(() => decodeSnapshot(diff)).toThrow(/base/);
    // Cargar: se rehace el mundo de partida con su semilla y se le pone la partida encima
    const again = blocks();
    again.st.restore(decodeSnapshot(diff, again.st.snapshot()));
    expect(again.st.hash()).toBe(st.hash());
    expect(again.grid.get(30, 30, grid.topAt(30, 30))).toBe(grid.blocks.index('tierra'));
  });

  it('lo que no es una instantánea, o de otra versión, es un error claro', () => {
    expect(() => decodeSnapshot(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/no es una instantánea/);
    const ok = encodeSnapshot(new WorldState(new StaticVoxels({ ramps: [{ name: 'a', colors: ['#000000', '#ffffff'] }] }, 16, 16, 0, 8), [], null).snapshot());
    const v = ok.slice(); v[6] = 99;
    expect(() => decodeSnapshot(v)).toThrow(/versión 99/);
  });
});
