// El agua por columnas en un mundo alto (WaterLayer con { wallAbove }): un lago cuya superficie está a z 40 (por
// encima del tramo de siempre, -16..32). Con la pared de siempre (8) no hay agua; con wallAbove Infinity sí, su tramo
// de alturas se ensancha y se dibuja. Siguiendo al mundo (follow), un hoyo junto al lago se llena y un bloque puesto en
// el agua la desplaza. Con el corte de la vista, el agua por encima de lo cortado no se dibuja
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { bakeWorld } from '../src/world/bake';
import { frame2D, type Frame2DOptions } from '../src/world/frame2d';
import { WorldView } from '../src/world/view';
import { clearBox } from '../src/world/edit';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const W = 64, D = 64, FLOOR = 40, BED = 34;
// El suelo hasta z 40 y un lago de x 16..39, y 20..43, con el fondo a z 34; el agua llega a ras del suelo
function setup(opts: { wallAbove?: number }) {
  const s = new StaticVoxels(PAL, W, D, 0, 63);
  const lake = (x: number, y: number) => x >= 16 && x < 40 && y >= 20 && y < 44;
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z < (lake(x, y) ? BED : FLOOR); z++) s.set(x, y, z, material(0, 1 + ((x + y) & 1)));
  const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (lake(x, y)) { wet[y * W + x] = 1; waterTop[y * W + x] = FLOOR; }
  const world = { model: s, lights: [], width: W, depth: D, wet, waterTop } as unknown as World;
  const water = new WaterLayer(world, opts);
  return { s, st: new WorldState(s, [], water), water };
}
const cellDepth = (w: WaterLayer, x: number, y: number) => w.depthAt(x, y);

describe('agua en un mundo alto', () => {
  it('con la pared de siempre no hay agua; con wallAbove Infinity sí, con su tramo de alturas, y se dibuja', () => {
    expect(cellDepth(setup({}).water, 28, 30)).toBe(0);                  // fondo a 34 > 8: pared
    const { st, s, water } = setup({ wallAbove: Infinity });
    expect(cellDepth(water, 28, 30)).toBeCloseTo(FLOOR - BED, 5);
    expect(water.zRange[1]).toBeGreaterThan(FLOOR);
    const b = bakeWorld({ model: s, lights: [], width: W, depth: D }, { topZ: 63 });
    const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.8] };
    const dry = new WorldState(s, [], null);
    const a = frame2D(st, b, o), c = frame2D(dry, b, o);
    let differ = 0;
    for (let i = 0; i < a.length; i += 4) if (a[i] !== c[i] || a[i + 1] !== c[i + 1] || a[i + 2] !== c[i + 2]) differ++;
    expect(differ).toBeGreaterThan(200);                                   // el lago se ve (24 x 12 píxeles)
    // Y en una vista que solo coge las filas del lago: las filas de celdas salen de su tramo de alturas, no de -16..32
    const [, top] = b.cam.project(16, 44, FLOOR), [, bot] = b.cam.project(16, 20, FLOOR);
    const vy = Math.floor(top) - 1, vh = Math.ceil(bot) - vy + 2;
    const o2 = { ...o, vy, vh }, a2 = frame2D(st, b, o2), c2 = frame2D(dry, b, o2);
    let differ2 = 0;
    for (let i = 0; i < a2.length; i += 4) if (a2[i] !== c2[i] || a2[i + 1] !== c2[i + 1] || a2[i + 2] !== c2[i + 2]) differ2++;
    expect(differ2).toBeGreaterThan(200);
  });

  it('siguiendo al mundo: un hoyo junto al lago se llena, y un bloque puesto en el agua la desplaza', () => {
    const { st, water } = setup({ wallAbove: Infinity });
    water.follow(st.watchChanges());
    const view = new WorldView(st, 0, { cut: true });                       // una vista que también lo sigue
    clearBox(st, { x0: 40, y0: 28, z0: 36, x1: 47, y1: 35, z1: 63 });      // una zanja al este, hasta z 36
    for (let k = 0; k < 6; k++) for (const [x, y] of [[30, 30], [31, 30], [30, 31], [31, 31]] as const) st.solid.set(x, y, BED + k, material(0, 1));   // un pilar de 2 x 2 dentro del lago hasta z 40
    const v0 = water.groundVersion;
    st.step();
    expect(water.groundVersion).toBeGreaterThan(v0);                       // la GPU vuelve a subir el fondo
    expect(view.frame().water!.groundVersion).toBe(water.groundVersion);
    expect(water.surfaceAt(30, 30)).toBeLessThanOrEqual(FLOOR + 0.01);     // el agua desplazada no sube por encima
    for (let t = 0; t < 240; t++) st.step();
    expect(cellDepth(water, 44, 31)).toBeGreaterThan(0.5);                 // la zanja tiene agua
    expect(water.surfaceAt(44, 31)).toBeLessThanOrEqual(FLOOR + 0.5);
    expect(cellDepth(water, 30, 30)).toBeLessThan(0.1);                    // donde está la columna, ya no
    const vw = view.frame().water!, j = Math.floor(31 / 2) * vw.gw + Math.floor(44 / 2), k = Math.floor(31 / 2) * water.gw + Math.floor(44 / 2);
    expect(vw.sim.ground[j]).toBe(water.sim.ground[k]);                    // la vista ve el fondo nuevo de la zanja
    // Sin seguir al mundo, como siempre: la zanja se queda seca
    const other = setup({ wallAbove: Infinity });
    clearBox(other.st, { x0: 40, y0: 28, z0: 36, x1: 47, y1: 35, z1: 63 });
    for (let t = 0; t < 240; t++) other.st.step();
    expect(cellDepth(other.water, 44, 31)).toBe(0);
  });

  it('con el corte de la vista, el agua que queda por encima de lo cortado no se dibuja', () => {
    const { st } = setup({ wallAbove: Infinity });
    const view = new WorldView(st, 0, { cut: true });
    view.setCut({ x0: 16, y0: 20, x1: 27, y1: 43, zTop: 37 });              // la mitad oeste del lago, por debajo del agua
    const rs = view.frame();
    const w = rs.water!, cell = (x: number, y: number) => w.sim.depth[Math.floor(y / 2) * w.gw + Math.floor(x / 2)]!;
    expect(cell(20, 30)).toBe(0);                                          // cortado
    expect(cell(34, 30)).toBeGreaterThan(5);                               // fuera del corte
  });
});
