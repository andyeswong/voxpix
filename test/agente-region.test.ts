// Lo que se ve para un agente, mirado solo donde hace falta: describe y check({ visible }) miran el recuadro de la imagen
// por el que pasa la zona pedida, no la imagen entera. Tienen que dar lo mismo que visibleCells() de toda la imagen, en
// los 4 giros, con y sin sección (también en cruz), en el centro y en los bordes de la rejilla. Y el agua de la capa de
// agua del mundo sale en describe con su letra
import { describe, it, expect } from 'vitest';
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { bakeWorld } from '../src/world/bake';
import { WorldView, type Quarter } from '../src/world/view';
import { sectionAround, SectionPainter, crossWindow, type SectionLayer } from '../src/world/section';
import { WaterLayer, WATER_SHOW } from '../src/world/water';
import type { World } from '../src/world/build';
import { AgentHost, type AgentLook, type Point } from '../src/agent/agent';
import { agentView } from '../src/agent/agentview';

const N = 8;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
  { name: 'arena', colors: ['#8a7040', '#b09060', '#d0b080'] },
] };
const cube = (ramp: number): Array<[number, number, number, number]> => {
  const out: Array<[number, number, number, number]> = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push([x, y, z, material(ramp, 1 + ((x + y + z) % 2))]);
  return out;
};
const COLS = 12, ROWS = 16, LAYERS = 7;
// Un terreno con escalones y huecos, para que haya de todo: lo que se ve, lo tapado y lo que destapa la sección
function world() {
  const set = new BlockSet('prueba', N, PAL);
  set.add('piedra', cube(0)); set.add('tierra', cube(1)); set.add('arena', cube(2));
  const st = new WorldState(new StaticVoxels(PAL, COLS * N, ROWS * N, 0, LAYERS * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++) {
    const h = 2 + ((bx * 3 + by * 5) % 4);
    for (let bz = 0; bz < h; bz++) if (!(bz === h - 1 && (bx + by) % 5 === 0)) grid.set(bx, by, bz, bz < 2 ? 1 : bz < 4 ? 2 : 3);
  }
  return { st, grid };
}
const PLAYER: Point = { x: 5 * N + 4.5, y: 7 * N + 3.25, z: 4 * N };

describe('lo que se ve, solo donde hace falta', () => {
  for (const q of [0, 1, 2, 3] as Quarter[]) {
    it(`describe y check dan lo mismo que visibleCells de toda la imagen (giro ${q})`, () => {
      const { st, grid } = world();
      const view = new WorldView(st, q);
      const baked = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
      let section: SectionLayer | null = null;
      const host = new AgentHost({ state: st, grid, look: (): AgentLook => ({ view, baked, section }), player: () => PLAYER });
      for (const withSection of [false, true, 'cruz'] as const) {
        if (withSection) {
          const p = new SectionPainter(baked, { ahead: 0, behind: 0 });
          const [vx, vy] = view.camera.pointToView(PLAYER.x, PLAYER.y), [wx, wy] = baked.cam.project(vx, vy, PLAYER.z + 6);
          p.set({ ...sectionAround(view.camera, PLAYER.x, PLAYER.y, PLAYER.z, 32), ...(withSection === 'cruz' ? { window: crossWindow(wx, wy, { r: 10, arm: 6 }) } : {}) }, 0); p.paintAll();
          section = p.layer();
        }
        const all = host.visibleCells()!;
        let hidden = 0, shown = 0;
        for (const [cx, cy, cz, r] of [[5, 7, 4, 3], [0, 0, 3, 2], [11, 15, 5, 4], [6, 2, 2, 6], [3, 12, 6, 1]] as const) {
          const d = host.describe({ at: { x: cx * N + 1, y: cy * N + 1, z: cz * N }, radius: r, below: 6, above: 6 });
          d.layers.forEach((L) => L.rows.forEach((row, i) => [...row].forEach((ch, j) => {
            const bx = d.x[0] + j, by = d.y[1] - i, t = bx >= 0 && by >= 0 && bx < COLS && by < ROWS ? grid.get(bx, by, L.bz) : 0;
            if (!t || ch === '@') return;
            const vis = all.has(`${bx},${by},${L.bz}`);
            expect([bx, by, L.bz, ch === ch.toUpperCase()]).toEqual([bx, by, L.bz, vis]);
            if (vis) shown++; else hidden++;
          })));
        }
        expect(shown).toBeGreaterThan(20);
        expect(hidden).toBeGreaterThan(20);
        for (let bz = 0; bz < LAYERS; bz++) for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++)
          expect([bx, by, bz, host.check([bx, by, bz], { visible: true }) === null]).toEqual([bx, by, bz, all.has(`${bx},${by},${bz}`)]);
      }
    });
  }
});

describe('el agua en describe', () => {
  // Piedra en las capas 0-2 y un lago en bx 2..4, by 2..4: sin la capa 2 y con el agua hasta su techo (z 24). Debajo del
  // lago, una cueva (la celda 3, 3, 0 vacía): aire bajo el fondo, que no es agua
  function lake(letters?: Record<string, string>, water?: string | false) {
    const set = new BlockSet('prueba', N, PAL);
    set.add('piedra', cube(0));
    const s = new StaticVoxels(PAL, 8 * N, 8 * N, 0, 4 * N - 1), st = new WorldState(s, [], null), grid = new BlockGrid(st, set);
    const inLake = (bx: number, by: number) => bx >= 2 && bx <= 4 && by >= 2 && by <= 4;
    for (let by = 0; by < 8; by++) for (let bx = 0; bx < 8; bx++) {
      if (bx !== 3 || by !== 3) grid.set(bx, by, 0, 1);
      grid.set(bx, by, 1, 1);
      if (!inLake(bx, by)) grid.set(bx, by, 2, 1);
    }
    const W = 8 * N, wet = new Uint8Array(W * W), waterTop = new Int16Array(W * W);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (inLake(Math.floor(x / N), Math.floor(y / N))) { wet[y * W + x] = 1; waterTop[y * W + x] = 3 * N; }
    st.water = new WaterLayer({ model: s, lights: [], width: W, depth: W, wet, waterTop } as unknown as World, { wallAbove: Infinity });
    const host = new AgentHost({ state: st, grid, player: () => ({ x: 6 * N + 1, y: 6 * N + 1, z: 3 * N }), ...(letters ? { letters } : {}), ...(water !== undefined ? { water } : {}) });
    return { host, d: host.describe({ at: { x: 3 * N + 1, y: 3 * N + 1, z: 2 * N }, radius: 3, below: 2, above: 1 }) };
  }

  it('las celdas de aire con agua salen con su letra, en la leyenda y en la vista en color', () => {
    const { host, d } = lake();
    expect(d.layers.map((L) => L.bz)).toEqual([3, 2, 1, 0]);
    expect(d.water).toBe('~');
    // capa 2: el lago (bx 2..4, by 2..4) en el centro, piedra alrededor; capa 1, el fondo; capa 3, aire: el agua no pasa
    // del techo de la capa 2. En la capa 0, la cueva bajo el lago es aire
    expect(d.layers[1]!.rows).toEqual(['PPPPPPP', 'PPPPPPP', 'PP~~~PP', 'PP~~~PP', 'PP~~~PP', 'PPPPPPP', 'PPPPPPP']);
    expect(d.layers[2]!.rows.every((r) => r === 'PPPPPPP')).toBe(true);
    expect(d.layers[0]!.rows.join('')).not.toContain('~');
    expect(d.layers[3]!.rows[3]).toBe('PPP.PPP');
    expect(d.text).toContain(', ~ agua');
    const v = agentView(host, d, { water: '#0000ff' });
    const cells = v.layers.flatMap((L) => L.rows.flat());
    expect(cells.filter((c) => c.kind === 'water').length).toBe(9);
    expect(cells.filter((c) => c.kind === 'water').every((c) => c.ch === '~' && c.color === '#0000ff' && !c.dim)).toBe(true);
    expect(v.legend).toContainEqual({ ch: '~', id: 'agua', color: '#0000ff' });
  });

  it('si "~" es de un bloque, el agua es "≈"; con water: false, aire como antes', () => {
    expect(lake({ piedra: '~' }).d.layers[1]!.rows[3]).toBe('~~≈≈≈~~');
    const dry = lake(undefined, false).d;
    expect(dry.water).toBeUndefined();
    expect(dry.layers[1]!.rows[3]).toBe('PP...PP');
    expect(dry.text).not.toContain('agua');
    expect(() => lake(undefined, 'P')).toThrow();
  });

  // La película que deja el simulador al tocar una orilla: milésimas de vóxel sobre el suelo seco. El render no la pinta
  // (WATER_SHOW) y describe tampoco la cuenta; ni el pelo de agua de un lago que asoma por encima del techo de una celda
  const view = (host: AgentHost) => host.describe({ at: { x: 3 * N + 1, y: 3 * N + 1, z: 2 * N }, radius: 3, below: 2, above: 1 });
  function film(depth: number, lakeOver = 0) {
    const { host } = lake(), sim = (host as unknown as { opts: { state: WorldState } }).opts.state.water!.sim;
    let filmed = 0;
    for (let i = 0; i < sim.depth.length; i++) {
      if (sim.solid[i]) continue;
      if (sim.depth[i]! > 1) sim.depth[i] = 3 * N - sim.ground[i]! + lakeOver;     // el lago, con la superficie a 24 + lakeOver
      else if (sim.ground[i] === 3 * N) { sim.depth[i] = depth; filmed++; }       // la piedra de alrededor, con la película
    }
    expect(filmed).toBeGreaterThan(100);
    return view(host);
  }

  it('una película de 0,001 sobre el suelo no es agua; el lago, igual que antes', () => {
    const d = film(0.001);
    expect(d.layers[0]!.bz).toBe(3);
    expect(d.layers[0]!.rows.join('')).not.toContain('~');
    expect(d.layers[1]!.rows).toEqual(['PPPPPPP', 'PPPPPPP', 'PP~~~PP', 'PP~~~PP', 'PP~~~PP', 'PPPPPPP', 'PPPPPPP']);
  });

  it('el umbral es el del render: justo por debajo de WATER_SHOW no hay agua, justo por encima sí', () => {
    const under = film(WATER_SHOW * 0.75).layers[0]!.rows, over = film(WATER_SHOW * 1.25).layers[0]!.rows;
    expect(under.join('')).not.toContain('~');
    // por encima, la película se cuenta: la capa 3 sobre la piedra (todo menos el hueco del lago y el jugador) es agua
    expect(over).toEqual(['~~~~~~@', '~~~~~~~', '~~...~~', '~~...~~', '~~...~~', '~~~~~~~', '~~~~~~~']);
  });

  it('un lago que asoma 0,02 por encima del techo de la celda: la celda de arriba no es agua', () => {
    const d = film(0, 0.02);
    expect(d.layers[0]!.rows.join('')).not.toContain('~');
    expect(d.layers[1]!.rows[3]).toBe('PP~~~PP');
    // con un vóxel por encima, sí
    expect(film(0, 1).layers[0]!.rows[3]).toBe('..~~~..');
  });
});
