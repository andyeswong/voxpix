// La prueba del ORÁCULO (condición de MAIA para dar por bueno el compositor de la GPU): los mismos estados del mundo
// compuestos por la CPU (frame2D, la referencia) y por la GPU, comparados píxel a píxel. Corre en un navegador de
// verdad (WebGL2); scripts/oracle/oracle.ps1 la abre en Edge sin ventana y recoge window.__oracle.
//
// Qué se compara, por píxel de la vista:
//   - el color antes de la luz (la escena, las entidades, el agua y las gotas): debe ser el mismo byte (±1);
//   - la luz ya pasada a pixel art: el NIVEL de la capa multiply (8 niveles por canal) y el de la capa add (16);
//   - el cuadro final.
// Tolerancia (la justifica scripts/oracle/README.md): como mucho el 0,5 % de los píxeles puede diferir, y ninguno en
// más de un nivel de luz o en más de ±2 de color.
import { generateLayout, TILE } from '../../../src/worldgen';
import { THEMES } from '../../../src/content/themes';
import { Model, box, material, planFoliage, lilyPadModels, FOLIAGE_RAMPS, type ModelFile } from '@core/index';
import { buildWorldState, addWorldFloaters, worldWaterDepth, type WorldTheme } from '../../../src/world/build';
import { bakeWorld, rebakeChanged, type Baked } from '../../../src/world/bake';
import { frame2DParts, shadeLayers, type Frame2DOptions } from '../../../src/world/frame2d';
import { applyLayers } from '../../../src/lighting/shade';
import { StaticVoxels, WorldState, type RenderState } from '../../../src/world/state';
import type { World } from '../../../src/world/build';
import { WaterLayer } from '../../../src/world/water';
import { WorldView, type Quarter } from '../../../src/world/view';
import { NO_INPUT, Runtime } from '../../../src/runtime/runtime';
import { GpuCompositor, type WarmItem } from '../../../src/view/gpu/compositor';
import maiaFile from '../../../models/maia/maia.json';
import { walkFrames } from '../../../src/anim/walk';

const VW = 384, VH = 216, TOPZ = 40, INCLINE = 0.5;
const TOL_SHARE = 0.005;
const maiaModel = Model.fromJSON(maiaFile as unknown as ModelFile);

// Un arma de prueba: cuerpo de metal y una bobina de una rampa emisiva
function plasmaGun(): Model {
  const m = new Model({ ramps: [{ name: 'metal', colors: ['#1c1a2e', '#353650', '#8f99ab'] }, { name: 'plasma', colors: ['#1f6f8a', '#6ff2ff'], emissive: true }] }, 'pistola');
  box(m, -1, -6, 0, 1, 2, 3, material(0, 1));
  box(m, -1, -5, 4, 1, -1, 4, material(1, 1));
  box(m, 0, 1, -0, 0, 2, 0, material(0, 0));
  return m;
}
const walk = walkFrames(maiaModel);

// Una multitud determinista alrededor de MAIA: n entidades con cuadros del walk y giros variados, solapadas
function crowd(n: number) {
  return (s: WorldState, rt: Runtime) => {
    const p = rt.player;
    for (let k = 0; k < n; k++) {
      const ang = k * 2.39996, r = 10 + 5 * Math.sqrt(k);
      const x = Math.round(p.x + Math.cos(ang) * r * 1.6), y = Math.round(p.y + Math.sin(ang) * r);
      s.entities.add({ model: walk[k % 8]!, x, y, z: s.groundAt(x, y), facing: (k * 45) % 360, castsShadow: true });
    }
    s.lights.add({ kind: 'lantern', x: p.x - 12, y: p.y + 6, z: 16 });
  };
}

interface Scenario {
  name: string;
  lightCap?: number;      // tope de luces por entidad (entityLightCap)
  theme: WorldTheme;
  quarter?: Quarter;      // la vista girada (WorldView); 0 por defecto
  crop?: [number, number, number, number];   // recorta el mundo a x0, y0, ancho, fondo (lados impares)
  veg?: boolean;          // con vegetación (vegetate): follaje con luz horneada y dinámica, y sumergido en el lago
  glass?: boolean;        // con mamparas de vidrio (glaze) alrededor de la salida
  highlight?: (w: World) => [number, number, number, number, number, number];   // resaltar esa caja del mundo
  pos?: [number, number];
  ticks: number;
  stompEvery?: number;
  lights?: boolean;
  setup?: (s: WorldState, rt: Runtime) => void;
  // Lo que pasa después del primer cuadro de la GPU (para probar lo que se sube al rehornear)
  // Modelos para precalentar en la GPU (Compositor.prewarm) antes del primer cuadro
  warm?: (s: WorldState) => WarmItem[];
  // (gpuFrame compone un cuadro en la GPU sin compararlo)
  // (view es la vista girada: tras tocar el mundo, view.frame() la pone al día)
  // (gpuOther pinta un cuadro de la GPU con OTRO horneado: el giro 1 del mismo mundo)
  after?: (s: WorldState, b: Baked, gpuFrame: () => void, view: WorldView, gpuOther: () => void) => void;
}

// Vegetación en un mundo generado (spec de KALADIN): hierba, flores y arbustos sobre la hierba, hierba sumergida en
// el fondo del lago, y un árbol con copa de follaje junto a una antorcha horneada (sombra a través de las hojas)
function vegetate(w: World, at: [number, number]): void {
  const m = w.model;
  const names = ['hierba-alta', 'flor-roja', 'flor-amarilla', 'arbusto'];
  m.palette = { ...m.palette, ramps: [...m.palette.ramps, ...names.map((n) => structuredClone(FOLIAGE_RAMPS[n]!)), { name: 'hojas', colors: ['#14301f', '#1f4a2a', '#2f6b32', '#4f8f3c', '#86b84e'], kind: 'foliage' }] };
  const ri = (n: string) => m.palette.ramps.findIndex((r) => r.name === n);
  const put = (plan: { voxels: Array<[number, number, number, number]> }, keep?: (x: number, y: number) => boolean) => { for (const [x, y, z, v] of plan.voxels) if (!keep || keep(x, y)) m.set(x, y, z, v); };
  const all = [0, 0, m.width - 1, m.depth - 1] as const;
  put(planFoliage(m, ...all, m.zMax, { type: 'bush', ramp: ri('arbusto'), seed: 3, zMin: m.zMin }));
  put(planFoliage(m, ...all, m.zMax, { type: 'grass', ramp: ri('hierba-alta'), seed: 4, zMin: m.zMin, density: 0.3 }));
  put(planFoliage(m, ...all, m.zMax, { type: 'flowers', ramp: ri('hierba-alta'), heads: [ri('flor-roja'), ri('flor-amarilla')], seed: 5, zMin: m.zMin }));
  // Sumergida: hierba en el fondo de las columnas que empiezan con agua
  put(planFoliage(m, ...all, m.zMax, { type: 'grass', ramp: ri('hierba-alta'), seed: 6, zMin: m.zMin, density: 0.5, on: m.palette.ramps.map((_, i) => i) }), (x, y) => w.wet[y * m.width + x] === 1);
  // Nenúfares que flotan en el lago (los pisotones del escenario los mueven)
  const pads = lilyPadModels(structuredClone(FOLIAGE_RAMPS.nenufar!));
  const lilies = planFoliage(m, ...all, m.zMax, { type: 'lilies', ramp: ri('hierba-alta'), seed: 7, zMin: m.zMin, waterDepth: worldWaterDepth(w), density: 0.02 });
  w.floaters = lilies.floats.map(([x, y, k]) => ({ x, y, model: pads[k]!, yaw: k * 45 }));
  // El árbol y su antorcha
  const [tx, ty] = at, g = m.walkAt(tx, ty);
  for (let z = g; z <= g + 7; z++) for (let y = ty; y <= ty + 1; y++) for (let x = tx; x <= tx + 1; x++) m.set(x, y, z, material(ri('madera'), 1));
  for (let z = g + 6; z <= g + 14; z++) for (let y = ty - 7; y <= ty + 8; y++) for (let x = tx - 7; x <= tx + 8; x++) {
    const d = Math.hypot((x - tx - 0.5) / 7.5, (y - ty - 0.5) / 7.5, (z - g - 10) / 4.5);
    if (d <= 1 && ((x * 7 + y * 13 + z * 5) % 11) > 1 && !m.get(x, y, z)) m.set(x, y, z, material(ri('hojas'), Math.min(4, 1 + Math.floor((z - g - 6) / 2.5))));
  }
  w.lights.push({ id: 'veg-antorcha', kind: 'torch', x: tx + 0.5, y: ty + 12.5, z: g + 9 }, { id: 'veg-detras', kind: 'lantern', x: tx - 9.5, y: ty + 0.5, z: g + 3 });
}

// Vidrio (sistema de materiales) en un mundo generado: mamparas de vidrio alrededor de la salida, con una lámpara
// horneada dentro; la luz sale por el vidrio y no por la piedra
function glaze(w: World, at: [number, number]): void {
  const m = w.model;
  m.palette = { ...m.palette, ramps: [...m.palette.ramps, { name: 'vidrio', colors: ['#24465a', '#3f7a96', '#7ab8d6'], material: 'vidrio' }] };
  const v = material(m.palette.ramps.length - 1, 1), [cx, cy] = at;
  for (let k = -14; k <= 14; k++) {
    if ((k + 14) % 9 === 4) continue;                                       // huecos de puerta
    for (const [x, y] of [[cx + k, cy - 14], [cx + k, cy + 14], [cx - 14, cy + k], [cx + 14, cy + k]] as const) {
      const g = m.walkAt(x, y);                                             // el suelo, antes de poner nada
      if (g > 2) continue;                                                  // solo sobre el suelo
      for (let z = g; z < g + 11; z++) if (!m.get(x, y, z)) m.set(x, y, z, v);
    }
  }
  w.lights.push({ id: 'vidrio-lampara', kind: 'lamp', x: cx + 0.5, y: cy + 0.5, z: m.walkAt(cx, cy) + 8 });
}

// Un trozo de un mundo generado, con su agua y sus luces: así hay mundos rectangulares de lados impares
function cropWorld(w: World, x0: number, y0: number, cw: number, cd: number): World {
  const src = w.model;
  const model = new StaticVoxels(src.palette, cw, cd, src.zMin, src.zMax);
  for (const [x, y, z, v] of src.entries()) if (x >= x0 && y >= y0 && x < x0 + cw && y < y0 + cd) model.set(x - x0, y - y0, z, v);
  const wet = new Uint8Array(cw * cd), waterTop = new Int8Array(cw * cd);
  for (let y = 0; y < cd; y++) for (let x = 0; x < cw; x++) { const j = (y + y0) * w.width + x + x0; wet[y * cw + x] = w.wet[j]!; waterTop[y * cw + x] = w.waterTop[j]!; }
  const inside = (x: number, y: number) => x >= x0 && y >= y0 && x < x0 + cw && y < y0 + cd;
  const lights = w.lights.filter((l) => inside(l.x, l.y)).map((l) => ({ ...l, x: l.x - x0, y: l.y - y0 }));
  const f = w.fountain;
  const fountain = f && inside(f.x - f.radius - 2, f.y - f.radius - 2) && inside(f.x + f.radius + 2, f.y + f.radius + 2) ? { ...f, x: f.x - x0, y: f.y - y0 } : null;
  return { model, lights, width: cw, depth: cd, wet, waterTop, fountain };
}

const SCENARIOS: Scenario[] = [
  { name: 'medieval salida', theme: 'medieval', ticks: 120 },
  { name: 'oficina salida', theme: 'oficina', ticks: 120 },
  { name: 'cyberpunk salida', theme: 'cyberpunk', ticks: 120 },
  { name: 'medieval lago con pisotones', theme: 'medieval', pos: [172, 170], ticks: 300, stompEvery: 42 },
  { name: 'medieval lago sin luces', theme: 'medieval', pos: [172, 170], ticks: 300, stompEvery: 42, lights: false },
  {
    name: 'medieval columna rota', theme: 'medieval', ticks: 120,
    after: (s, b, _f, view) => {
      const x0 = Math.floor(296 / TILE) * TILE, y0 = Math.floor(135 / TILE) * TILE;
      for (let z = 1; z < 48; z++) for (let y = y0; y < y0 + TILE; y++) for (let x = x0; x < x0 + TILE; x++) if (s.solid.get(x, y, z)) s.solid.set(x, y, z, 0);
      rebakeChanged(b, view.frame().lights);
    },
  },
  {
    // Los horneados guardados en la GPU (bakedKeep): se pinta con este, luego con el del giro 1, se rompe la columna y
    // se rehornea ESTE mientras está guardado; al volver, la GPU lo pone al día por su número de serie
    name: 'medieval columna rota, ida y vuelta a otro horneado', theme: 'medieval', ticks: 120,
    after: (s, b, gpuFrame, view, gpuOther) => {
      gpuOther();
      const x0 = Math.floor(296 / TILE) * TILE, y0 = Math.floor(135 / TILE) * TILE;
      for (let z = 1; z < 48; z++) for (let y = y0; y < y0 + TILE; y++) for (let x = x0; x < x0 + TILE; x++) if (s.solid.get(x, y, z)) s.solid.set(x, y, z, 0);
      rebakeChanged(b, view.frame().lights);
      gpuOther();
    },
  },
  {
    // Varias entidades con sombra, girados, y una luz dinámica (las que se añaden en partida)
    name: 'oficina entidades y luz dinámica', theme: 'oficina', ticks: 60,
    setup: (s, rt) => {
      const p = rt.player;
      for (const [dx, dy, f] of [[-14, 6, 2], [16, -4, 5], [4, 18, 7]] as const) s.entities.add({ model: maiaModel, x: Math.round(p.x + dx), y: Math.round(p.y + dy), z: p.z, facing: f * 45, castsShadow: true });
      s.lights.add({ kind: 'lantern', x: p.x + 8, y: p.y - 10, z: 14 });
      // Un arma con una bobina emisiva: la luz del mundo no la oscurece
      s.entities.add({ model: plasmaGun(), x: Math.round(p.x - 6), y: Math.round(p.y - 8), z: p.z, facing: 90, castsShadow: true });
    },
  },
  {
    // Una linterna (foco) que lleva MAIA, apuntando delante y abajo, con MAIAs dentro y fuera del cono, junto al agua
    name: 'medieval linterna', theme: 'medieval', ticks: 60,
    setup: (s, rt) => {
      const p = rt.player;
      for (const [dx, dy] of [[0, -16], [-10, -24], [14, -20], [0, 18], [-22, 0]] as const) s.entities.add({ model: walk[(dx + dy + 64) % 8]!, x: Math.round(p.x + dx), y: Math.round(p.y + dy), z: p.z, facing: 0, castsShadow: true });
      s.lights.add({ kind: 'lamp', x: p.x + 0.5, y: p.y - 9, z: p.z + 14, dir: [0, -1, -0.45], cone: 55, intensity: 1.4, radius: 70, owner: rt.entityId! });
    },
  },
  { name: 'oficina multitud de 60', theme: 'oficina', ticks: 30, setup: crowd(60) },
  {
    name: 'medieval 30 con antorchas, sin tope', theme: 'medieval', ticks: 30,
    setup: (s, rt) => {
      crowd(30)(s, rt);
      const ids = s.entities.map((e) => e.id).filter((id) => id !== rt.entityId);
      for (let k = 0; k < 6; k++) s.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: ids[k * 4]!, offset: [6, -4, 14] } });
    },
  },
  {
    // Antorchas llevadas por entidades y un tope de 2 luces por entidad: las dos rutas eligen las mismas
    name: 'medieval 30 con antorchas, tope 2', theme: 'medieval', ticks: 30, lightCap: 2,
    setup: (s, rt) => {
      crowd(30)(s, rt);
      const ids = s.entities.map((e) => e.id).filter((id) => id !== rt.entityId);
      for (let k = 0; k < 6; k++) s.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: ids[k * 4]!, offset: [6, -4, 14] } });
    },
  },
  { name: 'medieval multitud de 200', theme: 'medieval', ticks: 30, setup: crowd(200) },
  // Lo mismo con los sprites precalentados (los 8 cuadros del walk en los 8 rumbos, con su sombra): el cuadro no cambia
  { name: 'medieval multitud de 200, precalentada', theme: 'medieval', ticks: 30, setup: crowd(200), warm: () => [...walk.map((model) => ({ model, casts: true })), { model: maiaModel, casts: true }] },
  {
    // Destellos de golpe (Entity.tint): unas entidades en blanco y otras en rojo, con antorchas
    name: 'medieval 30 con destellos', theme: 'medieval', ticks: 30,
    setup: (s, rt) => {
      crowd(30)(s, rt);
      s.entities.forEach((e, k) => { if (k && k % 3 === 0) s.entities.setTint(e.id, k % 2 ? [1, 1, 1] : [1, 0.25, 0.3]); });
      s.entities.setTint(rt.entityId!, [1, 0.2, 0.2]);
    },
  },
  {
    // Giros libres: 60 entidades x 30 cuadros = 1800 sprites distintos, más que el tope del atlas (MAX_SPRITE_LAYERS):
    // la GPU va sustituyendo capas y el cuadro final tiene que seguir siendo el de la CPU
    name: 'oficina 60 con giros libres', theme: 'oficina', ticks: 30, setup: crowd(60),
    after: (s, _b, gpuFrame) => {
      const spin = (f: number) => s.entities.forEach((e, k) => { if (k) e.yaw = (k * 37.3 + f * 11.7) % 360; });
      for (let f = 0; f < 30; f++) { spin(f); gpuFrame(); }
      spin(30);
    },
  },
];

// La vista girada (condición de MAIA): los escenarios con lo que depende del lado de la cámara (luces horneadas y la
// fachada norte, agua y gotas, rehorneado, entidades giradas con luz dinámica, el foco) en los otros 3 cuartos, y un
// mundo rectangular de lados impares con agua en los 4
const TURNED = ['medieval salida', 'medieval lago con pisotones', 'medieval columna rota', 'oficina entidades y luz dinámica', 'medieval linterna'];
for (const name of TURNED) {
  const base = SCENARIOS.find((s) => s.name === name)!;
  for (const q of [1, 2, 3] as Quarter[]) SCENARIOS.push({ ...base, name: `${name}, giro ${q}`, quarter: q });
}
// Vegetación (condición de MAIA): transmisión por la copa, contraluz y follaje sumergido, con una luz dinámica
// llevada y pisotones en el lago, en los 4 giros
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({
    name: `medieval vegetación, giro ${q}`, theme: 'medieval', pos: [172, 170], ticks: 200, stompEvery: 42, quarter: q, veg: true,
    setup: (s, rt) => { const p = rt.player; s.lights.add({ kind: 'lantern', x: p.x + 6, y: p.y + 9, z: p.z + 4 }); },
  });
}
for (const q of [0, 1, 2, 3] as Quarter[]) SCENARIOS.push({ name: `oficina vidrio, giro ${q}`, theme: 'oficina', ticks: 60, quarter: q, glass: true });
// El resalte de un objeto del escenario (la fuente, al acabar la oleada), con MAIAs alrededor que lo tapan en parte
for (const q of [0, 1, 2, 3] as Quarter[]) SCENARIOS.push({
  name: `medieval fuente resaltada, giro ${q}`, theme: 'medieval', ticks: 60, quarter: q,
  highlight: (w) => { const f = w.fountain!; const r = Math.ceil(f.radius) + 3; return [Math.floor(f.x) - r, Math.floor(f.y) - r, 1, Math.floor(f.x) + r, Math.floor(f.y) + r, f.bowl.z + 3]; },   // desde z = 1: el suelo no es la fuente
  setup: (s, rt) => {
    const f = s.fountain!;
    for (const [dx, dy] of [[-20, -18], [0, -21], [21, -10], [-8, 19]] as const) s.entities.add({ model: maiaModel, x: Math.round(f.x + dx), y: Math.round(f.y + dy), z: s.groundAt(f.x + dx, f.y + dy), facing: 0, castsShadow: true });
    rt.player.x = f.x - 30; rt.player.y = f.y - 30; rt.syncEntity();
  },
});
// Efectos y partículas (src/core/effects.ts): humo, brasas y chispas con luz, polvo y lluvia que chocan con el
// escenario, con MAIAs que los tapan en parte, de noche, en los 4 giros; y la multitud de 200 con chispas al morir
const fxSetup = (s: WorldState, rt: Runtime) => {
  const p = rt.player;
  for (const [dx, dy] of [[-12, -10], [10, -14], [6, 12]] as const) s.entities.add({ model: maiaModel, x: Math.round(p.x + dx), y: Math.round(p.y + dy), z: p.z, facing: 0, castsShadow: true });
  s.fx.add('humo', p.x - 16, p.y + 4, p.z + 6);
  s.fx.add('brasas', p.x + 14, p.y - 2, p.z + 2);
  s.fx.add('lluvia', p.x, p.y, p.z + 40);
  for (let k = 0; k < 4; k++) s.fx.burst('chispas', p.x + k * 5 - 8, p.y - 6, p.z + 8);
  s.fx.burst('polvo', p.x + 2, p.y + 6, p.z + 1);
};
for (const q of [0, 1, 2, 3] as Quarter[]) SCENARIOS.push({ name: `medieval efectos, giro ${q}`, theme: 'medieval', ticks: 50, quarter: q, setup: fxSetup });
SCENARIOS.push({ name: 'cyberpunk efectos', theme: 'cyberpunk', ticks: 50, setup: fxSetup });
SCENARIOS.push({
  name: 'medieval multitud de 200 con chispas', theme: 'medieval', ticks: 30,
  setup: (s, rt) => {
    crowd(200)(s, rt);
    // Cada 4 ticks, 10 de ellos "mueren" con chispas (el tope de luces elige siempre las mismas)
    let t = 0;
    const tick = rt.step.bind(rt);
    rt.step = (inp) => { if (t++ % 4 === 0) s.entities.slice(1 + (t % 20) * 10, 11 + (t % 20) * 10).forEach((e) => s.fx.burst('chispas', e.x, e.y, e.z + 6)); return tick(inp); };
  },
});
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `medieval impar 151x97 con pisotones, giro ${q}`, theme: 'medieval', crop: [101, 121, 151, 97], pos: [71, 49], ticks: 200, stompEvery: 42, quarter: q });
}

function viewOf(depth: number, b: Baked, x: number, y: number, z: number): { vx: number; vy: number } {
  const feet = b.cam.project(x + 0.5, y, z);
  const vx = Math.max(0, Math.min(b.width - VW, Math.floor(feet[0]) - VW / 2));
  const top = Math.max(0, Math.floor(b.cam.project(0, depth - 1 - 2 * TILE, 32)[1]));
  const vy = Math.max(top, Math.min(b.height - VH, Math.floor(feet[1]) - VH / 2 - 12));
  return { vx, vy };
}

interface Result {
  name: string;
  pixels: number;
  differ: number;          // píxeles con el cuadro final distinto
  colorOff: number;        // color sin luz a más de ±2
  mulOff1: number;         // multiply a un nivel
  mulOff2: number;         // multiply a más de un nivel
  addOff2: number;         // add a más de un nivel
  maxFinal: number;
  share: number;
  pass: boolean;
  worst: Array<{ x: number; y: number; cpu: number[]; gpu: number[]; cpuColor: number[]; gpuColor: number[]; cpuMul: number[]; gpuMul: number[]; cpuAdd: number[]; gpuAdd: number[]; total: number[] }>;
  gpuMs: number;
  cpuMs: number;
}

function compare(name: string, cpu: { color: Uint8ClampedArray; mul: Uint8ClampedArray; add: Uint8ClampedArray; final: Uint8ClampedArray },
  gpu: { color: Uint8Array; mul: Uint8Array; add: Uint8Array; final: Uint8Array }, ambient: readonly number[], lights: boolean, ms: [number, number], total: Float32Array | null): Result {
  const worst: Result['worst'] = [];
  const px = (a: ArrayLike<number>, i: number) => [a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!];
  const n = VW * VH;
  let differ = 0, colorOff = 0, mulOff1 = 0, mulOff2 = 0, addOff2 = 0, maxFinal = 0;
  const level = (m: number, ch: number) => { const base = Math.min(1, ambient[ch]!), room = 1 - base; return room > 0 ? Math.round(((m / 255 - base) / room) * 7) : 0; };
  for (let i = 0; i < n; i++) {
    let fd = 0, cd = 0, md = 0, ad = 0;
    for (let ch = 0; ch < 3; ch++) {
      const o = i * 4 + ch;
      fd = Math.max(fd, Math.abs(cpu.final[o]! - gpu.final[o]!));
      cd = Math.max(cd, Math.abs(cpu.color[o]! - gpu.color[o]!));
      if (lights) {
        md = Math.max(md, Math.abs(level(cpu.mul[o]!, ch) - level(gpu.mul[o]!, ch)));
        ad = Math.max(ad, Math.abs(Math.round((cpu.add[o]! / 255) * 15) - Math.round((gpu.add[o]! / 255) * 15)));
      }
    }
    if (fd) differ++;
    maxFinal = Math.max(maxFinal, fd);
    if (cd > 2) colorOff++;
    if (md === 1) mulOff1++;
    if (md > 1) mulOff2++;
    if ((md > 1 || ad > 1 || cd > 2) && worst.length < 12) worst.push({ x: i % VW, y: Math.floor(i / VW), cpu: px(cpu.final, i), gpu: px(gpu.final, i), cpuColor: px(cpu.color, i), gpuColor: px(gpu.color, i),
      cpuMul: px(cpu.mul, i), gpuMul: px(gpu.mul, i), cpuAdd: px(cpu.add, i), gpuAdd: px(gpu.add, i), total: total ? [total[i * 3]!, total[i * 3 + 1]!, total[i * 3 + 2]!] : [] });
    if (ad > 1) addOff2++;
  }
  const share = differ / n;
  return { name, pixels: n, differ, colorOff, mulOff1, mulOff2, addOff2, maxFinal, share, pass: share <= TOL_SHARE && !colorOff && !mulOff2 && !addOff2, worst, cpuMs: ms[0], gpuMs: ms[1] };
}

async function run(): Promise<void> {
  const out = document.getElementById('out')!;
  const canvas = document.createElement('canvas');
  const gpu = GpuCompositor.create(canvas);
  if (!gpu) {
    (window as unknown as { __oracle: unknown }).__oracle = { error: 'sin WebGL2 o sin EXT_color_buffer_float' };
    out.textContent = 'Sin WebGL2: no se puede comparar.';
    return;
  }
  const results: Result[] = [];
  const shots: Record<string, { cpu: string; gpu: string; diff: string; colorDiff: string }> = {};
  for (const sc of SCENARIOS) {
    out.textContent += `${sc.name}…\n`;
    await new Promise((r) => setTimeout(r, 0));
    const layout = generateLayout(THEMES[sc.theme].spec, 7);
    let { world, state } = buildWorldState(layout, sc.theme);
    if (sc.crop || sc.veg || sc.glass) {
      if (sc.crop) world = cropWorld(world, ...sc.crop);
      if (sc.veg) vegetate(world, [204, 184]);
      if (sc.glass) glaze(world, [layout.spawn.x + 30, world.depth - 1 - layout.spawn.y + 6]);
      state = new WorldState(world.model, world.lights, new WaterLayer(world, sc.theme), { seed: layout.seed, fountain: world.fountain });
      addWorldFloaters(state, world);
      state.warmUp();
    }
    const view = new WorldView(state, sc.quarter ?? 0);
    const b = bakeWorld(view.bakeable(), { topZ: TOPZ, incline: INCLINE });
    const spawn = sc.pos ? { x: sc.pos[0], y: sc.pos[1] } : { x: layout.spawn.x, y: world.depth - 1 - layout.spawn.y };
    const rt = new Runtime(state, spawn, { radius: 4, speed: 70, model: maiaModel });
    sc.setup?.(state, rt);
    for (let t = 1; t <= sc.ticks; t++) rt.step(sc.stompEvery && t % sc.stompEvery === 0 ? { ...NO_INPUT, stomp: true } : NO_INPUT);
    const maia = view.frame().entities.find((e) => e.id === rt.entityId)!;
    const { vx, vy } = viewOf(view.camera.viewDepth, b, maia.x, maia.y, maia.z);
    const ambient = THEMES[sc.theme].ambient;
    const o: Frame2DOptions = { vx, vy, vw: VW, vh: VH, time: sc.ticks / 60, lights: sc.lights ?? true, ambient,
      ...(sc.highlight ? { highlight: { box: view.viewBox(sc.highlight(world)), color: [255, 214, 102] as const, width: 2 } } : {}), ...(sc.lightCap !== undefined ? { entityLightCap: sc.lightCap } : {}) };
    if (sc.warm) gpu.prewarm(b, o, sc.warm(state));
    if (sc.after) {
      gpu.read(view.frame(), b, o, 'color');
      let other: { v: WorldView; b: Baked } | null = null;
      const gpuOther = () => {
        if (!other) { const v = new WorldView(state, 1); other = { v, b: bakeWorld(v.bakeable(), { topZ: TOPZ, incline: INCLINE }) }; }
        rebakeChanged(other.b, other.v.frame().lights);
        gpu.read(other.v.frame(), other.b, { ...o, vx: 0, vy: 0 }, 'color');
      };
      sc.after(state, b, () => gpu.read(view.frame(), b, o, 'color'), view, gpuOther);
    }
    const rs: RenderState = view.frame();
    const c0 = performance.now();
    const parts = frame2DParts(rs, b, o);
    const layers = parts.total ? shadeLayers(parts.total, o) : null;
    const cpuFinal = layers ? applyLayers(parts.view, layers) : parts.view;
    const c1 = performance.now();
    const gFinal = gpu.read(rs, b, o, 'frame');
    const c2 = performance.now();
    const gColor = gpu.read(rs, b, o, 'color');
    const gMul = gpu.read(rs, b, o, 'multiply');
    const gAdd = gpu.read(rs, b, o, 'add');
    const empty = new Uint8ClampedArray(VW * VH * 4);
    const r = compare(sc.name, { color: parts.view, mul: layers?.multiply ?? empty, add: layers?.add ?? empty, final: cpuFinal },
      { color: gColor, mul: gMul, add: gAdd, final: gFinal }, ambient, o.lights, [c1 - c0, c2 - c1], parts.total);
    results.push(r);
    shots[sc.name] = { cpu: toPng(cpuFinal), gpu: toPng(gFinal), diff: toPng(diffMask(cpuFinal, gFinal)), colorDiff: toPng(diffMask(parts.view, gColor)) };
    out.textContent += `  ${r.pass ? 'BIEN' : 'MAL '} difieren ${(r.share * 100).toFixed(3)} % (${r.differ}), color>2: ${r.colorOff}, luz a 1 nivel: ${r.mulOff1}, a más: ${r.mulOff2}, add a más: ${r.addOff2}, máx ${r.maxFinal}\n`;
  }
  (window as unknown as { __oracle: unknown }).__oracle = { results, pass: results.every((r) => r.pass), shots };
  out.textContent += results.every((r) => r.pass) ? '\nTODO BIEN\n' : '\nHAY FALLOS\n';
}

// Blanco donde difieren, y la imagen de la CPU muy oscura debajo para situarse
function diffMask(a: ArrayLike<number>, b: ArrayLike<number>): Uint8ClampedArray {
  const m = new Uint8ClampedArray(VW * VH * 4);
  for (let i = 0; i < VW * VH; i++) {
    const d = Math.max(Math.abs(a[i * 4]! - b[i * 4]!), Math.abs(a[i * 4 + 1]! - b[i * 4 + 1]!), Math.abs(a[i * 4 + 2]! - b[i * 4 + 2]!));
    for (let ch = 0; ch < 3; ch++) m[i * 4 + ch] = d ? (ch === 1 ? 255 : 255) : a[i * 4 + ch]! * 0.25;
    m[i * 4 + 3] = 255;
  }
  return m;
}

function toPng(px: Uint8Array | Uint8ClampedArray): string {
  const c = document.createElement('canvas');
  c.width = VW; c.height = VH;
  const g = c.getContext('2d')!;
  g.putImageData(new ImageData(new Uint8ClampedArray(px), VW, VH), 0, 0);
  return c.toDataURL('image/png');
}

run().catch((e) => {
  (window as unknown as { __oracle: unknown }).__oracle = { error: String(e?.stack ?? e) };
  document.getElementById('out')!.textContent += `\nERROR ${e?.stack ?? e}\n`;
});
