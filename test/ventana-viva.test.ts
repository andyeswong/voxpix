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
import { rebakeChangedJobs, type Baked } from '../src/world/bake';
import { sectionAround, sectionLayer, SectionPainter, STRIP, secIdx, type SectionLayer } from '../src/world/section';

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
const diff = (b: Baked, r: Baked, rect?: { x0: number; y0: number; x1: number; y1: number }) => {
  let n = 0;
  for (let i = 0; i < r.width * r.height; i++) {
    if (rect) { const x = i % r.width, y = Math.floor(i / r.width); if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) continue; }
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

  it('con los 4 giros: todos se corren a la vez y quedan como en una ventana hecha de nuevo; turn cambia sin esperar', () => {
    const opts = (center: Trozo) => ({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS, quarters: [0, 1, 2, 3] as const });
    const win = new LiveWindow({ ...opts([0, 0]) });
    expect(win.quarters.sort()).toEqual([0, 1, 2, 3]);
    // Picar en el trozo (1, 0): el giro de ahora (0) lo rehornea el juego; los demás, update
    for (let z = 20; z < 40; z++) for (let y = 5; y < 15; y++) for (let x = TV + 4; x < TV + 14; x++) { const [lx, ly] = win.toLocal(x, y); win.store.set(lx, ly, z, 0); }
    const budget = new FrameBudget(1e6);
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) budget.run(); };
    let x = TV / 2, y = TV / 2;
    for (let s = 0; s < 5 * 8; s++) {
      if (s < 24) x += TV / 8; else y += TV / 8;
      // Con el giro 1 a la vista a mitad de camino
      if (s === 12) win.turn(1);
      win.update(x, y, budget); settle(); win.update(x, y, budget); settle(); win.update(x, y, budget); settle();
    }
    for (const j of rebakeChangedJobs(win.viewOf(0)!.baked, win.state.lights)) budget.push(j);
    win.update(x, y, budget); settle();
    expect(win.tx0).toBeGreaterThan(-2);
    // Una ventana hecha de nuevo ahí, con lo mismo picado
    const ref = new LiveWindow({ ...opts([win.tx0 + 2, win.ty0 + 2]) });
    for (let z = 20; z < 40; z++) for (let y2 = 5; y2 < 15; y2++) for (let x2 = TV + 4; x2 < TV + 14; x2++) {
      const [lx, ly] = ref.toLocal(x2, y2);
      if (lx >= 0 && ly >= 0 && lx < ref.store.width && ly < ref.store.depth) ref.store.set(lx, ly, z, 0);
    }
    for (const q of [0, 1, 2, 3] as const) {
      const r = ref.viewOf(q)!;
      for (const j of rebakeChangedJobs(r.baked, r.view.bakeable().lights)) while (!j.run(Infinity));
      expect([q, diff(win.viewOf(q)!.baked, r.baked)]).toEqual([q, 0]);
    }
    win.turn(2);
    expect(win.baked).toBe(win.viewOf(2)!.baked);
  });

  // every: el juego pone el corte en cada cuadro (alrededor del objetivo) o una vez, al empezar un corrimiento, y no lo
  // vuelve a tocar (la ventana lo corre; su cutJob a medias sigue en la cola)
  for (const every of [true, false]) it(`corte de casa de muñecas (view: { cut: true }), ${every ? 'puesto en cada cuadro' : 'puesto una vez'}: se corre con la ventana a medias de repasar, y tras girar; igual que cortar de nuevo ahí`, () => {
    const opts = (center: Trozo) => ({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS, view: { cut: true } });
    const win = new LiveWindow({ ...opts([0, 0]), viewport: [64, 40] });
    // La caja del techo alrededor del objetivo, en coordenadas locales de la ventana de ahora
    const cutAt = (w: LiveWindow, x: number, y: number) => { const [lx, ly] = w.toLocal(x, y); return { x0: Math.floor(lx) - 20, y0: Math.floor(ly) - 20, x1: Math.floor(lx) + 20, y1: Math.floor(ly) + 20, zTop: 36 }; };
    // Tanda pequeña: el repaso del corte va a medias cuando la ventana se corre
    const budget = new FrameBudget(0.3, undefined, { ms: 0.3, below: 64 });
    let placed = false;
    const frame = (x: number, y: number) => {
      win.update(x, y, budget);
      // (una vez: al empezar un corrimiento, para que el repaso vaya a medias en el cambio)
      if (every || (!placed && win.shifting)) { budget.push(win.view.cutJob(cutAt(win, x, y))); placed = true; }
      for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j);
      budget.run();
    };
    const settle = (x: number, y: number) => { for (let k = 0; k < 20000 && (win.busy || budget.pending); k++) frame(x, y); };
    const check = (x: number, y: number, q: 0 | 1) => {
      settle(x, y);
      const ref = new LiveWindow({ ...opts([win.tx0 + 2, win.ty0 + 2]), ...(q ? { quarters: [q] } : {}) });
      if (q) ref.turn(q);
      // (puesto una vez: la caja es la de entonces, corrida con la ventana; la ventana nueva está en el mismo sitio)
      ref.view.setCut(every ? cutAt(ref, x, y) : (win.view.currentCut as never));
      for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
      for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) while (!j.run(Infinity));
      expect(win.view.currentCut).toEqual(ref.view.currentCut);
      expect([q, diff(win.baked, ref.baked)]).toEqual([q, 0]);
    };
    let x = TV / 2, y = TV / 2, shifted = 0;
    for (let s = 0; s < 3 * 8; s++) { x += TV / 8; const t = win.tx0; frame(x, y); for (let k = 0; k < 6; k++) frame(x, y); if (win.tx0 !== t) shifted++; }
    expect(win.tx0).toBeGreaterThan(-2);
    check(x, y, 0);
    // Girar (la vista nueva lleva el corte: el juego lo pone en win.view) y seguir andando
    win.turnTo(1);
    placed = false;
    settle(x, y);
    expect(win.quarter).toBe(1);
    const ty = win.ty0;
    for (let s = 0; s < 2 * 8; s++) { y += TV / 8; frame(x, y); for (let k = 0; k < 6; k++) frame(x, y); }
    expect(win.ty0).toBeGreaterThan(ty);
    check(x, y, 1);
  });

  it('capa de sección (SectionPainter) con la ventana: pintando a mitad de los corrimientos, y tras girar con un pintor nuevo; igual que abrirla de nuevo ahí', () => {
    const opts = (center: Trozo) => ({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS });
    const win = new LiveWindow({ ...opts([0, 0]), viewport: [64, 40] });
    const budget = new FrameBudget(0.5, undefined, { ms: 0.5, below: 64 });
    let painter = new SectionPainter(win.baked, { ahead: 2, behind: 1 });
    // La caja: 24 vóxeles de ancho alrededor de los pies del objetivo (en los ejes de la vista)
    const cutOf = (w: LiveWindow, x: number, y: number) => { const [lx, ly] = w.toLocal(x, y); return sectionAround(w.view.camera, lx, ly, w.store.height[Math.floor(ly) * w.store.width + Math.floor(lx)]! - 12, 24); };
    const frame = (x: number, y: number, dir: number) => {
      win.update(x, y, budget);
      for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j);
      painter.set(cutOf(win, x, y), dir);
      const j = painter.job();
      if (j) budget.push(j);
      budget.run();
      painter.layer();
    };
    // (la capa del pintor va en anillo por columnas: secIdx, como en test/corte-componer.test.ts; y en la columna de cada
    // borde de la caja y la de fuera junto a ella, por diseño, el tono, el cielo y el contorno son los de un corte que
    // siguiera: esas no se comparan; también difieren sin ventana, andando sin correrse)
    const same = (a: SectionLayer | null, r: SectionLayer | null, bx0: number, bx1: number) => {
      if (!a || !r) return a === r;
      if (a.x !== r.x || a.y !== r.y || a.w !== r.w || a.h !== r.h || a.count !== r.count) return false;
      for (let q = 0; q < r.w * r.h; q++) {
        const gx = r.x + (q % r.w);
        if (gx === bx0 - 1 || gx === bx0 || gx === bx1 || gx === bx1 + 1) continue;
        const l = secIdx(a, gx, Math.floor(q / r.w));
        if (a.mask[l] !== r.mask[q]) return false;
        if (!r.mask[q]) continue;
        for (let c = 0; c < 4; c++) if (a.rgba[l * 4 + c] !== r.rgba[q * 4 + c]) return false;
        if (a.depth[l] !== r.depth[q] || a.sky![l] !== r.sky![q] || a.face[l] !== r.face[q]) return false;
      }
      return true;
    };
    const check = (x: number, y: number, dir: number, q: 0 | 1) => {
      for (let k = 0; k < 20000 && (win.busy || budget.pending || !painter.ready()); k++) frame(x, y, dir);
      const ref = new LiveWindow({ ...opts([win.tx0 + 2, win.ty0 + 2]), ...(q ? { quarters: [q] } : {}) });
      if (q) ref.turn(q);
      for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
      const c = cutOf(ref, x, y), x0 = Math.floor(c.x0 / STRIP) * STRIP;
      const R = sectionLayer(ref.baked, { ...c, x0, x1: x0 + Math.ceil((c.x1 - c.x0 + 1) / STRIP) * STRIP - 1 });
      expect(R).not.toBeNull();
      expect(R!.count).toBeGreaterThan(100);
      expect([q, same(painter.layer(), R, x0, x0 + Math.ceil((c.x1 - c.x0 + 1) / STRIP) * STRIP - 1)]).toEqual([q, true]);
    };
    let x = TV / 2, y = TV / 2;
    for (let s = 0; s < 3 * 8; s++) { x += TV / 8; for (let k = 0; k < 6; k++) frame(x, y, 1); }
    expect(win.tx0).toBeGreaterThan(-2);
    check(x, y, 1, 0);
    // Girar: el horneado es otro, y el pintor va atado al suyo (el juego hace uno nuevo)
    win.turnTo(1);
    for (let k = 0; k < 20000 && win.turning; k++) frame(x, y, 0);
    painter = new SectionPainter(win.baked, { ahead: 2, behind: 1 });
    const ty = win.ty0;
    for (let s = 0; s < 2 * 8; s++) { y += TV / 8; for (let k = 0; k < 6; k++) frame(x, y, 0); }
    expect(win.ty0).toBeGreaterThan(ty);
    check(x, y, 0, 1);
  });

  it("carga del principio por la cola (preload: 'queue'): el anillo listo antes que todo, y al final igual que cargada en el constructor", () => {
    const opts = { blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0] as Trozo, margin: 1, bake: OPTS };
    const win = new LiveWindow({ ...opts, preload: 'queue' });
    expect(win.preloadingNow).toBe(true);
    expect(win.isLoaded([0, 0])).toBe(false);
    // (el anillo, el trozo del objetivo solo: con 5 x 5, uno de 3 x 3 toca todos los de fuera con el margen del rehorneado)
    const x = TV / 2, y = TV / 2, ring = { x: 0, n: 0, s: 0 };
    expect(win.ready(x, y, ring)).toBe(false);
    const budget = new FrameBudget(1, undefined, { ms: 1, below: 64 });
    let ringAt = -1, allAt = -1, k = 0;
    for (; k < 20000 && (win.busy || budget.pending || win.preloadingNow); k++) {
      win.update(x, y, budget); budget.run();
      if (ringAt < 0 && win.ready(x, y, ring)) ringAt = k;
      if (allAt < 0 && win.ready(x, y, { x: 2, n: 2, s: 2 })) allAt = k;
    }
    // El trozo del objetivo escrito y horneado antes que la ventana entera (5 x 5); y todo acaba
    expect(ringAt).toBeGreaterThan(0);
    expect(allAt).toBeGreaterThan(ringAt);
    expect(k).toBeLessThan(20000);
    expect(win.preloadingNow).toBe(false);
    expect(win.ready(x, y, { x: 2, n: 2, s: 2 })).toBe(true);
    const ref = new LiveWindow(opts);
    for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
    for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) while (!j.run(Infinity));
    expect(diff(win.baked, ref.baked)).toBe(0);
  });

  it('girar con fundido (turnTo): lo visible primero, el cambio, lo demás después; cambiar de destino durante el fundido; queda como hecha de nuevo en ese giro', () => {
    const opts = (center: Trozo) => ({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS });
    const win = new LiveWindow({ ...opts([0, 0]), viewport: [64, 40] });
    for (let z = 20; z < 40; z++) for (let y = 5; y < 15; y++) for (let x = TV + 4; x < TV + 14; x++) { const [lx, ly] = win.toLocal(x, y); win.store.set(lx, ly, z, 0); }
    // Una luz fija, para que el giro la hornee
    const LW = [3 * TV + 5, 2 * TV + 7] as const;
    { const [lx, ly] = win.toLocal(LW[0], LW[1]); win.state.lights.addFixed({ id: 'antorcha', kind: 'torch', x: lx + 0.5, y: ly + 0.5, z: 44 }); }
    const budget = new FrameBudget(1, undefined, { ms: 1, below: 64 });
    // El juego: cada cuadro, lo cambiado en el giro de ahora
    // Una ventana hecha de nuevo donde está win, en el giro q, con lo mismo picado y la misma luz
    const refAt = (q: 0 | 1 | 2 | 3) => {
      const ref = new LiveWindow({ ...opts([win.tx0 + 2, win.ty0 + 2]), ...(q ? { quarters: [q] } : {}) });
      for (let z = 20; z < 40; z++) for (let y2 = 5; y2 < 15; y2++) for (let x2 = TV + 4; x2 < TV + 14; x2++) {
        const [lx, ly] = ref.toLocal(x2, y2);
        if (lx >= 0 && ly >= 0 && lx < ref.store.width && ly < ref.store.depth) ref.store.set(lx, ly, z, 0);
      }
      { const [lx, ly] = ref.toLocal(LW[0], LW[1]); ref.state.lights.addFixed({ id: 'antorcha', kind: 'torch', x: lx + 0.5, y: ly + 0.5, z: 44 }); }
      if (q) ref.turn(q);
      for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
      return ref;
    };
    // (onUpdate: justo después de update, antes de la cola)
    let onUpdate: (() => void) | null = null;
    const frame = (x: number, y: number) => { win.update(x, y, budget); onUpdate?.(); for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j); budget.run(); };
    let x = TV / 2, y = TV / 2, frames = 0, swapAt = -1;
    for (let s = 0; s < 5 * 8; s++) {
      if (s < 24) x += TV / 8; else y += TV / 8;
      if (s === 10) {
        win.turnTo(1);
        // Q otra vez durante el fundido: el destino pasa a 2
        frame(x, y); frame(x, y);
        expect(win.turning).toEqual({ to: 1, phase: 'core' });
        win.turnTo(((win.turnTarget + 1) % 4) as 2);
        expect(win.turning).toEqual({ to: 2, phase: 'core' });
        for (frames = 0; win.turning?.phase === 'core' && frames < 5000; frames++) frame(x, y);
        swapAt = frames;
        expect(win.quarter).toBe(2);
        // Al cambiar, lo que se ve ya está como en una ventana hecha de nuevo en ese giro
        const now = refAt(2), [lx, ly] = win.toLocal(x, y), [vx, vy] = win.view.camera.pointToView(lx, ly);
        const [px, py] = win.baked.cam.project(vx, vy, win.store.height[Math.floor(ly) * win.store.width + Math.floor(lx)]!);
        const X0 = Math.max(0, Math.min(win.baked.width - 64, Math.round(px) - 32)), Y0 = Math.max(0, Math.min(win.baked.height - 40, Math.round(py) - 20));
        expect(diff(win.baked, now.baked, { x0: X0, y0: Y0, x1: X0 + 63, y1: Y0 + 39 })).toBe(0);
        // Solo vive el giro de ahora
        expect(win.quarters).toEqual([2]);
        expect(win.turning?.phase).toBe('rest');
      }
      frame(x, y);
      for (let k = 0; k < 400 && (win.busy || budget.pending); k++) frame(x, y);
    }
    expect(swapAt).toBeGreaterThan(0);
    for (let k = 0; k < 3; k++) { frame(x, y); for (let k = 0; k < 400 && (win.busy || budget.pending); k++) frame(x, y); }
    expect(win.tx0).toBeGreaterThan(-2);
    // Una ventana hecha de nuevo ahí, en el giro 2, con lo mismo picado y la misma luz
    const ref = refAt(2), r = ref.viewOf(2)!;
    // (los vóxeles del mundo también: sin el giro 0, la ventana los corre aparte)
    let nv = 0;
    for (let z = win.store.zMin; z <= win.store.zMax; z++) for (let y2 = 0; y2 < win.store.depth; y2++) for (let x2 = 0; x2 < win.store.width; x2++) if (win.store.get(x2, y2, z) !== ref.store.get(x2, y2, z)) nv++;
    expect(nv).toBe(0);
    expect(diff(win.baked, r.baked)).toBe(0);
    // Girar con un corrimiento a medias (el cambio del corrimiento espera al giro, y pasa a la vista nueva): al 1, y en el
    // corrimiento siguiente al 0 (sin copia: lo demás se marca en el mundo, y los vóxeles los corre su horneado otra vez)
    for (const to of [1, 0] as const) {
      let turned = false;
      for (let s = 0; s < 3 * 8 && !turned; s++) {
        y -= TV / 8;
        onUpdate = () => { if (!turned && win.shifting) { win.turnTo(to); turned = true; expect(win.turning?.phase).toBe('core'); } };
        for (let k = 0; k < 400; k++) {
          frame(x, y);
          if (!win.busy && !budget.pending) break;
        }
        onUpdate = null;
      }
      expect(turned).toBe(true);
      for (let k = 0; k < 4000 && (win.busy || budget.pending); k++) frame(x, y);
      for (let k = 0; k < 3; k++) { frame(x, y); for (let k = 0; k < 400 && (win.busy || budget.pending); k++) frame(x, y); }
      expect(win.quarters).toEqual([to]);
      const rq = refAt(to);
      let nv = 0;
      for (let z = win.store.zMin; z <= win.store.zMax; z++) for (let y2 = 0; y2 < win.store.depth; y2++) for (let x2 = 0; x2 < win.store.width; x2++) if (win.store.get(x2, y2, z) !== rq.store.get(x2, y2, z)) nv++;
      expect([to, nv, diff(win.baked, rq.baked)]).toEqual([to, 0, 0]);
    }
  });
});
