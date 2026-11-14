// La hoja de iconos: cada modelo pintado en su celda (centrado, recortado a lo que tiene), con el índice id -> recuadro,
// la escala, la celda que no basta (error claro) y la del set de bloques del editor
import { describe, it, expect } from 'vitest';
import { Model, material, box, iconSheet, modelIcon } from '../src/core';
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

  it('huellas: el mismo modelo da el mismo icono (también suelto, con modelIcon, a la misma celda); otro modelo, otra', () => {
    const a = iconSheet([{ id: 'x', model: cube(6, 0) }, { id: 'y', model: cube(6, 1) }], { cell: 16 });
    const b = iconSheet([{ id: 'x', model: cube(6, 0) }, { id: 'y', model: cube(6, 1) }], { cell: 16 });
    expect(a.hash).toBe(b.hash);
    expect(a.icons.x!.hash).not.toBe(a.icons.y!.hash);
    const solo = modelIcon(cube(6, 0), { cell: 16 });
    expect(solo.size).toBe(16);
    expect(solo.hash).toBe(a.icons.x!.hash);
    expect(modelIcon(cube(6, 0), { cell: 16, yaw: 30 }).hash).not.toBe(solo.hash);   // otro giro, otro icono
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
  it('outlineColor: sin él, la hoja de siempre (la misma huella); con él, el contorno de ese color', () => {
    const m1 = new Model(PAL, 'x'); box(m1, 0, 0, 0, 5, 5, 5, material(0, 1)); box(m1, 1, 1, 6, 4, 4, 9, material(1, 2));
    const m2 = new Model(PAL, 'y'); box(m2, 0, 0, 0, 7, 3, 3, material(1, 1)); box(m2, 0, 4, 0, 3, 7, 6, material(0, 2));
    const items = [{ id: 'torre', model: m1 }, { id: 'escalon', model: m2 }];
    // Las huellas de antes de que existiera la opción
    expect(iconSheet(items, { outline: 'outer' }).hash).toBe('dab10245');
    expect(iconSheet(items, { outline: 'both' }).hash).toBe('de6b9405');
    const plain = iconSheet(items, { outline: 'both' }), pink = iconSheet(items, { outline: 'both', outlineColor: '#ff00ff' });
    expect(pink.hash).not.toBe(plain.hash);
    expect([pink.width, pink.height]).toEqual([plain.width, plain.height]);
    // Donde cambia un píxel, el nuevo es el color pedido; y hay borde de ese color en las dos celdas
    let changed = 0;
    for (let i = 0; i < plain.rgba.length; i += 4) {
      if (plain.rgba[i] === pink.rgba[i] && plain.rgba[i + 1] === pink.rgba[i + 1] && plain.rgba[i + 2] === pink.rgba[i + 2]) continue;
      changed++;
      expect([pink.rgba[i], pink.rgba[i + 1], pink.rgba[i + 2]]).toEqual([255, 0, 255]);
    }
    expect(changed).toBeGreaterThan(0);
    for (const id of ['torre', 'escalon']) {
      const r = pink.icons[id]!;
      let n = 0;
      for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { const o = (y * pink.width + x) * 4; if (pink.rgba[o + 3] && pink.rgba[o] === 255 && pink.rgba[o + 1] === 0 && pink.rgba[o + 2] === 255) n++; }
      expect(n).toBeGreaterThan(0);
    }
    expect(modelIcon(m1, { outline: 'both', outlineColor: '#ff00ff' }).hash).not.toBe(modelIcon(m1, { outline: 'both' }).hash);
  });
});
