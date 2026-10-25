// Coste por cuadro del agua de la demo: simulación (2 pasos de 1/120 s) + dibujo en una vista de 384x216
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorld } from '../src/world/build';
import { bakeWorld } from '../src/world/bake';
import { WaterLayer } from '../src/world/water';
for (const theme of ['medieval', 'cyberpunk', 'oficina'] as const) {
  const layout = generateLayout(THEMES[theme].spec, 7);
  const world = buildWorld(layout, theme);
  const b = bakeWorld(world);
  const w = new WaterLayer(world, theme);
  const vol0 = w.sim.totalVolume();
  const view = b.rgba.slice(0, 384 * 216 * 4), depth = new Float32Array(384 * 216).fill(Infinity), total = new Float32Array(384 * 216 * 3);
  let tSim = 0, tDraw = 0;
  for (let f = 0; f < 120; f++) {
    if (f % 6 === 0) w.disturb(170, world.depth - 1 - 170, 0.5);
    let t0 = performance.now(); w.step(1 / 60); tSim += performance.now() - t0;
    t0 = performance.now(); w.draw(b, view, depth, total, 0, 60, 384, 216, THEMES[theme].ambient, f / 60, world.lights); tDraw += performance.now() - t0;
  }
  console.log(theme, `sim ${(tSim / 120).toFixed(2)} ms`, `dibujo ${(tDraw / 120).toFixed(2)} ms`, `volumen ${vol0.toFixed(0)} -> ${w.sim.totalVolume().toFixed(0)}`);
}
