import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld, rebakeChanged, rebakeChangedJobs, type Baked } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorldState } from '../src/world/build';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] }] };

// Un patio: suelo, un muro este-oeste de 20 de alto, una columna y una antorcha al norte del muro
function yard(): { s: StaticVoxels; lights: WorldLight[] } {
  const s = new StaticVoxels(structuredClone(PAL), 80, 64, -4, 30);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 80; x++) s.set(x, y, 0, material(0, (x + y) % 2 ? 2 : 1));
  for (let z = 1; z <= 20; z++) for (let x = 10; x < 70; x++) for (let y = 30; y < 33; y++) s.set(x, y, z, material(0, 3));
  for (let z = 1; z <= 16; z++) for (let y = 12; y < 16; y++) for (let x = 50; x < 54; x++) s.set(x, y, z, material(0, 4));
  return { s, lights: [{ id: 'antorcha', kind: 'torch', x: 40, y: 40, z: 8, baked: true }] };
}

function same(a: Baked, b: Baked): void {
  expect(Buffer.from(a.rgba.buffer).equals(Buffer.from(b.rgba.buffer))).toBe(true);
  expect(a.depth).toEqual(b.depth);
  expect(a.face).toEqual(b.face);
  expect(a.lights.map((l) => l.light.id)).toEqual(b.lights.map((l) => l.light.id));
  for (let i = 0; i < a.lights.length; i++) {
    expect(a.lights[i]!.rect).toEqual(b.lights[i]!.rect);
    expect(a.lights[i]!.weight).toEqual(b.lights[i]!.weight);
  }
}

describe('rehorneado por trozos', () => {
  it('editar vóxeles y rehornear solo lo cambiado da lo mismo, byte a byte, que hornear de cero', () => {
    const { s, lights } = yard();
    const b = bakeWorld({ model: s, lights, width: 80, depth: 64 }, { topZ: 30, incline: 0.5 });
    // Ediciones: un hueco en el muro (deja pasar la luz de la antorcha al sur), media columna fuera y un bloque nuevo
    for (let z = 1; z <= 20; z++) for (let x = 36; x < 44; x++) for (let y = 30; y < 33; y++) s.set(x, y, z, 0);
    for (let z = 9; z <= 16; z++) for (let y = 12; y < 16; y++) for (let x = 50; x < 54; x++) s.set(x, y, z, 0);
    for (let z = 1; z <= 6; z++) for (let y = 50; y < 54; y++) for (let x = 20; x < 24; x++) s.set(x, y, z, material(0, 4));
    const r = rebakeChanged(b, lights);
    expect(r.chunks).toBeGreaterThan(0);
    expect(r.chunks).toBeLessThan(s.cols * s.rows);           // no todo
    same(b, bakeWorld({ model: s, lights, width: 80, depth: 64 }, { topZ: 30, incline: 0.5 }));
  });

  it('una sola edición alta (la parte de arriba de la columna): el recuadro llega hasta lo más alto', () => {
    const { s, lights } = yard();
    const b = bakeWorld({ model: s, lights, width: 80, depth: 64 }, { topZ: 30, incline: 0.5 });
    for (let z = 10; z <= 16; z++) for (let y = 12; y < 16; y++) for (let x = 50; x < 54; x++) s.set(x, y, z, 0);
    rebakeChanged(b, lights);
    same(b, bakeWorld({ model: s, lights, width: 80, depth: 64 }, { topZ: 30, incline: 0.5 }));
  });

  it('sin cambios no rehace nada; changedSince separa vóxeles de agua y entidades', () => {
    const { state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval');
    const v = state.version;
    expect(state.changedSince(v)).toEqual([]);
    for (let t = 0; t < 5; t++) state.step();                   // el agua de la fuente se mueve
    const water = state.changedSince(v);
    expect(water.length).toBeGreaterThan(0);
    expect(state.changedSince(v, 'voxels')).toEqual([]);         // pero ningún vóxel cambió
    const v2 = state.version;
    state.solid.set(100, 100, 5, material(0, 2));
    expect(state.changedSince(v2, 'voxels')).toEqual([state.solid.chunkOf(100, 100)]);
  });

  it('mover una entidad marca los trozos de donde sale y adonde llega', () => {
    const s = new StaticVoxels(structuredClone(PAL), 96, 96, -2, 10);
    const st = new WorldState(s, [], null);
    const body = { palette: PAL, get: () => 0, *entries() { yield [0, 0, 0, 1] as [number, number, number, number]; } };
    const id = st.entities.add({ model: body, x: 10, y: 10, z: 1 });
    const v = st.version;
    st.entities.move(id, 80, 80, 1);
    const ch = st.changedSince(v);
    expect(ch).toContain(s.chunkOf(10, 10));
    expect(ch).toContain(s.chunkOf(80, 80));
    expect(ch).not.toContain(s.chunkOf(48, 10));
  });
});

describe('rehorneado como trabajos (para la cola con presupuesto)', () => {
  function edited() {
    const { s, lights } = yard();
    const b = bakeWorld({ model: s, lights, width: 80, depth: 64 }, { topZ: 30, incline: 0.5 });
    const before = { rgba: b.rgba.slice(), weights: b.lights.map((l) => l.weight.slice()) };
    for (let z = 1; z <= 20; z++) for (let x = 36; x < 44; x++) for (let y = 30; y < 33; y++) s.set(x, y, z, 0);
    return { s, lights, b, before };
  }

  it('con el plazo siempre vencido avanzan un paso por llamada, y al acabar da lo mismo que hornear de cero', () => {
    const { s, lights, b } = edited();
    const jobs = rebakeChangedJobs(b, lights);
    expect(jobs.map((j) => j.key.split(':')[0])).toEqual(['rect', 'light']);
    let calls = 0;
    for (const j of jobs) while (!j.run(0)) calls++;
    expect(calls).toBeGreaterThan(5);                            // de verdad se trocea
    same(b, bakeWorld({ model: s, lights, width: 80, depth: 64 }, { topZ: 30, incline: 0.5 }));
  });

  it('mientras no acaban, lo publicado es lo viejo (nunca se ve medio recuadro ni media luz)', () => {
    const { lights, b, before } = edited();
    const [rect, light] = rebakeChangedJobs(b, lights);
    expect(light!.run(Infinity)).toBe(false);                    // la luz espera al recuadro y no toca nada
    expect(b.lights.map((l) => l.weight)).toEqual(before.weights);
    expect(rect!.run(0)).toBe(false);                            // un paso del recuadro
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(before.rgba.buffer))).toBe(true);
    while (!rect!.run(0)) { /* hasta acabar */ }
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(before.rgba.buffer))).toBe(false);   // ahora sí, de golpe
    expect(light!.run(0)).toBe(false);                           // la luz, por filas
    expect(b.lights.map((l) => l.weight)).toEqual(before.weights);
  });
});

