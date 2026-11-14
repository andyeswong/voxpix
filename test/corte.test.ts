// El corte de vista (WorldView.setCut): en los 4 giros, con una luz fija dentro de la zona cortada (en el túnel) y otra
// fuera, el horneado con corte (rehecho por rebakeChangedJobs al poner, mover, bajar, picar dentro y quitar el corte)
// es el mismo, byte a byte, que hornear de cero un mundo al que le faltan esos vóxeles
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type ViewCut } from '../src/world/view';
import { bakeWorld, rebakeChanged, type Baked } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080'] }, { name: 'musgo', colors: ['#103010', '#206020', '#40a040'] }] };
const W = 64, D = 56, Z = 47;
const LIGHTS: WorldLight[] = [
  { id: 'tunel', kind: 'torch', x: 30.5, y: 23.5, z: 22, baked: true },     // dentro de la zona cortada, en el túnel
  { id: 'arriba', kind: 'lamp', x: 50.5, y: 44.5, z: 46, baked: true },     // fuera, en la superficie
];
// Roca hasta z = 40 (con relieve) y un túnel este-oeste (y 20..27, z 16..31)
function fill(s: StaticVoxels, skip?: ViewCut): void {
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const top = 40 + ((x >> 3) + (y >> 3)) % 3;
    for (let z = 0; z < top; z++) {
      if (y >= 20 && y < 28 && z >= 16 && z < 32) continue;
      if (skip && x >= skip.x0 && x <= skip.x1 && y >= skip.y0 && y <= skip.y1 && z >= skip.zTop) continue;
      s.set(x, y, z, material(z % 7 ? 0 : 1, 1 + ((x + y) & 1)));
    }
  }
}
function world(skip?: ViewCut): WorldState {
  const s = new StaticVoxels(PAL, W, D, 0, Z);
  fill(s, skip);
  return new WorldState(s, LIGHTS.map((l) => ({ ...l })), null);
}
const OPTS = { topZ: Z, incline: 0.5 };
function same(a: Baked, b: Baked): void {
  expect(Buffer.from(a.rgba.buffer).equals(Buffer.from(b.rgba.buffer))).toBe(true);
  expect(a.depth).toEqual(b.depth);
  expect(a.face).toEqual(b.face);
  const w = (x: Baked) => x.lights.map((l) => [l.light.id, l.rect, Array.from(l.weight)]).sort((p, q) => String(p[0]).localeCompare(String(q[0])));
  expect(w(a)).toEqual(w(b));
}
// Lo de referencia: el mundo sin los vóxeles cortados (y con lo picado), visto en el mismo giro, horneado de cero
function reference(q: 0 | 1 | 2 | 3, cut: ViewCut | null, dig?: (s: StaticVoxels) => void): Baked {
  const st = world(cut ?? undefined);
  dig?.(st.solid);
  if (cut && dig) for (let y = cut.y0; y <= cut.y1; y++) for (let x = cut.x0; x <= cut.x1; x++) for (let z = cut.zTop; z <= Z; z++) st.solid.set(x, y, z, 0);
  const v = new WorldView(st, q);
  return bakeWorld(v.bakeable(), OPTS);
}

describe('corte de vista', () => {
  for (const q of [0, 1, 2, 3] as const) it(`giro ${q}: poner, mover, bajar, picar dentro y quitar el corte da lo mismo que hornear sin esos vóxeles`, () => {
    const st = world();
    const view = new WorldView(st, q, { cut: true });
    const b = bakeWorld(view.bakeable(), OPTS);
    const step = (cut: ViewCut | null, dig?: (s: StaticVoxels) => void) => {
      if (cut !== undefined) view.setCut(cut);
      rebakeChanged(b, view.frame().lights);
      same(b, reference(q, cut, dig));
    };
    const c1 = { x0: 16, y0: 12, x1: 47, y1: 35, zTop: 32 };
    expect(view.setCut(c1)).toBeGreaterThan(0);
    rebakeChanged(b, view.frame().lights);
    same(b, reference(q, c1));
    step({ ...c1, x0: 21, x1: 52 });                              // la caja se mueve (el jugador anda)
    step({ ...c1, x0: 21, x1: 52, zTop: 24 });                    // baja más (se ve dentro del túnel, la antorcha incluida)
    // Picar en el mundo dentro de la zona cortada: la vista lo copia sin deshacer el corte
    const dig = (s: StaticVoxels) => { for (let z = 10; z < 16; z++) for (let y = 22; y < 26; y++) for (let x = 30; x < 34; x++) s.set(x, y, z, 0); };
    dig(st.solid);
    step({ ...c1, x0: 21, x1: 52, zTop: 24 }, dig);
    view.setCut(null);
    rebakeChanged(b, view.frame().lights);
    const plain = world(); dig(plain.solid);
    same(b, bakeWorld(new WorldView(plain, q).bakeable(), OPTS));
  });

  it('sin copia no se puede cortar; mover la caja un vóxel solo reescribe las franjas que entran y salen', () => {
    const st = world();
    expect(() => new WorldView(st, 0).setCut({ x0: 0, y0: 0, x1: 4, y1: 4, zTop: 30 })).toThrow(/copia/);
    const v = new WorldView(st, 0, { cut: true });
    expect(v.setCut({ x0: 10, y0: 10, x1: 41, y1: 41, zTop: 30 })).toBe(32 * 32);
    expect(v.setCut({ x0: 11, y0: 10, x1: 42, y1: 41, zTop: 30 })).toBe(2 * 32);
    expect(v.setCut({ x0: 11, y0: 10, x1: 42, y1: 41, zTop: 30 })).toBe(0);
  });
});

describe('corte incremental (cutJob)', () => {
  it('a trozos, y con otro corte a mitad, acaba igual que hornear sin esos vóxeles; el horneado se va poniendo al día', () => {
    const st = world();
    const view = new WorldView(st, 1, { cut: true });
    const b = bakeWorld(view.bakeable(), OPTS);
    const c1 = { x0: 16, y0: 12, x1: 47, y1: 35, zTop: 32 }, c2 = { x0: 26, y0: 12, x1: 57, y1: 35, zTop: 26 };
    let job = view.cutJob(c1), calls = 0;
    while (calls < 3 && !job.run(-1)) { rebakeChanged(b, view.frame().lights); calls++; }   // plazo vencido: 16 columnas por llamada
    job = view.cutJob(c2);                                       // otro corte antes de acabar
    while (!job.run(-1)) { rebakeChanged(b, view.frame().lights); calls++; }
    rebakeChanged(b, view.frame().lights);
    expect(calls).toBeGreaterThan(10);
    same(b, reference(1, c2));
    expect(job.key).toBe('view-cut');
  });
});
