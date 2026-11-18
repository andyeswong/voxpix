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
import { rebakeChangedJobs, pushPublished, publishedSince, PUBLISHED_KEEP, SKY_REACH, type Baked } from '../src/world/bake';
import { sectionAround, sectionLayer, sectionRows, SectionPainter, STRIP, secIdx, type SectionLayer } from '../src/world/section';

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
// Una cola sin reloj: FrameBudget con un reloj parado muy en el pasado. Todo plazo que da ya venció, así que cada trabajo
// hace exactamente una unidad por llamada (una franja, 16 columnas del corte, un paso) y la cola no decide nada por tiempo:
// el mismo orden en cualquier máquina y con cualquier carga
const stepBudget = () => new FrameBudget(1, () => -1e12, { ms: 1, below: 64 });
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

// Un recuadro publicado que cambia de verdad la imagen: sus píxeles pierden el vóxel (pick NaN). Uno que no cambia nada
// de lo que pinta una franja no la deja vieja (SectionPainter.revalidate)
const changed = <R extends { x0: number; y0: number; x1: number; y1: number }>(b: Baked, r: R): R => {
  for (let y = Math.max(0, r.y0); y <= Math.min(b.height - 1, r.y1); y++) for (let x = Math.max(0, r.x0); x <= Math.min(b.width - 1, r.x1); x++) b.pick[y * b.width + x] = NaN;
  return r;
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
    // (por pasos, sin reloj: con un reloj parado en el pasado cada plazo ya venció y cada trabajo hace una unidad por
    // cuadro; con 0,3 ms de reloj el test dependía de la carga de la máquina)
    const budget = stepBudget();
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
    // (4,8 s en la batería en paralelo, con el tope de 5 s de vitest: a veces se pasaba)
  }, 30000);

  it('capa de sección (SectionPainter) con la ventana: pintando a mitad de los corrimientos, y tras girar con un pintor nuevo; igual que abrirla de nuevo ahí', () => {
    const opts = (center: Trozo) => ({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS });
    const win = new LiveWindow({ ...opts([0, 0]), viewport: [64, 40] });
    const budget = stepBudget();
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
        if (a.depth[l] !== r.depth[q] || a.sky![l] !== r.sky![q] || a.face[l] !== r.face[q] || !Object.is(a.pick[l], r.pick[q]) || a.wy[l] !== r.wy[q]) return false;
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
    // Y al norte (corrimientos en y: filas y profundidad, con lo pintado corrido)
    const ty0 = win.ty0;
    for (let s = 0; s < 2 * 8; s++) { y += TV / 8; for (let k = 0; k < 6; k++) frame(x, y, 0); }
    expect(win.ty0).toBeGreaterThan(ty0);
    check(x, y, 0, 0);
    // Girar: el horneado es otro, y el pintor va atado al suyo (el juego hace uno nuevo)
    win.turnTo(1);
    for (let k = 0; k < 20000 && win.turning; k++) frame(x, y, 0);
    painter = new SectionPainter(win.baked, { ahead: 2, behind: 1 });
    const ty = win.ty0;
    for (let s = 0; s < 2 * 8; s++) { y += TV / 8; for (let k = 0; k < 6; k++) frame(x, y, 0); }
    expect(win.ty0).toBeGreaterThan(ty);
    check(x, y, 0, 1);
  });

  it('capa de sección: al correrse la ventana, lo pintado se corre con la imagen (la caja sigue pintada en el cuadro del cambio, sin repintar)', () => {
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS, viewport: [64, 40] });
    const budget = stepBudget();
    const painter = new SectionPainter(win.baked, { ahead: 2, behind: 1 });
    const cutOf = (x: number, y: number) => { const [lx, ly] = win.toLocal(x, y); return sectionAround(win.view.camera, lx, ly, win.store.height[Math.floor(ly) * win.store.width + Math.floor(lx)]! - 12, 24); };
    let x = TV / 2;
    const y = TV / 2;
    const frame = (paint: boolean) => {
      win.update(x, y, budget);
      for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j);
      painter.set(cutOf(x, y), 1);
      const j = paint ? painter.job() : null;
      if (j) budget.push(j);
      budget.run();
    };
    // Quieto hasta tenerlo todo pintado
    for (let k = 0; k < 20000 && (win.busy || budget.pending || !painter.ready()); k++) frame(true);
    let kept = 0;
    // Andando al este, un paso por cuadro, hasta 3 corrimientos: en el cuadro de cada cambio la caja ya está pintada
    for (let s = 0; s < 400 && kept < 3; s++) {
      x += 1;
      frame(false);
      if (win.shifting) {
        // Mientras se corre, sin pintar nada; en cuanto cambia, la caja tiene que seguir pintada
        const shifts = win.baked.shifts ?? 0, before = painter.painted;
        for (let k = 0; k < 20000 && (win.baked.shifts ?? 0) === shifts; k++) frame(false);
        expect(win.baked.shifts).toBe(shifts + 1);
        painter.set(cutOf(x, y), 1);
        expect(painter.painted).toBe(before);
        expect(painter.ready()).toBe(true);
        // Y lo corrido es lo que se pintaría ahora de nuevo con la imagen corrida (menos las columnas de los bordes de la
        // caja y las de fuera junto a ellas, que por diseño llevan el tono del corte que sigue)
        const c = cutOf(x, y), x0 = Math.floor(c.x0 / STRIP) * STRIP, x1 = x0 + Math.ceil((c.x1 - c.x0 + 1) / STRIP) * STRIP - 1;
        const A = painter.layer()!, R = sectionLayer(win.baked, { ...c, x0, x1 })!;
        expect(R.count).toBeGreaterThan(50);
        expect([A.x, A.y, A.w, A.h, A.count]).toEqual([R.x, R.y, R.w, R.h, R.count]);
        let off = 0;
        for (let q = 0; q < R.w * R.h; q++) {
          const gx = R.x + (q % R.w);
          if (gx === x0 - 1 || gx === x0 || gx === x1 || gx === x1 + 1) continue;
          const l = secIdx(A, gx, Math.floor(q / R.w));
          if (A.mask[l] !== R.mask[q]) { off++; continue; }
          if (!R.mask[q]) continue;
          let d = false;
          for (let ch = 0; ch < 4; ch++) if (A.rgba[l * 4 + ch] !== R.rgba[q * 4 + ch]) d = true;
          if (d || A.depth[l] !== R.depth[q] || A.face[l] !== R.face[q] || !Object.is(A.pick[l], R.pick[q]) || A.wy[l] !== R.wy[q] || A.sky![l] !== R.sky![q]) off++;
        }
        expect(off).toBe(0);
        kept++;
      }
      // Que todo vuelva a estar al día antes del siguiente paso
      for (let k = 0; k < 20000 && (win.busy || budget.pending || !painter.ready()); k++) frame(true);
    }
    expect(kept).toBe(3);
  });

  it('capa de sección: un recuadro publicado en sus columnas pero lejos de sus filas no tira lo pintado; uno en sus filas, sí', () => {
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS });
    const b = win.baked, painter = new SectionPainter(b, { ahead: 0, behind: 0 });
    // Una caja poco honda (sus filas acaban mucho antes del pie de la imagen)
    const [lx, ly] = win.toLocal(TV / 2, TV / 2), cut = { ...sectionAround(win.view.camera, lx, ly, win.store.height[ly * win.store.width + lx]! - 12, 24), y0: ly - 4 };
    painter.set(cut, 0);
    painter.paintAll();
    expect(painter.ready()).toBe(true);
    const [fy0, fy1] = sectionRows(b, { ...cut, x0: -1e9, x1: 1e9 }), a = b.options.oblique?.y ?? 1, mr = Math.ceil((a + 1) * (SKY_REACH + 1)) + 1;
    expect(fy1 + mr + 4).toBeLessThan(b.height - 1);
    const pub = b.published, cx = (b.options.originX ?? 0) + cut.x0 + 8;
    // Al sur, en las mismas columnas y por debajo de sus filas (más el margen del cielo): sigue al día
    pub.rects.push(changed(b, { serial: ++pub.serial, x0: cx, y0: fy1 + mr + 1, x1: cx + 3, y1: b.height - 1 }));
    expect(painter.ready()).toBe(true);
    // En sus filas (y cambiando la imagen): ya no
    pub.rects.push(changed(b, { serial: ++pub.serial, x0: cx, y0: fy0, x1: cx + 3, y1: fy1 }));
    expect(painter.ready()).toBe(false);
  });

  it('capa de sección: una ráfaga de más recuadros lejanos de los que se guardan no tira lo pintado; uno sobre ella olvidado entre ellos, sí', () => {
    const make = () => {
      const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS });
      const painter = new SectionPainter(win.baked, { ahead: 0, behind: 0 });
      const [lx, ly] = win.toLocal(TV / 2, TV / 2);
      const cut = sectionAround(win.view.camera, lx, ly, win.store.height[ly * win.store.width + lx]! - 12, 24);
      painter.set(cut, 0); painter.paintAll();
      expect(painter.ready()).toBe(true);
      return { b: win.baked, painter, cx: (win.baked.options.originX ?? 0) + cut.x0 + 8 };
    };
    // PUBLISHED_KEEP + 40 recuadros lejos de la caja (otras columnas, a más de SKY_REACH + 1)
    const burst = (b: Baked, far: number) => { for (let k = 0; k < PUBLISHED_KEEP + 40; k++) pushPublished(b, { serial: ++b.published.serial, x0: far, y0: 0, x1: far + 3, y1: 20 }); };
    { const { b, painter, cx } = make(); burst(b, cx + 60); expect(painter.ready()).toBe(true); }
    // El primero de la ráfaga, sobre la caja: se olvida, pero su tanda lo une
    { const { b, painter, cx } = make(); pushPublished(b, changed(b, { serial: ++b.published.serial, x0: cx, y0: 0, x1: cx + 3, y1: b.height - 1 })); burst(b, cx + 60); expect(painter.ready()).toBe(false); }
  });

  it('capa de sección: lo que solo cambió el cielo (sky: true) no deja viejas las franjas; sobre la columna de fuera de un borde, sí recompone', () => {
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS });
    const b = win.baked, painter = new SectionPainter(b, { ahead: 0, behind: 0 });
    const [lx, ly] = win.toLocal(TV / 2, TV / 2);
    const cut = sectionAround(win.view.camera, lx, ly, win.store.height[ly * win.store.width + lx]! - 12, 24);
    painter.set(cut, 0); painter.paintAll();
    expect(painter.ready()).toBe(true);
    // (la caja que pinta: la pedida, alineada a sus unidades)
    const box = (painter as unknown as { cut: { x0: number; x1: number } }).cut;
    const ox = b.options.originX ?? 0, L0 = painter.layer();
    expect(L0).not.toBeNull();
    // (lo que hizo el cielo de cueva tras el último recuadro del corte en el juego: sobre toda la caja)
    pushPublished(b, { serial: ++b.published.serial, x0: ox + box.x0 + 2, y0: 0, x1: ox + box.x1 - 2, y1: b.height - 1, sky: true });
    expect(painter.ready()).toBe(true);
    expect(painter.boxState().stale).toBe(0);
    expect(painter.layer()).toBe(L0);
    // Sobre la columna de fuera del borde (la composición copia ahí b.sky): recompone, y las franjas siguen al día
    pushPublished(b, { serial: ++b.published.serial, x0: ox + box.x0 - 1, y0: 0, x1: ox + box.x0 - 1, y1: b.height - 1, sky: true });
    expect(painter.ready()).toBe(true);
    expect(painter.layer()).not.toBe(L0);
    // Un recuadro de verdad (caras y vóxeles) en las mismas columnas sí las deja viejas
    pushPublished(b, changed(b, { serial: ++b.published.serial, x0: ox + box.x0 + 2, y0: 0, x1: ox + box.x0 + 5, y1: b.height - 1 }));
    expect(painter.ready()).toBe(false);
  });

  it('publishedSince: lo guardado y las tandas olvidadas (unidas), null si llega más atrás de lo que se recuerda', () => {
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS });
    const b = win.baked, s0 = b.published.serial;
    const N = PUBLISHED_KEEP * 3 + 7;
    for (let k = 0; k < N; k++) pushPublished(b, { serial: ++b.published.serial, x0: k, y0: k, x1: k + 1, y1: k + 1 });
    // Desde el principio: los guardados y las tandas que unen lo olvidado, sin dejar fuera ninguno
    const all = publishedSince(b, s0)!;
    for (let k = 0; k < N; k++) expect(all.some((r) => r.x0 <= k && r.x1 >= k + 1 && r.y0 <= k && r.y1 >= k + 1)).toBe(true);
    expect(publishedSince(b, s0 + N - 1)!.length).toBe(1);
    expect(publishedSince(b, b.published.serial)).toEqual([]);
    // Más de 16 tandas atrás ya no se sabe
    for (let k = 0; k < PUBLISHED_KEEP * 20; k++) pushPublished(b, { serial: ++b.published.serial, x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(publishedSince(b, s0)).toBeNull();
  });

  it('el salto (el objetivo aparece fuera de la ventana, a mitad de escribir): un solo cambio, onUnload solo de lo escrito, lo de alrededor antes que todo, e igual que hecha de nuevo ahí', () => {
    const log = { unload: [] as string[], load: [] as string[] };
    const win = make([0, 0], log);
    const budget = stepBudget();
    const frame = (x: number, y: number) => { win.update(x, y, budget); for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j); budget.run(); };
    // Andar un poco y picar; y saltar en cuanto un corrimiento deja trozos por escribir
    let x = TV / 2, y = TV / 2;
    for (let z = 20; z < 40; z++) for (let yy = 5; yy < 15; yy++) for (let xx = 4; xx < 14; xx++) { dug.add(`${xx},${yy},${z}`); const [lx, ly] = win.toLocal(xx, yy); win.store.set(lx, ly, z, 0); }
    const shifts0 = win.tx0;
    for (let k = 0; k < 2000 && !(win.tx0 !== shifts0 && win.queued > 2); k++) { x += 1; frame(x, y); }
    expect(win.queued).toBeGreaterThan(2);
    const loadedBefore = new Set(log.load.filter((t) => !log.unload.includes(t)));
    log.unload.length = 0; log.load.length = 0;
    // El salto: 9 trozos al este (la ventana tiene 5)
    x += 9 * TV;
    let ringAt = -1, k = 0;
    const [ttx, tty] = win.trozoOf(x, y);
    for (; k < 20000 && (win.busy || budget.pending || win.preloadingNow); k++) {
      frame(x, y);
      if (ringAt < 0 && win.ready(x, y, { x: 0, n: 0, s: 0 })) ringAt = k;
    }
    expect(k).toBeLessThan(20000);
    expect(win.jumps).toBe(1);
    expect([win.tx0 + 2, win.ty0 + 2]).toEqual([ttx, tty + 0]);
    // onUnload: solo los que estaban escritos, una vez cada uno (ni los que estaban por escribir)
    // (el salto es más largo que la ventana: salen todos los que había escritos)
    expect(new Set(log.unload)).toEqual(loadedBefore);
    expect(log.unload.length).toBe(loadedBefore.size);
    // El trozo del objetivo, listo antes que la ventana entera
    expect(ringAt).toBeGreaterThan(0);
    expect(ringAt).toBeLessThan(k - 1);
    // Igual que una ventana hecha de nuevo ahí
    const ref = make([win.tx0 + 2, win.ty0 + 2]);
    for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
    for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) while (!j.run(Infinity));
    expect(diff(win.baked, ref.baked)).toBe(0);
    dug.clear();
  });

  it("carga del principio por la cola (preload: 'queue'): el anillo listo antes que todo, y al final igual que cargada en el constructor", () => {
    const opts = { blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0] as Trozo, margin: 1, bake: OPTS };
    const win = new LiveWindow({ ...opts, preload: 'queue' });
    expect(win.preloadingNow).toBe(true);
    expect(win.isLoaded([0, 0])).toBe(false);
    // (el anillo, el trozo del objetivo solo: con 5 x 5, uno de 3 x 3 toca todos los de fuera con el margen del rehorneado)
    const x = TV / 2, y = TV / 2, ring = { x: 0, n: 0, s: 0 };
    expect(win.ready(x, y, ring)).toBe(false);
    const budget = stepBudget();
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

  it('girar con fundido: el rehorneado en la cola de la vista que se suelta acaba sin hacer nada (no la guarda en memoria)', () => {
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS, viewport: [64, 40] });
    const budget = stepBudget();
    const frame = () => { win.update(TV / 2, TV / 2, budget); budget.run(); };
    const settle = () => { frame(); for (let k = 0; k < 20000 && (win.busy || budget.pending || win.turning); k++) frame(); };
    settle();
    win.turnTo(1); settle();
    // En el giro 1: una torre junto a MAIA, y su rehorneado queda en la cola sin correr
    const old = win.baked;
    for (let y = TV / 2 - 3; y < TV / 2 + 3; y++) for (let x = TV / 2 + 4; x < TV / 2 + 10; x++) {
      const [lx, ly] = win.toLocal(x, y), h = win.store.height[ly * win.store.width + lx]!;
      for (let z = h; z < h + 12; z++) win.store.set(lx, ly, z, 1);
    }
    win.view.frame();
    const held = rebakeChangedJobs(old, win.view.bakeable().lights);
    expect(held.length).toBeGreaterThan(0);
    const before = old.rgba.slice();
    win.turnTo(2);
    for (let n = 0; win.turning?.phase === 'core' && n < 200000; n++) frame();
    expect(win.quarter).toBe(2);
    // Cada uno acaba a la primera, sin tocar la imagen de la vista soltada
    for (const j of held) expect(j.run(Infinity)).toBe(true);
    expect(Buffer.compare(Buffer.from(old.rgba.buffer), Buffer.from(before.buffer))).toBe(0);
  });

  it('girar con fundido: beforeTurnSwap corre por pasos tras los recuadros del núcleo, con el horneado nuevo, y el cambio lo espera', () => {
    const calls: Baked[] = [];
    let steps = 0, done = false, sawVisible = false;
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS, viewport: [64, 40],
      beforeTurnSwap: (b) => {
        calls.push(b);
        // Se pide con el núcleo ya pintado: es el horneado del giro nuevo, no el que se enseña
        expect(b).not.toBe(win.baked);
        return { run: () => { if (win.quarter !== 0) throw new Error('cambió antes de acabar'); sawVisible = true; return (done = ++steps >= 5); } };
      } });
    const budget = stepBudget();
    const frame = () => { win.update(TV / 2, TV / 2, budget); budget.run(); };
    frame();
    for (let k = 0; k < 20000 && (win.busy || budget.pending); k++) frame();
    win.turnTo(1);
    let n = 0;
    for (; win.turning?.phase === 'core' && n < 200000; n++) frame();
    expect(win.quarter).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(win.baked);
    expect(sawVisible && done).toBe(true);
    expect(steps).toBe(5);
  });

  it('turn suelta la vista de antes si no está en quarters (también a mitad de un corrimiento), y queda igual que una ventana hecha de nuevo en ese giro', () => {
    const opts = (center: Trozo) => ({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS });
    // Quieto: de 0 a 1 sin el 0 en quarters, solo queda la del 1
    const still = new LiveWindow({ ...opts([0, 0]), quarters: [1] });
    expect(still.quarters.sort()).toEqual([0, 1]);
    still.turn(1);
    expect(still.quarters).toEqual([1]);
    expect(still.viewOf(0)).toBeUndefined();
    // Con quarters [0, 1], las dos siguen
    const both = new LiveWindow({ ...opts([0, 0]), quarters: [0, 1] });
    both.turn(1);
    expect(both.quarters.sort()).toEqual([0, 1]);
    // Andando: girar justo cuando empieza un corrimiento (el 0 llevaba el de los vóxeles del mundo)
    const win = new LiveWindow({ ...opts([0, 0]), quarters: [1] });
    const budget = stepBudget();
    let x = TV / 2, turned = false;
    const y = TV / 2;
    const frame = () => {
      win.update(x, y, budget);
      if (!turned && win.shifting) { win.turn(1); turned = true; }
      for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) budget.push(j);
      budget.run();
    };
    for (let s = 0; s < 3 * 8; s++) { x += TV / 8; for (let k = 0; k < 6; k++) frame(); }
    for (let k = 0; k < 20000 && (win.busy || budget.pending); k++) frame();
    expect(turned).toBe(true);
    expect(win.quarters).toEqual([1]);
    expect(win.tx0).toBeGreaterThan(-2);
    const ref = new LiveWindow({ ...opts([win.tx0 + 2, win.ty0 + 2]), quarters: [1] });
    ref.turn(1);
    for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
    for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) while (!j.run(Infinity));
    let nv = 0;
    for (let z = win.store.zMin; z <= win.store.zMax; z++) for (let y2 = 0; y2 < win.store.depth; y2++) for (let x2 = 0; x2 < win.store.width; x2++) if (win.store.get(x2, y2, z) !== ref.store.get(x2, y2, z)) nv++;
    expect(nv).toBe(0);
    expect(diff(win.baked, ref.baked)).toBe(0);
  });

  it('bakeFirst view: el constructor hornea solo lo que se ve; en el primer cuadro la pantalla es la de la imagen entera, y lo demás lo hace la cola', () => {
    const opts = { blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0] as Trozo, margin: 1, bake: OPTS };
    const VP = [64, 40] as const;
    const win = new LiveWindow({ ...opts, viewport: VP, bakeFirst: 'view' });
    const ref = new LiveWindow(opts);
    expect(win.startup.core).toBeGreaterThan(0);
    expect(win.startup.rest).toBeGreaterThan(win.startup.core);
    // La pantalla alrededor del objetivo (el centro del trozo del centro), como la pone la cámara del juego
    const [lx, ly] = win.toLocal(TV / 2, TV / 2), [vx, vy] = win.view.camera.pointToView(lx, ly);
    const [px, py] = win.baked.cam.project(vx, vy, win.store.height[Math.floor(ly) * win.store.width + Math.floor(lx)]!);
    const X0 = Math.max(0, Math.min(win.baked.width - VP[0], Math.round(px) - VP[0] / 2)), Y0 = Math.max(0, Math.min(win.baked.height - VP[1], Math.round(py) - VP[1] / 2));
    const screen = { x0: X0, y0: Y0, x1: X0 + VP[0] - 1, y1: Y0 + VP[1] - 1 };
    // Antes de que corra nada de la cola: 0 píxeles distintos en la pantalla; fuera, todavía sin hacer
    expect(diff(win.baked, ref.baked, screen)).toBe(0);
    expect(diff(win.baked, ref.baked)).toBeGreaterThan(0);
    // Y con la cola, toda la imagen como la entera
    const budget = stepBudget();
    for (let k = 0; k < 50000 && (win.busy || budget.pending); k++) { win.update(TV / 2, TV / 2, budget); budget.run(); }
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
    const budget = stepBudget();
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
        for (frames = 0; win.turning?.phase === 'core' && frames < 200000; frames++) frame(x, y);
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
      for (let k = 0; k < 20000 && (win.busy || budget.pending); k++) frame(x, y);
    }
    expect(swapAt).toBeGreaterThan(0);
    for (let k = 0; k < 3; k++) { frame(x, y); for (let k = 0; k < 20000 && (win.busy || budget.pending); k++) frame(x, y); }
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
        for (let k = 0; k < 20000; k++) {
          frame(x, y);
          if (!win.busy && !budget.pending) break;
        }
        onUpdate = null;
      }
      expect(turned).toBe(true);
      for (let k = 0; k < 200000 && (win.busy || budget.pending); k++) frame(x, y);
      for (let k = 0; k < 3; k++) { frame(x, y); for (let k = 0; k < 20000 && (win.busy || budget.pending); k++) frame(x, y); }
      expect(win.quarters).toEqual([to]);
      const rq = refAt(to);
      let nv = 0;
      for (let z = win.store.zMin; z <= win.store.zMax; z++) for (let y2 = 0; y2 < win.store.depth; y2++) for (let x2 = 0; x2 < win.store.width; x2++) if (win.store.get(x2, y2, z) !== rq.store.get(x2, y2, z)) nv++;
      expect([to, nv, diff(win.baked, rq.baked)]).toEqual([to, 0, 0]);
    }
  });
});
