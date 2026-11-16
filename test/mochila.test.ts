// El ejemplo de la mochila (models/mochila, hecha con scripts/mochila.js en el editor): un solo bloque 'mochila' de
// cuero, hecho para leerse en un icono de 16 px: todo el ancho del cubo, la solapa oscura delante, la hebilla clara
// debajo y el asa arriba
import { describe, it, expect } from 'vitest';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/mochila/mochila.voxset.json';

describe('ejemplo: mochila', () => {
  it('un bloque, dentro del cubo, con la solapa oscura delante, la hebilla clara debajo y el asa arriba', () => {
    const f = file as unknown as VoxsetFile;
    BlockSet.fromJSON(f);
    expect(f.blocks.map((b) => b.id)).toEqual(['mochila']);
    expect(f.palette.ramps.map((r) => r.name)).toEqual(['cuero', 'hebilla']);
    const vs = f.blocks[0]!.voxels;
    for (const [x, y, z] of vs) for (const c of [x, y, z]) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(7); }
    // Material: rampa * 16 + tono + 1 (cuero 0, hebilla 1); en el fichero x e y van de 0 a 7 (el -4..3 del script + 4)
    const at = (x: number, y: number, z: number) => vs.find((v) => v[0] === x + 4 && v[1] === y + 4 && v[2] === z)?.[3];
    const ramp = (m: number | undefined) => (m === undefined ? -1 : Math.floor((m - 1) / 16)), tone = (m: number | undefined) => (m! - 1) % 16;
    // Todo el ancho del cubo (para que el icono llegue a 11 px) y esquinas rectas arriba
    for (const x of [-4, 3]) for (const y of [-3, 0]) expect(at(x, y, 6)).toBeDefined();
    // La solapa: 4 filas del frente, más oscuras que el cuerpo debajo
    for (let z = 3; z <= 6; z++) expect(tone(at(-3, -3, z))).toBe(1);
    expect(tone(at(-3, -3, 0))).toBe(4);
    // La hebilla, de 2 x 2, centrada justo debajo de la solapa
    for (const [x, z] of [[-1, 1], [0, 1], [-1, 2], [0, 2]] as const) expect(ramp(at(x, -3, z))).toBe(1);
    // El asa, arriba (z 7), oscura y de 7 de ancho
    expect(vs.filter((v) => v[2] === 7).length).toBe(7);
    for (const v of vs.filter((v) => v[2] === 7)) expect(tone(v[3])).toBe(0);
  });
});
