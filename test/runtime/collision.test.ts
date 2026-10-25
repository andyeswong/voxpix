import { describe, it, expect } from 'vitest';
import { material } from '../../src/core';
import { StaticVoxels, WorldState } from '../../src/world/state';
import { buildWorldState, type WorldTheme } from '../../src/world/build';
import { generateLayout, WALL, TILE, type Layout } from '../../src/worldgen';
import { THEMES } from '../../src/content/themes';
import { fits, footprint, moveBody, restZ, type Body } from '../../src/runtime/body';

// La colisión del runtime sobre el estado del mundo: lo que el worldgen dice que es pared, columna o mueble no se
// pisa; un cuerpo nunca acaba dentro de un sólido ni en agua honda; resbala por las paredes; los disparos dan en
// las columnas.

// Las pruebas que recorren mapas enteros tardan más que los 5 s por defecto en máquinas lentas (oficina)
const SLOW = 30_000;

const THEME_IDS: WorldTheme[] = ['medieval', 'cyberpunk', 'oficina'];
const SEEDS = [1, 2, 3, 7];

function level(theme: WorldTheme, seed: number) {
  const layout = generateLayout(THEMES[theme].spec, seed);
  return { layout, ...buildWorldState(layout, theme) };
}

// Centro de un tile del worldgen (filas con y hacia abajo) en ejes del modelo
function tileCenter(layout: Layout, tx: number, ty: number): [number, number] {
  return [tx * TILE + TILE / 2, layout.rows * TILE - 1 - (ty * TILE + TILE / 2)];
}

function spawnBody(layout: Layout, state: WorldState, r: number): Body {
  const x = layout.spawn.x, y = layout.rows * TILE - 1 - layout.spawn.y;
  return { x, y, z: restZ(state, x, y, r), r };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('colisión del runtime contra el worldgen', () => {
  it.each(THEME_IDS.flatMap((t) => SEEDS.map((s) => [t, s] as const)))('%s, semilla %i: paredes, columnas y muebles no se pisan; el suelo libre sí', (theme, seed) => {
    const { layout, state, world } = level(theme, seed);
    const floorZ = restZ(state, ...tileCenter(layout, Math.floor(layout.spawn.x / TILE), Math.floor(layout.spawn.y / TILE)), 1);
    const f = world.fountain;
    let walls = 0, pillars = 0, free = 0;
    for (let ty = 0; ty < layout.rows; ty++) for (let tx = 0; tx < layout.cols; tx++) {
      const i = ty * layout.cols + tx;
      const [x, y] = tileCenter(layout, tx, ty);
      if (layout.wall[i] !== WALL.none) {
        expect(fits(state, x, y, floorZ, 3), `pared en el tile ${tx},${ty}`).toBe(false);
        walls++;
      } else if (layout.pillar[i]) {
        expect(fits(state, x, y, floorZ, 3), `columna o mueble en el tile ${tx},${ty}`).toBe(false);
        pillars++;
      } else if (layout.water[ty]![tx] !== '~' && !(f && Math.hypot(x - f.x, y - f.y) < f.radius + f.rim + TILE)) {
        expect(fits(state, x, y, floorZ, 3), `suelo libre en el tile ${tx},${ty}`).toBe(true);
        free++;
      }
    }
    expect(walls).toBeGreaterThan(0);
    expect(pillars).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(50);
  }, SLOW);

  it.each(THEME_IDS.flatMap((t) => SEEDS.map((s) => [t, s] as const)))('%s, semilla %i: andando al azar, nunca dentro de un sólido ni en agua honda', (theme, seed) => {
    const { layout, state } = level(theme, seed);
    const body = spawnBody(layout, state, 4);
    expect(fits(state, body.x, body.y, body.z, body.r)).toBe(true);
    const rand = rng(seed * 7919 + 13);
    let dx = 0, dy = 0, blocked = 0, travelled = 0;
    for (let tick = 0; tick < 3000; tick++) {
      if (tick % 40 === 0) {
        const a = rand() * Math.PI * 2;
        dx = Math.cos(a) * 1.2; dy = Math.sin(a) * 1.2;
      }
      const x0 = body.x, y0 = body.y;
      if (moveBody(state, body, dx, dy)) blocked++;
      travelled += Math.hypot(body.x - x0, body.y - y0);
      // Ninguna columna que pisa es un sólido por encima de sus pies, ni agua más honda que el límite
      for (const [cx, cy] of footprint(body.x, body.y, body.r)) {
        expect(state.solidAt(cx + 0.5, cy + 0.5, body.z), `pies dentro de un sólido en ${cx},${cy} (tick ${tick})`).toBe(false);
        expect(state.waterAt(cx + 0.5, cy + 0.5)?.depth ?? 0, `agua honda en ${cx},${cy} (tick ${tick})`).toBeLessThanOrEqual(4.5);
      }
      expect(body.z).toBe(restZ(state, body.x, body.y, body.r));
    }
    expect(travelled, 'el cuerpo tiene que moverse de verdad').toBeGreaterThan(1500);
    expect(blocked, 'y chocar con algo, o la prueba no prueba nada').toBeGreaterThan(0);
  }, SLOW);
});

describe('agua honda', () => {
  it('medieval: andando hacia el agua más honda, se para en la orilla (en todos los mapas que la tienen)', () => {
    let tested = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { state } = level('medieval', seed);
      // La celda de agua más honda y el punto de tierra pisable más cercano a ella
      let deep: [number, number] | null = null, depth = 0;
      for (let y = 0; y < state.depth; y += 2) for (let x = 0; x < state.width; x += 2) {
        const d = state.waterAt(x + 0.5, y + 0.5)?.depth ?? 0;
        if (d > depth) { depth = d; deep = [x + 0.5, y + 0.5]; }
      }
      if (!deep || depth <= 4.5) continue;             // sin agua honda en este mapa: nada que probar
      let start: [number, number] | null = null, best = Infinity;
      for (let y = 0; y < state.depth; y += 2) for (let x = 0; x < state.width; x += 2) {
        const z = restZ(state, x, y, 3);
        if (!fits(state, x, y, z, 3) || state.waterAt(x, y)) continue;
        const d = Math.hypot(x - deep[0], y - deep[1]);
        if (d < best) { best = d; start = [x, y]; }
      }
      expect(start).not.toBeNull();
      const body: Body = { x: start![0], y: start![1], z: restZ(state, start![0], start![1], 3), r: 3 };
      const len = Math.hypot(deep[0] - body.x, deep[1] - body.y);
      for (let i = 0; i < 200; i++) moveBody(state, body, (deep[0] - start![0]) / len, (deep[1] - start![1]) / len);
      for (const [cx, cy] of footprint(body.x, body.y, body.r)) expect(state.waterAt(cx + 0.5, cy + 0.5)?.depth ?? 0).toBeLessThanOrEqual(4.5);
      expect(Math.hypot(deep[0] - body.x, deep[1] - body.y)).toBeGreaterThan(body.r);
      tested++;
    }
    expect(tested, 'ningún mapa tenía agua honda: la prueba no prueba nada').toBeGreaterThan(0);
  }, SLOW);
});

describe('colisión en una sala de prueba', () => {
  // Suelo de 60x40 (cara de arriba en z = 1), pared al norte (y >= 30) y una columna de 4x4
  function room(): WorldState {
    const s = new StaticVoxels({ ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060'] }] }, 60, 40, -4, 20);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 60; x++) s.set(x, y, 0, material(0, 1));
    for (let y = 30; y < 40; y++) for (let x = 0; x < 60; x++) for (let z = 1; z <= 10; z++) s.set(x, y, z, material(0, 2));
    for (let y = 10; y < 14; y++) for (let x = 40; x < 44; x++) for (let z = 1; z <= 12; z++) s.set(x, y, z, material(0, 2));
    return new WorldState(s, [], null);
  }

  it('empujando en diagonal contra la pared norte, resbala hacia el este', () => {
    const w = room();
    const body: Body = { x: 10, y: 24, z: 1, r: 4 };
    for (let i = 0; i < 30; i++) moveBody(w, body, 1, 1);
    expect(body.y + body.r).toBeLessThanOrEqual(30);
    expect(body.y + body.r).toBeGreaterThan(29);       // pegado a la pared, no frenado antes
    expect(body.x).toBeCloseTo(40, 5);                 // el eje x no lo frena nadie
  });

  it('un paso grande no atraviesa una columna: se queda delante, aunque detrás haya sitio', () => {
    const w = room();
    const body: Body = { x: 30, y: 12, z: 1, r: 2 };
    moveBody(w, body, 20, 0);                          // x = 50 estaría libre, al otro lado
    expect(body.x + body.r).toBeLessThanOrEqual(40);
    expect(body.x + body.r).toBeGreaterThan(39);
  });

  it('andando en diagonal contra una columna redonda, la rodea en vez de quedarse clavado', () => {
    const s = new StaticVoxels({ ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060']}] }, 60, 60, -4, 20);
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) s.set(x, y, 0, material(0, 1));
    // Columna redonda de radio 7 centrada en (30, 30), como las del medieval
    for (let y = 22; y <= 38; y++) for (let x = 22; x <= 38; x++) if (Math.hypot(x + 0.5 - 30, y + 0.5 - 30) < 7) for (let z = 1; z <= 12; z++) s.set(x, y, z, material(0, 2));
    const w = new WorldState(s, [], null);
    // Desde el suroeste, apuntando un poco a un lado del centro: sin el desvío se clava contra la curva
    for (const [x0, y0] of [[18, 16], [16, 18], [20, 17]] as const) {
      const body: Body = { x: x0, y: y0, z: 1, r: 4 };
      for (let i = 0; i < 80; i++) moveBody(w, body, Math.SQRT1_2, Math.SQRT1_2);
      expect(body.x + body.y, `desde (${x0}, ${y0}) llegó a (${body.x.toFixed(1)}, ${body.y.toFixed(1)})`).toBeGreaterThan(80);
      expect(fits(w, body.x, body.y, body.z, body.r)).toBe(true);
    }
  });

  it('raycast: un disparo desde el suelo libre da en la columna, en su cara', () => {
    const w = room();
    const hit = w.raycast([20, 12, 4], [55, 12, 4]);
    expect(hit).not.toBeNull();
    expect(hit!.hit[0]).toBeCloseTo(40, 5);
    expect(hit!.normal).toEqual([-1, 0, 0]);
  });
});
