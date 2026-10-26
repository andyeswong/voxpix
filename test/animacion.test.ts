// Animación: el formato (versión 2 solo con cuadros o rig; sin ellos, los bytes de siempre) y el rig guardable
import { describe, it, expect } from 'vitest';
import { Model, box, material, animationToFile, animationFromFile, type ModelFile } from '../src/core';
import { rigFrames, rigFromSpec, type Rig, type RigSpec, type RigFrame } from '../src/anim/rig';
import { medievalScene } from '../src/samples/medieval';

describe('el formato con cuadros', () => {
  it('sin animación se guarda con los mismos bytes que antes (versión 1)', () => {
    const m = medievalScene().model;
    expect(JSON.stringify(animationToFile([{ model: m, ms: 100 }]))).toBe(JSON.stringify(m.toJSON()));
    expect(animationToFile([{ model: m, ms: 100 }]).version).toBe(1);
  });

  it('con cuadros sube a la versión 2, el cuadro 0 sigue en voxels, y vuelve igual', () => {
    const a = medievalScene().model, b = a.clone();
    b.set(0, 0, 20, material(0, 1));
    const f = animationToFile([{ model: a, ms: 120 }, { model: b, ms: 80 }], { parts: [], frames: [], frameMs: 100 });
    expect(f.version).toBe(2);
    // Quien lea la versión 1 ve el primer cuadro
    expect(JSON.stringify(Model.fromJSON(f as unknown as ModelFile).toJSON().voxels)).toBe(JSON.stringify(a.toJSON().voxels));
    const back = animationFromFile(JSON.parse(JSON.stringify(f)));
    expect(back.frames.map((x) => x.ms)).toEqual([120, 80]);
    expect(back.frames[1]!.model.get(0, 0, 20)).toBe(material(0, 1));
    expect(back.frames[0]!.model.get(0, 0, 20)).toBe(0);
    expect(back.frames[1]!.model.palette).toBe(back.frames[0]!.model.palette);   // una sola paleta
    expect(back.rig).toEqual({ parts: [], frames: [], frameMs: 100 });
    // Y un archivo de la versión 1 se carga como un cuadro
    expect(animationFromFile(a.toJSON()).frames.length).toBe(1);
  });
});

describe('el rig guardable (RigSpec)', () => {
  // Un bicho de dos patas: el cuerpo arriba y dos patas debajo (x = -3 y x = 3), las patas de la rampa 1
  function bug(): Model {
    const m = new Model({ ramps: [{ name: 'cuerpo', colors: ['#202020', '#606060', '#a0a0a0'] }, { name: 'pata', colors: ['#400000', '#800000'] }] });
    box(m, -4, -2, 4, 4, 2, 7, material(0, 1));
    box(m, -3, 0, 0, -3, 0, 3, material(1, 1));
    box(m, 3, 0, 0, 3, 0, 3, material(1, 1));
    return m;
  }
  it('da los mismos cuadros que el rig equivalente escrito en código', () => {
    const frames: RigFrame[] = [{ moves: { L: { stride: 1 }, R: { stride: -1 } } }, { moves: { R: { dz: 1 } } }, { moves: { L: { stride: -1 }, R: { stride: 1 } } }];
    const code: Rig = { frameMs: 100, frames, parts: [
      { name: 'L', has: (x, _y, z) => x < 0 && z <= 3, pivotZ: 3, footZ: 0 },
      { name: 'R', has: (x, _y, z) => x > 0 && z <= 3, pivotZ: 3, footZ: 0 },
    ] };
    const spec: RigSpec = { frameMs: 100, frames, parts: [
      { name: 'L', boxes: [[-9, -9, 0, -1, 9, 3]], ramps: [1], pivotZ: 3, footZ: 0 },
      { name: 'R', boxes: [[1, -9, 0, 9, 9, 3]], ramps: [1], pivotZ: 3, footZ: 0 },
    ] };
    const a = rigFrames(bug(), code), b = rigFrames(bug(), rigFromSpec(JSON.parse(JSON.stringify(spec))));
    expect(b.map((m) => JSON.stringify(m.toJSON().voxels))).toEqual(a.map((m) => JSON.stringify(m.toJSON().voxels)));
    expect(JSON.stringify(a[0]!.toJSON().voxels)).not.toBe(JSON.stringify(bug().toJSON().voxels));   // y se mueven de verdad
  });
  it('una parte sin nombre (o llamada body) falla con su motivo', () => {
    expect(() => rigFromSpec({ frameMs: 100, frames: [], parts: [{ name: 'body' }] })).toThrow(/nombre/);
  });

  // Los tres casos que pidió FERN, con formas genéricas: límites abiertos, una parte como unión de cajas, y el cuerpo
  // que se mueve. Cada uno, el mismo resultado escrito con has() y como RigSpec (ida y vuelta por JSON)
  const same = (base: Model, code: Rig, spec: RigSpec) => {
    const a = rigFrames(base, code), b = rigFrames(base, rigFromSpec(JSON.parse(JSON.stringify(spec))));
    expect(b.map((m) => JSON.stringify(m.toJSON().voxels))).toEqual(a.map((m) => JSON.stringify(m.toJSON().voxels)));
    return a;
  };
  const pal = { ramps: [{ name: 'a', colors: ['#202020', '#606060', '#a0a0a0'] }] };

  it('límites abiertos (null): un compás cuyas patas siguen valiendo aunque el modelo crezca', () => {
    const m = new Model(structuredClone(pal));
    box(m, -9, -1, 8, 9, 1, 10, material(0, 1));                 // la cabeza, ancha
    box(m, -9, 0, 0, -6, 0, 7, material(0, 2)); box(m, 6, 0, 0, 9, 0, 7, material(0, 2));
    const frames: RigFrame[] = [{ moves: { L: { stride: 1 }, R: { stride: -1 } } }, { moves: { R: { dz: 1 } } }];
    same(m, { frameMs: 110, frames, parts: [
      { name: 'L', has: (x, _y, z) => x <= -5 && z <= 7, pivotZ: 7, footZ: 0 },
      { name: 'R', has: (x, _y, z) => x >= 5 && z <= 7, pivotZ: 7, footZ: 0 },
    ] }, { frameMs: 110, frames, parts: [
      { name: 'L', boxes: [[null, null, null, -5, null, 7]], pivotZ: 7, footZ: 0 },
      { name: 'R', boxes: [[5, null, null, null, null, 7]], pivotZ: 7, footZ: 0 },
    ] });
  });

  it('una parte es la unión de sus cajas: un trípode (patas alternas de un insecto)', () => {
    const m = new Model(structuredClone(pal));
    box(m, -3, -4, 3, 3, 4, 5, material(0, 1));
    for (const y of [-3, 0, 3]) { box(m, -6, y, 0, -4, y, 2, material(0, 2)); box(m, 4, y, 0, 6, y, 2, material(0, 2)); }
    const tripodA = (x: number, y: number) => (x < 0 ? Math.abs(y) >= 2 : Math.abs(y) < 2);
    const frames: RigFrame[] = [{ moves: { A: { dz: 1, dy: -1 } } }, { moves: { B: { dz: 1, dy: -1 } } }];
    same(m, { frameMs: 80, frames, parts: [
      { name: 'A', has: (x, y, z) => z <= 2 && Math.abs(x) >= 4 && tripodA(x, y), pivotZ: 2, footZ: 0 },
      { name: 'B', has: (x, y, z) => z <= 2 && Math.abs(x) >= 4 && !tripodA(x, y), pivotZ: 2, footZ: 0 },
    ] }, { frameMs: 80, frames, parts: [
      { name: 'A', boxes: [[null, 2, null, -4, null, 2], [null, null, null, -4, -2, 2], [4, -1, null, null, 1, 2]], pivotZ: 2, footZ: 0 },
      { name: 'B', boxes: [[null, -1, null, -4, 1, 2], [4, 2, null, null, null, 2], [4, null, null, null, -2, 2]], pivotZ: 2, footZ: 0 },
    ] });
  });

  it('el cuerpo (body) también se mueve: una taza que salta', () => {
    const m = new Model(structuredClone(pal));
    box(m, -3, -3, 0, 3, 3, 7, material(0, 1));
    const frames: RigFrame[] = [{ moves: { body: { dz: 1 }, top: { dz: 2 } } }, { moves: {} }];
    const out = same(m, { frameMs: 120, frames, parts: [{ name: 'top', has: (_x, _y, z) => z >= 6 }] },
      { frameMs: 120, frames, parts: [{ name: 'top', boxes: [[null, null, 6, null, null, null]] }] });
    expect(out[0]!.get(0, 0, 0)).toBe(0);                          // el cuerpo subió 1
    expect(out[0]!.get(0, 0, 1)).toBe(material(0, 1));
  });

  it('si dos partes piden el mismo vóxel, es de la PRIMERA (como con has())', () => {
    const m = new Model(structuredClone(pal));
    box(m, 0, 0, 0, 0, 0, 3, material(0, 1));
    const spec: RigSpec = { frameMs: 100, frames: [{ moves: { P: { dx: 2 }, Q: { dx: -2 } } }], parts: [
      { name: 'P', boxes: [[0, 0, 0, 0, 0, 2]] }, { name: 'Q', boxes: [[0, 0, 1, 0, 0, 3]] },   // se solapan en z = 1..2
    ] };
    const [f] = rigFrames(m, rigFromSpec(spec));
    for (const z of [0, 1, 2]) expect(f!.get(2, 0, z), `z ${z}`).toBe(material(0, 1));   // P (la primera) se los queda
    expect(f!.get(-2, 0, 3)).toBe(material(0, 1));                  // a Q solo le queda z = 3
  });
});
