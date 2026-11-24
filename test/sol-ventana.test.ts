// El sol con la ventana viva: al correrse, lo que no está junto al borde cargado sale igual (el sol no mira nada de la ventana)
import { expect, it } from 'vitest';
import { material, type Palette } from '../src/core';
import { BlockSet, type VoxsetFile } from '../src/world/blocks';
import { FrameBudget } from '../src/view/budget';
import { LiveWindow } from '../src/world/live';
import { frame2D, type Frame2DOptions } from '../src/world/frame2d';
import { Weather } from '../src/world/weather';
import type { RegionSpec } from '../src/world/regiongen';

const B = 8, ids = ['piedra', 'hierba', 'tronco', 'hojas'];
const pal: Palette = { ramps: ids.map((name, i) => ({ name, colors: [`#${60 + i * 5}6060`, `#${70 + i * 5}7070`], ...(name === 'hojas' ? { material: 'follaje' } : {}) })) };
const cube = (r: number) => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) o.push([x, y, z, material(r, (x + y + z) % 2)]); return o; };
const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 't', size: B, palette: pal, blocks: ids.map((id, i) => ({ id, voxels: cube(i) })) } as VoxsetFile);
const T = (id: string) => set.index(id), leaves = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => [dx!, dy!, 4, T('hojas')] as [number, number, number, number]);
const SPEC: RegionSpec = { seed: 5, width: 48, depth: 48, height: 12, surface: { base: 5, amplitude: 3, scale: 6 }, strata: [{ material: T('hierba'), depth: 1 }, { material: T('piedra') }],
  scatter: [{ on: [T('hierba')], density: 0.08, spacing: 3, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('tronco')], ...leaves] }] };

it('correr la ventana al este no cambia el sol ni las nubes de lo que sigue a la vista', () => {
  const win = new LiveWindow({ blocks: set, spec: SPEC, nx: 7, ny: 9, chunk: 4, center: [0, 0], margin: 2, bake: { incline: 0.5, sky: true, outline: 'both' } });
  const bud = new FrameBudget(1e6), go = (x: number, y: number) => { for (let r = 0; r < 3; r++) { win.update(x, y, bud); for (let k = 0; k < 3000 && (win.busy || bud.pending); k++) bud.run(); } };
  go(16, 16);
  const weather = new Weather({ seed: 3, levels: { clouds: 0.5, wind: [0.4, 0] } });
  const shot = () => {
    const [lx, ly] = win.toLocal(16, 16), [sx, sy] = win.baked.cam.project(lx, ly, 48);
    const o: Frame2DOptions = { vx: Math.floor(sx) - 40, vy: Math.floor(sy) - 40, vw: 80, vh: 80, time: 0, lights: true, ambient: [0.35, 0.35, 0.4], weather: { weather, tick: 90, origin: win.toWorld(0, 0), camera: win.view.camera, sunlight: { color: [1, 0.9, 0.7], intensity: 0.5, dir: [0.4, -0.5, 0.7] } } };
    return [frame2D(win.view.frame(), win.baked, o), frame2D(win.view.frame(), win.baked, { ...o, weather: null })] as const;
  };
  const [sun, plain] = shot(), tx = win.tx0;
  expect(sun).not.toEqual(plain);
  go(80, 16);
  expect(win.tx0).not.toBe(tx);
  const [sun2, plain2] = shot();
  expect(plain2).toEqual(plain);
  expect(sun2).toEqual(sun);
});
