// LevelPathField: varios suelos por celda (la superficie y un túnel debajo), bajar por un pozo si maxDrop deja, no
// atravesar el techo del túnel, no subir por el pozo con un step pequeño, y un pozo nuevo (picado en partida, por
// watchChanges) que acorta el camino
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { LevelPathField } from '../src/world/levelpaths';
import { Runtime } from '../src/runtime/runtime';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }] };
// Roca hasta z = 40; un túnel este-oeste (y 20..27, z 16..31, x 4..59) y un pozo a él en x 52..59 (z 32..39)
function world(): WorldState {
  const s = new StaticVoxels(PAL, 64, 48, 0, 63);
  for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 40; z++) {
    const tunnel = y >= 20 && y < 28 && x >= 4 && x < 60 && z >= 16 && z < 32;
    const shaft = y >= 20 && y < 28 && x >= 52 && x < 60 && z >= 32;
    if (!tunnel && !shaft) s.set(x, y, z, material(0, 1));
  }
  return new WorldState(s, [], null);
}
const O = { cell: 4, radius: 1, height: 12, step: 2 };

describe('caminos por niveles', () => {
  it('los suelos de cada celda: encima del túnel, dos; fuera, uno', () => {
    const f = new LevelPathField(world(), O);
    expect(f.floorsAt({ x: 22, y: 22 })).toEqual([40, 16]);
    expect(f.floorsAt({ x: 22, y: 10 })).toEqual([40]);
    expect(f.floorsAt({ x: 54, y: 22 })).toEqual([16]);          // el pozo: abajo
    f.close();
  });

  it('de la superficie al túnel: por el pozo si se puede caer 24; sin atravesar el techo; con maxDrop 8, no', () => {
    const st = world();
    const f = new LevelPathField(st, O);
    const p = f.path({ x: 10, y: 10, z: 40 }, { x: 10, y: 22, z: 16 })!;
    expect(p).not.toBeNull();
    const firstDown = p.findIndex((q) => q.z === 16);
    expect(p[firstDown]!.x).toBeGreaterThanOrEqual(52);           // entra por el pozo, no por encima del túnel
    expect(p.at(-1)).toMatchObject({ z: 16 });
    f.close();
    const g = new LevelPathField(st, { ...O, maxDrop: 8 });
    expect(g.path({ x: 10, y: 10, z: 40 }, { x: 10, y: 22, z: 16 })).toBeNull();
    g.close();
  });

  it('del túnel a la superficie: por el pozo no se sube con step 2; con step 24, sí', () => {
    const st = world();
    const f = new LevelPathField(st, O);
    expect(f.path({ x: 10, y: 22, z: 16 }, { x: 10, y: 10, z: 40 })).toBeNull();
    expect(f.dir({ x: 10, y: 22, z: 16 }, { x: 10, y: 10, z: 40 })).toBeNull();
    f.close();
    const g = new LevelPathField(st, { ...O, step: 24 });
    expect(g.path({ x: 10, y: 22, z: 16 }, { x: 10, y: 10, z: 40 })).not.toBeNull();
    g.close();
  });

  it('un pozo nuevo, picado en partida, acorta el camino sin rehacer el campo', () => {
    const st = world();
    const f = new LevelPathField(st, O);
    const long = f.path({ x: 10, y: 10, z: 40 }, { x: 10, y: 22, z: 16 })!.length;
    for (let z = 32; z < 40; z++) for (let y = 20; y < 28; y++) for (let x = 8; x < 16; x++) st.solid.set(x, y, z, 0);
    const short = f.path({ x: 10, y: 10, z: 40 }, { x: 10, y: 22, z: 16 })!;
    expect(short.length).toBeLessThan(long);
    expect(short.find((q) => q.z === 16)!.x).toBeLessThan(20);
    const d = f.dir({ x: 10, y: 10, z: 40 }, { x: 10, y: 22, z: 16 })!;
    expect(d.y).toBeGreaterThan(0.7);
    f.close();
  });
  it('un cuerpo más ancho que media celda: la celda junto a la cara de un escalón tiene suelo y el escalón se sube', () => {
    // 128 x 128, suelo en z 16, y un escalón de un bloque (z 16..23) desde y 104
    const s = new StaticVoxels(PAL, 128, 128, 0, 63);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let z = 0; z < (y >= 104 ? 24 : 16); z++) s.set(x, y, z, material(0, 1));
    const st = new WorldState(s, [], null);
    for (const radius of [1, 2, 3]) {
      const f = new LevelPathField(st, { cell: 4, height: 14, step: 8, radius });
      expect(f.floorsAt({ x: 34, y: 101 })).toEqual([16]);          // la celda de y 100..103, pegada a la cara
      const p = f.path({ x: 34, y: 34, z: 16 }, { x: 34, y: 116, z: 24 });
      expect(p).not.toBeNull();
      expect(p!.at(-1)!.z).toBe(24);
      f.close();
    }
  });

  it('con un cuerpo que cabe centrado en la celda (radius 1, cell 4), no se corre: una columna suelta junto al centro quita el suelo (y con uno que sobresale, sí)', () => {
    const s = new StaticVoxels(PAL, 32, 32, 0, 31);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let z = 0; z < 8; z++) s.set(x, y, z, material(0, 1));
    for (let z = 8; z < 20; z++) s.set(11, 10, z, material(0, 1));   // junto al centro (10, 10) de la celda (2, 2)
    const st = new WorldState(s, [], null);
    const f = new LevelPathField(st, { cell: 4, height: 14, step: 2, radius: 1 });
    expect(f.floorsAt({ x: 10, y: 10 })).toEqual([]);
    f.close();
    // Con radius 3 (sobresale de la celda), corrido hacia una esquina la esquiva: hay suelo
    const g = new LevelPathField(st, { cell: 4, height: 14, step: 2, radius: 3 });
    expect(g.floorsAt({ x: 10, y: 10 })).toEqual([8]);
    g.close();
  });

  // dir tiene que llevar a donde se miró que cabe el cuerpo, no al centro de la celda. Con el runtime de verdad y un
  // cuerpo de radio 3 (7 columnas): por un hueco de 8 con celdas de 4, donde solo cabe corrido; y por uno de 7 justo con
  // celdas de 8, donde cabe centrado sin holgura (el centro de una celda par es el borde de su columna central)
  for (const [cell, x0, label] of [[4, 40, 'solo cabe corrido'], [8, 41, 'cabe justo centrado']] as const) it(`por un hueco donde el cuerpo ${label}: dir lleva a donde cabe y el runtime pasa`, () => {
    const s = new StaticVoxels(PAL, 64, 64, 0, 63);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      for (let z = 0; z < 8; z++) s.set(x, y, z, material(0, 1));
      // la pared: y 28..35, z 8..23, salvo el hueco x0..47
      if (y >= 28 && y < 36 && (x < x0 || x >= 48)) for (let z = 8; z < 24; z++) s.set(x, y, z, material(0, 1));
    }
    const st = new WorldState(s, [], null);
    const f = new LevelPathField(st, { cell, radius: 3, height: 12, step: 2 });
    const rt = new Runtime(st, { x: 20.5, y: 12.5 }, { radius: 3, speed: 30 });
    const to = { x: 44, y: 52, z: 8 };
    let ticks = 0;
    for (; ticks < 600; ticks++) {
      const p = rt.player;
      if (Math.hypot(to.x - p.x, to.y - p.y) <= 2) break;
      const d = f.dir(p, to, 0);
      if (!d) break;
      rt.step({ dx: d.x, dy: d.y, stomp: false });
    }
    expect(rt.player.y).toBeGreaterThan(36);                       // al otro lado de la pared
    // Llegó: a 2 de la meta, o en su celda (ahí dir ya da null)
    const sameCell = Math.floor(rt.player.x / cell) === Math.floor(to.x / cell) && Math.floor(rt.player.y / cell) === Math.floor(to.y / cell);
    expect(sameCell || Math.hypot(to.x - rt.player.x, to.y - rt.player.y) <= 2).toBe(true);
    // Los puntos del camino por el hueco: donde el cuerpo cabe (sus 7 columnas, de x - 3 a x + 3, dentro del hueco)
    const gap = f.path({ x: 20.5, y: 12.5, z: 8 }, to)!.filter((q) => q.y >= 28 && q.y < 36);
    expect(gap.length).toBeGreaterThan(0);
    for (const q of gap) { expect(Math.floor(q.x) - 3).toBeGreaterThanOrEqual(x0); expect(Math.floor(q.x) + 3).toBeLessThan(48); }
    f.close();
  });
});
