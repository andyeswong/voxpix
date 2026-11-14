// La hoja de iconos: cada modelo pintado en su celda (centrado, recortado a lo que tiene), con el índice id -> recuadro,
// la escala, la celda que no basta (error claro) y la del set de bloques del editor
import { describe, it, expect } from 'vitest';
import { Model, material, box, iconSheet } from '../src/core';
import { replaceModel, history } from '../app/src/store';
import { newSet, addBlock, block, setIcons } from '../app/src/blockSet';

const PAL = { ramps: [{ name: 'a', colors: ['#202020', '#606060', '#a0a0a0'] }, { name: 'b', colors: ['#402010', '#a06030', '#e0a060'] }] };
const cube = (n: number, ramp: number) => { const m = new Model(PAL, `c${n}`); box(m, 0, 0, 0, n - 1, n - 1, n - 1, material(ramp, 1)); return m; };
// ¿Hay algo pintado (opaco) dentro del recuadro?
const filled = (s: ReturnType<typeof iconSheet>, r: { x: number; y: number; w: number; h: number }) => {
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (s.rgba[(y * s.width + x) * 4 + 3]) n++;
  return n;
};

describe('hoja de iconos', () => {
  it('una celda por modelo, del tamaño del mayor; cada icono dentro de la suya; a x2, el doble', () => {
    const items = [{ id: 'chico', model: cube(4, 0) }, { id: 'grande', model: cube(8, 1) }, { id: 'medio', model: cube(6, 0) }];
    const s = iconSheet(items);
    expect(Object.keys(s.icons)).toEqual(['chico', 'grande', 'medio']);
    expect(s.width).toBe(2 * s.cell); expect(s.height).toBe(2 * s.cell);   // 3 iconos: 2 columnas, 2 filas
    for (const id of ['chico', 'grande', 'medio']) expect(filled(s, s.icons[id]!)).toBeGreaterThan(0);
    expect(filled(s, { x: s.cell, y: s.cell, w: s.cell, h: s.cell })).toBe(0);   // la cuarta celda, vacía
    expect(filled(s, s.icons.grande!)).toBeGreaterThan(filled(s, s.icons.chico!));
    const s2 = iconSheet(items, { scale: 2 });
    expect(s2.cell).toBe(s.cell * 2);
    expect(filled(s2, s2.icons.chico!)).toBe(filled(s, s.icons.chico!) * 4);
    expect(iconSheet(items).rgba).toEqual(s.rgba);              // siempre lo mismo
  });

  it('una celda más pequeña que un icono es un error que dice cuánto hace falta', () => {
    expect(() => iconSheet([{ id: 'grande', model: cube(8, 0) }], { cell: 4 })).toThrow(/grande.*celda de \d+ o más/);
  });

  it('la hoja del set de bloques del editor: un icono por bloque, con su índice', () => {
    replaceModel(new Model(PAL, 'x'));
    newSet('iconos', 4);
    const paint = (ramp: number) => { const h = history.value; h.begin(); for (let z = 0; z < 4; z++) for (let y = -2; y < 2; y++) for (let x = -2; x < 2; x++) h.set(x, y, z, material(ramp, 1)); h.commit(); };
    paint(0); addBlock('piedra'); block(null); paint(1); addBlock('madera');
    const r = setIcons({ scale: 2 });
    expect(Object.keys(r.icons)).toEqual(['piedra', 'madera']);
    expect(r.width).toBe(2 * r.cell);
  });
});
