// El pintor de la sección (SectionPainter) no deja cuadros con hueco: lo último pintado se sigue enseñando hasta que
// está lo nuevo.
// - Editar un vóxel dentro de la caja deja viejas las franjas de cerca: mientras se repintan, cada franja de la capa es
//   la de antes o la nueva, nunca vacía.
// - Mover el suelo de la caja de un salto (un escalón) cambia lo que se pinta: la capa de la caja anterior se sigue
//   devolviendo, con las x y la ventana de ahora, hasta que la nueva está pintada entera.
// - La holgura con que la caja se conserva en z es configurable (por defecto, la de siempre).
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView } from '../src/world/view';
import { bakeWorld, rebakeChangedJobs, type Baked } from '../src/world/bake';
import { sectionAround, SectionPainter, crossWindow, STRIP, UNIT, secIdx, type SectionCut, type SectionLayer } from '../src/world/section';

const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
] };
const W = 128, D = 112, ZT = 64, TZ0 = 8, TZ1 = 27;
const top = (x: number, y: number) => 40 + Math.round(4 * Math.sin(x / 11) * Math.cos(y / 9));
// Un terreno con un túnel este-oeste (y 52..67), de z 8 a 27
const tunnel = (_x: number, y: number, z: number) => z >= TZ0 && z <= TZ1 && y >= 52 && y <= 67;
function build(): StaticVoxels {
  const s = new StaticVoxels(pal, W, D, 0, ZT - 1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const t = top(x, y);
    for (let z = 0; z < t; z++) {
      if (tunnel(x, y, z)) continue;
      s.set(x, y, z, z >= t - 1 ? material(2, 2 + ((x + y) & 1)) : z >= t - 6 ? material(1, 2) : material(0, 1 + ((x * 3 + y + z) % 3)));
    }
  }
  return s;
}
function world() {
  const st = new WorldState(build(), [], null), view = new WorldView(st, 0, { cut: true });
  const b = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, outline: 'both', sky: true });
  return { view, b };
}

// La capa, aplanada (sin anillo): lo que se ve de ella
interface Flat { x: number; y: number; w: number; h: number; count: number; mask: Uint8Array; rgba: Uint8Array }
function flat(L: SectionLayer): Flat {
  const mask = new Uint8Array(L.w * L.h), rgba = new Uint8Array(L.w * L.h * 4);
  for (let j = 0; j < L.h; j++) for (let k = 0; k < L.w; k++) {
    const q = secIdx(L, L.x + k, j), o = j * L.w + k;
    mask[o] = L.mask[q]!;
    for (let c = 0; c < 4; c++) rgba[o * 4 + c] = L.rgba[q * 4 + c]!;
  }
  return { x: L.x, y: L.y, w: L.w, h: L.h, count: L.count, mask, rgba };
}
// ¿Las columnas g0..g1 de la imagen son iguales en las dos (máscara, y color donde hay máscara)?
function sameCols(a: Flat, r: Flat, g0: number, g1: number): boolean {
  if (a.y !== r.y || a.h !== r.h) return false;
  for (let g = g0; g <= g1; g++) {
    const ka = g - a.x, kr = g - r.x;
    if (ka < 0 || ka >= a.w || kr < 0 || kr >= r.w) return false;
    for (let j = 0; j < a.h; j++) {
      const oa = j * a.w + ka, or = j * r.w + kr;
      if (a.mask[oa] !== r.mask[or]) return false;
      if (!a.mask[oa]) continue;
      for (let c = 0; c < 4; c++) if (a.rgba[oa * 4 + c] !== r.rgba[or * 4 + c]) return false;
    }
  }
  return true;
}
function same(a: Flat, r: Flat): boolean { return a.x === r.x && a.w === r.w && a.count === r.count && sameCols(a, r, a.x, a.x + a.w - 1); }
// Una llamada de la cola sin sitio: no pinta nada, o (la caja lleva varias sin avanzar) un solo paso
const tick = (p: SectionPainter) => { p.job()?.run(0); };
// La caja como la lleva el pintor (franjas enteras en x), en columnas de la imagen
function boxCols(b: Baked, cut: SectionCut): [number, number] {
  const ox = b.options.originX ?? 0, x0 = Math.floor(cut.x0 / STRIP) * STRIP;
  return [ox + x0, ox + x0 + Math.ceil((cut.x1 - cut.x0 + 1) / STRIP) * STRIP - 1];
}

describe('el pintor de la sección no deja cuadros con hueco', () => {
  it('un vóxel editado dentro de la caja: mientras se repinta, cada franja es la de antes o la nueva', () => {
    const { view, b } = world();
    const gx = 60, gy = 60, cut = sectionAround(view.camera, gx, gy, TZ0, 32);
    const p = new SectionPainter(b, { ahead: 0, behind: 0 });
    p.set(cut, 0); p.paintAll();
    expect(p.ready()).toBe(true);
    const before = flat(p.layer()!);
    expect(before.count).toBeGreaterThan(500);
    // Se pica un hoyo en el suelo del túnel, dentro de la caja, y se rehornea
    // (lejos de los lados de la caja: su costura con lo horneado de fuera se hace con la imagen de ahora)
    const [ex, ey] = view.camera.cellToView(gx - 8, 56);
    for (let z = TZ0 - 4; z < TZ0; z++) for (let d = 0; d < 12; d++) for (let e = 0; e < 4; e++) { expect(view.static.get(ex + d, ey + e, z)).not.toBe(0); view.static.set(ex + d, ey + e, z, 0); }
    for (const j of rebakeChangedJobs(b, [])) while (!j.run(Infinity));
    expect(p.boxState().stale).toBeGreaterThan(0);
    // Lo nuevo: pintado de cero con el mundo de ahora
    const ref = new SectionPainter(b, { ahead: 0, behind: 0 });
    ref.set(cut, 0); ref.paintAll();
    const after = flat(ref.layer()!);
    expect(same(before, after)).toBe(false);
    // En el cuadro del rehorneado, la capa de antes entera
    p.set(cut, 0);
    expect(same(flat(p.layer()!), before)).toBe(true);
    // Y cuadro a cuadro hasta que está al día: cada unidad, la de antes o la nueva
    const [g0, g1] = boxCols(b, cut);
    let frames = 0, mixed = 0;
    for (; !p.ready() && frames < 4000; frames++) {
      p.set(cut, 0); tick(p);
      const L = p.layer();
      expect(L).not.toBeNull();
      const f = flat(L!);
      expect(f.count).toBeGreaterThanOrEqual(Math.min(before.count, after.count));
      let olds = 0, news = 0;
      for (let g = g0; g <= g1; g += UNIT) {
        const o = sameCols(f, before, g, g + UNIT - 1), n = sameCols(f, after, g, g + UNIT - 1);
        if (!o && !n) expect(`cuadro ${frames}, unidad en ${g}`).toBe('la de antes o la nueva');
        if (o && !n) olds++;
        if (n && !o) news++;
      }
      if (olds && news) mixed++;
    }
    expect(p.ready()).toBe(true);
    expect(frames).toBeGreaterThan(1);
    // (hubo cuadros con unas franjas ya nuevas y otras todavía de antes)
    expect(mixed).toBeGreaterThan(0);
    expect(same(flat(p.layer()!), after)).toBe(true);
  });

  it('el suelo de la caja se mueve de un salto: la capa anterior se sigue viendo hasta que la nueva está entera', () => {
    const { view, b } = world();
    const gx = 60, gy = 60, cut = sectionAround(view.camera, gx, gy, TZ0, 32), up: SectionCut = { ...cut, zMin: cut.zMin + 8 };
    const p = new SectionPainter(b, { ahead: 0, behind: 0 });
    p.set(cut, 0); p.paintAll();
    const before = flat(p.layer()!);
    const ref = new SectionPainter(b, { ahead: 0, behind: 0 });
    ref.set(up, 0); ref.paintAll();
    const after = flat(ref.layer()!);
    expect(same(before, after)).toBe(false);
    // El salto: lo pintado no vale para la caja nueva (se repinta entera), pero la capa es la de antes
    p.set(up, 0);
    expect(p.resets).toBe(1);
    expect(p.boxState().missing).toBeGreaterThan(0);
    expect(p.ready()).toBe(false);
    expect(same(flat(p.layer()!), before)).toBe(true);
    let frames = 0, olds = 0;
    for (; !p.ready() && frames < 4000; frames++) {
      p.set(up, 0); tick(p);
      const L = p.layer();
      expect(L).not.toBeNull();
      const f = flat(L!), o = same(f, before), n = same(f, after);
      if (!o && !n) expect(`cuadro ${frames}`).toBe('la capa de antes o la nueva');
      if (o) olds++;
      // (la nueva solo cuando está entera)
      if (n) expect(p.ready()).toBe(true);
    }
    expect(olds).toBeGreaterThan(1);
    const L = p.layer()!;
    expect(same(flat(L), after)).toBe(true);
    // (quien lleva una copia la sube entera: su base era la de la caja anterior)
    expect(L.base ?? null).toBeNull();
  });

  it('varios saltos seguidos sin acabar de pintar (una caída): se queda la última capa que estuvo entera, con la ventana de ahora', () => {
    const { view, b } = world();
    const gx = 60, gy = 60, cut = sectionAround(view.camera, gx, gy, TZ0 + 16, 32);
    const p = new SectionPainter(b, { ahead: 0, behind: 0 });
    p.set(cut, 0); p.paintAll();
    const whole = p.layer()!, before = flat(whole);
    const wx = whole.x + (whole.w >> 1), wy = whole.y + (whole.h >> 1);
    const win = (dx: number) => crossWindow(wx + dx, wy, { arm: 12, r: 20 });
    p.set({ ...cut, window: win(0) }, 0);
    const first = flat(p.layer()!);
    expect(first.count).toBeGreaterThan(0);
    expect(first.count).toBeLessThan(before.count);
    for (const [k, dz] of [8, 16].entries()) {
      for (let f = 0; f < 6; f++) {
        const w = win(k * 6 + f + 1);
        p.set({ ...cut, zMin: cut.zMin - dz, window: w }, 0); tick(p);
        const L = p.layer();
        expect(L).not.toBeNull();
        // La ventana es la de este cuadro, sobre la capa de la caja que estuvo entera
        expect(L!.window).toBe(w);
        expect(L!.count).toBeGreaterThan(0);
        for (let j = 0; j < L!.h; j++) for (let g = L!.x; g < L!.x + L!.w; g++) {
          const m = L!.mask[secIdx(L!, g, j)]!;
          if (m === 1 && before.mask[j * before.w + g - before.x] !== 1) expect(`cuadro ${k}/${f}, píxel ${g},${j}`).toBe('de la capa anterior');
        }
      }
      expect(p.resets).toBe(k + 1);
    }
    // Al acabar de pintar, la de la caja de ahora
    const last: SectionCut = { ...cut, zMin: cut.zMin - 16 };
    p.set(last, 0); p.paintAll();
    const ref = new SectionPainter(b, { ahead: 0, behind: 0 });
    ref.set(last, 0); ref.paintAll();
    expect(same(flat(p.layer()!), flat(ref.layer()!))).toBe(true);
  });

  it('sin corte, lo apartado se suelta', () => {
    const { view, b } = world();
    const cut = sectionAround(view.camera, 60, 60, TZ0, 32);
    const p = new SectionPainter(b, { ahead: 0, behind: 0 });
    p.set(cut, 0); p.paintAll();
    p.set({ ...cut, zMin: cut.zMin + 8 }, 0);
    expect(p.layer()).not.toBeNull();
    p.set(null, 0);
    expect(p.layer()).toBeNull();
    p.set({ ...cut, zMin: cut.zMin + 8 }, 0);
    expect(p.layer()).toBeNull();
  });

  it('la holgura en z es configurable; por defecto, 1 por debajo de los pies y 4 por encima', () => {
    const { view, b } = world();
    const cut = sectionAround(view.camera, 60, 60, TZ0 + 8, 32);
    const at = (p: SectionPainter, dz: number) => { p.set({ ...cut, zMin: cut.zMin + dz }, 0); return p.resets; };
    const d = new SectionPainter(b, { ahead: 0, behind: 0 });
    expect(d.slack).toEqual({ zBelow: 1, zAbove: 4, yBehind: STRIP });
    d.set(cut, 0); d.paintAll();
    // (los pies bajan 4: la caja queda 4 por encima; suben 1: queda 1 por debajo)
    expect(at(d, -4)).toBe(0);
    expect(at(d, 1)).toBe(0);
    expect(d.ready()).toBe(true);
    expect(at(d, -5)).toBe(1);
    expect(at(d, -5 + 2)).toBe(2);
    // Con un escalón entero de holgura a cada lado, subir o bajar uno no repinta
    const s = new SectionPainter(b, { ahead: 0, behind: 0, slack: { zBelow: 8, zAbove: 8 } });
    expect(s.slack).toEqual({ zBelow: 8, zAbove: 8, yBehind: STRIP });
    s.set(cut, 0); s.paintAll();
    expect(at(s, -8)).toBe(0);
    expect(at(s, 8)).toBe(0);
    expect(s.ready()).toBe(true);
    expect(at(s, 9)).toBe(1);
    // (y se puede cambiar después: vale desde el set siguiente)
    s.slack.zBelow = 1;
    s.set(cut, 0); s.paintAll();
    const r = s.resets;
    expect(at(s, 2) - r).toBe(1);
  });
});
