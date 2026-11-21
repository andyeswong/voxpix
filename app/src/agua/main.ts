// El agua por columnas en un mundo de bloques alto: un mapa por semilla (generateMap) de 384 x 384 x 96
// vóxeles con lagos, el agua con mapWater y un WaterLayer sin pared por altura, y el cuadro de la GPU (o la CPU).
//   ?medir=1: mide lo que cuesta el agua y lo deja en window.__agua:
//     - el paso del agua por tick (WaterLayer.step) en la simulación, con pisotones y en reposo (sin nada despierto);
//     - el cuadro del compositor con agua y con el mismo mundo sin agua (read espera a la GPU)
//     - los primeros ticks de una capa recién hecha (state.step, sin calentar): el más caro y en qué tick, sin seguir
//       al mundo, siguiéndolo (follow) y naciendo dormida (asleep);
//   ?medir=fosa: una fosa en seco junto al lago más hondo y luego un canal que la une a él (siguiendo al mundo, la capa
//     nacida dormida): cuántas celdas siguen despiertas y de qué clase, cuánta agua se pierde, y lo que cuestan el paso
//     y la copia de una vista girada (WaterView) los últimos 600 ticks de 1800
//   ?ruta=cpu   ?semilla=1   ?n=120 (cuadros medidos)
import { material, type Palette } from '@core/index';
import { StaticVoxels, WorldState } from '../../../src/world/state';
import { WaterLayer } from '../../../src/world/water';
import { BlockSet, BlockGrid, type VoxsetFile } from '../../../src/world/blocks';
import { generateMap, applyMap, mapWater } from '../../../src/world/mapgen';
import { bakeWorld } from '../../../src/world/bake';
import { createCompositor } from '../../../src/view/compositor';
import { GpuCompositor } from '../../../src/view/gpu/compositor';
import { frame2D, type Frame2DOptions } from '../../../src/world/frame2d';
import type { World } from '../../../src/world/build';
import { clearBox } from '../../../src/world/edit';
import { WorldView } from '../../../src/world/view';

const VW = 384, VH = 216, B = 8, CW = 48, CD = 48, CH = 12;
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;
const sc = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
canvas.style.width = `${VW * sc}px`; canvas.style.height = `${VH * sc}px`;

const ids = ['piedra', 'tierra', 'hierba', 'arena', 'agua'];
const colors = [['#2a2b32', '#3e4049', '#565a64', '#727784'], ['#3a2618', '#553823', '#704b2e', '#8c6040'], ['#24401f', '#35602a', '#4a8034', '#68a044'], ['#a08a5a', '#c0a872', '#d8c290', '#ece0b0'], ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4']];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: colors[i]! })) };
const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, 1 + ((x + y + z) % 3))]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'agua', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as VoxsetFile);
const T = (id: string) => set.index(id);
const map = generateMap({ seed: Number(q.get('semilla') ?? 1), width: CW, depth: CD, height: CH, surface: { base: 6, amplitude: 2.5, scale: 7 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
  seaLevel: 6, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 } });
const s = new StaticVoxels(pal, CW * B, CD * B, 0, CH * B - 1);
applyMap(map, new BlockGrid(new WorldState(s, [], null), set), { skip: [T('agua')] });
const world = { model: s, lights: [], width: s.width, depth: s.depth, ...mapWater(map, B, T('agua')) } as unknown as World;
const water = new WaterLayer(world, { wallAbove: Infinity });
const state = new WorldState(s, [], water, { seed: 1 });
const dry = new WorldState(s, [], null, { seed: 1 });
const baked = bakeWorld({ model: s, lights: [], width: s.width, depth: s.depth }, { topZ: CH * B + 8, incline: 0.5, outline: 'both' });
let wetCells = 0;
for (let i = 0; i < water.sim.depth.length; i++) if (water.sim.depth[i]! > 0.04) wetCells++;
// La vista: la del lago más grande que se vea (el centro de las celdas con agua)
let sx = 0, sy = 0, n0 = 0;
for (let gy = 0; gy < water.gh; gy++) for (let gx = 0; gx < water.gw; gx++) if (water.sim.depth[gy * water.gw + gx]! > 0.04) { sx += gx * 2; sy += gy * 2; n0++; }
const cx = n0 ? sx / n0 : s.width / 2, cy = n0 ? sy / n0 : s.depth / 2;
const [px, py] = baked.cam.project(cx, cy, 48);
const vx = Math.max(0, Math.min(baked.width - VW, Math.floor(px) - VW / 2)), vy = Math.max(0, Math.min(baked.height - VH, Math.floor(py) - VH / 2));
const opts = (t: number): Frame2DOptions => ({ vx, vy, vw: VW, vh: VH, time: t, lights: true, ambient: [0.9, 0.9, 0.95] });
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });

const pct = (a: number[], p: number) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]!; };
function measure(): unknown {
  const N = Number(q.get('n') ?? 120);
  // El paso del agua por tick (con un pisotón cada 30 ticks, que la despierta)
  const steps: number[] = [];
  for (let t = 0; t < N + 20; t++) {
    if (t % 30 === 0) water.disturb(cx, cy, 2);
    const a = performance.now(); water.step(1 / 60); if (t >= 20) steps.push(performance.now() - a);
  }
  const out: Record<string, unknown> = { size: [s.width, s.depth, CH * B], wetCells, cells: water.gw * water.gh, zRange: water.zRange,
    stepP50: pct(steps, 0.5), stepP95: pct(steps, 0.95), stepMax: Math.max(...steps) };
  // En reposo: se deja asentar (600 ticks sin pisotones) y se mide sin tocarla
  for (let t = 0; t < 600; t++) water.step(1 / 60);
  const rest: number[] = [];
  for (let t = 0; t < 600; t++) { const a = performance.now(); water.step(1 / 60); rest.push(performance.now() - a); }
  out.restP50 = pct(rest, 0.5); out.restP95 = pct(rest, 0.95); out.restMax = Math.max(...rest);
  // Los primeros ticks de una capa nueva (la primera vez que se corre: con el JIT frío y todo lo mojado despierto)
  for (const [key, follow, asleep] of [['first', false, false], ['firstFollow', true, false], ['firstAsleep', true, true]] as const) {
    const w2 = new WaterLayer(world, { wallAbove: Infinity, asleep }), st2 = new WorldState(s, [], w2, { seed: 1 });
    if (follow) w2.follow(st2.watchChanges());
    const ticks: number[] = [];
    for (let t = 0; t < 240; t++) { const a = performance.now(); st2.step(); ticks.push(performance.now() - a); }
    const max = Math.max(...ticks);
    out[key] = { tick0: ticks[0], max, at: ticks.indexOf(max), over5: ticks.filter((x) => x > 5).length, p50: pct(ticks, 0.5) };
  }
  // El cuadro: con agua y sin agua (el mismo mundo), en la GPU (read espera) y en la CPU
  const gc = GpuCompositor.create(document.createElement('canvas'));
  if (gc) {
    const on: number[] = [], off: number[] = [];
    for (let i = 0; i < N + 10; i++) {
      let a = performance.now(); gc.read(dry, baked, opts(i / 60)); const x = performance.now() - a;
      a = performance.now(); gc.read(state, baked, opts(i / 60)); const y = performance.now() - a;
      if (i >= 10) { off.push(x); on.push(y); }
    }
    out.gpu = { offP50: pct(off, 0.5), onP50: pct(on, 0.5), offP95: pct(off, 0.95), onP95: pct(on, 0.95) };
  }
  const con: number[] = [], sin: number[] = [];
  for (let i = 0; i < 23; i++) {
    let a = performance.now(); frame2D(dry, baked, { ...opts(i / 60), detail: 'bajo' }); const x = performance.now() - a;
    a = performance.now(); frame2D(state, baked, { ...opts(i / 60), detail: 'bajo' }); const y = performance.now() - a;
    if (i >= 3) { sin.push(x); con.push(y); }
  }
  out.cpu = { offP50: pct(sin, 0.5), onP50: pct(con, 0.5), offP95: pct(sin, 0.95), onP95: pct(con, 0.95) };
  return out;
}
function fosa(): unknown {
  const w = new WaterLayer(world, { wallAbove: Infinity, asleep: true }), st = new WorldState(s, [], w, { seed: 1 });
  w.follow(st.watchChanges());
  const view = new WorldView(st, 1), sim = w.sim, gw = w.gw, gh = w.gh;
  let deep = 0;
  for (let i = 0; i < gw * gh; i++) if (sim.depth[i]! > sim.depth[deep]!) deep = i;
  const cy = Math.floor(deep / gw);
  let ex = deep % gw;
  while (ex + 1 < gw && sim.depth[cy * gw + ex + 1]! > 0.5) ex++;
  const surf = sim.ground[cy * gw + ex]! + sim.depth[cy * gw + ex]!;
  const X = (ex + 14) * 2, Y = cy * 2, Z = Math.floor(surf) - 3;
  const vol = () => { let v = 0; for (let i = 0; i < gw * gh; i++) v += sim.depth[i]!; return v; };
  const tick = () => { st.step(); view.frame(); };
  for (let t = 0; t < 60; t++) tick();
  clearBox(st, { x0: X, y0: Y - 4, z0: Z, x1: X + 7, y1: Y + 3, z1: CH * B - 1 });          // la fosa, en seco
  for (let t = 0; t < 60; t++) tick();
  clearBox(st, { x0: ex * 2 + 2, y0: Y, z0: Z + 1, x1: X, y1: Y + 1, z1: CH * B - 1 });      // el canal
  const steps: number[] = [], frames: number[] = [];
  let v0 = 0;
  for (let t = 0; t < 1800; t++) {
    if (t === 1200) v0 = vol();
    let a = performance.now(); st.step(); const x = performance.now() - a;
    a = performance.now(); view.frame(); const y = performance.now() - a;
    if (t >= 1200) { steps.push(x); frames.push(y); }
  }
  const awake = sim.exportState().awake;
  let lake = 0, edge = 0, wetOut = 0, dry = 0;
  for (let i = 0; i < gw * gh; i++) {
    if (!awake[i] || sim.solid[i]) continue;
    const d = sim.depth[i]!, b = w.isBasin(i);
    if (!b && d > 0) wetOut++; else if (!b) dry++; else if (d > 0.04) lake++; else edge++;
  }
  return { surface: surf, awake: { lake, edge, wetOut, dry }, active: sim.activeCount, soaking: w.soakVisited, lostPer600: v0 - vol(),
    stepP50: pct(steps, 0.5), stepP95: pct(steps, 0.95), viewP50: pct(frames, 0.5), viewP95: pct(frames, 0.95), viewCells: (view.frame().water as unknown as { visited: number }).visited };
}
if (q.get('medir') === 'fosa') (window as unknown as { __niebla: unknown }).__niebla = fosa();
if (q.get('medir') === '1') (window as unknown as { __niebla: unknown; __agua: unknown }).__agua = (window as unknown as { __niebla: unknown }).__niebla = measure();

let acc = 0, n = 0, avg = 0;
function loop(now: number): void {
  const t0 = performance.now();
  state.step();
  if (Math.floor(now / 500) !== Math.floor((now - 16) / 500)) water.disturb(cx + 10 * Math.sin(now / 900), cy + 10 * Math.cos(now / 700), 1.5);
  compositor.frame(state, baked, opts(now / 1000));
  acc += performance.now() - t0;
  if (++n === 30) { avg = acc / n; acc = 0; n = 0; }
  hud.textContent = `agua en un mundo alto · ${s.width}x${s.depth}x${CH * B} · ${wetCells} celdas con agua · ruta ${compositor.kind} · tick + cuadro ${avg.toFixed(2)} ms`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
