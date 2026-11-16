// El ejemplo de bloques medievales (models/medieval, hecho con scripts/bloques-medievales.js en el editor): los ids, qué
// es sólido, qué brilla y qué se cruza; la escalera pegada a la cara +y, que se trepa; y todo dentro del cubo de 8
import { describe, it, expect } from 'vitest';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import { materialsOf } from '../src/core';
import file from '../models/medieval/medieval.voxset.json';

describe('ejemplo: bloques medievales', () => {
  it('ids, propiedades y caja', () => {
    const f = file as unknown as VoxsetFile;
    BlockSet.fromJSON(f);
    const byId = Object.fromEntries(f.blocks.map((b) => [b.id, b]));
    expect(Object.keys(byId)).toEqual(['mena_hierro', 'mena_oro', 'adoquin', 'tablas', 'arena', 'mesa', 'horno', 'horno_encendido', 'cofre', 'cofre_abierto', 'escalera', 'hueso']);
    for (const id of ['mena_hierro', 'mena_oro', 'adoquin', 'tablas', 'arena', 'mesa', 'horno', 'cofre', 'cofre_abierto']) expect(byId[id]?.props).toMatchObject({ solid: true, emissive: false });
    expect(byId.horno_encendido!.props).toMatchObject({ solid: true, emissive: true });
    for (const id of ['escalera', 'hueso']) expect(byId[id]?.props?.solid).toBe(false);
    // La escalera, toda en la fila de la cara +y (en el fichero, y de 0 a 7: la 7)
    expect(byId.escalera!.voxels.every((v) => v[1] === 7)).toBe(true);
    // y se trepa: todos sus vóxeles son de una rampa de material 'escala' (ladder, la que lee moveBodyLevels)
    expect(byId.escalera!.voxels.every((v) => f.palette.ramps[Math.floor((v[3] - 1) / 16)]?.material === 'escala')).toBe(true);
    expect(materialsOf(f.palette)!.ramps.find((r, i) => f.palette.ramps[i]!.name === 'escalera')).toMatchObject({ ladder: true });
    for (const b of f.blocks) for (const [x, y, z] of b.voxels) for (const c of [x, y, z]) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(7); }
    // El horno apagado tiene la boca vacía: menos vóxeles que el cubo; el encendido, brasa en ella
    expect(byId.horno!.voxels.length).toBeLessThan(512);
    expect(byId.horno_encendido!.voxels.length).toBeGreaterThan(byId.horno!.voxels.length);
  });
});
