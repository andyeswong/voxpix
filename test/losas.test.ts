// Las losas de StaticVoxels (trozos partidos en altura), exposedEntries, la caja de lo cambiado y el rehorneado por
// esa caja. Juez de todo: un modelo de referencia (un Map) y hornear de cero, byte a byte.
import { describe, it, expect } from 'vitest';
import { material, render, type VoxelSource } from '../src/core';
import { StaticVoxels, CHUNK, LightList } from '../src/world/state';
import { bakeWorld, rebakeChanged, rebakeChangedJobs, type Baked } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';

const PAL = {
  ramps: Array.from({ length: 20 }, (_, r) => ({ name: `r${r}`, colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0', '#c0c0c0', '#d0d0d0', '#e0e0e0', '#e8e8e8', '#f0f0f0', '#f4f4f4', '#f8f8f8', '#fafafa', '#fcfcfc', '#fdfdfd', '#fefefe'] })),
};
let seed = 11;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
const k = (x: number, y: number, z: number) => `${x},${y},${z}`;

// La columna entera de un trozo como la guardaba StaticVoxels antes de las losas: (z * CHUNK + y) * CHUNK + x
function oldColumn(ref: Map<string, number>, s: StaticVoxels, c: number): Uint16Array {
  const col = new Uint16Array(CHUNK * CHUNK * s.zh), cx = (c % s.cols) * CHUNK, cy = Math.floor(c / s.cols) * CHUNK;
  for (let z = s.zMin; z <= s.zMax; z++) for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) col[((z - s.zMin) * CHUNK + y) * CHUNK + x] = ref.get(k(cx + x, cy + y, z)) ?? 0;
  return col;
}

describe('losas de StaticVoxels', () => {
  it('get, set, entries, size y exportChunks dan lo mismo que una referencia, con losas vacías, llenas, de 1 y de 2 bytes', () => {
    const s = new StaticVoxels(PAL, 40, 36, -3, 37);              // 41 de alto: 3 losas, la última de 9
    const ref = new Map<string, number>();
    const put = (x: number, y: number, z: number, v: number) => { s.set(x, y, z, v); if (v) ref.set(k(x, y, z), v); else ref.delete(k(x, y, z)); };
    // Una losa entera de un solo valor (se queda sin datos), otra llena de dos valores, y la última (baja) entera
    for (let z = -3; z < 13; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) put(x, y, z, material(1, 2));
    for (let z = 13; z < 29; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) put(x, y, z, material((x + z) % 2, 3));
    for (let z = 29; z <= 37; z++) for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) put(x, y, z, material(4, 1));
    // Más de 256 valores distintos en una losa: pasa a 2 bytes por vóxel
    for (let i = 0; i < 300; i++) put(20 + (i % 16), 2 + Math.floor(i / 16) % 14, -3 + Math.floor(i / 224), material(Math.floor(i / 16), i % 16));
    // Ruido: escrituras y borrados sueltos por todo el mundo (también vaciar una losa entera)
    for (let i = 0; i < 4000; i++) put(rnd(40), rnd(36), -3 + rnd(41), rnd(3) ? 0 : material(rnd(20), rnd(16)));
    for (let z = -3; z < 13; z++) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) put(x, y, z, 0);
    for (let z = -3; z <= 37; z++) for (let y = 0; y < 36; y++) for (let x = 0; x < 40; x++) expect(s.get(x, y, z)).toBe(ref.get(k(x, y, z)) ?? 0);
    expect(s.size).toBe(ref.size);
    const ent = [...s.entries()];
    expect(ent.length).toBe(ref.size);
    for (const [x, y, z, v] of ent) expect(ref.get(k(x, y, z))).toBe(v);
    // El orden de siempre: trozo, z, y, x
    const order = (e: readonly number[]) => [Math.floor(e[1]! / CHUNK) * s.cols + Math.floor(e[0]! / CHUNK), e[2]!, e[1]!, e[0]!];
    for (let i = 1; i < ent.length; i++) {
      const a = order(ent[i - 1]!), b = order(ent[i]!);
      const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!;
      expect(cmp).toBeLessThan(0);
    }
    // exportChunks: la columna entera de siempre (la huella y la instantánea no cambian)
    const ex = s.exportChunks();
    for (let c = 0; c < ex.length; c++) if (ex[c]!.data) expect(ex[c]!.data).toEqual(oldColumn(ref, s, c));
    // Y de vuelta
    const t = new StaticVoxels(PAL, 40, 36, -3, 37);
    t.importChunks(ex);
    for (let z = -3; z <= 37; z++) for (let y = 0; y < 36; y++) for (let x = 0; x < 40; x++) expect(t.get(x, y, z)).toBe(ref.get(k(x, y, z)) ?? 0);
    expect(t.size).toBe(ref.size);
    expect(t.exportChunks()).toEqual(ex);
  });

  it('un trozo que tuvo vóxeles y se vació se exporta como antes (la columna a ceros, no null)', () => {
    const s = new StaticVoxels(PAL, 32, 32, 0, 20);
    s.set(3, 3, 3, material(0, 1)); s.set(3, 3, 3, 0);
    const ex = s.exportChunks();
    expect(ex[0]!.data).toEqual(new Uint16Array(CHUNK * CHUNK * 21));
    expect(ex[1]!.data).toBeNull();
  });

  it('un terreno macizo ocupa poco: la roca de un solo valor no guarda datos', () => {
    const s = new StaticVoxels(PAL, 128, 128, 0, 191);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) for (let z = 0; z < 96; z++) s.set(x, y, z, material(0, z < 90 ? 1 : 2));
    // 96 de alto lleno = 6 losas por trozo: 5 de roca sin datos y la de arriba con dos valores (1 byte por vóxel)
    expect(s.byteLength).toBeLessThan(128 * 128 * 16 + 300_000);
  });
});

describe('exposedEntries', () => {
  it('da todos los vóxeles con alguna cara al aire, en el orden de entries, y el render da los mismos píxeles', () => {
    const s = new StaticVoxels(PAL, 48, 48, 0, 47);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
      const h = 20 + ((x * 7 + y * 3) % 13);
      for (let z = 0; z < h; z++) s.set(x, y, z, material((z >> 3) % 3, 2));
    }
    for (let z = 10; z < 30; z++) for (let y = 20; y < 26; y++) for (let x = 5; x < 40; x++) s.set(x, y, z, 0);   // un túnel
    const all = [...s.entries()], exp = [...s.exposedEntries()];
    expect(exp.length).toBeLessThan(all.length);
    const inExp = new Set(exp.map(([x, y, z]) => k(x, y, z)));
    const D = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [x, y, z] of all) if (D.some(([a, b, c]) => !s.get(x + a!, y + b!, z + c!))) expect(inExp.has(k(x, y, z))).toBe(true);
    const pos = new Map(all.map(([x, y, z], i) => [k(x, y, z), i]));
    for (let i = 1; i < exp.length; i++) expect(pos.get(k(exp[i]![0], exp[i]![1], exp[i]![2]))! > pos.get(k(exp[i - 1]![0], exp[i - 1]![1], exp[i - 1]![2]))!).toBe(true);
    // forEachExposed da lo mismo que exposedEntries, y con un rango de z, lo mismo filtrado
    const seen: number[][] = [];
    s.forEachExposed((x, y, z, v) => seen.push([x, y, z, v]));
    expect(seen).toEqual(exp);
    const band: number[][] = [];
    s.forEachExposed((x, y, z, v) => band.push([x, y, z, v]), { x0: 3, y0: 5, x1: 30, y1: 40, z0: 14, z1: 33 });
    expect(band).toEqual(exp.filter(([x, y, z]) => x! >= 3 && x! <= 30 && y! >= 5 && y! <= 40 && z! >= 14 && z! <= 33));
    const plain: VoxelSource = { palette: s.palette, get: (x, y, z) => s.get(x, y, z), entries: () => s.entries() };
    for (const opt of [{ yaw: 0 }, { yaw: 37, smooth: 0.6, outline: 'both' as const }]) {
      const o = { width: 160, height: 140, originX: 40, originY: 110, oblique: { y: 0.5, z: 1 }, pivot: [0, 0, 0] as [number, number, number], ao: true, pick: true, ...opt };
      const a = render(s, o), b = render(plain, o);
      expect(Buffer.from(a.rgba.buffer).equals(Buffer.from(b.rgba.buffer))).toBe(true);
      expect(a.depth).toEqual(b.depth);
    }
  });
});

describe('la caja de lo cambiado y el rehorneado por caja', () => {
  it('changedBox cubre lo cambiado desde una versión; tras cut() la caja nueva es solo lo nuevo', () => {
    const s = new StaticVoxels(PAL, 32, 32, 0, 63);
    s.set(1, 1, 1, material(0, 1));
    const v = s.clock;
    s.cut();                                                      // quien lee hasta v corta: lo de después, aparte
    s.set(4, 5, 40, material(0, 1)); s.set(6, 2, 30, material(0, 1));
    expect(s.changedBox(0, v)).toEqual({ x0: 4, y0: 2, z0: 30, x1: 6, y1: 5, z1: 40 });
    expect(s.changedBox(0, 0)).toEqual({ x0: 1, y0: 1, z0: 1, x1: 6, y1: 5, z1: 40 });
    expect(s.changedBox(1, 0)).toBeNull();
    s.cut();
    const v2 = s.clock;
    s.set(9, 9, 9, material(0, 1));
    expect(s.changedBox(0, v2)).toEqual({ x0: 9, y0: 9, z0: 9, x1: 9, y1: 9, z1: 9 });
    // Muchos tramos: se funden los viejos, y la caja desde 0 sigue cubriéndolo todo
    for (let i = 0; i < 10; i++) { s.cut(); s.set(2 + i, 3, 50 + i, material(0, 1)); }
    expect(s.changedBox(0, 0)).toEqual({ x0: 1, y0: 1, z0: 1, x1: 11, y1: 9, z1: 59 });
  });

  function terrain(): { s: StaticVoxels; lights: WorldLight[] } {
    const s = new StaticVoxels(PAL, 96, 96, 0, 95);
    for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) {
      const h = 40 + 8 * (((x >> 3) + (y >> 3)) % 3);
      for (let z = 0; z < h; z++) s.set(x, y, z, material(z < h - 8 ? 0 : 1, 1 + ((x + y + z) % 3)));
    }
    return { s, lights: [{ id: 'a', kind: 'torch', x: 48, y: 48, z: 70, baked: true }, { id: 'b', kind: 'torch', x: 30, y: 60, z: 66, baked: true }] };
  }
  const same = (a: Baked, b: Baked) => {
    expect(Buffer.from(a.rgba.buffer).equals(Buffer.from(b.rgba.buffer))).toBe(true);
    expect(a.depth).toEqual(b.depth);
    expect(a.face).toEqual(b.face);
    expect(a.lights.map((l) => [l.light.id, l.rect])).toEqual(b.lights.map((l) => [l.light.id, l.rect]));
    for (let i = 0; i < a.lights.length; i++) expect(a.lights[i]!.weight).toEqual(b.lights[i]!.weight);
  };

  for (const outline of ['none', 'both'] as const) it(`picar y poner bloques de 8 en un terreno alto: el recuadro es pequeño y da lo mismo que hornear de cero (contorno ${outline})`, () => {
    const { s, lights } = terrain();
    const opts = { topZ: 95, incline: 0.5, outline };
    const b = bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts);
    const block = (bx: number, by: number, bz: number, v: number) => { for (let z = bz; z < bz + 8; z++) for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 8; x++) s.set(x, y, z, v); };
    // Picar uno, rehornear; picar el de debajo y poner uno al lado, rehornear; y otra vez sin cambios
    block(40, 40, 40, 0);                                        // la columna (40, 40) tiene 48 de alto
    const jobs = rebakeChangedJobs(b, lights);
    const rect = jobs.find((j) => j.key.startsWith('rect:'))!.key.slice(5).split(',').map(Number);
    expect(rect[3]! - rect[1]!).toBeLessThan(40);                // filas: el bloque y su margen, no toda la altura
    for (const j of jobs) while (!j.run(Infinity)) { /* */ }
    same(b, bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts));
    block(40, 40, 32, 0); block(48, 40, 56, material(1, 2));
    rebakeChanged(b, lights);
    same(b, bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts));
    expect(rebakeChanged(b, lights).chunks).toBe(0);
  });

  it('una luz con el mismo id pero otra intensidad no reaprovecha sus pesos viejos', () => {
    const { s, lights } = terrain();
    const opts = { topZ: 95, incline: 0.5 };
    const b = bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts);
    const changed: WorldLight[] = [{ ...lights[0]!, intensity: 0.4 }, lights[1]!];
    for (let z = 40; z < 48; z++) s.set(44, 44, z, 0);
    rebakeChanged(b, changed);
    same(b, bakeWorld({ model: s, lights: changed, width: 96, depth: 96 }, opts));
  });

  it('dos horneados del mismo mundo a versiones distintas: cada uno recoge su caja', () => {
    const { s, lights } = terrain();
    const opts = { topZ: 95, incline: 0.5 };
    const a = bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts);
    for (let z = 40; z < 48; z++) s.set(10, 10, z, 0);
    const b = bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts);
    rebakeChanged(b, lights);                                     // b corta los tramos; a sigue atrás
    for (let z = 40; z < 48; z++) s.set(70, 70, z, 0);
    rebakeChanged(a, lights); rebakeChanged(b, lights);
    const fresh = bakeWorld({ model: s, lights, width: 96, depth: 96 }, opts);
    same(a, fresh); same(b, fresh);
  });
});

describe('luces fijas puestas y quitadas en partida', () => {
  function ground(): StaticVoxels {
    const s = new StaticVoxels(PAL, 64, 64, 0, 47);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 16 + ((x >> 3) % 2) * 8; z++) s.set(x, y, z, material(0, 2));
    return s;
  }
  const weights = (b: Baked) => b.lights.map((l) => [l.light.id, l.rect, Array.from(l.weight)]);

  it('addFixed se hornea sin cambiar vóxeles, una sola vez aunque se pida cada cuadro; removeFixed la deshornea', () => {
    const s = ground();
    const ls = new LightList();
    ls.addFixed({ id: 'a', kind: 'torch', x: 20, y: 20, z: 30 });
    const opts = { topZ: 47, incline: 0.5 };
    const b = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts);
    expect(rebakeChangedJobs(b, ls)).toEqual([]);
    const id = ls.addFixed({ kind: 'lamp', x: 44, y: 40, z: 28 });
    const jobs = rebakeChangedJobs(b, ls);
    expect(jobs.map((j) => j.key)).toEqual([`light:${id}`]);
    expect(rebakeChangedJobs(b, ls)).toEqual([]);              // el cuadro siguiente: ya se está horneando
    for (const j of jobs) while (!j.run(Infinity)) { /* */ }
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts)));
    ls.removeFixed('a');
    expect(rebakeChangedJobs(b, ls)).toEqual([]);
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts)));
  });

  it('una fija quitada antes de acabar de hornearse no se publica', () => {
    const s = ground();
    const ls = new LightList();
    const b = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, { topZ: 47, incline: 0.5 });
    const id = ls.addFixed({ kind: 'torch', x: 30, y: 30, z: 30 });
    const jobs = rebakeChangedJobs(b, ls);
    ls.removeFixed(id);
    expect(rebakeChangedJobs(b, ls)).toEqual([]);
    for (const j of jobs) while (!j.run(Infinity)) { /* */ }
    expect(b.lights).toEqual([]);
  });

  it('poner una antorcha (vóxeles y luz fija a la vez) y quitarla da lo mismo que hornear de cero', () => {
    const s = ground();
    const ls = new LightList();
    ls.addFixed({ id: 'a', kind: 'torch', x: 20, y: 20, z: 30 });
    const opts = { topZ: 47, incline: 0.5 };
    const b = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts);
    for (let z = 24; z < 28; z++) s.set(40, 40, z, material(1, 3));
    const id = ls.addFixed({ kind: 'torch', x: 40.5, y: 40.5, z: 30 });
    rebakeChanged(b, ls);
    const fresh = bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts);
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(fresh.rgba.buffer))).toBe(true);
    expect(weights(b).sort()).toEqual(weights(fresh).sort());
    for (let z = 24; z < 28; z++) s.set(40, 40, z, 0);
    ls.removeFixed(id);
    rebakeChanged(b, ls);
    expect(weights(b)).toEqual(weights(bakeWorld({ model: s, lights: ls, width: 64, depth: 64 }, opts)));
  });
});
