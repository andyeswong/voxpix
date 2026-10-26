// Explorar (src/core/explore.ts): el render en primera persona y el caminante
import { describe, it, expect } from 'vitest';
import { Model, box, material, renderFirstPerson, fpRay, Walker, assertClosedPalette, unkey } from '../src/core';
import { medievalScene } from '../src/samples/medieval';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080'] }, { name: 'rojo', colors: ['#400000', '#800000', '#c00000'] }] };

describe('render en primera persona', () => {
  it('lo que hay delante sale en el centro, con la cara que mira al ojo; solo colores de la paleta', () => {
    const m = new Model(structuredClone(PAL));
    box(m, -10, 0, 0, 10, 0, 6, material(1, 1));                 // una pared al norte (y = 0)
    box(m, -10, -12, -1, 10, 0, -1, material(0, 2));             // el suelo
    const cam = { x: 0.5, y: -6.5, z: 2.5, yaw: 0, pitch: 0 };   // mirando al norte
    const img = renderFirstPerson(m, cam, { width: 64, height: 36 });
    const c = 18 * 64 + 32;
    const [x, y, z] = unkey(img.pickKey![c]!);
    expect(y).toBe(0);
    expect(z).toBeGreaterThanOrEqual(0);
    expect(Math.abs(x)).toBeLessThan(2);
    expect(img.pickFace![c]).toBe(3);                             // la cara -y (la que mira al sur, al ojo)
    expect(img.depth[c]).toBeCloseTo(6.5, 0);
    // Mirando hacia abajo, el centro es el suelo
    const down = renderFirstPerson(m, { ...cam, pitch: -80 }, { width: 64, height: 36 });
    expect(unkey(down.pickKey![c]!)[2]).toBe(-1);
    assertClosedPalette(img, m);
  });

  it('un rayo por píxel: el del centro va hacia donde mira la cámara', () => {
    const d = fpRay({ x: 0, y: 0, z: 0, yaw: 90, pitch: 0 }, 101, 51, 50, 25);
    expect(d[0]).toBeCloseTo(1, 5); expect(d[1]).toBeCloseTo(0, 5); expect(d[2]).toBeCloseTo(0, 5);
  });

  it('la escena medieval de muestra, desde dentro: se ve algo en casi toda la imagen', () => {
    const m = medievalScene().model;
    const img = renderFirstPerson(m, { x: -10, y: -12, z: 5.7, yaw: 30, pitch: -10 }, { width: 96, height: 54, outline: 'both' });
    let hit = 0;
    for (let i = 0; i < 96 * 54; i++) if (img.rgba[i * 4 + 3]) hit++;
    expect(hit).toBeGreaterThan(96 * 54 * 0.6);
    assertClosedPalette(img, m);
  });
});

describe('el caminante', () => {
  // Un suelo en z = 0, un escalón de 1 al norte y una pared de 3 al este
  const m = new Model(structuredClone(PAL));
  box(m, -20, -20, 0, 20, 20, 0, material(0, 1));
  box(m, -20, 5, 1, 20, 20, 1, material(0, 2));                   // escalón (z = 1) desde y = 5
  box(m, 6, -20, 1, 6, 4, 3, material(1, 1));                     // pared en x = 6
  const solid = (x: number, y: number, z: number) => m.get(x, y, z) !== 0;
  const run = (w: Walker, input: Parameters<Walker['step']>[1], ticks: number) => { for (let i = 0; i < ticks; i++) w.step(1 / 60, input, solid); };

  it('cae hasta el suelo y se queda de pie', () => {
    const w = new Walker(0.5, 0.5, 10, { height: 2 });
    run(w, { forward: 0, strafe: 0 }, 120);
    expect(w.z).toBe(1);
    expect(w.onGround).toBe(true);
  });

  it('sube un escalón de 1 andando, y no atraviesa una pared de 3', () => {
    const w = new Walker(0.5, 0.5, 1, { height: 2 });
    w.yaw = 0;                                                    // al norte: el escalón
    run(w, { forward: 1, strafe: 0 }, 120);
    expect(w.y).toBeGreaterThan(5.5);
    expect(w.z).toBe(2);
    const v = new Walker(0.5, 0.5, 1, { height: 2 });
    v.yaw = 90;                                                   // al este: la pared
    run(v, { forward: 1, strafe: 0 }, 120);
    expect(v.x).toBeLessThan(6);
    expect(v.x).toBeGreaterThan(5);
    expect(v.z).toBe(1);
  });

  it('salta, vuela y la altura se elige (el ojo va al 90 %)', () => {
    const w = new Walker(0.5, 0.5, 1, { height: 4 });
    expect(w.eye().z).toBeCloseTo(1 + 3.6, 5);
    run(w, { forward: 0, strafe: 0, jump: true }, 5);
    expect(w.z).toBeGreaterThan(1);
    run(w, { forward: 0, strafe: 0 }, 120);
    expect(w.z).toBe(1);
    run(w, { forward: 0, strafe: 0, fly: true, jump: true }, 60);
    expect(w.z).toBeGreaterThan(5);
  });
});
