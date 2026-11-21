// El agua en la ventana viva, de punta a punta: un WaterLayer movable sin cargar puesto con LiveWindow.setWater, el agua
// de la región sin escribir en la rejilla (LiveWindowOptions.skip) y cargada en onLoad con regionWater(ctx.region),
// guardada en onUnload (save) y vuelta a cargar al volver. Andando por la cola de ida y vuelta:
// - el agua (fondo, paredes, cuenca y profundidad) queda como en una ventana hecha de nuevo en ese sitio;
// - ni la rejilla ni los vóxeles tienen agua (la dibuja la capa);
// - la vista del giro 0 (WaterView) la ve igual;
// - con el agua moviéndose (pisotones), lo de un trozo que sale y vuelve vuelve como salió.
import { describe, it, expect } from 'vitest';
import { material, Model, type Palette } from '../src/core';
import type { RegionSpec } from '../src/world/regiongen';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import { FrameBudget } from '../src/view/budget';
import { LiveWindow, type Trozo, type TrozoCtx, type PreparedTrozo } from '../src/world/live';
import { WaterLayer, regionWater, takeWaterVoxels, type WaterChunk } from '../src/world/water';
import { BlockGrid } from '../src/world/blocks';
import { StaticVoxels, WorldState } from '../src/world/state';
import { generateRegion } from '../src/world/regiongen';
import type { World } from '../src/world/build';
import { frame2D } from '../src/world/frame2d';

const B = 8, ids = ['piedra', 'tierra', 'hierba', 'agua', 'arena'];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${(30 + i * 20).toString(16)}2020`, `#${(40 + i * 20).toString(16)}3030`] })) };
const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, (x + y + z) % 2)]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 't', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as unknown as VoxsetFile);
const T = (id: string) => set.index(id);
const SPEC: RegionSpec = {
  seed: 11, width: 48, depth: 48, height: 8,
  surface: { base: 4, amplitude: 2, scale: 6 },
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 1 }, { material: T('piedra') }],
  seaLevel: 4, water: T('agua'), shore: { material: T('arena') },
};
const TB = 4, TV = TB * B;                       // un trozo: 4 x 4 bloques = 32 x 32 vóxeles
const OPTS = { incline: 0.5, sky: false, outline: 'none' as const };
const key = (t: Trozo) => `${t[0]},${t[1]}`;

// La ventana con su agua, como la conectaría un juego
function make(center: Trozo, saved: Map<string, WaterChunk | null>, extra: Partial<ConstructorParameters<typeof LiveWindow>[0]> = {}) {
  let water: WaterLayer | null = null;
  const queue: Array<[Trozo, TrozoCtx]> = [];
  const rect = (ctx: TrozoCtx) => [ctx.at[0] * B, ctx.at[1] * B, ctx.at[0] * B + TV - 1, ctx.at[1] * B + TV - 1] as const;
  const load = (t: Trozo, ctx: TrozoCtx) => {
    const s = saved.get(key(t)) ?? null;
    water!.load(...rect(ctx), { saved: s, surface: s ? null : regionWater(ctx.region!, T('agua'), B, ctx.at) });
  };
  const win = new LiveWindow({
    blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS, skip: [T('agua')],
    // (los del constructor llegan antes de que haya capa: se cargan al ponerla)
    onLoad: (t, ctx) => { if (water) load(t, ctx); else queue.push([t, ctx]); },
    onUnload: (t, ctx) => { saved.set(key(t), water!.save(...rect(ctx))); },
    ...extra,
  });
  const s = win.store;
  water = new WaterLayer({ model: s, lights: [], width: s.width, depth: s.depth, wet: new Uint8Array(0), waterTop: new Int16Array(0), fountain: null } as unknown as World, { movable: true, unloaded: true, wallAbove: Infinity });
  win.setWater(water);
  for (const [t, ctx] of queue) load(t, ctx);
  return { win, water };
}

function sameWater(a: WaterLayer, b: WaterLayer, what: string): void {
  for (const [k, x, y] of [
    ['ground', a.sim.logical(a.sim.ground), b.sim.logical(b.sim.ground)],
    ['solid', a.sim.logical(a.sim.solid), b.sim.logical(b.sim.solid)],
    ['depth', a.sim.logical(a.sim.depth), b.sim.logical(b.sim.depth)],
    ['basin', a.sim.logical(a.basin), b.sim.logical(b.basin)],
  ] as const) {
    let bad = -1;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { bad = i; break; }
    expect([what, k, bad]).toEqual([what, k, -1]);
  }
}

describe('agua en la ventana viva (LiveWindow.setWater, skip, regionWater, load / save)', () => {
  it('andando de ida y vuelta: como una ventana hecha de nuevo ahí; sin agua en la rejilla ni en los vóxeles; la vista la ve igual', () => {
    const saved = new Map<string, WaterChunk | null>();
    const { win, water } = make([0, 0], saved);
    expect(water.sim.totalVolume()).toBeGreaterThan(100);
    const budget = new FrameBudget(1e6);
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) budget.run(); };
    win.update(0, 0, budget); settle();
    let x = TV / 2, y = TV / 2;
    const walk = (steps: number, dx: number, dy: number) => {
      for (let s = 0; s < steps; s++) { x += dx; y += dy; win.update(x, y, budget); budget.run(); win.update(x, y, budget); settle(); win.update(x, y, budget); settle(); }
    };
    walk(48, TV / 8, 0); walk(24, 0, TV / 8);
    expect(win.tx0).toBeGreaterThan(-2);
    expect(water.sim.origin).not.toEqual([0, 0]);
    sameWater(water, make([win.tx0 + 2, win.ty0 + 2], new Map()).water, 'lejos');
    walk(24, 0, -TV / 8); walk(48, -TV / 8, 0);
    expect(saved.size).toBeGreaterThan(0);
    const ref = make([win.tx0 + 2, win.ty0 + 2], new Map());
    expect([ref.win.tx0, ref.win.ty0]).toEqual([win.tx0, win.ty0]);
    sameWater(water, ref.water, 'de vuelta');
    // Ni la rejilla ni los vóxeles tienen agua
    const cells = win.grid.exportState().cells;
    expect(cells.some((c) => c === T('agua'))).toBe(false);
    let wv = 0;
    for (const [, , , v] of win.store.entries()) if (v >> 4 === T('agua') - 1) wv++;
    expect(wv).toBe(0);
    // La vista del giro 0 (WaterView, movable) ve la capa en orden, y es lo que da al render (frame), no el state
    const rs = win.view.frame();
    expect(rs.water).toBe(win.view.water);
    expect(rs.water).not.toBe(water);
    // Un cuadro de verdad en la CPU, con la capa corrida (drawWater por la vista; el de la capa directo daría error)
    const o = { vx: 0, vy: 0, vw: win.baked.width, vh: win.baked.height, time: 0, lights: true, ambient: [0.8, 0.8, 0.85] as [number, number, number] };
    const img = frame2D(rs, win.baked, o);
    expect(img.length).toBe(win.baked.width * win.baked.height * 4);
    const vw = win.view.water!, d = water.sim.logical(water.sim.depth), g = water.sim.logical(water.sim.ground);
    expect(Buffer.from(vw.sim.depth.buffer).equals(Buffer.from(d.buffer))).toBe(true);
    expect(Buffer.from(vw.sim.ground.buffer).equals(Buffer.from(g.buffer))).toBe(true);
  });

  it('regionWater: la superficie de cada columna es la de los vóxeles de agua de la misma región escrita sin skip', () => {
    // Una ventana sin skip (el agua como bloques): por trozo, lo que dice regionWater = lo que da takeWaterVoxels
    let checked = 0, wetCols = 0;
    let winRef: LiveWindow | null = null;              // (en el constructor la ventana aún no está: se comprueba al andar)
    // (un mar más hondo: columnas con dos y tres bloques de agua)
    const DEEP = { ...SPEC, seaLevel: 6 };
    let deep = 0;
    const win = new LiveWindow({
      blocks: set, spec: DEEP, nx: 3, ny: 3, chunk: TB, center: [0, 0], margin: 1, bake: OPTS,
      onLoad: (t, ctx) => {
        if (!winRef) return;
        const r = ctx.region!;
        for (let y = 0; y < r.region.depth; y++) for (let xx = 0; xx < r.region.width; xx++) {
          let n = 0;
          for (let z = 0; z < r.region.height; z++) if (r.cells[(z * r.region.depth + y) * r.region.width + xx] === T('agua')) n++;
          if (n >= 2) deep++;
        }
        const x0 = ctx.at[0] * B, y0 = ctx.at[1] * B, fromRegion = regionWater(ctx.region!, T('agua'), B, ctx.at);
        const fromVox = takeWaterVoxels(winRef!.store, x0, y0, x0 + TV - 1, y0 + TV - 1, (v) => v >> 4 === T('agua') - 1);
        for (let y = y0; y < y0 + TV; y++) for (let x = x0; x < x0 + TV; x++) {
          const a = fromRegion(x, y), b = fromVox(x, y);
          if (a !== b) throw new Error(`trozo ${t}: columna ${x},${y}: regionWater ${a}, vóxeles ${b}`);
          checked++; if (a !== null) wetCols++;
        }
        expect(fromRegion(x0 - 1, y0)).toBeNull();
      },
    });
    winRef = win;
    const budget = new FrameBudget(1e6);
    let x = TV / 2;
    for (let s2 = 0; s2 < 16; s2++) { x += TV / 8; for (let k = 0; k < 50; k++) { win.update(x, TV / 2, budget); budget.run(); if (!win.busy && !budget.pending) break; } }
    expect(checked).toBeGreaterThan(TV * TV * 2);
    expect(wetCols).toBeGreaterThan(20);
    expect(deep).toBeGreaterThan(5);
  });

  it('al correrse: las gotas en el aire, lo que flota y los efectos siguen en su sitio del mundo, y lo que flota sobre su agua', () => {
    const { win, water } = make([0, 0], new Map());
    const st = win.state;
    // Un sitio con agua honda cerca del centro, para lo que flota
    let spot: [number, number] | null = null;
    for (let y = 40; y < win.store.depth - 40 && !spot; y += 2) for (let x = 40; x < win.store.width - 40 && !spot; x += 2) if (water.depthAt(x, y) > 2) spot = [x, y];
    expect(spot).not.toBeNull();
    const pad = new Model(pal, 'hoja'); pad.set(0, 0, 0, material(2, 1));
    const fid = st.floaters.add(pad, spot![0] + 0.25, spot![1] + 0.5);
    // Una gota en el aire, un emisor de efecto y una partícula suelta
    st.drops.emit(spot![0] + 3.5, spot![1] - 2.25, 60, 0, 0, 0);
    const em = st.simFx.add('polvo', spot![0] - 4, spot![1] + 6, 30);
    st.simFx.burst('polvo', spot![0] + 1, spot![1] + 1, 40, 1);
    const em2 = st.fx.add('polvo', spot![0] + 5, spot![1] - 3, 30);
    const world = () => {
      const f = st.floaters.list.find((q) => q.id === fid)!, e = st.entities.get(fid)!, [dx, dy] = st.drops.at(0);
      const emi = st.simFx.list().find((q) => q.id === em)!, part = st.simFx.exportState().data, emi2 = st.fx.list().find((q) => q.id === em2)!, part2 = st.fx.exportState().data;
      return { f: win.toWorld(f.x, f.y), e: win.toWorld(e.x, e.y), d: win.toWorld(dx, dy), em: win.toWorld(emi.x, emi.y), p: win.toWorld(part[0]!, part[1]!), em2: win.toWorld(emi2.x, emi2.y), p2: win.toWorld(part2[0]!, part2[1]!) };
    };
    const before = world();
    const budget = new FrameBudget(1e6);
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) budget.run(); };
    win.update(0, 0, budget); settle();
    const tx0 = win.tx0, ty0 = win.ty0;
    // (al este hasta que se corre en x, y al norte hasta que se corre en y)
    let x = TV / 2, y = TV / 2;
    for (let s2 = 0; s2 < 24 && win.tx0 === tx0; s2++) { x += TV / 8; win.update(x, y, budget); budget.run(); win.update(x, y, budget); settle(); }
    for (let s2 = 0; s2 < 24 && win.ty0 === ty0; s2++) { y += TV / 8; win.update(x, y, budget); budget.run(); win.update(x, y, budget); settle(); }
    expect([win.tx0 !== tx0, win.ty0 !== ty0]).toEqual([true, true]);
    // (sin pasos del mundo: solo se corrió la ventana)
    expect(world()).toEqual(before);
    // Y lo que flota sigue sobre su agua (la de la capa corrida): unos ticks, y no se vara
    const f = st.floaters.list.find((q) => q.id === fid)!;
    expect(water.depthAt(f.x, f.y)).toBeGreaterThan(2);
    for (let t = 0; t < 30; t++) st.step();
    expect(water.depthAt(f.x, f.y)).toBeGreaterThan(0.3);
  });

  it('setWater: cambiar de capa suelta la vieja (ya no se corre) y las vistas toman la nueva; null la quita', () => {
    const { win, water } = make([0, 0], new Map());
    const s = win.store;
    const other = new WaterLayer({ model: s, lights: [], width: s.width, depth: s.depth, wet: new Uint8Array(0), waterTop: new Int16Array(0), fountain: null } as unknown as World, { movable: true, unloaded: true });
    win.setWater(other);
    expect(win.state.water).toBe(other);
    expect((win.view.water as unknown as { src: unknown }).src).toBe(other);
    const budget = new FrameBudget(1e6);
    let x = TV / 2;
    for (let s2 = 0; s2 < 16; s2++) { x += TV / 8; for (let k = 0; k < 50; k++) { win.update(x, TV / 2, budget); budget.run(); if (!win.busy && !budget.pending) break; } }
    expect(other.sim.origin).not.toEqual([0, 0]);
    expect(water.sim.origin).toEqual([0, 0]);
    win.setWater(null);
    expect(win.state.water).toBeNull();
    expect(win.view.water).toBeNull();
    const fixed = new WaterLayer({ model: s, lights: [], width: s.width, depth: s.depth, wet: new Uint8Array(0), waterTop: new Int16Array(0), fountain: null } as unknown as World, {});
    expect(() => win.setWater(fixed)).toThrow(/movable/);
    expect(win.state.water).toBeNull();
  });

  it('con prepareTrozo (trozos escritos fuera, con skip en su copia): lo mismo que escribirlos aquí', () => {
    const tmp = make([0, 0], new Map());
    const mirror = new StaticVoxels(set.palette, tmp.win.store.width, tmp.win.store.depth, tmp.win.store.zMin, tmp.win.store.zMax);
    const mgrid = new BlockGrid(new WorldState(mirror, [], null), set);
    for (let ty = tmp.win.ty0; ty < tmp.win.ty0 + 5; ty++) for (let tx = tmp.win.tx0; tx < tmp.win.tx0 + 5; tx++)
      mgrid.stampRegion(generateRegion(SPEC, { x0: tx * TB, y0: ty * TB, z0: 0, width: TB, depth: TB, height: 8 }), [(tx - tmp.win.tx0) * TB, (ty - tmp.win.ty0) * TB, 0], { skip: [T('agua')] });
    let preps = 0;
    const { win, water } = make([0, 0], new Map(), {
      onShift: (d) => { mirror.shift(d.voxels[0] / 16, d.voxels[1] / 16); mgrid.shift(d.cells[0], d.cells[1]); },
      prepareTrozo: (t, at) => {
        preps++;
        const r = generateRegion(SPEC, { x0: t[0] * TB, y0: t[1] * TB, z0: 0, width: TB, depth: TB, height: 8 });
        mgrid.stampRegion(r, [at[0], at[1], 0], { skip: [T('agua')] });
        const chunks: PreparedTrozo['chunks'] = [];
        const k0x = (at[0] * B) / 16, k0y = (at[1] * B) / 16, k = (TB * B) / 16;
        for (let cy = k0y; cy < k0y + k; cy++) for (let cx = k0x; cx < k0x + k; cx++) { const c = cy * mirror.cols + cx; chunks.push({ c, ...mirror.exportChunkPrepared(c)! }); }
        return { result: () => ({ cells: r, chunks }) };
      },
    });
    const budget = new FrameBudget(1e6);
    let x = TV / 2;
    for (let s2 = 0; s2 < 3 * 8; s2++) { x += TV / 8; for (let k = 0; k < 50; k++) { win.update(x, TV / 2, budget); budget.run(); if (!win.busy && !budget.pending) break; } }
    expect(preps).toBeGreaterThan(5);
    expect(win.grid.exportState().cells.some((c) => c === T('agua'))).toBe(false);
    sameWater(water, make([win.tx0 + 2, win.ty0 + 2], new Map()).water, 'preparado');
  });

  it('con el agua moviéndose: un trozo que sale y vuelve trae su agua como salió (quieta)', () => {
    const saved = new Map<string, WaterChunk | null>();
    const { win, water } = make([0, 0], saved);
    const budget = new FrameBudget(1e6);
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) budget.run(); };
    win.update(0, 0, budget); settle();
    // Pisotones en el agua del trozo más al oeste de la ventana, y unos ticks
    const t0: Trozo = [win.tx0, win.ty0 + 2];
    let wet: [number, number] | null = null;
    const [lx0, ly0] = win.toLocal(t0[0] * TV, t0[1] * TV);
    for (let yy = ly0; yy < ly0 + TV && !wet; yy += 2) for (let xx = lx0; xx < lx0 + TV && !wet; xx += 2) if (water.depthAt(xx, yy) > 0.5) wet = [xx, yy];
    expect(wet).not.toBeNull();
    for (let t = 0; t < 20; t++) { if (t % 5 === 0) water.disturb(wet![0], wet![1], 3, 2); win.state.step(); }
    // Lo de ese trozo justo antes de salir (en coordenadas del mundo)
    const snap = (tt: Trozo) => {
      const [ax, ay] = win.toLocal(tt[0] * TV, tt[1] * TV), out: number[] = [];
      for (let yy = ay; yy < ay + TV; yy += 2) for (let xx = ax; xx < ax + TV; xx += 2) out.push(water.depthAt(xx, yy));
      return out;
    };
    const before = snap(t0);
    expect(before.some((v) => v > 0)).toBe(true);
    // Se va al este hasta que sale, y vuelve (sin ticks: lo que se quedó no se mueve)
    let x = TV / 2, y = TV / 2;
    const walk = (steps: number, dx: number) => { for (let s = 0; s < steps; s++) { x += dx; win.update(x, y, budget); budget.run(); win.update(x, y, budget); settle(); win.update(x, y, budget); settle(); } };
    walk(24, TV / 8);
    expect(win.isLoaded(t0)).toBe(false);
    expect(saved.has(key(t0))).toBe(true);
    // (de vuelta hasta que el trozo vuelve a entrar: la ventana no se corre hasta que el objetivo se acerca al borde)
    for (let n = 0; n < 80 && !win.isLoaded(t0); n++) walk(1, -TV / 8);
    expect(win.isLoaded(t0)).toBe(true);
    expect(snap(t0)).toEqual(before);
  });
});
