// El borde dibujado de la ventana del corte (section.ts: withBorder). El criterio, escrito aquí a mano: es borde el píxel
// de dentro de la forma que tiene alguno de fuera a `width` píxeles o menos en cualquiera de las ocho direcciones.
// - windowBorderSpans / windowBorderAt dicen eso, con la cruz, un círculo y una forma con huecos, y varios grosores;
// - apagado por defecto: sin borde, la ventana y el cuadro son los de siempre; el borde cambia la clave de la ventana;
// - el cuadro (frame2D): con borde es el de sin borde salvo en los píxeles de borde que caen en el recuadro de la capa,
//   que llevan su color tal cual, también con luz, niebla, fondo transparente y una entidad debajo; con sectionLayer,
//   con SectionPainter y con Frame2DOptions.section; con la cruz cortada por los lados de la imagen y fuera de la caja;
// - no toca lo que se pica ni la máscara: son los de la misma ventana sin borde, y lo sustituido queda dentro de la forma;
// - con SectionPainter al moverse: lo que la capa dice que cambió (base, dirty) basta para llevar al día una copia del
//   bit de borde hecha como la del compositor de la GPU (al subir cada recuadro).
import { describe, it, expect } from 'vitest';
import { material, Model, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, pickBlock } from '../src/world/blocks';
import { bakeWorld, type Baked } from '../src/world/bake';
import { WorldView, type Quarter } from '../src/world/view';
import { frame2D, type Frame2DOptions } from '../src/world/frame2d';
import { sectionAround, sectionLayer, SectionPainter, secIdx, crossWindow, windowOf, windowContains, withBorder, windowBorderSpans, windowBorderAt, sectionBorderAt, STRIP,
  type SectionCut, type SectionLayer, type SectionWindow } from '../src/world/section';

const N = 8;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30'] },
  { name: 'cuerpo', colors: ['#a02020', '#d04040', '#f08080'] },
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

// El borde, a mano
const edgeOf = (inside: (sx: number, sy: number) => boolean, width: number) => (sx: number, sy: number): boolean => {
  if (!inside(sx, sy)) return false;
  for (let dy = -width; dy <= width; dy++) for (let dx = -width; dx <= width; dx++) if (!inside(sx + dx, sy + dy)) return true;
  return false;
};
const inCross = (cx: number, cy: number, r: number, arm: number) => (sx: number, sy: number): boolean => {
  const dx = Math.abs(sx - cx), dy = Math.abs(sy - cy), h = Math.floor(Math.min(arm, 2 * r) / 2);
  return (dx <= h && dy <= r) || (dy <= h && dx <= r);
};

type Kind = 'sectionLayer' | 'SectionPainter';
function layerOf(kind: Kind, b: Baked, cut: SectionCut): SectionLayer | null {
  if (kind === 'sectionLayer') return sectionLayer(b, cut);
  const p = new SectionPainter(b, { ahead: 0, behind: 0 });
  p.set(cut, 0); p.paintAll();
  expect(p.ready()).toBe(true);
  return p.layer();
}
const COLOR = '#ff00fe', RGB = [255, 0, 254];

describe('el borde de la ventana del corte: qué píxeles son', () => {
  it('windowBorderSpans y windowBorderAt dicen lo mismo que el criterio a mano', () => {
    const shapes: Array<[string, SectionWindow, (sx: number, sy: number) => boolean]> = [];
    for (const [r, arm] of [[1, 1], [3, 3], [12, 12], [40, 24], [24, 7], [24, 8], [40, 2], [10, 999], [9, 0]] as const)
      shapes.push([`cruz ${r} ${arm}`, crossWindow(40, 31, { r, arm }), inCross(40, 31, r, arm)]);
    const disc = (sx: number, sy: number) => (sx - 40) ** 2 + (sy - 31) ** 2 <= 17 * 17;
    shapes.push(['disco', windowOf('disco', 23, 14, 57, 48, disc), disc]);
    // (una forma con huecos y trozos sueltos: tramos de 5 cada 8 columnas, y las filas 20..22 enteras quitadas)
    const comb = (sx: number, sy: number) => sx >= 10 && sx <= 70 && sy >= 10 && sy <= 50 && (sx % 8 < 5 || sy % 13 === 0) && !(sy >= 20 && sy <= 22);
    shapes.push(['peine', windowOf('peine', 10, 10, 70, 50, comb), comb]);
    let borders = 0, inner = 0;
    for (const [name, base, inside] of shapes) for (const width of [1, 2, 3, 5]) {
      const w = withBorder(base, { color: COLOR, width }), edge = edgeOf(inside, width);
      expect(w.border).toEqual({ color: COLOR, width });
      expect([w.x0, w.y0, w.x1, w.y1]).toEqual([base.x0, base.y0, base.x1, base.y1]);
      const bad: string[] = [];
      for (let sy = w.y0 - 3; sy <= w.y1 + 3; sy++) {
        // (la forma es la misma)
        const a: number[] = [], c: number[] = [];
        base.spans(sy, a); w.spans(sy, c);
        expect(c).toEqual(a);
        // Los tramos del borde: en orden, sin tocarse, dentro de la forma
        const sp: number[] = [];
        windowBorderSpans(w, sy, sp);
        for (let k = 0; k < sp.length; k += 2) if (sp[k]! > sp[k + 1]! || (k && sp[k]! <= sp[k - 1]! + 1)) bad.push(`tramos ${sy}: ${sp.join(' ')}`);
        for (let sx = w.x0 - 3; sx <= w.x1 + 3; sx++) {
          let got = false;
          for (let k = 0; k < sp.length; k += 2) if (sx >= sp[k]! && sx <= sp[k + 1]!) got = true;
          const want = edge(sx, sy);
          if (got !== want || windowBorderAt(w, sx, sy) !== want) bad.push(`${sx},${sy}: ${got} por ${want}`);
          if (want) borders++; else if (inside(sx, sy)) inner++;
          expect(windowContains(w, sx, sy)).toBe(inside(sx, sy));
        }
      }
      expect([name, width, bad.slice(0, 6)]).toEqual([name, width, []]);
    }
    expect(borders).toBeGreaterThan(5000);
    expect(inner).toBeGreaterThan(5000);
    // Una ventana hecha a mano que da tramos también fuera de sus filas (su recuadro manda: fuera no hay nada dentro)
    const sloppy: SectionWindow = { key: 'floja', x0: 5, y0: 5, x1: 14, y1: 9, spans: (_sy, out) => { out.push(5, 14); } };
    const box = (sx: number, sy: number) => sx >= 5 && sx <= 14 && sy >= 5 && sy <= 9;
    for (const width of [1, 2]) {
      const w = withBorder(sloppy, { color: COLOR, width }), edge = edgeOf(box, width);
      for (let sy = 2; sy <= 12; sy++) for (let sx = 2; sx <= 17; sx++) expect([width, sx, sy, windowBorderAt(w, sx, sy)]).toEqual([width, sx, sy, edge(sx, sy)]);
    }
  });

  it('apagado por defecto, y el borde va en la clave de la ventana', () => {
    const plain = crossWindow(10, 10);
    expect(plain.border ?? null).toBe(null);
    const sp: number[] = [];
    for (let sy = plain.y0; sy <= plain.y1; sy++) windowBorderSpans(plain, sy, sp);
    expect(sp).toEqual([]);
    expect(windowBorderAt(plain, plain.x0 + 40, plain.y0)).toBe(false);
    expect(withBorder(plain, null)).toBe(plain);
    expect(withBorder(plain, undefined)).toBe(plain);
    expect(crossWindow(10, 10, { border: null }).key).toBe(plain.key);
    // Por defecto, de un píxel; el grosor se redondea y no baja de uno
    const one = crossWindow(10, 10, { border: { color: COLOR } });
    expect(one.border).toEqual({ color: COLOR, width: 1 });
    expect(crossWindow(10, 10, { border: { color: COLOR, width: 0 } }).border!.width).toBe(1);
    expect(crossWindow(10, 10, { border: { color: COLOR, width: 2.4 } }).border!.width).toBe(2);
    expect(windowBorderAt(one, one.x0 + 40, one.y0)).toBe(true);
    expect(windowBorderAt(one, one.x0 + 40, one.y0 + 1)).toBe(false);
    // La clave: otra con borde, con otro grosor o con otro color; la misma con lo mismo
    const keys = [plain.key, one.key, crossWindow(10, 10, { border: { color: COLOR, width: 2 } }).key, crossWindow(10, 10, { border: { color: '#000000' } }).key];
    expect(new Set(keys).size).toBe(4);
    expect(crossWindow(10, 10, { border: { color: COLOR, width: 1 } }).key).toBe(one.key);
    expect(withBorder(plain, { color: COLOR }).key).toBe(one.key);
    // Cambiar el borde de una que ya lo lleva: como ponérselo a la de sin borde
    const again = withBorder(withBorder(plain, { color: '#102030', width: 4 }), { color: COLOR, width: 1 });
    expect([again.key, again.border]).toEqual([one.key, one.border]);
    // windowOf con borde
    const w = windowOf('caja', 0, 0, 9, 9, () => true, { color: COLOR, width: 2 });
    expect(w.border).toEqual({ color: COLOR, width: 2 });
    expect(w.key).not.toBe(windowOf('caja', 0, 0, 9, 9, () => true).key);
    expect([windowBorderAt(w, 1, 5), windowBorderAt(w, 2, 5), windowBorderAt(w, 8, 8), windowBorderAt(w, 7, 7), windowBorderAt(w, 10, 5)]).toEqual([true, false, true, false, false]);
  });
});

describe('el borde de la ventana del corte: lo que se pinta y lo que se pica', () => {
  const O = (b: Baked, more: Partial<Frame2DOptions> = {}): Frame2DOptions => ({ vx: 0, vy: 0, vw: b.width, vh: b.height, lights: false, time: 0, ambient: [1, 1, 1], ...more });

  for (const q of [0, 1] as Quarter[]) for (const kind of ['sectionLayer', 'SectionPainter'] as Kind[]) it(`el cuadro solo cambia en los píxeles de borde de dentro de la capa, giro ${q}, ${kind}`, () => {
    const { st, grid } = world();
    const view = new WorldView(st, q);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline: 'both', sky: true });
    const tx = 5 * N + 4, ty = 8 * N + 4, cut = sectionAround(view.camera, tx, ty, 2 * N, 80);
    const [vx, vy] = view.camera.pointToView(tx, ty), [fx, fy] = b.cam.project(vx, vy, 2 * N + 8), px = Math.round(fx), py = Math.round(fy);
    const U = layerOf(kind, b, cut)!;
    // Los centros: el objetivo; en los cuatro lados de la imagen; a caballo de cada lado del recuadro de la capa (ahí el
    // trazo se corta); y fuera de la caja (sin capa)
    const centres: Array<[number, number]> = [[px, py], [0, py], [b.width - 1, py], [px, 0], [px, b.height - 1], [U.x, py], [U.x + U.w - 1, py], [px, U.y], [px, U.y + U.h - 1], [px - 400, py]];
    let drawn = 0, clipped = 0, covered = 0, cases = 0, none = 0;
    for (const [cx, cy] of centres) for (const [r, arm, width] of [[14, 9, 1], [40, 24, 1], [40, 24, 3], [12, 12, 2]] as const) {
      const plain = crossWindow(cx, cy, { r, arm }), win = withBorder(plain, { color: COLOR, width });
      const P = layerOf(kind, b, { ...cut, window: plain }), W = layerOf(kind, b, { ...cut, window: win });
      cases++;
      // La capa es la misma: su recuadro, lo que sustituye y su máscara
      expect(!!W).toBe(!!P);
      if (!W || !P) { none++; expect(Buffer.compare(Buffer.from(frame2D(view.frame(), b, O(b, { sectionLayer: W })).buffer), Buffer.from(frame2D(view.frame(), b, O(b)).buffer))).toBe(0); continue; }
      expect([W.x, W.y, W.w, W.h, W.count]).toEqual([P.x, P.y, P.w, P.h, P.count]);
      const F = frame2D(view.frame(), b, O(b, { sectionLayer: P })), G = frame2D(view.frame(), b, O(b, { sectionLayer: W }));
      const inside = inCross(cx, cy, r, arm), edge = edgeOf(inside, width);
      const bad: string[] = [];
      for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
        const i = (sy * b.width + sx) * 4, inL = sx >= W.x && sy >= W.y && sx < W.x + W.w && sy < W.y + W.h;
        const want = inL && edge(sx, sy);
        if (sectionBorderAt(W, sx, sy) !== want || sectionBorderAt(P, sx, sy)) bad.push(`sectionBorderAt ${sx},${sy}`);
        if (want) {
          drawn++;
          if (G[i] !== RGB[0] || G[i + 1] !== RGB[1] || G[i + 2] !== RGB[2] || G[i + 3] !== 255) bad.push(`borde ${sx},${sy}`);
        } else {
          if (edge(sx, sy)) clipped++;
          if (G[i] !== F[i] || G[i + 1] !== F[i + 1] || G[i + 2] !== F[i + 2] || G[i + 3] !== F[i + 3]) bad.push(`pintado ${sx},${sy}`);
        }
        // La máscara y lo que se pica, los de sin borde; y lo sustituido, dentro de la forma
        const m = inL ? W.mask[secIdx(W, sx, sy - W.y)]! : 0, pm = inL ? P.mask[secIdx(P, sx, sy - P.y)]! : 0;
        if (m !== pm) bad.push(`máscara ${sx},${sy}`);
        if (m === 1 && !inside(sx, sy)) bad.push(`sustituido fuera ${sx},${sy}`);
        if (want && m === 1) covered++;
        if (want || m) { if (JSON.stringify(pickBlock(grid, view, b, sx, sy, W)) !== JSON.stringify(pickBlock(grid, view, b, sx, sy, P))) bad.push(`pick ${sx},${sy}`); }
      }
      expect([cx, cy, r, width, bad.slice(0, 6)]).toEqual([cx, cy, r, width, []]);
    }
    // (hubo de todo: trazos enteros, cortados por el recuadro de la capa, sobre píxeles sustituidos, y ventanas sin capa)
    expect(drawn).toBeGreaterThan(3000);
    expect(clipped).toBeGreaterThan(300);
    expect(covered).toBeGreaterThan(300);
    expect([cases, none > 0, none < cases / 2]).toEqual([centres.length * 4, true, true]);
  });

  it('encima de todo: con luz, niebla, fondo transparente y una entidad debajo, el color tal cual', () => {
    const { st } = world();
    const view = new WorldView(st, 0);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline: 'both', sky: true });
    const tx = 5 * N + 4, ty = 8 * N + 4, cut = sectionAround(view.camera, tx, ty, 2 * N, 80);
    const [fx, fy] = b.cam.project(tx, ty, 2 * N + 8), px = Math.round(fx), py = Math.round(fy);
    // Una entidad de pie en el túnel, a un lado: la barra horizontal de la cruz le pasa por encima
    const body = new Model(PAL, 'cuerpo');
    for (let z = 0; z < 14; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) body.set(x, y, z, material(2, 1));
    st.entities.add({ model: body, x: tx + 18, y: ty, z: 2 * N, facing: 0, castsShadow: false });
    st.lights.push({ id: 'luz', kind: 'torch', x: tx, y: ty, z: 2 * N + 6, baked: false });
    const win = crossWindow(px, py, { r: 30, arm: 10, border: { color: COLOR, width: 2 } }), plain = crossWindow(px, py, { r: 30, arm: 10 });
    const edge = edgeOf(inCross(px, py, 30, 10), 2);
    const W = sectionLayer(b, { ...cut, window: win })!, P = sectionLayer(b, { ...cut, window: plain })!;
    const fog = { focusZ: 5 * N, start: 4, full: 30, color: [40, 60, 90] as const, strength: 0.8 };
    for (const more of [{ lights: true, ambient: [0.3, 0.3, 0.4] as [number, number, number] }, { fog }, { background: 'transparent' as const }, { lights: true, ambient: [0.2, 0.2, 0.2] as [number, number, number], fog, background: 'transparent' as const }]) {
      const F = frame2D(view.frame(), b, O(b, { ...more, sectionLayer: P })), G = frame2D(view.frame(), b, O(b, { ...more, sectionLayer: W }));
      // (la entidad se pinta: el cuadro con ella no es el de sin ella en los píxeles del trazo)
      const { st: bare } = world(), H = frame2D(new WorldView(bare, 0).frame(), b, O(b, { ...more, sectionLayer: P }));
      let bad = 0, n = 0, overBody = 0, changed = 0;
      for (let sy = 0; sy < b.height; sy++) for (let sx = 0; sx < b.width; sx++) {
        const i = (sy * b.width + sx) * 4, e = edge(sx, sy);
        if (e) { n++; if (G[i] !== RGB[0] || G[i + 1] !== RGB[1] || G[i + 2] !== RGB[2] || G[i + 3] !== 255) bad++; if (F[i] !== H[i] || F[i + 1] !== H[i + 1] || F[i + 2] !== H[i + 2]) overBody++; }
        else if (G[i] !== F[i] || G[i + 1] !== F[i + 1] || G[i + 2] !== F[i + 2] || G[i + 3] !== F[i + 3]) bad++;
        if (e && (F[i] !== RGB[0] || F[i + 1] !== RGB[1] || F[i + 2] !== RGB[2])) changed++;
      }
      expect([Object.keys(more).join('+'), bad, changed]).toEqual([Object.keys(more).join('+'), 0, n]);
      expect(n).toBeGreaterThan(300);
      expect(overBody).toBeGreaterThan(3);
    }
  });

  it('con Frame2DOptions.section: el cuadro es el de la capa, y cambia con el borde, su grosor y su color', () => {
    const { st } = world();
    const view = new WorldView(st, 0);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline: 'both', sky: true });
    const cut = sectionAround(view.camera, 5 * N + 4, 8 * N + 4, 2 * N, 80), [fx, fy] = b.cam.project(5 * N + 4, 8 * N + 4, 2 * N + 8);
    const frames: Uint8ClampedArray[] = [];
    for (const border of [null, { color: COLOR }, { color: COLOR, width: 2 }, { color: '#00ff00' }]) {
      const c = { ...cut, window: crossWindow(fx, fy, { r: 20, arm: 12, border }) }, f = frame2D(view.frame(), b, O(b, { section: c }));
      expect(Buffer.compare(Buffer.from(f.buffer), Buffer.from(frame2D(view.frame(), b, O(b, { sectionLayer: sectionLayer(b, c) })).buffer))).toBe(0);
      for (const g of frames) expect(Buffer.compare(Buffer.from(f.buffer), Buffer.from(g.buffer))).not.toBe(0);
      frames.push(f);
    }
    // Una vista más pequeña que la imagen y corrida: el trazo, en su sitio (el cuadro es el recorte del entero)
    const c = { ...cut, window: crossWindow(fx, fy, { r: 20, arm: 12, border: { color: COLOR, width: 2 } }) };
    const full = frame2D(view.frame(), b, O(b, { section: c })), vx = Math.round(fx) - 11, vy = Math.round(fy) - 25, vw = 30, vh = 33;
    const part = frame2D(view.frame(), b, O(b, { section: c, vx, vy, vw, vh }));
    let bad = 0, n = 0;
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) for (let k = 0; k < 4; k++) {
      if (part[(y * vw + x) * 4 + k] !== full[((vy + y) * b.width + vx + x) * 4 + k]) bad++;
      if (k === 2 && part[(y * vw + x) * 4] === RGB[0] && part[(y * vw + x) * 4 + 1] === RGB[1] && part[(y * vw + x) * 4 + 2] === RGB[2]) n++;
    }
    expect([bad, n > 60]).toEqual([0, true]);
  });
});

describe('el borde de la ventana del corte con SectionPainter: al moverse', () => {
  it('base + dirty bastan para llevar al día una copia del bit de borde', () => {
    const { st } = world();
    const view = new WorldView(st, 0);
    const b = bakeWorld(view.bakeable(), { topZ: LAYERS * N, incline: 0.5, outline: 'both', sky: true });
    const p = new SectionPainter(b, { ahead: 1, behind: 1 });
    // La copia, como la textura del compositor: por columna de la imagen en anillo y por fila de la capa; el bit se
    // calcula al escribir cada recuadro, con la ventana de la capa que se sube. Lo que nadie ha escrito es basura
    const TW = 256;
    let mirror: { y: number; h: number; bit: Uint8Array } | null = null, seen: SectionLayer | null = null;
    let fulls = 0, parts = 0;
    const sync = (L: SectionLayer | null) => {
      if (L === seen) return;
      const up = seen; seen = L;
      if (!L) return;
      let full = !(L.base && up && L.base === up && L.dirty && mirror && L.y === mirror.y && L.h === mirror.h);
      if (!mirror || L.h > mirror.h) { mirror = { y: L.y, h: L.h, bit: new Uint8Array(TW * L.h).fill(7) }; full = true; }
      mirror.y = L.y;
      if (full) fulls++; else parts++;
      const rects: ReadonlyArray<readonly [number, number, number?, number?]> = full ? [[L.x, L.x + L.w - 1]] : L.dirty!;
      for (const [g0, g1, r0, r1] of rects) for (let j = Math.max(0, r0 ?? 0); j <= Math.min(L.h - 1, r1 ?? L.h - 1); j++) {
        const sp: number[] = [];
        if (L.window) windowBorderSpans(L.window, L.y + j, sp);
        for (let gx = Math.max(L.x, g0); gx <= Math.min(L.x + L.w - 1, g1); gx++) {
          let on = 0;
          for (let k = 0; k < sp.length; k += 2) if (gx >= sp[k]! && gx <= sp[k + 1]!) on = 1;
          mirror.bit[j * TW + (gx % TW)] = on;
        }
      }
    };
    const ty = 8 * N + 4;
    let step = 0, borders = 0;
    const go = (tx: number, win: SectionWindow | null) => {
      const cut: SectionCut = { ...sectionAround(view.camera, tx, ty, 2 * N, 64), window: win };
      p.set(cut, 1); p.paintAll();
      const L = p.layer();
      sync(L);
      let bad = 0;
      if (L) for (let j = 0; j < L.h; j++) for (let gx = L.x; gx < L.x + L.w; gx++) {
        const want = sectionBorderAt(L, gx, L.y + j) ? 1 : 0;
        if (mirror!.bit[j * TW + (gx % TW)] !== want) bad++;
        borders += want;
      }
      expect([`paso ${step++} (x ${tx}${win ? ', ' + win.key : ''})`, bad]).toEqual([`paso ${step - 1} (x ${tx}${win ? ', ' + win.key : ''})`, 0]);
      expect(p.layer()).toBe(L);
    };
    const centre = (tx: number): [number, number] => { const [fx, fy] = b.cam.project(tx, ty, 2 * N + 8); return [Math.round(fx), Math.round(fy)]; };
    const B = { color: COLOR, width: 1 };
    // Anda hacia el este con la cruz con borde en el objetivo
    for (let tx = 4 * N; tx <= 4 * N + 3 * STRIP; tx += 1) go(tx, crossWindow(...centre(tx), { r: 14, arm: 10, border: B }));
    const partsWalking = parts;
    const X = 4 * N + 3 * STRIP, [cx, cy] = centre(X);
    // Sin moverse: otro grosor, otro color, sin borde, con él otra vez, sin ventana, con ella
    go(X, crossWindow(cx, cy, { r: 14, arm: 10, border: { color: COLOR, width: 3 } }));
    go(X, crossWindow(cx, cy, { r: 14, arm: 10, border: { color: '#00ff00', width: 3 } }));
    go(X, crossWindow(cx, cy, { r: 14, arm: 10 }));
    go(X, crossWindow(cx, cy, { r: 14, arm: 10, border: B }));
    go(X, null);
    go(X + 1, null);
    go(X + 2, crossWindow(cx + 2, cy, { r: 14, arm: 10, border: B }));
    // La ventana quieta mientras la caja avanza por debajo, a caballo del lado de la caja; fuera de la caja y de vuelta
    const ox = b.options.originX ?? 0, edge = ox + Math.floor((X - 32) / STRIP) * STRIP, still = crossWindow(edge + 3, cy, { r: 9, arm: 9, border: { color: COLOR, width: 2 } });
    for (const k of [0, 1, 2, 1, 0]) go(X + k * STRIP, still);
    go(X, crossWindow(cx - 300, cy, { r: 14, arm: 10, border: B }));
    go(X, crossWindow(cx, cy - 9, { r: 30, arm: 6, border: B }));
    for (let tx = X; tx >= 4 * N + STRIP; tx -= 3) go(tx, crossWindow(...centre(tx), { r: 14, arm: 10, border: B }));
    expect(borders).toBeGreaterThan(3000);
    expect(partsWalking).toBeGreaterThan(3 * STRIP - 4);
    expect(fulls).toBeLessThan(10);
  });
});
