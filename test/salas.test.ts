// Salas que se unen (src/worldgen/rooms.ts): cada sala trae cuatro huecos de puerta cerrados, en el centro de cada lado;
// al unirlas en una rejilla se abren solo los que dan a otra sala, y todo el mapa queda conectado de puerta a puerta.
import { describe, it, expect } from 'vitest';
import { generateLayout, openDoors, stitchRooms, WALL, NORTH, TILE, type GeneratorSpec, type Layout, type ShapeSpec } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildSampleRecipe } from '../src/samples/recipes';

const SPEC: GeneratorSpec = { ...THEMES.medieval.spec, cols: 24, rows: 18, doors: {} };
const free = (l: Layout, x: number, y: number) => l.wall[y * l.cols + x] === WALL.none;

function reach(l: Layout, from: [number, number]): Set<number> {
  const seen = new Set([from[1] * l.cols + from[0]]), q = [from[1] * l.cols + from[0]];
  while (q.length) {
    const c = q.pop()!, x = c % l.cols;
    for (const n of [x > 0 ? c - 1 : -1, x < l.cols - 1 ? c + 1 : -1, c - l.cols, c + l.cols]) {
      if (n < 0 || n >= l.wall.length || l.wall[n] !== WALL.none || seen.has(n)) continue;
      seen.add(n); q.push(n);
    }
  }
  return seen;
}

const SHAPES: Array<ShapeSpec | undefined> = [undefined, { kind: 'L' }, { kind: 'T' }, { kind: 'maze' }, { kind: 'corridors' }, { kind: 'L', corner: 'sw', size: 0.6 }];

describe('salas con puertas', () => {
  for (const shape of SHAPES) it(`${shape?.kind ?? 'rectángulo'}: cuatro huecos cerrados, que llegan al suelo de la sala`, () => {
    for (const seed of [1, 5, 9]) {
      const l = generateLayout({ ...SPEC, shape }, seed);
      expect(l.doors!.map((d) => d.side)).toEqual(['n', 's', 'e', 'w']);
      expect(l.doors!.every((d) => !d.open && d.to - d.from === 2)).toBe(true);
      // Cerrados: el borde sigue siendo pared
      const w = l.doors!.find((d) => d.side === 'w')!;
      expect(free(l, 0, w.from)).toBe(false);
      // Abiertos, cada hueco lleva al resto de la sala
      openDoors(l, ['n', 's', 'e', 'w']);
      const all = reach(l, [0, w.from]);
      const n = l.doors!.find((d) => d.side === 'n')!, s = l.doors!.find((d) => d.side === 's')!, e = l.doors!.find((d) => d.side === 'e')!;
      expect(all.has(0 * l.cols + n.from)).toBe(true);
      expect(all.has((l.rows - 1) * l.cols + s.from)).toBe(true);
      expect(all.has(e.from * l.cols + l.cols - 1)).toBe(true);
      // Sobre la puerta norte no hay fachada ni luz
      for (let x = n.from; x <= n.to; x++) { expect(l.facade[x]).toBe(''); expect(l.sources.some((q) => q.id === `facade-${x}`)).toBe(false); }
    }
  });

  it('sin doors, el generador no cambia (y sin huecos)', () => {
    const { doors: _d, ...plain } = SPEC;
    void _d;
    expect(generateLayout(plain, 7).doors).toBeUndefined();
  });

  it('stitchRooms: abre solo las puertas entre vecinas, y todo queda conectado', () => {
    const placed = [[0, 0], [1, 0], [1, 1], [2, 1]] as const;
    const blocks = placed.map(([gx, gy], k) => ({ gx, gy, layout: generateLayout({ ...SPEC, shape: SHAPES[k + 1] }, 3 + k) }));
    const m = stitchRooms(blocks);
    expect([m.cols, m.rows]).toEqual([72, 36]);
    const open = m.doors!.filter((d) => d.open).map((d) => `${(d as { block: number }).block}${d.side}`).sort();
    expect(open).toEqual(['0e', '1s', '1w', '2e', '2n', '3w']);
    // Donde no hay sala (la esquina de abajo a la izquierda) es el vacío
    expect(m.wall[(18 + 5) * m.cols + 5]).toBe(WALL.outside);
    // Desde la salida se llega a las cuatro salas
    const sx = Math.floor(m.spawn.x / TILE), sy = Math.floor(m.spawn.y / TILE);
    const r = reach(m, [sx, sy]);
    for (const b of m.blocks!) {
      let hit = false;
      for (let y = b.y0; y < b.y0 + 18 && !hit; y++) for (let x = b.x0; x < b.x0 + 24 && !hit; x++) if (r.has(y * m.cols + x)) hit = true;
      expect(hit, `sala ${b.gx},${b.gy}`).toBe(true);
    }
    // Nada dentro de una pared ni del vacío
    for (let i = 0; i < m.wall.length; i++) if (m.wall[i]) { expect(m.pillar[i]).toBe(0); expect(m.water[Math.floor(i / m.cols)]![i % m.cols]).toBe('.'); }
    // La fachada decorada es la de la fila de arriba
    expect(m.facade.slice(0, 48).some((f) => f)).toBe(true);
    expect(() => stitchRooms([{ gx: 0, gy: 0, layout: blocks[0]!.layout }, { gx: 0, gy: 0, layout: blocks[1]!.layout }])).toThrow(/dos salas/);
    expect(() => stitchRooms([{ gx: 0, gy: 0, layout: generateLayout({ ...SPEC, cols: 20 }, 1) }, { gx: 1, gy: 0, layout: blocks[1]!.layout }])).toThrow(/miden lo mismo/);
  });

  it('en una receta: rooms construye el mapa entero, determinista', () => {
    const r = { theme: 'oficina' as const, seed: 4, size: [24, 18] as const, rooms: [{ gx: 0, gy: 0, shape: { kind: 'T' as const } }, { gx: 1, gy: 0 }, { gx: 1, gy: 1, shape: { kind: 'maze' as const } }] };
    const a = buildSampleRecipe(r), b = buildSampleRecipe(JSON.parse(JSON.stringify(a.recipe)));
    expect(a.state.hash()).toBe(b.state.hash());
    expect([a.world.width, a.world.depth]).toEqual([48 * TILE, 36 * TILE]);
    // La puerta entre la sala 0 y la 1 es suelo de verdad (se puede cruzar)
    const d = a.layout.doors!.find((x) => x.open && x.side === 'e')!;
    const my = (py: number) => a.world.depth - 1 - py;
    expect(a.state.solidAt(23 * TILE + 8, my((d.from + 1) * TILE + 8), 6)).toBe(false);
    expect(a.state.solidAt(24 * TILE + 8, my((d.from + 1) * TILE + 8), 6)).toBe(false);
    void NORTH;
  });
});
