import { describe, it, expect } from 'vitest';
import { material } from '../../src/core';
import { StaticVoxels, WorldState } from '../../src/world/state';
import { buildWorldState } from '../../src/world/build';
import { generateLayout, floorLayout } from '../../src/worldgen';
import { THEMES } from '../../src/samples/themes';
import { footprint, moveBody, restZ, type Body, type MoveRules, DEFAULT_RULES } from '../../src/runtime/body';

// moveBody y standable piden el suelo con una sola consulta por celda (footing: hasColumn + climbableAt + groundAt) y
// el agua sin crear objeto (waterDepthAt). Esto comprueba que dan lo mismo que las consultas sueltas de siempre, en
// mundos que tienen lo que cada una mira: arbustos que no se suben, agua honda y objetos despiertos.

const SLOW = 60_000;

// standable como era: las cuatro consultas sueltas
function refStandable(w: WorldState, xi: number, yi: number, feetZ: number, step: number, maxWater: number): boolean {
  if (!w.solid.hasColumn(xi, yi) || !w.solid.climbableAt(xi, yi)) return false;
  if (w.groundAt(xi, yi) - feetZ > step) return false;
  const wt = w.waterAt(xi, yi);
  return !(wt && wt.depth > maxWater);
}

// moveBody como era (58e055f, antes de la pasada única): fits + restZ celda a celda con las consultas sueltas
function refMove(w: WorldState, body: Body, dx: number, dy: number, rules: MoveRules = DEFAULT_RULES): boolean {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.5));
  let blocked = false;
  const go = (nx: number, ny: number) => {
    for (const [cx, cy] of footprint(nx, ny, body.r)) if (!refStandable(w, cx, cy, body.z, rules.step, rules.maxWater)) return false;
    body.x = nx; body.y = ny; body.z = restZ(w, nx, ny, body.r);
    return true;
  };
  for (let i = 0; i < n; i++) {
    let moved = false;
    for (const axis of ['x', 'y'] as const) {
      const d = (axis === 'x' ? dx : dy) / n;
      if (d === 0) continue;
      if (go(axis === 'x' ? body.x + d : body.x, axis === 'y' ? body.y + d : body.y)) { moved = true; continue; }
      blocked = true;
    }
    if (moved) continue;
    deflect: for (const axis of ['x', 'y'] as const) {
      const d = (axis === 'x' ? dx : dy) / n;
      if (d === 0) continue;
      const other = axis === 'x' ? dy : dx;
      const signs = other > 0 ? [-1, 1] : other < 0 ? [1, -1] : [-1, 1];
      for (const k of [1, 2]) for (const s of signs) {
        const side = s * k * Math.abs(d);
        if (go(axis === 'x' ? body.x + d : body.x + side, axis === 'y' ? body.y + d : body.y + side)) break deflect;
      }
    }
  }
  return blocked;
}

// Arbustos (escalera de 1 a 4) y una pared, como en materiales.test.ts
function bushes(): WorldState {
  const PAL = { ramps: [{ name: 'suelo', colors: ['#404040'] }, { name: 'arbusto', colors: ['#2f6b32'], material: 'arbusto' }, { name: 'muro', colors: ['#606060'] }] };
  const s = new StaticVoxels(PAL, 40, 24, -2, 12);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 40; x++) if (x !== 30 || y < 8) s.set(x, y, 0, material(0, 0));   // y un hueco sin suelo
  for (let k = 0; k < 4; k++) for (let x = 10 + k * 2; x < 12 + k * 2; x++) for (let y = 4; y < 20; y++) for (let z = 1; z <= k + 1; z++) s.set(x, y, z, material(1, 0));
  for (let x = 18; x < 22; x++) for (let y = 4; y < 20; y++) for (let z = 1; z <= 6; z++) s.set(x, y, z, material(2, 0));
  return new WorldState(s, [], null);
}

// Un medieval con agua más honda que el límite (como en collision.test.ts, el primer mapa que la tiene)
function deepWater(): WorldState {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { state } = buildWorldState(generateLayout(THEMES.medieval.spec, seed), THEMES.medieval.look);
    for (let y = 0; y < state.depth; y += 2) for (let x = 0; x < state.width; x += 2) if ((state.waterAt(x, y)?.depth ?? 0) > DEFAULT_RULES.maxWater) return state;
  }
  throw new Error('ningún mapa medieval tiene agua honda');
}

// Una oficina con sus objetos despiertos (cuentan en groundAt)
function awake(): WorldState {
  const { state } = buildWorldState(floorLayout({ ...THEMES.oficina.spec, cols: 20, rows: 14 }, 3, 1).layout, { ...THEMES.oficina.look, objects: true });
  for (const o of [...state.objects]) state.objects.wake(o.id);
  expect(state.objects.awake.length).toBeGreaterThan(0);
  return state;
}

// Escalones de 2 justos, el límite de DEFAULT_RULES.step (como en escalon.test.ts)
function stairs(): WorldState {
  const s = new StaticVoxels({ ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060'] }] }, 60, 60, -4, 30);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
    const top = x >= 20 && x < 30 && y < 30 ? (y >= 20 ? 5 : 3) : x >= 40 && y >= 40 ? 4 : 1;
    for (let z = 0; z < top; z++) s.set(x, y, z, material(0, 1));
  }
  return new WorldState(s, [], null);
}

// Columnas redondas de radios 2 a 5 en rejilla: contra ellas moveBody se desvía de lado (el caso que rodea la curva)
function pillars(): WorldState {
  const s = new StaticVoxels({ ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060'] }] }, 80, 80, -4, 30);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    s.set(x, y, 0, material(0, 1));
    for (let py = 10; py < 80; py += 20) for (let px = 10; px < 80; px += 20) {
      const pr = 2 + ((px + py) / 10) % 4;
      if (Math.hypot(x + 0.5 - px, y + 0.5 - py) < pr) for (let z = 1; z < 12; z++) s.set(x, y, z, material(0, 1));
    }
  }
  return new WorldState(s, [], null);
}

// Postes de un vóxel sueltos: de frente contra uno, los dos lados del desvío pueden quedar libres, y entonces importa
// cuál se prueba primero
function posts(): WorldState {
  const s = new StaticVoxels({ ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060'] }] }, 60, 60, -4, 30);
  for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
    s.set(x, y, 0, material(0, 1));
    if (x % 7 === 3 && y % 7 === 3) for (let z = 1; z < 12; z++) s.set(x, y, z, material(0, 1));
  }
  return new WorldState(s, [], null);
}

const WORLDS: Array<[string, () => WorldState]> = [['arbustos', bushes], ['agua honda', deepWater], ['objetos despiertos', awake], ['escalones de 2', stairs], ['columnas redondas', pillars], ['postes', posts]];

describe('la pisada en una consulta', () => {
  it.each(WORLDS)('%s: footing y standable dan lo de las consultas sueltas en cada celda', (_name, make) => {
    const w = make();
    let no = 0, yes = 0;
    for (let y = -1; y <= w.depth; y++) for (let x = -1; x <= w.width; x++) {
      const ok = w.solid.hasColumn(x, y) && w.solid.climbableAt(x, y);
      const f = w.footing(x, y);
      if (ok) expect(f).toBe(w.groundAt(x, y)); else expect(f).toBeNaN();
      const g = ok ? w.groundAt(x, y) : 0;
      for (const feet of [g - 3, g - 2, g - 1, g, g + 5]) for (const maxWater of [-1, 0, 4.5]) {
        const want = refStandable(w, x, y, feet, 2, maxWater);
        expect(w.standable(x + 0.5, y + 0.5, feet, 2, maxWater), `${x},${y} pies ${feet} agua ${maxWater}`).toBe(want);
        if (want) yes++; else no++;
      }
    }
    expect(yes).toBeGreaterThan(0);
    expect(no).toBeGreaterThan(0);
  }, SLOW);

  it.each(WORLDS)('%s: moveBody acaba donde moveBody con las consultas sueltas', (_name, make) => {
    const w = make();
    let seed = 7;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    let walks = 0, stopped = 0;
    for (let k = 0; k < 120; k++) {
      const r = [2, 3.5, 6][k % 3]!;
      // La mitad empieza en posiciones enteras y anda de medio en medio vóxel: así hay celdas justo a r del centro, el
      // borde de la huella
      const grid = k % 2 === 0;
      let x = r + rnd() * (w.width - 2 * r), y = r + rnd() * (w.depth - 2 * r);
      if (grid) { x = Math.round(x); y = Math.round(y); }
      const z = restZ(w, x, y, r);
      if (!Number.isFinite(z)) continue;
      const a: Body = { x, y, z, r }, b: Body = { ...a };
      const ang = rnd() * Math.PI * 2, sp = 0.3 + rnd() * 1.2;
      const ax = [0.5, -0.5, 0][Math.floor(rnd() * 3)]!, ay = ax === 0 ? 0.5 : [0.5, -0.5, 0][Math.floor(rnd() * 3)]!;
      for (let i = 0; i < 60; i++) {
        const dx = grid ? ax : Math.cos(ang + i * 0.05) * sp, dy = grid ? ay : Math.sin(ang + i * 0.05) * sp;
        const ba = moveBody(w, a, dx, dy), bb = refMove(w, b, dx, dy);
        expect([a.x, a.y, a.z, ba], `recorrido ${k}, paso ${i}`).toEqual([b.x, b.y, b.z, bb]);
        if (ba) stopped++;
      }
      walks++;
    }
    // Hacia cada columna (si las hay) desde los cuatro lados y en diagonal, algo descentrados: el desvío de lado, con el
    // otro eje a cero, a favor y en contra
    for (let py = 10; py < w.depth && w.depth === 80; py += 20) for (let px = 10; px < w.width; px += 20) {
      for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 0.3], [1, -0.3], [-0.3, 1], [0.3, -1], [0.7, 0.7]] as const) {
        // El desvío solo sirve rozando: descentrado cerca de la suma de los radios (de frente se queda parado)
        const pr = 2 + ((px + py) / 10) % 4;
        for (const [f, r] of [[-1, 2], [-0.9, 3.5], [-0.75, 2], [0, 3.5], [0.75, 3.5], [0.9, 2], [1, 3.5]] as const) {
          const off = f * (pr + r);
          const a: Body = { x: px - ux * 12 - uy * off, y: py - uy * 12 + ux * off, z: 1, r }, b: Body = { ...a };
          for (let i = 0; i < 40; i++) {
            const ba = moveBody(w, a, ux * 0.8, uy * 0.8), bb = refMove(w, b, ux * 0.8, uy * 0.8);
            expect([a.x, a.y, a.z, ba], `columna ${px},${py} dir ${ux},${uy} off ${off} paso ${i}`).toEqual([b.x, b.y, b.z, bb]);
            if (ba) stopped++;
          }
          walks++;
        }
      }
    }
    expect(walks).toBeGreaterThan(50);
    expect(stopped, 'ningún recorrido chocó: la prueba no mira los bordes').toBeGreaterThan(0);
  }, SLOW);

  // De frente contra un poste de un vóxel, casi rozándolo: con el otro eje quieto los dos lados del desvío quedan
  // libres, y va primero hacia el lado negativo (y 19,7 o x 19,7, no 21,3)
  it('el desvío, con los dos lados libres, va primero hacia el negativo', () => {
    const s = new StaticVoxels({ ramps: [{ name: 'p', colors: ['#202020', '#404040'] }] }, 40, 40, -4, 30);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      s.set(x, y, 0, material(0, 1));
      if (x === 20 && y === 20) for (let z = 1; z < 12; z++) s.set(x, y, z, material(0, 1));
    }
    const w = new WorldState(s, [], null);
    const a: Body = { x: 17.61, y: 20.5, z: 1, r: 2 };
    expect(moveBody(w, a, 0.4, 0)).toBe(true);
    expect([a.x, a.y]).toEqual([17.61 + 0.4, 19.7]);
    const b: Body = { x: 20.5, y: 17.61, z: 1, r: 2 };
    expect(moveBody(w, b, 0, 0.4)).toBe(true);
    expect([b.x, b.y]).toEqual([19.7, 17.61 + 0.4]);
  });
});
