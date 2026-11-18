// El corte al componer (src/world/section.ts): ver de perfil lo de detrás del objetivo sin rehornear. Contra el corte
// horneado (el mismo mundo con la caja quitada, horneado entero), en los 4 giros:
// - sin luces fijas, igual byte a byte (con contorno 'both'), también con una luz dinámica;
// - con cielo de cueva, la capa igual; difieren solo unos píxeles horneados junto al corte (que con el corte ganan cielo);
// - con una luz fija, la capa difiere solo en su sombra (en la sección, las fijas llegan sin sombras), poco.
// Y sin sección, el cuadro de siempre.
import { describe, it, expect } from 'vitest';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView, type Quarter } from '../src/world/view';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { frame2D, sectionFor, type Frame2DOptions } from '../src/world/frame2d';
import { sectionAround, sectionLayer, SectionPainter, STRIP, UNIT, secIdx, type SectionLayer } from '../src/world/section';
import type { WorldLight } from '../src/world/build';

const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
] };
const W = 128, D = 112, ZT = 64, TZ0 = 8, TZ1 = 19;
const top = (x: number, y: number) => 36 + Math.round(4 * Math.sin(x / 11) * Math.cos(y / 9));
// Un terreno con un túnel este-oeste (y 52..67) y otro norte-sur (x 60..75), los dos de z 8 a 19
const tunnel = (x: number, y: number, z: number) => z >= TZ0 && z <= TZ1 && ((y >= 52 && y <= 67) || (x >= 60 && x <= 75));
function build(cut: ((x: number, y: number, z: number) => boolean) | null): StaticVoxels {
  const s = new StaticVoxels(pal, W, D, 0, ZT - 1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const t = top(x, y);
    for (let z = 0; z < t; z++) {
      if (tunnel(x, y, z) || (cut && cut(x, y, z))) continue;
      s.set(x, y, z, z >= t - 1 ? material(2, 2 + ((x + y) & 1)) : z >= t - 6 ? material(1, 2) : material(0, 1 + ((x * 3 + y + z) % 3)));
    }
  }
  return s;
}
// El cuadro con la capa (mundo entero) y el del corte horneado (la caja quitada), en el giro q, con el objetivo en
// (gx, gy) del mundo y sus pies a z 8
function pair(q: Quarter, gx: number, gy: number, width: number, opts: { sky?: boolean; lights?: WorldLight[] } = {}) {
  const lights = opts.lights ?? [];
  const full = new WorldState(build(null), lights, null);
  const view = new WorldView(full, q);
  const cut = sectionAround(view.camera, gx, gy, TZ0, width);
  const cam = view.camera;
  const inCut = (x: number, y: number, z: number) => { const [vx, vy] = cam.cellToView(x, y); return vx >= cut.x0 && vx <= cut.x1 && vy >= cut.y0 && vy <= cut.y1 && z >= cut.zMin; };
  const refSt = new WorldState(build(inCut), lights, null), refView = new WorldView(refSt, q);
  const bo = { topZ: ZT, incline: 0.5, outline: 'both' as const, sky: opts.sky ?? false };
  const bf = bakeWorld(view.bakeable(), bo), br = bakeWorld(refView.bakeable(), bo);
  const o: Frame2DOptions = { vx: 0, vy: 0, vw: bf.width, vh: bf.height, time: 0, lights: true, ambient: [0.9, 0.9, 0.9], ...(opts.sky ? { cave: [0.25, 0.25, 0.3] as const } : {}) };
  const withLayer = { ...o, section: cut };
  const a = frame2D(refView.frame(), br, o), c = frame2D(view.frame(), bf, withLayer);
  const layer = sectionFor(bf, withLayer)!;
  let inside = 0, outside = 0, maxIn = 0, maxOut = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i]! - c[i]!), Math.abs(a[i + 1]! - c[i + 1]!), Math.abs(a[i + 2]! - c[i + 2]!));
    if (!d) continue;
    const px = (i / 4) % bf.width, py = Math.floor(i / 4 / bf.width);
    const inL = px >= layer.x && py >= layer.y && px < layer.x + layer.w && py < layer.y + layer.h && layer.mask[(py - layer.y) * layer.w + px - layer.x] === 1;
    if (inL) { inside++; maxIn = Math.max(maxIn, d); } else { outside++; maxOut = Math.max(maxOut, d); }
  }
  const plain = frame2D(view.frame(), bf, o);
  let changed = 0;
  for (let i = 0; i < c.length; i++) if (c[i] !== plain[i]) changed++;
  const off = frame2D(view.frame(), bf, { ...o, section: null });
  return { count: layer.count, inside, outside, maxIn, maxOut, changed, plainSame: plain.every((v, i) => v === off[i]) };
}

describe('corte al componer', () => {
  for (const q of [0, 1, 2, 3] as Quarter[]) it(`giro ${q}: sin luces fijas, igual byte a byte que el corte horneado (con contorno)`, () => {
    const r = pair(q, 40, 59, 32);
    expect(r.count).toBeGreaterThan(500);                                   // la capa sustituye de verdad
    expect(r.changed).toBeGreaterThan(500);                                 // y el cuadro cambia
    expect(r.inside + r.outside).toBe(0);
  });

  it('con una luz dinámica en el túnel, igual', () => {
    const r = pair(0, 40, 59, 32, { lights: [{ id: 'd', kind: 'torch', x: 44.5, y: 62.5, z: 13, baked: false }] });
    expect(r.inside + r.outside).toBe(0);
  });

  it('con cielo de cueva: la capa igual; fuera, solo unos píxeles junto al corte, poco', () => {
    const r = pair(0, 40, 59, 32, { sky: true });
    expect(r.inside).toBe(0);
    expect(r.outside).toBeLessThan(80);
    expect(r.maxOut).toBeLessThanOrEqual(12);
  });

  it('con una luz fija en el túnel: la capa difiere solo en su sombra, poco', () => {
    const r = pair(0, 40, 59, 32, { lights: [{ id: 'f', kind: 'torch', x: 44.5, y: 62.5, z: 13, baked: true }] });
    expect(r.outside).toBe(0);
    expect(r.inside).toBeLessThan(r.count / 3);
    expect(r.maxIn).toBeLessThanOrEqual(40);
  });

  it('todo el ancho de la vista, en el túnel norte-sur girado', () => {
    const r = pair(1, 67, 40, 112);
    expect(r.count).toBeGreaterThan(1000);
    expect(r.inside + r.outside).toBe(0);
  });

  it('por franjas (SectionPainter): la misma capa que la de la caja entera, pintando solo lo nuevo al andar; y lo que cambia (dirty) basta para ponerla al día', () => {
    const st = new WorldState(build(null), [], null), view = new WorldView(st, 0);
    const bf = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, outline: 'both', sky: true });
    const p = new SectionPainter(bf, { ahead: 4, behind: 1 });
    // Una copia como la de la GPU: por columnas de la imagen, puesta al día solo con lo que dice cada capa (base y dirty)
    const BW = bf.width;
    let mirror: { y: number; h: number; mask: Uint8Array; rgba: Uint8Array; depth: Float32Array; sky: Uint8Array } | null = null, seen: SectionLayer | null = null;
    const sync = (L: SectionLayer | null) => {
      if (!L || L === seen) return;
      const full = !mirror || !L.base || L.base !== seen || mirror.y !== L.y || mirror.h !== L.h;
      if (!mirror || mirror.y !== L.y || mirror.h !== L.h) mirror = { y: L.y, h: L.h, mask: new Uint8Array(BW * L.h), rgba: new Uint8Array(BW * L.h * 4), depth: new Float32Array(BW * L.h), sky: new Uint8Array(BW * L.h) };
      const cols: ReadonlyArray<readonly [number, number]> = full ? [[L.x, L.x + L.w - 1]] : L.dirty!;
      for (const [g0, g1] of cols) for (let g = Math.max(L.x, g0); g <= Math.min(L.x + L.w - 1, g1); g++) for (let j = 0; j < L.h; j++) {
        const q = secIdx(L, g, j), m = j * BW + g;
        mirror.mask[m] = L.mask[q]!; mirror.depth[m] = L.depth[q]!; mirror.sky[m] = L.sky![q]!;
        for (let c = 0; c < 4; c++) mirror.rgba[m * 4 + c] = L.rgba[q * 4 + c]!;
      }
      seen = L;
    };
    let prevX0 = 0;
    for (const [k, gx] of [40, 44, 52, 60, 68].entries()) {
      const c0 = sectionAround(view.camera, gx, 59, TZ0, 32);
      p.set(c0, 1);
      sync(p.layer());                                                     // compone (en el cuadro del salto, lo de delante espera)
      const before = p.painted;
      p.job()?.run(Infinity);                                              // por la cola: también el cielo de los bordes de la caja siguiente
      // La caja, 4 franjas por delante y 1 por detrás; luego, las franjas que avanza (de UNIT en UNIT)
      const x0 = Math.floor(c0.x0 / STRIP) * STRIP, moved = k === 0 ? 0 : (x0 - prevX0) / STRIP;
      expect(p.painted - before).toBe((k === 0 ? 4 + 4 + 1 : moved) * (STRIP / UNIT));
      prevX0 = x0;
      const L = p.layer()!, R = sectionLayer(bf, { ...c0, x0: Math.floor(c0.x0 / STRIP) * STRIP, x1: Math.floor(c0.x0 / STRIP) * STRIP + Math.ceil((c0.x1 - c0.x0 + 1) / STRIP) * STRIP - 1 })!;   // la caja como la lleva el pintor: por franjas en x
      sync(L);
      if (moved > 0) expect(L.base).not.toBeNull();                        // al andar se pone al día por columnas
      expect([L.x, L.y, L.w, L.h, L.count]).toEqual([R.x, R.y, R.w, R.h, R.count]);
      for (let q = 0; q < R.w * R.h; q++) {
        const gx = R.x + (q % R.w), j = Math.floor(q / R.w), l = secIdx(L, gx, j), m = j * BW + gx;
        if (L.mask[l] !== R.mask[q]) expect(`máscara ${q} k ${k}`).toBe('igual');
        if (mirror!.mask[m] !== R.mask[q]) expect(`copia: máscara ${q}`).toBe('igual');
        if (!R.mask[q]) continue;
        for (let c = 0; c < 4; c++) if (L.rgba[l * 4 + c] !== R.rgba[q * 4 + c] || mirror!.rgba[m * 4 + c] !== R.rgba[q * 4 + c]) expect(`color ${q}`).toBe('igual');
        if (L.depth[l] !== R.depth[q] || L.sky![l] !== R.sky![q]) expect(`profundidad o cielo ${q} k ${k}`).toBe('igual');
        if (L.wy[l] !== R.wy[q] || L.back[l] !== R.back[q] || L.face[l] !== R.face[q]) expect(`geometría ${q} k ${k} ${L.wy[l]} ${R.wy[q]} ${L.back[l]} ${R.back[q]}`).toBe('igual');
        if (mirror!.depth[m] !== R.depth[q] || mirror!.sky[m] !== R.sky![q]) expect(`copia: profundidad o cielo ${q}`).toBe('igual');
      }
    }
  });

  it('un pozo bajo el suelo cortado: lo sustituido sin nada detrás lleva el fondo de la sección, no transparente', () => {
    // Suelo llano a 16, una losa encima delante del objetivo (lo que se corta) y un pozo en el suelo dentro de la caja: el
    // rayo de lo cortado baja por el pozo, donde no hay nada que pintar. El cielo horneado de la losa es el abierto (la
    // regla de antes lo dejaba transparente: asomaba el cielo del juego)
    const s = new StaticVoxels(pal, 64, 64, 0, 47);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) for (let z = 0; z < 16; z++) s.set(x, y, z, material(1, 1));
    // (una losa de un vóxel sobre el suelo y el pozo: lo que se corta son sus caras de arriba, con todo el cielo)
    for (let y = 20; y < 36; y++) for (let x = 8; x < 56; x++) s.set(x, y, 16, material(0, 2));
    for (let y = 26; y < 36; y++) for (let x = 24; x < 40; x++) for (let z = 0; z < 16; z++) s.set(x, y, z, 0);   // el pozo, cerrado dentro de la caja
    const bf = bakeWorld({ model: s, lights: [], width: 64, depth: 64 }, { topZ: 48, incline: 0.5, outline: 'both', sky: true });
    const L = sectionLayer(bf, { x0: 4, x1: 59, y0: 0, y1: 39, zMin: 16 })!;
    let holes = 0, filled = 0;
    for (let q = 0; q < L.w * L.h; q++) {
      if (L.mask[q] !== 1) continue;
      if (!L.rgba[q * 4 + 3]) holes++;
      else if (L.face[q] === -1) filled++;                                 // sin cara: el fondo
    }
    expect(filled).toBeGreaterThan(20);                                      // el pozo se ve, con el fondo
    expect(holes).toBe(0);                                                    // y nada transparente
    // Al aire libre (una pared sin suelo detrás: lo de detrás es cielo), sí transparente
    const s2 = new StaticVoxels(pal, 64, 64, 0, 47);
    for (let y = 20; y < 26; y++) for (let x = 8; x < 56; x++) for (let z = 16; z < 34; z++) s2.set(x, y, z, material(0, 2));
    const b2 = bakeWorld({ model: s2, lights: [], width: 64, depth: 64 }, { topZ: 48, incline: 0.5, outline: 'both', sky: true });
    const L2 = sectionLayer(b2, { x0: 4, x1: 59, y0: 0, y1: 39, zMin: 16 })!;
    let open = 0;
    for (let q = 0; q < L2.w * L2.h; q++) if (L2.mask[q] === 1 && !L2.rgba[q * 4 + 3]) open++;
    expect(open).toBeGreaterThan(20);
  });

  // Lo de entrar bajo tierra en el juego: el corte de la vista (view-cut) escribe los vóxeles enseguida, la sección se pinta
  // con ellos, y los recuadros del corte se publican cientos de ms después. Esos recuadros cambian el pick horneado de las
  // franjas, pero no lo que pintan (o casi): antes las dejaban todas viejas, y la caja quedaba con huecos ~15 cuadros
  it('los recuadros del corte de la vista, publicados después de pintar con él, no dejan viejas las franjas que no cambian (igual que pintadas de nuevo); un vóxel cambiado cerca, sí', () => {
    const run = (q: Quarter, gx: number, edit: boolean) => {
      const st = new WorldState(build(null), [], null), view = new WorldView(st, q, { cut: true });
      const b = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, outline: 'both', sky: true });
      const gy = 60, [vx, vy] = view.camera.cellToView(gx, gy), cut = sectionAround(view.camera, gx, gy, TZ0, 16);
      view.setCut({ x0: vx - 16, y0: vy - 16, x1: vx + 16, y1: vy + 16, zTop: TZ1 + 1 });
      const p = new SectionPainter(b, { ahead: 0, behind: 0 });
      p.set(cut, 0); p.paintAll();
      expect(p.ready()).toBe(true);
      // (un vóxel picado junto al túnel, en la copia de la vista, antes de rehornear)
      if (edit) { const [ex, ey] = view.camera.cellToView(gx, 50); expect(view.static.get(ex, ey, TZ0 + 2)).not.toBe(0); view.static.set(ex, ey, TZ0 + 2, 0); }
      for (const j of rebakeChangedJobs(b, [])) while (!j.run(Infinity));
      const ref = new SectionPainter(b, { ahead: 0, behind: 0 });
      ref.set(cut, 0); ref.paintAll();
      return { p, L: p.layer(), R: ref.layer()! };
    };
    for (const gx of [30, 45, 90]) {
      const { p, L, R } = run(0, gx, false);
      expect(p.revalidated).toBe(4);
      expect(p.ready()).toBe(true);
      // Igual que pintada de nuevo, píxel a píxel
      expect(L).not.toBeNull();
      expect([L!.x, L!.y, L!.w, L!.h, L!.count]).toEqual([R.x, R.y, R.w, R.h, R.count]);
      let diff = 0;
      for (let j = 0; j < R.h; j++) for (let x = R.x; x < R.x + R.w; x++) {
        const a = secIdx(L!, x, j), r = secIdx(R, x, j);
        if (L!.mask[a] !== R.mask[r]) { diff++; continue; }
        if (!R.mask[r]) continue;
        let d = L!.sky![a] !== R.sky![r] || !(L!.depth[a] === R.depth[r]) || !(L!.pick[a] === R.pick[r] || (L!.pick[a] !== L!.pick[a] && R.pick[r] !== R.pick[r]));
        for (let c = 0; c < 4 && !d; c++) d = L!.rgba[a * 4 + c] !== R.rgba[r * 4 + c];
        if (d) diff++;
      }
      expect(diff).toBe(0);
    }
    // Con un vóxel cambiado en la caja: las franjas de cerca, viejas
    const { p } = run(0, 45, true);
    expect(p.ready()).toBe(false);
    expect(p.boxState().stale).toBeGreaterThan(0);
  });

  it('sin sección, el cuadro de siempre', () => {
    expect(pair(0, 40, 59, 32).plainSame).toBe(true);
  });
});
