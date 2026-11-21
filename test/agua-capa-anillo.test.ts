// WaterLayer que se corre con la ventana (movable, shift en vóxeles): la rejilla en anillo y todo lo que la indexa
// (syncGround y su cuenca, pour, el empapado, waterAt / depthAt / surfaceAt, flowAt / slopeAt, firstPersonWater, la
// instantánea, WorldState.waterColumns y la vista WaterView, que la lee también en el giro 0). Contra una capa de
// referencia que se corre COPIANDO (por su instantánea, en el orden de la rejilla), sobre un mundo de vóxeles que se
// corre igual en las dos (StaticVoxels.shift), con lo que entra escrito en las dos y su fondo cargado (syncGround), pasos
// con pisotones, gotas y picados entre medias: lo mismo en todo.
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { CHUNK, StaticVoxels, WorldState } from '../src/world/state';
import { WaterLayer } from '../src/world/water';
import { WorldView } from '../src/world/view';
import type { World } from '../src/world/build';

const PAL = { ramps: [
  { name: 'piedra', colors: ['#303030', '#606060', '#909090', '#c0c0c0'] },
  { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
] };
const C = 6, R = 5, W = C * CHUNK, D = R * CHUNK, ZMAX = 31, CELL = 2;
// El mundo por coordenadas globales: suelo ondulado (de z 7 a 17) y lagos con su agua a z 7, a ras de la orilla más baja
const top = (x: number, y: number) => 12 + Math.round(3 * Math.sin(x / 9) + 2 * Math.cos(y / 7));
const lake = (x: number, y: number) => Math.sin(x / 13) + Math.cos(y / 11) > 1.1;
const floorAt = (x: number, y: number) => (lake(x, y) ? 4 : top(x, y));

function writeChunk(s: StaticVoxels, cx: number, cy: number, gx: number, gy: number): void {
  for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++) {
    const f = floorAt(gx + x, gy + y);
    for (let z = 0; z <= ZMAX; z++) s.set(x, y, z, z < f ? material(0, 1 + ((x + y) & 1)) : 0);
  }
}

function setup(movable: boolean) {
  const s = new StaticVoxels(PAL, W, D, 0, ZMAX);
  for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) writeChunk(s, cx, cy, 0, 0);
  const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) if (lake(x, y)) { wet[y * W + x] = 1; waterTop[y * W + x] = 7; }
  const world = { model: s, lights: [], width: W, depth: D, wet, waterTop, fountain: null } as unknown as World;
  const water = new WaterLayer(world, { movable, wallAbove: Infinity });
  const state = new WorldState(s, [], water);
  return { s, water, state };
}

// La referencia: corre copiando su instantánea (lo de (x + dx, y + dy) a (x, y); lo que entra, como la franja del anillo)
function copyShift(w: WaterLayer, dx: number, dy: number): void {
  const st = w.exportState(), gw = w.gw, gh = w.gh;
  const mv = <T extends Float32Array | Uint16Array | Uint8Array>(a: T, fill: number): T => {
    const out = a.slice() as T;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const sx = x + dx, sy = y + dy;
      out[y * gw + x] = sx >= 0 && sy >= 0 && sx < gw && sy < gh ? a[sy * gw + sx]! : fill;
    }
    return out;
  };
  const ground = mv(w.sim.ground, 0), solid = mv(w.sim.solid, 1);
  w.importState({ depth: mv(st.depth, 0), fl: mv(st.fl, 0), fr: mv(st.fr, 0), ft: mv(st.ft, 0), fb: mv(st.fb, 0), awake: mv(st.awake, 0), basin: mv(st.basin!, 0) });
  w.sim.ground.set(ground); w.sim.solid.set(solid);
}

function same(a: ReturnType<typeof setup>, b: ReturnType<typeof setup>, what: string): void {
  const A = a.water, B = b.water, ea = A.exportState(), eb = B.exportState();
  for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake', 'basin'] as const) {
    const x = ea[k]!, y = eb[k]!;
    let bad = -1;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) { bad = i; break; }
    expect([what, k, bad]).toEqual([what, k, -1]);
  }
  expect([what, Buffer.from(A.sim.logical(A.sim.ground).buffer).equals(Buffer.from(B.sim.logical(B.sim.ground).buffer))]).toEqual([what, true]);
  expect([what, Buffer.from(A.sim.logical(A.sim.solid).buffer).equals(Buffer.from(B.sim.logical(B.sim.solid).buffer))]).toEqual([what, true]);
  for (let y = 1; y < D; y += 5) for (let x = 1; x < W; x += 5) {
    expect([what, x, y, a.state.waterAt(x, y), A.flowAt(x, y), A.slopeAt(x, y)]).toEqual([what, x, y, b.state.waterAt(x, y), B.flowAt(x, y), B.slopeAt(x, y)]);
  }
  const fa = A.firstPersonWater(PAL as never)!, fb = B.firstPersonWater(PAL as never)!;
  expect([what, Buffer.from(fa.depth.buffer).equals(Buffer.from(fb.depth.buffer))]).toEqual([what, true]);
  const region = { x0: 0, y0: 0, x1: W - 1, y1: D - 1 };
  expect([what, [...a.state.waterColumns(region as never)].sort()]).toEqual([what, [...b.state.waterColumns(region as never)].sort()]);
}

// La vista del giro 0 de la capa en anillo (WaterView, en orden) contra la referencia, que está en orden
function sameView(view: WorldView, ref: ReturnType<typeof setup>, what: string): void {
  const vw = view.water!;
  expect([what, Buffer.from(vw.sim.depth.buffer).equals(Buffer.from(ref.water.sim.depth.buffer))]).toEqual([what, true]);
  expect([what, Buffer.from(vw.sim.ground.buffer).equals(Buffer.from(ref.water.sim.ground.buffer))]).toEqual([what, true]);
  for (let i = 0; i < ref.water.gw * ref.water.gh; i++) if (vw.isBasin(i) !== ref.water.isBasin(i)) throw new Error(`${what}: cuenca ${i}`);
}

// Un espejo como la textura del fondo de la GPU: se pone al día solo con staticSince (corre lo que tiene y sube la caja)
// y tiene que quedar igual que la vista
class Mirror {
  v = -1; ground: Float32Array; solid: Uint8Array; basin: Uint8Array; uploaded = 0; full = 0;   // (-1: como la GPU, la primera vez todo)
  constructor(readonly gw: number, readonly gh: number) { this.ground = new Float32Array(gw * gh); this.solid = new Uint8Array(gw * gh); this.basin = new Uint8Array(gw * gh); }
  sync(view: WorldView): void {
    const vw = view.water as unknown as { sim: { ground: Float32Array; solid: Uint8Array }; isBasin(i: number): boolean; staticSince(v: number): { v: number; all: boolean; shift: [number, number] | null; box: [number, number, number, number] | null } };
    const ch = vw.staticSince(this.v);
    this.v = ch.v;
    const up = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * this.gw + x; this.ground[i] = vw.sim.ground[i]!; this.solid[i] = vw.sim.solid[i]!; this.basin[i] = vw.isBasin(i) ? 1 : 0; this.uploaded++; }
    };
    if (ch.all) { this.full++; up(0, 0, this.gw - 1, this.gh - 1); return; }
    if (ch.shift) {
      const [dx, dy] = ch.shift, g = this.ground.slice(), so = this.solid.slice(), b = this.basin.slice();
      for (let y = 0; y < this.gh; y++) for (let x = 0; x < this.gw; x++) {
        const sx = x + dx, sy = y + dy, i = y * this.gw + x, inside = sx >= 0 && sy >= 0 && sx < this.gw && sy < this.gh, j = sy * this.gw + sx;
        this.ground[i] = inside ? g[j]! : 0; this.solid[i] = inside ? so[j]! : 1; this.basin[i] = inside ? b[j]! : 0;
      }
    }
    if (ch.box) up(...ch.box);
  }
  same(view: WorldView, what: string): void {
    const vw = view.water!;
    expect([what, Buffer.from(this.ground.buffer).equals(Buffer.from(vw.sim.ground.buffer)), Buffer.from(this.solid.buffer).equals(Buffer.from(vw.sim.solid.buffer))]).toEqual([what, true, true]);
    for (let i = 0; i < this.basin.length; i++) if (this.basin[i] !== (vw.isBasin(i) ? 1 : 0)) throw new Error(`${what}: cuenca ${i}`);
  }
}

describe('WaterLayer en anillo (movable, shift)', () => {
  it('igual que correr copiando: pasos, pisotones, gotas, picados y lo que entra cargado', () => {
    const ring = setup(true), ref = setup(false);
    const view = new WorldView(ring.state, 0);           // (movable: lee por WaterView también en el giro 0)
    const mirror = new Mirror(ring.water.gw, ring.water.gh);
    let gx = 0, gy = 0, k = 0;
    const marked = new Map<unknown, number[]>();
    const moves: Array<[number, number]> = [[1, 0], [0, 1], [-2, 1], [3, -1], [0, -2], [6, 0], [1, 1], [-1, -3], [2, 2], [0, 5]];
    for (const [dcx, dcy] of moves) {
      for (let t = 0; t < 30; t++) {
        for (const w of [ring, ref]) {
          if (t === 2) w.water.disturb(20 + (k * 17) % 50, 15 + (k * 11) % 45, 2.5, 2);
          if (t === 5) w.water.pour(30 + (k * 7) % 40, 20 + (k * 13) % 40, 3);
          if (t === 8) {
            // Un picado (un hoyo de 4 x 4 hasta z 6) y el fondo de lo tocado otra vez (syncGround, como follow)
            const px = 8 + (k * 19) % (W - 16), py = 8 + (k * 23) % (D - 16);
            for (let y = py; y < py + 4; y++) for (let x = px; x < px + 4; x++) for (let z = 6; z <= ZMAX; z++) w.s.set(x, y, z, 0);
            w.water.syncGround({ x0: px, y0: py, x1: px + 3, y1: py + 3 });
          }
          // Un tick del mundo entero (state.step): los trozos que marca el agua que se movió (dynamicVersions)
          if (t === 12) {
            const before = w.state.dynamicVersions.slice();
            w.state.step();
            marked.set(w, [...w.state.dynamicVersions].flatMap((v, c) => (v !== before[c] ? [c] : [])));
          } else w.water.step(1 / 60);
        }
        // La vista, entre corrimientos: copia solo lo que cambió (changesSince) y ve lo mismo que la referencia
        if (t % 10 === 9) { view.frame(); sameView(view, ref, `cuadro ${k}.${t}`); mirror.sync(view); mirror.same(view, `espejo ${k}.${t}`); }
      }
      expect([k, marked.get(ring)]).toEqual([k, marked.get(ref)]);
      same(ring, ref, `antes de ${dcx},${dcy}`);
      // (al empezar, con agua de verdad moviéndose)
      if (k === 0) { expect(ring.water.sim.totalVolume()).toBeGreaterThan(100); expect(ring.water.sim.activeCount).toBeGreaterThan(50); }
      // Unos pasos más sin cuadro: lo que cambia aquí, la vista lo copia después de correr (corrido con el corrimiento)
      for (let t = 0; t < 3; t++) for (const w of [ring, ref]) { w.water.disturb(30 + (k * 9) % 40, 20 + (k * 7) % 40, 2.5, 3); w.water.pour(40 + (k * 5) % 30, 30, 2); w.water.step(1 / 60); }
      // Correr: el mundo y el agua (la referencia, copiando)
      for (const w of [ring, ref]) w.s.shift(dcx, dcy);
      // (la vista se corre con la ventana antes que la capa, como en LiveWindow: WorldView.shift y después los Attached)
      view.shift(dcx * CHUNK, dcy * CHUNK);
      ring.water.shift(dcx * CHUNK, dcy * CHUNK); copyShift(ref.water, (dcx * CHUNK) / CELL, (dcy * CHUNK) / CELL);
      gx += dcx * CHUNK; gy += dcy * CHUNK;
      // Lo que entra: escrito en las dos y su fondo cargado
      for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) {
        const ox = cx + dcx, oy = cy + dcy;
        if (ox >= 0 && oy >= 0 && ox < C && oy < R) continue;
        for (const w of [ring, ref]) { writeChunk(w.s, cx, cy, gx, gy); w.water.syncGround({ x0: cx * CHUNK, y0: cy * CHUNK, x1: cx * CHUNK + CHUNK - 1, y1: cy * CHUNK + CHUNK - 1 }); }
      }
      same(ring, ref, `después de ${dcx},${dcy}`);
      // La vista del giro 0 (WaterView) ve lo mismo que la referencia, que está en orden
      const gv = ring.water.groundVersion;
      view.frame();
      sameView(view, ref, `vista ${dcx},${dcy}`);
      // (el espejo, a veces cada cuadro y a veces tras varios corrimientos seguidos: corre y sube lo justo)
      if (k % 3 !== 1) { mirror.sync(view); mirror.same(view, `espejo tras ${dcx},${dcy}`); }
      expect(gv).toBeGreaterThan(0);
      k++;
    }
    expect(ring.water.sim.origin).not.toEqual([0, 0]);
    // (el espejo se puso al día sin subirlo todo más que la primera vez)
    expect(mirror.full).toBe(1);
    expect(mirror.uploaded).toBeLessThan(moves.length * 4 * ring.water.gw * ring.water.gh / 3);
  });

  it('con el agua en calma, la vista copia solo lo que cambia junto a la costura del anillo, y ve lo mismo', () => {
    const ring = setup(true), ref = setup(false);
    const view = new WorldView(ring.state, 0);
    // Corrida un trozo en x y otro en y: la costura (la columna y la fila físicas 0) cae dentro de la rejilla
    for (const w of [ring, ref]) w.s.shift(1, 1);
    view.shift(CHUNK, CHUNK);
    ring.water.shift(CHUNK, CHUNK); copyShift(ref.water, CHUNK / CELL, CHUNK / CELL);
    for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) {
      if (cx < C - 1 && cy < R - 1) continue;
      for (const w of [ring, ref]) { writeChunk(w.s, cx, cy, CHUNK, CHUNK); w.water.syncGround({ x0: cx * CHUNK, y0: cy * CHUNK, x1: cx * CHUNK + CHUNK - 1, y1: cy * CHUNK + CHUNK - 1 }); }
    }
    // Hasta que se duerma todo (el lago que entró seco se llena desde la parte de antes)
    for (let t = 0; t < 6000 && (ring.water.sim.activeCount || t < 2); t++) for (const w of [ring, ref]) w.water.step(1 / 60);
    expect(ring.water.sim.activeCount).toBe(0);
    view.frame(); sameView(view, ref, 'en calma');
    const [sx, sy] = ring.water.sim.xy(0);                // la celda de la rejilla en el sitio físico 0
    let local = 0;
    for (const [px, py] of [[sx, sy], [sx - 1, sy], [sx, sy - 1], [sx - 1, sy - 1]] as Array<[number, number]>) {
      // Agua echada en la costura (gotas en celdas secas): se mueve y se empapa ahí, sin tocar lo demás
      for (const w of [ring, ref]) w.water.pour(px * CELL + 1, py * CELL + 1, 2);
      for (let t = 0; t < 12; t++) {
        for (const w of [ring, ref]) w.water.step(1 / 60);
        if (t % 3 === 2) {
          view.frame();
          const vis = (view.water as unknown as { visited: number }).visited;
          if (vis > 0 && vis < ring.water.gw * ring.water.gh / 4) local++;
          sameView(view, ref, `costura ${px},${py} tick ${t}`);
        }
      }
    }
    expect(local).toBeGreaterThan(4);
    // Agua echada lejos del borde y unos pasos sin cuadro; después, correr: lo que cambió antes de correr llega a la vista
    // corrido (en calma, la copia es solo de lo que cambió)
    for (let t = 0; t < 600 && (ring.water.sim.activeCount || t < 2); t++) for (const w of [ring, ref]) w.water.step(1 / 60);
    view.frame(); sameView(view, ref, 'otra vez en calma');
    for (const w of [ring, ref]) { w.water.pour(70, 30, 3); for (let t = 0; t < 4; t++) w.water.step(1 / 60); }
    // (tres trozos: lo que cambió queda lejos de donde estaba, sin solaparse)
    for (const w of [ring, ref]) w.s.shift(3, 0);
    view.shift(3 * CHUNK, 0);
    ring.water.shift(3 * CHUNK, 0); copyShift(ref.water, (3 * CHUNK) / CELL, 0);
    view.frame();
    expect((view.water as unknown as { visited: number }).visited).toBeLessThan(ring.water.gw * ring.water.gh);   // (no entera: la franja y lo echado)
    sameView(view, ref, 'cambio antes de correr');
  });

  it('por baldosas: dos sitios lejanos con agua moviéndose se copian sin lo de en medio; la vista girada, igual que la de la referencia', () => {
    const ring = setup(true), ref = setup(false);
    const view = new WorldView(ring.state, 0), turned = new WorldView(ring.state, 1), refTurned = new WorldView(ref.state, 1);
    for (const w of [ring, ref]) w.s.shift(1, 0);
    view.shift(CHUNK, 0); turned.shift(CHUNK, 0);
    ring.water.shift(CHUNK, 0); copyShift(ref.water, CHUNK / CELL, 0);
    for (let t = 0; t < 6000 && (ring.water.sim.activeCount || t < 2); t++) for (const w of [ring, ref]) w.water.step(1 / 60);
    expect(ring.water.sim.activeCount).toBe(0);
    view.frame(); turned.frame(); refTurned.frame();
    // Gotas en dos esquinas opuestas (secas: se empapan ahí)
    let most = 0, n = 0;
    for (let t = 0; t < 30; t++) {
      if (t % 10 === 0) for (const w of [ring, ref]) { w.water.pour(6, 6, 2); w.water.pour(W - 7, D - 7, 2); }
      for (const w of [ring, ref]) w.water.step(1 / 60);
      view.frame(); turned.frame(); refTurned.frame();
      const vis = (view.water as unknown as { visited: number }).visited;
      if (vis) { most = Math.max(most, vis); n++; }
      sameView(view, ref, `baldosas ${t}`);
      const a = turned.water!, b = refTurned.water!;
      expect([t, Buffer.from(a.sim.depth.buffer).equals(Buffer.from(b.sim.depth.buffer)), Buffer.from(a.sim.ground.buffer).equals(Buffer.from(b.sim.ground.buffer))]).toEqual([t, true, true]);
    }
    expect(n).toBeGreaterThan(10);
    // (la caja de las dos esquinas sería casi toda la rejilla; por baldosas, unas pocas de 8 x 8 en cada una)
    expect(most).toBeLessThan(ring.water.gw * ring.water.gh / 4);
  });

  it('la lista de baldosas cambiadas: leer a mitad de un tick y volver a cambiar la misma; corrimiento de media baldosa; lista desbordada', () => {
    const ring = setup(true), ref = setup(false);
    const view = new WorldView(ring.state, 0);
    for (let t = 0; t < 6000 && (ring.water.sim.activeCount || t < 2); t++) for (const w of [ring, ref]) w.water.step(1 / 60);
    view.frame();
    // Gota, la vista lee, otra gota en la misma celda sin paso entre medias: la vista la ve
    for (const w of [ring, ref]) w.water.pour(41, 41, 2);
    view.frame();
    for (const w of [ring, ref]) w.water.pour(41, 41, 3);
    view.frame();
    sameView(view, ref, 'dos gotas en el mismo tick');
    // Un corrimiento que no es de baldosas enteras (4 celdas): la vista lo copia todo
    for (const w of [ring, ref]) { w.water.step(1 / 60); }
    view.frame();
    ring.water.shift(8, 0); view.shift(8, 0); copyShift(ref.water, 4, 0);
    view.frame();
    expect((view.water as unknown as { visited: number }).visited).toBe(ring.water.gw * ring.water.gh);
    sameView(view, ref, 'media baldosa');
    // Una vista que no lee mientras otra lee cada tick: la lista se le queda corta y lo copia todo, igual que la referencia.
    // Una gota lejos (la baldosa 5,4) una sola vez y después mucho movimiento solo en las baldosas del oeste: la entrada de
    // la gota se pierde de la lista, y aun así la vista que no leía la ve
    const lazy = new WorldView(ring.state, 0);
    lazy.frame();
    for (const w of [ring, ref]) w.water.pour(90, 74, 3);
    let entries = 0, pseq = ring.water.changedTiles(0).seq;
    for (let t = 0; t < 4000; t++) {
      // (despiertas las celdas de x < 24: las baldosas 0..2 de cada fila cambian en cada tick)
      for (const w of [ring, ref]) { w.water.sim.wake(10, 20, 13); if (t % 3 === 0) w.water.disturb(8 + (t % 30), 30, 2, 2); w.water.step(1 / 60); }
      view.frame();
      // (cada 10 ticks, lo que da la lista desde la vez anterior: sin repetir, aunque la otra vista leyó diez veces)
      if (t % 10 === 9) {
        const probe = ring.water.changedTiles(pseq);
        pseq = probe.seq;
        expect(probe.all).toBe(false);
        expect(new Set(probe.tiles).size).toBe(probe.tiles.length);
        entries = probe.seq;
      }
    }
    expect(entries).toBeGreaterThan(1 << 16);
    lazy.frame();
    expect((lazy.water as unknown as { visited: number }).visited).toBe(ring.water.gw * ring.water.gh);
    sameView(lazy, ref, 'lista desbordada');
    sameView(view, ref, 'la que lee');
  });

  it('lo que entra queda seco y de pared hasta cargarse; la vista que se corre con la capa copia solo la franja, la que no, todo', () => {
    const w = setup(true);
    const moved = new WorldView(w.state, 0), stale = new WorldView(w.state, 0);
    moved.frame(); stale.frame();
    const gv = w.water.groundVersion, seq = w.water.changesSince(0).seq;
    w.s.shift(2, 0); moved.shift(2 * CHUNK, 0); w.water.shift(2 * CHUNK, 0);
    expect(w.water.groundVersion).toBeGreaterThan(gv);         // (la GPU vuelve a subir el fondo)
    for (let gy = 0; gy < w.water.gh; gy++) for (let gx = w.water.gw - CHUNK; gx < w.water.gw; gx++) {
      const i = w.water.sim.at(gx, gy);
      expect([gx, gy, w.water.sim.depth[i], w.water.sim.solid[i], w.water.isBasin(i)]).toEqual([gx, gy, 0, 1, false]);
    }
    // Lo que cambió: la franja que entra
    expect(w.water.changesSince(seq).box).toEqual([w.water.gw - CHUNK, 0, w.water.gw - 1, w.water.gh - 1]);
    expect(w.water.shiftCount).toBe(1);
    moved.frame(); stale.frame();
    // (la franja justa: en el giro 0 las celdas de la vista son las del mundo, sin margen)
    expect((moved.water as unknown as { visited: number }).visited).toBe(CHUNK * w.water.gh);
    expect((stale.water as unknown as { visited: number }).visited).toBe(w.water.gw * w.water.gh);
    for (const v of [moved, stale]) {
      const vw = v.water!;
      for (let gy = 0; gy < w.water.gh; gy++) for (let gx = 0; gx < w.water.gw; gx++) {
        const i = gy * w.water.gw + gx, p = w.water.sim.at(gx, gy);
        if (vw.sim.depth[i] !== w.water.sim.depth[p] || vw.sim.ground[i] !== w.water.sim.ground[p] || vw.sim.solid[i] !== w.water.sim.solid[p]) throw new Error(`${gx},${gy}`);
      }
    }
    moved.frame();
    expect((moved.water as unknown as { visited: number }).visited).toBe(0);
  });

  it('la textura del fondo (staticSince): un picado y después un corrimiento; la franja sin cargar no se sube; el registro corto, todo', () => {
    const w = setup(true);
    const view = new WorldView(w.state, 0), mirror = new Mirror(w.water.gw, w.water.gh);
    view.frame(); mirror.sync(view); mirror.same(view, 'al empezar');
    const vw = view.water as unknown as { staticSince(v: number): { v: number; all: boolean; shift: [number, number] | null; box: [number, number, number, number] | null } };
    // Un picado (cambia el fondo de una caja) y, sin poner al día el espejo, un corrimiento: la caja llega corrida
    for (let y = 40; y < 46; y++) for (let x = 60; x < 66; x++) for (let z = 3; z <= ZMAX; z++) w.s.set(x, y, z, 0);
    w.water.syncGround({ x0: 60, y0: 40, x1: 65, y1: 45 });
    view.frame();
    w.s.shift(1, 1); view.shift(CHUNK, CHUNK); w.water.shift(CHUNK, CHUNK);
    view.frame();
    const ch = vw.staticSince(mirror.v);
    expect(ch.shift).toEqual([CHUNK / CELL, CHUNK / CELL]);
    // (la franja que entra es pared seca en la vista y en la capa: no hay nada que subir de ella; solo la caja picada)
    // (lo picado: las celdas 30..32 x 20..22, corridas 8 y 8)
    expect(ch.box).toEqual([22, 12, 24, 14]);
    mirror.sync(view); mirror.same(view, 'picado y corrido');
    // Más de 64 cambios sin poner al día el espejo: el registro ya no llega, todo
    for (let k = 0; k < 70; k++) {
      const x = 4 + (k % 20) * 4, y = 4 + Math.floor(k / 20) * 4;
      w.s.set(x, y, 20, material(0, 1)); w.water.syncGround({ x0: x, y0: y, x1: x, y1: y }); view.frame();
    }
    expect(vw.staticSince(mirror.v).all).toBe(true);
    mirror.sync(view); mirror.same(view, 'registro corto');
  });

  it('sin movable, shift es un error; corrida, draw directo también (se dibuja por la vista)', () => {
    const a = setup(false);
    expect(() => a.water.shift(CHUNK, 0)).toThrow(/movable/);
    const b = setup(true);
    expect(() => b.water.shift(3, 0)).toThrow(/múltiplo/);
    b.water.shift(CHUNK, 0);
    expect(() => b.water.draw(null as never, null as never, null as never, null, 0, 0, 0, 0, [0, 0, 0], 0, [])).toThrow(/corrida/);
  });

  it('instantánea tras correr: en el orden de la rejilla, y volver a ella deja la capa igual que la referencia', () => {
    const ring = setup(true), ref = setup(false);
    for (let t = 0; t < 20; t++) for (const w of [ring, ref]) { w.water.disturb(40, 40, 2, 2); w.water.step(1 / 60); }
    for (const w of [ring, ref]) w.s.shift(1, 1);
    ring.water.shift(CHUNK, CHUNK); copyShift(ref.water, CHUNK / CELL, CHUNK / CELL);
    // (una cuenca ganada jugando: un canal desde un lago, como syncGround tras picar)
    for (const w of [ring, ref]) { for (let y = 20; y < 30; y++) for (let x = 2; x < 4; x++) for (let z = 4; z <= ZMAX; z++) w.s.set(x, y, z, 0); w.water.syncGround({ x0: 2, y0: 20, x1: 3, y1: 29 }); }
    const sa = ring.state.snapshot(), sb = ref.state.snapshot();
    const changed = ring.water.basinChanged();
    expect(sa.water).toEqual(sb.water);
    for (let t = 0; t < 20; t++) for (const w of [ring, ref]) { w.water.pour(30, 30, 1); w.water.step(1 / 60); }
    ring.state.restore(sa); ref.state.restore(sb);
    expect(ring.water.sim.origin).toEqual([0, 0]);
    expect(ring.water.basinChanged()).toBe(changed);
    same(ring, ref, 'tras volver');
    for (let t = 0; t < 20; t++) for (const w of [ring, ref]) { w.water.disturb(50, 30, 2, 2); w.water.step(1 / 60); }
    same(ring, ref, 'y después');
  });
});
