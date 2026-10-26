// Demo: un escenario generado (src/worldgen) en UN SOLO MUNDO de vóxeles (src/world/state.ts). Este fichero solo hace
// la vista: cámara, frame2D o frame3D e interfaz. El tick (entrada -> mover y colisión -> eventos -> world.step()) es
// el runtime (src/runtime/runtime.ts); el mundo guarda lo estático, el agua, las entidades (MAIA), las luces y las
// gotas, y los dos modos leen ese mismo estado.
import { generateLayout, TILE, type Layout } from '../../../src/worldgen';
import { THEMES, type ThemeId } from '../../../src/samples/themes';
import { Model, FX_PRESETS, type ModelFile } from '@core/index';
import { buildWorldState, DEFAULT_WALL_H, type World } from '../../../src/world/build';
import { bakeWorld, rebakeChangedJobs, type Baked } from '../../../src/world/bake';
import { FrameBudget } from '../../../src/view/budget';
import { walkFrames } from '../../../src/anim/walk';
import { createCompositor } from '../../../src/view/compositor';
import { frame3D } from '../../../src/world/frame3d';
import type { WorldState, Entity } from '../../../src/world/state';
import { FixedLoop, NO_INPUT, Runtime, type TickInput, type CarryConfig } from '../../../src/runtime/runtime';
import maiaFile from '../../../models/maia/maia.json';
import { decorate } from './decor';
import { buildSampleRecipe, type RecipeInput } from '../../../src/samples/recipes';
import type { WorldRecipe } from '../../../src/world/recipe';
import { restZ } from '../../../src/runtime/body';
import { installWorldApi } from './api';
import { WorldExplorer } from './explorar';
import linterna from '../../../models/luces/linterna.json';
import linternaNeon from '../../../models/luces/linterna-neon.json';
import antorcha from '../../../models/luces/antorcha.json';

// La luz que lleva MAIA en la mano en cada mundo: linterna (un foco) en la oficina y en cyberpunk, antorcha en el
// medieval. hand: dónde va el modelo respecto a los pies; emit: de dónde sale la luz respecto al modelo. ?luz=no la
// quita, para comparar.
const CARRY: Record<ThemeId, Omit<CarryConfig, 'model'> & { file: unknown }> = {
  oficina: { file: linterna, kind: 'lantern', cone: 40, intensity: 3, radius: 100, hand: [8, -2, 6], emit: [0, -7, 1] },
  medieval: { file: antorcha, kind: 'torch', hand: [8, -1, 5], emit: [0, 0, 8] },
  cyberpunk: { file: linternaNeon, kind: 'lantern', cone: 40, intensity: 1.8, color: [0.18, 0.9, 1], hand: [8, -2, 6], emit: [0, -7, 1] },
};
function carryFor(t: ThemeId): CarryConfig | undefined {
  if (q.get('luz') === 'no') return undefined;
  const { file, ...c } = CARRY[t];
  return { ...c, model: Model.fromJSON(file as ModelFile) };
}

const VW = 384, VH = 216;
const TOPZ = 40;
const THEME_IDS: ThemeId[] = ['medieval', 'cyberpunk', 'oficina'];
const q = new URLSearchParams(location.search);
// Inclinación del suelo (misma para escenario y personajes): 0.5 por defecto; 1 = losetas sin acortar como el juego
const INCLINE = Number(q.get('inclinacion') ?? 0.5);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;
const modeBtn = document.getElementById('mode') as HTMLButtonElement;
// ?embed: para meter la demo en otra página (la landing), sin el HUD de medidas ni los botones de encima; los mandos
// los pone la página de fuera con window.voxpixWorld. Las teclas siguen funcionando
if (q.has('embed')) {
  for (const el of [hud, modeBtn, document.getElementById('outline')]) if (el) el.style.display = 'none';
}
// Letrero visible cuando el modo 2D se compone en la CPU (sin WebGL2, o si se perdió el contexto): bajo detalle, sin
// sombras de verdad ni reflejos (MAIA no quiere que eso solo lo diga el '(cpu)' del HUD). Lo crea la escena, sin tocar
// el HTML.
const lowDetail = document.createElement('div');
lowDetail.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);padding:6px 12px;'
  + 'background:#1a1420e6;color:#ffd08a;border:1px solid #6a4a2a;font:13px system-ui,sans-serif;border-radius:4px;'
  + 'pointer-events:none;display:none;z-index:10';
document.body.appendChild(lowDetail);
function showRoute(): void {
  const cpu = mode === '2d' && compositor.kind === 'cpu';
  const text = !cpu ? '' : q.get('ruta') === 'cpu' ? 'Modo de bajo detalle (forzado con ?ruta=cpu)' : 'Sin aceleración gráfica: modo de bajo detalle';
  if (lowDetail.textContent !== text) lowDetail.textContent = text;
  const display = cpu ? 'block' : 'none';
  if (lowDetail.style.display !== display) lowDetail.style.display = display;
}
canvas.width = VW; canvas.height = VH;
// El modo 2D lo compone la GPU (WebGL2) o, sin ella, la CPU (src/view/compositor.ts). El modo vóxel pinta con la CPU
// en un lienzo 2D aparte: un lienzo con contexto WebGL no admite uno 2D.
// ?ruta=cpu fuerza la composición en la CPU (el fallback, y para medirla como antes); por defecto, la GPU si hay WebGL2
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });
const voxCanvas = document.createElement('canvas');
voxCanvas.width = VW; voxCanvas.height = VH;
voxCanvas.style.display = 'none';
canvas.after(voxCanvas);
const g = voxCanvas.getContext('2d')!;
function fit(): void {
  const s = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
  for (const c of [compositor.canvas, voxCanvas]) {
    c.style.width = `${VW * s}px`; c.style.height = `${VH * s}px`;
    c.style.marginTop = `${Math.max(0, (innerHeight - VH * s) / 2)}px`;
  }
}
addEventListener('resize', fit); fit();

const maiaModel = Model.fromJSON(maiaFile as unknown as ModelFile);
// El walk de MAIA es el de por defecto desde que Andrés lo aprobó ("me encanta el walk", "está precioso");
// ?anim=quieto anda con el modelo quieto y el bote de 1 px, para comparar
const WALK = q.get('anim') !== 'quieto';

// ---- estado de la demo (el del juego vive en `state`)
let theme: ThemeId = (THEME_IDS.includes(q.get('tema') as ThemeId) ? q.get('tema') : 'medieval') as ThemeId;
let seed = Number(q.get('seed') ?? 7);
let lightsOn = true;
// Contorno (como el de VoxPix): exterior, exterior + interior (los saltos de profundidad: paredes, columnas) o ninguno.
// Cada uno, con el tono más oscuro de la rampa vecina (como VoxPix) o marcado: casi negro. El estándar es interior.
// ?contorno=exterior|exterior-negro|interior|interior-negro|no
const INK = '#0d0c12';
const OUTLINES = [
  { name: 'exterior', id: 'outer', color: undefined }, { name: 'exterior-negro', id: 'outer', color: INK },
  { name: 'interior', id: 'both', color: undefined }, { name: 'interior-negro', id: 'both', color: INK },
  { name: 'no', id: 'none', color: undefined },
] as const;
let outlineIx = Math.max(0, OUTLINES.findIndex((o) => o.name === (q.get('contorno') ?? 'interior')));   // el estándar (Andrés): contorno interior
let outline: 'outer' | 'both' | 'none' = OUTLINES[outlineIx]!.id;
let outlineColor: string | undefined = OUTLINES[outlineIx]!.color;
let layout: Layout = generateLayout(THEMES[theme].spec, seed);
let world: World | null = null;
let state: WorldState | null = null;
let baked: Baked | null = null;
let maia: Entity | null = null;
let mode: '2d' | 'voxel' = q.get('modo') === 'voxel' ? 'voxel' : '2d';
// X: explorar en primera persona (explorar.ts) desde donde está MAIA. +/-: la altura del personaje invisible
const explorer = new WorldExplorer();
let exploreHeight = Number(q.get('altura') ?? 1);
const vox = { yaw: -30, elevation: 35, zoom: 3, dirty: true };
let runtime: Runtime | null = null;
let ticks: FixedLoop | null = null;
let moving = false;            // para el bote al andar (vista)
let stomp = false;             // Espacio: se gasta en el siguiente tick
const keys = new Set<string>();
let bakeMs = 0;
let deco = q.get('deco') !== 'no';     // ?deco=no: el escenario sin vegetación ni vidrio (G lo cambia)
// Efectos (src/core/effects.ts): brasas en antorchas y braseros, polvo al pisar, chispas (E) y el tiempo (N: nada,
// lluvia, nieve; cyberpunk empieza con lluvia). F los apaga: la partida es la misma (los visuales no tocan la huella).
// ?efectos=no arranca sin ellos; ?tiempo=lluvia|nieve|nada
let fxOn = q.get('efectos') !== 'no';
const WEATHERS = ['nada', 'lluvia', 'nieve'] as const;
let weather: typeof WEATHERS[number] = 'nada';
let weatherId = 0;
// La receta de mundo que puso un agente (window.voxpixWorld.build): mientras la haya, el mundo sale de ella (y no del
// tema con su decoración). T vuelve a los temas
let recipe: (WorldRecipe & { theme?: ThemeId }) | null = null;
let ambient: readonly [number, number, number] = THEMES[theme].ambient;
let built: Array<() => void> = [];          // quien espera a que termine el rebuild en curso

function rebuild(): void {
  loading.style.display = 'flex';
  setTimeout(() => {
    const t0 = performance.now();
    if (recipe) {
      const b = buildSampleRecipe({ ...recipe, seed });
      ({ layout, world, state, ambient } = b);
      recipe = b.recipe;
      if (b.recipe.theme) theme = b.recipe.theme;
    } else {
      layout = generateLayout(THEMES[theme].spec, seed);
      ambient = THEMES[theme].ambient;
      // La decoración del tema (decor.ts): vegetación en el medieval, cubículos de vidrio en oficina y cyberpunk. G la quita
      const lay = layout;
      ({ world, state } = buildWorldState(layout, THEMES[theme].look, deco ? { decorate: (w) => decorate(w, theme, { x: lay.spawn.x, y: w.depth - 1 - lay.spawn.y }, seed) } : {}));
    }
    baked = bakeWorld(world, { topZ: TOPZ, incline: INCLINE, outline, outlineColor });
    // La salida viene del worldgen (filas hacia abajo): se pasa a ejes del modelo una vez, aquí
    let spawn = { x: layout.spawn.x, y: world.depth - 1 - layout.spawn.y };
    const pos = q.get('pos')?.split(',').map(Number);              // ?pos=x,y en ejes del modelo (y hacia el norte)
    if (pos && pos.length === 2 && pos.every(Number.isFinite)) spawn = { x: pos[0]!, y: pos[1]! };
    runtime = new Runtime(state, spawn, { radius: 4, speed: 70, model: maiaModel, walk: WALK ? walkFrames(maiaModel) : undefined, shadow: 'always', carry: carryFor(theme) });
    maia = state.entities.get(runtime.entityId!) ?? null;
    addEffects();
    if (q.get('dir')) { runtime.player.facing = Number(q.get('dir')) % 8; runtime.syncEntity(); }
    // Hasta 10 ticks por cuadro (un tick cuesta ~0,7 ms): el modo vóxel pinta a 8-10 fps y con el tope de 5 MAIA andaba
    // a cámara lenta. Por debajo de 6 fps la partida se frena en vez de encadenar cuadros más lentos
    ticks = new FixedLoop(runtime, input, 10);
    budget = new FrameBudget(3);       // los trabajos del mapa anterior no sirven para este
    bakeMs = Math.round(performance.now() - t0);
    vox.dirty = true;
    loading.style.display = 'none';
    if (explorer.on) { explorer.stop(); toggleExplore(); }        // explorando: se sigue en el mundo nuevo
    else if (q.get('explorar') === '1' && !exploredOnce) { exploredOnce = true; toggleExplore(); }
    const waiting = built; built = [];
    for (const f of waiting) f();
  }, 30);
}
let exploredOnce = false;

// Los efectos del escenario: brasas sobre las antorchas y braseros horneados (y humo en los braseros), y el tiempo
function addEffects(): void {
  if (!state) return;
  state.effectsOn = fxOn;
  for (const l of state.lights) {
    if (l.kind === 'torch') state.fx.add('brasas', l.x, l.y, l.z + 2);
    if (l.kind === 'brazier') { state.fx.add('brasas', l.x, l.y, l.z + 2); state.fx.add('humo', l.x, l.y, l.z + 6); }
  }
  weatherId = 0;
  const w = q.get('tiempo');
  setWeather((WEATHERS as readonly string[]).includes(w ?? '') ? w as typeof weather : theme === 'cyberpunk' ? 'lluvia' : 'nada');
}
// El tiempo cae sobre lo que se ve: un emisor que sigue a MAIA, del ancho de la vista
function setWeather(w: typeof weather): void {
  weather = w;
  if (!state) return;
  if (weatherId) { state.fx.remove(weatherId); weatherId = 0; }
  if (w === 'nada' || !maia) return;
  const base = w === 'lluvia' ? FX_PRESETS.lluvia : FX_PRESETS.nieve;
  // Más ancho que la vista (384 px ~ 384 vóxeles en x; el fondo, ~2 veces su alto por la inclinación), con el ritmo
  // escalado al área para que la densidad sea la del efecto ya hecho
  const ext = [210, 160, 0] as const;
  const rate = base.rate * (ext[0] * ext[1]) / (base.extent[0] * base.extent[1]) * (w === 'lluvia' ? 0.6 : 0.5);
  weatherId = state.fx.add({ ...base, extent: ext, rate }, maia.x, maia.y, maia.z + (w === 'lluvia' ? 48 : 40));
}

// La entrada de un tick, leída del teclado. En modo vóxel, las teclas van según la pantalla (arriba = alejarse de la
// cámara): se giran con el giro de la vista a los ejes del modelo.
function input(): TickInput {
  if (explorer.on) { moving = false; stomp = false; return { dx: 0, dy: 0, stomp: false }; }   // explorando, MAIA se queda quieta (Espacio salta)
  let dx = 0, dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx--;
  if (keys.has('d') || keys.has('arrowright')) dx++;
  if (keys.has('w') || keys.has('arrowup')) dy++;                 // arriba = norte = +y
  if (keys.has('s') || keys.has('arrowdown')) dy--;
  if (mode === 'voxel' && (dx || dy)) {
    const r = (vox.yaw * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    [dx, dy] = [dx * c + dy * s, -dx * s + dy * c];
  }
  moving = !!(dx || dy);
  // El pisotón levanta polvo (efecto visual: no entra en la partida)
  if (stomp && state && maia) state.fx.burst('polvo', maia.x + 0.5, maia.y, maia.z + 1);
  const t = { dx, dy, stomp };
  stomp = false;
  return t;
}

// Cámara del modo 2D: centrada en MAIA, sin pasar de la tapa de la pared norte
function viewOrigin(b: Baked, st: WorldState, m: Entity): { vx: number; vy: number } {
  const feet = b.cam.project(m.x + 0.5, m.y, m.z);
  const vx = Math.max(0, Math.min(b.width - VW, Math.floor(feet[0]) - VW / 2));
  const top = Math.floor(b.cam.project(0, st.depth - 1 - 2 * TILE, world?.wallHeight ?? DEFAULT_WALL_H)[1]);   // la tapa de la pared norte
  return { vx, vy: Math.max(top, Math.min(b.height - VH, Math.floor(feet[1]) - VH / 2 - 12)) };
}

let lastVoxelDraw = 0;
function frame(time: number): void {
  if (!state || !baked || !maia) return;
  if (explorer.on) {
    const out = explorer.frame(VW, VH, time, lightsOn, ambient, outline);
    g.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, VW, VH), 0, 0);
    return;
  }
  if (mode === 'voxel') {
    // Se redibuja al girar, al hacer zoom y mientras MAIA anda; si no, a pocos Hz para el parpadeo y el agua
    if (!vox.dirty && !moving && time - lastVoxelDraw < 0.15) return;
    const out = frame3D(state, { width: VW, height: VH, center: [maia.x, maia.y], radius: 72, yaw: vox.yaw, elevation: vox.elevation, zoom: vox.zoom,
      time, lights: lightsOn, ambient, outline, outlineColor });
    g.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, VW, VH), 0, 0);
    vox.dirty = false; lastVoxelDraw = time;
    return;
  }
  const b = baked;
  const { vx, vy } = viewOrigin(b, state, maia);
  compositor.frame(state, b, {
    vx, vy, vw: VW, vh: VH, time, lights: lightsOn, ambient, outline, outlineColor,
    // La silueta de quien queda detrás de una pared (todas miden lo mismo: la del sur tapa a quien se pega a ella)
    xray: { color: [150, 220, 255] },
    // ?luces=N: solo las N luces más cercanas alumbran a cada entidad (para ajustar en el Flip)
    ...(q.get('luces') ? { entityLightCap: Number(q.get('luces')) } : {}),
    // Sin walk, un bote de 1 px al andar; el walk ya trae el sube y baja del cuerpo
    bob: (e) => (!WALK && e === maia && moving && runtime && Math.floor(runtime.player.walked * 8) % 2 ? 1 : 0),
  });
}

// Lo que cambia en los vóxeles se rehornea por trabajos, con el presupuesto de cada cuadro (src/view/budget.ts)
let budget = new FrameBudget(3);
// ?romper=x,y: a los 3 s quita todo lo que hay encima del suelo en el tile de 16x16 de (x, y) (prueba del rehorneado
// sin teclado: con ?romper=296,135 desaparece la columna al suroeste de la salida en medieval, semilla 7)
const romper = q.get('romper')?.split(',').map(Number);
let roto = false;

let last = performance.now(), avg = 0, acc = 0, n = 0;
function loop(now: number): void {
  const dt = (now - last) / 1000;
  last = now;
  if (q.has('agitar') && Math.floor(now / 700) !== Math.floor((now - dt * 1000) / 700)) stomp = true;   // pruebas sin teclado
  ticks?.advance(dt);              // ticks fijos de 1/60: el runtime del juego
  if (weatherId && state && maia) state.fx.move(weatherId, maia.x, maia.y, maia.z + (weather === 'lluvia' ? 48 : 40));
  explorer.step(Math.min(0.1, dt), keys);
  const t0 = performance.now();
  frame(now / 1000);
  if (state && baked && romper?.length === 2 && !roto && runtime && runtime.tick > 180) {
    roto = true;
    const x0 = Math.floor(romper[0]! / TILE) * TILE, y0 = Math.floor(romper[1]! / TILE) * TILE;   // en ejes del modelo los tiles también caen en múltiplos de 16
    for (let z = 1; z < 48; z++) for (let y = y0; y < y0 + TILE; y++) for (let x = x0; x < x0 + TILE; x++) if (state.solid.get(x, y, z)) state.solid.set(x, y, z, 0);
  }
  if (state && baked) for (const job of rebakeChangedJobs(baked, state.lights)) budget.push(job);
  budget.run();
  acc += performance.now() - t0; n++;
  if (n === 30) { avg = acc / n; acc = 0; n = 0; }
  showRoute();
  hud.textContent = `VoxPix · un solo mundo en vóxeles · ${theme} · semilla ${seed}\n` +
    `horneado ${bakeMs} ms${baked ? ` (render ${baked.ms.render}, luces ${baked.ms.light})` : ''} · cuadro ${avg.toFixed(1)} ms (${compositor.kind}) · luces ${lightsOn ? 'sí' : 'no'} · gotas ${state?.drops.count ?? 0} · partículas ${fxOn ? state?.fx.alive ?? 0 : 'no'}\n` +
    (explorer.on ? `EXPLORAR · clic para mirar con el ratón · WASD andar · Espacio saltar · Mayús correr · +/- altura ${explorer.walker!.height} · X o Esc salir · render ${explorer.renderMs.toFixed(1)} ms (escena ${explorer.parts.scene.toFixed(1)}, luz ${explorer.parts.light.toFixed(1)}, capas ${explorer.parts.layers.toFixed(1)})`
      : mode === '2d' ? `WASD/flechas mover · Espacio pisotón · R otra semilla · T otro tema · L luz · C contorno · G ${theme === 'medieval' ? 'vegetación' : 'vidrio'} ${deco ? 'sí' : 'no'} · F efectos ${fxOn ? 'sí' : 'no'} · E chispas · N tiempo: ${weather} · V modo vóxel · X explorar`
      : `MODO VÓXEL · WASD andar · arrastrar = girar · rueda = zoom · C contorno · V vuelve al modo 2D`);
  next(loop);
}
// En navegadores sin ventana (capturas) requestAnimationFrame no avanza: ?timer=1 usa temporizadores
const next = q.has('timer') ? (f: (t: number) => void) => setTimeout(() => f(performance.now()), 16) : requestAnimationFrame;

function toggleMode(): void {
  mode = mode === '2d' ? 'voxel' : '2d';
  vox.dirty = true;
  modeBtn.textContent = mode === '2d' ? 'Modo vóxel' : 'Modo 2D';
  compositor.canvas.style.display = mode === '2d' ? '' : 'none';
  voxCanvas.style.display = mode === '2d' ? 'none' : '';
  modeBtn.classList.toggle('on', mode === 'voxel');
}
modeBtn.addEventListener('click', () => { toggleMode(); modeBtn.blur(); });

// El contorno: cambia el de las entidades y el del modo vóxel al momento; el del escenario 2D va en el horneado,
// así que se vuelve a hornear (sin tocar la partida: el estado del mundo es el mismo)
const outlineBtn = document.getElementById('outline') as HTMLButtonElement;
function showOutline(): void {
  outlineBtn.textContent = `Contorno: ${OUTLINES[outlineIx]!.name.replace('-', ' ')}`;
  outlineBtn.classList.toggle('on', outline !== 'none');
}
function cycleOutline(): void {
  outlineIx = (outlineIx + 1) % OUTLINES.length;
  outline = OUTLINES[outlineIx]!.id;
  outlineColor = OUTLINES[outlineIx]!.color;
  showOutline();
  vox.dirty = true;
  if (!world) return;
  loading.style.display = 'flex';
  setTimeout(() => {
    baked = bakeWorld(world!, { topZ: TOPZ, incline: INCLINE, outline, outlineColor });
    budget = new FrameBudget(3);
    loading.style.display = 'none';
  }, 30);
}
outlineBtn.addEventListener('click', () => { cycleOutline(); outlineBtn.blur(); });
showOutline();
if (mode === 'voxel') { mode = '2d'; toggleMode(); }


addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'r') { seed = (seed * 7919 + 13) % 100000; rebuild(); }
  if (k === 't') { recipe = null; theme = THEME_IDS[(THEME_IDS.indexOf(theme) + 1) % THEME_IDS.length]!; rebuild(); }
  if (k === 'l') { lightsOn = !lightsOn; vox.dirty = true; }
  if (k === 'c') cycleOutline();
  if (k === 'g') { deco = !deco; rebuild(); }
  if (k === 'f') { fxOn = !fxOn; if (state) state.effectsOn = fxOn; }
  if (k === 'n') setWeather(WEATHERS[(WEATHERS.indexOf(weather) + 1) % WEATHERS.length]!);
  // Chispas delante de MAIA, a la altura de la mano
  if (k === 'e' && state && maia && !explorer.on) {
    const a = (maia.yaw * Math.PI) / 180;
    state.fx.burst('chispas', maia.x + 0.5 + Math.sin(a) * 8, maia.y - Math.cos(a) * 8, maia.z + 8);
  }
  if (k === 'v' && !explorer.on) toggleMode();
  if (k === 'x') toggleExplore();
  if (explorer.on && (k === '+' || k === '=')) { exploreHeight = Math.min(48, exploreHeight + 1); explorer.setHeight(exploreHeight); }
  if (explorer.on && (k === '-' || k === '_')) { exploreHeight = Math.max(1, exploreHeight - 1); explorer.setHeight(exploreHeight); }
  if (k === 'escape' && explorer.on && !document.pointerLockElement) toggleExplore();
  if (k === ' ') { stomp = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

// Explorar: el lienzo del modo vóxel muestra la primera persona; clic para capturar el ratón y mirar
function toggleExplore(): void {
  if (explorer.on) {
    explorer.stop();
    if (document.pointerLockElement) document.exitPointerLock();
    compositor.canvas.style.display = mode === '2d' ? '' : 'none';
    voxCanvas.style.display = mode === '2d' ? 'none' : '';
    vox.dirty = true;
    return;
  }
  if (!state || !maia) return;
  explorer.start(state, { x: maia.x, y: maia.y, z: maia.z }, exploreHeight);
  compositor.canvas.style.display = 'none';
  voxCanvas.style.display = '';
}
voxCanvas.addEventListener('click', () => { if (explorer.on) voxCanvas.requestPointerLock(); });
addEventListener('mousemove', (e) => { if (explorer.on && document.pointerLockElement === voxCanvas) explorer.look(e.movementX, e.movementY); });

// Girar y hacer zoom en modo vóxel
let drag: [number, number] | null = null;
voxCanvas.addEventListener('mousedown', (e) => { if (mode === 'voxel') drag = [e.clientX, e.clientY]; });
addEventListener('mouseup', () => { drag = null; });
addEventListener('mousemove', (e) => {
  if (!drag) return;
  vox.yaw = Math.round(vox.yaw + (e.clientX - drag[0]) * 0.5);
  vox.elevation = Math.max(5, Math.min(89, Math.round(vox.elevation + (e.clientY - drag[1]) * 0.3)));
  drag = [e.clientX, e.clientY];
  vox.dirty = true;
});
voxCanvas.addEventListener('wheel', (e) => {
  if (mode !== 'voxel') return;
  e.preventDefault();
  vox.zoom = Math.max(1, Math.min(8, vox.zoom + (e.deltaY < 0 ? 1 : -1)));
  vox.dirty = true;
}, { passive: false });

// La API de mundos para agentes (api.ts): window.voxpixWorld
installWorldApi({
  get state() { return state; }, get world() { return world; }, get layout() { return layout; }, get baked() { return baked; },
  get recipe() { return recipe; }, get mode() { return explorer.on ? 'explore' : mode; }, get ambient() { return ambient; },
  get theme() { return theme; }, get seed() { return seed; }, get maia() { return maia; }, vox, VW, VH,
  build(r: RecipeInput | null): Promise<void> {
    if (r) { recipe = 'theme' in r && r.theme ? { ...(r as WorldRecipe), theme: r.theme } as WorldRecipe & { theme?: ThemeId } : r as WorldRecipe; seed = r.seed ?? seed; }
    else recipe = null;
    return new Promise((res) => { built.push(res); rebuild(); });
  },
  goto(x: number, y: number): void {
    if (!runtime || !state) throw new Error('el mundo aún no está construido');
    const p = runtime.player;
    p.x = x; p.y = y; p.z = restZ(state, x, y, p.r);
    runtime.syncEntity();
    vox.dirty = true;
  },
  setMode(m: '2d' | 'voxel' | 'explore'): void {
    if (m === 'explore') { if (!explorer.on) toggleExplore(); return; }
    if (explorer.on) toggleExplore();
    if (m !== mode) toggleMode();
  },
  setWeather(w: string): void {
    if (!(WEATHERS as readonly string[]).includes(w)) throw new Error(`no hay tiempo "${w}"; hay: ${WEATHERS.join(', ')}`);
    setWeather(w as typeof weather);
  },
  setLights(on: boolean): void { lightsOn = on; vox.dirty = true; },
  frame3D(): Uint8ClampedArray {
    if (!state || !maia) throw new Error('el mundo aún no está construido');
    return frame3D(state, { width: VW, height: VH, center: [maia.x, maia.y], radius: 72, yaw: vox.yaw, elevation: vox.elevation, zoom: vox.zoom,
      time: performance.now() / 1000, lights: lightsOn, ambient, outline, outlineColor });
  },
  view(): { vx: number; vy: number } {
    if (!baked || !state || !maia) throw new Error('el mundo aún no está construido');
    return viewOrigin(baked, state, maia);
  },
  get lightsOn() { return lightsOn; }, get outline() { return outline; },
});

rebuild();
next(loop);
