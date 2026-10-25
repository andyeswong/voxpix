// El walk de MAIA en vóxeles: el pivote se queda en los pies (condición de MAIA para darlo por bueno).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Model, render, type ModelFile } from '../src/core';
import { walkFrames, WALK_POSES, WALK_FRAME_MS } from '../src/anim/walk';

const maia = Model.fromJSON(JSON.parse(readFileSync('models/maia/maia.json', 'utf8')) as ModelFile);
const frames = walkFrames(maia);
const BOOTS = 5;                                   // rampa de las botas (Kr)
const rampOf = (v: number) => Math.floor((v - 1) / 16);

// Los vóxeles del suelo (z = 0) y su centro
function ground(m: Model): { n: number; boots: number; cx: number; cy: number } {
  let n = 0, boots = 0, sx = 0, sy = 0;
  for (const [x, y, z, v] of m.entries()) if (z === 0) { n++; sx += x; sy += y; if (rampOf(v) === BOOTS) boots++; }
  return { n, boots, cx: sx / n, cy: sy / n };
}

// Caja del torso (abrigo entre la cadera y los hombros, sin brazos)
function torso(m: Model): { x0: number; x1: number; y0: number; y1: number } {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y, z, v] of m.entries()) if (z >= 6 && z <= 12 && Math.abs(x) <= 5 && rampOf(v) === 2) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { x0, x1, y0, y1 };
}

// La fila de pantalla más baja con algo pintado, con la celda del juego (frame2d: 48x72, pies en (24, 60))
function lowestRow(m: Model, yaw: number): number {
  const img = render(m, { width: 48, height: 72, originX: 24, originY: 60, pivot: [0.5, 0, 0], yaw, oblique: { y: 0.5, z: 1 }, flat: true, outline: 'none' });
  for (let y = 71; y >= 0; y--) for (let x = 0; x < 48; x++) if (img.rgba[(y * 48 + x) * 4 + 3]) return y;
  return -1;
}

// Solo una pierna (de la bota a la rodilla: z 0..3, el lado de x como en src/anim/walk.ts)
function legOf(m: Model, side: 'L' | 'R'): Model {
  const out = new Model(m.palette);
  for (const [x, y, z, v] of m.entries()) if (z <= 3 && Math.abs(x) <= 5 && (side === 'L' ? x <= 0 : x >= 1)) out.set(x, y, z, v);
  return out;
}

describe('walk de MAIA en vóxeles', () => {
  it('8 cuadros de 100 ms, como el walk 2D aprobado', () => {
    expect(frames).toHaveLength(8);
    expect(WALK_POSES).toHaveLength(8);
    expect(WALK_FRAME_MS).toBe(100);
  });

  it('en cada cuadro hay una bota apoyada en z = 0 y nada por debajo', () => {
    for (const f of frames) {
      expect(f.bounds()!.minZ).toBe(0);
      expect(ground(f).boots).toBeGreaterThan(0);
    }
  });

  it('el apoyo no se desplaza: el centro del suelo, de media en el ciclo, es el del modelo quieto', () => {
    const base = ground(maia);
    const cx = frames.reduce((s, f) => s + ground(f).cx, 0) / frames.length;
    const cy = frames.reduce((s, f) => s + ground(f).cy, 0) / frames.length;
    expect(Math.abs(cx - base.cx)).toBeLessThan(0.5);
    expect(Math.abs(cy - base.cy)).toBeLessThan(0.5);
    // En los contactos (las dos botas en el suelo) el centro es exactamente el del quieto: una delante y otra detrás
    for (const i of [0, 1, 4, 5]) expect(ground(frames[i]!)).toEqual(base);
    // y cada pierna avanza lo mismo que retrocede en el ciclo
    expect(WALK_POSES.reduce((s, p) => s + p.legL, 0)).toBe(0);
    expect(WALK_POSES.reduce((s, p) => s + p.legR, 0)).toBe(0);
  });

  it('el cuerpo no se mueve en planta: el torso queda en el mismo sitio en todos los cuadros', () => {
    const t = torso(maia);
    for (const f of frames) expect(torso(f)).toEqual(t);
  });

  it('en las 4 vistas, los pies no flotan ni se hunden en la celda del juego', () => {
    // Con el suelo a 0.5, una bota S vóxeles hacia la cámara cae S/2 píxeles más abajo, y hacia atrás, S/2 más
    // arriba: es perspectiva (que no flota ni se hunde lo dice z = 0, más arriba). Lo que se comprueba es que la
    // fila de los pies no se va más allá de eso, y que en los cuadros de paso (el pie de apoyo bajo el cuerpo) es
    // exactamente la de ese pie en el quieto.
    const S = Math.max(...WALK_POSES.map((p) => Math.max(Math.abs(p.legL), Math.abs(p.legR))));
    for (const yaw of [0, 90, 180, 270]) {
      const base = lowestRow(maia, yaw);
      for (const [i, f] of frames.entries()) {
        const row = lowestRow(f, yaw);
        expect(Math.abs(row - base), `giro ${yaw}, cuadro ${i}`).toBeLessThanOrEqual(Math.ceil(S * 0.5));
        // En el paso, el pie que apoya está exactamente donde está ese mismo pie en el quieto
        const lift = WALK_POSES[i]!.lift;
        if (lift) {
          const planted = lift === 'L' ? 'R' : 'L';
          expect(lowestRow(legOf(f, planted), yaw), `giro ${yaw}, cuadro de paso ${i}`).toBe(lowestRow(legOf(maia, planted), yaw));
        }
      }
    }
  });

  it('no pierde ni inventa masa', () => {
    // Margen del 5 %: la melena que cae con retraso tapa vóxeles de la cabeza (como el squash del 2D), la franja de
    // la cadera se la queda el cuerpo al bajar, y el relleno de huecos de la cabeza añade. Un fallo de verdad (una
    // pierna que no se pinta, el pelo en el sitio equivocado) mueve cientos de vóxeles: más del 5 %.
    for (const f of frames) expect(Math.abs(f.size - maia.size) / maia.size).toBeLessThan(0.05);
  });
});
