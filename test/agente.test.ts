// La interfaz para agentes (src/agent): describe (capas como texto, leyenda del BlockSet, marcas), visibleCells (lo
// que se ve es lo que se pica: celda a celda igual que pickBlock en todos los píxeles, también con la sección), probe,
// reach y check, el registro de órdenes y step(n) sin reloj. Todo JSON.
import { describe, it, expect } from 'vitest';
import { material, Model, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, pickBlock } from '../src/world/blocks';
import { bakeWorld } from '../src/world/bake';
import { WorldView, type Quarter } from '../src/world/view';
import { sectionAround, SectionPainter, type SectionLayer } from '../src/world/section';
import { AgentHost, installAgent, type AgentLook, type Point } from '../src/agent/agent';
import { Runtime, type TickInput } from '../src/runtime/runtime';

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

// Piedra en las capas 0-1, tierra en la 2-3, una zanja de un bloque (bx 5, by 6..8, capa 3) y arena en (2, 2, 3)
function world() {
  const set = new BlockSet('prueba', N, PAL);
  set.add('piedra', cube(0)); set.add('tierra', cube(1)); set.add('arena', cube(2));
  const st = new WorldState(new StaticVoxels(PAL, COLS * N, ROWS * N, 0, LAYERS * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  for (let bz = 0; bz <= 3; bz++) for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++)
    if (!(bz === 3 && bx === 5 && by >= 6 && by <= 8)) grid.set(bx, by, bz, bz < 2 ? 1 : 2);
  grid.set(2, 2, 3, 3);
  return { st, grid, set };
}
const PLAYER: Point = { x: 5 * N + 4.5, y: 7 * N + 3.25, z: 3 * N };

describe('interfaz para agentes', () => {
  it('describe: capas por z con letras del BlockSet, filas de norte a sur, marcas con su posición exacta', () => {
    const { st, grid } = world();
    const host = new AgentHost({ state: st, grid, player: () => PLAYER, marks: () => [{ ch: 'e', x: 3 * N + 1, y: 7 * N + 1, z: 3 * N, name: 'bicho' }] });
    const d = host.describe({ radius: 3, below: 1, above: 0 });
    expect(d.center).toEqual([5, 7, 3]);
    expect(d.x).toEqual([2, 8]); expect(d.y).toEqual([4, 10]);
    expect(d.layers.map((l) => l.bz)).toEqual([3, 2]);
    expect(d.legend).toEqual({ T: 'tierra' });
    expect(d.visible).toBe(false);
    // Capa 3: la zanja en bx 5 (columna 3), by 6..8; el jugador en (5, 7); el bicho en (3, 7). La fila 0 es by 10 (norte)
    expect(d.layers[0]!.rows).toEqual([
      'TTTTTTT',
      'TTTTTTT',
      'TTT.TTT',
      'TeT@TTT',
      'TTT.TTT',
      'TTTTTTT',
      'TTTTTTT',
    ]);
    expect(d.layers[1]!.rows.every((r) => r === 'TTTTTTT')).toBe(true);
    expect(d.marks).toEqual([
      { ch: '@', x: PLAYER.x, y: PLAYER.y, z: PLAYER.z, name: 'jugador', cell: [5, 7, 3] },
      { ch: 'e', x: 25, y: 57, z: 24, name: 'bicho', cell: [3, 7, 3] },
    ]);
    expect(d.text).toContain('@ jugador (44.5, 59.25, 24) celda 5,7,3');
    expect(d.text).toContain('leyenda: . aire, T tierra');
    expect(d.text.split('\n')).toContain('    7 TeT@TTT');
    // Fuera de la rejilla, espacios; arena en (2, 2, 3) con su letra
    const e = host.describe({ at: { x: 4, y: 4, z: 3 * N }, radius: 2, below: 0, above: 0 });
    expect(e.layers[0]!.rows).toEqual(['  TTA', '  TTT', '  TTT', '     ', '     ']);
    expect(e.legend).toEqual({ T: 'tierra', A: 'arena' });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('describe: las entidades del mundo con *, salvo la del jugador', () => {
    const { st, grid } = world();
    const m = new Model(PAL, 'cosa'); m.set(0, 0, 0, material(0, 1));
    const id = st.models.register(m);
    const a = st.entities.add({ model: id, x: 3 * N + 2, y: 8 * N + 2, z: 3 * N, facing: 0, castsShadow: false });
    const me = st.entities.add({ model: id, x: PLAYER.x, y: PLAYER.y, z: PLAYER.z, facing: 0, castsShadow: false });
    const host = new AgentHost({ state: st, grid, player: () => PLAYER, playerEntity: me });
    const d = host.describe({ radius: 2, below: 0, above: 0 });
    expect(d.marks.map((k) => [k.ch, k.name, k.cell])).toEqual([['@', 'jugador', [5, 7, 3]], ['*', `entidad ${a}`, [3, 8, 3]]]);
    expect(d.layers[0]!.rows[1]).toBe('*T.TT');
    expect(new AgentHost({ state: st, grid, player: () => PLAYER, playerEntity: me, entities: false }).describe({ radius: 2 }).marks.length).toBe(1);
  });

  it('letras: fijas, repartidas sin choques, y error con una letra reservada', () => {
    const { st, grid } = world();
    const host = new AgentHost({ state: st, grid, letters: { tierra: 'X' } });
    expect([1, 2, 3].map((t) => host.letter(t))).toEqual(['P', 'X', 'A']);
    expect(host.letter(0)).toBe('.');
    expect(() => new AgentHost({ state: st, grid, letters: { tierra: '@' } })).toThrow(/reservados/);
    // Dos ids que empiezan igual no comparten letra
    const set = new BlockSet('b', N, PAL);
    set.add('tierra', cube(1)); set.add('tierra_seca', cube(1)); set.add('t2', cube(1));
    const g2 = new BlockGrid(new WorldState(new StaticVoxels(PAL, 16, 16, 0, 15), [], null), set);
    const h2 = new AgentHost({ state: g2.state, grid: g2 });
    const ls = [1, 2, 3].map((t) => h2.letter(t));
    expect(new Set(ls).size).toBe(3);
  });

  for (const q of [0, 1] as Quarter[]) {
    it(`visibleCells es lo que pickBlock pica, sin y con sección (giro ${q}), y describe lo marca en minúscula`, () => {
      const { st, grid } = world();
      const view = new WorldView(st, q);
      const baked = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
      let section: SectionLayer | null = null;
      const look = (): AgentLook => ({ view, baked, section });
      const host = new AgentHost({ state: st, grid, look, player: () => PLAYER });
      const picked = () => {
        const s = new Map<string, number>();
        for (let sy = 0; sy < baked.height; sy++) for (let sx = 0; sx < baked.width; sx++) {
          const p = pickBlock(grid, view, baked, sx, sy, section);
          if (p) s.set(p.cell.join(','), (s.get(p.cell.join(',')) ?? 0) + 1);
        }
        return s;
      };
      for (const withSection of [false, true]) {
        if (withSection) {
          const p = new SectionPainter(baked, { ahead: 0, behind: 0 });
          p.set(sectionAround(view.camera, PLAYER.x, PLAYER.y, PLAYER.z, 32), 0); p.paintAll();
          section = p.layer();
          expect(section).not.toBeNull();
        }
        const v = host.visibleCells()!, ref = picked();
        expect([...v.keys()].sort()).toEqual([...ref.keys()].sort());
        for (const [k, c] of v) {
          expect(c.px).toBe(ref.get(k));
          expect(c.faces.reduce((a, f) => a + f.px, 0)).toBe(c.px);
          expect(new Set(c.faces.map((f) => f.face.join(','))).size).toBe(c.faces.length);   // cada cara una vez
        }
        expect([...v.values()].filter((c) => c.faces.length > 1).length).toBeGreaterThan(5);
        // Un recuadro (la columna y la fila del centro de la imagen): como pickBlock en esos píxeles
        const mx = baked.width >> 1, my = baked.height >> 1;
        for (const rect of [{ x0: mx, x1: mx, y0: 0, y1: baked.height - 1 }, { x0: 0, x1: baked.width - 1, y0: my, y1: my }]) {
          let n = 0;
          for (let sy = rect.y0; sy <= rect.y1; sy++) for (let sx = rect.x0; sx <= rect.x1; sx++) if (pickBlock(grid, view, baked, sx, sy, section)) n++;
          expect([...host.visibleCells(rect)!.values()].reduce((a, c) => a + c.px, 0)).toBe(n);
          expect(n).toBeGreaterThan(0);
        }
        // (la última columna y la última fila de la imagen no pican nada: el horneado deja margen)
        for (let sy = 0; sy < baked.height; sy++) expect(pickBlock(grid, view, baked, baked.width - 1, sy, section)).toBeNull();
        for (let sx = 0; sx < baked.width; sx++) expect(pickBlock(grid, view, baked, sx, baked.height - 1, section)).toBeNull();
        // El suelo bajo el jugador (5, 7, 2): sin sección no se ve (minúscula), con sección sí
        const d = host.describe({ radius: 2, below: 1, above: 0 });
        expect(d.visible).toBe(true);
        const floor = d.layers.find((l) => l.bz === 2)!.rows[2]![2];
        expect([withSection, floor]).toEqual([withSection, withSection ? 'T' : 't']);
        expect(host.check([5, 7, 2], { visible: true })).toEqual(withSection ? null : { ok: false, msg: 'no visible' });
        expect(d.text).toContain('minúscula: no se ve desde la cámara');
      }
    });
  }

  it('probe: lo que se pinta bajo el píxel; sin vista, lo dice', () => {
    const { st, grid } = world();
    const view = new WorldView(st, 0);
    const baked = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    const host = new AgentHost({ state: st, grid, look: () => ({ view, baked }) });
    const [sx, sy] = baked.cam.project(2 * N + 4.5, 2 * N + 4.5, 4 * N);
    const r = host.probe(Math.floor(sx), Math.floor(sy));
    expect(r).toMatchObject({ ok: true, msg: 'arena 2,2,3', cell: [2, 2, 3], face: [0, 0, 1], block: 'arena' });
    expect(pickBlock(grid, view, baked, Math.floor(sx), Math.floor(sy))).toEqual({ cell: r.cell, face: r.face });
    expect(host.probe(-5, -5)).toEqual({ ok: false, msg: 'nada en ese píxel' });
    expect(new AgentHost({ state: st, grid }).probe(0, 0)).toEqual({ ok: false, msg: 'no hay vista' });
  });

  it('reach y check: distancia a la caja de la celda, fuera de la rejilla, fuera de alcance', () => {
    const { st, grid } = world();
    const host = new AgentHost({ state: st, grid, player: () => PLAYER });
    expect(host.reach([5, 7, 3], 1)).toMatchObject({ ok: true, distance: 0 });
    // (5, 7, 2): justo debajo de los pies (z 24 es su cara de arriba)
    expect(host.reach([5, 7, 2], 0)).toMatchObject({ ok: true, distance: 0 });
    // (4, 7, 3): x de 32 a 40 (su caja llega al borde del vóxel 39), el jugador en x 44,5: 4,5
    expect(host.reach([4, 7, 3], 10).distance).toBe(4.5);
    // (8, 7, 3): x de 64 a 72, el jugador en x 44,5: 19,5
    expect(host.reach([8, 7, 3], 19)).toEqual({ ok: false, msg: 'fuera de alcance (19.5 > 19)', distance: 19.5 });
    expect(host.reach([8, 7, 3], 19.5).ok).toBe(true);
    expect(host.check([8, 7, 3], { reach: 10 })).toMatchObject({ ok: false, msg: 'fuera de alcance (19.5 > 10)' });
    expect(host.check([12, 0, 0])).toEqual({ ok: false, msg: 'celda fuera de la rejilla (12,0,0; hay 12 x 16 x 7)' });
    expect(host.check([1.5, 0, 0] as [number, number, number])?.ok).toBe(false);
    expect(host.check([8, 7, 3], { reach: 20 })).toBeNull();
    expect(new AgentHost({ state: st, grid }).reach([0, 0, 0], 5)).toEqual({ ok: false, msg: 'no hay jugador', distance: null });
  });

  it('órdenes: las registra el juego y siempre contestan', () => {
    const { st, grid, set } = world();
    const host = new AgentHost({ state: st, grid, player: () => PLAYER });
    host.register('picar', (a, h) => {
      const cell = a.cell as [number, number, number];
      const no = h.check(cell, { reach: 12 });
      if (no) return no;
      const t = grid.get(...cell);
      if (!t) return { ok: false, msg: 'ahí no hay nada' };
      grid.set(...cell, 0);
      return { ok: true, msg: `picado, +1 ${set.get(t).id}` };
    }, 'picar {cell}');
    host.register('rompe', () => { throw new Error('se rompió'); });
    host.register('mal', () => ({ nada: 1 }) as never);
    expect(() => host.register('picar', () => ({ ok: true, msg: '' }))).toThrow(/ya hay/);
    expect(host.list()).toEqual([{ name: 'picar', help: 'picar {cell}' }, { name: 'rompe', help: '' }, { name: 'mal', help: '' }]);
    expect(host.act('picar', { cell: [5, 7, 2] })).toEqual({ ok: true, msg: 'picado, +1 tierra' });
    expect(grid.get(5, 7, 2)).toBe(0);
    expect(host.act('picar', { cell: [5, 7, 2] })).toEqual({ ok: false, msg: 'ahí no hay nada' });
    expect(host.act('picar', { cell: [10, 7, 2] }).msg).toMatch(/^fuera de alcance/);
    expect(host.act('volar')).toEqual({ ok: false, msg: 'no hay orden "volar"; hay: picar, rompe, mal' });
    expect(host.act('rompe')).toEqual({ ok: false, msg: 'error en "rompe": se rompió' });
    expect(host.act('mal')).toEqual({ ok: false, msg: 'la orden "mal" no devolvió { ok, msg }' });
  });

  it('step(n): n ticks con la misma entrada, sin reloj; con un Runtime, la misma partida que paso a paso', () => {
    const { st, grid } = world();
    const seen: TickInput[] = [];
    const fake = { tick: 0, step(i: TickInput) { seen.push(i); this.tick++; } };
    const host = new AgentHost({ state: st, grid, sim: fake });
    const walk = { dx: 1, dy: 0, stomp: false };
    expect(host.step(5, walk)).toEqual({ ok: true, msg: '5 ticks', tick: 5 });
    expect(seen).toEqual(Array(5).fill(walk));
    expect(host.step(-1).ok).toBe(false);
    expect(host.step(1.5).ok).toBe(false);
    expect(new AgentHost({ state: st, grid }).step(1)).toEqual({ ok: false, msg: 'no hay simulación' });
    // Con un Runtime de verdad: 30 ticks andando al este por la agencia = 30 a mano
    const a = world(), b = world();
    const ra = new Runtime(a.st, { x: 20, y: 20 }, { radius: 3, speed: 30 }), rb = new Runtime(b.st, { x: 20, y: 20 }, { radius: 3, speed: 30 });
    new AgentHost({ state: a.st, grid: a.grid, sim: ra }).step(30, walk);
    for (let i = 0; i < 30; i++) rb.step(walk);
    expect(ra.tick).toBe(30);
    expect(ra.player.x).toBeGreaterThan(20);
    expect(ra.hash()).toBe(rb.hash());
  });

  it('installAgent: lo cuelga de un objeto, con JSON por fuera', () => {
    const { st, grid } = world();
    const view = new WorldView(st, 0);
    const baked = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
    const host = new AgentHost({ state: st, grid, look: () => ({ view, baked }), player: () => PLAYER });
    const win: Record<string, unknown> = {};
    installAgent(win, host);
    const api = win.voxpixAgent as Record<string, (...a: unknown[]) => unknown>;
    expect(Object.keys(api).sort()).toEqual(['act', 'actions', 'describe', 'entityAt', 'goTo', 'probe', 'reach', 'step', 'visible']);
    const vis = api.visible!() as unknown[];
    expect(vis.length).toBeGreaterThan(50);
    expect(JSON.parse(JSON.stringify(vis))).toEqual(vis);
    expect((api.describe!({ radius: 1 }) as { center: number[] }).center).toEqual([5, 7, 3]);
    installAgent(win, host, 'otro');
    expect(win.otro).toBeDefined();
  });
});
