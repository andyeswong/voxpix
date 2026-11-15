// El mapa por semilla (src/world/mapgen.ts): la misma semilla da la misma huella (y una fija, para notar cualquier
// cambio), otra semilla otra; los estratos, el agua hasta el nivel del mar con su orilla, las vetas solo en su materia
// y su franja, las cuevas sin tocar la capa 0 ni el agua, lo sembrado sobre aire y sin pisarse, las columnas por tramos;
// y applyMap deja la rejilla de bloques igual que el mapa
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateMap, applyMap, mapColumn, mapHash, type MapSpec } from '../src/world/mapgen';

// Los materiales son números que pone quien llama: aquí, los índices del set de abajo
const PIEDRA = 1, TIERRA = 2, HIERBA = 3, AGUA = 4, ARENA = 5, MENA = 6, TRONCO = 7, HOJAS = 8, FLOR = 9;
const SPEC: MapSpec = {
  seed: 7, width: 32, depth: 32, height: 12,
  surface: { base: 6, amplitude: 3, scale: 7 },
  strata: [{ material: HIERBA, depth: 1 }, { material: TIERRA, depth: 2 }, { material: PIEDRA }],
  seaLevel: 6, water: AGUA, shore: { material: ARENA, width: 1, depth: 1 },
  veins: [{ material: MENA, in: [PIEDRA, TIERRA], z: [1, 4], density: 0.05, size: [2, 4] }],
  caves: { count: 3, z: [1, 5], length: [10, 18], radius: [1, 1.6] },
  scatter: [
    { on: [HIERBA], density: 0.05, spacing: 3, structure: [[0, 0, 1, TRONCO], [0, 0, 2, TRONCO], [0, 0, 3, HOJAS], [1, 0, 3, HOJAS], [-1, 0, 3, HOJAS]] },
    { on: [HIERBA], density: 0.4, structure: [[0, 0, 1, FLOR]] },                   // sin distancia: chocaría con los troncos
  ],
};
const at = (x: number, y: number, z: number) => (z * SPEC.depth + y) * SPEC.width + x;

describe('mapa por semilla', () => {
  it('la misma semilla, la misma huella (y la fijada); otra semilla, otra', () => {
    const a = generateMap(SPEC), b = generateMap(SPEC);
    expect(mapHash(b)).toBe(mapHash(a));
    expect(b.sown).toEqual(a.sown);
    expect(mapHash(generateMap({ ...SPEC, seed: 8 }))).not.toBe(mapHash(a));
    expect(mapHash(a)).toBe(PINNED);
  });

  it('agua hasta el nivel del mar con lecho y orilla, vetas en su sitio, cuevas sin tocar la capa 0 ni el agua', () => {
    const m = generateMap(SPEC), { width: W, depth: D, height: H, cells } = m;
    let lakes = 0, shore = 0, veins = 0, caveAir = 0;
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
      expect(cells[at(x, y, 0)]).not.toBe(0);                                   // la capa 0 nunca se vacía
      let topWater = -1;
      for (let z = 0; z < H; z++) {
        const c = cells[at(x, y, z)]!;
        if (c === AGUA) { topWater = z; lakes++; }
        if (c === MENA) { veins++; expect(z).toBeGreaterThanOrEqual(1); expect(z).toBeLessThanOrEqual(4); }
        if (c === ARENA) shore++;
        // Aire por debajo de la superficie: una cueva
        if (c === 0 && z < m.heights[y * W + x]!) caveAir++;
      }
      if (topWater >= 0) {
        expect(topWater).toBe(SPEC.seaLevel);                                   // el agua llega justo al nivel del mar
        const h = m.heights[y * W + x]!;
        expect(cells[at(x, y, h)]).toBe(ARENA);                                 // y su lecho es de orilla
        for (let z = h + 1; z <= SPEC.seaLevel!; z++) expect(cells[at(x, y, z)]).toBe(AGUA);
      }
    }
    expect(lakes).toBeGreaterThan(10);
    expect(shore).toBeGreaterThan(lakes / 4);
    expect(veins).toBeGreaterThan(10);
    expect(caveAir).toBeGreaterThan(10);
  });

  it('lo sembrado va sobre su materia, fuera del agua, sobre aire, sin pisarse y a su distancia', () => {
    const m = generateMap(SPEC), { width: W, depth: D } = m, used = new Set<number>();
    expect(m.sown.filter((s) => s.rule === 0).length).toBeGreaterThan(3);
    expect(m.sown.filter((s) => s.rule === 1).length).toBeGreaterThan(20);
    for (const s of m.sown) {
      expect(m.cells[at(s.x, s.y, s.z)]).toBe(HIERBA);
      expect(s.z).toBe(m.heights[s.y * W + s.x]);
      for (const [dx, dy, dz] of m.structures[s.rule]!) {
        const k = at(s.x + dx, s.y + dy, s.z + dz);
        expect(m.cells[k]).toBe(0);
        expect(used.has(k)).toBe(false);
        used.add(k);
      }
      if (s.rule === 0) for (const o of m.sown) if (o !== s && o.rule === 0) expect(Math.max(Math.abs(o.x - s.x), Math.abs(o.y - s.y))).toBeGreaterThanOrEqual(3);
    }
    void D;
  });

  it('las columnas por tramos rehacen las celdas, y applyMap deja la rejilla igual (con lo sembrado)', () => {
    const m = generateMap(SPEC), { width: W, depth: D, height: H } = m;
    for (const [x, y] of [[0, 0], [5, 9], [31, 31], [17, 4]] as const) {
      const col = new Array<number>(H).fill(0);
      for (const [z0, z1, t] of mapColumn(m, x, y)) for (let z = z0; z <= z1; z++) col[z] = t;
      for (let z = 0; z < H; z++) expect(col[z]).toBe(m.cells[at(x, y, z)]);
    }
    const N = 2, pal: Palette = { ramps: ['#606060', '#6a4a30', '#2e7038', '#2f6a86', '#d8c290', '#b8602e', '#4a2f1d', '#2a5426', '#d02c30'].map((c, i) => ({ name: `r${i}`, colors: [c, c] })) };
    const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(r, 1)]); return o; };
    const file: VoxsetFile = { format: 'voxpix-set', version: 1, name: 'mapa', size: N, palette: pal, blocks: ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'mena', 'tronco', 'hojas', 'flor'].map((id, i) => ({ id, voxels: cube(i) })) };
    const set = BlockSet.fromJSON(file);
    const grid = new BlockGrid(new WorldState(new StaticVoxels(pal, W * N, D * N, 0, H * N - 1), [], null), set);
    applyMap(m, grid);
    const sownAt = new Map<number, number>();
    for (const s of m.sown) for (const [dx, dy, dz, t] of m.structures[s.rule]!) sownAt.set(at(s.x + dx, s.y + dy, s.z + dz), t);
    for (let z = 0; z < H; z++) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) expect(grid.get(x, y, z)).toBe(sownAt.get(at(x, y, z)) ?? m.cells[at(x, y, z)]);
  });
});

const PINNED = '1901d0a1';                                   // la huella de SPEC: si cambia, el mapa cambió                                   // la huella de SPEC: si cambia, el mapa cambió
