// Avisos de "esta zona del mundo cambió" (src/world/changes.ts): por cada vía que toca el mundo, la unión de las cajas
// avisadas cubre todo vóxel que cambió; un despierto avisa de su huella continua; la memoria no crece sin take.
import { describe, it, expect } from 'vitest';
import { floorLayout, TILE, type GeneratorSpec } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { material } from '../src/core';
import { StaticVoxels, WorldState, TICK } from '../src/world/state';
import { SLEEP_AFTER, type WorldObject } from '../src/world/objects';
import { VoxelFall } from '../src/world/fall';
import { crushAt } from '../src/world/crush';
import type { ChangeBox } from '../src/world/changes';

const SPEC: GeneratorSpec = { ...THEMES.oficina.spec, cols: 20, rows: 14 };
const officeWorld = () => buildWorldState(floorLayout(SPEC, 3, 1).layout, { ...THEMES.oficina.look, objects: true }).state;

const voxelMap = (w: WorldState) => {
  const m = new Map<string, number>();
  for (const [x, y, z, v] of w.solid.entries()) m.set(`${x},${y},${z}`, v);
  return m;
};
// Los vóxeles distintos entre dos copias
function diff(a: Map<string, number>, b: Map<string, number>): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push(k.split(',').map(Number) as [number, number, number]);
  return out;
}
const inside = (b: ChangeBox, x: number, y: number, z: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1;
// Cuántos de los vóxeles cambiados no caen en ninguna caja
const uncovered = (cells: Array<[number, number, number]>, boxes: ChangeBox[]) => cells.filter(([x, y, z]) => !boxes.some((b) => inside(b, x, y, z))).length;

// La huella continua de un despierto en (px, py): cada vóxel ocupa [px + lx, px + lx + 1), así que pisa las columnas de
// floor(px + lx) a ceil(px + lx + 1) - 1
function footprint(o: WorldObject, px: number, py: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < o.cells.length; i += 4) {
    const fx = px + o.cells[i]!, fy = py + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
    for (let x = Math.floor(fx); x <= Math.ceil(fx + 1) - 1; x++) for (let y = Math.floor(fy); y <= Math.ceil(fy + 1) - 1; y++) out.push([x, y, z]);
  }
  return out;
}

// Un mueble que se mueve hacia algún lado, y hacia dónde (sin dejar rastro: deshace el intento)
function movable(w: WorldState) {
  for (const o of w.objects) {
    if (o.kind !== 'prop' || !w.objects.fitsSprite(o.id)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const snap = w.snapshot();
      const r = w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 3, TICK);
      w.restore(snap);
      if (r.moved > 0) return { id: o.id, dx, dy };
    }
  }
  throw new Error('ningún mueble se puede mover');
}

describe('avisos de cambios: cada vía cubre lo que cambió', () => {
  it('set suelto: una caja por trozo, ajustada a lo que cambió (no al trozo entero)', () => {
    const w = officeWorld();
    const watch = w.watchChanges();
    const before = voxelMap(w);
    w.solid.set(3, 3, 5, material(0, 1));
    w.solid.set(4, 5, 7, material(0, 1));
    w.solid.set(3 * 16 + 2, 2 * 16 + 1, 6, material(0, 1));
    w.solid.set(3, 3, 5, material(0, 1));                         // el mismo valor: no es un cambio
    const { boxes } = watch.take();
    expect(boxes.length).toBe(2);
    expect(boxes[0]).toEqual({ x0: 3, y0: 3, z0: 5, x1: 4, y1: 5, z1: 7, cause: 'voxels' });
    expect(uncovered(diff(before, voxelMap(w)), boxes)).toBe(0);
    expect(watch.take().boxes).toEqual([]);                        // take vacía
  });

  it('objetos: despertar, empujar (con su huella continua), dormirse en otro sitio', () => {
    const w = officeWorld();
    const { id, dx, dy } = movable(w);
    const watch = w.watchChanges();
    const o = w.objects.get(id)!;
    let before = voxelMap(w);
    const force = w.objects.forceToMove(id) * 3;
    w.objects.push(id, dx, dy, force, TICK);
    expect(o.awake).toBe(true);
    let t = watch.take();
    expect(uncovered(diff(before, voxelMap(w)), t.boxes)).toBe(0);  // despertar quita sus vóxeles
    // Empujar a trozos que dejan la posición a medias (px no entero): la caja cubre lo que asoma a la celda de al lado
    for (let i = 0; i < 6; i++) {
      const x0 = o.px, y0 = o.py;
      w.objects.push(id, dx, dy, force, TICK * 0.7);
      t = watch.take();
      expect(t.boxes.every((b) => b.cause === 'object' && b.id === id)).toBe(true);
      const obj = t.boxes;
      expect(uncovered([...footprint(o, x0, y0), ...footprint(o, o.px, o.py)], obj)).toBe(0);
    }
    expect(o.px % 1 !== 0 || o.py % 1 !== 0).toBe(true);            // de verdad a medias
    const last = footprint(o, o.px, o.py);
    before = voxelMap(w);
    for (let i = 0; i < Math.ceil(SLEEP_AFTER / TICK) + 2; i++) w.step();
    expect(o.awake).toBe(false);
    t = watch.take();
    expect(uncovered(diff(before, voxelMap(w)), t.boxes)).toBe(0);  // los vóxeles que pone al dormirse
    expect(uncovered(last, t.boxes.filter((b) => b.cause === 'object'))).toBe(0);   // y deja su sitio de despierto
  });

  for (const how of ['destroy', 'chip'] as const) it(`objetos: ${how} de uno despierto avisa de su última huella`, () => {
    const w = officeWorld();
    const { id, dx, dy } = movable(w);
    const o = w.objects.get(id)!;
    w.objects.push(id, dx, dy, w.objects.forceToMove(id) * 3, TICK * 0.7);
    expect(o.awake).toBe(true);
    const watch = w.watchChanges();
    const last = footprint(o, o.px, o.py), before = voxelMap(w);
    if (how === 'destroy') w.objects.destroy(id);
    else w.objects.chip(id, o.px + o.cells[0]!, o.py + o.cells[1]!, o.z + o.cells[2]!, 2);
    const { boxes } = watch.take();
    expect(uncovered(diff(before, voxelMap(w)), boxes)).toBe(0);
    expect(uncovered(last, boxes.filter((b) => b.cause === 'object' && b.id === id))).toBe(0);
  });

  it('objetos dormidos: destroy con caída y chip', () => {
    const w = officeWorld();
    const watch = w.watchChanges();
    const list = [...w.objects].filter((o) => o.kind === 'prop');
    const before = voxelMap(w);
    const f = new VoxelFall(w);
    w.objects.destroy(list[0]!.id, f, { piece: 4 });
    f.finish();
    const c = list[1]!;
    w.objects.chip(c.id, c.x + c.cells[0]!, c.y + c.cells[1]!, c.z + c.cells[2]!, 2);
    expect(uncovered(diff(before, voxelMap(w)), watch.take().boxes)).toBe(0);
  });

  it("VoxelFall: crumble y rebuild con commit 'end'", () => {
    const w = officeWorld();
    const watch = w.watchChanges();
    const before = voxelMap(w);
    const f = new VoxelFall(w);
    f.crumble({ x0: 3 * TILE, y0: 0, z0: 1, x1: 7 * TILE - 1, y1: TILE - 1, z1: 40 }, { piece: 4, push: [0, 40, 10] });
    f.rebuild({ x0: 9 * TILE, y0: 4 * TILE, z0: -10, x1: 13 * TILE - 1, y1: 8 * TILE - 1, z1: 40 }, { piece: 8, drop: 50, commit: 'end' });
    let n = 0;
    while (!f.done && n++ < 3000) f.step();
    f.release();
    const changed = diff(before, voxelMap(w));
    expect(changed.length).toBeGreaterThan(100);
    expect(uncovered(changed, watch.take().boxes)).toBe(0);
  });

  it('crushAt', () => {
    const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040'] }, { name: 'hierba', colors: ['#102010', '#204020'], material: 'follaje' }] };
    const s = new StaticVoxels(structuredClone(PAL), 32, 32, -2, 20);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { s.set(x, y, 0, material(0, 1)); for (let z = 1; z <= 4; z++) s.set(x, y, z, material(1, 1)); }
    const w = new WorldState(s, [], null);
    const watch = w.watchChanges();
    const before = voxelMap(w);
    crushAt(w, 16, 16, 6, { mode: 'break' });
    const changed = diff(before, voxelMap(w));
    expect(changed.length).toBeGreaterThan(50);
    expect(uncovered(changed, watch.take().boxes)).toBe(0);
  });

  it('restore: el mundo entero', () => {
    const w = officeWorld();
    const snap = w.snapshot();
    const watch = w.watchChanges();
    w.restore(snap);
    expect(watch.take().boxes).toEqual([{ x0: 0, y0: 0, z0: w.solid.zMin, x1: w.solid.width - 1, y1: w.solid.depth - 1, z1: w.solid.zMax, cause: 'restore' }]);
  });
});

describe('avisos de cambios: memoria, versión y oyentes', () => {
  it('10.000 cambios en el mismo trozo sin take dejan 1 caja; un despierto que no para, 1 por objeto', () => {
    const w = officeWorld();
    const watch = w.watchChanges();
    for (let i = 0; i < 10000; i++) w.solid.set(1 + (i % 14), 1 + ((i >> 4) % 14), 10 + (i % 3), material(0, i % 2));
    expect(watch.pending).toBe(1);
    const { id, dx, dy } = movable(w);
    watch.take();
    for (let i = 0; i < 200; i++) w.objects.push(id, i % 2 ? dx : -dx, i % 2 ? dy : -dy, w.objects.forceToMove(id) * 3, TICK);
    expect(watch.take().boxes.filter((b) => b.cause === 'object').length).toBe(1);
  });

  it('version: la del mundo al tomar; lo de después sale en el take siguiente', () => {
    const w = officeWorld();
    const watch = w.watchChanges();
    w.solid.set(2, 2, 9, material(0, 1));
    const a = watch.take();
    expect(a.version).toBe(w.version);
    w.solid.set(60, 60, 9, material(0, 1));
    const b = watch.take();
    expect(b.version).toBeGreaterThan(a.version);
    expect(b.boxes.map((x) => [x.x0, x.y0])).toEqual([[60, 60]]);
  });

  it('varios oyentes, cada uno con lo suyo; close lo quita y sin oyentes la lista es null', () => {
    const w = officeWorld();
    expect(w.changes.list).toBeNull();
    const a = w.watchChanges();
    w.solid.set(2, 2, 9, material(0, 1));
    const b = w.watchChanges();
    w.solid.set(60, 60, 9, material(0, 1));
    expect(a.take().boxes.length).toBe(2);
    expect(b.take().boxes.length).toBe(1);
    a.close();
    w.solid.set(3, 3, 9, material(0, 1));
    expect(a.take().boxes).toEqual([]);
    b.close();
    expect(w.changes.list).toBeNull();
  });

  it('escuchar no cambia la partida: la misma huella con y sin oyente', () => {
    const run = (listen: boolean) => {
      const w = officeWorld();
      if (listen) w.watchChanges();
      const { id, dx, dy } = movable(w);
      for (let i = 0; i < 20; i++) w.objects.push(id, dx, dy, w.objects.forceToMove(id) * 3, TICK);
      for (let i = 0; i < 120; i++) w.step();
      return w.hash();
    };
    expect(run(true)).toBe(run(false));
  });
});
