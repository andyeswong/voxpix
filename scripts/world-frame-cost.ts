// Coste por cuadro de los dos modos leyendo el MISMO estado del mundo (con MAIA, agua y gotas)
import { readFileSync } from 'node:fs';
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { Model } from '../src/core';
import { buildWorldState } from '../src/world/build';
import { bakeWorld } from '../src/world/bake';
import { frame2D } from '../src/world/frame2d';
import { frame3D } from '../src/world/frame3d';
const maia = Model.fromJSON(JSON.parse(readFileSync('models/maia/maia.json', 'utf8')));
for (const theme of ['medieval', 'cyberpunk', 'oficina'] as const) {
  const layout = generateLayout(THEMES[theme].spec, 7);
  const t0 = performance.now();
  const { world, state } = buildWorldState(layout, theme);
  const b = bakeWorld(world, { topZ: 40, incline: 0.5 });
  const tb = performance.now() - t0;
  const ex = 172, ey = world.depth - 1 - 170;
  const e = state.addEntity('maia', maia, ex, ey, state.groundAt(ex, ey), 45);
  const amb = THEMES[theme].ambient;
  let t2 = 0, t3 = 0;
  for (let f = 0; f < 60; f++) {
    if (f % 10 === 0) { state.water!.disturb(ex, ey, 1.5, 3); state.drops.splash(ex, ey, 1, 20, 80); }
    state.step();
    let t = performance.now();
    frame2D(state, b, { vx: 0, vy: 60, vw: 384, vh: 216, time: f / 60, lights: true, ambient: amb });
    t2 += performance.now() - t;
    if (f % 6 === 0) { t = performance.now(); frame3D(state, { width: 384, height: 216, center: [e.x, e.y], radius: 72, yaw: -30, elevation: 35, zoom: 3, time: f / 60, lights: true, ambient: amb }); t3 += performance.now() - t; }
  }
  console.log(theme, `horneado ${tb.toFixed(0)} ms`, `cuadro 2D ${(t2 / 60).toFixed(1)} ms`, `cuadro vóxel ${(t3 / 10).toFixed(0)} ms`);
}
