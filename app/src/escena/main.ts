// Demo: un escenario generado (src/worldgen) en UN SOLO MUNDO de vóxeles (src/world/state.ts). Este fichero solo hace
// la vista: cámara, frame2D o frame3D e interfaz. El tick (entrada -> mover y colisión -> eventos -> world.step()) es
// el runtime (src/runtime/runtime.ts); el mundo guarda lo estático, el agua, las entidades (MAIA), las luces y las
// gotas, y los dos modos leen ese mismo estado.
import { generateLayout, TILE, type Layout } from '../../../src/worldgen';
import { THEMES } from '../../../src/content/themes';
import { Model, type ModelFile } from '@core/index';
import { buildWorldState, type WorldTheme, type World } from '../../../src/world/build';
import { bakeWorld, rebakeChangedJobs, type Baked } from '../../../src/world/bake';
import { FrameBudget } from '../../../src/view/budget';
import { walkFrames } from '../../../src/anim/walk';
import { createCompositor } from '../../../src/view/compositor';
import { frame3D } from '../../../src/world/frame3d';
import type { WorldState, Entity } from '../../../src/world/state';
import { FixedLoop, NO_INPUT, Runtime, type TickInput, type CarryConfig } from '../../../src/runtime/runtime';
import maiaFile from '../../../models/maia/maia.json';
import { decorate } from './decor';
import linterna from '../../../models/luces/linterna.json';
import linternaNeon from '../../../models/luces/linterna-neon.json';
import antorcha from '../../../models/luces/antorcha.json';

// La luz que lleva MAIA en la mano en cada mundo: linterna (un foco) en la oficina y en cyberpunk, antorcha en el
// medieval. hand: dónde va el modelo respecto a los pies; emit: de dónde sale la luz respecto al modelo. ?luz=no la
// quita, para comparar.
const CARRY: Record<WorldTheme, Omit<CarryConfig, 'model'> & { file: unknown }> = {
  oficina: { file: linterna, kind: 'lantern', cone: 40, intensity: 3, radius: 100, hand: [8, -2, 6], emit: [0, -7, 1] },
  medieval: { file: antorcha, kind: 'torch', hand: [8, -1, 5], emit: [0, 0, 8] },
  cyberpunk: { file: linternaNeon, kind: 'lantern', cone: 40, intensity: 1.8, color: [0.18, 0.9, 1], hand: [8, -2, 6], emit: [0, -7, 1] },
};
function carryFor(t: WorldTheme): CarryConfig | undefined {
  if (q.get('luz') === 'no') return undefined;
  const { file, ...c } = CARRY[t];
  return { ...c, model: Model.fromJSON(file as ModelFile) };
}

const VW = 384, VH = 216;
const TOPZ = 40;
const THEME_IDS: WorldTheme[] = ['medieval', 'cyberpunk', 'oficina'];
const q = new URLSearchParams(location.search);
// Inclinación del suelo (misma para escenario y personajes): 0.5 por defecto; 1 = losetas sin acortar como el juego
const INCLINE = Number(q.get('inclinacion') ?? 0.5);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;
const modeBtn = document.getElementById('mode') as HTMLButtonElement;
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
let theme: WorldTheme = (THEME_IDS.includes(q.get('tema') as WorldTheme) ? q.get('tema') : 'medieval') as WorldTheme;
let seed = Number(q.get('seed') ?? 7);
let lightsOn = true;
// Contorno (como el de VoxPix): exterior, exterior + interior (los saltos de profundidad: paredes, columnas) o ninguno.
// ?contorno=exterior|interior|no
// Cada uno, con el tono más oscuro de la rampa vecina (como VoxPix) o marcado: casi negro.
// ?contorno=exterior|exterior-negro|interior|interior-negro|no
const INK = '#0d0c12';
const OUTLINES = [
  { name: 'exterior', id: 'outer', color: undefined }, { name: 'exterior-negro', id: 'outer', color: INK },
  { name: 'interior', id: 'both', color: undefined }, { name: 'interior-negro', id: 'both', color: INK },
  { name: 'no', id: 'none', color: undefined },
] as const;
let outlineIx = Math.max(0, OUTLINES.findIndex((o) => o.name === (q.get('contorno') ?? 'no')));
let outline: 'outer' | 'both' | 'none' = OUTLINES[outlineIx]!.id;
let outlineColor: string | undefined = OUTLINES[outlineIx]!.color;
let layout: Layout = generateLayout(THEMES[theme].spec, seed);
let world: World | null = null;
let state: WorldState | null = null;
let baked: Baked | null = null;
let maia: Entity | null = null;
let mode: '2d' | 'voxel' = q.get('modo') === 'voxel' ? 'voxel' : '2d';
const vox = { yaw: -30, elevation: 35, zoom: 3, dirty: true };
let runtime: Runtime | null = null;
let ticks: FixedLoop | null = null;
let moving = false;            // para el bote al andar (vista)
let stomp = false;             // Espacio: se gasta en el siguiente tick
const keys = new Set<string>();
let bakeMs = 0;
let deco = q.get('deco') !== 'no';     // ?deco=no: el escenario sin vegetación ni vidrio (G lo cambia)

function rebuild(): void {
  loading.style.display = 'flex';
  setTimeout(() => {
    const t0 = performance.now();
    layout = generateLayout(THEMES[theme].spec, seed);
    // La decoración del tema (decor.ts): vegetación en el medieval, cubículos de vidrio en oficina y cyberpunk. G la quita
    const lay = layout;
    ({ world, state } = buildWorldState(layout, theme, deco ? { decorate: (w) => decorate(w, theme, { x: lay.spawn.x, y: w.depth - 1 - lay.spawn.y }, seed) } : {}));
    baked = bakeWorld(world, { topZ: TOPZ, incline: INCLINE, outline, outlineColor });
    // La salida viene del worldgen (filas hacia abajo): se pasa a ejes del modelo una vez, aquí
    let spawn = { x: layout.spawn.x, y: world.depth - 1 - layout.spawn.y };
    const pos = q.get('pos')?.split(',').map(Number);              // ?pos=x,y en ejes del modelo (y hacia el norte)
    if (pos && pos.length === 2 && pos.every(Number.isFinite)) spawn = { x: pos[0]!, y: pos[1]! };
    runtime = new Runtime(state, spawn, { radius: 4, speed: 70, model: maiaModel, walk: WALK ? walkFrames(maiaModel) : undefined, shadow: 'always', carry: carryFor(theme) });
    maia = state.entities.get(runtime.entityId!) ?? null;
    if (q.get('dir')) { runtime.player.facing = Number(q.get('dir')) % 8; runtime.syncEntity(); }
    // Hasta 10 ticks por cuadro (un tick cuesta ~0,7 ms): el modo vóxel pinta a 8-10 fps y con el tope de 5 MAIA andaba
    // a cámara lenta. Por debajo de 6 fps la partida se frena en vez de encadenar cuadros más lentos
    ticks = new FixedLoop(runtime, input, 10);
    budget = new FrameBudget(3);       // los trabajos del mapa anterior no sirven para este
    bakeMs = Math.round(performance.now() - t0);
    vox.dirty = true;
    loading.style.display = 'none';
  }, 30);
}

// La entrada de un tick, leída del teclado. En modo vóxel, las teclas van según la pantalla (arriba = alejarse de la
// cámara): se giran con el giro de la vista a los ejes del modelo.
function input(): TickInput {
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
  const t = { dx, dy, stomp };
  stomp = false;
  return t;
}

let lastVoxelDraw = 0;
function frame(time: number): void {
  if (!state || !baked || !maia) return;
  if (mode === 'voxel') {
    // Se redibuja al girar, al hacer zoom y mientras MAIA anda; si no, a pocos Hz para el parpadeo y el agua
    if (!vox.dirty && !moving && time - lastVoxelDraw < 0.15) return;
    const out = frame3D(state, { width: VW, height: VH, center: [maia.x, maia.y], radius: 72, yaw: vox.yaw, elevation: vox.elevation, zoom: vox.zoom,
      time, lights: lightsOn, ambient: THEMES[theme].ambient, outline, outlineColor });
    g.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, VW, VH), 0, 0);
    vox.dirty = false; lastVoxelDraw = time;
    return;
  }
  const b = baked;
  // Cámara: centrada en MAIA, sin pasar de la tapa de la pared norte
  const feet = b.cam.project(maia.x + 0.5, maia.y, maia.z);
  const fx = Math.floor(feet[0]), fy = Math.floor(feet[1]);
  const vx = Math.max(0, Math.min(b.width - VW, fx - VW / 2));
  const top = Math.floor(b.cam.project(0, state.depth - 1 - 2 * TILE, 32)[1]);   // la tapa de la pared norte
  const vy = Math.max(top, Math.min(b.height - VH, fy - VH / 2 - 12));
  compositor.frame(state, b, {
    vx, vy, vw: VW, vh: VH, time, lights: lightsOn, ambient: THEMES[theme].ambient, outline, outlineColor,
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
    `horneado ${bakeMs} ms${baked ? ` (render ${baked.ms.render}, luces ${baked.ms.light})` : ''} · cuadro ${avg.toFixed(1)} ms (${compositor.kind}) · luces ${lightsOn ? 'sí' : 'no'} · gotas ${state?.drops.count ?? 0}\n` +
    (mode === '2d' ? `WASD/flechas mover · Espacio pisotón · R otra semilla · T otro tema · L luz · C contorno · G ${theme === 'medieval' ? 'vegetación' : 'vidrio'} ${deco ? 'sí' : 'no'} · V modo vóxel`
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
  if (k === 't') { theme = THEME_IDS[(THEME_IDS.indexOf(theme) + 1) % THEME_IDS.length]!; rebuild(); }
  if (k === 'l') { lightsOn = !lightsOn; vox.dirty = true; }
  if (k === 'c') cycleOutline();
  if (k === 'g') { deco = !deco; rebuild(); }
  if (k === 'v') toggleMode();
  if (k === ' ') { stomp = true; e.preventDefault(); }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));

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

rebuild();
next(loop);
