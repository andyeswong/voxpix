// ShallowWater en anillo: shift corre el origen y limpia la franja que entra (seca, quieta, de pared, fondo 0), sin
// copiar. Contra una simulación de referencia que se corre COPIANDO sus arrays (y limpia igual la franja), con
// corrimientos de todo tipo (vueltas enteras al anillo, diagonales, mayores que la rejilla), pasos entre medias,
// pisotones (disturb) y despertares (wake), y lo que entra "cargado" (fondo, paredes y agua) en las dos: el mismo estado
// byte a byte en el orden de la rejilla, las mismas celdas activas, el mismo flujo y la misma inclinación.
import { describe, it, expect, vi } from 'vitest';
import { ShallowWater } from '../src/fluid/shallow';

const W = 40, H = 30, DT = 1 / 60;
// El mundo por coordenadas globales (celdas): fondo ondulado, lagos y alguna pared
const groundAt = (x: number, y: number) => 6 + 3 * Math.sin(x / 5) + 2 * Math.cos(y / 4);
const wallAt = (x: number, y: number) => ((x * 7 + y * 13) % 29 === 0);
const lakeAt = (x: number, y: number) => (Math.sin(x / 9) + Math.cos(y / 7) > 0.9 ? 4 : 0);

// Pone en la celda (x, y) de la rejilla lo de la celda global (gx, gy)
function load(s: ShallowWater, x: number, y: number, gx: number, gy: number): void {
  const i = s.at(x, y);
  s.ground[i] = groundAt(gx, gy); s.solid[i] = wallAt(gx, gy) ? 1 : 0; s.depth[i] = s.solid[i] ? 0 : lakeAt(gx, gy);
}

// La referencia: corre copiando (lo de (x + dx, y + dy) a (x, y); lo que entra, como la franja del anillo)
function copyShift(s: ShallowWater, dx: number, dy: number): void {
  const st = s.exportState();
  const mv = <T extends Float32Array | Uint16Array | Uint8Array>(a: T, fill: number): T => {
    const out = a.slice() as T;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = x + dx, sy = y + dy;
      out[y * W + x] = sx >= 0 && sy >= 0 && sx < W && sy < H ? a[sy * W + sx]! : fill;
    }
    return out;
  };
  const ground = mv(s.ground, 0), solid = mv(s.solid, 1);
  s.importState({ depth: mv(st.depth, 0), fl: mv(st.fl, 0), fr: mv(st.fr, 0), ft: mv(st.ft, 0), fb: mv(st.fb, 0), awake: mv(st.awake, 0) });
  s.ground.set(ground); s.solid.set(solid);
}

// (active: las celdas activas son las del último paso; justo tras correr o importar, sin paso, no se comparan)
function same(a: ShallowWater, b: ShallowWater, what: string, active = true): void {
  const ea = a.exportState(), eb = b.exportState();
  for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake'] as const) {
    const x = ea[k], y = eb[k];
    let bad = -1;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) { bad = i; break; }
    expect([what, k, bad]).toEqual([what, k, -1]);
  }
  expect([what, Buffer.from(a.logical(a.ground).buffer).equals(Buffer.from(b.ground.buffer))]).toEqual([what, true]);
  expect([what, Buffer.from(a.logical(a.solid).buffer).equals(Buffer.from(b.solid.buffer))]).toEqual([what, true]);
  if (active) {
    expect([what, a.activeCount]).toEqual([what, b.activeCount]);
    const act = (s: ShallowWater) => [...s.activeCells()].map((i) => s.xy(i).join(',')).sort();
    expect([what, act(a)]).toEqual([what, act(b)]);
  }
  for (let y = 0; y < H; y += 3) for (let x = 0; x < W; x += 3) {
    expect([what, x, y, a.flow(x, y), a.slope(x, y)]).toEqual([what, x, y, b.flow(x, y), b.slope(x, y)]);
    expect(a.depth[a.at(x, y)]).toBe(b.depth[b.at(x, y)]);
  }
}

describe('agua en anillo (ShallowWater.shift)', () => {
  it('igual que correr copiando, con corrimientos de todo tipo, pasos, pisotones y lo que entra cargado', () => {
    const ring = new ShallowWater(W, H, { cell: 2, damping: 0.9 }), ref = new ShallowWater(W, H, { cell: 2, damping: 0.9 });
    let gx = 0, gy = 0;
    for (const s of [ring, ref]) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) load(s, x, y, x, y); s.wakeAll(); }
    const moves: Array<[number, number]> = [[3, 0], [0, 2], [-5, 1], [7, -4], [40, 0], [1, 1], [-2, -3], [0, -30], [13, 9], [-41, 2], [6, 31], [-1, 0], [20, 15], [0, 0], [2, -1]];
    let k = 0;
    for (const [dx, dy] of moves) {
      // Pasos con el agua moviéndose: un pisotón y un despertar en sitios que cambian
      for (let t = 0; t < 25; t++) {
        if (t === 3) for (const s of [ring, ref]) s.disturb(5 + (k * 7) % 30, 4 + (k * 5) % 22, 2, 1.5);
        if (t === 9) for (const s of [ring, ref]) s.wake(20 + (k * 3) % 15, 10 + (k * 11) % 15, 4);
        ring.step(DT); ref.step(DT);
      }
      same(ring, ref, `antes de ${dx},${dy}`);
      ring.shift(dx, dy); copyShift(ref, dx, dy);
      same(ring, ref, `después de ${dx},${dy} (sin cargar)`, false);
      gx += dx; gy += dy;
      // Lo que entra, cargado en las dos (y despierto, como un trozo que entra con agua)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const inBand = (dx > 0 && x >= W - dx) || (dx < 0 && x < -dx) || (dy > 0 && y >= H - dy) || (dy < 0 && y < -dy);
        if (!inBand) continue;
        for (const s of [ring, ref]) { load(s, x, y, gx + x, gy + y); if (s.depth[s.at(x, y)]! > 0) s.wake(x, y, 0); }
      }
      k++;
    }
    for (let t = 0; t < 40; t++) { ring.step(DT); ref.step(DT); }
    same(ring, ref, 'al final');
    expect(ring.origin).not.toEqual([0, 0]);
    expect(ring.totalVolume()).toBe(ref.totalVolume());
  });

  it('un escalón dormido junto a la costura del anillo se despierta como sin anillo (uphill, en las 4 direcciones)', () => {
    // Tras correr, la columna física 0 cae dentro de la rejilla: su vecina izquierda está al otro lado de los arrays. El
    // agua alta y dormida de un lado y la celda baja y despierta del otro: la dormida tiene que despertarse y bajar
    // (flip: lo alto al otro lado: la despierta es la de antes de la costura y mira hacia delante, R o B)
    for (const [dx, dy, axis, flip] of [[7, 0, 'x', false], [0, 5, 'y', false], [-9, 0, 'x', true], [0, -4, 'y', true]] as const) {
      const ring = new ShallowWater(W, H, { cell: 2 }), ref = new ShallowWater(W, H, { cell: 2 });
      ring.shift(dx, dy);
      // (la costura: la celda de la rejilla que cae en la columna o la fila física 0)
      const [sx, sy] = ring.xy(0);
      const seam = axis === 'x' ? sx : sy;
      expect(seam).toBeGreaterThan(0);
      for (const s of [ring, ref]) {
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = s.at(x, y), c = axis === 'x' ? x : y;
          s.ground[i] = 0; s.solid[i] = 0; s.depth[i] = (flip ? c >= seam : c < seam) ? 3 : 0;
        }
        // Despiertas solo las de junto a la costura del lado seco: lo alto, dormido
        const awake = flip ? seam - 1 : seam;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((axis === 'x' ? x : y) === awake) s.wake(x, y, 0);
      }
      for (let t = 0; t < 30; t++) { ring.step(DT); ref.step(DT); }
      same(ring, ref, `costura ${dx},${dy}`);
      // (y el agua pasó al otro lado de la costura)
      const dry = flip ? seam - 3 : seam + 2;
      expect(ref.depth[axis === 'x' ? ref.at(dry, 3) : ref.at(3, dry)]).toBeGreaterThan(0.05);
    }
  });

  it('la franja que entra es pared seca y quieta: el agua de junto al borde no sale por ella', () => {
    const s = new ShallowWater(W, H, { cell: 2 });
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = s.at(x, y); s.ground[i] = 0; s.depth[i] = 5; }
    s.wakeAll();
    for (let t = 0; t < 10; t++) s.step(DT);
    s.shift(4, 0);
    for (let y = 0; y < H; y++) for (let x = W - 4; x < W; x++) {
      const i = s.at(x, y);
      expect([x, y, s.depth[i], s.solid[i], s.ground[i]]).toEqual([x, y, 0, 1, 0]);
    }
    const v = s.totalVolume();
    for (let t = 0; t < 60; t++) s.step(DT);
    expect(Math.abs(s.totalVolume() - v)).toBeLessThan(1e-2);
    for (let y = 0; y < H; y++) for (let x = W - 4; x < W; x++) expect(s.depth[s.at(x, y)]).toBe(0);
  });

  it('exportState / importState en el orden de la rejilla: importar tras correr deja el origen en (0, 0)', () => {
    const a = new ShallowWater(W, H), b = new ShallowWater(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) load(a, x, y, x, y);
    a.wakeAll();
    for (let t = 0; t < 10; t++) a.step(DT);
    a.shift(7, -3);
    const st = a.exportState();
    b.ground.set(a.logical(a.ground)); b.solid.set(a.logical(a.solid)); b.importState(st);
    a.importState(st);
    expect(a.origin).toEqual([0, 0]);
    same(a, b, 'tras importar', false);
    for (let t = 0; t < 10; t++) { a.step(DT); b.step(DT); }
    same(a, b, 'y después');
  });

  it('shift no copia: ningún copyWithin ni set, en una rejilla del tamaño de una ventana de 11 x 13 trozos', () => {
    const s = new ShallowWater(11 * 64, 13 * 64, { cell: 2 });
    const typed = Object.getPrototypeOf(Float32Array.prototype) as { copyWithin: (...a: unknown[]) => unknown; set: (...a: unknown[]) => unknown };
    const cw = vi.spyOn(typed, 'copyWithin'), set = vi.spyOn(typed, 'set');
    try {
      for (const [dx, dy] of [[64, 0], [-64, 0], [0, 64], [64, -64], [11 * 64, 0]] as const) s.shift(dx, dy);
      expect(cw).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    } finally { cw.mockRestore(); set.mockRestore(); }
  });
});
