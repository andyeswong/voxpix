// El ejemplo de las flores (models/flores, hecho con scripts/flores.js en el editor): tres bloques de un set que se
// cruzan y dejan pasar la luz (rampas 'follaje'), pequeños y de pie sobre z = 0 dentro de su cubo de 8
import { describe, it, expect } from 'vitest';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/flores/flores.voxset.json';

describe('ejemplo: flores', () => {
  it('se cargan como bloques que se cruzan y dejan pasar la luz, de pie en z = 0 y dentro del cubo', () => {
    const set = BlockSet.fromJSON(file as unknown as VoxsetFile);
    const f = file as unknown as VoxsetFile;
    expect(f.blocks.map((b) => b.id)).toEqual(['flor_roja', 'flor_amarilla', 'flor_blanca']);
    for (const b of f.blocks) {
      expect(b.props).toMatchObject({ solid: false, light: 'passes', emissive: false });
      const zs = b.voxels.map((v) => v[2]), xs = b.voxels.map((v) => v[0]), ys = b.voxels.map((v) => v[1]);
      expect(Math.min(...zs)).toBe(0);
      expect(Math.max(...zs)).toBeLessThan(8);
      expect(Math.min(...xs, ...ys)).toBeGreaterThanOrEqual(0);     // en el fichero, de 0 a 7 (el lienzo de -4 a 3, +4)
      expect(Math.max(...xs, ...ys)).toBeLessThanOrEqual(7);
      expect(b.voxels.some((v) => v[0] === 4 && v[1] === 4 && v[2] === 0)).toBe(true);   // el tallo, en el centro
      expect(b.voxels.length).toBeGreaterThan(10);
      expect(set.index(b.id)).toBeGreaterThan(0);
    }
  });
});
