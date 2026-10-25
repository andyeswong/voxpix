// Animación genérica por partes (src/anim/rig.ts): el pivote se queda en los pies con cualquier cuerpo.
import { describe, it, expect } from 'vitest';
import { Model, box, material } from '../src/core';
import { rigFrames, type Rig } from '../src/anim/rig';

function ground(m: Model): { n: number; cx: number; cy: number } {
  let n = 0, sx = 0, sy = 0;
  for (const [x, y, z] of m.entries()) if (z === 0) { n++; sx += x; sy += y; }
  return { n, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
}

// Las reglas del pivote para un modelo y su rig
function checkRig(name: string, base: Model, rig: Rig): void {
  const frames = rigFrames(base, rig);
  expect(frames).toHaveLength(rig.frames.length);
  const g0 = ground(base);
  let cx = 0, cy = 0, k = 0;
  frames.forEach((f, i) => {
    const b = f.bounds()!;
    if (rig.frames[i]!.airborne) {
      // En el aire: nada por debajo del suelo y sube poco (un salto, no un vuelo)
      expect(b.minZ, `${name} cuadro ${i}`).toBeGreaterThanOrEqual(0);
      expect(b.minZ, `${name} cuadro ${i}`).toBeLessThanOrEqual(2);
      return;
    }
    // Apoyado: algo toca z = 0 y nada baja de ahí
    expect(b.minZ, `${name} cuadro ${i}`).toBe(0);
    const g = ground(f);
    cx += g.cx; cy += g.cy; k++;
  });
  // De media en el ciclo, el apoyo está donde el del quieto (medio vóxel de margen)
  expect(Math.abs(cx / k - g0.cx), `${name} x`).toBeLessThan(0.75);
  expect(Math.abs(cy / k - g0.cy), `${name} y`).toBeLessThan(0.75);
  // Cada parte avanza lo mismo que retrocede
  for (const p of rig.parts) expect(rig.frames.reduce((s, f) => s + (f.moves[p.name]?.stride ?? 0), 0), `${name} ${p.name}`).toBe(0);
  // El cuerpo no se desplaza en planta
  for (const f of rig.frames) { expect(f.moves.body?.dx ?? 0).toBe(0); }
  // Ni pierde ni inventa masa (más del 8 %: un bicho pequeño pierde proporcionalmente más al doblar una pata)
  for (const f of frames) expect(Math.abs(f.size - base.size) / base.size, name).toBeLessThan(0.08);
}

describe('rig genérico', () => {
  // Un cuadrúpedo de prueba: un cuerpo de 8x6x4 sobre cuatro patas de 1x1x4
  const pal = { ramps: [{ name: 'cuerpo', colors: ['#202020', '#606060', '#a0a0a0'] }] };
  const quad = new Model(pal);
  box(quad, -4, -3, 4, 3, 2, 7, material(0, 1));
  for (const [x, y] of [[-4, -3], [3, -3], [-4, 2], [3, 2]] as const) box(quad, x, y, 0, x, y, 3, material(0, 2));
  const diagonal = (x: number, y: number) => (x < 0) === (y < 0);
  const rig: Rig = {
    frameMs: 100,
    parts: [
      { name: 'A', has: (x, y, z) => z <= 3 && diagonal(x, y), pivotZ: 3, footZ: 0 },
      { name: 'B', has: (x, y, z) => z <= 3 && !diagonal(x, y), pivotZ: 3, footZ: 0 },
    ],
    frames: [
      { moves: { A: { stride: 1 }, B: { stride: -1 } } },
      { moves: { A: { dz: 1 } } },
      { moves: { A: { stride: -1 }, B: { stride: 1 } } },
      { moves: { B: { dz: 1 } } },
    ],
  };

  it('la zancada mueve el pie y deja la cadera', () => {
    const [f0] = rigFrames(quad, rig);
    // pata A delantera-izquierda (-4, -3): el pie (z 0) se adelanta 1 (y -1), la cadera (z 3) no se mueve
    expect(f0!.get(-4, -4, 0)).toBeTruthy();
    expect(f0!.get(-4, -3, 0)).toBe(0);
    expect(f0!.get(-4, -3, 3)).toBeTruthy();
  });

  it('cumple las reglas del pivote', () => checkRig('cuadrúpedo', quad, rig));
});
