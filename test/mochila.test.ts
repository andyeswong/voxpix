// El ejemplo de la mochila (models/mochila, hecha con scripts/mochila.js en el editor): un solo bloque 'mochila' de
// cuero, dentro del cubo de 8, con la solapa (cuero más oscuro) delante del cuerpo, la hebilla clara en ella y el
// asa arriba
import { describe, it, expect } from 'vitest';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/mochila/mochila.voxset.json';

describe('ejemplo: mochila', () => {
  it('un bloque, dentro del cubo, con solapa, hebilla y asa', () => {
    const f = file as unknown as VoxsetFile;
    BlockSet.fromJSON(f);
    expect(f.blocks.map((b) => b.id)).toEqual(['mochila']);
    expect(f.palette.ramps.map((r) => r.name)).toEqual(['hierro', 'cuero']);
    const vs = f.blocks[0]!.voxels;
    for (const [x, y, z] of vs) for (const c of [x, y, z]) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(7); }
    // Material: rampa * 16 + tono + 1 (hierro 0, cuero 1); en el fichero x e y van de 0 a 7 (el -4..3 del script + 4)
    const at = (x: number, y: number, z: number) => vs.find((v) => v[0] === x + 4 && v[1] === y + 4 && v[2] === z)?.[3];
    const ramp = (m: number | undefined) => (m === undefined ? -1 : Math.floor((m - 1) / 16)), tone = (m: number | undefined) => (m! - 1) % 16;
    expect(ramp(at(-1, -4, 3))).toBe(0);                                   // la hebilla, de hierro claro
    expect(tone(at(-1, -4, 3))).toBe(3);
    expect(ramp(at(0, -3, 5))).toBe(1);                                    // la solapa, de cuero
    expect(tone(at(0, -3, 5))).toBeLessThan(tone(at(0, -2, 4)));           // más oscura que el cuerpo detrás
    expect(at(-1, 0, 7)).toBeDefined();                                    // el asa
    expect(new Set(vs.map((v) => ramp(v[3])))).toEqual(new Set([0, 1]));
  });
});
