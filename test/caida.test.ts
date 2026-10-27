// Vóxeles que caen (src/world/fall.ts): rebuild deja la zona como estaba; crumble la vacía y deja el escombro en el
// suelo; a ticks o de golpe, el mundo acaba igual; las piezas no se quedan como entidades.
import { describe, it, expect } from 'vitest';
import { floorLayout, TILE, type GeneratorSpec } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorld, buildWorldState } from '../src/world/build';
import { openDoorInWorld } from '../src/world/doors';
import { dashBody, restZ } from '../src/runtime/body';
import { VoxelFall, type FallBox } from '../src/world/fall';
import type { WorldState } from '../src/world/state';

const SPEC: GeneratorSpec = { ...THEMES.medieval.spec, cols: 20, rows: 14 };
function fresh(): WorldState { return buildWorldState(floorLayout(SPEC, 3, 1).layout, THEMES.medieval.look).state; }
function voxels(w: WorldState, b?: FallBox): string {
  const out: string[] = [];
  for (const [x, y, z, v] of w.solid.entries()) if (!b || (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1)) out.push(`${x},${y},${z}:${v}`);
  return out.join('|');
}
const count = (w: WorldState, b: FallBox) => { let n = 0; for (const [x, y, z] of w.solid.entries()) if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1) n++; return n; };

// Una franja de pared: la del sur entera, sobre el suelo
const WALL_BOX: FallBox = { x0: 3 * TILE, y0: 0, z0: 1, x1: 7 * TILE - 1, y1: TILE - 1, z1: 40 };

describe('VoxelFall', () => {
  it('rebuild: las piezas esperan, caen y la zona queda exactamente como estaba', () => {
    const w = fresh();
    const box: FallBox = { x0: 2 * TILE, y0: 4 * TILE, z0: -10, x1: 8 * TILE - 1, y1: 9 * TILE - 1, z1: 40 };
    const before = voxels(w), ents = w.entities.length, ramps = w.palette.ramps.length;
    const f = new VoxelFall(w);
    const n = f.rebuild(box, { piece: 8, drop: 50, launch: 0.5 });
    expect(n).toBeGreaterThan(10);
    expect(count(w, box)).toBe(0);
    expect(w.entities.length).toBe(ents);                       // al empezar no se ve ninguna (esperan)
    f.step();
    expect(w.entities.length).toBeGreaterThan(ents);            // la primera ya cae
    let t = 0;
    while (!f.done && t++ < 2000) f.step();
    expect(f.done).toBe(true);
    expect(t).toBeLessThan(200);                                 // 0,5 s de suelta y la caída de 50
    expect(voxels(w)).toBe(before);
    expect(w.entities.length).toBe(ents);
    expect(w.palette.ramps.length).toBe(ramps);                  // la paleta del mundo no crece
    expect(f.touched).toEqual({ x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 });
  });

  it('crumble: la pared se vacía, el escombro cae al suelo y nada queda flotando', () => {
    const w = fresh();
    const total = w.solid.entries ? [...w.solid.entries()].length : 0;
    const f = new VoxelFall(w);
    const before = count(w, WALL_BOX);
    expect(before).toBeGreaterThan(500);
    f.crumble(WALL_BOX, { piece: 4, push: [0, 40, 10] });
    expect(count(w, WALL_BOX)).toBe(0);
    let t = 0;
    while (!f.done && t++ < 5000) f.step();
    expect(f.done).toBe(true);
    // Lo que no cayó fuera del mundo ni encima de algo ocupado sigue ahí
    const after = [...w.solid.entries()].length;
    expect(after).toBeLessThanOrEqual(total);
    expect(after).toBeGreaterThan(total - before);
    // El escombro está por debajo de donde estaba la pared (se ha caído), no a su altura de antes
    expect(count(w, { ...WALL_BOX, z0: 20 })).toBe(0);
  });

  it('a ticks o de golpe, el mundo acaba igual (rebuild y crumble)', () => {
    const run = (ticks: number) => {
      const w = fresh();
      const f = new VoxelFall(w);
      f.crumble(WALL_BOX, { piece: 4 });
      f.rebuild({ x0: 6 * TILE, y0: 5 * TILE, z0: -10, x1: 12 * TILE - 1, y1: 9 * TILE - 1, z1: 40 });
      for (let t = 0; t < ticks; t++) f.step();
      f.finish();
      expect(f.done).toBe(true);
      return voxels(w) + `#${w.entities.length}`;
    };
    const a = run(0), b = run(17), c = run(90);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("rebuild con commit 'end': el mundo no cambia mientras caen y al final queda igual que pieza a pieza", () => {
    const box: FallBox = { x0: 2 * TILE, y0: 4 * TILE, z0: -10, x1: 8 * TILE - 1, y1: 9 * TILE - 1, z1: 40 };
    const run = (commit: 'landing' | 'end') => {
      const w = fresh(), ents = w.entities.length;
      const f = new VoxelFall(w);
      f.rebuild(box, { piece: 8, drop: 50, launch: 0.5, commit });
      let changes = 0, t = 0, last = count(w, box);
      while (!f.done && t++ < 2000) {
        f.step();
        const n = count(w, box);
        if (n !== last) { changes++; last = n; }
      }
      expect(f.done).toBe(true);
      if (commit === 'end') {
        expect(f.held).toBeGreaterThan(10);                      // siguen dibujadas hasta que la vista rehornee
        expect(w.entities.length).toBe(ents + f.held);
        f.release();
      }
      expect(f.held).toBe(0);
      expect(w.entities.length).toBe(ents);
      return { voxels: voxels(w), changes };
    };
    const each = run('landing'), end = run('end');
    expect(end.voxels).toBe(each.voxels);
    expect(end.changes).toBe(1);                                 // solo al acabar
    expect(each.changes).toBeGreaterThan(10);                    // pieza a pieza: casi cada tick
  });

  it('caja fuera del mundo o vacía: nada', () => {
    const w = fresh();
    const f = new VoxelFall(w);
    expect(f.crumble({ x0: -50, y0: -50, z0: 0, x1: -10, y1: -10, z1: 5 })).toBe(0);
    expect(f.rebuild({ x0: 40, y0: 40, z0: 45, x1: 50, y1: 50, z1: 48 })).toBe(0);
    expect(f.done).toBe(true);
  });
});

describe('openDoorInWorld', () => {
  for (const theme of ['medieval', 'oficina', 'cyberpunk'] as const) it(`${theme}: la salida de cada piso se abre en vivo, igual que montada abierta, y se puede cruzar`, () => {
    for (let fl = 0; fl < 4; fl++) {
      const p = floorLayout({ ...THEMES[theme].spec, cols: 22, rows: 16 }, 5, fl);
      const { state } = buildWorldState(p.layout, THEMES[theme].look);
      const ents = state.entities.length;
      const { fall, touched } = openDoorInWorld(state, p.layout, p.exit.slot.side, THEMES[theme].look);
      expect(p.exit.slot.open).toBe(true);
      expect(fall.active).toBeGreaterThan(0);
      fall.finish();
      expect(state.entities.length).toBe(ents);
      const fresh = buildWorld(p.layout, THEMES[theme].look).model;
      for (let z = fresh.zMin; z <= fresh.zMax; z++) for (let y = touched.y0; y <= touched.y1; y++) for (let x = touched.x0; x <= touched.x1; x++) {
        if (fresh.get(x, y, z) !== state.solid.get(x, y, z)) throw new Error(`${theme} piso ${fl}: ${x},${y},${z} distinto`);
      }
      // Desde la loseta de dentro se llega al borde del mundo por el hueco
      const H = p.layout.rows * TILE, x = p.exit.x, y = H - 1 - p.exit.y;
      const body = { x, y, z: restZ(state, x, y, 4), r: 4 };
      const [dx, dy] = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] }[p.exit.slot.side]!;
      dashBody(state, body, dx!, dy!, 200);
      const edge = dx! > 0 ? p.layout.cols * TILE - body.x : dx! < 0 ? body.x : dy! > 0 ? H - body.y : body.y;
      expect(edge).toBeLessThan(8);
    }
  });
});
