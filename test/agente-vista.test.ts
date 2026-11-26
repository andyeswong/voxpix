// La vista del agente en color (src/agent/agentview.ts): las mismas letras que describe, cada una con el color de su
// bloque (el más repetido arriba en su modelo), lo que no se ve apagado, las marcas con el suyo, y el dibujo en un canvas
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { AgentHost, type Point, type Description } from '../src/agent/agent';
import { agentView, agentViewText, agentViewSize, paintAgentView, blockColor, mixColor, type AgentViewCtx } from '../src/agent/agentview';

const N = 4;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
  { name: 'musgo', colors: ['#103010', '#20a040', '#40c060'] },
] };
// Un cubo de una rampa con el tono 1 en todo salvo arriba, donde el tono de la cara es top (o la mitad top2)
const cube = (ramp: number, top: number, top2 = top): Array<[number, number, number, number]> => {
  const out: Array<[number, number, number, number]> = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
    out.push([x, y, z, material(ramp, z < N - 1 ? 1 : x < N / 2 ? top : top2)]);
  return out;
};
const COLS = 6, ROWS = 6, LAYERS = 4;
function world() {
  const set = new BlockSet('prueba', N, PAL);
  set.add('piedra', cube(0, 2));             // arriba, todo tono 2
  set.add('tierra', cube(1, 1));             // arriba, todo tono 1
  set.add('musgo', cube(2, 2, 0));           // arriba, mitad 2 y mitad 0: a igualdad, el que va antes (tono 0)
  const st = new WorldState(new StaticVoxels(PAL, COLS * N, ROWS * N, 0, LAYERS * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++) { grid.set(bx, by, 0, 1); grid.set(bx, by, 1, 2); }
  grid.set(1, 1, 1, 3);
  grid.set(4, 4, 1, 0);
  return { st, grid, set };
}
const PLAYER: Point = { x: 2 * N + 1, y: 3 * N + 1, z: 2 * N };
const host = (marks = true) => {
  const { st, grid } = world();
  return new AgentHost({ state: st, grid, player: () => PLAYER, marks: marks ? () => [{ ch: 'm', x: 4 * N + 1, y: 2 * N + 1, z: 1 * N, name: 'algo' }] : undefined });
};

describe('la vista del agente en color', () => {
  it('las letras son las de describe, una a una, y fuera de la rejilla no se pinta nada', () => {
    const h = host(), d = h.describe({ radius: 4, below: 2, above: 0 }), v = agentView(h, d);
    expect(agentViewText(v)).toEqual(d.layers.map((L) => L.rows));
    expect(v.layers.map((L) => L.bz)).toEqual(d.layers.map((L) => L.bz));
    expect(v.center).toEqual(d.center);
    const out = v.layers.flatMap((L) => L.rows.flat()).filter((c) => c.kind === 'out');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.ch === ' ')).toBe(true);
  });

  it('el color de un bloque es el más repetido arriba de su modelo; a igualdad, el que va antes en la paleta', () => {
    const { set } = world();
    expect(blockColor(set.get(set.index('piedra')))).toBe('#565e68');
    expect(blockColor(set.get(set.index('tierra')))).toBe('#4a3020');
    expect(blockColor(set.get(set.index('musgo')))).toBe('#103010');
  });

  it('cada celda lleva el color de su bloque, el aire el suyo y las marcas el de la marca, no el de un bloque', () => {
    const h = host(), d = h.describe({ radius: 4, below: 2, above: 0 }), v = agentView(h, d);
    const at = (bz: number, bx: number, by: number) => v.layers.find((L) => L.bz === bz)!.rows[d.y[1] - by]![bx - d.x[0]]!;
    expect(at(1, 2, 2)).toEqual({ ch: 'T', color: '#4a3020', dim: false, kind: 'block', id: 'tierra' });
    expect(at(1, 1, 1)).toMatchObject({ kind: 'block', id: 'musgo', color: '#103010' });
    expect(at(0, 0, 0)).toMatchObject({ kind: 'block', id: 'piedra', color: '#565e68' });
    expect(at(1, 4, 4)).toMatchObject({ ch: '.', kind: 'air' });
    expect(at(2, 2, 3)).toMatchObject({ ch: '@', kind: 'mark', color: '#ffd84a' });
    // la marca del juego es una minúscula como la de un bloque que no se ve: la decide la celda, no la letra
    expect(at(1, 4, 2)).toMatchObject({ ch: 'm', kind: 'mark', color: '#ff9f40', dim: false });
    expect(v.legend).toEqual(expect.arrayContaining([{ ch: 'T', id: 'tierra', color: '#4a3020' }, { ch: 'P', id: 'piedra', color: '#565e68' }]));
  });

  it('lo que no se ve (minúscula) va apagado hacia el fondo; y los colores fijos mandan', () => {
    const h = host(false), d = h.describe({ at: { x: PLAYER.x, y: PLAYER.y, z: N }, radius: 2, below: 0, above: 0 });
    const L0 = d.layers[0]!, hidden: Description = { ...d, layers: [{ bz: L0.bz, rows: L0.rows.map((r, i) => (i === 0 ? r.toLowerCase() : r)) }] };
    const v = agentView(h, hidden, { colors: { tierra: '#ff0000' }, background: '#000000', dim: 0.5 });
    const top = v.layers[0]!.rows[0]!.filter((c) => c.kind === 'block'), rest = v.layers[0]!.rows[1]!.filter((c) => c.kind === 'block');
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((c) => c.dim && c.color === '#800000')).toBe(true);
    expect(rest.every((c) => !c.dim && c.color === '#ff0000')).toBe(true);
    expect(mixColor('#ff0000', '#000000', 0.5)).toBe('#800000');
    expect(mixColor('#102030', '#102030', 0.3)).toBe('#102030');
  });

  it('se pinta una letra por celda con su color, en su sitio; el tamaño es el que dice agentViewSize', () => {
    const h = host(), d = h.describe({ radius: 2, below: 1, above: 0 }), v = agentView(h, d);
    const calls: Array<{ text: string; x: number; y: number; fill: string }> = [], rects: number[][] = [];
    const ctx: AgentViewCtx = { fillStyle: '', font: '', textAlign: 'start', textBaseline: 'alphabetic',
      fillRect: (x, y, w, hh) => { rects.push([x, y, w, hh]); }, fillText(text, x, y) { calls.push({ text, x, y, fill: String(this.fillStyle) }); } };
    const cell = 10, size = paintAgentView(ctx, v, { cell, gap: 1 });
    expect(size).toEqual(agentViewSize(v, { cell, gap: 1 }));
    const cols = d.x[1] - d.x[0] + 1, rows = d.y[1] - d.y[0] + 1;
    expect(size).toEqual({ width: cols * cell, height: 2 * (rows + 1) * cell + cell });
    expect(rects[0]).toEqual([0, 0, size.width, size.height]);
    expect(calls.filter((c) => /^z /.test(c.text)).map((c) => c.text)).toEqual(['z 2', 'z 1']);
    const letters = calls.filter((c) => !/^z /.test(c.text)), cells = v.layers.flatMap((L) => L.rows.flat()).filter((c) => c.kind !== 'out');
    expect(letters.length).toBe(cells.length);
    // la segunda capa empieza tras la primera, su cabecera y una celda de separación
    const k = v.layers[1]!.rows[0]![0]!, first = letters[v.layers[0]!.rows.flat().filter((c) => c.kind !== 'out').length]!;
    expect(first).toEqual({ text: k.kind === 'air' ? '·' : k.ch, x: cell / 2, y: (rows + 1) * cell + cell + cell * 1.5, fill: k.color });
    // capas lado a lado
    expect(agentViewSize(v, { cell, gap: 1, across: 2 })).toEqual({ width: 2 * cols * cell + cell, height: (rows + 1) * cell });
    expect(agentViewSize(v, { cell, labels: false, across: 2 })).toEqual({ width: 2 * cols * cell + cell, height: rows * cell });
  });
});
