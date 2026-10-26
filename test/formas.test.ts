// Formas de sala (src/worldgen/shape.ts): L, T, salas con pasillos, laberinto y plano en texto. En todas, el suelo está
// conectado y nada (agua, columnas, muebles, salida, materiales) cae dentro de una pared. Sin forma, el mapa de siempre.
import { describe, it, expect } from 'vitest';
import { generateLayout, WALL, NORTH, TILE, type GeneratorSpec, type ShapeSpec, type Layout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildSampleRecipe } from '../src/samples/recipes';

const SPEC = THEMES.medieval.spec;
const floorCells = (l: Layout) => [...l.wall].map((w, i) => (w === WALL.none ? i : -1)).filter((i) => i >= 0);

function connected(l: Layout): boolean {
  const cells = floorCells(l);
  const seen = new Set([cells[0]!]);
  const q = [cells[0]!];
  while (q.length) {
    const c = q.pop()!, x = c % l.cols;
    for (const n of [x > 0 ? c - 1 : -1, x < l.cols - 1 ? c + 1 : -1, c - l.cols, c + l.cols]) {
      if (n < 0 || n >= l.wall.length || l.wall[n] !== WALL.none || seen.has(n)) continue;
      seen.add(n); q.push(n);
    }
  }
  return seen.size === cells.length;
}

function sane(l: Layout): void {
  const wallAt = (cx: number, cy: number) => l.wall[cy * l.cols + cx] !== WALL.none;
  expect(connected(l)).toBe(true);
  for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) {
    const i = y * l.cols + x;
    if (!l.wall[i]) continue;
    expect(l.water[y]![x], `agua en pared ${x},${y}`).toBe('.');
    expect(l.pillar[i], `columna o mueble en pared ${x},${y}`).toBe(0);
  }
  expect(wallAt(Math.floor(l.spawn.x / TILE), Math.floor(l.spawn.y / TILE))).toBe(false);
  // Las columnas (no los muebles) dejan al menos 2 losetas libres hasta cualquier pared: no tapan un pasillo
  for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) {
    const i = y * l.cols + x;
    if (!l.pillar[i] || l.prop[i]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) expect(wallAt(x + dx, y + dy), `columna ${x},${y} junto a pared`).toBe(false);
  }
  for (const m of l.materials) expect(wallAt(Math.floor(m.x / TILE), Math.floor(m.y / TILE))).toBe(false);
}

const SHAPES: ShapeSpec[] = [
  { kind: 'L' }, { kind: 'L', corner: 'sw', size: 0.6 },
  { kind: 'T' }, { kind: 'T', bar: 'south', stem: 0.2 },
  { kind: 'corridors' }, { kind: 'corridors', rooms: 8, width: 2 },
  { kind: 'maze' }, { kind: 'maze', cell: 3, loops: 0.3 },
];

describe('formas de sala', () => {
  it('sin forma, el mismo mapa que antes', () => {
    // La huella del mundo de muestra (la de las pruebas de determinismo) no cambia: aquí, el layout entero
    const a = generateLayout(SPEC, 7), b = generateLayout({ ...SPEC }, 7);
    expect(JSON.stringify({ ...a, masses: null })).toBe(JSON.stringify({ ...b, masses: null }));
  });

  for (const shape of SHAPES) it(`${JSON.stringify(shape)}: conectado, y nada dentro de las paredes`, () => {
    for (const seed of [1, 2, 7, 33]) {
      const l = generateLayout({ ...SPEC, shape }, seed);
      sane(l);
      // Hay pared de verdad dentro (la forma hizo algo)
      let inner = 0;
      for (let y = NORTH; y < l.rows - 1; y++) for (let x = 1; x < l.cols - 1; x++) if (l.wall[y * l.cols + x]) inner++;
      expect(inner).toBeGreaterThan(20);
      // Determinista
      expect(JSON.stringify({ ...generateLayout({ ...SPEC, shape }, seed), masses: null })).toBe(JSON.stringify({ ...l, masses: null }));
    }
  });

  it('la T: la barra entera al norte y el tallo en el centro', () => {
    const l = generateLayout({ ...SPEC, shape: { kind: 'T' } }, 7);
    const w = (x: number, y: number) => l.wall[y * l.cols + x] !== WALL.none;
    expect(w(2, NORTH)).toBe(false);                                     // la barra
    expect(w(l.cols - 3, NORTH)).toBe(false);
    expect(w(2, l.rows - 3)).toBe(true);                                 // abajo a los lados, pared
    expect(w(l.cols - 3, l.rows - 3)).toBe(true);
    expect(w(l.cols >> 1, l.rows - 3)).toBe(false);                      // el tallo
  });

  it('el plano en texto: sus paredes, y las zonas sueltas se cierran', () => {
    const cols = 20, rows = 14;
    const rows_ = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => (x === 10 && y !== 8 ? '#' : y === 11 && x > 12 ? '#' : '.')).join(''));
    // Una isla cerrada: un cuadrado de pared con un hueco dentro (se cierra)
    const grid = rows_.map((r) => r.split(''));
    for (let y = 4; y <= 8; y++) for (let x = 13; x <= 17; x++) grid[y]![x] = y === 4 || y === 8 || x === 13 || x === 17 ? '#' : '.';
    const spec: GeneratorSpec = { ...SPEC, cols, rows, water: { ocean: false, lake: false, puddles: 1 }, pillars: 2, shape: { kind: 'plan', rows: grid.map((r) => r.join('')) } };
    const l = generateLayout(spec, 3);
    sane(l);
    expect(l.wall[5 * cols + 10]).not.toBe(WALL.none);                   // la pared del plano
    expect(l.wall[8 * cols + 10]).toBe(WALL.none);                       // su hueco
    expect(l.wall[6 * cols + 15]).not.toBe(WALL.none);                   // la isla, cerrada
    expect(() => generateLayout({ ...spec, shape: { kind: 'plan', rows: ['...'] } }, 3)).toThrow(/14 filas de 20/);
    expect(() => generateLayout({ ...SPEC, shape: { kind: 'estrella' } as never }, 3)).toThrow(/L, T, corridors, maze, plan/);
  });

  it('en una receta: las paredes siguen la forma (una loseta de grueso) y fuera queda el vacío', () => {
    const b = buildSampleRecipe({ theme: 'oficina', seed: 2, shape: { kind: 'T' } });
    const l = b.layout, my = (py: number) => b.world.depth - 1 - py;
    const cy = l.rows - 3, at = (cx: number) => [cx * TILE + 8, my(cy * TILE + 8)] as const;
    // El tallo: 11 losetas de ancho desde la 14 (interior de 38); la 13 es su pared y la 5, vacío (sin suelo ni pared)
    expect(l.wall[cy * l.cols + 13]).toBe(WALL.cap);
    expect(l.wall[cy * l.cols + 5]).toBe(WALL.outside);
    expect(b.state.solidAt(...at(13), 6)).toBe(true);
    expect(b.state.solidAt(...at(15), 6)).toBe(false);
    for (const z of [0, 6, 11]) expect(b.state.solidAt(...at(5), z)).toBe(false);
    expect(b.world.model.floorAt(...at(5))).toBeLessThanOrEqual(b.world.model.zMin);
    // En la L (esquina noreste quitada), sobre el vacío no hay fachada, ni sus luces
    const L = generateLayout({ ...THEMES.medieval.spec, shape: { kind: 'L' } }, 7);
    expect(L.facade[L.cols - 3]).toBe('');
    expect(L.facade[3]).not.toBe('');
    expect(L.sources.some((s) => s.id === `facade-${L.cols - 3}`)).toBe(false);
  });
});
