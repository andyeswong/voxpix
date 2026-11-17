// La ventana viva (src/world/live.ts): un objetivo que anda por un mundo por regiones; la ventana se corre por la cola
// (FrameBudget), escribe los trozos que entran, avisa al juego (onUnload / onLoad, para guardar y poner sus diferencias)
// y rehornea. Al final, lo horneado es lo mismo que una ventana hecha de nuevo en ese sitio con las mismas diferencias, y
// una entidad sigue en el mismo sitio del mundo
import { describe, it, expect } from 'vitest';
import { material, Model, type Palette } from '../src/core';
import { generateRegion, type RegionSpec } from '../src/world/regiongen';

const B = 8, ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena', 'carbon', 'tronco', 'hojas', 'flor'];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${(30 + i * 20).toString(16)}2020`, `#${(40 + i * 20).toString(16)}3030`] })) };
const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, (x + y + z) % 2)]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 't', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: id === 'flor' ? [[3, 3, 0, material(i, 0)], [3, 3, 1, material(i, 1)]] : cube(i), ...(id === 'hierba' ? { props: { covered: 'tierra' } } : {}) })) } as unknown as VoxsetFile);
const T = (id: string) => set.index(id);
const leaves: Array<[number, number, number, number]> = [];
for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) leaves.push([dx, dy, 4, T('hojas')]);
const H = 8;
const SPEC: RegionSpec = {
  seed: 5, width: 48, depth: 48, height: H,
  surface: { base: 4, amplitude: 2, scale: 6 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 1 }, { material: T('piedra') }],
  seaLevel: 3, water: T('agua'), shore: { material: T('arena') },
  veins: [{ material: T('carbon'), in: [T('piedra')], z: [0, 3], density: 0.1, size: [2, 4] }],
  caves: { count: 6, z: [1, 3], length: [8, 16], radius: [1, 1.5] },
  scatter: [
    { on: [T('hierba')], density: 0.05, spacing: 3, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves] },
    { on: [T('hierba')], density: 0.1, structure: [[0, 0, 1, T('flor')]] },
  ],
};
const TB = 4, TV = TB * B;                       // un trozo: 4 x 4 bloques = 32 x 32 vóxeles (2 x 2 trozos de vóxeles)
const T0 = -3, NT = 6;                           // el mundo fijo: los trozos -3..2 en x y en y
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import { FrameBudget } from '../src/view/budget';
import { LiveWindow, type Trozo } from '../src/world/live';
import type { Baked } from '../src/world/bake';

const OPTS = { incline: 0.5, sky: true, outline: 'both' as const };
// El "juego": lo picado, en coordenadas del mundo; al entrar un trozo se vuelve a poner
const dug = new Set<string>();
const make = (center: Trozo, log?: { unload: string[]; load: string[] }) => new LiveWindow({
  blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS,
  onUnload: (t) => log?.unload.push(`${t[0]},${t[1]}`),
  onLoad: (t, ctx) => {
    log?.load.push(`${t[0]},${t[1]}`);
    for (const k of dug) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; if (Math.floor(x / TV) === t[0] && Math.floor(y / TV) === t[1]) ctx.write(x, y, z, 0); }
  },
});
const diff = (b: Baked, r: Baked) => {
  let n = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    let d = b.face[i] !== r.face[i] || !(b.pick[i] === r.pick[i] || (Number.isNaN(b.pick[i]!) && Number.isNaN(r.pick[i]!))) || b.sky![i] !== r.sky![i];
    for (let c = 0; c < 4 && !d; c++) d = b.rgba[i * 4 + c] !== r.rgba[i * 4 + c];
    if (d) n++;
  }
  return n;
};

describe('ventana viva', () => {
  it('andando: se corre por la cola, avisa al juego, y queda como hecha de nuevo; las entidades siguen en su sitio del mundo', () => {
    const log = { unload: [] as string[], load: [] as string[] };
    const win = make([0, 0], log);
    // Picar en el trozo (1, 0) (está en la ventana): el juego lo apunta en coordenadas del mundo
    for (let z = 20; z < 40; z++) for (let y = 5; y < 15; y++) for (let x = TV + 4; x < TV + 14; x++) {
      dug.add(`${x},${y},${z}`); const [lx, ly] = win.toLocal(x, y); win.store.set(lx, ly, z, 0);
    }
    const budget = new FrameBudget(1e6);
    // Una entidad en (40, 40) del mundo
    const [ex, ey] = win.toLocal(40, 40);
    const dot = new Model(pal, 'punto'); dot.set(0, 0, 0, material(0, 1));
    const id = win.state.entities.add({ model: dot, x: ex, y: ey, z: 30 });
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) { budget.run(); } };
    win.update(0, 0, budget); settle();
    // El objetivo anda 6 trozos al este y 3 al norte (cada paso, la cola hasta que no queda nada)
    let x = TV / 2, y = TV / 2;
    for (let s = 0; s < 9 * 8; s++) {
      if (s < 48) x += TV / 8; else y += TV / 8;
      win.update(x, y, budget); budget.run(); win.update(x, y, budget); settle(); win.update(x, y, budget); settle();
    }
    // Se corrió: la esquina va detrás del objetivo y salieron y entraron trozos
    expect(win.tx0).toBeGreaterThan(-2);
    const far = diff(win.baked, make([win.tx0 + 2, win.ty0 + 2]).baked);
    expect(far).toBe(0);
    // Y de vuelta: el trozo picado sale y vuelve a entrar (onLoad le pone lo picado)
    expect(win.isLoaded([1, 0])).toBe(false);
    for (let s = 0; s < 9 * 8; s++) {
      if (s < 24) y -= TV / 8; else x -= TV / 8;
      win.update(x, y, budget); budget.run(); win.update(x, y, budget); settle(); win.update(x, y, budget); settle();
    }
    expect(win.isLoaded([1, 0])).toBe(true);
    expect(log.unload.length).toBeGreaterThan(0);
    expect(log.load.length).toBe(25 + log.unload.length);                   // los 25 del principio también pasan por onLoad
    // Lo horneado = una ventana hecha de nuevo ahí (con lo picado)
    const ref = make([win.tx0 + 2, win.ty0 + 2]);
    expect([ref.tx0, ref.ty0]).toEqual([win.tx0, win.ty0]);
    expect(diff(win.baked, ref.baked)).toBe(0);
    // La rejilla de bloques también (celdas, giros y luces)
    const ga = win.grid.exportState(), gb = ref.grid.exportState();
    expect(Array.from(ga.cells)).toEqual(Array.from(gb.cells));
    expect(Array.from(ga.yaw)).toEqual(Array.from(gb.yaw));
    // La entidad, en el mismo sitio del mundo
    const e = win.state.entities.find((q) => q.id === id)!;
    expect(win.toWorld(e.x, e.y)).toEqual([40, 40]);
  });

  it('con fill (el juego escribe el trozo: lo generado y sus celdas guardadas, con giro) y onShift en celdas y vóxeles', () => {
    // El "juego": por trozo, celdas guardadas [x, y, z, bloque, giro] en celdas del mundo
    const saved = new Map<string, Array<[number, number, number, number, 0 | 90 | 180 | 270]>>();
    const shifts: Array<{ cells: readonly [number, number]; voxels: readonly [number, number] }> = [];
    const opts = (center: Trozo) => ({
      blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS,
      fill: (t: Trozo, ctx: import('../src/world/live').TrozoCtx) => {
        const r = generateRegion(SPEC, { x0: t[0] * TB, y0: t[1] * TB, z0: 0, width: TB, depth: TB, height: H });
        const job = ctx.grid.stampRegionJob(r, ctx.at);
        return { run: (d: number) => { if (!job.run(d)) return false; for (const [x, y, z, b, yaw] of saved.get(`${t[0]},${t[1]}`) ?? []) ctx.setCell(x, y, z, b, yaw); return true; } };
      },
      onShift: (d: { cells: readonly [number, number]; voxels: readonly [number, number] }) => shifts.push(d),
    });
    // Una flor girada en el trozo (1, 1): celda del mundo (TB + 1, TB + 2, 5)
    saved.set('1,1', [[TB + 1, TB + 2, 5, T('flor'), 90]]);
    const win = new LiveWindow(opts([0, 0]));
    expect(win.ctx([1, 1]).cell(TB + 1, TB + 2, 5)).toEqual([T('flor'), 90]);
    const budget = new FrameBudget(1e6);
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) budget.run(); };
    let x = TV / 2;
    for (let s = 0; s < 3 * 8; s++) { x += TV / 8; win.update(x, TV / 2, budget); settle(); win.update(x, TV / 2, budget); settle(); }
    expect(shifts.length).toBeGreaterThan(0);
    expect(shifts[0]).toEqual({ cells: [TB, 0], voxels: [TV, 0] });
    // La flor sigue en su celda del mundo (con su giro), y la rejilla es la de una ventana hecha de nuevo ahí
    expect(win.ctx([1, 1]).cell(TB + 1, TB + 2, 5)).toEqual([T('flor'), 90]);
    const ref = new LiveWindow(opts([win.tx0 + 2, win.ty0 + 2]));
    expect(Array.from(win.grid.exportState().cells)).toEqual(Array.from(ref.grid.exportState().cells));
    expect(diff(win.baked, ref.baked)).toBe(0);
  });
});
