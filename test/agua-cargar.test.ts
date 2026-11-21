// Cargar y guardar el agua por trozos (WaterLayer.load / save, WaterOptions.unloaded, takeWaterVoxels), para la ventana
// viva:
// - cargar todos los trozos con la superficie de partida da lo mismo que construir la capa de una vez (fondo, paredes,
//   cuenca, profundidad y el tramo de alturas);
// - lo guardado al descargar un trozo vuelve igual al cargarlo (profundidad y cuenca, quieto), también tras correr la
//   ventana y volver;
// - takeWaterVoxels quita los vóxeles de agua y da su superficie (lo mismo que el agua de partida);
// - el borde de lo cargado se despierta: agua más alta a un lado baja al otro;
// - sin cargar, todo es pared seca.
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { CHUNK, StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer, takeWaterVoxels } from '../src/world/water';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const C = 6, R = 5, W = C * CHUNK, D = R * CHUNK, ZMAX = 31, CELL = 2;
const top = (x: number, y: number) => 12 + Math.round(3 * Math.sin(x / 9) + 2 * Math.cos(y / 7));
const lake = (x: number, y: number) => Math.sin(x / 13) + Math.cos(y / 11) > 1.1;
const floorAt = (x: number, y: number) => (lake(x, y) ? 4 : top(x, y));
const LEVEL = 7;
const wetTop = (gx: number, gy: number) => (lake(gx, gy) ? LEVEL : null);

function writeChunk(s: StaticVoxels, cx: number, cy: number, gx: number, gy: number, waterVoxels = false): void {
  for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
    const f = floorAt(gx + x, gy + y);
    for (let z = 0; z <= ZMAX; z++) s.set(x, y, z, z < f ? material(0, 1 + ((x + y) & 1)) : waterVoxels && lake(gx + x, gy + y) && z < LEVEL ? material(1, 2) : 0);
  }
}
function voxels(waterVoxels = false): StaticVoxels {
  const s = new StaticVoxels(PAL, W, D, 0, ZMAX);
  for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) writeChunk(s, cx, cy, 0, 0, waterVoxels);
  return s;
}
function world(s: StaticVoxels, withWater: boolean): World {
  const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  if (withWater) for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (lake(x, y)) { wet[y * W + x] = 1; waterTop[y * W + x] = LEVEL; }
  return { model: s, lights: [], width: W, depth: D, wet, waterTop, fountain: null } as unknown as World;
}
const rect = (cx: number, cy: number) => [cx * CHUNK, cy * CHUNK, cx * CHUNK + CHUNK - 1, cy * CHUNK + CHUNK - 1] as const;

function sameStatic(a: WaterLayer, b: WaterLayer, what: string): void {
  for (const [k, x, y] of [
    ['ground', a.sim.logical(a.sim.ground), b.sim.logical(b.sim.ground)],
    ['solid', a.sim.logical(a.sim.solid), b.sim.logical(b.sim.solid)],
    ['depth', a.sim.logical(a.sim.depth), b.sim.logical(b.sim.depth)],
    ['basin', a.sim.logical(a.basin), b.sim.logical(b.basin)],
  ] as const) expect([what, k, Buffer.from(x.buffer).equals(Buffer.from(y.buffer))]).toEqual([what, k, true]);
}

describe('agua por trozos: cargar y guardar', () => {
  it('cargar todos los trozos con la superficie de partida = construir de una vez', () => {
    const s = voxels();
    const once = new WaterLayer(world(s, true), { wallAbove: Infinity });
    const byChunk = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    // (sin cargar: todo pared seca)
    expect(byChunk.sim.solid.every((v) => v === 1)).toBe(true);
    expect(byChunk.sim.totalVolume()).toBe(0);
    // En otro orden que el de la rejilla
    for (const [cx, cy] of [[3, 2], [0, 0], [5, 4], [1, 3], [2, 0], [4, 1]]) {
      // (cada carga: la caja de cambios la cubre, para la vista, y el fondo sube de versión, para la GPU)
      const seq = byChunk.changesSince(0).seq, gv = byChunk.groundVersion;
      byChunk.load(...rect(cx!, cy!), { surface: wetTop });
      const n = CHUNK / CELL;
      const box = byChunk.changesSince(seq).box!;
      expect([box[0] <= cx! * n, box[1] <= cy! * n, box[2] >= cx! * n + n - 1, box[3] >= cy! * n + n - 1]).toEqual([true, true, true, true]);
      byChunk.step(1 / 60);
      expect(byChunk.groundVersion).toBe(gv + 1);
    }
    for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) byChunk.load(...rect(cx, cy), { surface: wetTop });
    sameStatic(once, byChunk, 'por trozos');
    expect(byChunk.zRange).toEqual(once.zRange);
    expect(once.sim.totalVolume()).toBeGreaterThan(100);
    expect(byChunk.basinChanged()).toBe(false);
  });

  it('lo guardado al descargar vuelve igual al cargar, también tras correr la ventana y volver', () => {
    const s = voxels();
    const w = new WaterLayer(world(s, true), { wallAbove: Infinity, movable: true });
    // Agua moviéndose y una cuenca ganada (un canal picado desde un lago)
    for (let t = 0; t < 30; t++) { w.disturb(24, 8, 3, 2); w.pour(60, 50, 2); w.step(1 / 60); }
    for (let y = 2; y < 30; y++) for (let x = 30; x < 32; x++) for (let z = 3; z <= ZMAX; z++) s.set(x, y, z, 0);
    w.syncGround({ x0: 30, y0: 2, x1: 31, y1: 29 });
    for (let t = 0; t < 30; t++) w.step(1 / 60);
    // Salen los trozos de las columnas 0 y 1 (se guardan); la ventana se corre dos trozos al este y vuelve
    const before = { depth: w.sim.logical(w.sim.depth), basin: w.sim.logical(w.basin) };
    const saved = [0, 1].map((cx) => [0, 1, 2, 3, 4].map((cy) => w.save(...rect(cx, cy))));
    expect(saved[1]!.some((c) => c !== null)).toBe(true);
    s.shift(2, 0); w.shift(2 * CHUNK, 0);
    s.shift(-2, 0); w.shift(-2 * CHUNK, 0);
    // (lo que salió volvió seco y de pared)
    expect(w.sim.solid[w.sim.at(0, 0)]).toBe(1);
    // Cada trozo se escribe con lo suyo (lo picado en la columna 1, como el juego con sus diferencias guardadas) y
    // después se carga su agua
    for (const cx of [0, 1]) for (let cy = 0; cy < R; cy++) {
      writeChunk(s, cx, cy, 0, 0);
      if (cx === 1) for (let y = Math.max(2, cy * CHUNK); y < Math.min(30, cy * CHUNK + CHUNK); y++) for (let x = 30; x < 32; x++) for (let z = 3; z <= ZMAX; z++) s.set(x, y, z, 0);
      w.load(...rect(cx, cy), { saved: saved[cx]![cy] });
    }
    // Lo de las dos columnas: la misma profundidad y cuenca que antes de salir (el agua de lo que se quedó no se movió:
    // no hubo pasos)
    const depth = w.sim.logical(w.sim.depth), basin = w.sim.logical(w.basin);
    for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < (2 * CHUNK) / CELL; gx++) {
      const k = gy * w.gw + gx;
      expect([gx, gy, depth[k], basin[k]]).toEqual([gx, gy, before.depth[k], before.basin[k]]);
    }
    // y el fondo, de los vóxeles reescritos
    const ref = new WaterLayer(world(s, false), { wallAbove: Infinity });
    expect(Buffer.from(w.sim.logical(w.sim.ground).buffer).equals(Buffer.from(ref.sim.ground.buffer))).toBe(true);
    // Un trozo sin agua no guarda nada
    const dry = new WaterLayer(world(voxels(), false), { wallAbove: Infinity });
    expect(dry.save(...rect(0, 0))).toBeNull();
  });

  it('takeWaterVoxels: quita los vóxeles de agua y da su superficie; cargar con ella = el agua de partida', () => {
    const s = voxels(true), plain = voxels(false);
    // Agua de una cueva bajo tierra (bajo un vóxel de piedra): se queda como vóxeles
    for (const v of [s, plain]) { v.set(70, 70, 2, material(1, 2)); v.set(70, 70, 1, material(1, 2)); }
    let water = 0;
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z <= ZMAX; z++) if (s.get(x, y, z) === material(1, 2)) water++;
    expect(water).toBeGreaterThan(500);
    const surface = takeWaterVoxels(s, 0, 0, W - 1, D - 1, (v) => v === material(1, 2));
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
      expect([x, y, surface(x, y)]).toEqual([x, y, wetTop(x, y)]);
      for (let z = 0; z <= ZMAX; z++) if (s.get(x, y, z) !== plain.get(x, y, z)) throw new Error(`vóxel ${x},${y},${z}`);
    }
    expect(surface(-1, 0)).toBeNull();
    const once = new WaterLayer(world(plain, true), { wallAbove: Infinity });
    const loaded = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    loaded.load(0, 0, W - 1, D - 1, { surface });
    sameStatic(once, loaded, 'desde vóxeles');
  });

  it('el borde de lo cargado se despierta: el agua más alta de un lado baja al otro', () => {
    const s = voxels();
    // Un valle llano en todo el mundo (fondo 4) con agua a 6, y un trozo que se carga con el agua a 9
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z <= ZMAX; z++) s.set(x, y, z, z < 4 ? material(0, 1) : 0);
    const w = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) if (cx !== 2 || cy !== 2) w.load(...rect(cx, cy), { surface: () => 6 });
    for (let t = 0; t < 400 && (w.sim.activeCount || t < 2); t++) w.step(1 / 60);
    expect(w.sim.activeCount).toBe(0);
    w.load(...rect(2, 2), { surface: () => 9 });
    // (lo cargado nace quieto: sin despertar su borde, nada se movería)
    const out = w.sim.at((3 * CHUNK) / CELL + 2, (2 * CHUNK + 8) / CELL), mid = w.sim.at((2 * CHUNK + 8) / CELL, (2 * CHUNK + 8) / CELL);
    const d0 = w.sim.depth[out]!, m0 = w.sim.depth[mid]!;
    expect([d0, m0]).toEqual([2, 5]);
    for (let t = 0; t < 120; t++) w.step(1 / 60);
    expect(w.sim.depth[out]!).toBeGreaterThan(d0 + 0.1);
    expect(w.sim.depth[mid]!).toBeLessThan(m0 - 0.1);
  });

  it('lo cargado: sin flujos, con su empapado, con su cuenca seca guardada y el tramo de alturas ensanchado', () => {
    const s = voxels();
    const w = new WaterLayer(world(s, true), { wallAbove: Infinity, movable: true });
    // Agua moviéndose en el lago de junto al borde sur; recargar su trozo (cx 1, cy 0) con lo suyo guardado lo deja sin
    // flujos (el resto del lago sigue moviéndose)
    for (let t = 0; t < 20; t++) { w.disturb(18, 6, 3, 3); w.step(1 / 60); }
    const [x0, y0, x1, y1] = rect(1, 0), n = CHUNK / CELL;
    const saved = w.save(x0, y0, x1, y1);
    w.load(x0, y0, x1, y1, { saved });
    const st = w.exportState();
    let moving = 0, inside = 0;
    for (let gy = 0; gy < w.gh; gy++) for (let gx = 0; gx < w.gw; gx++) {
      const k = gy * w.gw + gx, f = st.fl[k]! + st.fr[k]! + st.ft[k]! + st.fb[k]!;
      if (gx >= n && gx < 2 * n && gy < n) { expect([gx, gy, f]).toEqual([gx, gy, 0]); if (f === 0 && saved && saved.depth[(gy) * n + gx - n]! > 0) inside++; }
      else if (f > 0) moving++;
    }
    expect(moving).toBeGreaterThan(20);
    expect(inside).toBeGreaterThan(20);
    // Agua echada en seco en medio de un trozo (se empapa): guardada y cargada en otro sitio de la ventana, se sigue
    // empapando aunque nada la despierte
    const d = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, movable: true });
    d.pour(5 * CHUNK + 8, 3 * CHUNK + 8, 2);
    const spot = d.sim.at((5 * CHUNK + 8) / CELL, (3 * CHUNK + 8) / CELL);
    expect(d.isBasin(spot)).toBe(false);
    const wet = d.save(...rect(5, 3));
    expect(wet).not.toBeNull();
    const e = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, unloaded: true, movable: true });
    e.load(...rect(5, 3), { saved: wet });
    const v0 = e.sim.totalVolume();
    expect(v0).toBeGreaterThan(1);
    for (let t = 0; t < 600; t++) e.step(1 / 60);
    expect(e.sim.totalVolume()).toBeLessThan(v0 / 2);
    // Una cuenca seca (agua de partida a ras del fondo: cuenca sin profundidad) se guarda y vuelve
    const f = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, unloaded: true, movable: true });
    f.load(...rect(1, 1), { surface: (x, y) => (lake(x, y) ? 4 : null) });
    const cell = f.sim.at((1 * CHUNK + 1) / CELL, (1 * CHUNK + 1) / CELL);
    let basins = 0;
    for (let gy = n; gy < 2 * n; gy++) for (let gx = n; gx < 2 * n; gx++) if (f.isBasin(f.sim.at(gx, gy))) { basins++; expect(f.sim.depth[f.sim.at(gx, gy)]).toBe(0); }
    void cell;
    const dryBasin = f.save(...rect(1, 1));
    if (basins) {
      expect(dryBasin).not.toBeNull();
      const g = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, unloaded: true, movable: true });
      g.load(...rect(1, 1), { saved: dryBasin });
      expect(Buffer.from(g.sim.logical(g.basin).buffer).equals(Buffer.from(f.sim.logical(f.basin).buffer))).toBe(true);
    }
    expect(basins).toBeGreaterThan(0);
    // Agua alta (superficie a 40, por encima del tramo de siempre): el tramo de alturas la cubre
    const hgh = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, unloaded: true, movable: true });
    hgh.load(...rect(2, 2), { surface: () => 40 });
    expect(hgh.zRange[1]).toBeGreaterThanOrEqual(48);
  });

  it('el agua que se junta contra el borde sin cargar no se duplica ni se inventa: correr, guardar, cargar y volver cuadran el volumen', () => {
    const s = voxels();
    const w = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    const saved = new Map<string, ReturnType<WaterLayer['save']>>();
    const vol = (c: ReturnType<WaterLayer['save']>) => (c ? c.depth.reduce((a, v) => a + v, 0) : 0);
    let gx = 0;                                   // el trozo del mundo en la columna 0 de la ventana
    const loadCol = (cx: number) => { for (let cy = 0; cy < R; cy++) { const sv = saved.get(`${gx + cx},${cy}`) ?? null; w.load(...rect(cx, cy), { saved: sv, surface: sv ? null : (x, y) => wetTop(x + gx * CHUNK, y) }); } };
    const saveCol = (cx: number) => { for (let cy = 0; cy < R; cy++) saved.set(`${gx + cx},${cy}`, w.save(...rect(cx, cy))); };
    // (el mundo por trozos: la columna cx de la ventana es el trozo gx + cx)
    const writeCol = (cx: number) => { for (let cy = 0; cy < R; cy++) writeChunk(s, cx, cy, gx * CHUNK, 0); };
    for (let cx = 0; cx < C; cx++) loadCol(cx);
    // (el agua de la ventana más la guardada de los trozos que están fuera de ella)
    const total = () => w.sim.totalVolume() + [...saved].reduce((a, [k, c]) => { const tx = Number(k.split(',')[0]); return tx >= gx && tx < gx + C ? a : a + vol(c); }, 0);
    // Se corre un trozo al este: sale la columna 0 (se guarda) y la que entra queda sin cargar (pared)
    saveCol(0);
    s.shift(1, 0); w.shift(CHUNK, 0); gx++;
    // Agua echada junto al borde sin cargar: se junta contra la pared
    for (let k = 0; k < 40; k++) w.pour((C - 1) * CHUNK - 2, 20 + (k % 20), 3);
    for (let t = 0; t < 300; t++) w.step(1 / 60);
    const pile = w.sim.depth[w.sim.at(((C - 1) * CHUNK) / CELL - 1, 12)]!;
    expect(pile).toBeGreaterThan(0.1);
    // (el empapado quita agua del suelo seco: se mira lo que hay ahora, sin más pasos)
    const v1 = total();
    // Se carga la columna que entra con lo suyo: el volumen sube justo lo suyo (lo de una capa que solo tiene esa columna;
    // el agua de junto a la pared no cuenta como suya ni se pierde)
    writeCol(C - 1);
    const before = w.sim.totalVolume();
    loadCol(C - 1);
    const added = w.sim.totalVolume() - before;
    const ref = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    for (let cy = 0; cy < R; cy++) ref.load(...rect(C - 1, cy), { surface: (x, y) => wetTop(x + gx * CHUNK, y) });
    expect(added).toBeCloseTo(ref.sim.totalVolume(), 3);
    // (y lo de junto a la pared, donde estaba)
    expect(w.sim.depth[w.sim.at(((C - 1) * CHUNK) / CELL - 1, 12)]).toBe(pile);
    const v2 = total();
    expect(v2).toBeCloseTo(v1 + added, 3);
    // De vuelta: sale la columna del este (se guarda, con su agua) y vuelve la del oeste con lo guardado
    saveCol(C - 1);
    s.shift(-1, 0); w.shift(-CHUNK, 0); gx--;
    writeCol(0); loadCol(0);
    expect(total()).toBeCloseTo(v2, 3);
    // Cargar, guardar y cargar un trozo dormido (uno con agua): lo mismo byte a byte
    let wc: [number, number] = [0, 0];
    for (let cy = 0; cy < R; cy++) for (let cx = 1; cx < C - 1; cx++) if (w.save(...rect(cx, cy)) && wc[0] === 0) wc = [cx, cy];
    const a = w.save(...rect(...wc));
    w.load(...rect(...wc), { saved: a });
    const b = w.save(...rect(...wc));
    expect(a === null ? null : [Buffer.from(a.depth.buffer).toString('hex'), Buffer.from(a.basin.buffer).toString('hex')]).toEqual(b === null ? null : [Buffer.from(b.depth.buffer).toString('hex'), Buffer.from(b.basin.buffer).toString('hex')]);
    expect(a).not.toBeNull();
  });

  it('loadJob por unidades: rows filas por llamada (sin mirar el plazo), y acaba como load', () => {
    const s = voxels();
    const a = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    const b = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    a.load(...rect(1, 0), { surface: wetTop });
    const j = b.loadJob(...rect(1, 0), { surface: wetTop }, 3);
    let calls = 1;
    while (!j.run(0)) if (++calls > 100) throw new Error('loadJob no avanza');
    expect(calls).toBe(Math.ceil(CHUNK / CELL / 3));
    sameStatic(a, b, 'por pasos');
    expect(b.zRange).toEqual(a.zRange);
    // (y la capa no se puede correr con la carga a medias)
    const c = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, unloaded: true, movable: true });
    const jc = c.loadJob(...rect(1, 0), { surface: wetTop }, 1);
    expect(jc.run(0)).toBe(false);
    c.shift(CHUNK, 0);
    expect(() => jc.run(Infinity)).toThrow(/a medias/);
  });

  it('errores: recuadro que no es de celdas enteras, lo guardado de otro tamaño', () => {
    const w = new WaterLayer(world(voxels(), false), { wallAbove: Infinity, unloaded: true, movable: true });
    expect(() => w.load(1, 0, 16, 15)).toThrow(/celdas enteras/);
    expect(() => w.load(0, 0, 15, 15, { saved: { w: 4, h: 4, depth: new Float32Array(16), basin: new Uint8Array(16) } })).toThrow(/8 x 8/);
  });

  it('en el mundo: WorldState con una capa sin cargar (pared) no deja pasar el agua de lo cargado', () => {
    const s = voxels();
    const w = new WaterLayer(world(s, false), { wallAbove: Infinity, unloaded: true, movable: true });
    const st = new WorldState(s, [], w);
    w.load(...rect(0, 0), { surface: () => 20 });
    const v = w.sim.totalVolume();
    for (let t = 0; t < 120; t++) st.step();
    expect(Math.abs(w.sim.totalVolume() - v)).toBeLessThan(0.05 * v);
    for (let gy = 0; gy < w.gh; gy++) for (let gx = CHUNK / CELL; gx < w.gw; gx++) expect(w.sim.depth[w.sim.at(gx, gy)]).toBe(0);
  });
});
