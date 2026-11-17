// Caminos en la ventana viva: un PathField y un LevelPathField enganchados a LiveWindow (attach) se corren con ella.
// Andando, con picados en medio (avisos de watchChanges sin tomar al correrse) y consultas por el camino, al final dan lo
// mismo que unos campos hechos de nuevo sobre una ventana hecha de nuevo en ese sitio: los suelos de cada celda y los
// caminos hacia una meta
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
import { PathField } from '../src/world/paths';
import { LevelPathField } from '../src/world/levelpaths';

const OPTS = { incline: 0.5, sky: true, outline: 'both' as const };
// Lo picado, en coordenadas del mundo; al entrar un trozo se vuelve a poner
const dug = new Set<string>();
const make = (center: Trozo) => new LiveWindow({
  blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center, margin: 1, bake: OPTS,
  onLoad: (t, ctx) => {
    for (const k of dug) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; if (Math.floor(x / TV) === t[0] && Math.floor(y / TV) === t[1]) ctx.write(x, y, z, 0); }
  },
});
const dig = (win: LiveWindow, x0: number, y0: number) => {
  for (let z = 20; z < 40; z++) for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) {
    dug.add(`${x},${y},${z}`);
    const [lx, ly] = win.toLocal(x, y);
    if (lx >= 0 && ly >= 0 && lx < win.store.width && ly < win.store.depth) win.store.set(lx, ly, z, 0);
  }
};
// (radio 3: el cuerpo de las celdas del borde sale de la ventana, así que el borde nuevo se tiene que volver a mirar)
const LV = { cell: 4, radius: 3, height: 16, step: 8, maxDrop: 24 }, FL = { cell: 4, radius: 3, step: 8 };

describe('caminos en la ventana viva', () => {
  it('PathField y LevelPathField enganchados: andando y picando, quedan como hechos de nuevo en ese sitio', () => {
    const win = make([0, 0]);
    const flat = new PathField(win.state, FL), lv = new LevelPathField(win.state, LV);
    // Y uno con la búsqueda repartida (budget, como los bichos de noche): una búsqueda a medias al correrse se tira
    const slow = new LevelPathField(win.state, { ...LV, budget: 300 });
    win.attach(flat); win.attach(slow); const off = win.attach(lv);
    const budget = new FrameBudget(1e6);
    const settle = () => { for (let k = 0; k < 2000 && (win.busy || budget.pending); k++) budget.run(); };
    let x = TV / 2, y = TV / 2;
    for (let s = 0; s < 5 * 8; s++) {
      if (s < 24) x += TV / 8; else y += TV / 8;
      // Picar en cada paso, antes de update: en los pasos con corrimiento, el aviso se queda sin tomar y se corre con la
      // ventana (las consultas, cada 4 pasos)
      dig(win, Math.floor(x) + 10 + (s % 3) * 7, Math.floor(y) - 3 - (s % 2) * 9);
      win.update(x, y, budget); settle(); win.update(x, y, budget); settle();
      // Consultas por el camino (en coordenadas locales): hacia el objetivo desde un poco atrás
      if (s % 4 === 3) {
        const [lx, ly] = win.toLocal(x, y), from = { x: lx - 20, y: ly + 5 }, to = { x: lx, y: ly };
        flat.dir(from, to, 2);
        lv.dir({ ...from, z: 40 }, { ...to, z: 40 }, 2);
      }
      slow.dir({ x: 40, y: 40, z: 40 }, (() => { const [lx, ly] = win.toLocal(x, y); return { x: lx, y: ly, z: 40 }; })(), 2);
      slow.advance();
    }
    expect(win.tx0).toBeGreaterThan(-2);
    off();
    // Una ventana hecha de nuevo ahí (con lo mismo picado, puesto por onLoad) y campos nuevos
    const ref = make([win.tx0 + 2, win.ty0 + 2]);
    const rflat = new PathField(ref.state, FL), rlv = new LevelPathField(ref.state, LV);
    let bad = 0;
    for (let cy = 2; cy < win.store.depth; cy += 4) for (let cx = 2; cx < win.store.width; cx += 4) {
      const p = { x: cx, y: cy };
      if (JSON.stringify(lv.floorsAt(p)) !== JSON.stringify(rlv.floorsAt(p)) || flat.at(p).floor !== rflat.at(p).floor) bad++;
    }
    expect(bad).toBe(0);
    // Los caminos hacia el objetivo desde varios sitios: los mismos
    const [gx, gy] = win.toLocal(x, y), goal = { x: gx, y: gy };
    slow.dir({ x: 40, y: 40, z: 40 }, { ...goal, z: 40 }, 2);
    for (let k = 0; k < 1000 && !slow.advance(); k++);
    for (const [fx, fy] of [[10, 10], [150, 20], [30, 140], [140, 150], [80, 80]] as const) {
      expect([fx, fy, flat.path({ x: fx, y: fy }, goal, 2)]).toEqual([fx, fy, rflat.path({ x: fx, y: fy }, goal, 2)]);
      expect([fx, fy, slow.path({ x: fx, y: fy, z: 40 }, { ...goal, z: 40 }, 2)]).toEqual([fx, fy, rlv.path({ x: fx, y: fy, z: 40 }, { ...goal, z: 40 }, 2)]);
      expect([fx, fy, lv.path({ x: fx, y: fy, z: 40 }, { ...goal, z: 40 }, 2)]).toEqual([fx, fy, rlv.path({ x: fx, y: fy, z: 40 }, { ...goal, z: 40 }, 2)]);
    }
  });

  it('reach: hasta N pasos de la meta, el mismo camino que sin tope; más lejos, ninguno', () => {
    const win = make([0, 0]);
    const R = 10, goal = { x: 80, y: 80 };
    const full = new LevelPathField(win.state, LV), near = new LevelPathField(win.state, { ...LV, reach: R });
    const ffull = new PathField(win.state, FL), fnear = new PathField(win.state, { ...FL, reach: R });
    let inside = 0, outside = 0;
    for (let y = 2; y < win.store.depth; y += 6) for (let x = 2; x < win.store.width; x += 6) {
      const p = full.path({ x, y, z: 40 }, { ...goal, z: 40 }, 2), q = near.path({ x, y, z: 40 }, { ...goal, z: 40 }, 2);
      if (p && p.length - 1 <= R) { expect(q).toEqual(p); inside++; } else { expect(q).toBeNull(); if (p) outside++; }
      const a = ffull.path({ x, y }, goal, 2), b = fnear.path({ x, y }, goal, 2);
      if (a && a.length - 1 <= R) expect(b).toEqual(a); else expect(b).toBeNull();
    }
    // (que haya de los dos)
    expect(inside).toBeGreaterThan(5);
    expect(outside).toBeGreaterThan(5);
  });
});
