// Lo precalentado se repone al recuperar la GPU un contexto perdido (WarmMemory, en GpuPath): cada lista una vez, con
// el horneado y las opciones del último cuadro si lo hubo, y los mismos sprites que el prewarm de antes
import { describe, it, expect } from 'vitest';
import { Model, material, box } from '../../src/core';
import { WarmMemory, type WarmItem } from '../../src/view/compositor';
import type { Baked } from '../../src/world/bake';
import type { Frame2DOptions } from '../../src/world/frame2d';

const PAL = { ramps: [{ name: 'a', colors: ['#202020', '#606060', '#a0a0a0'] }] };
const m = (n: number) => { const x = new Model(PAL, `m${n}`); box(x, 0, 0, 0, n, n, n, material(0, 1)); return x; };
const bakedA = { id: 'A' } as unknown as Baked, bakedB = { id: 'B' } as unknown as Baked;
const opts = (vx: number) => ({ vx, vy: 0, vw: 10, vh: 10, time: 0, lights: true, ambient: [1, 1, 1] }) as Frame2DOptions;
// Un compositor de mentira que apunta lo que le piden
const target = () => {
  const got: Array<{ b: Baked; o: Frame2DOptions; models: unknown[]; yaws: Array<readonly number[] | undefined>; casts: unknown[] }> = [];
  return { got, prewarm: (b: Baked, o: Frame2DOptions, list: readonly WarmItem[]) => { got.push({ b, o, models: list.map((i) => i.model), yaws: list.map((i) => i.yaws), casts: list.map((i) => i.casts) }); return 0; } };
};

describe('lo precalentado, al recuperar el contexto', () => {
  it('se repone cada lista una vez, con sus modelos, rumbos y sombras', () => {
    const w = new WarmMemory(), walk = [m(2), m(3)], enemy = [m(4)];
    w.record(bakedA, opts(0), walk.map((model) => ({ model, casts: true })));
    w.record(bakedA, opts(0), walk.map((model) => ({ model, casts: true })));          // la misma otra vez: no se duplica
    w.record(bakedA, opts(0), enemy.map((model) => ({ model, yaws: [0, 90] })));
    expect(w.size).toBe(3);
    const t = target();
    expect(w.replay(t)).toBe(0);
    expect(t.got.map((g) => g.models)).toEqual([walk, enemy]);
    expect(t.got.map((g) => g.casts)).toEqual([[true, true], [undefined]]);
    expect(t.got[1]!.yaws).toEqual([[0, 90]]);
    expect(t.got.every((g) => g.b === bakedA)).toBe(true);
  });

  it('con el horneado y las opciones del último cuadro (si cambió el nivel, los de ahora)', () => {
    const w = new WarmMemory();
    w.record(bakedA, opts(0), [{ model: m(2) }]);
    w.saw(bakedB, opts(40));
    const t = target();
    w.replay(t);
    expect(t.got[0]!.b).toBe(bakedB);
    expect(t.got[0]!.o.vx).toBe(40);
  });

  it('sin nada precalentado, no repone nada', () => {
    const t = target();
    new WarmMemory().replay(t);
    expect(t.got).toEqual([]);
  });
});
