// El ejemplo de los corazones de vida (models/corazones, hecho con scripts/corazones.js en el editor): lleno, medio y
// vacío. Lo que promete el modelo (una losa de 2 de hondo con la silueta de corazón de 6 x 5, el medio partido por la
// mitad) y lo que se lee en el icono, de frente (yaw 0, elevación 20) a 8 px y a 16 px (scale 2), medido sin verlo:
// docs/runbooks/diseno-para-16-px.md
import { describe, it, expect } from 'vitest';
import { iconSheet } from '../src/core';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import file from '../models/corazones/corazones.voxset.json';

const f = file as unknown as VoxsetFile;
const set = BlockSet.fromJSON(f);
const IDS = ['corazon_lleno', 'corazon_medio', 'corazon_vacio'];
const items = IDS.map((id) => ({ id, model: set.get(set.index(id)).model }));
const OUT = [7, 7, 10];
// Por icono: la silueta, y los píxeles rojos y del hueco oscuro de cada mitad (sin el contorno)
function measure(scale: number) {
  const s = iconSheet(items, { yaw: 0, elevation: 20, cell: 8, scale, outline: 'both', outlineColor: '#07070a' });
  const out: Record<string, { w: number; h: number; red: [number, number]; dark: [number, number]; hash: string }> = {};
  for (const id of IDS) {
    const r = s.icons[id]!;
    let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
    const red: [number, number] = [0, 0], dark: [number, number] = [0, 0];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const i = (y * s.width + x) * 4, R = s.rgba[i]!, G = s.rgba[i + 1]!, B = s.rgba[i + 2]!;
      if (!s.rgba[i + 3]) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      if (R === OUT[0] && G === OUT[1] && B === OUT[2]) continue;
      const half = x - r.x < r.w / 2 ? 0 : 1;
      if (R > 120 && R > 2 * G) red[half]++;
      else if (0.299 * R + 0.587 * G + 0.114 * B < 45) dark[half]++;
    }
    out[id] = { w: x1 - x0 + 1, h: y1 - y0 + 1, red, dark, hash: r.hash };
  }
  return out;
}

describe('ejemplo: corazones de vida', () => {
  it('tres corazones de 6 x 5 en una losa de 2 de hondo; el medio, rojo a la izquierda y hueco a la derecha', () => {
    expect(f.blocks.map((b) => b.id)).toEqual(IDS);
    expect(f.palette.ramps.map((r) => r.name)).toEqual(['corazon', 'hueco']);
    const ramp = (m: number) => Math.floor((m - 1) / 16);
    for (const b of f.blocks) {
      expect(b.voxels.length).toBe(22 * 2);                                 // 22 casillas de la silueta, 2 de hondo
      expect(b.voxels.every((v) => v[1] === 3 || v[1] === 4)).toBe(true);   // y -1..0 (en el fichero, + 4)
    }
    const at = (id: string) => f.blocks.find((b) => b.id === id)!.voxels;
    expect(at('corazon_lleno').every((v) => ramp(v[3]) === 0)).toBe(true);
    expect(at('corazon_vacio').every((v) => ramp(v[3]) === 1)).toBe(true);
    // el medio: x < 0 (en el fichero, < 4) rojo; el resto, hueco
    expect(at('corazon_medio').every((v) => ramp(v[3]) === (v[0] < 4 ? 0 : 1))).toBe(true);
  });

  it('a 8 px: caben con el contorno, y el medio se distingue del lleno (la mitad derecha)', () => {
    const m = measure(1);
    for (const id of IDS) expect([m[id]!.w, m[id]!.h]).toEqual([8, 8]);
    expect(m.corazon_lleno!.red[0]).toBeGreaterThan(0);
    expect(m.corazon_lleno!.red[1]).toBeGreaterThanOrEqual(10);            // el lleno: rojo también a la derecha
    expect(m.corazon_medio!.red[1]).toBe(0);                                // el medio: nada rojo a la derecha
    expect(m.corazon_medio!.dark[1]).toBeGreaterThanOrEqual(10);           // sino el hueco
    expect(m.corazon_medio!.red[0]).toBeGreaterThan(0);                     // y rojo a la izquierda
    expect(m.corazon_vacio!.red).toEqual([0, 0]);                           // el vacío: sin rojo
    expect(m.corazon_vacio!.dark[0] + m.corazon_vacio!.dark[1]).toBeGreaterThanOrEqual(20);
    expect(IDS.map((id) => m[id]!.hash)).toEqual(['0da012a5', '19e05d95', '600ec415']);
  });

  it('a 16 px (scale 2): lo mismo, cada píxel doble', () => {
    const m1 = measure(1), m2 = measure(2);
    for (const id of IDS) {
      expect([m2[id]!.w, m2[id]!.h]).toEqual([16, 16]);
      expect(m2[id]!.red).toEqual(m1[id]!.red.map((n) => n * 4));
      expect(m2[id]!.dark).toEqual(m1[id]!.dark.map((n) => n * 4));
    }
  });
});
