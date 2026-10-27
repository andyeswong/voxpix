// Objetos del mundo (src/world/objects.ts): con look.objects, cada columna y cada mueble queda registrado con sus
// vóxeles, lo que había debajo, su peso (de los materiales) y su vida; sin él, el mundo es el de siempre.
import { describe, it, expect } from 'vitest';
import { floorLayout, type GeneratorSpec } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorld, buildWorldState, blockProp, M } from '../src/world/build';
import { VOXEL_M3, material, decode } from '../src/core';
import type { WorldState } from '../src/world/state';

const SPEC: GeneratorSpec = { ...THEMES.oficina.spec, cols: 20, rows: 14 };
const layout = () => floorLayout(SPEC, 3, 1).layout;
const voxels = (w: WorldState) => [...w.solid.entries()].map(([x, y, z, v]) => `${x},${y},${z}:${v}`).join('|');

describe('objetos', () => {
  it('sin look.objects no hay objetos; con él, el mundo de vóxeles es exactamente el mismo', () => {
    const off = buildWorldState(layout(), THEMES.oficina.look).state;
    const on = buildWorldState(layout(), { ...THEMES.oficina.look, objects: true }).state;
    expect(off.objects.size).toBe(0);
    expect(off.objects.used).toBe(false);
    expect(on.objects.size).toBeGreaterThan(0);
    expect(voxels(on)).toBe(voxels(off));
  });

  it('cada columna y cada mueble es un objeto: sus vóxeles están en el mundo y son suyos; el suelo no es de nadie', () => {
    const L = layout();
    const { state: w } = buildWorldState(L, { ...THEMES.oficina.look, objects: true });
    const list = [...w.objects];
    expect(list.filter((o) => o.kind === 'prop').length).toBe(L.props.length);
    expect(list.filter((o) => o.kind === 'pillar').length).toBeGreaterThan(0);
    for (const o of list) {
      for (let i = 0; i < o.cells.length; i += 4) {
        const x = o.x + o.cells[i]!, y = o.y + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
        expect(w.solid.get(x, y, z)).toBe(o.cells[i + 3]);
        expect(w.objects.at(x, y, z)?.id).toBe(o.id);
      }
      expect(o.mass).toBeGreaterThan(0);
      expect(o.hp).toBe(o.cells.length / 4);
    }
    expect(w.objects.at(1, 1, 0)).toBeUndefined();
    // Las luces que pone un escritorio (su pantalla) son suyas
    expect(list.some((o) => o.lights.length > 0)).toBe(true);
  });

  it('lo que había debajo y el peso: un mueble de bloque sobre el suelo, de madera', () => {
    const L = layout();
    const world = buildWorld(L, { palette: THEMES.oficina.look.palette, prop: blockProp, pillar: null, objects: true });
    const props = world.objects!.filter((o) => o.kind === 'prop');
    expect(props.length).toBe(L.props.length);
    const o = props[0]!, p = L.props[0]!;
    // blockProp: (16w-2) x (16h-2) x 12 vóxeles de madera, metido 1 en su huella, desde z = 0 (pisa el suelo)
    const n = (p.w * 16 - 2) * (p.h * 16 - 2) * 12;
    expect(o.cells.length / 4).toBe(n);
    expect(o.z).toBe(0);
    let onFloor = 0;
    for (let i = 0; i < o.cells.length / 4; i++) {
      expect(decode(o.cells[i * 4 + 3]!).ramp).toBe(M.wood);
      if (o.cells[i * 4 + 2] === 0) { onFloor++; expect(decode(o.under[i]!).ramp).toBe(M.floor); }
      else expect(o.under[i]).toBe(0);
    }
    expect(onFloor).toBe((p.w * 16 - 2) * (p.h * 16 - 2));
    const { state } = buildWorldState(L, { palette: THEMES.oficina.look.palette, prop: blockProp, pillar: null, objects: true });
    const mass = [...state.objects].find((x) => x.kind === 'prop')!.mass;
    expect(mass).toBeCloseTo(n * 600 * VOXEL_M3, 6);                 // madera, 600 kg/m³
  });

  it('una columna de piedra pesa más por vóxel que un mueble de madera', () => {
    const { state: w } = buildWorldState(layout(), { palette: THEMES.medieval.look.palette, prop: blockProp, objects: true });
    const per = (k: string) => { const o = [...w.objects].find((x) => x.kind === k)!; return o.mass / (o.cells.length / 4); };
    expect(per('pillar')).toBeCloseTo(2400 * VOXEL_M3, 6);
    expect(per('pillar')).toBeGreaterThan(per('prop') * 3);
  });

  it('instantánea y huella: restaurar deja los mismos objetos y dueños; la vida cuenta en la huella', () => {
    const { state: w } = buildWorldState(layout(), { ...THEMES.oficina.look, objects: true });
    const snap = w.snapshot(), h0 = w.hash();
    const o = [...w.objects][0]!;
    o.hp -= 5;
    const h1 = w.hash();
    expect(h1).not.toBe(h0);
    w.objects.remove(o.id);
    expect(w.objects.at(o.x + o.cells[0]!, o.y + o.cells[1]!, o.z + o.cells[2]!)).toBeUndefined();
    w.restore(snap);
    expect(w.hash()).toBe(h0);
    expect(w.objects.get(o.id)?.hp).toBe(o.maxHp);
    expect(w.objects.at(o.x + o.cells[0]!, o.y + o.cells[1]!, o.z + o.cells[2]!)?.id).toBe(o.id);
  });

  it('una rampa con su propia densidad cambia el peso', () => {
    const pal = structuredClone(THEMES.oficina.look.palette);
    pal.ramps[M.wood] = { ...pal.ramps[M.wood]!, props: { density: 1200 } };
    const L = layout();
    const a = [...buildWorldState(L, { palette: THEMES.oficina.look.palette, prop: blockProp, pillar: null, objects: true }).state.objects][0]!;
    const b = [...buildWorldState(L, { palette: pal, prop: blockProp, pillar: null, objects: true }).state.objects][0]!;
    expect(b.mass).toBeCloseTo(a.mass * 2, 6);
    expect(material(M.wood, 0)).toBeGreaterThan(0);
  });
});

// ---- fase 2: despertar, dormir, empujar
import { SLEEP_AFTER } from '../src/world/objects';
import { TICK } from '../src/world/state';
import { bakeWorld, rebakeChanged } from '../src/world/bake';
import { objectAhead } from '../src/runtime/body';

const officeWorld = () => buildWorldState(layout(), { ...THEMES.oficina.look, objects: true }).state;
// El primer mueble con luz que se pueda mover en alguna dirección (la primera de E, O, N, S que avance)
function movable(w: WorldState) {
  for (const o of w.objects) {
    if (o.kind !== 'prop' || !o.lights.length || !w.objects.fitsSprite(o.id)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const snap = w.snapshot();
      const r = w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 3, TICK);
      w.restore(snap);
      if (r.moved > 0) return { o: w.objects.get(o.id)!, dx, dy };
    }
  }
  throw new Error('ningún mueble se puede mover');
}
const steps = (w: WorldState, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const sleepTicks = Math.ceil(SLEEP_AFTER / TICK) + 2;

describe('objetos: empujar', () => {
  it('sin fuerza suficiente es pared: no se despierta ni cambia nada', () => {
    const w = officeWorld();
    const { o, dx, dy } = movable(w);
    const h = w.hash();
    const r = w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 0.99, TICK);
    expect(r).toMatchObject({ moved: 0, heavy: true });
    expect(o.awake).toBe(false);
    expect(w.hash()).toBe(h);
  });

  it('empujado se despierta y avanza; quieto se duerme en su sitio nuevo, con el suelo de antes intacto', () => {
    const w = officeWorld();
    const { o, dx, dy } = movable(w);
    const x0 = o.x, y0 = o.y, ents = w.entities.length, under0 = o.under.slice();
    const cell0 = [x0 + o.cells[0]!, y0 + o.cells[1]!, o.z + o.cells[2]!] as const;
    let moved = 0;
    for (let i = 0; i < 30; i++) moved += w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 3, TICK).moved;
    expect(o.awake).toBe(true);
    expect(moved).toBeGreaterThan(2);
    expect(w.entities.length).toBe(ents + 1);
    expect(w.objects.at(...cell0)).toBeUndefined();                   // despierto: sus vóxeles no están en el mundo
    // Su huella choca: el suelo de su columna nueva está a su altura
    const fx = Math.round(o.px) + o.cells[0]!, fy = Math.round(o.py) + o.cells[1]!;
    expect(w.groundAt(fx + 0.5, fy + 0.5)).toBeGreaterThan(o.z + 1);
    steps(w, sleepTicks);
    expect(o.awake).toBe(false);
    expect(o.x - x0 + (o.y - y0)).toBe(Math.round(moved) * (dx + dy));
    // Sus vóxeles están en el sitio nuevo y son suyos; donde estaba y ya no está, vuelve lo que había debajo
    const now = new Set<string>();
    for (let i = 0; i < o.cells.length; i += 4) now.add(`${o.x + o.cells[i]!},${o.y + o.cells[i + 1]!},${o.z + o.cells[i + 2]!}`);
    let freed = 0;
    for (let i = 0; i < o.cells.length; i += 4) {
      const x = x0 + o.cells[i]!, y = y0 + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
      if (now.has(`${x},${y},${z}`)) continue;
      expect(w.solid.get(x, y, z)).toBe(under0[i >> 2]);
      freed++;
    }
    expect(freed).toBeGreaterThan(0);
    for (let i = 0; i < o.cells.length; i += 4) {
      const x = o.x + o.cells[i]!, y = o.y + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
      expect(w.solid.get(x, y, z)).toBe(o.cells[i + 3]);
      expect(w.objects.at(x, y, z)?.id).toBe(o.id);
    }
    // La entidad queda como fantasma (dibujada, fuera de la partida) hasta que se vea el rehorneado
    expect(w.entities.length).toBe(ents + 1);
    const snapEnts = w.snapshot().entities.length;
    expect(snapEnts).toBe(ents);
    expect(w.objects.dropGhosts(w.solid.clock)).toBe(1);
    expect(w.entities.length).toBe(ents);
  });

  it('sus luces van con él y vuelven a ser fijas al dormirse; el rehorneado da lo mismo que hornear de cero', () => {
    const w = officeWorld();
    const { o, dx, dy } = movable(w);
    const lights = () => [...w.lights];
    const b = bakeWorld({ model: w.solid, lights: lights(), width: w.width, depth: w.depth }, { topZ: 40, incline: 0.5 });
    const l0 = o.lights.map((id) => { const l = w.lights.get(id)!; return [l.x, l.y] as const; }), x0 = o.x, y0 = o.y;
    for (let i = 0; i < 20; i++) w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 3, TICK);
    expect(o.lights.every((id) => w.lights.get(id)!.baked === false)).toBe(true);
    rebakeChanged(b, lights());
    expect(b.lights.some((bl) => o.lights.includes(bl.light.id))).toBe(false);   // despierta, su luz no está horneada
    steps(w, sleepTicks);
    o.lights.forEach((id, k) => {
      const l = w.lights.get(id)!;
      expect(l.baked).toBe(true);
      expect(l.x - l0[k]![0]).toBeCloseTo(o.x - x0, 6);
      expect(l.y - l0[k]![1]).toBeCloseTo(o.y - y0, 6);
    });
    rebakeChanged(b, lights());
    const fresh = bakeWorld({ model: w.solid, lights: lights(), width: w.width, depth: w.depth }, { topZ: 40, incline: 0.5 });
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(fresh.rgba.buffer))).toBe(true);
    expect(b.lights.map((l) => l.light.id).sort()).toEqual(fresh.lights.map((l) => l.light.id).sort());
    for (const fl of fresh.lights) expect(b.lights.find((l) => l.light.id === fl.light.id)!.weight).toEqual(fl.weight);
  });

  it('contra la pared se para y nunca la pisa', () => {
    const w = officeWorld();
    const { o, dx, dy } = movable(w);
    let last = 1;
    for (let i = 0; i < 2000 && last > 0; i++) last = w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 50, TICK).moved;
    expect(last).toBe(0);
    steps(w, sleepTicks);
    // Dormido en el sitio donde se paró: ningún vóxel suyo cayó sobre otro sólido (lo de debajo es suelo o vacío)
    for (let i = 0; i < o.under.length; i++) expect(o.under[i] === 0 || o.cells[i * 4 + 2] === 0).toBe(true);
  });

  it('determinista: instantánea a medio empujón, y seguir da lo mismo', () => {
    const run = (cut: boolean) => {
      const w = officeWorld();
      const { o, dx, dy } = movable(w);
      const f = w.objects.forceToMove(o.id) * 3;
      for (let i = 0; i < 10; i++) { w.objects.push(o.id, dx, dy, f, TICK); w.step(); }
      if (cut) { const s = w.snapshot(); steps(w, 7); w.restore(s); }
      for (let i = 0; i < 10; i++) { w.objects.push(o.id, dx, dy, f, TICK); w.step(); }
      steps(w, sleepTicks);
      return w.hash();
    };
    expect(run(true)).toBe(run(false));
  });

  it('objectAhead: el cuerpo que va hacia el mueble lo encuentra; hacia el vacío, nada', () => {
    const w = officeWorld();
    const { o } = movable(w);
    // Un cuerpo al oeste del mueble, a media altura de su huella, mirando al este
    let ly = 0;
    for (let i = 0; i < o.cells.length; i += 4) if (o.cells[i] === 0) { ly = o.cells[i + 1]!; break; }
    const body = { x: o.x - 4, y: o.y + ly + 0.5, z: 1, r: 3 };
    expect(objectAhead(w, body, 1, 0, 2)).toBe(o.id);
    expect(objectAhead(w, body, -1, 0, 2)).not.toBe(o.id);
  });
});

// ---- fase 3: romper, morder y aplastar
import { VoxelFall } from '../src/world/fall';
import { crushAt } from '../src/world/crush';
import { StaticVoxels, WorldState as WS } from '../src/world/state';

describe('objetos: romper', () => {
  const desk = (w: WorldState) => [...w.objects].find((o) => o.kind === 'prop' && o.lights.length)!;
  const legsOnFloor = (w: WorldState, o: ReturnType<typeof desk>) => {
    const out: Array<[number, number, number, number]> = [];
    for (let i = 0; i < o.cells.length; i += 4) if (o.under[i >> 2]) out.push([o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!, o.under[i >> 2]!]);
    return out;
  };

  it('el daño baja la vida; sin llegar a 0 no cambia nada más', () => {
    const w = officeWorld();
    const o = desk(w), v = voxels(w);
    expect(w.objects.damage(o.id, 10)).toEqual({ hp: o.maxHp - 10, destroyed: false, pieces: 0 });
    expect(voxels(w)).toBe(v);
  });

  it('a 0 sin caída: desaparece, vuelve el suelo que pisaba, se apagan sus luces y deja de ser objeto', () => {
    const w = officeWorld();
    const o = desk(w), legs = legsOnFloor(w, o), lights = [...o.lights];
    expect(legs.length).toBeGreaterThan(0);
    expect(w.objects.damage(o.id, o.hp + 1)).toMatchObject({ hp: 0, destroyed: true, pieces: 0 });
    for (const [x, y, z, under] of legs) expect(w.solid.get(x, y, z)).toBe(under);
    for (let i = 0; i < o.cells.length; i += 4) if (!o.under[i >> 2]) expect(w.solid.get(o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!)).toBe(0);
    for (const id of lights) expect(w.lights.get(id)).toBeUndefined();
    expect(w.objects.get(o.id)).toBeUndefined();
  });

  it('con caída se desmorona en piezas; el escombro no es de nadie y el suelo vuelve', () => {
    const w = officeWorld();
    const o = desk(w), legs = legsOnFloor(w, o), n = o.cells.length / 4;
    const f = new VoxelFall(w);
    const r = w.objects.damage(o.id, Infinity, f, { piece: 4 });
    expect(r.destroyed).toBe(true);
    expect(r.pieces).toBeGreaterThan(5);
    for (const [x, y, z, under] of legs) expect(w.solid.get(x, y, z)).toBe(under);
    f.finish();
    let owned = 0;
    for (const [x, y, z] of w.solid.entries()) if (w.objects.at(x, y, z)) owned++;
    expect(owned).toBe([...w.objects].reduce((a, b) => a + b.cells.length / 4, 0));
    expect(n).toBeGreaterThan(0);
  });

  it('despierto: se duerme antes, sin dejar fantasma', () => {
    const w = officeWorld();
    const { o, dx, dy } = movable(w);
    const ents = w.entities.length;
    for (let i = 0; i < 5; i++) w.objects.push(o.id, dx, dy, w.objects.forceToMove(o.id) * 3, TICK);
    expect(w.entities.length).toBe(ents + 1);
    w.objects.destroy(o.id);
    expect(w.entities.length).toBe(ents);
    expect(w.objects.awake.length).toBe(0);
  });

  it('chip: le arranca lo que hay cerca del golpe, baja su masa y sigue siendo objeto', () => {
    const w = officeWorld();
    const o = desk(w), n0 = o.cells.length / 4, m0 = o.mass;
    // Un golpe en su esquina más alta
    let k = 0;
    for (let i = 0; i < o.cells.length; i += 4) if (o.cells[i + 2]! > o.cells[k + 2]!) k = i;
    const hx = o.x + o.cells[k]! + 0.5, hy = o.y + o.cells[k + 1]! + 0.5, hz = o.z + o.cells[k + 2]! + 0.5;
    const lost = w.objects.chip(o.id, hx, hy, hz, 3);
    expect(lost).toBeGreaterThan(0);
    expect(o.cells.length / 4).toBe(n0 - lost);
    expect(o.mass).toBeLessThan(m0);
    expect(w.solid.get(Math.floor(hx), Math.floor(hy), Math.floor(hz))).toBe(0);
    expect(w.objects.get(o.id)).toBe(o);
    for (let i = 0; i < o.cells.length; i += 4) expect(w.objects.at(o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!)?.id).toBe(o.id);
  });
});

describe('crushAt', () => {
  const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] }, { name: 'hierba', colors: ['#102010', '#204020', '#306030', '#408040', '#50a050'], material: 'follaje' }] };
  const meadow = () => {
    const s = new StaticVoxels(structuredClone(PAL), 32, 32, -2, 20);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
      s.set(x, y, 0, material(0, 2));
      for (let z = 1; z <= 4; z++) s.set(x, y, z, material(1, 3));
    }
    s.set(16, 16, 5, material(0, 2));                     // una piedra encima de la hierba en el centro
    return new WS(s, [], null);
  };
  const col = (w: WS, x: number, y: number) => { let n = 0; for (let z = 1; z <= 6; z++) if (w.solid.get(x, y, z)) n++; return n; };

  it('flatten deja la hierba de 1 de alto en el círculo; fuera, intacta; la piedra no se aplasta', () => {
    const w = meadow();
    const n = crushAt(w, 10, 10, 3);
    expect(n).toBeGreaterThan(0);
    expect(col(w, 10, 10)).toBe(1);
    expect(col(w, 20, 20)).toBe(4);
    expect(crushAt(w, 10, 10, 3)).toBe(0);                // ya aplastada: no cambia nada (no rehornea cada tick)
    crushAt(w, 16, 16, 1);
    expect(w.solid.get(16, 16, 5)).toBe(material(0, 2));
  });

  it('break se la lleva entera; darken oscurece lo que queda', () => {
    const w = meadow();
    crushAt(w, 5, 5, 2, { mode: 'break' });
    expect(col(w, 5, 5)).toBe(0);
    expect(w.solid.get(5, 5, 0)).toBe(material(0, 2));
    crushAt(w, 25, 25, 2, { darken: true });
    expect(w.solid.get(25, 25, 1)).toBe(material(1, 2));
  });
});
