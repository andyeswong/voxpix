// El ejemplo de la mochila (models/mochila, hecha con scripts/mochila.js en el editor): un solo bloque 'mochila' de
// cuero, hecho para que su icono oblicuo de 16 px parezca un dibujo plano: una losa de 2 de hondo con todo el ancho,
// la solapa oscura en las 3 filas de arriba (y por encima), la hebilla clara centrada debajo y el asa arriba
import { describe, it, expect } from 'vitest';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/mochila/mochila.voxset.json';

describe('ejemplo: mochila', () => {
  it('una losa de 8 x 2 x 7 con la solapa arriba, la hebilla centrada debajo y el asa encima', () => {
    const f = file as unknown as VoxsetFile;
    BlockSet.fromJSON(f);
    expect(f.blocks.map((b) => b.id)).toEqual(['mochila']);
    expect(f.palette.ramps.map((r) => r.name)).toEqual(['cuero', 'hebilla']);
    const vs = f.blocks[0]!.voxels;
    for (const [x, y, z] of vs) for (const c of [x, y, z]) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(7); }
    // Material: rampa * 16 + tono + 1 (cuero 0, hebilla 1); en el fichero x e y van de 0 a 7 (el -4..3 del script + 4)
    const at = (x: number, y: number, z: number) => vs.find((v) => v[0] === x + 4 && v[1] === y + 4 && v[2] === z)?.[3];
    const ramp = (m: number | undefined) => (m === undefined ? -1 : Math.floor((m - 1) / 16)), tone = (m: number | undefined) => (m! - 1) % 16;
    // La losa: todo el ancho, 2 de hondo (y -1..0), 7 de alto, y nada detrás
    for (const x of [-4, 3]) for (const y of [-1, 0]) for (const z of [0, 6]) expect(at(x, y, z)).toBeDefined();
    expect(vs.every((v) => v[1] === 3 || v[1] === 4)).toBe(true);
    // La solapa: las 3 filas de arriba del frente, oscuras; el cuerpo debajo, claro
    for (let z = 4; z <= 6; z++) expect(tone(at(-4, -1, z))).toBe(1);
    expect(tone(at(-4, -1, 0))).toBe(5);
    // La hebilla, centrada (x -2..1) justo debajo de la solapa (z 2..3)
    for (let x = -2; x <= 1; x++) for (const z of [2, 3]) expect(ramp(at(x, -1, z))).toBe(1);
    // El asa: la fila de arriba (z 7), 4 vóxeles centrados en el plano del frente, oscuros
    const top = vs.filter((v) => v[2] === 7);
    expect(top.map((v) => v[0] - 4).sort((a, b) => a - b)).toEqual([-2, -1, 0, 1]);
    for (const v of top) { expect(v[1] - 4).toBe(-1); expect(tone(v[3])).toBe(0); }
  });
});
