import { describe, it, expect } from 'vitest';
import { Model, material, box, render, assertClosedPalette, type RenderOptions } from '../src/core';
import { encodePNG } from '../src/core/png';
import { sampleScene, TEST_PALETTE } from '../src/samples/basic';

const OPTS: RenderOptions = { width: 48, height: 36, originX: 24, originY: 30 };

describe('render', () => {
  it('es determinista: mismo modelo y opciones, mismos bytes de PNG', () => {
    const a = render(sampleScene(), { ...OPTS, yaw: 37 });
    const b = render(sampleScene(), { ...OPTS, yaw: 37 });
    expect(Buffer.from(encodePNG(48, 36, a.rgba)).equals(Buffer.from(encodePNG(48, 36, b.rgba)))).toBe(true);
  });

  it('no depende del orden en que se construyó el modelo', () => {
    const a = new Model(TEST_PALETTE);
    const b = new Model(TEST_PALETTE);
    box(a, -3, -3, 0, 3, 3, 8, material(1, 2));
    for (let z = 8; z >= 0; z--) for (let y = 3; y >= -3; y--) for (let x = 3; x >= -3; x--) b.set(x, y, z, material(1, 2));
    expect(render(a, { ...OPTS, yaw: 20 }).rgba).toEqual(render(b, { ...OPTS, yaw: 20 }).rgba);
  });

  it('solo produce colores de la paleta en todos los ángulos', () => {
    const m = sampleScene();
    for (let yaw = 0; yaw < 360; yaw += 15) expect(() => assertClosedPalette(render(m, { ...OPTS, yaw }), m)).not.toThrow();
  });

  it('el pivote (los pies) cae en el mismo píxel en todos los ángulos', () => {
    // Un poste de 1x1 en el pivote: su base ocupa siempre la columna originX y termina justo encima de originY
    const m = new Model(TEST_PALETTE);
    box(m, 0, 0, 0, 0, 0, 10, material(1, 2));
    for (let yaw = 0; yaw < 360; yaw += 10) {
      const img = render(m, { ...OPTS, yaw, outline: 'none' });
      const opaque = (x: number, y: number) => img.rgba[(y * img.width + x) * 4 + 3] === 255;
      expect(opaque(OPTS.originX, OPTS.originY - 1), `yaw ${yaw}`).toBe(true);
      expect(opaque(OPTS.originX, OPTS.originY + 1), `yaw ${yaw}`).toBe(false);
    }
  });

  it('de frente, 1 vóxel = 1 píxel: una caja de 5 de ancho y 8 de alto ocupa 5 columnas y 8 filas de fachada', () => {
    const m = new Model(TEST_PALETTE);
    box(m, -2, 0, 0, 2, 0, 7, material(1, 2));
    const img = render(m, { ...OPTS, yaw: 0, elevation: 0, outline: 'none' });
    let minX = 99, maxX = -1, minY = 99, maxY = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
      if (img.rgba[(y * img.width + x) * 4 + 3]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    expect([maxX - minX + 1, maxY - minY + 1]).toEqual([5, 8]);
  });

  it('la luz viene de arriba-izquierda en pantalla: la cara izquierda de una caja es más clara que la derecha', () => {
    const m = new Model(TEST_PALETTE);
    box(m, -4, -4, 0, 4, 4, 8, material(2, 2));
    const img = render(m, { ...OPTS, yaw: 45, outline: 'none' });
    const lum = (x: number, y: number) => { const p = (y * img.width + x) * 4; return img.rgba[p]! + img.rgba[p + 1]! + img.rgba[p + 2]!; };
    expect(lum(OPTS.originX - 3, OPTS.originY - 4)).toBeGreaterThan(lum(OPTS.originX + 3, OPTS.originY - 4));
  });

  it('el formato de fichero da el mismo modelo', () => {
    const m = sampleScene();
    const back = Model.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    expect(render(back, OPTS).rgba).toEqual(render(m, OPTS).rgba);
  });
});

describe('cámara del editor 3D', () => {
  it('con zoom, el vóxel del pivote se ve en el centro y el pick dice cuál es', async () => {
    const { camera } = await import('../src/core');
    const m = new Model(TEST_PALETTE);
    box(m, 0, 0, 0, 0, 0, 0, material(1, 2));
    const o = { width: 200, height: 200, originX: 100, originY: 150, yaw: 30, elevation: 35, ppu: 12, pick: true, outline: 'none' as const };
    const img = render(m, o);
    const [sx, sy] = camera(o).project(0.5, 0.5, 0.5);
    const idx = Math.floor(sy) * 200 + Math.floor(sx);
    expect(img.pickKey![idx]).toBe((await import('../src/core')).key(0, 0, 0));
    expect(img.pickFace![idx]).toBeGreaterThanOrEqual(0);
  });

  it('groundAt deshace la proyección del suelo', async () => {
    const { camera } = await import('../src/core');
    for (const yaw of [0, 30, 135, -70]) {
      const cam = camera({ width: 200, height: 200, originX: 100, originY: 150, yaw, elevation: 40, ppu: 10 });
      for (const [x, y] of [[0, 0], [3, -2], [-5, 4]] as const) {
        const [sx, sy] = cam.project(x + 0.5, y + 0.5, 0);
        expect(cam.groundAt(sx, sy), `yaw ${yaw} celda ${x},${y}`).toEqual([x, y]);
      }
    }
  });
});
