import { describe, it, expect } from 'vitest';
import { Model, material, box, render, camera, lightField3D, type RenderOptions } from '../src/core';
import { TEST_PALETTE } from '../src/samples/basic';

const O: RenderOptions = { width: 80, height: 60, originX: 40, originY: 50, yaw: 0, elevation: 35, pick: true, outline: 'none' };
const RED = { radius: 40, color: [1, 0.2, 0.1] as const, intensity: 1 };

function at(field: Float32Array, x: number, y: number): number { return field[(y * O.width + x) * 3]!; }

describe('luz 3D', () => {
  it('una luz a la izquierda alumbra la cara izquierda de un muro y no la derecha', () => {
    const m = new Model(TEST_PALETTE);
    box(m, -1, -3, 0, 1, 3, 8, material(1, 2));        // muro norte-sur de 3 de ancho
    const img = render(m, { ...O, yaw: 30 });
    const cam = camera({ ...O, yaw: 30 });
    const f = lightField3D(m, img, cam, [{ x: -12, y: 0, z: 6, ...RED }], [0.2, 0.2, 0.2]);
    // Buscar en la imagen una cara -x (izquierda) y una +x
    let left = -1, right = -1;
    for (let i = 0; i < O.width * O.height; i++) {
      if (img.pickFace![i] === 1 && left < 0) left = i;
      if (img.pickFace![i] === 0 && right < 0) right = i;
    }
    expect(left).toBeGreaterThanOrEqual(0);
    expect(f[left * 3]!).toBeGreaterThan(0.3);
    if (right >= 0) expect(f[right * 3]!).toBeCloseTo(0.2, 5);
  });

  it('el modelo da sombra en el suelo detrás de él respecto a la luz', () => {
    const m = new Model(TEST_PALETTE);
    box(m, 0, -2, 0, 1, 2, 10, material(1, 2));         // muro corto de 5 de fondo
    const img = render(m, O);
    const cam = camera(O);
    const light = { x: -15, y: 0.5, z: 4, ...RED };
    const f = lightField3D(m, img, cam, [light], [0.1, 0.1, 0.1]);
    // Suelo a la derecha del poste (en sombra) frente a suelo a la misma distancia a la izquierda (lit)
    const shadowPt = cam.project(6.5, 0.5, 0);
    const s = at(f, Math.floor(shadowPt[0]), Math.floor(shadowPt[1]));
    const open = cam.project(-6.5, 0.5, 0);
    const l = at(f, Math.floor(open[0]), Math.floor(open[1]));
    expect(s).toBeCloseTo(0.1, 5);
    expect(l).toBeGreaterThan(0.2);
  });

  it('sin luces, todo es ambiente', () => {
    const m = new Model(TEST_PALETTE);
    box(m, 0, 0, 0, 2, 2, 2, material(1, 2));
    const img = render(m, O);
    const f = lightField3D(m, img, camera(O), [], [0.3, 0.4, 0.5]);
    for (let i = 0; i < 20; i++) expect([f[i * 3], f[i * 3 + 1], f[i * 3 + 2]].map((v) => Math.round(v! * 10) / 10)).toEqual([0.3, 0.4, 0.5]);
  });
});
