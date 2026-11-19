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

import { renderRect, REMOTE_RETRIES, type RectOut } from '../src/world/bake';
import type { PreparedTrozo } from '../src/world/live';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockGrid } from '../src/world/blocks';

describe('recuadros pintados fuera (Baked.remote)', () => {
  it('uno que llega tarde, después del de un picado posterior, no lo pisa: algo suyo cambió y se pinta aquí', () => {
    const win = make([0, 0]), ref = make([0, 0]);
    const queue: Array<{ o: RectOut; at: number }> = [];
    let calls = 0;
    // El primero que se pide llega a las 10 llamadas; los demás, a la siguiente
    win.baked.remote = { ask: (rect) => { const o = renderRect(win.baked, rect), item = { o, at: queue.length === 0 ? 10 : 1 }; queue.push(item); let c = 0; return { result: () => (++c >= item.at ? item.o : null) }; } };
    // (en las mismas columnas: A de z 40 para arriba; B debajo, de 26 a 40: el suelo del hoyo de A, que está en el recuadro
    // de A, cambia con B)
    const dig = (w: LiveWindow, z0: number, z1: number) => { for (let z = z0; z < z1; z++) for (let y = 34; y < 44; y++) for (let x = 38; x < 50; x++) w.store.set(x, y, z, 0); };
    // A: picar y pedir su rehorneado (se pinta con A y llega tarde)
    dig(win, 40, 64);
    const ja = rebakeChangedJobs(win.baked, win.view.bakeable().lights);
    for (const j of ja) j.run(Infinity);
    // B: picar debajo; su rehorneado llega enseguida y se publica
    dig(win, 26, 40);
    const jb = rebakeChangedJobs(win.baked, win.view.bakeable().lights);
    for (const j of jb) for (let k = 0; k < 20 && !j.run(Infinity); k++);
    // Llega A: no tiene que pisar lo de B
    for (const j of ja) for (let k = 0; k < 20 && !j.run(Infinity); k++);
    calls++;
    dig(ref, 40, 64); dig(ref, 26, 40);
    for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
    expect(queue.length).toBeGreaterThan(1);
    expect(diff(win.baked, ref.baked)).toBe(0);
  });

  it('lo que llega se publica igual que pintarlo aquí; si algo suyo cambió mientras, se pinta aquí', () => {
    const run = (withRemote: boolean, digMidway: boolean) => {
      const win = make([0, 0]);
      let asked = 0, late: Array<() => void> = [];
      if (withRemote) win.baked.remote = { ask: (rect) => {
        asked++;
        // Llega dos llamadas después (se pinta con lo de ese momento: si se picó en medio, lo de antes)
        const o: RectOut = renderRect(win.baked, rect);
        let calls = 0;
        return { result: () => (++calls >= 2 ? o : null) };
      } };
      const budget = new FrameBudget(1e6);
      let x = TV / 2;
      for (let s = 0; s < 3 * 8; s++) {
        x += TV / 8;
        win.update(x, TV / 2, budget);
        for (let k = 0; k < 50 && (win.busy || budget.pending); k++) {
          budget.run();
          if (digMidway && k === 1) { const [lx, ly] = win.toLocal(x + TV, TV / 2); for (let z = 20; z < 40; z++) for (let y = ly - 4; y < ly + 4; y++) for (let xx = lx - 4; xx < lx + 4; xx++) if (xx >= 0 && xx < win.store.width && y >= 0 && y < win.store.depth) win.store.set(xx, y, z, 0); }
          win.update(x, TV / 2, budget);
        }
      }
      for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) while (!j.run(Infinity));
      void late;
      return { win, asked };
    };
    const a = run(true, false), b = run(false, false);
    expect(a.asked).toBeGreaterThan(3);
    expect(diff(a.win.baked, b.win.baked)).toBe(0);
    const c = run(true, true), d = run(false, true);
    expect(diff(c.win.baked, d.win.baked)).toBe(0);
  });

  it('uno que llega después de que un vecino que pinta en parte (no de su núcleo) cambió y se publicó encima: se pinta aquí, igual que hornear de nuevo', () => {
    // Como el del vecino de ventana-horneado, pero el recuadro de A se pinta fuera con lo de antes de cavar B. A, junto al
    // borde de su trozo de vóxeles (y 64..79); B, en el de al lado (80..95), al sur: fuera del plan de A, pero el recuadro de A
    // pinta 14 píxeles de B. Antes, al llegar, solo se miraba el grupo de A, y A tapaba con lo viejo lo que B ya había publicado
    const win = make([0, 0]), ref = make([0, 0]);
    const b = win.baked;
    b.remote = { ask: (rect) => { const o = renderRect(b, rect); let n = 0; return { result: () => (++n >= 2 ? o : null) }; } };
    const dig = (w: LiveWindow, [x0, y0, z0, x1, y1, z1]: number[]) => { for (let z = z0!; z <= z1!; z++) for (let y = y0!; y <= y1!; y++) for (let x = x0!; x <= x1!; x++) w.store.set(x, y, z, 0); };
    const A = [70, 70, 0, 78, 78, 63], B2 = [70, 80, 0, 78, 83, 63];
    dig(win, A);
    const ja = rebakeChangedJobs(b, win.view.bakeable().lights, { shape: { band: 16, rows: 64, merge: true } });
    // (cada uno pide el suyo fuera: se pinta ya, con lo de ahora, y llega a la llamada siguiente)
    const left = ja.filter((j) => !j.run(Infinity));
    expect(left.some((j) => j.key.startsWith('rect:'))).toBe(true);
    dig(win, B2);
    const jb = rebakeChangedJobs(b, win.view.bakeable().lights, { shape: { band: 16, rows: 64, merge: true } });
    for (const j of jb) for (let k = 0; k < 20 && !j.run(Infinity); k++);
    const before = b.remoteStats?.stale ?? 0;
    for (const j of left) for (let k = 0; k < 20 && !j.run(Infinity); k++);
    expect((b.remoteStats?.stale ?? 0) - before).toBeGreaterThan(0);
    dig(ref, A); dig(ref, B2);
    for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
    expect(diff(b, ref.baked)).toBe(0);
  });

  it('uno que llega caducado se vuelve a pedir fuera (con lo de ahora), y tras REMOTE_RETRIES veces caducado se pinta aquí; igual que hornear de nuevo', () => {
    const run = (digs: number) => {
      const win = make([0, 0]), ref = make([0, 0]);
      const b = win.baked;
      let asks = 0;
      b.remote = { ask: (rect) => { asks++; const o = renderRect(b, rect); let n = 0; return { result: () => (++n >= 2 ? o : null) }; } };
      // (en el núcleo del recuadro: cada vez que se pinta fuera, se pica un poco más mientras tanto)
      const dig = (w: LiveWindow, k: number) => { for (let z = 30 - k * 3; z < 64; z++) for (let y = 70; y < 76; y++) for (let x = 70; x < 76; x++) w.store.set(x, y, z, 0); };
      dig(win, 0);
      const jobs = rebakeChangedJobs(b, win.view.bakeable().lights, { shape: { band: 16, rows: 64, merge: true } });
      let k = 0;
      for (let it = 0; it < 50 && jobs.some((j) => !j.run(Infinity)); it++) {
        // (pedido y aún fuera: se pica otra vez, hasta `digs` veces)
        if (k < digs && asks > k) dig(win, ++k);
      }
      for (let i = 0; i <= k; i++) dig(ref, i);
      for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
      return { asks, stale: b.remoteStats?.stale ?? 0, d: diff(b, ref.baked) };
    };
    // Una vez caducado: se vuelve a pedir (2 pedidos), nada se pinta aquí
    const one = run(1);
    expect([one.stale, one.d]).toEqual([1, 0]);
    expect(one.asks).toBe(2);
    // Caducado cada vez: 1 + REMOTE_RETRIES pedidos, y después aquí
    const all = run(10);
    expect(all.asks).toBe(1 + REMOTE_RETRIES);
    expect(all.stale).toBe(1 + REMOTE_RETRIES);
    expect(all.d).toBe(0);
  });

  it('trozos escritos fuera (prepareTrozo): la copia del "worker" los estampa y el principal solo pone sus losas; igual que escribirlos aquí', () => {
    const win0 = make([0, 0]);
    // La copia: un store y una rejilla como los de la ventana, con lo que escribió el constructor
    const mirror = new StaticVoxels(set.palette, win0.store.width, win0.store.depth, win0.store.zMin, win0.store.zMax);
    const mgrid = new BlockGrid(new WorldState(mirror, [], null), set);
    let mtx0 = win0.tx0, mty0 = win0.ty0;
    for (let ty = mty0; ty < mty0 + 5; ty++) for (let tx = mtx0; tx < mtx0 + 5; tx++) mgrid.stampRegion(generateRegion(SPEC, { x0: tx * TB, y0: ty * TB, z0: 0, width: TB, depth: TB, height: H }), [(tx - mtx0) * TB, (ty - mty0) * TB, 0]);
    let preps = 0;
    const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 5, ny: 5, chunk: TB, center: [0, 0], margin: 1, bake: OPTS,
      onShift: (d) => { mirror.shift(d.voxels[0] / 16, d.voxels[1] / 16); mgrid.shift(d.cells[0], d.cells[1]); },
      prepareTrozo: (t, at) => {
        preps++;
        const r = generateRegion(SPEC, { x0: t[0] * TB, y0: t[1] * TB, z0: 0, width: TB, depth: TB, height: H });
        mgrid.stampRegion(r, [at[0], at[1], 0]);
        const chunks: PreparedTrozo['chunks'] = [];
        const k0x = (at[0] * B) / 16, k0y = (at[1] * B) / 16, k = (TB * B) / 16;
        for (let cy = k0y; cy < k0y + k; cy++) for (let cx = k0x; cx < k0x + k; cx++) { const c = cy * mirror.cols + cx; chunks.push({ c, ...mirror.exportChunkPrepared(c)! }); }
        let calls = 0;
        return { result: () => (++calls >= 2 ? { cells: r, chunks } : null) };
      } });
    void mtx0; void mty0;
    const budget = new FrameBudget(1e6);
    let x = TV / 2;
    for (let s = 0; s < 3 * 8; s++) { x += TV / 8; for (let k = 0; k < 50; k++) { win.update(x, TV / 2, budget); budget.run(); if (!win.busy && !budget.pending) break; } }
    expect(preps).toBeGreaterThan(5);
    // La copia, igual que el store del principal
    let nv = 0;
    for (let z = mirror.zMin; z <= mirror.zMax; z += 3) for (let y = 0; y < mirror.depth; y += 2) for (let xx = 0; xx < mirror.width; xx += 2) if (mirror.get(xx, y, z) !== win.store.get(xx, y, z)) nv++;
    expect(nv).toBe(0);
    // Y lo horneado, igual que una ventana hecha de nuevo ahí
    const ref = make([win.tx0 + 2, win.ty0 + 2]);
    for (const j of rebakeChangedJobs(ref.baked, ref.view.bakeable().lights)) while (!j.run(Infinity));
    for (const j of rebakeChangedJobs(win.baked, win.view.bakeable().lights)) while (!j.run(Infinity));
    expect(diff(win.baked, ref.baked)).toBe(0);
  });
});
