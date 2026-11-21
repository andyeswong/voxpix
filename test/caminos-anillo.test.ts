// LevelPathField en anillo: shift corre el origen y limpia la franja que entra, sin copiar las rejillas. Con
// corrimientos que dan la vuelta al anillo varias veces, en las dos direcciones y en diagonal, uno mayor que el campo y
// picados sin tomar antes de correr, da lo mismo que un campo hecho de nuevo en ese sitio: los suelos de cada celda y
// los caminos (con la búsqueda de una vez y repartida). Y no copia: ninguna rejilla pasa por copyWithin al correrse (con
// copia, en una ventana de 11 x 13 trozos eran ~30 MB cada vez, y el primero pagaba además la memoria nueva)
import { describe, it, expect, vi } from 'vitest';
import { material } from '../src/core';
import { CHUNK, StaticVoxels, WorldState } from '../src/world/state';
import { LevelPathField, type LevelPoint } from '../src/world/levelpaths';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#606060', '#a0a0a0'] }] };
const C = 6, R = 5, W = C * CHUNK, D = R * CHUNK, Z = 47;
// El mundo, por coordenadas globales: suelo ondulado, un túnel este-oeste cada 40 vóxeles de y (dos suelos encima) y
// pozos que bajan a él
function solid(x: number, y: number, z: number): boolean {
  const top = 30 + Math.round(4 * Math.sin(x / 7) + 3 * Math.cos(y / 9));
  if (z >= top) return false;
  const ty = ((y % 40) + 40) % 40, tunnel = ty >= 12 && ty < 22 && z >= 6 && z < 20;
  const shaft = tunnel && ((x % 48) + 48) % 48 < 6 && z >= 6;
  const well = ty >= 12 && ty < 22 && ((x % 48) + 48) % 48 < 6 && z >= 20;
  return !tunnel && !shaft && !well;
}
function writeChunk(s: StaticVoxels, cx: number, cy: number, gx: number, gy: number): void {
  for (let y = cy * CHUNK; y < (cy + 1) * CHUNK; y++) for (let x = cx * CHUNK; x < (cx + 1) * CHUNK; x++)
    for (let z = 0; z <= Z; z++) s.set(x, y, z, solid(gx + x, gy + y, z) ? material(0, 1) : 0);
}
const O = { cell: 4, radius: 1, height: 10, step: 8, maxDrop: 32, reach: Infinity };

describe('caminos por niveles: el anillo', () => {
  it('corrido de muchas maneras, queda como uno hecho de nuevo en ese sitio', () => {
    const s = new StaticVoxels(PAL, W, D, 0, Z), st = new WorldState(s, [], null);
    let gx = 0, gy = 0;
    for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) writeChunk(s, cx, cy, gx, gy);
    const f = new LevelPathField(st, O), slow = new LevelPathField(st, { ...O, budget: 50 });
    const dug = new Set<string>();
    // En trozos: vueltas enteras al anillo en x (6 trozos) y en y (5), diagonales y uno mayor que el campo
    const moves: Array<[number, number]> = [[1, 0], [2, 0], [0, 1], [1, 1], [-1, 2], [3, -1], [-2, -2], [0, -3], [7, 0], [1, 0], [2, 3], [-4, 1], [0, 6], [-1, 0], [5, -4]];
    let k = 0;
    for (const [dcx, dcy] of moves) {
      // Consultas antes (distancias y pasos guardados que se corren) y una búsqueda repartida a medias
      const goal: LevelPoint = { x: W / 2, y: D / 2, z: 40 };
      f.path({ x: 6, y: 6, z: 40 }, goal);
      slow.dir({ x: W - 6, y: D - 6, z: 40 }, goal); slow.advance();
      // Un picado sin tomar: el aviso se corre con el campo
      const px = 8 + (k * 13) % (W - 16), py = 8 + (k * 7) % (D - 16);
      for (let z = 20; z <= Z; z++) for (let y = py; y < py + 4; y++) for (let x = px; x < px + 4; x++) { s.set(x, y, z, 0); dug.add(`${gx + x},${gy + y},${z}`); }
      k++;
      // Correr (lo de (cx, cy) pasa al (cx - dcx, cy - dcy)) y escribir lo que entra, con lo picado
      s.shift(dcx, dcy); f.shift(dcx * CHUNK, dcy * CHUNK); slow.shift(dcx * CHUNK, dcy * CHUNK);
      gx += dcx * CHUNK; gy += dcy * CHUNK;
      for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) {
        const ox = cx + dcx, oy = cy + dcy;
        if (ox >= 0 && oy >= 0 && ox < C && oy < R) continue;
        writeChunk(s, cx, cy, gx, gy);
        for (const key of dug) {
          const [x, y, z] = key.split(',').map(Number) as [number, number, number], lx = x - gx, ly = y - gy;
          if (Math.floor(lx / CHUNK) === cx && Math.floor(ly / CHUNK) === cy) s.set(lx, ly, z, 0);
        }
      }
    }
    // Pasos guardados que caducan a través de la costura del anillo: se busca (y se guarda canMove) desde muchos sitios, y
    // después un muro de x 62..69 (la costura en x queda en la celda 16, x 64..67, tras estos corrimientos) que sube hasta
    // arriba, con un hueco en y 60..71: los pasos guardados que lo subían ya no valen
    const goal0: LevelPoint = { x: 10, y: 34, z: 40 };
    slow.dir({ x: 2, y: 2, z: 40 }, goal0);
    for (let n = 0; n < 100000 && !slow.advance(); n++);
    for (let y = 2; y < D; y += 7) for (let x = 2; x < W; x += 7) { f.path({ x, y, z: 40 }, goal0); slow.path({ x, y, z: 40 }, goal0); }
    for (let y = 0; y < D; y++) for (let x = 62; x < 70; x++) if (y < 60 || y >= 72) for (let z = 0; z <= Z; z++) s.set(x, y, z, material(0, 1));
    const ref = new LevelPathField(st, O);
    // Hacia la meta de antes del muro, desde todas partes: los mismos caminos (con pasos guardados que no caducaran,
    // cruzarían el muro)
    slow.dir({ x: 2, y: 2, z: 40 }, goal0);
    for (let n = 0; n < 100000 && !slow.advance(); n++);
    let wall = 0;
    for (let y = 2; y < D; y += 3) for (let x = 2; x < W; x += 3) {
      const p = ref.path({ x, y, z: 40 }, goal0);
      expect([x, y, f.path({ x, y, z: 40 }, goal0)]).toEqual([x, y, p]);
      expect([x, y, slow.path({ x, y, z: 40 }, goal0)]).toEqual([x, y, p]);
      if (p) wall++;
    }
    expect(wall).toBeGreaterThan(50);
    let bad = 0, floors = 0, two = 0;
    for (let y = 2; y < D; y += 4) for (let x = 2; x < W; x += 4) {
      const a = f.floorsAt({ x, y }), b = ref.floorsAt({ x, y }), c = slow.floorsAt({ x, y });
      if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(c) !== JSON.stringify(b)) bad++;
      floors += b.length; if (b.length > 1) two++;
    }
    expect(bad).toBe(0);
    expect(two).toBeGreaterThan(20);                        // (que haya celdas de dos suelos: el túnel)
    const goal: LevelPoint = { x: 42, y: 34, z: 40 };
    slow.dir({ x: 2, y: 2, z: 40 }, goal);
    for (let n = 0; n < 100000 && !slow.advance(); n++);
    let found = 0;
    for (let y = 2; y < D; y += 9) for (let x = 2; x < W; x += 11) for (const z of [40, 10]) {
      const p = ref.path({ x, y, z }, goal);
      expect([x, y, z, f.path({ x, y, z }, goal)]).toEqual([x, y, z, p]);
      expect([x, y, z, slow.path({ x, y, z }, goal)]).toEqual([x, y, z, p]);
      expect(f.dir({ x, y, z }, goal)).toEqual(ref.dir({ x, y, z }, goal));
      if (p) found++;
    }
    expect(found).toBeGreaterThan(20);
    expect(floors).toBeGreaterThan(0);
    f.close(); slow.close(); ref.close();
  });

  it('con budget, justo después de correr (sin advance), contesta con las distancias de antes corridas: nada de la franja que entra', () => {
    // La meta junto al lado que sale: sin limpiar la franja que entra, sus celdas (las que salieron, dando la vuelta)
    // tendrían distancias pequeñas junto al borde que entra, y los caminos irían a ellas
    for (const [dcx, dcy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [7, 0], [0, -6], [20, 0], [-3, -17], [200, 0], [0, -150], [0, 150], [-90, 77]] as const) {
      const s = new StaticVoxels(PAL, W, D, 0, Z), st = new WorldState(s, [], null);
      for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) writeChunk(s, cx, cy, 0, 0);
      const f = new LevelPathField(st, { ...O, budget: 50 });
      const goal: LevelPoint = { x: dcx > 0 ? 6 : dcx < 0 ? W - 6 : W / 2, y: dcy > 0 ? 6 : dcy < 0 ? D - 6 : D / 2, z: 40 };
      f.dir({ x: W / 2, y: D / 2, z: 40 }, goal);
      for (let n = 0; n < 100000 && !f.advance(); n++);
      s.shift(dcx, dcy); f.shift(dcx * CHUNK, dcy * CHUNK);
      const bx = dcx * CHUNK, by = dcy * CHUNK;
      const inBand = (p: { x: number; y: number }) => (bx > 0 && p.x >= W - bx) || (bx < 0 && p.x < -bx) || (by > 0 && p.y >= D - by) || (by < 0 && p.y < -by);
      const all = Math.abs(bx) >= W || Math.abs(by) >= D;
      let asked = 0;
      for (let y = 2; y < D; y += 5) for (let x = 2; x < W; x += 5) {
        if (inBand({ x, y }) && !all) continue;
        const p = f.path({ x, y, z: 40 }, { ...goal, x: goal.x - bx, y: goal.y - by });
        asked++;
        // (corrido más que el campo, todo es franja que entra: no queda ningún camino)
        if (all) {
          expect([dcx, dcy, x, y, p]).toEqual([dcx, dcy, x, y, null]);
          expect([dcx, dcy, x, y, f.dir({ x, y, z: 40 }, goal)]).toEqual([dcx, dcy, x, y, null]);
        }
        else expect([dcx, dcy, x, y, p?.find(inBand) ?? null]).toEqual([dcx, dcy, x, y, null]);
      }
      expect(asked).toBeGreaterThan(50);
      f.close();
    }
  });

  it('con budget, el borde que sale se rehace por advance (no en el corrimiento) y acaba como un campo hecho de nuevo', () => {
    // (lo que entra se escribe, como en la ventana; el borde del lado que sale solo lo rehace el corrimiento. Una dirección
    // por eje: con radius 6 cada campo cuesta)
    for (const [dcx, dcy] of [[-1, 0], [0, 1]] as const) {
      const s = new StaticVoxels(PAL, W, D, 0, Z), st = new WorldState(s, [], null);
      for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) writeChunk(s, cx, cy, 0, 0);
      // (radius 6: el cuerpo de una celda llega a las de al lado, y la del borde, a lo que había fuera)
      const O6 = { ...O, radius: 6 };
      const f = new LevelPathField(st, { ...O6, budget: 50 }), now = new LevelPathField(st, O6);
      const goal: LevelPoint = { x: W / 2, y: D / 2, z: 40 };
      f.path({ x: 6, y: 6, z: 40 }, goal); now.path({ x: 6, y: 6, z: 40 }, goal);
      s.shift(dcx, dcy); f.shift(dcx * CHUNK, dcy * CHUNK); now.shift(dcx * CHUNK, dcy * CHUNK);
      for (let cy = 0; cy < R; cy++) for (let cx = 0; cx < C; cx++) {
        const ox = cx + dcx, oy = cy + dcy;
        if (ox >= 0 && oy >= 0 && ox < C && oy < R) continue;
        writeChunk(s, cx, cy, dcx * CHUNK, dcy * CHUNK);
      }
      // (con budget se pone al día al consultarlo: una consulta y advance hasta acabar; sin budget, al consultar)
      f.dir({ x: 6, y: 6, z: 40 }, goal);
      for (let n = 0; n < 100000 && !f.advance(); n++);
      now.dir({ x: 6, y: 6, z: 40 }, goal);
      const ref = new LevelPathField(st, O6);
      for (let y = 1; y < D; y += 2) for (let x = 1; x < W; x += 2) {
        const r = ref.floorsAt({ x, y });
        if (JSON.stringify(now.floorsAt({ x, y })) !== JSON.stringify(r)) throw new Error(`${dcx},${dcy}: suelos en ${x},${y} (sin budget)`);
        if (JSON.stringify(f.floorsAt({ x, y })) !== JSON.stringify(r)) throw new Error(`${dcx},${dcy}: suelos en ${x},${y} (budget)`);
      }
      // (los caminos, en una muestra: con radius 6 cada búsqueda cuesta; los suelos ya van todos arriba)
      for (let y = 2; y < D; y += 37) for (let x = 2; x < W; x += 41) {
        const p = ref.path({ x, y, z: 40 }, goal);
        expect([dcx, dcy, x, y, now.path({ x, y, z: 40 }, goal)]).toEqual([dcx, dcy, x, y, p]);
        f.dir({ x, y, z: 40 }, goal);
        for (let n = 0; n < 100000 && !f.advance(); n++);
        expect([dcx, dcy, x, y, f.path({ x, y, z: 40 }, goal)]).toEqual([dcx, dcy, x, y, p]);
      }
      f.close(); now.close(); ref.close();
    }
  });

  it('shift no copia las rejillas: ningún copyWithin, en el tamaño de una ventana de 11 x 13 trozos', () => {
    const st = new WorldState(new StaticVoxels(PAL, 11 * 128, 13 * 128, 0, 15), [], null);
    const f = new LevelPathField(st, { cell: 4, levels: 4, radius: 1, height: 14, step: 8, maxDrop: 64, budget: 1000 });
    const typed = Object.getPrototypeOf(Uint8Array.prototype) as { copyWithin: (...a: unknown[]) => unknown };
    const spy = vi.spyOn(typed, 'copyWithin');
    try {
      for (const [dx, dy] of [[128, 0], [-128, 0], [0, 128], [128, -128], [11 * 128, 0]] as const) f.shift(dx, dy);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); f.close(); }
  });
});
