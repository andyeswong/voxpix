// Pisos (src/worldgen/floors.ts): cada piso tiene entrada al sur, una salida cerrada en otro lado, el punto de
// partida junto a la entrada y un hueco libre y alcanzable para la tienda. Determinista solo con sus argumentos.
import { describe, it, expect } from 'vitest';
import { floorLayout, openDoors, generateLayout, WALL, TILE, type GeneratorSpec, type ShapeSpec, type Layout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { dashBody, fits, restZ, type Body } from '../src/runtime/body';

const SPEC: GeneratorSpec = { ...THEMES.oficina.spec, cols: 24, rows: 18 };
const SHAPES: Array<ShapeSpec | undefined> = [undefined, { kind: 'L' }, { kind: 'T' }, { kind: 'corridors' }, { kind: 'maze' }];

function walk(l: Layout, x: number, y: number): boolean {
  const i = y * l.cols + x;
  return l.wall[i] === WALL.none && !l.pillar[i] && l.water[y]![x] !== '~';
}
function reach(l: Layout, from: { x: number; y: number }): Set<number> {
  const s = [Math.floor(from.y / TILE) * l.cols + Math.floor(from.x / TILE)], seen = new Set(s);
  while (s.length) {
    const c = s.pop()!, x = c % l.cols, y = (c / l.cols) | 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      const n = ny * l.cols + nx;
      if (nx < 0 || ny < 0 || nx >= l.cols || ny >= l.rows || seen.has(n) || !walk(l, nx, ny)) continue;
      seen.add(n); s.push(n);
    }
  }
  return seen;
}
const cell = (l: Layout, p: { x: number; y: number }) => Math.floor(p.y / TILE) * l.cols + Math.floor(p.x / TILE);

describe('pisos', () => {
  for (const shape of SHAPES) it(`${shape?.kind ?? 'rectángulo'}: 10 pisos con entrada, salida y tienda alcanzables`, () => {
    for (const seed of [1, 4]) for (let f = 0; f < 10; f++) {
      const p = floorLayout(SPEC, seed, f, shape);
      const l = p.layout;
      expect(p.entry).toBe('s');
      expect(p.exit.slot.side).not.toBe('s');
      expect(p.exit.slot.open).toBe(false);
      expect(p.spawn).toEqual(l.spawn);
      // La partida, cerca de la entrada (en la mitad sur)
      expect(p.spawn.y).toBeGreaterThan(l.rows * TILE / 2);
      const r = reach(l, p.spawn);
      expect(r.has(cell(l, p.shop))).toBe(true);
      expect(r.has(cell(l, p.exit))).toBe(true);
      // La tienda con sus 8 vecinas libres (salvo en salas en las que no cabe)
      const sx = Math.floor(p.shop.x / TILE), sy = Math.floor(p.shop.y / TILE);
      let clear = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!walk(l, sx + dx, sy + dy)) clear = false;
      if (shape?.kind !== 'maze') expect(clear).toBe(true);
      // Al abrir la salida, desde dentro se llega al borde
      openDoors(l, [p.exit.slot.side]);
      const out = reach(l, p.spawn);
      const s = p.exit.slot;
      const edge = s.side === 'n' ? s.from : s.side === 'e' ? s.from * l.cols + l.cols - 1 : s.from * l.cols;
      expect(out.has(edge)).toBe(true);
    }
  });

  it('determinista y distinto de piso en piso', () => {
    const a = floorLayout(SPEC, 9, 3, { kind: 'T' }), b = floorLayout(SPEC, 9, 3, { kind: 'T' });
    expect(Array.from(a.layout.wall)).toEqual(Array.from(b.layout.wall));
    expect([a.shop, a.exit.x, a.exit.y]).toEqual([b.shop, b.exit.x, b.exit.y]);
    const sigs = new Set(Array.from({ length: 10 }, (_, f) => floorLayout(SPEC, 9, f).layout.floor.join()));
    expect(sigs.size).toBe(10);
    const exits = new Set(Array.from({ length: 10 }, (_, f) => floorLayout(SPEC, 9, f).exit.slot.side));
    expect(exits.size).toBeGreaterThan(1);
  });

  it('sin spawnNear el generador no cambia', () => {
    const l = generateLayout({ ...SPEC, doors: {} }, 5);
    const n = generateLayout({ ...SPEC, doors: {}, spawnNear: undefined }, 5);
    expect(n.spawn).toEqual(l.spawn);
    expect(() => generateLayout({ ...SPEC, spawnNear: 's' }, 5)).toThrow(/doors/);
  });
});

describe('dashBody', () => {
  const p = floorLayout({ ...SPEC, pillars: 0, props: [] }, 2, 0);
  const { state } = buildWorldState(p.layout, THEMES.oficina.look);
  const H = p.layout.rows * TILE - 1;
  const body = (): Body => { const x = p.spawn.x, y = H - p.spawn.y; return { x, y, z: restZ(state, x, y, 4), r: 4 }; };

  it('en campo abierto recorre la distancia entera', () => {
    const b = body();
    const x0 = b.x, y0 = b.y;
    const r = dashBody(state, b, 0, 1, 24);
    expect(r.hit).toBe(false);
    expect(r.traveled).toBeCloseTo(24, 5);
    expect([b.x, b.y]).toEqual([x0, y0 + 24]);
  });

  it('contra la pared se para (sin atravesarla) y dice que chocó', () => {
    const b = body();
    const r = dashBody(state, b, 0, -1, 400);                              // hacia el sur, a la pared de la entrada
    expect(r.hit).toBe(true);
    expect(r.traveled).toBeLessThan(400);
    expect(fits(state, b.x, b.y, b.z, b.r)).toBe(true);
    expect(dashBody(state, b, 0, -1, 8).traveled).toBeLessThan(1);        // ya pegado: no avanza
  });

  it('en diagonal contra la pared desliza a lo largo de ella', () => {
    const b = body();
    dashBody(state, b, 0, -1, 400);
    const x0 = b.x;
    const r = dashBody(state, b, 1, -1, 20);
    expect(r.hit).toBe(true);
    expect(b.x - x0).toBeGreaterThan(10);
  });

  it('dirección nula o distancia 0: no se mueve', () => {
    const b = body();
    expect(dashBody(state, b, 0, 0, 30)).toMatchObject({ traveled: 0, hit: false });
    expect(dashBody(state, b, 1, 0, 0)).toMatchObject({ traveled: 0, hit: false });
  });
});
