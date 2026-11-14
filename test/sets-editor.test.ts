// El set de bloques del editor (app/src/blockSet.ts, window.voxpix newSet/addBlock/block/saveBlock/saveSet/loadSet):
// guardar bloques desde el lienzo, volver a ellos, exportar un .voxset.json que el motor acepta, y que un cambio de
// paleta después de guardar no los rompa (se traducen por el nombre de la rampa)
import { describe, it, expect } from 'vitest';
import { Model, material, decode } from '../src/core';
import { model, replaceModel, history } from '../app/src/store';
import { newSet, addBlock, block, saveBlock, saveSet, loadSet, listBlocks, blockSet } from '../app/src/blockSet';
import { BlockSet } from '../src/world/blocks';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
  { name: 'hierba', colors: ['#10301a', '#2e7038', '#68b060'] },
  { name: 'llama', colors: ['#a04010', '#f0a020'], emissive: true, material: 'atravesable' as const },
] };
const N = 4;
function paintCube(ramp: number): void {
  const h = history.value;
  h.begin();
  for (let z = 0; z < N; z++) for (let y = -2; y < 2; y++) for (let x = -2; x < 2; x++) h.set(x, y, z, material(ramp, 1));
  h.commit();
}

describe('set de bloques del editor', () => {
  it('guardar, volver, exportar e importar', () => {
    replaceModel(new Model(PAL, 'x'));
    newSet('prueba', N);
    expect(blockSet.active).toBe(true);
    paintCube(0);
    expect(addBlock('piedra')).toBe(1);
    expect(() => addBlock('piedra')).toThrow(/ya hay/);
    block(null);
    expect(model.value.size).toBe(0);
    history.value.begin(); history.value.set(0, 0, 0, material(3, 0)); history.value.set(0, 0, 1, material(3, 1)); history.value.commit();
    addBlock('antorcha', { emits: { kind: 'torch' } });
    block(null); paintCube(2);
    addBlock('hierba', { covered: 'tierra' });
    expect(() => saveSet()).toThrow(/tierra/);                  // covered nombra un bloque que aún no está
    block(null); paintCube(1);
    addBlock('tierra');
    // Fuera del lienzo del bloque: error claro
    history.value.begin(); history.value.set(5, 0, 0, material(1, 1)); history.value.commit();
    expect(() => saveBlock()).toThrow(/fuera del bloque/);
    history.value.undo();
    // Volver a la piedra, cambiarla y guardarla
    block('piedra');
    expect(model.value.size).toBe(N * N * N);
    history.value.begin(); history.value.set(-2, -2, 3, 0); history.value.commit();
    saveBlock();
    const f = saveSet();
    const set = BlockSet.fromJSON(f);
    expect(set.ids()).toEqual(['piedra', 'antorcha', 'hierba', 'tierra']);
    expect(set.get(set.index('piedra')).model.size).toBe(N * N * N - 1);
    expect(set.get(set.index('antorcha')).props).toMatchObject({ solid: false, emissive: true, emits: { kind: 'torch' } });
    expect(listBlocks().map((b) => b.id)).toEqual(['piedra', 'antorcha', 'hierba', 'tierra']);
    // Abrirlo de nuevo da lo mismo
    expect(loadSet(JSON.stringify(f)).blocks).toEqual(['piedra', 'antorcha', 'hierba', 'tierra']);
    expect(saveSet()).toEqual(f);
  });

  it('cambiar el orden de la paleta después de guardar: los bloques se traducen por el nombre de su rampa', () => {
    replaceModel(new Model(PAL, 'x'));
    newSet('orden', N);
    paintCube(0);
    addBlock('piedra');
    // La misma paleta al revés (como si se hubieran reordenado las rampas)
    const rev = { ramps: [...PAL.ramps].reverse() };
    replaceModel(new Model(rev, 'x'));
    const f = saveSet();
    const piedra = rev.ramps.findIndex((r) => r.name === 'piedra');
    expect(f.blocks[0]!.voxels.every(([, , , v]) => decode(v).ramp === piedra)).toBe(true);
  });
});
