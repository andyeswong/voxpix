// Motor de escenario: autotiles y regiones de terreno.
import { describe, expect, it } from 'vitest';
import { BLOB47, E, N, NE, NW, S, SE, SW, W, blobIndex, neighborMask, reduceMask } from '../src/terrain/autotile';
import { KIND_BY_ID, analyzeMasses, massAt } from '../src/terrain/regions';
import { TILE, TONE, buildWaterAtlas, cellRect, colorize, WATER_PALETTES, waterTone } from '../src/terrain/waterTiles';

// Mapa de texto: '#' es del tipo, '.' no
const grid = (rows: string[]) => ({
  w: rows[0]!.length,
  h: rows.length,
  at: (x: number, y: number) => rows[y]?.[x] === '#',
});
const analyze = (rows: string[], options = {}) => {
  const g = grid(rows);
  return analyzeMasses(g.w, g.h, g.at, options);
};

describe('autotile de 8 vecinas', () => {
  it('quedan 47 piezas distintas', () => {
    expect(BLOB47).toHaveLength(47);
    expect(new Set(BLOB47).size).toBe(47);
    expect(BLOB47[0]).toBe(0);
    expect(BLOB47[46]).toBe(255);
  });

  it('una esquina solo cuenta si sus dos lados también son vecinas', () => {
    expect(reduceMask(NE)).toBe(0);                        // solo la diagonal: no cuenta
    expect(reduceMask(N | NE)).toBe(N);                    // falta el lado este
    expect(reduceMask(N | E | NE)).toBe(N | E | NE);       // los dos lados: sí
    expect(reduceMask(N | E | S | W)).toBe(N | E | S | W);
    expect(reduceMask(255)).toBe(255);
  });

  it('cada máscara reducida tiene su propia variante y las no reducidas caen en la suya', () => {
    const seen = new Set<number>();
    for (let m = 0; m < 256; m++) {
      const v = blobIndex(m);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(47);
      expect(BLOB47[v]).toBe(reduceMask(m));
      seen.add(v);
    }
    expect(seen.size).toBe(47);
  });

  it('neighborMask lee las 8 vecinas', () => {
    const g = grid(['###', '###', '###']);
    expect(neighborMask(g.at, 1, 1)).toBe(255);
    expect(neighborMask(g.at, 0, 0)).toBe(E | SE | S);
    expect(neighborMask(g.at, 2, 2)).toBe(N | NW | W);
    expect(neighborMask(() => false, 1, 1)).toBe(0);
    expect(neighborMask((x, y) => x === 2 && y === 0, 1, 1)).toBe(NE);
    expect(neighborMask((x, y) => x === 0 && y === 2, 1, 1)).toBe(SW);
  });
});

describe('masas: charco, lago y océano por tamaño', () => {
  it('las celdas que se tocan por un lado son una masa; en diagonal, dos', () => {
    const r = analyze(['##..', '....', '..#.', '...#']);
    expect(r.regionSizes.slice().sort()).toEqual([1, 1, 2]);
    expect(new Set(Array.from(r.region).filter((n) => n >= 0)).size).toBe(3);
  });

  it('la clase depende del tamaño de la masa', () => {
    const rows = [
      '#.......',
      '........',
      '.###....',
      '.###....',
      '.###....',
      '........',
    ];
    const r = analyze(rows, { puddleMax: 4, lakeMax: 9, edgeIsMember: false });
    expect(KIND_BY_ID[r.kind[0]!]).toBe('puddle');          // 1 celda
    expect(KIND_BY_ID[r.kind[3 * 8 + 2]!]).toBe('lake');    // 9 celdas: justo en el límite del lago
    const bigger = analyze(rows, { puddleMax: 4, lakeMax: 8, edgeIsMember: false });
    expect(KIND_BY_ID[bigger.kind[3 * 8 + 2]!]).toBe('ocean');   // con lakeMax 8, las mismas 9 celdas ya son océano
  });

  it('puddleMax y lakeMax marcan los límites', () => {
    const block = (n: number) => Array.from({ length: n }, () => '#'.repeat(n));
    const kindOf = (n: number, o: object) => KIND_BY_ID[analyze(block(n), { edgeIsMember: false, ...o }).kind[0]!];
    expect(kindOf(2, { puddleMax: 4, lakeMax: 20 })).toBe('puddle');   // 4 celdas
    expect(kindOf(3, { puddleMax: 4, lakeMax: 20 })).toBe('lake');     // 9
    expect(kindOf(5, { puddleMax: 4, lakeMax: 20 })).toBe('ocean');    // 25
  });

  it('profundidad: 1 en la orilla y +1 hacia dentro', () => {
    const r = analyze(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.#####.', '.......'], { edgeIsMember: false });
    const depthAt = (x: number, y: number) => r.depth[y * 7 + x];
    expect(depthAt(1, 1)).toBe(1);
    expect(depthAt(3, 1)).toBe(1);
    expect(depthAt(2, 2)).toBe(2);
    expect(depthAt(3, 3)).toBe(3);
    expect(depthAt(0, 0)).toBe(0);
  });

  it('con edgeIsMember el borde del mapa no es orilla', () => {
    const rows = ['####', '####', '####', '####'];
    const open = analyze(rows, { edgeIsMember: true });
    const closed = analyze(rows, { edgeIsMember: false });
    expect(closed.depth[0]).toBe(1);
    expect(open.depth[0]).toBe(255);                         // sin orilla en todo el mapa: profundo
    expect(BLOB47[open.variant[0]!]).toBe(255);              // sigue más allá: pieza llena
    expect(BLOB47[closed.variant[0]!]).toBe(E | SE | S);     // esquina cerrada
  });

  it('una celda que no es del tipo no tiene masa ni clase', () => {
    const r = analyze(['#.', '..']);
    expect(r.region[1]).toBe(-1);
    expect(r.kind[1]).toBe(0);
    expect(r.depth[1]).toBe(0);
  });
});

describe('piezas de agua', () => {
  const opaque = (tone: Uint8Array, x: number, y: number) => tone[y * TILE + x] !== TONE.clear;
  const index = (mask: number) => BLOB47.indexOf(mask);

  it('una pieza rodeada de agua es toda cuerpo (sin borde ni espuma)', () => {
    const tone = waterTone(index(255));
    expect(Array.from(tone).every((t) => t === TONE.body || t === TONE.ripple)).toBe(true);
  });

  it('una pieza aislada es un charco redondeado, simétrico, con las esquinas vacías', () => {
    const tone = waterTone(index(0));
    expect(opaque(tone, 0, 0)).toBe(false);
    expect(opaque(tone, 15, 15)).toBe(false);
    expect(opaque(tone, 8, 8)).toBe(true);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      expect(opaque(tone, x, y)).toBe(opaque(tone, TILE - 1 - x, y));
      expect(opaque(tone, x, y)).toBe(opaque(tone, x, TILE - 1 - y));
    }
  });

  it('un lado sin vecina retira el agua 2 px y deja contorno y espuma', () => {
    const tone = waterTone(index(255 & ~N & ~NE & ~NW));
    for (let x = 0; x < TILE; x++) {
      expect(opaque(tone, x, 0)).toBe(false);
      expect(opaque(tone, x, 1)).toBe(false);
    }
    expect(tone[2 * TILE + 8]).toBe(TONE.edge);
    expect(tone[3 * TILE + 8]).toBe(TONE.foam);
    expect(tone[4 * TILE + 8]).toBe(TONE.foam);
    expect([TONE.body, TONE.ripple]).toContain(tone[5 * TILE + 8]);
  });

  it('una esquina cóncava deja un cuarto de círculo de tierra', () => {
    const tone = waterTone(index(255 & ~NW));
    expect(opaque(tone, 0, 0)).toBe(false);
    expect(opaque(tone, 8, 8)).toBe(true);
    expect(opaque(tone, TILE - 1, TILE - 1)).toBe(true);
  });

  // Lo importante: dos celdas de agua vecinas no pueden dejar un salto en el borde que comparten
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const edgeIsMember of [false, true]) {
    it(`la orilla es continua entre celdas vecinas en mapas al azar (edgeIsMember=${edgeIsMember})`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const rand = rng(seed);
        const w = 14;
        const h = 12;
        const cells = Array.from({ length: w * h }, () => rand() < 0.6);
        const r = analyzeMasses(w, h, (x, y) => cells[y * w + x] ?? false, { edgeIsMember });
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (!cells[y * w + x]) continue;
            const a = waterTone(r.variant[y * w + x]!);
            if (x + 1 < w && cells[y * w + x + 1]) {
              const b = waterTone(r.variant[y * w + x + 1]!);
              for (let k = 0; k < TILE; k++) expect(opaque(a, TILE - 1, k), `semilla ${seed} (${x},${y}) este, fila ${k}`).toBe(opaque(b, 0, k));
            }
            if (y + 1 < h && cells[(y + 1) * w + x]) {
              const b = waterTone(r.variant[(y + 1) * w + x]!);
              for (let k = 0; k < TILE; k++) expect(opaque(a, k, TILE - 1), `semilla ${seed} (${x},${y}) sur, col ${k}`).toBe(opaque(b, k, 0));
            }
          }
        }
      }
    });
  }

  it('colorize pone alfa solo donde hay agua y usa la profundidad', () => {
    const tone = waterTone(index(0));
    const shallow = colorize(tone, WATER_PALETTES.lake, 0);
    const deep = colorize(tone, WATER_PALETTES.lake, 3);
    expect(shallow[3]).toBe(0);                                         // esquina vacía
    const c = (8 * TILE + 8) * 4;
    expect(shallow[c + 3]).toBe(255);
    expect(Array.from(shallow.slice(c, c + 3))).not.toEqual(Array.from(deep.slice(c, c + 3)));
  });

  it('el charco es transparente (deja ver el suelo) y el lago y el océano siguen opacos', () => {
    const tone = waterTone(index(255));
    const alphaAt = (kind: 'puddle' | 'lake' | 'ocean') => colorize(tone, WATER_PALETTES[kind], 0)[(8 * TILE + 8) * 4 + 3]!;
    expect(alphaAt('puddle')).toBeGreaterThan(60);
    expect(alphaAt('puddle')).toBeLessThan(200);
    expect(alphaAt('lake')).toBe(255);
    expect(alphaAt('ocean')).toBe(255);
    // el borde del charco es suave: menos opaco que el cuerpo del lago, y la esquina vacía sigue siendo transparente
    const iso = colorize(waterTone(index(0)), WATER_PALETTES.puddle, 0);
    expect(iso[3]).toBe(0);
    const edgeAlpha = iso[(2 * TILE + 8) * 4 + 3]!;
    expect(edgeAlpha).toBeGreaterThan(0);
    expect(edgeAlpha).toBeLessThan(255);
  });

  it('el atlas lleva el alfa del charco en su fila', () => {
    const atlas = buildWaterAtlas();
    const r = cellRect(index(255), 'puddle', 0);
    const a = atlas.data[((r.y + 8) * atlas.width + r.x + 8) * 4 + 3]!;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
  });

  it('el atlas tiene 47 columnas y 12 filas y cada celda cae donde cellRect dice', () => {
    const atlas = buildWaterAtlas();
    expect(atlas.width).toBe(47 * TILE);
    expect(atlas.height).toBe(12 * TILE);
    const r = cellRect(index(255), 'ocean', 3);
    expect(r).toEqual({ x: 46 * TILE, y: 11 * TILE, w: TILE, h: TILE });
    const px = ((r.y + 8) * atlas.width + r.x + 8) * 4;
    expect(atlas.data[px + 3]).toBe(255);
  });
});

describe('massAt: lo que la simulación puede preguntar', () => {
  const map = analyze(['....', '.##.', '.##.', '....'], { edgeIsMember: false });
  it('da clase, profundidad y masa de una celda de agua', () => {
    expect(massAt(map, 1, 1)).toEqual({ kind: 'puddle', depth: 1, region: 0 });
  });
  it('una celda de tierra no tiene clase', () => {
    expect(massAt(map, 0, 0)).toEqual({ kind: 'none', depth: 0, region: -1 });
  });
  it('fuera del mapa no hay nada', () => {
    expect(massAt(map, -1, 0)).toBeUndefined();
    expect(massAt(map, 4, 0)).toBeUndefined();
    expect(massAt(map, 0, 99)).toBeUndefined();
  });
});

// La simulación (sim/) es determinista y no sabe de dibujo: la parte pura de terrain/ no puede
// depender de la vista ni usar azar sin semilla (el azar del motor sale de sim/rng.ts).
describe('terrain: la parte pura no depende de la vista', () => {
  const sources = import.meta.glob('../src/terrain/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const file = (name: string) => Object.entries(sources).find(([k]) => k.endsWith(`/${name}`))?.[1] ?? '';
  const importsOf = (src: string) => [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);

  for (const name of ['autotile.ts', 'regions.ts', 'index.ts']) {
    it(`${name} solo importa de la parte pura`, () => {
      expect(file(name)).not.toBe('');
      for (const imp of importsOf(file(name))) {
        expect(['./autotile', './regions'], `${name} importa ${imp}`).toContain(imp);
      }
    });
  }

  it('ningún archivo usa azar sin semilla ni el reloj', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(4);
    for (const [k, src] of Object.entries(sources)) {
      expect(src, k).not.toMatch(/Math\.random|Date\.now|performance\.now/);
    }
  });
});
