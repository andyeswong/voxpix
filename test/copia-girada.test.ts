// La copia girada por losas (StaticVoxels.copyRotatedSlabs, la de WorldView y prepareViewJob): la misma que copiar
// vóxel a vóxel con set, en los 4 giros, en un mundo con losas de un solo valor, de 1 byte con paleta y de 2 bytes, una
// cueva, un hoyo y una última losa más baja. Lo mismo vóxel a vóxel, en alturas, en la instantánea
// (exportChunks), en lo que recorre el render y en el horneado; y después de copiar, set sigue igual en las dos
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, ViewCamera, prepareViewJob, type Quarter } from '../src/world/view';
import { bakeWorld, rebakeChanged } from '../src/world/bake';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080', '#a0a0a0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const W = 64, D = 48, Z0 = -4, Z1 = 40;          // 4 x 3 trozos; losas de z -4..11, 12..27 y 28..40 (13 de alto)
const Q: Quarter[] = [0, 1, 2, 3];

// rare: valores de 1 a 400 en una caja (más de 256 distintos en una losa: la losa pasa a 2 bytes). Para comparar
// vóxeles, no para hornear
function world(rare: boolean): StaticVoxels {
  const s = new StaticVoxels(structuredClone(PAL), W, D, Z0, Z1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const top = 14 + ((x >> 3) + 2 * (y >> 3)) % 7;
    for (let z = Z0; z < top; z++) s.set(x, y, z, z < 12 ? material(0, 2) : material(1, 1 + ((x * 3 + y + z) % 4)));
  }
  for (let y = 20; y < 30; y++) for (let x = 5; x < 40; x++) for (let z = 2; z < 9; z++) s.set(x, y, z, 0);      // cueva
  for (let y = 4; y < 12; y++) for (let x = 44; x < 58; x++) for (let z = 10; z < 40; z++) s.set(x, y, z, 0);    // hoyo
  for (let z = 14; z < 38; z++) s.set(9, 40, z, material(0, 4));                                                     // torre alta (última losa)
  for (let y = 32; y < 48; y++) for (let x = 48; x < 64; x++) for (let z = Z0; z <= Z1; z++) s.set(x, y, z, material(0, 2));   // trozo macizo: todas sus losas de un valor
  if (rare) for (let z = 12; z < 20; z++) for (let y = 32; y < 48; y++) for (let x = 16; x < 32; x++) s.set(x, y, z, 1 + ((x * 7 + y * 13 + z) % 400));
  return s;
}
// La copia de siempre: vóxel a vóxel
function bySet(src: StaticVoxels, q: Quarter): StaticVoxels {
  const cam = new ViewCamera(q, src.width, src.depth);
  const s = new StaticVoxels(src.palette, cam.viewWidth, cam.viewDepth, src.zMin, src.zMax);
  for (const [x, y, z, v] of src.entries()) { const [vx, vy] = cam.cellToView(x, y); s.set(vx, vy, z, v); }
  return s;
}
function bySlabs(src: StaticVoxels, q: Quarter): StaticVoxels {
  const cam = new ViewCamera(q, src.width, src.depth);
  const s = new StaticVoxels(src.palette, cam.viewWidth, cam.viewDepth, src.zMin, src.zMax);
  s.copyRotatedSlabs(src, q, 0, src.cols * src.rows * src.nz);
  return s;
}
function expectSame(a: StaticVoxels, b: StaticVoxels, what: string): void {
  for (let z = a.zMin; z <= a.zMax; z++) for (let y = 0; y < a.depth; y++) for (let x = 0; x < a.width; x++) if (a.get(x, y, z) !== b.get(x, y, z)) expect(b.get(x, y, z), `${what}: ${x},${y},${z}`).toBe(a.get(x, y, z));
  expect(Array.from(b.height), `${what}: alturas`).toEqual(Array.from(a.height));
  expect(b.exportChunks().map((c) => c.data), `${what}: instantánea`).toEqual(a.exportChunks().map((c) => c.data));
  expect(b.size, `${what}: llenos`).toBe(a.size);
  expect(b.byteLength, `${what}: memoria`).toBe(a.byteLength);
  expect([...b.entries()], `${what}: entries`).toEqual([...a.entries()]);
  const walk = (s: StaticVoxels) => { const o: number[] = []; s.forEachExposed((x, y, z, v) => o.push(x, y, z, v)); return o; };
  expect(walk(b), `${what}: lo expuesto`).toEqual(walk(a));
}

describe('copia girada por losas', () => {
  for (const rare of [false, true]) it(`la misma que vóxel a vóxel en los 4 giros${rare ? ', con una losa de 2 bytes' : ''}; y set sigue igual después`, () => {
    const src = world(rare), before = src.exportChunks().map((c) => c.data);
    for (const q of Q) {
      const a = bySet(src, q), b = bySlabs(src, q);
      expectSame(a, b, `giro ${q}`);
      // Después de copiar: picar la cima de la torre y poner algo encima de todo, en las dos
      const cam = new ViewCamera(q, W, D), [tx, ty] = cam.cellToView(9, 40), [px, py] = cam.cellToView(50, 30);
      for (const s of [a, b]) { for (let z = 30; z < 38; z++) s.set(tx, ty, z, 0); s.set(px, py, Z1, material(0, 1)); s.set(px, py, Z1, 0); }
      expectSame(a, b, `giro ${q}, tras cambiar`);
      // Su reloj: lo cambiado después de la copia es más nuevo que todo lo copiado
      const v = b.clock;
      b.set(px, py, 30, material(0, 1));
      expect(b.changedSince(v)).toEqual([b.chunkOf(px, py)]);
    }
    expect(src.exportChunks().map((c) => c.data), 'cambiar la copia no toca el mundo').toEqual(before);
    // Ni al revés: un valor nuevo en una losa con paleta de la copia y otro en la misma losa del mundo
    const b = bySlabs(src, 1), [cx, cy] = new ViewCamera(1, W, D).cellToView(20, 20);
    b.set(cx, cy, 16, material(2, 4));
    src.set(20, 20, 16, material(2, 3));
    expect(b.get(cx, cy, 16)).toBe(material(2, 4));
    expect(src.get(20, 20, 16)).toBe(material(2, 3));
  });

  it('el horneado de la vista (WorldView y prepareViewJob) es el mismo que con la copia vóxel a vóxel', () => {
    const src = world(false);
    const st = new WorldState(src, [{ id: 't', kind: 'torch', x: 20.5, y: 24.5, z: 5, baked: true }], null);
    const opts = { topZ: 44, incline: 0.5, sky: true, outline: 'both' as const };
    for (const q of Q) {
      const view = new WorldView(st, q, { cut: true });
      const ref = new WorldView(new WorldState(bySet(src, q), [], null), 0);
      const lights = view.bakeable().lights;
      const a = bakeWorld({ ...ref.bakeable(), lights }, opts), b = bakeWorld(view.bakeable(), opts);
      expect(Buffer.from(b.rgba).equals(Buffer.from(a.rgba)), `giro ${q}`).toBe(true);
      expect(Buffer.from(b.depth.buffer).equals(Buffer.from(a.depth.buffer)), `giro ${q}: profundidad`).toBe(true);
      // Por partes, con el mundo cambiando a media copia: al ponerse al día, lo mismo que hornear de nuevo
      const st2 = new WorldState(world(false), [], null), prep = prepareViewJob(st2, q, opts, { cut: true });
      let calls = 0;
      while (!prep.job.run(0)) {
        if (calls === 3) for (let z = 14; z < 38; z++) st2.solid.set(9, 40, z, 0);              // a media copia
        if (prep.stage() === 'bake' && calls % 7 === 0) st2.solid.set(30, 10, 30, material(0, 1));
        calls++;
      }
      expect(calls).toBeGreaterThan(src.cols * src.rows * src.nz);                       // una losa por llamada con plazo 0
      const { view: v2, baked } = prep.result()!;
      rebakeChanged(baked, v2.frame().lights);
      const fresh = bakeWorld(new WorldView(st2, q, { cut: true }).bakeable(), opts);
      expect(Buffer.from(baked.rgba).equals(Buffer.from(fresh.rgba)), `giro ${q}, por partes`).toBe(true);
    }
  }, 60000);
});
