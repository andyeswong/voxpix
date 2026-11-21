// EL FOCO del agua (ShallowWater.focus, WaterLayer.setFocus): solo se simula lo de cerca. Las condiciones:
// - todo dentro del foco: la misma huella, byte a byte (profundidad, flujos y despiertas), que sin foco; con el foco igual a
//   la rejilla y con uno que deja fuera solo tierra seca;
// - lo de fuera queda congelado: sus profundidades, flujos y despiertas no cambian, ni se empapa, ni el volumen;
// - retoma donde estaba: un lago aislado congelado K ticks y suelto después evoluciona como el mismo lago sin congelar.
// El montaje es el del test del borde (agua-cargar): trozos cargados con lagos a 7 y agua a 9, ticks y un pisotón.
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { CHUNK, StaticVoxels } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const C = 6, R = 5, W = C * CHUNK, D = R * CHUNK, ZMAX = 31, CELL = 2;
const top = (x: number, y: number) => 12 + Math.round(3 * Math.sin(x / 9) + 2 * Math.cos(y / 7));
const lake = (x: number, y: number) => Math.sin(x / 13) + Math.cos(y / 11) > 1.1;
const floorAt = (x: number, y: number) => (lake(x, y) ? 4 : top(x, y));

function voxels(floor: (x: number, y: number) => number = floorAt): StaticVoxels {
  const s = new StaticVoxels(PAL, W, D, 0, ZMAX);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) { const f = floor(x, y); for (let z = 0; z < f; z++) s.set(x, y, z, material(0, 1)); }
  return s;
}
const rect = (cx: number, cy: number) => [cx * CHUNK, cy * CHUNK, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1] as const;
function layer(s: StaticVoxels, surface: (x: number, y: number, cx: number, cy: number) => number | null): WaterLayer {
  const w = new WaterLayer({ model: s, lights: [], width: W, depth: D, wet: new Uint8Array(0), waterTop: new Int16Array(0), fountain: null } as unknown as World, { wallAbove: Infinity, unloaded: true, movable: true });
  for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) w.load(...rect(cx, cy), { surface: (x, y) => surface(x, y, cx, cy) });
  return w;
}
const montaje = (x: number, y: number, cx: number, cy: number) => (lake(x, y) ? 7 : (cx + cy) % 3 === 0 ? 9 : null);

function sameState(a: WaterLayer, b: WaterLayer, what: string): void {
  const ea = a.exportState(), eb = b.exportState();
  for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake'] as const) {
    const x = ea[k], y = eb[k];
    let bad = -1;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) { bad = i; break; }
    expect([what, k, bad]).toEqual([what, k, -1]);
  }
}

describe('agua: el foco', () => {
  it('todo dentro del foco: la misma huella que sin foco (foco = la rejilla, y foco que deja fuera solo tierra seca)', () => {
    const s = voxels();
    const none = layer(s, montaje), full = layer(s, montaje);
    full.sim.focus = [0, 0, full.gw - 1, full.gh - 1];
    // (otro mundo: todo seco y alto salvo un estanque en medio; el foco lo rodea con 8 celdas de tierra: más que lo que
    // despierta un pisotón de radio 1, 6 celdas. "Todo dentro" es también lo que se despierta)
    const pond = (x: number, y: number) => (x >= 40 && x < 56 && y >= 30 && y < 50 ? 4 : 14);
    const s2 = voxels(pond);
    const nn = layer(s2, (x, y) => (x >= 40 && x < 56 && y >= 30 && y < 50 ? 9 : null)), ff = layer(s2, (x, y) => (x >= 40 && x < 56 && y >= 30 && y < 50 ? 9 : null));
    ff.sim.focus = [40 / CELL - 8, 30 / CELL - 8, 56 / CELL + 7, 50 / CELL + 7];
    for (let t = 0; t < 240; t++) {
      if (t === 40) for (const w of [none, full]) w.disturb(CHUNK * 3 + 1, CHUNK * 2 + 4, 2.8, 3);
      if (t % 30 === 5) for (const w of [nn, ff]) w.disturb(48, 40, 2.8, 1);
      for (const w of [none, full, nn, ff]) w.step(1 / 60);
      if (t % 40 === 39) { sameState(none, full, `foco = rejilla, tick ${t}`); sameState(nn, ff, `foco con tierra alrededor, tick ${t}`); }
    }
    expect(nn.sim.activeCount).toBeGreaterThan(0);
  });

  it('fuera del foco, congelado: ni profundidad, ni flujos, ni despiertas cambian, ni se empapa; el volumen, igual', () => {
    const s = voxels();
    const w = layer(s, montaje);
    // Agua moviéndose en todas partes (pisotones, también junto a los bordes del foco), y agua en seco empapándose (gotas
    // fuera de cuenca)
    for (const [x, y] of [[20, 10], [70, 50], [30, 60], [16, 40], [80, 20]] as Array<[number, number]>) w.disturb(x, y, 2.8, 3);
    for (const [x, y] of [[85, 70], [10, 70]] as Array<[number, number]>) w.pour(x, y, 3);
    for (let t = 0; t < 5; t++) w.step(1 / 60);
    // El foco: un recuadro en medio (sus cuatro lados dentro de la rejilla, con agua cruzándolos)
    const F: [number, number, number, number] = [8, 5, w.gw - 9, w.gh - 6];
    const inF = (gx: number, gy: number) => gx >= F[0] && gx <= F[2] && gy >= F[1] && gy <= F[3];
    w.sim.focus = F;
    const before = w.exportState();
    const outVol = (d: Float32Array) => { let v = 0; for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < w.gw; gx++) if (!inF(gx, gy)) v += d[gy * w.gw + gx]!; return v; };
    const inVol = (d: Float32Array) => { let v = 0; for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < w.gw; gx++) if (inF(gx, gy)) v += d[gy * w.gw + gx]!; return v; };
    let moved = 0, edgeWet = 0;
    for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < w.gw; gx++) if (!inF(gx, gy) && (inF(gx + 1, gy) || inF(gx - 1, gy) || inF(gx, gy + 1) || inF(gx, gy - 1)) && before.depth[gy * w.gw + gx]! > 0.05) edgeWet++;
    // (con el foco puesto, solo gotas en el centro: un pisotón es un evento que toca lo de alrededor, profundidad y
    // despiertas, en un radio de hasta 18 celdas, esté donde esté; lo que se congela es la simulación)
    for (let t = 0; t < 120; t++) { if (t % 10 === 0) w.pour(48, 40, 2); w.step(1 / 60); }
    const after = w.exportState();
    for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake'] as const) {
      for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < w.gw; gx++) {
        const i = gy * w.gw + gx;
        if (!inF(gx, gy)) { if (!Object.is(after[k][i], before[k][i])) throw new Error(`fuera del foco, ${k} cambió en ${gx},${gy}`); }
        else if (k === 'depth' && after.depth[i] !== before.depth[i]) moved++;
      }
    }
    expect(outVol(after.depth)).toBe(outVol(before.depth));
    // (dentro, el agua no se va por el borde: lo de dentro es lo de antes más las gotas, menos lo que se empapa)
    expect(inVol(after.depth)).toBeLessThanOrEqual(inVol(before.depth) + 12 * 2 + 1e-3);
    expect(moved).toBeGreaterThan(50);
    expect(edgeWet).toBeGreaterThan(10);
    // (y lo de fuera seguía despierto: congelado, no dormido)
    let awakeOut = 0;
    for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < w.gw; gx++) if (!inF(gx, gy) && after.awake[gy * w.gw + gx]! > 0) awakeOut++;
    expect(awakeOut).toBeGreaterThan(20);
  });

  it('dentro del foco, su borde es pared: lo mismo, byte a byte, que sin foco con lo de fuera hecho pared', () => {
    const s = voxels();
    const focused = layer(s, montaje), walled = layer(s, montaje);
    for (const w of [focused, walled]) { for (const [x, y] of [[20, 10], [70, 50], [16, 40], [80, 20], [48, 12]] as Array<[number, number]>) w.disturb(x, y, 2.8, 3); for (let t = 0; t < 5; t++) w.step(1 / 60); }
    const F: [number, number, number, number] = [8, 5, focused.gw - 9, focused.gh - 6];
    const inF = (gx: number, gy: number) => gx >= F[0] && gx <= F[2] && gy >= F[1] && gy <= F[3];
    focused.sim.focus = F;
    for (let gy = 0; gy < walled.gh; gy++) for (let gx = 0; gx < walled.gw; gx++) if (!inF(gx, gy)) walled.sim.solid[walled.sim.at(gx, gy)] = 1;
    for (let t = 0; t < 150; t++) {
      if (t % 10 === 0) for (const w of [focused, walled]) w.pour(48, 40, 2);
      focused.step(1 / 60); walled.step(1 / 60);
      if (t % 25 === 24) {
        const a = focused.exportState(), b = walled.exportState();
        for (const k of ['depth', 'fl', 'fr', 'ft', 'fb'] as const) for (let gy = F[1]; gy <= F[3]; gy++) for (let gx = F[0]; gx <= F[2]; gx++) {
          const i = gy * focused.gw + gx;
          if (!Object.is(a[k][i], b[k][i])) throw new Error(`tick ${t}: ${k} distinto en ${gx},${gy}`);
        }
      }
    }
    expect(focused.sim.activeCount).toBeGreaterThan(0);
  });

  it('retoma donde estaba: un lago aislado congelado K ticks y suelto después, igual que el mismo lago sin congelar', () => {
    // Dos estanques separados por tierra alta: A (oeste) y B (este)
    const twoPonds = (x: number, y: number) => ((x >= 8 && x < 30 && y >= 20 && y < 60) || (x >= 60 && x < 88 && y >= 20 && y < 60) ? 4 : 16);
    const s = voxels(twoPonds);
    const surf = (x: number, y: number) => (twoPonds(x, y) === 4 ? 9 : null);
    const frozen = layer(s, surf), ref = layer(s, surf);
    // Un pisotón en B en las dos; en frozen, B fuera del foco K ticks (A sí se mueve: otro pisotón)
    for (const w of [frozen, ref]) w.disturb(74, 40, 2.8, 3);
    frozen.disturb(18, 40, 2.8, 3);
    frozen.sim.focus = [0, 0, 44 / CELL, frozen.gh - 1];
    for (let t = 0; t < 50; t++) frozen.step(1 / 60);
    frozen.sim.focus = null;
    // B en frozen ahora = B en ref antes de dar ningún tick: M ticks en las dos y B igual byte a byte
    const cellsB: number[] = [];
    for (let gy = 0; gy < frozen.gh; gy++) for (let gx = 48 / CELL; gx < frozen.gw; gx++) cellsB.push(gy * frozen.gw + gx);
    for (let t = 0; t < 90; t++) {
      frozen.step(1 / 60); ref.step(1 / 60);
      if (t % 15 === 14) {
        const a = frozen.exportState(), b = ref.exportState();
        for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake'] as const) for (const i of cellsB) if (!Object.is(a[k][i], b[k][i])) throw new Error(`tick ${t}: ${k} de B distinto en ${i % frozen.gw},${Math.floor(i / frozen.gw)}`);
      }
    }
    expect(ref.sim.activeCount).toBeGreaterThan(0);
  });

  it('setFocus: en vóxeles, un recuadro de celdas alrededor del punto, recortado a la rejilla; null, todo', () => {
    const w = layer(voxels(), montaje);
    w.setFocus(40, 30, 10);
    expect(w.sim.focus).toEqual([15, 10, 25, 20]);
    w.setFocus(2, 2, 10);
    expect(w.sim.focus).toEqual([0, 0, 6, 6]);
    w.setFocus(-100, -100, 5);
    expect(w.sim.focus).toEqual([0, 0, -1, -1]);
    w.setFocus(null);
    expect(w.sim.focus).toBeNull();
  });
});
