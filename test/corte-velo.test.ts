// Los vóxeles semitransparentes de la sección (SectionCut.ghost): lo sustituido en z >= ghost.z se compone con alpha
// sobre una segunda superficie (lo que se ve detrás con todo lo de esa altura quitado).
// - la capa: sus arrays de siempre (la superficie de delante) no cambian ni un byte, así que la máscara, pickVoxel, lo
//   que ve un agente y entityAt son los de sin ghost; la segunda superficie es la de un mundo sin lo de z >= ghost.z;
// - el cuadro: apagado es el de siempre; con alpha 1 también; con otra alpha, la mezcla exacta del cuadro de alpha 0
//   con el de alpha 1, con luz, niebla y luces; una entidad delante del vóxel sale opaca, entre las dos superficies se
//   ve a través del velo, detrás de la segunda no se ve; y sobre fondo transparente el velo lleva alfa = alpha.
import { describe, it, expect } from 'vitest';
import { material, Model, unkey, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid, pickVoxel } from '../src/world/blocks';
import { WorldView } from '../src/world/view';
import { bakeWorld } from '../src/world/bake';
import { frame2D, sectionFor, sceneLayer, ghostMix, type Frame2DOptions } from '../src/world/frame2d';
import { sectionAround, sectionLayer, secIdx, FACING, type SectionCut, type SectionLayer } from '../src/world/section';
import { AgentHost, type AgentLook } from '../src/agent/agent';
import type { WorldLight } from '../src/world/build';

const pal: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
  { name: 'cuerpo', colors: ['#a02020', '#d04040', '#f08080'] },
] };
const W = 96, D = 96, ZT = 64, TOP = 40, GZ = 20;
// Una sala cerrada bajo tierra (x 30..61, y 40..57, z 8..19) con roca encima hasta la superficie (z 39), y sobre su
// mitad de detrás una hoya a cielo abierto (x 36..55, y 49..56, hasta z 30): la sección enseña su suelo (caras de arriba
// en z 29) además de la cara vertical de la roca
const R = { x0: 30, x1: 61, y0: 40, y1: 57, z0: 8, z1: 19 }, PIT = { x0: 36, x1: 55, y0: 49, y1: 56, z: 30 };
function build(zCap = Infinity): StaticVoxels {
  const s = new StaticVoxels(pal, W, D, 0, ZT - 1);
  for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
    const top = x >= PIT.x0 && x <= PIT.x1 && y >= PIT.y0 && y <= PIT.y1 ? PIT.z : TOP;
    for (let z = 0; z < Math.min(top, zCap); z++) {
      if (x >= R.x0 && x <= R.x1 && y >= R.y0 && y <= R.y1 && z >= R.z0 && z <= R.z1) continue;
      s.set(x, y, z, z === top - 1 ? material(1, 2 + ((x + y) & 1)) : material(0, 1 + ((x * 3 + y + z) % 3)));
    }
  }
  return s;
}
function body(): Model {
  const m = new Model(pal, 'cuerpo');
  for (let z = 0; z < 20; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) m.set(x, y, z, material(2, 1));
  return m;
}
const GX = 46, GY = 48;
type Ent = { x: number; y: number; z: number };
function scene(opts: { lights?: WorldLight[]; ents?: Ent[]; zCap?: number; sky?: boolean } = {}) {
  const st = new WorldState(build(opts.zCap), opts.lights ?? [], null);
  for (const e of opts.ents ?? []) st.entities.add({ model: body(), x: e.x, y: e.y, z: e.z, facing: 0, castsShadow: true });
  const view = new WorldView(st, 0);
  const b = bakeWorld(view.bakeable(), { topZ: ZT, incline: 0.5, outline: 'both', sky: opts.sky ?? true });
  const cut = sectionAround(view.camera, GX, GY, R.z0, 32);
  const o: Frame2DOptions = { vx: 0, vy: 0, vw: b.width, vh: b.height, time: 0, lights: true, ambient: [0.9, 0.9, 0.9], cave: [0.3, 0.3, 0.35] };
  const shot = (c: SectionCut | null, more: Partial<Frame2DOptions> = {}) => frame2D(view.frame(), b, { ...o, ...more, ...(c ? { section: c } : {}) });
  return { st, view, b, cut, o, shot };
}
const ghost = (alpha: number, keepFacing = false) => ({ z: GZ, alpha, ...(keepFacing ? { keepFacing } : {}) });
const same = (a: ArrayLike<number>, c: ArrayLike<number>): number => { let n = 0; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], c[i])) n++; return n; };
// Los píxeles (índice en la vista entera) con velo de la capa
function veiled(b: { width: number }, L: SectionLayer): number[] {
  const out: number[] = [], g = L.ghost!;
  for (let j = 0; j < L.h; j++) for (let gx = L.x; gx < L.x + L.w; gx++) { const q = secIdx(L, gx, j); if (L.mask[q] === 1 && g.on[q]) out.push((L.y + j) * b.width + gx); }
  return out;
}

describe('la capa con ghost', () => {
  it('la superficie de delante no cambia ni un byte, y la segunda es la de un mundo sin lo de z >= ghost.z', () => {
    const { b, cut } = scene();
    const plain = sectionLayer(b, cut)!, L = sectionLayer(b, { ...cut, ghost: ghost(0.4) })!;
    expect(plain.ghost ?? null).toBeNull();
    for (const f of ['mask', 'rgba', 'depth', 'face', 'pick', 'sky', 'wy', 'back'] as const) expect(`${f}: ${same(plain[f]!, L[f]!)}`).toBe(`${f}: 0`);
    expect([L.x, L.y, L.w, L.h, L.count]).toEqual([plain.x, plain.y, plain.w, plain.h, plain.count]);
    const g = L.ghost!;
    expect(g.z).toBe(GZ);
    // Lleva velo justo lo sustituido cuyo vóxel está en z >= GZ
    let on = 0, tops = 0, none = 0;
    for (let q = 0; q < L.mask.length; q++) {
      const want = L.mask[q] === 1 && L.pick[q] === L.pick[q] && unkey(L.pick[q]!)[2] >= GZ;
      if (!!g.on[q] !== want) expect(`velo en ${q}`).toBe(`${want}`);
      if (!g.on[q]) { if (g.rgba[q * 4 + 3] || g.depth[q] !== Infinity || g.face[q] !== -1 || g.pick[q] === g.pick[q]) expect(`segunda superficie fuera del velo en ${q}`).toBe('vacía'); continue; }
      on++;
      if (g.pick[q] !== g.pick[q]) { none++; continue; }
      const [, , z] = unkey(g.pick[q]!);
      if (z >= GZ) expect(`el píxel ${q} ve un vóxel en z ${z}`).toBe(`por debajo de ${GZ}`);
      if (!(g.depth[q]! > L.depth[q]!)) expect(`la segunda superficie del píxel ${q} está a ${g.depth[q]}`).toBe(`detrás de ${L.depth[q]}`);
      if (z === GZ - 1 && g.face[q] === 4) tops++;
    }
    expect(on).toBe(g.count);
    expect(on).toBeGreaterThan(500);
    // (lo que destapa quitar el semiespacio: las caras de arriba de z = GZ - 1, que tenían roca encima)
    expect(tops).toBeGreaterThan(50);
    expect(none).toBeLessThan(on / 2);
    // Contra el mundo de verdad sin lo de z >= GZ: en cada píxel con velo se ve el mismo vóxel, por la misma cara y a la
    // misma profundidad (lo sustituido de su capa, o lo horneado si allí no se sustituye)
    const ref = scene({ zCap: GZ }), RL = sectionLayer(ref.b, cut)!;
    expect([ref.b.width, ref.b.height]).toEqual([b.width, b.height]);
    let cmp = 0, color = 0;
    for (let j = 0; j < L.h; j++) for (let gx = L.x; gx < L.x + L.w; gx++) {
      const q = secIdx(L, gx, j);
      if (!g.on[q] || g.pick[q] !== g.pick[q]) continue;
      const gy = L.y + j, rj = gy - RL.y, inR = gx >= RL.x && gx < RL.x + RL.w && rj >= 0 && rj < RL.h, rq = inR ? secIdx(RL, gx, rj) : -1;
      const sub = rq >= 0 && RL.mask[rq] === 1, gi = gy * b.width + gx;
      const pk = sub ? RL.pick[rq]! : ref.b.pick[gi]!, fc = sub ? RL.face[rq]! : ref.b.face[gi]!, dp = sub ? RL.depth[rq]! : ref.b.depth[gi]!;
      if (g.pick[q] !== pk || g.face[q] !== fc || g.depth[q] !== dp) expect(`píxel ${gx},${gy}: ${unkey(g.pick[q]!)} cara ${g.face[q]} a ${g.depth[q]}`).toBe(`${pk === pk ? unkey(pk) : 'nada'} cara ${fc} a ${dp}`);
      cmp++;
      const rc = sub ? RL.rgba.subarray(rq * 4, rq * 4 + 3) : ref.b.rgba.subarray(gi * 4, gi * 4 + 3);
      if (g.rgba[q * 4] === rc[0] && g.rgba[q * 4 + 1] === rc[1] && g.rgba[q * 4 + 2] === rc[2]) color++;
    }
    expect(cmp).toBeGreaterThan(400);
    // (el color, salvo contornos y costuras)
    expect(color / cmp).toBeGreaterThan(0.9);
  });

  it('keepFacing: las caras verticales que miran a la cámara no llevan velo', () => {
    const { b, cut } = scene();
    const all = sectionLayer(b, { ...cut, ghost: ghost(0.4) })!, keep = sectionLayer(b, { ...cut, ghost: ghost(0.4, true) })!;
    let facing = 0;
    for (let q = 0; q < all.mask.length; q++) {
      const f = all.face[q] === FACING;
      if (all.ghost!.on[q] && f) facing++;
      if (!!keep.ghost!.on[q] !== (!!all.ghost!.on[q] && !f)) expect(`velo con keepFacing en ${q} (cara ${all.face[q]})`).toBe(`${!!all.ghost!.on[q] && !f}`);
    }
    expect(facing).toBeGreaterThan(200);
    expect(keep.ghost!.count).toBe(all.ghost!.count - facing);
    expect(keep.ghost!.keepFacing).toBe(true);
  });

  it('sin nada en z >= ghost.z no hay segunda superficie; y la caché de frame2D repinta con z o keepFacing, no con alpha', () => {
    const { b, cut, o } = scene();
    expect(sectionLayer(b, { ...cut, ghost: { z: TOP + 5, alpha: 0.5 } })!.ghost ?? null).toBeNull();
    const a = sectionFor(b, { ...o, section: { ...cut, ghost: ghost(0.4) } })!;
    const a2 = sectionFor(b, { ...o, section: { ...cut, ghost: ghost(0.7) } })!;
    expect(a2).toBe(a);
    expect(a.ghost!.alpha).toBe(0.7);
    expect(sectionFor(b, { ...o, section: { ...cut, ghost: { z: GZ + 4, alpha: 0.7 } } })).not.toBe(a);
    const k = sectionFor(b, { ...o, section: { ...cut, ghost: ghost(0.7, true) } })!;
    expect(k.ghost!.keepFacing).toBe(true);
    expect(sectionFor(b, { ...o, section: cut })!.ghost ?? null).toBeNull();
  });

  it('lo que se pica, lo que ve un agente y entityAt son los de sin ghost', () => {
    const ents = [{ x: 46, y: 52, z: R.z0 }, { x: 40, y: 44, z: R.z0 }];
    const { st, view, b, cut } = scene({ ents });
    const plain = sectionLayer(b, cut)!, L = sectionLayer(b, { ...cut, ghost: ghost(0.3) })!;
    const grid = new BlockGrid(st, new BlockSet('prueba', 8, pal));
    let section: SectionLayer | null = plain;
    const host = new AgentHost({ state: st, grid, look: (): AgentLook => ({ view, baked: b, section, frame: { lights: false } }) });
    const cells = () => JSON.stringify([...host.visibleCells()!.entries()].sort((p, q) => (p[0] < q[0] ? -1 : 1)));
    const ents0: string[] = [], picks0: string[] = [];
    const v0 = cells();
    for (let sy = 0; sy < b.height; sy += 1) for (let sx = 0; sx < b.width; sx += 1) { picks0.push(JSON.stringify(pickVoxel(view, b, sx, sy, plain))); ents0.push(JSON.stringify(host.entityAt(sx, sy))); }
    section = L;
    expect(cells()).toBe(v0);
    let k = 0, found = 0;
    for (let sy = 0; sy < b.height; sy += 1) for (let sx = 0; sx < b.width; sx += 1, k++) {
      if (JSON.stringify(pickVoxel(view, b, sx, sy, L)) !== picks0[k]) expect(`pickVoxel en ${sx},${sy}`).toBe('igual');
      const e = JSON.stringify(host.entityAt(sx, sy));
      if (e !== ents0[k]) expect(`entityAt en ${sx},${sy}: ${e}`).toBe(ents0[k]);
      if (e.includes('"id"')) found++;
    }
    expect(found).toBeGreaterThan(50);
  });
});

describe('el cuadro con ghost', () => {
  const fogOf = { focusZ: 30, start: 2, full: 20, color: [40, 60, 90] as const, strength: 0.7 };
  const lights: WorldLight[] = [
    { id: 'fija', kind: 'torch', x: 46.5, y: 54.5, z: 14, baked: true },
    { id: 'suelta', kind: 'torch', x: 52.5, y: 52.5, z: 34, baked: false },
  ];

  for (const mode of ['sin luces', 'con luces', 'con luces y niebla'] as const) it(`apagado y con alpha 1, el cuadro de siempre; con otra alpha, la mezcla exacta de alpha 0 y alpha 1 (${mode})`, () => {
    const { b, cut, shot } = scene({ lights: mode === 'sin luces' ? [] : lights });
    const more: Partial<Frame2DOptions> = { ...(mode === 'sin luces' ? { lights: false } : {}), ...(mode === 'con luces y niebla' ? { fog: fogOf } : {}) };
    const plain = shot(cut, more);
    expect(same(shot({ ...cut, ghost: null }, more), plain)).toBe(0);
    expect(same(shot({ ...cut, ghost: { z: TOP + 5, alpha: 0.5 } }, more), plain)).toBe(0);
    expect(same(shot({ ...cut, ghost: ghost(1) }, more), plain)).toBe(0);
    const back = shot({ ...cut, ghost: ghost(0) }, more);
    const L = sectionLayer(b, { ...cut, ghost: ghost(0) })!, at = new Set(veiled(b, L));
    // Con alpha 0 solo cambian píxeles con velo, y casi todos (detrás hay otra cosa)
    let diff = 0;
    for (let t = 0; t < b.width * b.height; t++) {
      const d = back[t * 4] !== plain[t * 4] || back[t * 4 + 1] !== plain[t * 4 + 1] || back[t * 4 + 2] !== plain[t * 4 + 2];
      if (d && !at.has(t)) expect(`el píxel ${t % b.width},${Math.floor(t / b.width)} cambia`).toBe('sin velo');
      if (d) diff++;
    }
    expect(diff).toBeGreaterThan(at.size * 0.7);
    for (const alpha of [0.25, 0.5, 0.8]) {
      const px = shot({ ...cut, ghost: ghost(alpha) }, more), k = ghostMix(alpha);
      for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) {
        const want = Math.floor(back[i + c]! + (plain[i + c]! - back[i + c]!) * k + 0.5);
        if (px[i + c] !== want) expect(`alpha ${alpha}, píxel ${(i / 4) % b.width},${Math.floor(i / 4 / b.width)}, canal ${c}: ${px[i + c]}`).toBe(`${want}`);
      }
      expect(px.filter((_, i) => i % 4 === 3 && px[i] !== 255).length).toBe(0);
    }
    expect(ghostMix(0.5)).toBe(0.5);
    expect(ghostMix(2)).toBe(1);
    expect(ghostMix(-1)).toBe(0);
  });

  it('una entidad delante del vóxel sale opaca; entre las dos superficies, a través del velo; detrás de la segunda, no se ve', () => {
    const E = { entre: { x: 46, y: 52, z: R.z0 }, delante: { x: 46, y: 44, z: R.z0 }, detras: { x: 60, y: 75, z: -4 } };
    for (const lit of [false, true]) {
      const more: Partial<Frame2DOptions> = lit ? {} : { lights: false };
      const none = scene({ lights });
      const L = sectionLayer(none.b, { ...none.cut, ghost: ghost(0) })!, at = new Set(veiled(none.b, L));
      const px = (f: Uint8ClampedArray, t: number) => `${f[t * 4]},${f[t * 4 + 1]},${f[t * 4 + 2]}`;
      for (const which of ['entre', 'delante', 'detras'] as const) {
        const one = scene({ lights, ents: [E[which]] });
        // Dónde se pinta el cuerpo: lo que cambia sin luces al ponerlo (sin luces no hay sombras), sin ghost y con alpha 0
        const bodyPlain: number[] = [], bodyBack: number[] = [];
        const p0 = none.shot(none.cut, { lights: false }), p1 = one.shot(one.cut, { lights: false });
        const g0 = none.shot({ ...none.cut, ghost: ghost(0) }, { lights: false }), g1 = one.shot({ ...one.cut, ghost: ghost(0) }, { lights: false });
        for (let t = 0; t < none.b.width * none.b.height; t++) { if (px(p0, t) !== px(p1, t)) bodyPlain.push(t); if (px(g0, t) !== px(g1, t)) bodyBack.push(t); }
        const plain = one.shot(one.cut, more), a0 = one.shot({ ...one.cut, ghost: ghost(0) }, more), a1 = one.shot({ ...one.cut, ghost: ghost(1) }, more);
        const mid = one.shot({ ...one.cut, ghost: ghost(0.5) }, more), k = ghostMix(0.5);
        // Con alpha 1 el velo lo tapa todo: el cuadro de sin ghost
        expect(`${which}, alpha 1: ${same(a1, plain)}`).toBe(`${which}, alpha 1: 0`);
        const through = bodyBack.filter((t) => !bodyPlain.includes(t));
        if (which === 'entre') {
          // Asoma por detrás de la roca de encima de la sala: sin ghost no se ve ahí; con ghost, sí, y con velo
          expect(through.length).toBeGreaterThan(20);
          for (const t of through) {
            if (!at.has(t)) expect(`el píxel ${t} enseña la entidad`).toBe('con velo');
            for (let c = 0; c < 3; c++) {
              const want = Math.floor(a0[t * 4 + c]! + (plain[t * 4 + c]! - a0[t * 4 + c]!) * k + 0.5);
              if (mid[t * 4 + c] !== want) expect(`píxel ${t}, canal ${c}: ${mid[t * 4 + c]}`).toBe(`${want}`);
            }
            if (!lit && px(a0, t) !== '208,64,64') expect(`píxel ${t} con alpha 0: ${px(a0, t)}`).toBe('el color del cuerpo');
          }
        } else if (which === 'delante') {
          // De pie dentro de la caja, delante de la roca con velo: opaca con cualquier alpha
          const over = bodyPlain.filter((t) => at.has(t));
          expect(over.length).toBeGreaterThan(20);
          expect(through.length).toBe(0);
          for (const t of over) for (const f of [a0, mid]) if (px(f, t) !== px(plain, t)) expect(`píxel ${t}: ${px(f, t)}`).toBe(px(plain, t));
        } else {
          // Dentro de la roca de detrás: no se ve ni sin ghost ni con él
          expect(bodyPlain.length).toBe(0);
          expect(bodyBack.length).toBe(0);
          // (con luces su sombra de contacto sí cae donde caen sus pies en la imagen, como sin ghost)
          if (!lit) expect(same(a0, none.shot({ ...none.cut, ghost: ghost(0) }, more))).toBe(0);
        }
      }
    }
  });

  it('la sombra de contacto de una entidad cae también sobre el velo: con alpha 1, el cuadro de sin ghost', () => {
    // En el aire dentro de la caja, con los pies (en la imagen) sobre la roca con velo
    // (con una luz delante de esa roca: la sombra de contacto solo se nota donde la luz pasa del ambiente)
    const front: WorldLight[] = [{ id: 'frente', kind: 'torch', x: 40.5, y: 44.5, z: 26, baked: false }];
    const ent = { x: 46, y: 44, z: 26 }, none = scene({ lights: front }), one = scene({ lights: front, ents: [ent] });
    const L = sectionLayer(none.b, { ...none.cut, ghost: ghost(1) })!, at = new Set(veiled(none.b, L));
    const p0 = none.shot(none.cut), p1 = one.shot(one.cut);
    let dark = 0;
    for (const t of at) if (p1[t * 4] !== p0[t * 4] || p1[t * 4 + 1] !== p0[t * 4 + 1] || p1[t * 4 + 2] !== p0[t * 4 + 2]) dark++;
    expect(dark).toBeGreaterThan(20);
    expect(same(one.shot({ ...one.cut, ghost: ghost(1) }), p1)).toBe(0);
  });

  it('sobre fondo transparente, el velo donde detrás no hay nada lleva alfa = alpha', () => {
    const { b, cut, shot } = scene();
    const c = { ...cut, depth: 3, fill: null }, more = { background: 'transparent' as const };
    const plain = shot(c, more), k = ghostMix(0.4), a = Math.floor(k * 255 + 0.5);
    const px = shot({ ...c, ghost: ghost(0.4) }, more), L = sectionLayer(b, { ...c, ghost: ghost(0.4) })!, at = new Set(veiled(b, L));
    let half = 0;
    for (let t = 0; t < b.width * b.height; t++) {
      const al = px[t * 4 + 3]!;
      if (al === a) {
        half++;
        if (!at.has(t)) expect(`píxel ${t} con alfa ${al}`).toBe('con velo');
        for (let ch = 0; ch < 3; ch++) if (px[t * 4 + ch] !== plain[t * 4 + ch]) expect(`píxel ${t}, canal ${ch}: ${px[t * 4 + ch]}`).toBe(`${plain[t * 4 + ch]}`);
      } else if (al !== 0 && al !== 255) expect(`alfa ${al} en el píxel ${t}`).toBe(`0, 255 o ${a}`);
    }
    expect(half).toBeGreaterThan(200);
    // (y la escena con la segunda superficie es lo que entra en frame2D: sus píxeles con velo sin nada detrás)
    const S = sceneLayer(L)!;
    expect(S.ghost ?? null).toBeNull();
    expect(S.mask).toBe(L.mask);
  });
});
