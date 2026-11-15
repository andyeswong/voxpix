// La luz de un bloque (emits.at) gira con el bloque, como sus vóxeles: puesto con cualquier yaw, sale de su llama. Y
// donde nada cambia (un bloque sin girar, o con la luz en el centro), los mismos bytes que antes: la escena de abajo da
// la huella y el horneado de 28f1e22, el commit anterior al giro de la luz, en los 4 cuartos
import { describe, it, expect } from 'vitest';
import { material, decode, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { bakeWorld } from '../src/world/bake';
import { WorldView, type Quarter } from '../src/world/view';
import { turnCell, turnPoint } from '../src/world/edit';

const N = 8;
const PAL: Palette = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c'] },
  { name: 'llama', colors: ['#a04010', '#f0a020', '#fff0a0'], emissive: true, material: 'atravesable' },
] };
const cube = () => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(0, 1 + ((x + y + z) % 3))]); return o; };

describe('la luz de un bloque gira con él', () => {
  it('turnPoint lleva un punto a donde turnCell lleva la celda que lo contiene, y el centro no se mueve', () => {
    for (const yaw of [0, 90, 180, 270] as const) for (const [x, y] of [[0.5, 0.5], [4.5, 0.5], [7.25, 3.75], [4, 4]]) {
      const [cx, cy] = turnCell(Math.floor(x!), Math.floor(y!), yaw), off = [yaw === 90 || yaw === 180 ? N : 0, yaw === 180 || yaw === 270 ? N : 0];
      const [px, py] = turnPoint(x!, y!, yaw, N);
      if (x === 4 && y === 4) { expect([px, py]).toEqual([4, 4]); continue; }
      expect(px).toBeGreaterThanOrEqual(cx + off[0]!); expect(px).toBeLessThanOrEqual(cx + off[0]! + 1);
      expect(py).toBeGreaterThanOrEqual(cy + off[1]!); expect(py).toBeLessThanOrEqual(cy + off[1]! + 1);
    }
  });

  it('un bloque con la luz en su cara sur, puesto con los 4 yaw: la luz cae en el centro de su llama girada', () => {
    // una pared de piedra con una brasa en la cara sur (la celda 4, 0, 4) y la luz en su centro
    const voxels = cube().filter(([, y]) => y >= 2).concat([[4, 0, 4, material(1, 2)]]);
    const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'cara', size: N, palette: PAL, blocks: [{ id: 'brasero', voxels, props: { emits: { kind: 'brazier', at: [4.5, 0.5, 4.5] } } }] });
    const where: Record<number, string> = {};
    for (const yaw of [0, 90, 180, 270] as const) {
      const s = new StaticVoxels(PAL, 3 * N, 3 * N, 0, 2 * N - 1), st = new WorldState(s, [], null), g = new BlockGrid(st, set);
      g.set(1, 1, 0, set.index('brasero'), yaw);
      const b = g.box(1, 1, 0), lights = st.lights.filter((l) => l.baked);
      let ember: [number, number, number] | null = null;
      for (let z = b.z0; z <= b.z1; z++) for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { const v = s.get(x, y, z); if (v && decode(v).ramp === 1) ember = [x, y, z]; }
      expect(lights).toHaveLength(1);
      expect([lights[0]!.x, lights[0]!.y, lights[0]!.z]).toEqual([ember![0] + 0.5, ember![1] + 0.5, ember![2] + 0.5]);
      where[yaw] = `${lights[0]!.x - b.x0},${lights[0]!.y - b.y0}`;
    }
    // 90 lleva lo que miraba al sur (-y) al este (+x): la cara sur, este, norte y oeste
    expect(where).toEqual({ 0: '4.5,0.5', 90: '7.5,4.5', 180: '3.5,7.5', 270: '0.5,3.5' });
  });

  it('donde nada cambia, la misma huella y los mismos bytes de luz que 28f1e22 en los 4 cuartos', () => {
    const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'huella', size: N, palette: PAL, blocks: [
      { id: 'piedra', voxels: cube() },
      // una antorcha con la llama en (4, 4, 4..6) y la luz en 4,5 / 4,5 / 5,5, fuera del centro del bloque, sin girar
      { id: 'antorcha', voxels: [[4, 4, 4, material(1, 1)], [4, 4, 5, material(1, 2)], [4, 4, 6, material(1, 2)]], props: { emits: { kind: 'torch', at: [4.5, 4.5, 5.5] } } },
      // la luz por defecto, en el centro de arriba: con cualquier giro en el mismo sitio
      { id: 'farol', voxels: [[3, 3, 0, material(1, 1)], [4, 3, 0, material(1, 1)], [3, 4, 0, material(1, 1)], [4, 4, 0, material(1, 1)], [3, 3, 1, material(1, 2)]], props: { emits: { kind: 'lamp' } } },
    ] });
    const C = 12, s = new StaticVoxels(PAL, C * N, C * N, 0, 4 * N - 1), st = new WorldState(s, [], null), g = new BlockGrid(st, set);
    const P = set.index('piedra'), A = set.index('antorcha'), F = set.index('farol');
    for (let by = 0; by < C; by++) for (let bx = 0; bx < C; bx++) g.set(bx, by, 0, P);
    for (let k = 2; k < 9; k++) { g.set(k, 6, 1, P); g.set(k, 6, 2, P); g.set(6, k, 1, P); }
    g.set(3, 3, 1, A); g.set(8, 4, 1, A); g.set(4, 9, 1, A); g.set(9, 9, 3, A);
    g.set(2, 8, 1, F, 0); g.set(9, 2, 1, F, 90); g.set(10, 7, 1, F, 180); g.set(5, 10, 1, F, 270);
    const fnv = (b: ArrayLike<number>) => { let h = 2166136261; for (let i = 0; i < b.length; i++) h = Math.imul(h ^ (b[i]! & 255), 16777619) >>> 0; return h.toString(16); };
    const got: string[] = [String(st.hash())];
    for (const q of [0, 1, 2, 3] as Quarter[]) {
      const v = new WorldView(st, q, {}), b = bakeWorld(v.bakeable(), { topZ: 4 * N + 8, incline: 0.5 });
      const w = new Float32Array(b.lights.flatMap((l) => [...l.weight]));
      got.push(`${q} ${fnv(b.rgba)} ${fnv(new Uint8Array(w.buffer))} ${b.lights.length}`);
    }
    // medido con 28f1e22 (bun scripts/huella-luz.ts, la misma escena, antes del cambio)
    expect(got).toEqual(['a23b6699', '0 b6509995 bd0385db 8', '1 7073433 ebb2a456 8', '2 69237077 fe52b5c 8', '3 b1f32e75 a2e4538d 8']);
  });
});
