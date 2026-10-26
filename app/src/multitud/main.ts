// Prueba de carga del compositor (NARUTO): el escenario con N entidades que andan en círculo con el walk de MAIA,
// para medir cuántas caben (un juego de hordas pide ~200). No es un juego: las mueve la vista, sin
// runtime. ?n=200  ?ruta=cpu  ?tema=oficina  ?sombras=0 (sin sombra de verdad)
//   ?antorchas=10: las 10 primeras llevan una antorcha (luz puntual que va con ellas)   ?linterna=1: y una linterna
//   ?luces=N: tope de luces por entidad (solo las N más cercanas la alumbran)   ?contorno=no: sin el contorno interior
import { generateLayout, TILE } from '../../../src/worldgen';
import { THEMES, type ThemeId } from '../../../src/samples/themes';
import { Model, type ModelFile } from '@core/index';
import { buildWorldState } from '../../../src/world/build';
import { bakeWorld } from '../../../src/world/bake';
import { createCompositor } from '../../../src/view/compositor';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import maiaFile from '../../../models/maia/maia.json';

const VW = 384, VH = 216;
const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 200);
const theme = (q.get('tema') ?? 'medieval') as ThemeId;
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;
const s = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
canvas.style.width = `${VW * s}px`; canvas.style.height = `${VH * s}px`;
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });

const maia = Model.fromJSON(maiaFile as unknown as ModelFile);
const walk = walkFrames(maia);
const layout = generateLayout(THEMES[theme].spec, 7);
const { world, state } = buildWorldState(layout, THEMES[theme].look);
const baked = bakeWorld(world, { topZ: 40, incline: 0.5, outline: q.get('contorno') === 'no' ? 'none' : 'both' });   // el estándar: contorno interior
const cx = layout.spawn.x, cy = world.depth - 1 - layout.spawn.y;
// Cada una en su órbita alrededor de la salida, a su velocidad
const orbits = Array.from({ length: N }, (_, k) => ({ r: 14 + 7 * Math.sqrt(k), a0: k * 2.39996, w: (k % 2 ? 1 : -1) * (0.25 + (k % 7) * 0.04) }));
const ids = orbits.map(() => state.entities.add({ model: walk[0]!, x: cx, y: cy, z: 1, castsShadow: q.get('sombras') !== '0' }));
// Luces que se mueven con ellas (para medir su coste): antorchas en la mano y una linterna
const torches = Math.min(N, Number(q.get('antorchas') ?? 0));
for (let k = 0; k < torches; k++) state.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: ids[k]!, offset: [6, -4, 14] } });
if (q.get('linterna') === '1' && ids.length) state.lights.add({ kind: 'lamp', x: 0, y: 0, z: 0, cone: 50, intensity: 1.6, radius: 90, follow: { entity: ids[ids.length - 1]!, offset: [0, -9, 14], dir: [0, -1, -0.3] } });

const feet = baked.cam.project(cx + 0.5, cy, 1);
const vx = Math.max(0, Math.min(baked.width - VW, Math.floor(feet[0]) - VW / 2));
const top = Math.floor(baked.cam.project(0, state.depth - 1 - 2 * TILE, 32)[1]);
const vy = Math.max(top, Math.min(baked.height - VH, Math.floor(feet[1]) - VH / 2));

// ?precalentar=1: los sprites del walk (8 cuadros x 8 rumbos, con su sombra) se suben antes del primer cuadro
// (Compositor.prewarm); =2, además, un primer cuadro tapado (sube el horneado y compila los shaders)
const warm = Number(q.get('precalentar') ?? 0);
let warmMs = 0;
const frameOpts = (t: number) => ({ vx, vy, vw: VW, vh: VH, time: t, lights: true, ambient: THEMES[theme].ambient, ...(q.get('luces') ? { entityLightCap: Number(q.get('luces')) } : {}) });
if (warm) {
  const w0 = performance.now();
  compositor.prewarm(baked, frameOpts(0), walk.map((model) => ({ model, casts: q.get('sombras') !== '0' })));
  if (warm >= 2) compositor.frame(state, baked, frameOpts(0));
  warmMs = performance.now() - w0;
}
// El primer cuadro y el peor (lo que se nota como tirón)
let first = -1, worst = 0, frames = 0;

let acc = 0, n = 0, avg = 0, upAvg = 0, upAcc = 0, simAcc = 0, simAvg = 0;
const pAcc = { baked: 0, entities: 0, casters: 0, water: 0, drops: 0 }, pAvg = { ...pAcc };
function loop(now: number): void {
  const t = now / 1000;
  const s0 = performance.now();
  orbits.forEach((o, k) => {
    const a = o.a0 + o.w * t;
    const x = Math.round(cx + Math.cos(a) * o.r * 1.6), y = Math.round(cy + Math.sin(a) * o.r);
    // Mira hacia donde anda (tangente), en octavos de vuelta como el runtime
    const dir = Math.atan2(Math.cos(a) * o.w, -Math.sin(a) * o.w * 1.6);
    const facing = ((Math.round((90 - (dir * 180) / Math.PI) / 45) * 45) % 360 + 360) % 360;
    state.entities.move(ids[k]!, x, y, state.groundAt(x, y), facing);
    state.entities.setModel(ids[k]!, walk[Math.floor((now / WALK_FRAME_MS) + k) % 8]!);
  });
  state.step();
  const t0 = performance.now();
  simAcc += t0 - s0;
  compositor.frame(state, baked, frameOpts(t));
  const ms = performance.now() - t0;
  if (first < 0) first = ms;
  if (++frames > 1) worst = Math.max(worst, ms);
  (window as unknown as { __multitud: unknown }).__multitud = { first, worst, warmMs, frames };
  acc += ms; upAcc += compositor.stats.uploadMs; n++;
  const pr = compositor.stats.parts;
  if (pr) for (const k of Object.keys(pAcc) as Array<keyof typeof pAcc>) pAcc[k] += pr[k];
  if (n === 30) {
    avg = acc / n; upAvg = upAcc / n; simAvg = simAcc / n;
    for (const k of Object.keys(pAcc) as Array<keyof typeof pAcc>) { pAvg[k] = pAcc[k] / n; pAcc[k] = 0; }
    acc = upAcc = simAcc = n = 0;
  }
  hud.textContent = `multitud: ${N} entidades · ${torches} antorchas${q.get('linterna') === '1' ? ' · linterna' : ''}${q.get('luces') ? ` · tope ${q.get('luces')} luces` : ''} · ${theme} · ruta ${compositor.kind}\ncuadro (CPU) ${avg.toFixed(1)} ms · de eso, preparar y subir ${upAvg.toFixed(1)} ms` +
    ` (horneado ${pAvg.baked.toFixed(1)}, entidades ${pAvg.entities.toFixed(1)}, sombras ${pAvg.casters.toFixed(1)}, agua ${pAvg.water.toFixed(1)}, gotas ${pAvg.drops.toFixed(1)})\nmover ${N} y step del mundo ${simAvg.toFixed(1)} ms` +
    `\nprimer cuadro ${first.toFixed(1)} ms · peor de los demás ${worst.toFixed(1)} ms${warm ? ` · precalentado ${warmMs.toFixed(0)} ms antes de empezar` : ''}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
