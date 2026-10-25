// Desglose del cuadro 2D (medieval, vista con lago y MAIA dentro)
import { readFileSync } from 'node:fs';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { Model, render, camera, lightField3D } from '../src/core';
import { buildWorldState } from '../src/world/build';
import { bakeWorld, lightView } from '../src/world/bake';
import { buildLayers, applyLayers } from '../src/lighting/shade';
const maia = Model.fromJSON(JSON.parse(readFileSync('models/maia/maia.json', 'utf8')));
const { world, state } = buildWorldState(generateLayout(THEMES.medieval.spec, 7), 'medieval');
const b = bakeWorld(world, { topZ: 40, incline: 0.5 });
const amb = THEMES.medieval.ambient;
const N = 30, T: Record<string, number> = {};
const time = (k: string, f: () => void) => { const t = performance.now(); f(); T[k] = (T[k] ?? 0) + performance.now() - t; };
const view = new Uint8ClampedArray(384 * 216 * 4), depth = new Float32Array(384 * 216);
for (let i = 0; i < N; i++) {
  let total!: Float32Array;
  time('luces del mundo (lightView)', () => { total = lightView(b, 0, 60, 384, 216, amb, i / 60); });
  const lo = { width: 48, height: 72, originX: 24, originY: 60, pivot: [0.5, 0, 0] as [number, number, number], yaw: 45, oblique: { y: 0.5, z: 1 }, flat: true, outline: 'none' as const, pick: true };
  let img!: ReturnType<typeof render>;
  time('render de MAIA', () => { img = render(maia, lo); });
  time('luz por cara de MAIA', () => { lightField3D(maia, img, camera(lo), [{ x: 0, y: 30, z: 20, radius: 110, color: [1, 0.6, 0.3], intensity: 1 }], amb, { floor: false }); });
  time('agua', () => { depth.fill(Infinity); state.water!.draw(b, view, depth, total, 0, 60, 384, 216, amb, i / 60, state.lights); });
  time('capas de luz (build+apply)', () => { applyLayers(view, buildLayers({ cell: 1, cols: 384, rows: 216, ambient: amb, total }, { x: 0, y: 0, width: 384, height: 216 }, { steps: 8, softGlow: true })); });
}
for (const [k, v] of Object.entries(T)) console.log(k.padEnd(30), (v / N).toFixed(2), 'ms');
