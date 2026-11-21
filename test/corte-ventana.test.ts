// La ventana del corte al componer (SectionCut.window): la forma en píxeles por la que se mira dentro de la caja.
// El criterio, escrito aquí a mano: un píxel se sustituye si la caja entera lo sustituía Y cae dentro de la forma.
// - En cada píxel de la imagen, lo que se pica (pickBlock) y lo que se pinta (frame2D) es lo de la caja entera donde se
//   sustituye y lo horneado donde no; lo único más que cambia es la costura (el contorno de un sustituido junto a uno de
//   la caja que queda horneado) y el borde que se queda junto a un sustituido.
// - Con la cruz en varios brazos, centrada en el objetivo, corrida, cortada por el borde de la imagen y fuera de la
//   caja; con otra forma (un círculo, con windowOf); en dos giros; con sectionLayer y con SectionPainter.
// - SectionPainter al mover la ventana y la caja: la capa es la de un pintor nuevo, y lo que dice que cambió (base,
//   dirty) basta para llevar al día una copia (lo que hace el compositor de la GPU con sus texturas).
// - El agua de la caja solo deja de dibujarse dentro de la ventana.
import { describe, it, expect } from 'vitest';
import { material, unkey, decode, rgbOf, innerGapFor, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, pickBlock } from '../src/world/blocks';
import { bakeWorld, type Baked } from '../src/world/bake';
import { WorldView, type Quarter } from '../src/world/view';
import { frame2D } from '../src/world/frame2d';
import { WaterLayer } from '../src/world/water';
import type { World } from '../src/world/build';
import { sectionAround, sectionLayer, sectionAt, SectionPainter, secIdx, crossWindow, windowOf, windowContains, CROSS_ARM, CROSS_RADIUS, STRIP, type SectionCut, type SectionLayer, type SectionWindow } from '../src/world/section';

const N = 8;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
] };
const cube = (ramp: number): Array<[number, number, number, number]> => {
  const out: Array<[number, number, number, number]> = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) out.push([x, y, z, material(ramp, 1 + ((x + y + z) % 2))]);
  return out;
};
const COLS = 14, ROWS = 16, LAYERS = 7;

// Tierra hasta la capa 5 con un túnel tapado este-oeste (by 7..8, capas 2..3) y una sala (bx 3..8, by 9..11, capas 2..4)
function world() {
  const set = new BlockSet('prueba', N, PAL);
  set.add('piedra', cube(0)); set.add('tierra', cube(1));
  const st = new WorldState(new StaticVoxels(PAL, COLS * N, ROWS * N, 0, LAYERS * N - 1), [], null);
  const grid = new BlockGrid(st, set);
  const air = (bx: number, by: number, bz: number) => (bz >= 2 && bz <= 3 && (by === 7 || by === 8)) || (bz >= 2 && bz <= 4 && bx >= 3 && bx <= 8 && by >= 9 && by <= 11);
  for (let bz = 0; bz <= 5; bz++) for (let by = 0; by < ROWS; by++) for (let bx = 0; bx < COLS; bx++)
    if (!air(bx, by, bz)) grid.set(bx, by, bz, bz < 2 || (bx + by) % 3 === 0 ? 1 : 2);
  return { st, grid };
}

// La cruz, a mano: dos barras de `arm` de ancho (el brazo) que llegan a `r` píxeles del centro
function inCross(sx: number, sy: number, cx: number, cy: number, r: number, arm = r): boolean {
  const dx = sx - cx, dy = sy - cy, h = arm / 2;
  return (Math.abs(dx) <= h && Math.abs(dy) <= r) || (Math.abs(dy) <= h && Math.abs(dx) <= r);
}

type Kind = 'sectionLayer' | 'SectionPainter';
function layerOf(kind: Kind, b: Baked, cut: SectionCut): SectionLayer | null {
  if (kind === 'sectionLayer') return sectionLayer(b, cut);
  const p = new SectionPainter(b, { ahead: 0, behind: 0 });
  p.set(cut, 0); p.paintAll();
  expect(p.ready()).toBe(true);
  return p.layer();
}
const maskAt = (L: SectionLayer | null, sx: number, sy: number): number => {
  if (!L || sx < L.x || sy < L.y || sx >= L.x + L.w || sy >= L.y + L.h) return 0;
  return L.mask[secIdx(L, sx, sy - L.y)]!;
};
const frameOf = (view: WorldView, b: Baked, L: SectionLayer | null) =>
  frame2D(view.frame(), b, { vx: 0, vy: 0, vw: b.width, vh: b.height, lights: false, time: 0, ambient: [1, 1, 1], sectionLayer: L });

// Comprueba la capa con ventana W contra la de la caja entera U y lo horneado, píxel a píxel. Devuelve lo que contó
function check(grid: BlockGrid, view: WorldView, b: Baked, U: SectionLayer, W: SectionLayer | null, inside: (sx: number, sy: number) => boolean) {
  const A = frameOf(view, b, null), B = frameOf(view, b, U), C = frameOf(view, b, W);
  const sub = (sx: number, sy: number) => sx >= 0 && sy >= 0 && sx < b.width && sy < b.height && inside(sx, sy) && maskAt(U, sx, sy) === 1;
  const same = (P: Uint8ClampedArray, Q: Uint8ClampedArray, i: number) => P[i * 4] === Q[i * 4] && P[i * 4 + 1] === Q[i * 4 + 1] && P[i * 4 + 2] === Q[i * 4 + 2] && P[i * 4 + 3] === Q[i * 4 + 3];
  const gap = b.options.innerGap ?? innerGapFor(b.options);
  let subs = 0, seams = 0, borders = 0, changed = 0;
  const bad: string[] = [];
  for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
    const i = sy * b.width + sx, s = sub(sx, sy);
    const near = sub(sx - 1, sy) || sub(sx + 1, sy) || sub(sx, sy - 1) || sub(sx, sy + 1);
    // Lo que se pica: lo de la caja entera donde se sustituye; lo horneado donde no
    const want = s ? pickBlock(grid, view, b, sx, sy, U) : pickBlock(grid, view, b, sx, sy), got = pickBlock(grid, view, b, sx, sy, W);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`pick ${sx},${sy}`);
    // La máscara: 1 justo donde se sustituye; 2 solo donde la caja entera tenía borde y toca a un sustituido
    const m = maskAt(W, sx, sy), wantM = s ? 1 : maskAt(U, sx, sy) === 2 && near ? 2 : 0;
    if (m !== wantM) bad.push(`máscara ${sx},${sy}: ${m} por ${wantM}`);
    if ((W ? sectionAt(W, sx, sy) >= 0 : false) !== (wantM > 0)) bad.push(`sectionAt ${sx},${sy}`);
    // Lo que se pinta
    if (s) {
      subs++;
      // La costura: junto a uno que la caja sustituía y la ventana deja horneado, si lo horneado queda más cerca que el
      // salto del contorno interior; ahí va el color del contorno (el más oscuro de la rampa de su vóxel). Si no, lo de
      // la caja entera
      const q = secIdx(U, sx, sy - U.y), d = U.depth[q]!;
      const seam = b.options.outline === 'both' && d !== Infinity && ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const).some(([dx, dy]) =>
        maskAt(U, sx + dx, sy + dy) === 1 && !inside(sx + dx, sy + dy) && b.depth[(sy + dy) * b.width + sx + dx]! < d - gap);
      if (seam) {
        const [x, y, z] = unkey(U.pick[q]!), c = rgbOf(b.source.palette.ramps[decode(b.source.get(x, y, z)).ramp]!.colors[0]!);
        if (C[i * 4] !== c[0] || C[i * 4 + 1] !== c[1] || C[i * 4 + 2] !== c[2]) bad.push(`costura ${sx},${sy}`);
        if (!same(C, B, i)) seams++;
      } else if (!same(C, B, i)) bad.push(`pintado ${sx},${sy} (sustituido)`);
    } else if (wantM === 2) { borders++; if (!same(C, B, i)) bad.push(`pintado ${sx},${sy} (borde)`); }
    else if (!same(C, A, i)) bad.push(`pintado ${sx},${sy} (horneado)`);
    if (!same(C, A, i)) changed++;
  }
  expect(bad.slice(0, 8)).toEqual([]);
  expect(W ? W.count : 0).toBe(subs);
  return { subs, seams, borders, changed };
}

describe('la ventana del corte: se pica y se pinta lo mismo, por la forma', () => {
  for (const q of [0, 1] as Quarter[]) for (const kind of ['sectionLayer', 'SectionPainter'] as Kind[]) for (const outline of (q ? ['both'] : ['both', 'none']) as Array<'both' | 'none'>) {
    it(`la cruz en varios brazos y sitios, giro ${q}, ${kind}, contorno ${outline}`, () => {
      const { st, grid } = world();
      const view = new WorldView(st, q);
      // (con contorno 'both' y cielo de cueva, como un juego: ahí hay costura)
      const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline, sky: outline === 'both' });
      // El objetivo en el túnel (celda 5, 8; pies en la capa 2) y otro pegado al borde oeste del mundo (celda 0, 8)
      const total = { subs: 0, seams: 0, borders: 0, cases: 0, empty: 0 }, edge = [0, 0, 0, 0];
      for (const [tx, ty] of [[5 * N + 4, 8 * N + 4], [4, 8 * N + 4]] as const) {
        const cut = sectionAround(view.camera, tx, ty, 2 * N, 80);
        const U = layerOf(kind, b, cut)!;
        expect(U.count).toBeGreaterThan(500);
        const [vx, vy] = view.camera.pointToView(tx, ty), [fx, fy] = b.cam.project(vx, vy, 2 * N + 8);
        const px = Math.round(fx), py = Math.round(fy);
        // Los centros: el objetivo; corrido; en los cuatro bordes de la imagen (la cruz cortada por él); y fuera de la caja
        const centres: Array<[number, number]> = [[px, py], [px + 9, py - 5], [0, py], [b.width - 1, py], [px, 0], [px, b.height - 1], [px - 400, py]];
        // y con el lado derecho de la cruz justo en el último píxel sustituido de una fila, con borde de la caja al lado
        // (ese borde queda a un píxel fuera del recuadro de la ventana, y sigue siendo borde)
        let ex = -1, ey = -1;
        for (let sy = U.y; sy < U.y + U.h && ex < 0; sy++) for (let sx = U.x; sx < U.x + U.w - 1; sx++) if (maskAt(U, sx, sy) === 1 && maskAt(U, sx + 1, sy) === 2) { ex = sx; ey = sy; break; }
        expect(ex).toBeGreaterThan(0);
        for (const arm of [3, 12, CROSS_RADIUS, 60]) for (const [ci, [cx, cy]] of [...centres, [ex - arm, ey] as [number, number]].entries()) {
          const W = layerOf(kind, b, { ...cut, window: crossWindow(cx, cy, { r: arm, arm }) });
          const r = check(grid, view, b, U, W, (sx, sy) => inCross(sx, sy, cx, cy, arm));
          total.subs += r.subs; total.seams += r.seams; total.borders += r.borders; total.cases++;
          if (ci >= 2 && ci <= 5) edge[ci - 2]! += r.subs;
          if (!W || !W.count) { total.empty++; expect(r.changed).toBe(0); }
          // (centrada en el objetivo siempre destapa algo, y menos que la caja entera)
          if (cx === px && cy === py) { expect(r.subs).toBeGreaterThan(arm); expect(r.subs).toBeLessThan(U.count); }
          if (ci === centres.length) expect(maskAt(W, ex + 1, ey)).toBe(2);
        }
        // Las barras más finas que el brazo, y el valor por defecto del brazo
        const thin = layerOf(kind, b, { ...cut, window: crossWindow(px, py, { r: 40, arm: 7 }) });
        expect(check(grid, view, b, U, thin, (sx, sy) => inCross(sx, sy, px, py, 40, 7)).subs).toBeGreaterThan(40);
        const def = layerOf(kind, b, { ...cut, window: crossWindow(px, py) });
        expect(check(grid, view, b, U, def, (sx, sy) => inCross(sx, sy, px, py, CROSS_RADIUS, CROSS_ARM)).subs).toBeGreaterThan(24);
      }
      // (hubo de todo: cruces cortadas por cada uno de los cuatro bordes de la imagen con algo dentro, costuras, bordes, y
      // ventanas sin nada)
      if (outline === 'both') expect(total.seams).toBeGreaterThan(20); else expect(total.seams).toBe(0);
      expect(total.borders).toBeGreaterThan(20);
      expect(total.empty).toBeGreaterThan(0);
      for (const n of edge) expect(n).toBeGreaterThan(500);
    });

    if (outline === 'both') it(`otra forma (un círculo), giro ${q}, ${kind}`, () => {
      const { st, grid } = world();
      const view = new WorldView(st, q);
      const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5 });
      const tx = 5 * N + 4, ty = 8 * N + 4, cut = sectionAround(view.camera, tx, ty, 2 * N, 80);
      const U = layerOf(kind, b, cut)!;
      void outline;
      const [vx, vy] = view.camera.pointToView(tx, ty), [fx, fy] = b.cam.project(vx, vy, 2 * N + 8), px = Math.round(fx), py = Math.round(fy);
      for (const r of [5, 18, 33]) {
        const disc = (sx: number, sy: number) => (sx - px) ** 2 + (sy - py) ** 2 <= r * r;
        const win = windowOf(`disco:${px},${py},${r}`, px - r, py - r, px + r, py + r, disc);
        const res = check(grid, view, b, U, layerOf(kind, b, { ...cut, window: win }), disc);
        expect(res.subs).toBeGreaterThan(r * r);
      }
    });
  }

  it('con Frame2DOptions.section: el cuadro cambia con la ventana y es el de la capa', () => {
    const { st } = world();
    const view = new WorldView(st, 0);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline: 'both', sky: true });
    const cut = sectionAround(view.camera, 5 * N + 4, 8 * N + 4, 2 * N, 80), [fx, fy] = b.cam.project(5 * N + 4, 8 * N + 4, 2 * N + 8);
    const o = { vx: 0, vy: 0, vw: b.width, vh: b.height, lights: false, time: 0, ambient: [1, 1, 1] as [number, number, number] };
    const frames: Uint8ClampedArray[] = [];
    for (const win of [crossWindow(fx, fy, { r: 10, arm: 10 }), crossWindow(fx + 7, fy, { r: 10, arm: 10 }), crossWindow(fx, fy, { r: 20, arm: 20 }), null]) {
      const c = { ...cut, window: win }, f = frame2D(view.frame(), b, { ...o, section: c });
      expect(Buffer.compare(Buffer.from(f.buffer), Buffer.from(frameOf(view, b, sectionLayer(b, c)).buffer))).toBe(0);
      for (const g of frames) expect(Buffer.compare(Buffer.from(f.buffer), Buffer.from(g.buffer))).not.toBe(0);
      frames.push(f);
    }
  });

  it('crossWindow, windowOf y windowContains dicen lo mismo que la forma a mano', () => {
    expect([CROSS_ARM, CROSS_RADIUS]).toEqual([24, 40]);
    for (const [r, arm] of [[1, 1], [3, 3], [12, 12], [40, 24], [24, 7], [24, 8], [40, 2], [10, 999]] as const) {
      const w = crossWindow(40.4, 30.6, { r, arm });
      expect([w.x0, w.y0, w.x1, w.y1]).toEqual([40 - r, 31 - r, 40 + r, 31 + r]);
      // (un brazo más ancho que la cruz es un cuadrado: no pasa de r)
      for (let sy = 31 - r - 2; sy <= 31 + r + 2; sy++) for (let sx = 40 - r - 2; sx <= 40 + r + 2; sx++)
        expect([sx, sy, windowContains(w, sx, sy)]).toEqual([sx, sy, inCross(sx, sy, 40, 31, r, Math.min(arm, 2 * r))]);
      // (y los tramos, sin salirse de su recuadro: ninguno fuera de sus filas ni de sus columnas)
      for (let sy = 31 - r - 3; sy <= 31 + r + 3; sy++) {
        const sp: number[] = [];
        w.spans(sy, sp);
        if (sy < w.y0 || sy > w.y1) expect([sy, sp]).toEqual([sy, []]);
        else expect([sy, sp.length, sp[0]! >= w.x0, sp[1]! <= w.x1]).toEqual([sy, 2, true, true]);
      }
    }
    expect(crossWindow(10, 10).key).toBe(crossWindow(10, 10, { arm: CROSS_ARM, r: CROSS_RADIUS }).key);
    expect(crossWindow(10, 10).key).not.toBe(crossWindow(10, 10, { r: 20, arm: 20 }).key);
    expect(crossWindow(10, 10).key).not.toBe(crossWindow(10, 10, { r: 39 }).key);
    // (un brazo más ancho que la cruz es el mismo cuadrado: la misma clave)
    expect(crossWindow(10, 10, { r: 10, arm: 999 }).key).toBe(crossWindow(10, 10, { r: 10, arm: 20 }).key);
    expect(crossWindow(10, 10).key).not.toBe(crossWindow(11, 10).key);
    // Una forma con huecos en la fila: tramos sueltos
    const comb = windowOf('peine', 0, 0, 20, 3, (sx) => sx % 4 < 2);
    const out: number[] = [];
    comb.spans(1, out);
    expect(out).toEqual([0, 1, 4, 5, 8, 9, 12, 13, 16, 17, 20, 20]);
    comb.spans(9, out);
    expect(out.length).toBe(12);
  });
});

describe('la ventana del corte con SectionPainter: al moverse', () => {
  it('la capa es la de un pintor nuevo, y base + dirty bastan para llevar una copia al día', () => {
    const { st } = world();
    const view = new WorldView(st, 0);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline: 'both', sky: true });
    const p = new SectionPainter(b, { ahead: 1, behind: 1 });
    // La copia (como las texturas del compositor: por columna de la imagen, en anillo, y por fila de la capa)
    const TW = 256;
    let mirror: { y: number; h: number; mask: Uint8Array; rgba: Uint8Array } | null = null, seen: SectionLayer | null = null;
    let fulls = 0, parts = 0, px = 0;
    const sync = (L: SectionLayer | null) => {
      if (L === seen) return;
      const up = seen; seen = L;
      if (!L) return;
      let full = !(L.base && up && L.base === up && L.dirty && mirror && L.y === mirror.y && L.h === mirror.h);
      if (!mirror || L.h > mirror.h) { mirror = { y: L.y, h: L.h, mask: new Uint8Array(TW * L.h), rgba: new Uint8Array(TW * L.h * 4) }; full = true; }
      mirror.y = L.y;
      if (full) fulls++; else parts++;
      const rects: ReadonlyArray<readonly [number, number, number?, number?]> = full ? [[L.x, L.x + L.w - 1]] : L.dirty!;
      for (const [g0, g1, r0, r1] of rects) for (let gx = Math.max(L.x, g0); gx <= Math.min(L.x + L.w - 1, g1); gx++) for (let j = Math.max(0, r0 ?? 0); j <= Math.min(L.h - 1, r1 ?? L.h - 1); j++) {
        const q = secIdx(L, gx, j), t = j * TW + (gx % TW);
        mirror.mask[t] = L.mask[q]!; px++;
        for (let c = 0; c < 4; c++) mirror.rgba[t * 4 + c] = L.mask[q] ? L.rgba[q * 4 + c]! : 0;
      }
    };
    const fresh = (cut: SectionCut) => { const f = new SectionPainter(b, { ahead: 0, behind: 0 }); f.set(cut, 0); f.paintAll(); return f.layer(); };
    const compare = (L: SectionLayer | null, R: SectionLayer | null, step: string) => {
      expect([step, !!L]).toEqual([step, !!R]);
      if (!L || !R) return;
      expect([step, L.x, L.y, L.w, L.h, L.count]).toEqual([step, R.x, R.y, R.w, R.h, R.count]);
      let bad = 0;
      for (let j = 0; j < L.h; j++) for (let gx = L.x; gx < L.x + L.w; gx++) {
        const q = secIdx(L, gx, j), r = secIdx(R, gx, j), t = j * TW + (gx % TW);
        if (L.mask[q] !== R.mask[r] || mirror!.mask[t] !== R.mask[r]) { bad++; continue; }
        if (!R.mask[r]) continue;
        for (let c = 0; c < 4; c++) if (L.rgba[q * 4 + c] !== R.rgba[r * 4 + c] || mirror!.rgba[t * 4 + c] !== R.rgba[r * 4 + c]) { bad++; break; }
        if (L.pick[q] !== R.pick[r] && !(Number.isNaN(L.pick[q]!) && Number.isNaN(R.pick[r]!))) bad++;
      }
      expect([step, bad]).toEqual([step, 0]);
    };
    const ty = 8 * N + 4;
    let step = 0;
    const go = (tx: number, win: SectionWindow | null, depth?: number) => {
      const cut: SectionCut = { ...sectionAround(view.camera, tx, ty, 2 * N, 64, depth), window: win };
      p.set(cut, 1); p.paintAll();
      const L = p.layer();
      sync(L);
      compare(L, fresh(cut), `paso ${step++} (x ${tx}${win ? ', ' + win.key : ''})`);
      // (sin cambios, la misma capa)
      expect(p.layer()).toBe(L);
    };
    const centre = (tx: number): [number, number] => { const [fx, fy] = b.cam.project(tx, ty, 2 * N + 8); return [Math.round(fx), Math.round(fy)]; };
    // Anda hacia el este con la cruz en el objetivo: la ventana se mueve en cada paso y la caja, cada STRIP
    for (let tx = 4 * N; tx <= 4 * N + 3 * STRIP; tx += 1) go(tx, crossWindow(...centre(tx), { r: 14, arm: 14 }));
    const partsWalking = parts, pxWalking = px;
    // La ventana sube y baja sin moverse la caja; cambia de brazo; se va fuera de la caja y vuelve
    const [cx, cy] = centre(4 * N + 3 * STRIP);
    for (const dy of [-1, -2, -9, 0, 6]) go(4 * N + 3 * STRIP, crossWindow(cx, cy + dy, { r: 14, arm: 14 }));
    for (const arm of [3, 30, 60, 14]) go(4 * N + 3 * STRIP, crossWindow(cx, cy, { r: arm, arm }));
    go(4 * N + 3 * STRIP, crossWindow(cx - 300, cy, { r: 14, arm: 14 }));
    go(4 * N + 3 * STRIP, crossWindow(cx, cy, { r: 14, arm: 14 }));
    // Sin ventana (la caja entera) y otra vez con ella
    go(4 * N + 3 * STRIP, null);
    go(4 * N + 3 * STRIP + 1, null);
    go(4 * N + 3 * STRIP + 2, crossWindow(cx + 2, cy, { r: 14, arm: 14 }));
    // La ventana quieta en la imagen mientras la caja avanza por debajo (cambia lo compuesto y no la ventana), a
    // caballo del lado de la caja (ahí hay borde y costura de la caja, a un píxel de la ventana)
    const ox = b.options.originX ?? 0, edge = ox + Math.floor((4 * N + 3 * STRIP - 32) / STRIP) * STRIP, still = crossWindow(edge + 3, cy, { r: 9, arm: 9 });
    for (const k of [0, 1, 2, 1, 0]) go(4 * N + 3 * STRIP + k * STRIP, still);
    go(4 * N + 3 * STRIP, crossWindow(edge + 30, cy - 20, { r: 9, arm: 9 }));
    // Lo pintado se tira (cambia lo que se mira detrás) con la ventana en otro sitio: lo de antes no puede quedarse
    go(4 * N + 3 * STRIP, crossWindow(cx + 3, cy + 3, { r: 14, arm: 14 }));
    go(4 * N + 3 * STRIP, crossWindow(cx - 20, cy - 12, { r: 5, arm: 5 }), 40);
    go(4 * N + 3 * STRIP, crossWindow(cx + 12, cy + 9, { r: 5, arm: 5 }), 40);
    // Y de vuelta al oeste
    for (let tx = 4 * N + 3 * STRIP; tx >= 4 * N + STRIP; tx -= 3) go(tx, crossWindow(...centre(tx), { r: 14, arm: 14 }));
    // Andando, casi todo fue por partes, y cada paso subió poco más que el recuadro de la cruz (no la capa entera)
    expect(partsWalking).toBeGreaterThan(3 * STRIP - 4);
    expect(pxWalking / (3 * STRIP + 1)).toBeLessThan(4000);
    expect(fulls).toBeLessThan(10);
  });
});

describe('la ventana del corte y el agua', () => {
  it('el agua de la caja solo deja de dibujarse dentro de la ventana', () => {
    // Tierra hasta z 7 con un lago en medio (fondo a z 3, agua hasta z 7); el objetivo, de pie en el fondo del lago
    const W = 64, D = 64;
    const model = new StaticVoxels(PAL, W, D, 0, 23);
    const wet = new Uint8Array(W * D), waterTop = new Int16Array(W * D);
    for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
      const lake = x >= 14 && x <= 49 && y >= 14 && y <= 49;
      for (let z = 0; z < (lake ? 4 : 8); z++) model.set(x, y, z, material(lake ? 0 : 1, 1 + ((x + y) & 1)));
      if (lake) { wet[y * W + x] = 1; waterTop[y * W + x] = 7; }
    }
    const w = { model, lights: [], width: W, depth: D, wet, waterTop, fountain: null } as unknown as World;
    const water = new WaterLayer(w, { wallAbove: Infinity });
    const state = new WorldState(model, [], water), dry = new WorldState(model, [], null);
    const b = bakeWorld(w, { topZ: 24, incline: 0.5, outline: 'both' });
    const cut: SectionCut = { x0: 8, x1: 55, y0: 0, y1: 40, zMin: 4 };
    const [fx, fy] = b.cam.project(32, 40, 8), cx = Math.round(fx), cy = Math.round(fy);
    for (const arm of [3, 6, 12]) {
      const win = crossWindow(cx, cy, { r: arm, arm });
      for (const kind of ['sectionLayer', 'SectionPainter'] as Kind[]) {
      const U = sectionLayer(b, cut)!, L = layerOf(kind, b, { ...cut, window: win })!;
      expect([kind, arm, !!L]).toEqual([kind, arm, true]);
      // Dónde se dibuja agua: donde el cuadro con agua no es el cuadro sin ella (sin reflejos: cada píxel va por su cuenta)
      const wet2 = (sec: SectionLayer | null) => {
        const o = { vx: 0, vy: 0, vw: b.width, vh: b.height, lights: false, time: 0, ambient: [1, 1, 1] as [number, number, number], detail: 'bajo' as const, sectionLayer: sec };
        const f = frame2D(state, b, o), g = frame2D(dry, b, o), out = new Uint8Array(b.width * b.height);
        for (let i = 0; i < out.length; i++) out[i] = f[i * 4] !== g[i * 4] || f[i * 4 + 1] !== g[i * 4 + 1] || f[i * 4 + 2] !== g[i * 4 + 2] ? 1 : 0;
        return out;
      };
      const none = wet2(null), box = wet2(U), shaped = wet2(L);
      let bad = 0, hidden = 0, back = 0;
      for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
        const i = sy * b.width + sx, inside = inCross(sx, sy, cx, cy, arm);
        // Dentro de la ventana, como con la caja entera; fuera, como sin corte
        if (shaped[i] !== (inside ? box[i] : none[i])) bad++;
        if (inside && none[i] && !shaped[i]) hidden++;
        if (!inside && !box[i] && shaped[i]) back++;
      }
      expect([arm, bad]).toEqual([arm, 0]);
      expect(hidden).toBeGreaterThan(arm * 4);
      expect(back).toBeGreaterThan(50);
      }
    }
  });
});
