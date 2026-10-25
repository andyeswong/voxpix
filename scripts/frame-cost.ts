// Coste por cuadro de la demo del escenario: luces (con parpadeo) + capas del juego sobre una vista de 384x216
import { generateLayout } from '../src/worldgen';
import { THEMES } from '../src/content/themes';
import { buildWorld } from '../src/world/build';
import { bakeWorld, lightView } from '../src/world/bake';
import { buildLayers, applyLayers } from '../src/lighting/shade';
for (const theme of ['medieval', 'cyberpunk', 'oficina'] as const) {
  const b = bakeWorld(buildWorld(generateLayout(THEMES[theme].spec, 7), theme));
  const a = THEMES[theme].ambient;
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) {
    const total = lightView(b, 100, 40, 384, 216, a, i / 60);
    const view = b.rgba.slice(0, 384 * 216 * 4);
    applyLayers(view, buildLayers({ cell: 1, cols: 384, rows: 216, ambient: a, total }, { x: 0, y: 0, width: 384, height: 216 }, { steps: 8, softGlow: true }));
  }
  console.log(theme, 'cuadro', ((performance.now() - t0) / 60).toFixed(1), 'ms', 'horneado', b.ms);
}
