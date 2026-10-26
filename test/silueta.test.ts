// La silueta a través de lo que tapa (Frame2DOptions.xray): una entidad detrás de una pared se ve como un damero de su
// color, con luz propia; delante de todo se ve como siempre; sin xray, nada cambia.
import { describe, it, expect } from 'vitest';
import { Model, box, material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld } from '../src/world/bake';
import { frame2D, frame2DParts, type Frame2DOptions } from '../src/world/frame2d';

const PAL = { ramps: [{ name: 'suelo', colors: ['#202020', '#404040', '#606060', '#808080'] }, { name: 'muro', colors: ['#302040', '#504070', '#8070b0'] }] };
const XR = [255, 0, 255] as const;

function scene(behind: boolean) {
  const s = new StaticVoxels(structuredClone(PAL), 40, 40, -2, 24);
  for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) s.set(x, y, 0, material(0, 1));
  // Un muro alto en y = 20, de 16 (y grande = lejos de la cámara: lo de y > 20 queda detrás)
  for (let z = 1; z <= 16; z++) for (let x = 5; x < 35; x++) s.set(x, 20, z, material(1, 1));
  const state = new WorldState(s, [], null);
  const m = new Model({ ramps: [{ name: 'cuerpo', colors: ['#400000', '#800000', '#c00000', '#ff0000'] }] });
  box(m, -1, -1, 0, 1, 1, 5, material(0, 2));
  state.addEntity('alguien', m, 20, behind ? 23 : 12, 1);
  const b = bakeWorld({ model: s, lights: [], width: 40, depth: 40 }, { topZ: 24 });
  return { state, b };
}
const count = (img: Uint8ClampedArray) => { let n = 0; for (let i = 0; i < img.length; i += 4) if (img[i] === 255 && img[i + 1] === 0 && img[i + 2] === 255) n++; return n; };

describe('silueta a través de lo que tapa', () => {
  it('detrás de la pared: damero del color de la silueta, con luz propia; sin xray, nada', () => {
    const { state, b } = scene(true);
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.1, 0.1, 0.1] };
    expect(count(frame2D(state, b, o))).toBe(0);
    const { view, total } = frame2DParts(state, b, { ...o, xray: { color: XR } });
    const n = count(view);
    expect(n).toBeGreaterThan(4);
    // Con luz propia
    for (let i = 0; i < view.length / 4; i++) if (view[i * 4] === 255 && view[i * 4 + 1] === 0 && view[i * 4 + 2] === 255) expect(total![i * 3]).toBe(1);
    // En damero: ningún par de vecinos horizontales los dos de silueta
    for (let i = 0; i + 1 < view.length / 4; i++) {
      const a = view[i * 4] === 255 && view[i * 4 + 1] === 0, c = view[(i + 1) * 4] === 255 && view[(i + 1) * 4 + 1] === 0;
      if ((i + 1) % b.width) expect(a && c).toBe(false);
    }
  });

  it('delante de todo, la entidad se ve como siempre (sin silueta)', () => {
    const { state, b } = scene(false);
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: false, ambient: [1, 1, 1] };
    const plain = frame2D(state, b, o), xr = frame2D(state, b, { ...o, xray: { color: XR } });
    expect(count(xr)).toBe(0);
    expect(Buffer.from(xr).equals(Buffer.from(plain))).toBe(true);
  });
});
