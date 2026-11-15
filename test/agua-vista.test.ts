// La copia del agua de una vista (WaterView, girada o con corte) copia solo lo que cambió: con el agua quieta, nada; y
// lo que copia da siempre lo mismo que una vista nueva, que la copia entera. En los 4 giros, con y sin corte, picando,
// poniendo, pisando, echando agua en seco, moviendo el corte y cargando una partida
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { WorldView, type ViewCut, type Quarter } from '../src/world/view';
import { clearBox } from '../src/world/edit';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
// Lados impares a propósito (las celdas giradas no caen sobre las del mundo)
const W = 71, D = 57, FLOOR = 40, BED = 34;
function setup() {
  const s = new StaticVoxels(PAL, W, D, 0, 63);
  const lake = (x: number, y: number) => x >= 16 && x < 40 && y >= 14 && y < 38;
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z < (lake(x, y) ? BED : FLOOR); z++) s.set(x, y, z, material(0, 1 + ((x + y) & 1)));
  const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (lake(x, y)) { wet[y * W + x] = 1; waterTop[y * W + x] = FLOOR; }
  const world = { model: s, lights: [], width: W, depth: D, wet, waterTop } as unknown as World;
  const water = new WaterLayer(world, { wallAbove: Infinity });
  const st = new WorldState(s, [], water, { seed: 5 });
  water.follow(st.watchChanges());
  return { st, water };
}
type V = { v: WorldView; q: Quarter; cut: boolean };
// La vista contra una nueva con el mismo giro y el mismo corte: la misma agua celda a celda
function same(st: WorldState, { v, q, cut }: V, when: string) {
  const a = v.frame().water!;
  const fresh = new WorldView(st, q, cut ? { cut: true } : {});
  const c = v.currentCut;
  if (c) fresh.setCut(c as ViewCut);
  const b = fresh.frame().water!;
  const tag = `${when}, giro ${q}${cut ? ' con corte' : ''}`;
  expect(Array.from(a.sim.depth), tag).toEqual(Array.from(b.sim.depth));
  expect(Array.from(a.sim.ground), tag).toEqual(Array.from(b.sim.ground));
  expect(Array.from(a.sim.solid), tag).toEqual(Array.from(b.sim.solid));
  for (let i = 0; i < a.gw * a.gh; i++) if (a.isBasin(i) !== b.isBasin(i)) expect(`${tag}: cuenca ${i}`).toBe('igual');
}
const visited = (v: WorldView) => (v.frame().water as unknown as { visited: number }).visited;

describe('la copia del agua de una vista', () => {
  it('copia solo lo que cambió y da lo mismo que una vista nueva', () => {
    const { st, water } = setup();
    const views: V[] = [];
    for (const q of [0, 1, 2, 3] as Quarter[]) for (const cut of [false, true]) if (q || cut) views.push({ v: new WorldView(st, q, cut ? { cut: true } : {}), q, cut });
    const check = (when: string) => { for (const x of views) same(st, x, when); };
    // Cada tick, cada vista da su cuadro (como el juego, que tiene al día el giro de pantalla y otro)
    const tick = (n = 1) => { for (let k = 0; k < n; k++) { st.step(); for (const x of views) x.v.frame(); } };
    tick(); check('al nacer');
    tick(120);                                                   // se duerme
    tick();
    for (const x of views) expect(visited(x.v), `reposo, giro ${x.q}`).toBe(0);
    check('en reposo');
    clearBox(st, { x0: 40, y0: 20, z0: 35, x1: 47, y1: 27, z1: 63 });   // una zanja que el lago llena
    tick(); check('al picar');
    tick(30); check('llenándose');
    for (let k = 0; k < 6; k++) for (const [x, y] of [[30, 30], [31, 30], [30, 31], [31, 31]] as const) st.solid.set(x, y, BED + k, material(0, 1));
    tick(); check('al poner un pilar');
    st.events.disturb(24, 24, 6, 3);                            // con fuerza, junto a la orilla
    check('al pisar, antes del paso');                         // el juego puede dibujar entre el evento y el paso
    tick(); check('al pisar');
    water.pour(60, 50, 1.5);                                     // en suelo seco: se empapa
    check('al echar agua en seco, antes del paso');
    tick(); check('al echar agua en seco');
    // Mover el corte: las vistas con corte lo cambian; el agua de debajo queda a la vista o se esconde
    for (const x of views) if (x.cut) x.v.setCut({ x0: 10, y0: 10, x1: 33, y1: 33, zTop: 37 });
    tick(); check('al cortar');
    for (const x of views) if (x.cut) x.v.setCut({ x0: 20, y0: 18, x1: 45, y1: 40, zTop: 38 });
    tick(); check('al mover el corte');
    tick(200); check('después');
    // Cargar una partida de antes
    const snap = st.snapshot();
    tick(60);
    st.restore(snap);
    for (const x of views) x.v.frame();
    check('al cargar');
    tick(30); check('tras cargar');
  });

  it('un charco en seco que se duerme y se sigue empapando: eso solo lo cambia el empapado, y la vista lo copia', () => {
    const { st, water } = setup();
    const views: V[] = ([1, 2] as Quarter[]).map((q) => ({ v: new WorldView(st, q), q, cut: false }));
    const tick = (n = 1) => { for (let k = 0; k < n; k++) { st.step(); for (const x of views) x.v.frame(); } };
    clearBox(st, { x0: 58, y0: 46, z0: 38, x1: 59, y1: 47, z1: 63 });   // un hoyo de una celda lejos del lago: no es cuenca
    tick(150);
    water.pour(58, 46, 1.5);                                     // por debajo del borde: no sale, se duerme y se empapa
    let sleepingSoak = false;
    for (let k = 0; k < 600 && water.depthAt(58, 46) > 0; k++) {
      tick();
      if (water.sim.activeCount === 0 && water.soakVisited > 0) { sleepingSoak = true; tick(10); for (const x of views) same(st, x, 'empapándose dormido'); break; }
    }
    expect(sleepingSoak).toBe(true);
  });
});
