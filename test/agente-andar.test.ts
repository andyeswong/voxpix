// La interfaz para agentes: entityAt (la entidad que se pinta en un píxel) y goTo (andar con los caminos del motor).
// - entityAt: dice que hay entidad exactamente en los píxeles donde el cuadro (frame2D) cambia al ponerla; también con
//   una pared delante (ahí no) y con la sección que la destapa (ahí sí);
// - goTo, con un Runtime de verdad y LevelPathField: llega a una celda (rodeando una pared por su hueco), a lo que se ve
//   en un píxel, y con la búsqueda repartida (budget); dice "no hay camino" si no lo hay, "no llegó" con lo que le queda
//   si se le acaban los ticks, y "atascado" si no se mueve.
import { describe, it, expect } from 'vitest';
import { material, Model, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { bakeWorld } from '../src/world/bake';
import { WorldView } from '../src/world/view';
import { frame2D } from '../src/world/frame2d';
import { sectionAround, sectionLayer, crossWindow, type SectionLayer } from '../src/world/section';
import { LevelPathField } from '../src/world/levelpaths';
import { Runtime } from '../src/runtime/runtime';
import { AgentHost, type AgentLook } from '../src/agent/agent';

const N = 8;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
  { name: 'cuerpo', colors: ['#a02020', '#d04040', '#f08080'] },
] };
const cube = (ramp: number): Array<[number, number, number, number]> => {
  const out: Array<[number, number, number, number]> = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push([x, y, z, material(ramp, 1 + ((x + y + z) % 2))]);
  return out;
};
const COLS = 12, ROWS = 12, LAYERS = 6;

// Suelo de tierra (capas 0-1) y una pared de piedra en by 6 (capas 2-3) con un hueco en bx 9..10; y un recinto cerrado en
// bx 1..3, by 9..11 (paredes de 2 capas alrededor de la celda 2, 10)
function world() {
  const set = new BlockSet('prueba', N, PAL);
  set.add('piedra', cube(0)); set.add('tierra', cube(1));
  const st = new WorldState(new StaticVoxels(PAL, COLS * N, ROWS * N, 0, LAYERS * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  for (let bz = 0; bz <= 1; bz++) for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++) grid.set(bx, by, bz, 2);
  for (let bz = 2; bz <= 3; bz++) {
    for (let bx = 0; bx < COLS; bx++) if (bx !== 9 && bx !== 10) grid.set(bx, 6, bz, 1);
    for (let by = 9; by <= 11; by++) for (let bx = 1; bx <= 3; bx++) if (by !== 10 || bx !== 2) grid.set(bx, by, bz, 1);
  }
  return { st, grid };
}
function body(): Model {
  const m = new Model(PAL, 'cuerpo');
  for (let z = 0; z < 20; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) m.set(x, y, z, material(2, 1));
  return m;
}

describe('agente: entityAt', () => {
  for (const withSection of [false, true, 'cruz'] as const) it(`la entidad que se pinta en cada píxel, la misma que cambia el cuadro${withSection === 'cruz' ? ' (con la sección en cruz, que la destapa en parte)' : withSection ? ' (con la sección que la destapa)' : ''}`, () => {
    const a = world(), b = world();
    // Una entidad de 20 de alto de pie en (5.5, 7.5) celdas, justo al norte de la pared de by 6 (que la tapa en parte desde
    // la cámara: asoma por encima)
    const ex = 5 * N + 4, ey = 7 * N + 2, ez = 2 * N;
    const id = a.st.entities.add({ model: body(), x: ex, y: ey, z: ez, facing: 0, castsShadow: false });
    const views = [a, b].map((w) => new WorldView(w.st, 0));
    const baked = bakeWorld(views[0]!.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    const bakedB = bakeWorld(views[1]!.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    let section: SectionLayer | null = null;
    // (la cruz, sobre el pecho de la entidad y más estrecha que ella de alto: destapa solo un trozo)
    const [wx, wy] = baked.cam.project(ex, ey, ez + 6), win = withSection === 'cruz' ? { window: crossWindow(wx, wy, { arm: 7, width: 5 }) } : {};
    if (withSection) section = sectionLayer(baked, { ...sectionAround(views[0]!.camera, ex, ey, ez, 32), ...win });
    const o = { vx: 0, vy: 0, vw: baked.width, vh: baked.height, lights: false, time: 0, ambient: [1, 1, 1] as [number, number, number], ...(section ? { sectionLayer: section } : {}) };
    const secB = withSection ? sectionLayer(bakedB, { ...sectionAround(views[1]!.camera, ex, ey, ez, 32), ...win }) : null;
    const fa = frame2D(views[0]!.frame(), baked, o), fb = frame2D(views[1]!.frame(), bakedB, { ...o, ...(secB ? { sectionLayer: secB } : {}) });
    const host = new AgentHost({ state: a.st, grid: a.grid, look: (): AgentLook => ({ view: views[0]!, baked, section, frame: { lights: false } }) });
    let painted = 0, said = 0, bad = 0;
    for (let sy = 0; sy < baked.height; sy++) for (let sx = 0; sx < baked.width; sx++) {
      const i = (sy * baked.width + sx) * 4;
      const differs = fa[i] !== fb[i] || fa[i + 1] !== fb[i + 1] || fa[i + 2] !== fb[i + 2];
      const r = host.entityAt(sx, sy);
      if (differs) painted++;
      if (r.ok) { said++; expect(r.id).toBe(id); }
      if (differs !== r.ok) bad++;
    }
    expect(painted).toBeGreaterThan(20);
    expect([painted, said, bad]).toEqual([painted, painted, 0]);
    PAINTED[String(withSection)] = painted;
    // (la cruz destapa más que sin sección y menos que la caja entera)
    if (withSection === 'cruz') { expect(painted).toBeGreaterThan(PAINTED['false']!); expect(painted).toBeLessThan(PAINTED['true']!); }
  });
  const PAINTED: Record<string, number> = {};

  it('sin vista, fuera de la imagen, y donde no hay nadie', () => {
    const { st, grid } = world();
    const view = new WorldView(st, 0), baked = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    expect(new AgentHost({ state: st, grid }).entityAt(0, 0)).toEqual({ ok: false, msg: 'no hay vista' });
    const host = new AgentHost({ state: st, grid, look: () => ({ view, baked }) });
    expect(host.entityAt(-1, 0).msg).toBe('fuera de la imagen');
    expect(host.entityAt(10, 10).msg).toBe('ninguna entidad en ese píxel');
  });
});

describe('agente: goTo', () => {
  const setup = (budget?: number) => {
    const { st, grid } = world();
    // (el cuerpo de la simulación y el de los caminos, de radio 2)
    const rt = new Runtime(st, { x: 3 * N + 4, y: 2 * N + 4 }, { radius: 2, speed: 30 });
    const paths = new LevelPathField(st, { cell: 4, radius: 2, height: 14, step: 8, maxDrop: 32, ...(budget ? { budget } : {}) });
    const host = new AgentHost({ state: st, grid, sim: rt, player: () => rt.player, paths });
    return { st, grid, rt, paths, host };
  };

  for (const budget of [undefined, 200]) it(`llega a una celda rodeando la pared por su hueco${budget ? ' (búsqueda repartida)' : ''}`, () => {
    const { rt, host } = setup(budget);
    // De (3, 2) a encima de la tierra en (3, 8): la pared de by 6 solo se cruza por bx 9..10
    const r = host.goTo({ cell: [3, 8, 1] }, { maxTicks: 3000 });
    expect(r).toMatchObject({ ok: true });
    expect(r.msg).toMatch(/^llegó en \d+ ticks$/);
    expect(Math.hypot(rt.player.x - (3 * N + 4), rt.player.y - (8 * N + 4))).toBeLessThanOrEqual(2);
    // (pasó por el hueco: de y 2 a y 8 con la pared en medio, tiene que haber ido hasta x ~ 9 celdas)
    expect(r.ticks as number).toBeGreaterThan(100);
  });

  it('a lo que se ve en un píxel', () => {
    const { st, rt, host } = setup();
    const view = new WorldView(st, 0), baked = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    const h2 = new AgentHost({ ...host.opts, look: () => ({ view, baked }) });
    // El píxel del centro de la cara de arriba de la tierra en (7, 3)
    const [sx, sy] = baked.cam.project(7 * N + 4.5, 3 * N + 4.5, 2 * N);
    const r = h2.goTo({ pixel: [Math.floor(sx), Math.floor(sy)] }, { maxTicks: 2000 });
    expect(r).toMatchObject({ ok: true });
    expect(Math.hypot(rt.player.x - (7 * N + 4.5), rt.player.y - (3 * N + 4.5))).toBeLessThanOrEqual(3);
  });

  it('sin camino, sin llegar a tiempo, atascado, y lo que falta', () => {
    const { st, grid, rt, paths, host } = setup();
    // Al recinto cerrado
    expect(host.goTo({ cell: [2, 10, 1] }).msg).toBe('no hay camino');
    // Lejos con pocos ticks: dice lo que le falta y el camino que le queda
    const r = host.goTo({ cell: [10, 10, 1] }, { maxTicks: 20 });
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/^no llegó en 20 ticks \(le faltan \d+ vóxeles\)$/);
    expect((r.path as unknown[]).length).toBeGreaterThan(0);
    // Una simulación que no mueve al jugador: atascado
    const still = { tick: 0, step() { this.tick++; } };
    const h3 = new AgentHost({ state: st, grid, sim: still, player: () => rt.player, paths });
    expect(h3.goTo({ cell: [10, 2, 1] }, { stuckTicks: 30 }).msg).toBe('atascado (30 ticks sin moverse)');
    // Lo que falta para andar
    expect(new AgentHost({ state: st, grid }).goTo({ cell: [1, 1, 1] }).msg).toBe('no hay caminos (paths)');
    expect(new AgentHost({ state: st, grid, paths }).goTo({ cell: [1, 1, 1] }).msg).toBe('no hay simulación');
    expect(host.goTo({ cell: [99, 1, 1] }).msg).toMatch(/fuera de la rejilla/);
    expect(new AgentHost({ ...host.opts }).goTo({ pixel: [0, 0] }).msg).toBe('no hay vista');
  });
});
