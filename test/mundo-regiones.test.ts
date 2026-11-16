// El mundo por regiones (src/world/regiongen.ts): la regla de oro. Un mundo de 192 x 192 generado entero y el mismo en
// trozos de 16 x 16 en orden aleatorio dan las mismas celdas, alturas y lista sembrada; también cortado en z, y en
// trozos que no empiezan en 0 (también en negativo). Y la huella fijada
import { describe, it, expect } from 'vitest';
import { generateRegion, regionHash, applyRegion, type RegionSpec, type GeneratedRegion } from '../src/world/regiongen';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';

const PIEDRA = 1, TIERRA = 2, HIERBA = 3, AGUA = 4, ARENA = 5, CARBON = 6, MENA = 7, TRONCO = 8, HOJAS = 9, FLOR = 10;
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) leaves.push([dx, dy, 4, HOJAS]);
const SPEC: RegionSpec = {
  seed: 11, width: 96, depth: 96, height: 24,
  surface: { base: 11, amplitude: 4, scale: 9 },
  strata: [{ material: HIERBA, depth: 1 }, { material: TIERRA, depth: 2 }, { material: PIEDRA }],
  seaLevel: 10, water: AGUA, shore: { material: ARENA, width: 1, depth: 1 },
  veins: [
    { material: CARBON, in: [PIEDRA], z: [3, 9], density: 0.06, size: [2, 5] },
    { material: MENA, in: [PIEDRA], z: [1, 6], density: 0.03, size: [2, 4] },
  ],
  caves: { count: 20, z: [2, 8], length: [20, 40], radius: [1, 1.7] },
  scatter: [
    { on: [HIERBA], density: 0.03, spacing: 4, structure: [[0, 0, 1, TRONCO], [0, 0, 2, TRONCO], [0, 0, 3, TRONCO], ...leaves, [0, 0, 5, HOJAS]] },
    { on: [HIERBA], density: 0.08, structure: [[0, 0, 1, FLOR]] },
  ],
};
const N = 192, Z = 24;

// Junta trozos en una región grande (las celdas y alturas en su sitio; lo sembrado, la unión ordenada)
function stitch(parts: GeneratedRegion[], x0: number, y0: number, z0: number, W: number, D: number, H: number) {
  const cells = new Uint16Array(W * D * H), heights = new Int16Array(W * D);
  const sown: GeneratedRegion['sown'] = [];
  for (const p of parts) {
    const g = p.region;
    for (let z = 0; z < g.height; z++) for (let y = 0; y < g.depth; y++) for (let x = 0; x < g.width; x++)
      cells[((g.z0 - z0 + z) * D + (g.y0 - y0 + y)) * W + (g.x0 - x0 + x)] = p.cells[(z * g.depth + y) * g.width + x]!;
    for (let y = 0; y < g.depth; y++) for (let x = 0; x < g.width; x++) heights[(g.y0 - y0 + y) * W + (g.x0 - x0 + x)] = p.heights[y * g.width + x]!;
    sown.push(...p.sown);
  }
  sown.sort((a, b) => a.rule - b.rule || a.y - b.y || a.x - b.x || a.z - b.z);
  return { cells, heights, sown };
}
const shuffle = <T,>(a: T[], seed: number) => { let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };

describe('mundo por regiones', () => {
  it('192 x 192 entero y en trozos de 16 x 16 en orden aleatorio: lo mismo', () => {
    const whole = generateRegion(SPEC, { x0: 0, y0: 0, z0: 0, width: N, depth: N, height: Z });
    // Lo que tiene que haber para que la prueba diga algo
    const count = (m: number) => whole.cells.reduce((n, c) => n + (c === m ? 1 : 0), 0);
    expect(count(AGUA)).toBeGreaterThan(500);
    expect(count(CARBON)).toBeGreaterThan(100);
    expect(count(MENA)).toBeGreaterThan(30);
    expect(whole.sown.filter((s) => s.rule === 0).length).toBeGreaterThan(20);
    expect(whole.sown.filter((s) => s.rule === 1).length).toBeGreaterThan(200);
    let caveAir = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) for (let z = 1; z < whole.heights[y * N + x]!; z++) if (whole.cells[(z * N + y) * N + x] === 0) caveAir++;
    expect(caveAir).toBeGreaterThan(200);
    const boxes: Array<[number, number]> = [];
    for (let y = 0; y < N; y += 16) for (let x = 0; x < N; x += 16) boxes.push([x, y]);
    const parts = shuffle(boxes, 7).map(([x, y]) => generateRegion(SPEC, { x0: x, y0: y, z0: 0, width: 16, depth: 16, height: Z }));
    const s = stitch(parts, 0, 0, 0, N, N, Z);
    expect(Array.from(s.heights)).toEqual(Array.from(whole.heights));
    let diff = 0;
    for (let i = 0; i < s.cells.length; i++) if (s.cells[i] !== whole.cells[i]) diff++;
    expect(diff).toBe(0);
    expect(s.sown).toEqual(whole.sown);
  });

  it('cortado en z, y lejos del origen (también en negativo), igual', () => {
    const at = { x0: -40, y0: 1000, width: 48, depth: 40 };
    const whole = generateRegion(SPEC, { ...at, z0: -4, height: Z + 8 });
    const parts = [
      generateRegion(SPEC, { x0: -40, y0: 1000, z0: -4, width: 24, depth: 40, height: 15 }),
      generateRegion(SPEC, { x0: -40, y0: 1000, z0: 11, width: 24, depth: 40, height: Z + 8 - 15 }),
      generateRegion(SPEC, { x0: -16, y0: 1000, z0: -4, width: 24, depth: 23, height: Z + 8 }),
      generateRegion(SPEC, { x0: -16, y0: 1023, z0: -4, width: 24, depth: 17, height: Z + 8 }),
    ];
    const s = stitch(parts, at.x0, at.y0, -4, at.width, at.depth, Z + 8);
    let diff = 0;
    for (let i = 0; i < s.cells.length; i++) if (s.cells[i] !== whole.cells[i]) diff++;
    expect(diff).toBe(0);
    expect(s.sown).toEqual(whole.sown);
    // Por encima del mundo, aire; por debajo de 0, el último estrato sigue (sin bottom)
    expect(whole.cells.slice((Z + 4) * 40 * 48).every((c) => c === 0)).toBe(true);
    expect(whole.cells[0]).toBe(PIEDRA);
    // Con bottom, debajo es aire
    const abyss = generateRegion({ ...SPEC, bottom: 0 }, { x0: 0, y0: 0, z0: -3, width: 8, depth: 8, height: 6 });
    expect(abyss.cells.slice(0, 3 * 64).every((c) => c === 0)).toBe(true);
  });

  it('escribir trozo a trozo en una rejilla deja lo mismo que escribir entero (también los árboles que cruzan bordes)', () => {
    const B = 2, ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'mena', 'tronco', 'hojas', 'flor'];
    const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${(i * 20 + 30).toString(16)}3030`] })) };
    const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, 0)]); return o; };
    const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'r', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as VoxsetFile);
    const W = 48, at = [300, 40] as const;
    const mk = () => new BlockGrid(new WorldState(new StaticVoxels(pal, W * B, W * B, 0, Z * B - 1), [], null), set);
    const a = mk(), b = mk();
    const whole = generateRegion(SPEC, { x0: at[0], y0: at[1], z0: 0, width: W, depth: W, height: Z });
    expect(whole.sown.filter((s) => s.rule === 0).length).toBeGreaterThan(3);
    applyRegion(whole, a, [0, 0, 0]);
    const boxes: Array<[number, number]> = [];
    for (let y = 0; y < W; y += 16) for (let x = 0; x < W; x += 16) boxes.push([x, y]);
    for (const [x, y] of shuffle(boxes, 3)) applyRegion(generateRegion(SPEC, { x0: at[0] + x, y0: at[1] + y, z0: 0, width: 16, depth: 16, height: Z }), b, [x, y, 0]);
    let diff = 0, filled = 0;
    for (let z = 0; z < Z; z++) for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { if (a.get(x, y, z) !== b.get(x, y, z)) diff++; if (a.get(x, y, z)) filled++; }
    expect(filled).toBeGreaterThan(W * W * 5);
    expect(diff).toBe(0);
  });

  it('la huella fijada (si cambia, el mundo cambió)', () => {
    expect(regionHash(generateRegion(SPEC, { x0: 0, y0: 0, z0: 0, width: 64, depth: 64, height: Z }))).toBe('6ea96928');
  });
});
