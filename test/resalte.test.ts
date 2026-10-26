// El resalte de un objeto estático del escenario (Frame2DOptions.highlight): un aro exterior de luz propia alrededor
// de lo que se ve de los vóxeles de la caja, sin rehornear; las entidades que pasan por delante lo tapan
import { describe, it, expect } from 'vitest';
import { Model, box, material, unkey } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D, highlightMask, type Frame2DOptions } from '../src/world/frame2d';

const PAL = { ramps: [{ name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] }, { name: 'pilon', colors: ['#302040', '#504070', '#8070b0'] }] };
function world(): { state: WorldState; s: StaticVoxels } {
  const s = new StaticVoxels(structuredClone(PAL), 48, 40, -2, 16);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 48; x++) s.set(x, y, 0, material(0, 1));
  // Un pilón hueco (un anillo de 10 x 10 con el centro vacío) y una columna en medio
  for (let z = 1; z <= 3; z++) for (let y = 15; y < 25; y++) for (let x = 19; x < 29; x++) if (x === 19 || x === 28 || y === 15 || y === 24) s.set(x, y, z, material(1, 1));
  for (let z = 1; z <= 8; z++) s.set(23, 20, z, material(1, 2));
  return { state: new WorldState(s, [], null), s };
}
const BOX = [17, 13, 1, 30, 26, 10] as const;
const GOLD = [255, 214, 102] as const;

describe('resaltar un objeto del escenario', () => {
  it('el aro va por fuera de la silueta, no dentro del pilón, y tiene el color con luz propia', () => {
    const { state, s } = world();
    const b = bakeWorld({ model: s, lights: [], width: 48, depth: 40 }, { topZ: 16 });
    const m = highlightMask(b, { box: BOX, color: GOLD, width: 1 })!;
    expect(m.mask.some((v) => v === 1)).toBe(true);
    const [rx, ry, rw, rh] = m.rect;
    // Ningún píxel del aro muestra el fondo de DENTRO del pilón (el suelo rodeado por el anillo)
    let inner = 0;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) if (m.mask[j * rw + i]) {
      const k = b.pick[(ry + j) * b.width + rx + i]!;
      if (Number.isNaN(k)) continue;
      const [x, y, z] = unkey(k);
      if (z === 0 && x > 19 && x < 28 && y > 15 && y < 24) inner++;
    }
    expect(inner).toBe(0);
    // En el cuadro, los píxeles del aro son exactamente el color (con y sin luces)
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.3, 0.3, 0.4], highlight: { box: BOX, color: GOLD, width: 1 } };
    const img = frame2D(state, b, o);
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) if (m.mask[j * rw + i]) {
      const t = ((ry + j) * b.width + rx + i) * 4;
      expect([img[t], img[t + 1], img[t + 2]]).toEqual([...GOLD]);
    }
    // Sin resalte, el cuadro es el de siempre (y con él, solo cambian los píxeles del aro)
    const plain = frame2D(state, b, { ...o, highlight: null });
    let diff = 0;
    for (let p = 0; p < b.width * b.height; p++) if (plain[p * 4] !== img[p * 4] || plain[p * 4 + 1] !== img[p * 4 + 1] || plain[p * 4 + 2] !== img[p * 4 + 2]) diff++;
    expect(diff).toBe(m.mask.reduce((a, v) => a + v, 0) - countOutside(m, b));
  });

  it('una entidad delante tapa el aro; la máscara se guarda y se rehace al rehornear', () => {
    const { state, s } = world();
    const b = bakeWorld({ model: s, lights: [], width: 48, depth: 40 }, { topZ: 16 });
    const h = { box: BOX, color: GOLD, width: 2 };
    const m1 = highlightMask(b, h)!;
    expect(highlightMask(b, h)).toBe(m1);                         // guardada
    const body = new Model({ ramps: [{ name: 'c', colors: ['#004000', '#008000'] }] });
    box(body, -2, -1, 0, 2, 1, 12, material(0, 1));
    state.entities.add({ model: body, x: 24, y: 12, z: 1, facing: 0, castsShadow: false });   // delante (al sur) del pilón
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: false, ambient: [1, 1, 1], highlight: h };
    const img = frame2D(state, b, o);
    const [rx, ry, rw, rh] = m1.rect;
    let gold = 0, ring = 0;
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) if (m1.mask[j * rw + i]) {
      ring++;
      const t = ((ry + j) * b.width + rx + i) * 4;
      if (img[t] === 255 && img[t + 1] === 214) gold++;
    }
    expect(gold).toBeLessThan(ring);                              // la entidad tapa parte
    expect(gold).toBeGreaterThan(0);
  });
});

// Píxeles del aro que caen fuera de la imagen (no cuentan como cambiados)
function countOutside(m: { rect: [number, number, number, number]; mask: Uint8Array }, b: { width: number; height: number }): number {
  const [rx, ry, rw, rh] = m.rect;
  let n = 0;
  for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) if (m.mask[j * rw + i] && (rx + i >= b.width || ry + j >= b.height)) n++;
  return n;
}
