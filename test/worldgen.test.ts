// Motor de escenario: el generador de mapas.
import { describe, expect, it } from 'vitest';
import { analyzeMasses, KIND_BY_ID } from '../src/terrain/regions';
import { generateLayout, NORTH, TILE, WALL, type Layout } from '../src/worldgen/generate';
import type { GeneratorSpec } from '../src/worldgen/spec';

// Dos temas de ejemplo (en el juego vivirán en el contenido de cada nivel): el motor solo ve datos
const MEDIEVAL: GeneratorSpec = {
  cols: 40, rows: 30,
  floors: [{ anim: 'piso', weight: 12 }, { anim: 'piso-gastado', weight: 3 }, { anim: 'piso-grieta', weight: 2 }, { anim: 'piso-hierba', weight: 2 }, { anim: 'piso-paja', weight: 1.5 }],
  caps: ['muro-almena', 'muro-tapa'],
  facade: {
    fill: [{ anim: 'muro-liso', weight: 4 }, { anim: 'muro-ventana-arco', weight: 3 }, { anim: 'muro-ventana-oscura', weight: 2 }, { anim: 'muro-tronera', weight: 2 }, { anim: 'muro-hiedra', weight: 1.5 }],
    neutral: 'muro-liso', door: 'muro-puerta', flank: 'muro-antorcha', banner: 'muro-estandarte', crest: 'muro-escudo',
    emits: { 'muro-antorcha': 'torch' },
  },
  water: { ocean: true, lake: true, puddles: 5 },
  pillars: 8, materials: 10,
};
const CYBERPUNK: GeneratorSpec = {
  cols: 40, rows: 30,
  floors: [{ anim: 'piso', weight: 12 }, { anim: 'piso-gastado', weight: 3 }, { anim: 'piso-raspon', weight: 2 }, { anim: 'piso-rejilla', weight: 1 }, { anim: 'piso-neon-rosa', weight: 0.4 }, { anim: 'piso-neon-cian', weight: 0.4 }],
  caps: ['muro-tapa', 'muro-tapa-aviso'],
  facade: {
    fill: [{ anim: 'muro-liso', weight: 3 }, { anim: 'muro-ventana', weight: 5 }, { anim: 'muro-ventana-calida', weight: 2 }, { anim: 'muro-ventana-cian', weight: 1.2 }, { anim: 'muro-ventana-rosa', weight: 1.2 }, { anim: 'muro-rejilla', weight: 1.4 }, { anim: 'muro-tuberia', weight: 1.1 }, { anim: 'muro-neon-rosa', weight: 1.2 }, { anim: 'muro-neon-cian', weight: 1.2 }],
    neutral: 'muro-liso', door: 'muro-puerta',
    emits: { 'muro-neon-rosa': 'neon-pink', 'muro-neon-cian': 'neon-cyan' },
  },
  water: { ocean: false, lake: true, puddles: 6 },
  pillars: 6, materials: 8,
};
// Oficina: sin lagos ni océano, con escritorios (muebles con pantalla que emite)
const OFFICE: GeneratorSpec = {
  ...CYBERPUNK,
  water: { ocean: false, lake: false, puddles: 4 },
  pillars: 3,
  props: [
    { anim: 'escritorio-pc', w: 2, h: 1, count: 3, emits: 'screen', edge: true },
    { anim: 'escritorio-laptop', w: 2, h: 1, count: 2, emits: 'screen', edge: true },
    { anim: 'escritorio-pc', w: 2, h: 1, count: 1, emits: 'screen' },
  ],
};
const THEMES = { medieval: MEDIEVAL, cyberpunk: CYBERPUNK, oficina: OFFICE } as const;

const at = (l: Layout, x: number, y: number) => y * l.cols + x;
const kinds = (l: Layout) => {
  const seen: Record<string, number> = { puddle: 0, lake: 0, ocean: 0 };
  l.masses.regionSizes.forEach((_, i) => { const k = KIND_BY_ID[l.masses.kind[l.masses.region.indexOf(i)]!]!; seen[k] = (seen[k] ?? 0) + 1; });
  return seen;
};

describe('generador de mapas por semilla', () => {
  it('la misma semilla y el mismo tema dan el mismo mundo; otra semilla, otro', () => {
    const a = generateLayout(MEDIEVAL, 7), b = generateLayout(MEDIEVAL, 7), c = generateLayout(MEDIEVAL, 8);
    expect(a.water).toEqual(b.water);
    expect(a.facade).toEqual(b.facade);
    expect(a.floor).toEqual(b.floor);
    expect(a.sources).toEqual(b.sources);
    expect(a.materials).toEqual(b.materials);
    expect(a.water).not.toEqual(c.water);
    expect(a.floor).not.toEqual(c.floor);
  });

  for (const [name, spec] of Object.entries(THEMES)) {
    describe(`tema ${name}`, () => {
      const layouts = Array.from({ length: 30 }, (_, i) => generateLayout(spec, i + 1));

      it('cada semilla trae lo que el tema pide: océano, lago y charcos', () => {
        const missing: string[] = [];
        layouts.forEach((l, i) => {
          const k = kinds(l);
          if ((spec.water.ocean && !k.ocean) || (spec.water.lake && !k.lake) || (spec.water.puddles > 0 && !k.puddle)) missing.push(`semilla ${i + 1}: ${JSON.stringify(k)}`);
          if (!spec.water.ocean && k.ocean) missing.push(`semilla ${i + 1}: salió un océano que el tema no pide`);
        });
        expect(missing).toEqual([]);
      });

      it('el agua nunca toca las paredes, se sale en tierra firme y las columnas no pisan agua', () => {
        for (const l of layouts) {
          const solid = (x: number, y: number) => l.wall[at(l, x, y)] !== WALL.none;
          for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) {
            const wet = l.water[y]![x] === '~';
            expect(wet && solid(x, y), `semilla ${l.seed}: agua en una pared (${x},${y})`).toBe(false);
            expect(l.pillar[at(l, x, y)] === 1 && (wet || solid(x, y)), `semilla ${l.seed}: columna mal puesta (${x},${y})`).toBe(false);
          }
          for (let x = 1; x < l.cols - 1; x++) for (let y = NORTH; y < NORTH + 2; y++) expect(l.water[y]![x], `semilla ${l.seed}: agua pegada a la pared norte`).toBe('.');
          const sx = Math.floor(l.spawn.x / TILE), sy = Math.floor((l.spawn.y - 2) / TILE);
          expect(l.water[sy]![sx], `semilla ${l.seed}: sale en el agua`).toBe('.');
          expect(l.wall[at(l, sx, sy)]).toBe(WALL.none);
        }
      });

      it('todo sale del tema: suelos, fachada, tapas y número de columnas y materiales', () => {
        const floors = new Set(spec.floors.map((p) => p.anim));
        const f = spec.facade;
        const allowed = new Set([...f.fill.map((p) => p.anim), f.neutral, f.door, ...(f.flank ? [f.flank] : []), ...(f.banner ? [f.banner] : []), ...(f.crest ? [f.crest] : [])]);
        for (const l of layouts) {
          expect(l.caps).toEqual(spec.caps);
          l.floor.forEach((a, i) => { if (l.wall[i] === WALL.none) expect(floors.has(a), `suelo ${a}`).toBe(true); else expect(a).toBe(''); });
          for (let x = 1; x < l.cols - 1; x++) expect(allowed.has(l.facade[x]!), `fachada ${l.facade[x]}`).toBe(true);
          expect(l.facade.filter((p) => p === f.door)).toHaveLength(2);
          const pillars = l.pillar.reduce((a, b, i) => a + (b && !l.prop[i] ? 1 : 0), 0);   // los muebles también son sólidos
          expect(pillars).toBeGreaterThanOrEqual(1);
          expect(pillars).toBeLessThanOrEqual(spec.pillars);
          expect(l.materials.length).toBeGreaterThan(0);
          expect(l.materials.length).toBeLessThanOrEqual(spec.materials);
          for (const m of l.materials) expect(l.water[Math.floor(m.y / TILE)]![Math.floor(m.x / TILE)]).toBe('.');
        }
      });

      it('las fuentes de luz son exactamente las piezas de fachada que emiten, con ids únicos', () => {
        for (const l of layouts) {
          const expected = Array.from({ length: l.cols }, (_, x) => x).filter((x) => x > 0 && x < l.cols - 1 && spec.facade.emits[l.facade[x]!]);
          const facadeSources = l.sources.filter((s) => s.id.startsWith('facade-'));
          expect(facadeSources.map((s) => s.id)).toEqual(expected.map((x) => `facade-${x}`));
          expect(new Set(l.sources.map((s) => s.id)).size).toBe(l.sources.length);
          facadeSources.forEach((s, i) => {
            expect(s.kind).toBe(spec.facade.emits[l.facade[expected[i]!]!]);
            expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(l.cols * TILE);
          });
        }
        expect(layouts.filter((l) => l.sources.length > 0).length).toBeGreaterThan(20);   // casi todas las semillas tienen alguna fuente
      });
    });
  }

  // La arena de un nivel puede ser de cualquier tamaño (la del juego es de 512x512, o sea 32x32 tiles).
  // Con posiciones fijas pensadas para 40 columnas, una puerta caía fuera de la pared en las arenas más estrechas.
  for (const [cols, rows] of [[32, 32], [40, 30], [48, 36]] as const) {
    it(`en una arena de ${cols}x${rows} todo cae dentro y cada nivel tiene sus dos puertas`, () => {
      for (const [name, base] of Object.entries(THEMES)) {
        const spec = { ...base, cols, rows };
        for (let seed = 1; seed <= 30; seed++) {
          const l = generateLayout(spec, seed);
          const doors = l.facade.map((p, x) => (p === spec.facade.door ? x : -1)).filter((x) => x >= 0);
          expect(doors, `${name} ${cols}x${rows} semilla ${seed}`).toHaveLength(2);
          for (const x of doors) { expect(x).toBeGreaterThanOrEqual(2); expect(x).toBeLessThanOrEqual(cols - 3); }
          for (const s of l.sources) { expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(cols * TILE); }
          for (const m of l.materials) { expect(m.x).toBeLessThan(cols * TILE); expect(m.y).toBeLessThan(rows * TILE); }
          const sx = Math.floor(l.spawn.x / TILE), sy = Math.floor((l.spawn.y - 2) / TILE);
          expect(l.water[sy]![sx], `${name} ${cols}x${rows} semilla ${seed}: sale en el agua`).toBe('.');
          expect(l.water).toHaveLength(rows);
          const k = kinds(l);
          if (spec.water.ocean) expect(k.ocean, `${name} ${cols}x${rows} semilla ${seed}: sin océano`).toBeGreaterThan(0);
          if (spec.water.puddles > 0) expect(k.puddle, `${name} ${cols}x${rows} semilla ${seed}: sin charco`).toBeGreaterThan(0);
        }
      }
    });
  }

  // Una L o una raya de tres charcos se lee como una tubería: los charcos son 1 celda, 2 pegadas o un 2x2
  it('todos los charcos tienen forma de charco (1 celda, 2 pegadas o un 2x2), nunca una L ni una raya', () => {
    for (const [name, base] of Object.entries(THEMES)) for (const [cols, rows] of [[32, 32], [40, 30]] as const) for (let seed = 1; seed <= 40; seed++) {
      const l = generateLayout({ ...base, cols, rows }, seed);
      l.masses.regionSizes.forEach((size, id) => {
        if (size > 4) return;
        const cells: Array<[number, number]> = [];
        for (let i = 0; i < l.masses.region.length; i++) if (l.masses.region[i] === id) cells.push([i % cols, Math.floor(i / cols)]);
        const w = Math.max(...cells.map((c) => c[0])) - Math.min(...cells.map((c) => c[0])) + 1;
        const h = Math.max(...cells.map((c) => c[1])) - Math.min(...cells.map((c) => c[1])) + 1;
        const ok = size <= 2 || (size === 4 && w === 2 && h === 2);
        expect(ok, `${name} ${cols}x${rows} semilla ${seed}: charco de ${size} celdas en ${w}x${h}`).toBe(true);
      });
    }
  });

  it('hay espacio libre para pelear: todo lo caminable se alcanza desde la salida y es la mayor parte de la arena', () => {
    // el agua es decorado, así que solo paredes y columnas estorban
    for (const [name, spec] of Object.entries(THEMES)) for (let seed = 1; seed <= 60; seed++) {
      const l = generateLayout(spec, seed);
      const free = (x: number, y: number) => x >= 0 && y >= 0 && x < l.cols && y < l.rows && l.wall[at(l, x, y)] === WALL.none && l.pillar[at(l, x, y)] === 0;
      let total = 0;
      for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) if (free(x, y)) total++;
      const seen = new Set<number>();
      const queue = [at(l, Math.floor(l.spawn.x / TILE), Math.floor((l.spawn.y - 2) / TILE))];
      while (queue.length) {
        const c = queue.pop()!;
        if (seen.has(c)) continue;
        const x = c % l.cols, y = Math.floor(c / l.cols);
        if (!free(x, y)) continue;
        seen.add(c);
        queue.push(c + 1, c - 1, c + l.cols, c - l.cols);
      }
      expect(seen.size, `${name} semilla ${seed}: hay suelo inalcanzable`).toBe(total);
      expect(total / ((l.cols - 2) * (l.rows - 3)), `${name} semilla ${seed}: demasiado ocupado`).toBeGreaterThan(0.85);
    }
  });

  // Parámetros de aparición de la oficina (src/content/levels/oficina/module.ts), en píxeles
  const SPAWN = { minDistance: 52, edgeMargin: 10, ringRadius: 96, fightRadius: 48 };
  for (const [cols, rows] of [[32, 32], [40, 30]] as const) {
    it(`en ${cols}x${rows} hay hueco para pelear y sitio para que salgan enemigos (60 semillas por tema)`, () => {
      for (const [name, base] of Object.entries(THEMES)) for (let seed = 1; seed <= 60; seed++) {
        const l = generateLayout({ ...base, cols, rows }, seed);
        const blocked = (x: number, y: number) => x < 0 || y < 0 || x >= l.cols || y >= l.rows || l.wall[at(l, x, y)] !== WALL.none || l.pillar[at(l, x, y)] === 1;
        // distancia de un punto al rectángulo de una celda
        const gap = (px: number, py: number, cx: number, cy: number) => Math.hypot(Math.max(cx * TILE - px, 0, px - (cx + 1) * TILE), Math.max(cy * TILE - py, 0, py - (cy + 1) * TILE));
        const cells: [number, number][] = [];
        for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) if (blocked(x, y)) cells.push([x, y]);
        const { x: sx, y: sy } = l.spawn;
        const who = `${name} ${cols}x${rows} semilla ${seed}`;

        // (a) ninguna celda ocupada toca el círculo de pelea alrededor de la salida
        const nearest = Math.min(...cells.map(([x, y]) => gap(sx, sy, x, y)));
        expect(nearest, `${who}: el hueco libre alrededor de la salida es de ${nearest.toFixed(1)} px`).toBeGreaterThanOrEqual(SPAWN.fightRadius);

        // (b1) al menos la mitad de lo caminable está lejos de la salida y de cualquier pared o columna
        let walkable = 0, good = 0;
        for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) {
          if (blocked(x, y)) continue;
          walkable++;
          const px = x * TILE + TILE / 2, py = y * TILE + TILE / 2;
          if (Math.hypot(px - sx, py - sy) < SPAWN.minDistance) continue;
          if (cells.some(([bx, by]) => gap(px, py, bx, by) < SPAWN.edgeMargin + TILE)) continue;
          good++;
        }
        expect(good / walkable, `${who}: solo ${good} de ${walkable} celdas sirven para que salga un enemigo`).toBeGreaterThanOrEqual(0.5);

        // (b2) al menos la mitad del anillo de aparición es caminable
        const N = 72;
        let open = 0;
        for (let i = 0; i < N; i++) {
          const a = (i / N) * Math.PI * 2;
          if (!blocked(Math.floor((sx + Math.cos(a) * SPAWN.ringRadius) / TILE), Math.floor((sy + Math.sin(a) * SPAWN.ringRadius) / TILE))) open++;
        }
        expect(open / N, `${who}: el anillo de aparición es caminable en ${(open / N * 100).toFixed(0)} %`).toBeGreaterThanOrEqual(0.5);
      }
    });
  }

  it('los muebles salen enteros sobre tierra, sin pisarse ni tocarse, sin tapar la salida, y su pantalla es una fuente', () => {
    for (const [cols, rows] of [[32, 32], [40, 30]] as const) for (let seed = 1; seed <= 60; seed++) {
      const l = generateLayout({ ...OFFICE, cols, rows }, seed);
      const who = `${cols}x${rows} semilla ${seed}`;
      expect(l.props.length, `${who}: faltan muebles`).toBe(6);
      const taken = new Set<number>();
      for (const p of l.props) for (let dy = -1; dy <= p.h; dy++) for (let dx = -1; dx <= p.w; dx++) {
        const inside = dx >= 0 && dx < p.w && dy >= 0 && dy < p.h;
        const c = at(l, p.x + dx, p.y + dy);
        if (inside) {
          expect(l.water[p.y + dy]![p.x + dx], `${who}: mueble sobre agua`).toBe('.');
          expect(l.wall[c], `${who}: mueble en una pared`).toBe(WALL.none);
          expect(l.pillar[c] === 1 && l.prop[c] === 1, `${who}: la huella no es sólida`).toBe(true);
          expect(taken.has(c), `${who}: dos muebles se pisan`).toBe(false);
          taken.add(c);
        }
      }
      // sin hueco de una celda entre muebles distintos
      for (const a of l.props) for (const b of l.props) if (a !== b) {
        const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
        expect(Math.max(gapX, gapY), `${who}: muebles pegados`).toBeGreaterThanOrEqual(1);
      }
      const screens = l.sources.filter((s) => s.id.startsWith('prop-'));
      expect(screens.length).toBe(l.props.length);
      expect(screens.every((s) => s.kind === 'screen')).toBe(true);
      expect(new Set(l.sources.map((s) => s.id)).size).toBe(l.sources.length);
    }
  });

  it('un tema sin agua no genera agua', () => {
    const dry = { ...MEDIEVAL, water: { ocean: false, lake: false, puddles: 0 } };
    for (let seed = 1; seed <= 10; seed++) expect(generateLayout(dry, seed).water.join('')).not.toContain('~');
  });

  it('el mapa de agua cumple el contrato del nivel: filas de "~" y ".", una por tile, y las masas coinciden', () => {
    for (const [, spec] of Object.entries(THEMES)) {
      const l = generateLayout(spec, 11);
      expect(l.water).toHaveLength(spec.rows);
      for (const row of l.water) { expect(row).toHaveLength(spec.cols); expect(row).toMatch(/^[~.]+$/); }
      const again = analyzeMasses(spec.cols, spec.rows, (x, y) => l.water[y]![x] === '~', { edgeIsMember: false });
      expect(Array.from(again.kind)).toEqual(Array.from(l.masses.kind));
      expect(Array.from(again.depth)).toEqual(Array.from(l.masses.depth));
    }
  });

  it('el mapa cabe en una arena de cols*16 x rows*16', () => {
    const l = generateLayout(MEDIEVAL, 3);
    expect(l.cols * TILE).toBe(640);
    expect(l.rows * TILE).toBe(480);
    for (const m of l.materials) { expect(m.x).toBeLessThan(640); expect(m.y).toBeLessThan(480); }
  });
});

// El azar del motor sale de sim/rng.ts: el generador no puede usar azar sin semilla ni el reloj, y su parte
// pura no importa la vista
describe('worldgen: arquitectura', () => {
  const sources = import.meta.glob('../src/worldgen/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const ALLOWED = ['./spec', './generate', '../lighting/lights', '../sim/rng', '../terrain/regions'];
  it('solo importa de lo permitido', () => {
    expect(Object.keys(sources).length).toBeGreaterThanOrEqual(3);
    for (const [k, src] of Object.entries(sources)) for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(ALLOWED, `${k} importa ${m[1]}`).toContain(m[1]);
  });
  it('ningún archivo usa azar sin semilla ni el reloj', () => {
    for (const [k, src] of Object.entries(sources)) expect(src, k).not.toMatch(/Math\.random|Date\.now|performance\.now/);
  });
});
