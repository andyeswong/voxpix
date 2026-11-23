// La luz del interior de la sección con SectionCut.worldSky: el cielo de cueva de lo sustituido es el del mundo sin
// cortar. Por defecto la caja quitada deja entrar el cielo y un interior cerrado se ve iluminado de día; con worldSky
// queda a oscuras salvo por sus luces y por las aberturas que de verdad dan al cielo.
// El criterio: el cielo de cada píxel de la capa es el que el horneado da a su vóxel y su cara con el mundo entero
// (skyFromPick), y el cuadro lo refleja (cave donde no hay cielo).
import { describe, it, expect } from 'vitest';
import { material, unkey } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView } from '../src/world/view';
import { bakeWorld, skyFromPick, SKY_REACH } from '../src/world/bake';
import { frame2D, sectionFor, type Frame2DOptions } from '../src/world/frame2d';
import { sectionAround, sectionLayer, SectionPainter, STRIP, secIdx, type SectionCut, type SectionLayer } from '../src/world/section';
import type { WorldLight } from '../src/world/build';

const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
] };
const W = 96, D = 96, ZT = 48, TOP = 40;
// Una sala cerrada bajo tierra (x 30..61, y 40..57, z 8..19) y, si se pide, un pozo de 4 x 4 de su techo a la superficie
const R = { x0: 30, x1: 61, y0: 40, y1: 57, z0: 8, z1: 19 }, SHAFT = { x0: 44, x1: 47, y0: 51, y1: 54 };
function build(shaft: boolean): StaticVoxels {
  const s = new StaticVoxels(pal, W, D, 0, ZT - 1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) for (let z = 0; z < TOP; z++) {
    if (x >= R.x0 && x <= R.x1 && y >= R.y0 && y <= R.y1 && z >= R.z0 && z <= R.z1) continue;
    if (shaft && x >= SHAFT.x0 && x <= SHAFT.x1 && y >= SHAFT.y0 && y <= SHAFT.y1 && z > R.z1) continue;
    s.set(x, y, z, z === TOP - 1 ? material(1, 2 + ((x + y) & 1)) : material(0, 1 + ((x * 3 + y + z) % 3)));
  }
  return s;
}
const GX = 46, GY = 48;
function scene(opts: { shaft?: boolean; lights?: WorldLight[] } = {}) {
  const st = new WorldState(build(!!opts.shaft), opts.lights ?? [], null), view = new WorldView(st, 0);
  const b = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, outline: 'both', sky: true });
  const cut = sectionAround(view.camera, GX, GY, R.z0, 32);
  const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.9, 0.9, 0.9], cave: [0.1, 0.1, 0.1] };
  // La capa y el cuadro con el corte `c`, y la luminancia media de lo sustituido
  const shot = (c: SectionCut, cave: readonly [number, number, number] = [0.1, 0.1, 0.1]) => {
    const oo = { ...o, cave, section: c }, L = sectionFor(b, oo)!, px = frame2D(view.frame(), b, oo);
    let sum = 0, n = 0;
    for (let j = 0; j < L.h; j++) for (let g = L.x; g < L.x + L.w; g++) {
      if (L.mask[secIdx(L, g, j)] !== 1) continue;
      const t = ((L.y + j) * b.width + g) * 4;
      sum += 0.299 * px[t]! + 0.587 * px[t + 1]! + 0.114 * px[t + 2]!; n++;
    }
    return { L, px, lum: sum / n, n };
  };
  return { view, b, cut, shot };
}
// ¿El vóxel de ese píxel está bajo tierra? (la caja llega hasta arriba: lo sustituido incluye la superficie de detrás,
// que ve el cielo de verdad)
// (y no junto al canto del mundo: la caja empieza en y 0, y un rayo que sale del mundo cuenta como cielo, también en el
// horneado)
const under = (k: number) => { if (k !== k) return false; const [, y, z] = unkey(k); return z < TOP - 1 && y > SKY_REACH; };
// El cielo de cada píxel de la capa (máscara 1 o 2) contra el del mundo entero; devuelve cuántos de los sustituidos de
// bajo tierra lo ven y cuántos no
function againstWorld(b: ReturnType<typeof scene>['b'], L: SectionLayer): { open: number; dark: number } {
  let open = 0, dark = 0;
  for (let j = 0; j < L.h; j++) for (let g = L.x; g < L.x + L.w; g++) {
    const q = secIdx(L, g, j), m = L.mask[q]!;
    if (!m) continue;
    const want = skyFromPick(b.source, Float64Array.of(L.pick[q]!), Int8Array.of(L.face[q]!))[0]!;
    if (L.sky![q] !== want) expect(`cielo del píxel ${g},${j} (máscara ${m}): ${L.sky![q]}`).toBe(`${want}`);
    // (el borde es un píxel horneado: su cielo es el horneado)
    if (m === 2 && L.sky![q] !== b.sky![(L.y + j) * b.width + g]) expect(`borde ${g},${j}`).toBe('el cielo horneado');
    if (m === 1 && under(L.pick[q]!)) { if (L.sky![q]) open++; else dark++; }
  }
  return { open, dark };
}

describe('la luz del interior de la sección (worldSky)', () => {
  it('una sala cerrada sin luz: por defecto el corte la ilumina; con worldSky, a oscuras', () => {
    const { b, cut, shot } = scene();
    const def = shot(cut), wor = shot({ ...cut, worldSky: true });
    expect(def.n).toBeGreaterThan(500);
    // Lo que se quita y se ve no cambia: la misma máscara y los mismos vóxeles
    expect(wor.n).toBe(def.n);
    for (let q = 0; q < def.L.mask.length; q++) {
      if (def.L.mask[q] !== wor.L.mask[q]) expect(`máscara ${q}`).toBe('igual');
      if (def.L.mask[q] && def.L.pick[q] !== wor.L.pick[q]) expect(`vóxel ${q}`).toBe('igual');
      for (let c = 0; c < 4; c++) if (def.L.mask[q] && def.L.rgba[q * 4 + c] !== wor.L.rgba[q * 4 + c]) expect(`color ${q}`).toBe('igual');
    }
    // Por defecto, casi todo lo sustituido ve cielo por el corte
    let defOpen = 0, below = 0;
    for (let q = 0; q < def.L.mask.length; q++) if (def.L.mask[q] === 1 && under(def.L.pick[q]!)) { below++; if (def.L.sky![q]) defOpen++; }
    expect(below).toBeGreaterThan(500);
    expect(defOpen).toBeGreaterThan(below * 0.5);
    // Con worldSky, nada de bajo tierra ve cielo, y el cielo de cada píxel es el del mundo entero
    const w = againstWorld(b, wor.L);
    expect(w.open).toBe(0);
    expect(w.dark).toBe(below);
    // Y en el cuadro: a la luz de cueva (0,1 frente a 0,9 de ambiente)
    expect(wor.lum).toBeLessThan(def.lum * 0.25);
    expect(wor.lum).toBeGreaterThan(0);
  });

  it('con una luz dentro: el cielo sigue a cero y lo de cerca de la luz se ilumina', () => {
    const light = { id: 'luz', kind: 'torch', x: GX, y: 52, z: R.z0 + 4, baked: false } as unknown as WorldLight;
    const dark = scene(), lit = scene({ lights: [light] });
    const a = dark.shot({ ...dark.cut, worldSky: true }), c = lit.shot({ ...lit.cut, worldSky: true });
    expect(againstWorld(lit.b, c.L).open).toBe(0);
    expect(c.n).toBe(a.n);
    expect(c.lum).toBeGreaterThan(a.lum * 1.5);
    // (ningún píxel sustituido queda más oscuro que sin la luz)
    for (let j = 0; j < c.L.h; j++) for (let g = c.L.x; g < c.L.x + c.L.w; g++) {
      if (c.L.mask[secIdx(c.L, g, j)] !== 1) continue;
      const t = ((c.L.y + j) * lit.b.width + g) * 4;
      for (let k = 0; k < 3; k++) if (c.px[t + k]! < a.px[t + k]!) expect(`píxel ${g},${j}`).toBe('no más oscuro');
    }
  });

  it('con una abertura al cielo: solo lo de cerca del pozo ve cielo, y es el del mundo entero', () => {
    const closed = scene(), holed = scene({ shaft: true });
    const a = closed.shot({ ...closed.cut, worldSky: true }), c = holed.shot({ ...holed.cut, worldSky: true });
    const w = againstWorld(holed.b, c.L);
    expect(w.open).toBeGreaterThan(20);
    expect(w.dark).toBeGreaterThan(w.open);
    // Los que ven cielo están a SKY_REACH + 1 columnas del pozo como mucho
    for (let j = 0; j < c.L.h; j++) for (let g = c.L.x; g < c.L.x + c.L.w; g++) {
      const q = secIdx(c.L, g, j);
      if (c.L.mask[q] !== 1 || !c.L.sky![q] || !under(c.L.pick[q]!)) continue;
      const [x, y] = unkey(c.L.pick[q]!);
      const near = x >= SHAFT.x0 - SKY_REACH - 1 && x <= SHAFT.x1 + SKY_REACH + 1 && y >= SHAFT.y0 - SKY_REACH - 1 && y <= SHAFT.y1 + SKY_REACH + 1;
      if (!near) expect(`píxel ${g},${j} ve cielo lejos del pozo`).toBe('cerca');
    }
    // Y el cuadro: frente al mismo con la cueva tan clara como el ambiente (sin efecto del cielo), lo que ve cielo pierde
    // menos luz que lo que no
    const flatLit = holed.shot({ ...holed.cut, worldSky: true }, [0.9, 0.9, 0.9]);
    const sum = { open: { cave: 0, flat: 0 }, dark: { cave: 0, flat: 0 } };
    for (let j = 0; j < c.L.h; j++) for (let g = c.L.x; g < c.L.x + c.L.w; g++) {
      const q = secIdx(c.L, g, j);
      if (c.L.mask[q] !== 1 || !under(c.L.pick[q]!)) continue;
      const t = ((c.L.y + j) * holed.b.width + g) * 4, lum = (px: Uint8ClampedArray | Uint8Array) => 0.299 * px[t]! + 0.587 * px[t + 1]! + 0.114 * px[t + 2]!;
      const acc = c.L.sky![q] ? sum.open : sum.dark;
      acc.cave += lum(c.px); acc.flat += lum(flatLit.px);
    }
    const kept = { open: sum.open.cave / sum.open.flat, dark: sum.dark.cave / sum.dark.flat };
    expect(kept.dark).toBeLessThan(0.2);
    expect(kept.open).toBeGreaterThan(kept.dark * 1.5);
    // (y la sala cerrada no cambia por haber un pozo en otro mundo: sigue a oscuras)
    expect(againstWorld(closed.b, a.L).open).toBe(0);
  });

  it('por franjas (SectionPainter): el mismo cielo, y cambiar worldSky repinta', () => {
    const { b, cut } = scene({ shaft: true });
    const p = new SectionPainter(b, { ahead: 0, behind: 0 });
    for (const worldSky of [true, false]) {
      const c: SectionCut = { ...cut, worldSky };
      p.set(c, 0); p.paintAll();
      const x0 = Math.floor(c.x0 / STRIP) * STRIP;
      const L = p.layer()!, Rf = sectionLayer(b, { ...c, x0, x1: x0 + Math.ceil((c.x1 - c.x0 + 1) / STRIP) * STRIP - 1 })!;
      expect([L.x, L.y, L.w, L.h, L.count]).toEqual([Rf.x, Rf.y, Rf.w, Rf.h, Rf.count]);
      for (let j = 0; j < Rf.h; j++) for (let g = Rf.x; g < Rf.x + Rf.w; g++) {
        const l = secIdx(L, g, j), r = secIdx(Rf, g, j);
        if (L.mask[l] !== Rf.mask[r]) expect(`máscara ${g},${j}`).toBe('igual');
        if (Rf.mask[r] && L.sky![l] !== Rf.sky![r]) expect(`cielo ${g},${j} worldSky ${worldSky}: ${L.sky![l]}`).toBe(`${Rf.sky![r]}`);
      }
      if (worldSky) againstWorld(b, L);
    }
    expect(p.resets).toBe(1);
  });
});
