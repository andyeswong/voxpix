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
