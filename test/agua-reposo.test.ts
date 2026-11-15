// El agua en reposo no cuesta nada: un paso sin nada despierto no recorre la rejilla, ni el simulador (las despiertas
// van en lista) ni el empapado (las celdas mojadas fuera de cuenca, también). Picar, pisar o echar agua en suelo seco
// las vuelve a recorrer, y luego se duermen. La simulación es la misma que recorriendo la rejilla: la huella de la
// partida de abajo está fijada con el código de antes
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { clearBox } from '../src/world/edit';
import { buildWorldState, type World } from '../src/world/build';
import { generateLayout } from '../src/worldgen';
import { BlockSet, BlockGrid, type VoxsetFile } from '../src/world/blocks';
import { generateMap, applyMap, mapWater } from '../src/world/mapgen';
import { THEMES } from '../src/samples/themes';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const W = 64, D = 64, FLOOR = 40, BED = 34;
// El suelo hasta z 40 y un lago de x 16..39, y 20..43, con el fondo a z 34; el agua llega a ras del suelo
function setup() {
  const s = new StaticVoxels(PAL, W, D, 0, 63);
  const lake = (x: number, y: number) => x >= 16 && x < 40 && y >= 20 && y < 44;
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z < (lake(x, y) ? BED : FLOOR); z++) s.set(x, y, z, material(0, 1 + ((x + y) & 1)));
  const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (lake(x, y)) { wet[y * W + x] = 1; waterTop[y * W + x] = FLOOR; }
  const world = { model: s, lights: [], width: W, depth: D, wet, waterTop } as unknown as World;
  const water = new WaterLayer(world, { wallAbove: Infinity });
  const st = new WorldState(s, [], water, { seed: 5 });
  water.follow(st.watchChanges());
  return { st, water };
}
const rest = (st: WorldState, water: WaterLayer) => { for (let t = 0; t < 400 && (water.sim.visited || water.soakVisited || water.sim.activeCount); t++) st.step(); };

describe('agua en reposo', () => {
  it('sin nada despierto, el paso no recorre ninguna celda; picar, pisar o echar agua las recorre y se vuelven a dormir', () => {
    const { st, water } = setup();
    st.step();
    expect(water.sim.visited).toBe(144);                                   // al nacer, todo lo mojado está despierto (12 x 12 celdas)
    rest(st, water);
    st.step();
    expect(water.sim.visited).toBe(0);
    expect(water.sim.activeCount).toBe(0);
    expect(water.soakVisited).toBe(0);
    // Pisar el lago: se recorre lo despierto (aquí, con la rejilla de 32 x 32, casi toda: despierta un radio de 18)
    st.events.disturb(28, 30, 2.8, 3);
    st.step();
    expect(water.sim.visited).toBeGreaterThan(0);
    rest(st, water);
    // Agua en suelo seco: se empapa (la recorre el empapado) hasta secarse
    water.pour(50, 50, 1.5);
    st.step();
    expect(water.soakVisited).toBeGreaterThan(0);
    expect(water.depthAt(50, 50)).toBeGreaterThan(0);
    rest(st, water);
    st.step();
    expect(water.depthAt(50, 50)).toBe(0);
    expect(water.soakVisited).toBe(0);
    expect(water.sim.visited).toBe(0);
  });

  it('nacer dormida (asleep): con lagos en reposo, la misma agua que naciendo despierta y durmiéndose, sin sus ticks caros', () => {
    // Un mundo de bloques con lagos (mapgen + mapWater), de 16 x 16 x 12 bloques de 8
    const B = 8, ids = ['piedra', 'tierra', 'hierba', 'arena', 'agua'];
    const pal = { ramps: ids.map((name) => ({ name, colors: ['#303030', '#606060', '#909090'] })) };
    const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, 1)]); return o; };
    const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'a', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as VoxsetFile);
    const T = (id: string) => set.index(id);
    const map = generateMap({ seed: 1, width: 16, depth: 16, height: 12, surface: { base: 6, amplitude: 2.5, scale: 7 },
      strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
      seaLevel: 6, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 } });
    const s = new StaticVoxels(pal, 16 * B, 16 * B, 0, 12 * B - 1);
    applyMap(map, new BlockGrid(new WorldState(s, [], null), set), { skip: [T('agua')] });
    const world = { model: s, lights: [], width: s.width, depth: s.depth, ...mapWater(map, B, T('agua')) } as unknown as World;
    const awake = new WaterLayer(world, { wallAbove: Infinity }), asleep = new WaterLayer(world, { wallAbove: Infinity, asleep: true });
    const a = new WorldState(s, [], awake, { seed: 1 }), b = new WorldState(s, [], asleep, { seed: 1 });
    let wet = 0;
    for (let i = 0; i < awake.sim.depth.length; i++) if (awake.sim.depth[i]! > 0.04) wet++;
    expect(wet).toBeGreaterThan(100);
    a.step(); b.step();
    expect(awake.sim.visited).toBeGreaterThan(100);                        // despierta: recorre todo lo mojado
    expect(asleep.sim.visited).toBe(0);                                    // dormida: nada
    for (let t = 0; t < 120; t++) { a.step(); b.step(); }
    const same = () => { const x = awake.exportState(), y = asleep.exportState(); for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake', 'basin'] as const) expect(Array.from(y[k]!), k).toEqual(Array.from(x[k]!)); };
    same();                                                                // el agua despierta se durmió donde la otra ya estaba
    // Y desde ahí, lo mismo: un pisotón la despierta igual
    let i0 = 0;
    while (!(awake.sim.depth[i0]! > 1)) i0++;
    for (const st of [a, b]) st.events.disturb((i0 % awake.gw) * 2, Math.floor(i0 / awake.gw) * 2, 2.8, 3);
    for (let t = 0; t < 90; t++) { a.step(); b.step(); }
    same();
  });

  it('la misma simulación que recorriendo la rejilla (la huella, fijada con el código de antes)', () => {
    const { st, water } = setup();
    for (let t = 0; t < 600; t++) {
      if (t === 10) clearBox(st, { x0: 40, y0: 28, z0: 35, x1: 47, y1: 35, z1: 63 });   // una zanja que el lago llena (despierta
      // solo su borde: lo demás lo despierta el paso según corre el agua; los pisotones, que despiertan mucho, después)
      if (t >= 200 && t % 97 === 0) { st.events.disturb(24 + (t % 7), 30, 2.8, 3); st.events.splash(24, 30, 40, 30, 90); }
      if (t === 300) st.events.disturb(39, 31, 6, 3);                    // con fuerza junto a la orilla: salta al suelo
      if (t === 320) water.pour(50, 50, 1.5);                            // agua en suelo seco
      st.step();
    }
    expect(st.hash()).toBe(PINNED);
  });

  it('y en el mundo de salas, con su fuente y pisotones por todo el agua (la huella, fijada con el código de antes)', () => {
    const { state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), THEMES.medieval.look);
    const w = state.water!, wet: number[] = [];
    for (let i = 0; i < w.sim.depth.length; i++) if (!w.sim.solid[i] && w.sim.depth[i]! > 0.5) wet.push(i);
    for (let t = 0; t < 600; t++) {
      if (t % 37 === 0) { const i = wet[(t * 131) % wet.length]!; state.events.disturb((i % w.gw) * 2, Math.floor(i / w.gw) * 2, 3 + (t % 3), 3); }
      state.step();
    }
    expect(state.hash()).toBe(PINNED_ROOMS);
  });
});

const PINNED = '1f3622ce';                     // la huella con el código que recorría la rejilla (6296d11)
const PINNED_ROOMS = '74cc9fe0';               // la del mundo de salas, también con el código de antes (6296d11)
