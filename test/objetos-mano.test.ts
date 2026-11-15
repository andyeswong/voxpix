// El ejemplo de objetos de mano (models/objetos, hecho con scripts/objetos.js en el editor): los ids, que caben en el
// cubo de 8, que el agarre de cada uno es uno de sus vóxeles (o el pie del lingote) y que nada es sólido
import { describe, it, expect } from 'vitest';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/objetos/objetos.voxset.json';

const GRIP: Record<string, [number, number, number]> = {
  palo: [0, 0, 1], pico_madera: [0, 0, 1], pico_piedra: [0, 0, 1], pico_hierro: [0, 0, 1],
  espada_madera: [0, 0, 0], espada_piedra: [0, 0, 0], espada_hierro: [0, 0, 0], lingote_hierro: [0, 0, 0], lingote_oro: [0, 0, 0],
};

describe('ejemplo: objetos de mano', () => {
  it('ids, caja, agarre y que no son sólidos', () => {
    const f = file as unknown as VoxsetFile;
    BlockSet.fromJSON(f);
    expect(f.blocks.map((b) => b.id)).toEqual(Object.keys(GRIP));
    for (const b of f.blocks) {
      expect(b.props?.solid).toBe(false);
      for (const [x, y, z] of b.voxels) for (const c of [x, y, z]) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(7); }
      // En el fichero las coordenadas van de 0 a 7 (el lienzo de -4 a 3, +4): el agarre es uno de sus vóxeles
      const [gx, gy, gz] = GRIP[b.id]!;
      expect(b.voxels.some(([x, y, z]) => x === gx + 4 && y === gy + 4 && z === gz), b.id).toBe(true);
    }
  });
});
