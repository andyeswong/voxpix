// La prueba del ORÁCULO (la condición para dar por bueno el compositor de la GPU): los mismos estados del mundo
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
import { THEMES, type ThemeId } from '../../../src/samples/themes';
import { Model, box, material, planFoliage, rgbOf, lilyPadModels, FOLIAGE_RAMPS, type ModelFile } from '@core/index';
import { buildWorldState, addWorldFloaters, worldWaterDepth, DEFAULT_WALL_H, type WorldLook } from '../../../src/world/build';
import type { ShapeSpec } from '../../../src/worldgen';
import { bakeWorld, rebakeChanged, shiftBaked, type Baked } from '../../../src/world/bake';
import { frame2D, frame2DParts, shadeLayers, applyFog, applyGhost, clearTransparent, sectionFor, sceneLayer, drawSectionBorder, type Frame2DOptions } from '../../../src/world/frame2d';
import { applyLayers } from '../../../src/lighting/shade';
import { StaticVoxels, WorldState, type RenderState } from '../../../src/world/state';
import type { World } from '../../../src/world/build';
import { Weather, type WeatherLevels } from '../../../src/world/weather';
import { climateTable, type WeatherFrame } from '../../../src/world/climate';
import { swaySources, aquaticMask } from '../../../src/world/sway';
import { WaterLayer } from '../../../src/world/water';
import { generateMap, applyMap, mapWater } from '../../../src/world/mapgen';
import { BlockSet, BlockGrid } from '../../../src/world/blocks';
import { clearBox } from '../../../src/world/edit';
import { WorldView, type Quarter } from '../../../src/world/view';
import { NO_INPUT, Runtime } from '../../../src/runtime/runtime';
import { GpuCompositor, type WarmItem } from '../../../src/view/gpu/compositor';
import { sectionAround, SectionPainter, secIdx, crossWindow, sectionBorderAt, type SectionLayer } from '../../../src/world/section';
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

// Agua verde tóxica que brilla sola (una rampa agua emisiva) sobre el resto del look
function toxic(base: WorldLook): WorldLook {
  const ramps = base.palette.ramps.map((r) => (r.name === 'agua' ? { ...r, colors: ['#0a2a10', '#145a20', '#22a03a', '#4ee060', '#b0ffb8'], emissive: true } : r));
  return { ...base, palette: { ...base.palette, ramps } };
}

interface Scenario {
  name: string;
  lightCap?: number;      // tope de luces por entidad (entityLightCap)
  theme: ThemeId;
  look?: (base: WorldLook) => WorldLook;     // otro aspecto del mundo (el agua emisiva)
  shape?: ShapeSpec;                         // la forma de la sala (paredes que siguen el contorno y el vacío fuera)
  xray?: boolean;                            // la silueta de las entidades tapadas (Frame2DOptions.xray)
  highWater?: { cut?: boolean; dig?: boolean; gpuFirst?: boolean; prepHalf?: boolean };   // (prepHalf: la mitad de la subida por partes antes de picar, el resto después)
  // El horneado se sube por partes (GpuCompositor.prepareJob, el giro con fundido) antes del primer cuadro, en bandas
  prepared?: boolean;   // un mundo alto con lagos (mapgen + WaterLayer con wallAbove), con corte o picando la orilla (gpuFirst: la GPU ya dibujó un cuadro antes de picar)
  clearBg?: boolean;                         // fondo transparente (Frame2DOptions.background = 'transparent')
  fog?: boolean;                             // niebla por altura (Frame2DOptions.fog) con el foco sobre los pies de MAIA
  cave?: boolean;                            // un tejado sobre la salida, el cielo horneado y la luz de cueva (Frame2DOptions.cave)
  quarter?: Quarter;      // la vista girada (WorldView); 0 por defecto
  // El corte al componer (Frame2DOptions.section, o sectionLayer con SectionPainter): una caja de `width` de ancho
  // alrededor de MAIA, desde sus pies. Moviéndose: antes, la GPU dibuja con la caja 16 y 8 vóxeles más a un lado (sube
  // una capa y la cambia)
  // Con un anillo de paredes de piedra alrededor de MAIA (a 12-20 vóxeles, hasta z 28: el de delante es el que se
  // corta, en cualquier giro) y, con torch, una antorcha fija dentro
  // (z: la altura del corte; por defecto, la de los pies)
  // (pit: una losa de un vóxel delante de MAIA sobre un pozo en el suelo, dentro de la caja: lo cortado sin nada detrás
  // lleva el fondo de la sección, no transparente; secHoles cuenta lo sustituido transparente)
  // cross: con la ventana en cruz (SectionCut.window) de ese radio y ese brazo, centrada en el cuerpo del jugador; true:
  // la de por defecto (brazo 24, radio 40). border: la cruz con su borde dibujado (withBorder) de ese grosor
  // (ghost: los vóxeles de la sección desde dz por encima de los pies del corte, semitransparentes con esa alpha)
  section?: { width: number; painter?: boolean; torch?: boolean; z?: number; pit?: boolean; cross?: number | true; border?: number; ghost?: { alpha: number; dz?: number; keepFacing?: boolean; seq?: boolean } };
  // La ventana viva (shiftBaked): con antorchas fijas a los dos lados del borde del primer trozo de vóxeles, la GPU
  // dibuja, la imagen se corre un trozo (y la GPU la corre dentro de sí). 'ida': se compara ahí (la vista corrida con
  // ella); 'vuelta': se vuelve al sitio (lo que salió, otra vez desde una copia) y la vista tiene que ser byte a byte la
  // de antes, en CPU y en GPU
  shift?: 'ida' | 'vuelta';
  crop?: [number, number, number, number];   // recorta el mundo a x0, y0, ancho, fondo (lados impares)
  // El clima del cuadro (Frame2DOptions.weather): sus niveles y las opciones; con veg, sus rampas se mecen
  bare?: boolean;         // con veg y clima: la hierba y las flores no toman nieve (MaterialProps.snow)
  algas?: boolean;        // con veg y clima: plantas en el agua del lago (MaterialProps.aquatic)
  flota?: boolean;        // con algas: hojas sueltas en la superficie del lago que se mecen con el rizado (MaterialProps.afloat)
  clima?: { levels: Partial<WeatherLevels>; frame?: Partial<WeatherFrame>; snow?: number; wet?: number };   // (snow, wet: lo ya acumulado)
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

// La altura del suelo (la cara de arriba del más alto) bajo un punto
function rt0FeetZ(state: WorldState, p: { x: number; y: number }): number { return state.solid.height[Math.floor(p.y) * state.solid.width + Math.floor(p.x)]!; }

// Vegetación en un mundo generado: hierba, flores y arbustos sobre la hierba, hierba sumergida en
// el fondo del lago, y un árbol con copa de follaje junto a una antorcha horneada (sombra a través de las hojas)
function vegetate(w: World, at: [number, number], wind = false, algae = false, bare = false, afloat = false): void {
  const m = w.model;
  const names = ['hierba-alta', 'flor-roja', 'flor-amarilla', 'arbusto'];
  m.palette = { ...m.palette, ramps: [...m.palette.ramps, ...names.map((n) => structuredClone(FOLIAGE_RAMPS[n]!)), { name: 'hojas', colors: ['#14301f', '#1f4a2a', '#2f6b32', '#4f8f3c', '#86b84e'], kind: 'foliage' }] };
  if (wind) for (const r of m.palette.ramps) {
    if (r.name === 'hojas') r.props = { sway: 2, anchor: 'self' };
    else if (names.includes(r.name)) r.props = { ...(bare ? { snow: false } : {}), sway: 3, anchor: 'root', reach: r.name === 'arbusto' ? 4 : 3 };
  }
  const ri = (n: string) => m.palette.ramps.findIndex((r) => r.name === n);
  const put = (plan: { voxels: Array<[number, number, number, number]> }, keep?: (x: number, y: number) => boolean) => { for (const [x, y, z, v] of plan.voxels) if (!keep || keep(x, y)) m.set(x, y, z, v); };
  const all = [0, 0, m.width - 1, m.depth - 1] as const;
  put(planFoliage(m, ...all, m.zMax, { type: 'bush', ramp: ri('arbusto'), seed: 3, zMin: m.zMin }));
  put(planFoliage(m, ...all, m.zMax, { type: 'grass', ramp: ri('hierba-alta'), seed: 4, zMin: m.zMin, density: 0.3 }));
  put(planFoliage(m, ...all, m.zMax, { type: 'flowers', ramp: ri('hierba-alta'), heads: [ri('flor-roja'), ri('flor-amarilla')], seed: 5, zMin: m.zMin }));
  // Sumergida: hierba en el fondo de las columnas que empiezan con agua
  put(planFoliage(m, ...all, m.zMax, { type: 'grass', ramp: ri('hierba-alta'), seed: 6, zMin: m.zMin, density: 0.5, on: m.palette.ramps.map((_, i) => i) }), (x, y) => w.wet[y * m.width + x] === 1);
  // Plantas de agua: columnas desde el fondo hasta debajo de la superficie (y algunas, por encima)
  if (algae) {
    m.palette = { ...m.palette, ramps: [...m.palette.ramps, { name: 'alga', colors: ['#143c1e', '#2c6e2a', '#58a03a'], material: 'follaje', props: { sway: 3, anchor: 'root', reach: 5, aquatic: true } }] };
    const al = m.palette.ramps.length - 1;
    for (let y = 0; y < m.depth; y++) for (let x = 0; x < m.width; x++) {
      if (!w.wet[y * m.width + x] || (x * 7 + y * 13) % 9) continue;
      const f = m.floorAt(x, y), top = w.waterTop[y * m.width + x]! + ((x + y) % 4 === 0 ? 3 : -1);
      for (let z = f; z < top; z++) m.set(x, y, z, material(al, (x + z) % 3));
    }
    // Hojas en la superficie: un vóxel (o dos) sobre el agua, que se mece con el rizado de su celda
    if (afloat) {
      m.palette = { ...m.palette, ramps: [...m.palette.ramps, { name: 'hoja-flotante', colors: ['#1c5a2a', '#3f8a3a', '#7ab84e'], material: 'follaje', props: { sway: 2, anchor: 'self', afloat: true, snow: false } }] };
      const fl = m.palette.ramps.length - 1;
      for (let y = 0; y < m.depth; y++) for (let x = 0; x < m.width; x++) {
        if (!w.wet[y * m.width + x] || (x * 5 + y * 11) % 7 || m.get(x, y, w.waterTop[y * m.width + x]!)) continue;
        const z = w.waterTop[y * m.width + x]!;
        m.set(x, y, z, material(fl, (x + y) % 3));
        if (x + 1 < m.width && !m.get(x + 1, y, z) && w.wet[y * m.width + x + 1]) m.set(x + 1, y, z, material(fl, 1));
      }
    }
  }
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
  // El líquido brilla solo cuando su rampa es emisiva (WaterLayer.glow): la GPU lo pinta igual, también en la vista girada
  { name: 'lago tóxico emisivo', theme: 'medieval', look: toxic, pos: [172, 170], ticks: 120, stompEvery: 42 },
  { name: 'laberinto medieval', theme: 'medieval', shape: { kind: 'maze' }, ticks: 60 },
  // MAIA pegada a la pared sur: la pared la tapa y se ve su silueta (Frame2DOptions.xray)
  { name: 'silueta tras la pared sur', theme: 'oficina', pos: [320, 20], xray: true, ticks: 30 },
  { name: 'medieval bajo tejado (cielo y cueva)', theme: 'medieval', cave: true, ticks: 60 },
  { name: 'medieval bajo tejado (cielo y cueva), giro 1', theme: 'medieval', cave: true, quarter: 1, ticks: 60 },
  { name: 'silueta tras la pared sur, giro 2', theme: 'oficina', pos: [320, 426], quarter: 2, xray: true, ticks: 30 },
  { name: 'oficina en T, giro 1', theme: 'oficina', shape: { kind: 'T' }, quarter: 1, ticks: 60 },
  { name: 'lago tóxico emisivo, giro 1', theme: 'medieval', look: toxic, quarter: 1, pos: [172, 170], ticks: 120 },
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
    // Lo mismo, pero con un cuadro de la GPU antes de romper: la luz se rehace sobre la que la GPU ya tiene y se sube
    // solo su recuadro sucio (texSubImage3D con UNPACK_SKIP_*)
    // Se pica junto a cada luz horneada (un hueco de 3 x 3 al sur y al este de ella, hasta el suelo): cada una se rehace
    // en parte, con su recuadro sucio lejos de la primera fila de su zona
    name: 'medieval picado junto a las luces tras un cuadro (pesos por recuadro)', theme: 'medieval', ticks: 120,
    after: (s, b, gpuFrame, view) => {
      gpuFrame();
      for (const l of view.frame().lights) {
        if (l.baked === false) continue;
        const cx = Math.round(l.x) + 3, cy = Math.round(l.y) - 3;
        for (let z = 0; z <= Math.ceil(l.z); z++) for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) if (x >= 0 && y >= 0 && x < s.solid.width && y < s.solid.depth && s.solid.get(x, y, z)) s.solid.set(x, y, z, 0);
      }
      rebakeChanged(b, view.frame().lights);
    },
  },
  {
    // Una entidad con un modelo sin vóxeles que da sombra, junto a MAIA: sin sombra y sin romper el cuadro
    name: 'oficina entidad de modelo vacío', theme: 'oficina', ticks: 30,
    setup: (s, rt) => { const m = s.entities.get(rt.entityId!)!; s.entities.add({ model: new Model(maiaModel.palette, 'vacio'), x: m.x + 6, y: m.y, z: m.z, castsShadow: true }); },
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

// La vista girada: los escenarios con lo que depende del lado de la cámara (luces horneadas y la
// fachada norte, agua y gotas, rehorneado, entidades giradas con luz dinámica, el foco) en los otros 3 cuartos, y un
// mundo rectangular de lados impares con agua en los 4
const TURNED = ['medieval salida', 'medieval lago con pisotones', 'medieval columna rota', 'oficina entidades y luz dinámica', 'medieval linterna'];
for (const name of TURNED) {
  const base = SCENARIOS.find((s) => s.name === name)!;
  for (const q of [1, 2, 3] as Quarter[]) SCENARIOS.push({ ...base, name: `${name}, giro ${q}`, quarter: q });
}
// Vegetación: transmisión por la copa, contraluz y follaje sumergido, con una luz dinámica
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

// La niebla por altura: el foco 8 por encima de los pies (las paredes y las entidades quedan por encima, el suelo
// dentro del tramo, el agua más abajo), de 2 a 10 por debajo
const fogQ = [0, 1, 2, 3] as Quarter[];
for (const q of fogQ) SCENARIOS.push({ name: `medieval lago con niebla por altura, giro ${q}`, theme: 'medieval', pos: [172, 170], ticks: 300, stompEvery: 42, quarter: q, fog: true });
SCENARIOS.push({ name: 'medieval lago con niebla por altura, sin luces', theme: 'medieval', pos: [172, 170], ticks: 300, stompEvery: 42, lights: false, fog: true });
// Fondo transparente: donde no hay mundo, alfa 0 en las dos (la sala en T deja vacío alrededor; con efectos, la silueta
// y entidades encima)
SCENARIOS.push({ name: 'oficina en T, fondo transparente', theme: 'oficina', shape: { kind: 'T' }, ticks: 60, clearBg: true });
SCENARIOS.push({ name: 'oficina en T, fondo transparente, giro 1', theme: 'oficina', shape: { kind: 'T' }, quarter: 1, ticks: 60, clearBg: true });
SCENARIOS.push({ name: 'medieval efectos, fondo transparente', theme: 'medieval', ticks: 50, setup: fxSetup, clearBg: true });
SCENARIOS.push({ name: 'silueta tras la pared sur, fondo transparente', theme: 'oficina', pos: [320, 20], xray: true, ticks: 30, clearBg: true });
SCENARIOS.push({ name: 'oficina multitud de 60 con niebla por altura', theme: 'oficina', ticks: 30, setup: crowd(60), fog: true });

// Un mundo de bloques alto (de 4 vóxeles) con lagos: generateMap, applyMap sin el agua y el agua con mapWater y un
// WaterLayer que no tiene pared por altura. La superficie del agua queda a z 40-44, por encima del tramo de siempre
// bigLake: la salida, junto a un lago de 40 columnas del mapa o más (aquí, el más grande) (para picar su orilla: un charco no llenaría la poza)
function highWaterWorld(bigLake = false): { world: World; state: WorldState; spawn: { x: number; y: number }; lake: { x: number; y: number } } {
  const N = 4, pal = { ramps: [
    { name: 'piedra', colors: ['#2a2b32', '#3e4049', '#565a64', '#727784'] },
    { name: 'tierra', colors: ['#3a2618', '#553823', '#704b2e', '#8c6040'] },
    { name: 'hierba', colors: ['#24401f', '#35602a', '#4a8034', '#68a044'] },
    { name: 'arena', colors: ['#a08a5a', '#c0a872', '#d8c290', '#ece0b0'] },
    { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
  ] };
  const cube = (r: number): Array<[number, number, number, number]> => { const o: Array<[number, number, number, number]> = []; for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o.push([x, y, z, material(r, 1 + ((x + y + z) % 3))]); return o; };
  const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'alto', size: N, palette: pal, blocks: ['piedra', 'tierra', 'hierba', 'arena', 'agua'].map((id, i) => ({ id, voxels: cube(i) })) });
  const T = (id: string) => set.index(id);
  const map = generateMap({ seed: 3, width: 100, depth: 100, height: 16, surface: { base: 11, amplitude: 3, scale: 8 },
    strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
    seaLevel: 10, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 } });
  const s = new StaticVoxels(pal, 100 * N, 100 * N, 0, 16 * N - 1);
  const pre = new WorldState(s, [], null);
  applyMap(map, new BlockGrid(pre, set), { skip: [T('agua')] });
  const world = { model: s, lights: [], width: s.width, depth: s.depth, ...mapWater(map, N, T('agua')) } as unknown as World;
  const state = new WorldState(s, [], new WaterLayer(world, { wallAbove: Infinity }), { seed: 3 });
  // La salida: la columna seca más cercana al centro de un lago (el más grande que toque el centro del mapa)
  let best: { x: number; y: number } | null = null, lake = { x: 200, y: 200 }, bd = Infinity;
  // El tamaño del lago de cada columna con agua (en la capa del nivel del mar)
  const size = new Int32Array(100 * 100), wetAt = (i: number) => map.cells[10 * 100 * 100 + i] === T('agua');
  for (let i = 0; i < 100 * 100; i++) {
    if (!wetAt(i) || size[i]) continue;
    const q = [i];
    size[i] = -1;
    for (let k = 0; k < q.length; k++) {
      const c = q[k]!, cx = c % 100, cy = (c - cx) / 100;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy, j = ny * 100 + nx;
        if (nx < 0 || ny < 0 || nx >= 100 || ny >= 100 || size[j] || !wetAt(j)) continue;
        size[j] = -1; q.push(j);
      }
    }
    for (const c of q) size[c] = q.length;
  }
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const wetNear = map.cells[(10 * 100 + y) * 100 + x] === T('agua');
    if (!wetNear || (bigLake && size[y * 100 + x]! < 40)) continue;
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= 100 || ny >= 100 || map.heights[ny * 100 + nx]! < 10) continue;
      const d = Math.hypot(nx - 50, ny - 50);
      if (d < bd) { bd = d; best = { x: nx * N + 2, y: ny * N + 2 }; lake = { x: x * N + 2, y: y * N + 2 }; }
    }
  }
  return { world, state, spawn: best ?? { x: 200, y: 200 }, lake };
}
for (const q of [0, 1, 2, 3] as Quarter[]) SCENARIOS.push({ name: `agua en mundo alto, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, stompEvery: 40, highWater: {} });
// La subida por partes del giro con fundido (prepareJob): byte a byte lo de subirlo entero
for (const q of [0, 1] as Quarter[]) SCENARIOS.push({ name: `medieval lago con pisotones, subido por partes, giro ${q}`, theme: 'medieval', pos: [172, 170], ticks: 300, stompEvery: 42, quarter: q, prepared: true });
SCENARIOS.push({ name: 'oficina vidrio, subido por partes', theme: 'oficina', ticks: 60, glass: true, prepared: true });
SCENARIOS.push({ name: 'agua en mundo alto picando, subido por partes a medias', theme: 'medieval', ticks: 240, highWater: { dig: true, prepHalf: true } });
SCENARIOS.push({ name: 'agua en mundo alto con corte', theme: 'medieval', ticks: 60, highWater: { cut: true } });
SCENARIOS.push({ name: 'agua en mundo alto picando la orilla', theme: 'medieval', ticks: 240, highWater: { dig: true } });
// La ventana viva: la imagen corrida un trozo (la GPU la corre dentro de sí), y corrida y vuelta
for (const q of [0, 1] as Quarter[]) {
  SCENARIOS.push({ name: `ventana corrida, giro ${q}`, theme: 'medieval', pos: [172, 170], quarter: q, ticks: 60, shift: 'ida' });
  SCENARIOS.push({ name: `ventana corrida y vuelta, giro ${q}`, theme: 'medieval', pos: [172, 170], quarter: q, ticks: 60, shift: 'vuelta' });
}
// El corte al componer, moviéndose, en los 4 giros: bajo el tejado (el cielo con el corte), con las antorchas fijas
// (fijas como dinámicas en lo sustituido), y con entidades y una luz dinámica (sus sombras sobre la sección); con la
// caja de cada cuadro (section) y con SectionPainter (sectionLayer)
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `corte al componer bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, section: { width: 64, z: 1 } });
  SCENARIOS.push({ name: `corte al componer por franjas bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, section: { width: 64, painter: true, z: 1 } });
  SCENARIOS.push({ name: `corte al componer con antorchas, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, section: { width: 96, painter: true, torch: true } });
  // Sobre el lago con pisotones: el agua dentro de la caja no se dibuja
  SCENARIOS.push({ name: `corte al componer con pozo, giro ${q}`, theme: 'medieval', quarter: q, ticks: 30, section: { width: 64, painter: true, pit: true, z: 1 } });
  SCENARIOS.push({ name: `corte al componer sobre el lago, giro ${q}`, theme: 'medieval', pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, section: { width: 96, painter: true, z: 1 } });
  const ent = SCENARIOS.find((s) => s.name === 'oficina entidades y luz dinámica')!;
  SCENARIOS.push({ ...ent, name: `corte al componer con entidades y luz dinámica, giro ${q}`, quarter: q, section: { width: 64, painter: true } });
  // Lo mismo por una ventana en cruz: solo se sustituye dentro de la cruz, y el agua de la caja solo se quita ahí
  SCENARIOS.push({ name: `corte al componer en cruz bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, section: { width: 64, z: 1, cross: true } });
  SCENARIOS.push({ name: `corte al componer en cruz por franjas con antorchas, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, section: { width: 96, painter: true, torch: true, cross: 24 } });
  SCENARIOS.push({ name: `corte al componer en cruz sobre el lago, giro ${q}`, theme: 'medieval', pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, section: { width: 96, painter: true, z: 1, cross: 16 } });
  SCENARIOS.push({ ...ent, name: `corte al componer en cruz con entidades y luz dinámica, giro ${q}`, quarter: q, section: { width: 64, painter: true, cross: 12 } });
  // Y la cruz con su borde dibujado: el trazo, el mismo en las dos rutas, encima de todo (agua, entidades, luz, niebla)
  SCENARIOS.push({ name: `corte al componer en cruz con borde bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, section: { width: 64, z: 1, cross: true, border: 1 } });
  SCENARIOS.push({ name: `corte al componer en cruz con borde por franjas con antorchas, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, section: { width: 96, painter: true, torch: true, cross: 24, border: 2 } });
  SCENARIOS.push({ name: `corte al componer en cruz con borde sobre el lago con niebla, giro ${q}`, theme: 'medieval', pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, fog: true, section: { width: 96, painter: true, z: 1, cross: 16, border: 1 } });
  SCENARIOS.push({ ...ent, name: `corte al componer en cruz con borde, entidades y luz dinámica, giro ${q}`, quarter: q, section: { width: 64, painter: true, cross: 12, border: 3 } });
  SCENARIOS.push({ name: `corte al componer en cruz con borde sin luces y fondo transparente, giro ${q}`, theme: 'medieval', quarter: q, ticks: 30, lights: false, clearBg: true, section: { width: 64, z: 1, cross: true, border: 2 } });
  // Con vóxeles semitransparentes (SectionCut.ghost): la segunda superficie en la escena y el velo de la de delante en
  // el paso final; con la caja de cada cuadro y por franjas (con otras alphas en los cuadros de antes), con caras opacas
  // (keepFacing, desde el suelo del corte: de frente todo son caras que miran a la cámara, y el velo queda en las de
  // arriba, el suelo), con entidades y luz dinámica, con niebla, por la cruz con borde, y sin luces sobre fondo transparente
  SCENARIOS.push({ name: `corte con velo bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, section: { width: 64, z: 1, ghost: { alpha: 0.35 } } });
  SCENARIOS.push({ name: `corte con velo y caras opacas bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, section: { width: 64, z: 1, ghost: { alpha: 0.35, dz: -1, keepFacing: true } } });
  SCENARIOS.push({ name: `corte con velo por franjas con antorchas, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, section: { width: 96, painter: true, torch: true, ghost: { alpha: 0.6 } } });
  SCENARIOS.push({ ...ent, name: `corte con velo, entidades y luz dinámica, giro ${q}`, quarter: q, section: { width: 64, painter: true, ghost: { alpha: 0.35, dz: 4 } } });
  SCENARIOS.push({ name: `corte con velo en cruz con borde sobre el lago con niebla, giro ${q}`, theme: 'medieval', pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, fog: true, section: { width: 96, painter: true, z: 1, cross: 16, border: 1, ghost: { alpha: 0.5 } } });
  // (y encendiéndolo y apagándolo cuadro a cuadro, después de comparar la escena: veilSeq)
  SCENARIOS.push({ name: `corte con velo que se enciende y se apaga, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, section: { width: 96, painter: true, torch: true, ghost: { alpha: 0.35, seq: true } } });
  SCENARIOS.push({ name: `corte con velo en cruz con borde sin luces y fondo transparente, giro ${q}`, theme: 'medieval', quarter: q, ticks: 30, lights: false, clearBg: true, section: { width: 64, z: 1, cross: true, border: 2, ghost: { alpha: 0.35 } } });
}
// El viento en la vegetación (Frame2DOptions.weather, world/sway.ts): la vegetación de arriba con sus rampas meciéndose, en
// los 4 giros, con entidades y luces, bajo el cielo, con el corte (por franjas y con velo), corrida la ventana y sin luces
const wind = { levels: { wind: [0.9, 0.35], gust: 0.6 } as Partial<WeatherLevels> };
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `viento en la vegetación, giro ${q}`, theme: 'medieval', veg: true, pos: [176, 174], quarter: q, ticks: 97, stompEvery: 42, clima: wind });
  SCENARIOS.push({ name: `viento en la vegetación con corte, giro ${q}`, theme: 'medieval', veg: true, pos: [224, 172], quarter: q, ticks: 60, clima: wind, section: { width: 64, painter: true, z: 3, torch: true } });
  SCENARIOS.push({ name: `viento en la vegetación con velo, giro ${q}`, theme: 'medieval', veg: true, pos: [224, 172], quarter: q, ticks: 60, clima: wind, section: { width: 64, z: 1, ghost: { alpha: 0.35, dz: 4 } } });
}
for (const q of [0, 1] as Quarter[]) {
  SCENARIOS.push({ name: `viento con la ventana corrida, giro ${q}`, theme: 'medieval', veg: true, pos: [172, 170], quarter: q, ticks: 60, shift: 'ida', clima: wind });
  SCENARIOS.push({ name: `viento con la ventana corrida y vuelta, giro ${q}`, theme: 'medieval', veg: true, pos: [172, 170], quarter: q, ticks: 60, shift: 'vuelta', clima: wind });
}
// Con una multitud (sus sombras, también en el borde de la vista), y con matas puestas a mano y rehorneadas tras un cuadro
SCENARIOS.push({ name: 'viento en la vegetación con multitud', theme: 'medieval', veg: true, pos: [196, 172], ticks: 40, setup: (s, rt) => { crowd(60)(s, rt); for (const dx of [-186, 186]) { const x = rt.player.x + dx, y = rt.player.y; if (x < 8 || x > s.solid.width - 8) continue; s.lights.add({ kind: 'brazier', x: x - Math.sign(dx) * 10, y: y + 2, z: 12 }); s.entities.add({ model: walk[0]!, x, y, z: s.groundAt(x, y), facing: 0, castsShadow: true }); } }, clima: wind });
SCENARIOS.push({ name: 'viento en matas puestas a mano', theme: 'medieval', veg: true, pos: [196, 172], ticks: 40, clima: wind, after: (s, b, _f, view) => {
  const r = s.solid.palette.ramps.findIndex((q) => q.name === 'hierba-alta');
  for (let y = 150; y < 200; y += 6) for (let x = 170; x < 230; x += 7) { const g = s.solid.walkAt(x, y); if (g > 4) continue; for (let z = g; z < g + 9; z++) s.solid.set(x, y, z, material(r, 1)); }
  rebakeChanged(b, view.frame().lights);
} });
SCENARIOS.push({ name: 'viento en la vegetación, sin luces', theme: 'medieval', veg: true, pos: [204, 168], ticks: 45, lights: false, clima: wind });
SCENARIOS.push({ name: 'viento en la vegetación bajo el cielo, con niebla', theme: 'medieval', veg: true, pos: [196, 172], ticks: 45, cave: true, fog: true, clima: wind });
SCENARIOS.push({ name: 'viento en la vegetación, subido por partes', theme: 'medieval', veg: true, pos: [204, 168], ticks: 45, prepared: true, clima: wind });
// Las plantas de agua: se mecen y se ven a través del agua, en los 4 giros, con pisotones, con corte, sin luces y en la cueva
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `plantas en el agua, giro ${q}`, theme: 'medieval', veg: true, algas: true, pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, clima: wind });
  SCENARIOS.push({ name: `plantas en el agua con corte, giro ${q}`, theme: 'medieval', veg: true, algas: true, pos: [172, 170], quarter: q, ticks: 60, clima: wind, section: { width: 96, painter: true, z: 1, cross: 16 } });
}
SCENARIOS.push({ name: 'plantas en el agua, sin luces', theme: 'medieval', veg: true, algas: true, pos: [172, 170], ticks: 60, lights: false, clima: wind });
SCENARIOS.push({ name: 'plantas en el agua, sin viento', theme: 'medieval', veg: true, algas: true, pos: [172, 170], ticks: 61, clima: { levels: {} } });
SCENARIOS.push({ name: 'plantas en el agua con niebla, la ventana corrida', theme: 'medieval', veg: true, algas: true, pos: [172, 170], ticks: 60, fog: true, shift: 'ida', clima: wind });
// Lo que cae y lo que deja: bajo el cielo con un tejado, en los 4 giros, con corte (con velo también), con niebla, sin luces
// y sobre el lago; con el vaivén a la vez
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `lluvia y mojado, giro ${q}`, theme: 'medieval', veg: true, cave: true, pos: [172, 170], quarter: q, ticks: 97, stompEvery: 42, clima: { levels: { rain: 1, wind: [0.7, 0.3], gust: 0.5 }, frame: { fall: {}, cover: true }, wet: 0.8 } });
  SCENARIOS.push({ name: `nieve a medias, giro ${q}`, theme: 'medieval', veg: true, cave: true, pos: [196, 172], quarter: q, ticks: 64, clima: { levels: { snow: 0.8, wind: [-0.4, 0.5], gust: 0.5 }, frame: { fall: {}, cover: true }, snow: 0.55, wet: 0.2 } });
  SCENARIOS.push({ name: `nieve con corte, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 64, clima: { levels: { snow: 1 }, frame: { fall: {}, cover: true }, snow: 1 }, section: { width: 64, painter: true, z: 1 } });
  SCENARIOS.push({ name: `nieve con corte y velo, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 64, clima: { levels: { snow: 1 }, frame: { fall: {}, cover: true }, snow: 0.5, wet: 1 }, section: { width: 64, z: 1, ghost: { alpha: 0.35 } } });
}
// Lo que cae sobre un corte en cruz con borde (sobre el interior, nada), y el velo con agua y algas a la vez
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `lluvia sobre la cruz, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 64, clima: { levels: { rain: 1, wind: [0.5, 0.2] }, frame: { fall: { max: 1500 } } }, section: { width: 64, painter: true, z: 1, cross: true, border: 2 } });
  SCENARIOS.push({ name: `velo con agua y algas, giro ${q}`, theme: 'medieval', veg: true, algas: true, pos: [172, 170], quarter: q, ticks: 97, stompEvery: 42, clima: { levels: { rain: 1, wind: [0.8, 0.3], gust: 0.6 }, frame: { fall: {}, waves: 1 } }, section: { width: 96, painter: true, z: 1, ghost: { alpha: 0.5 } } });
}
for (const q of [0, 1] as Quarter[]) SCENARIOS.push({ name: `nieve con rampas que no la toman, giro ${q}`, theme: 'medieval', veg: true, bare: true, cave: true, pos: [196, 172], quarter: q, ticks: 64, clima: { levels: { snow: 0.8, wind: [-0.4, 0.5] }, frame: { fall: { snow: { colors: [[255, 200, 120], [120, 200, 255]], glow: true } }, cover: true, rate: { tables: 8, fall: 20 } }, snow: 1 } });
SCENARIOS.push({ name: 'nieve con rampas que no la toman, con corte', theme: 'medieval', veg: true, bare: true, cave: true, pos: [196, 172], ticks: 64, clima: { levels: { snow: 0.8, wind: [0.8, 0.3] }, frame: { cover: true }, snow: 1 }, section: { width: 64, painter: true, z: 3 } });
SCENARIOS.push({ name: 'nieve con rampas que no la toman, la ventana corrida y vuelta', theme: 'medieval', veg: true, bare: true, cave: true, pos: [196, 172], ticks: 64, shift: 'vuelta', clima: { levels: { snow: 0.8, wind: [0.8, 0.3] }, frame: { cover: true }, snow: 1 } });
SCENARIOS.push({ name: 'nieve con niebla sin luces', theme: 'medieval', cave: true, ticks: 64, lights: false, fog: true, clima: { levels: { snow: 1 }, frame: { fall: {}, cover: true }, snow: 0.7 } });
SCENARIOS.push({ name: 'lluvia con fondo transparente', theme: 'medieval', cave: true, clearBg: true, ticks: 64, clima: { levels: { rain: 1, wind: [1, 0] }, frame: { fall: { max: 1000 }, cover: true }, wet: 1 } });
SCENARIOS.push({ name: 'lluvia con la ventana corrida y vuelta', theme: 'medieval', veg: true, cave: true, pos: [172, 170], ticks: 60, shift: 'vuelta', clima: { levels: { rain: 1, wind: [1, 0] }, frame: { fall: {}, cover: true }, wet: 1, snow: 0.4 } });
// El rizado del agua: el viento y los anillos de la lluvia sobre el lago, en los 4 giros (con pisotones y con vegetación), el
// mundo alto, el lago que brilla solo, con corte, sin luces y con la ventana corrida
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `agua rizada, giro ${q}`, theme: 'medieval', veg: true, algas: true, pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, clima: { levels: { wind: [0.9, 0.35], gust: 0.6, rain: 0.8 }, frame: { waves: 1, fall: {} } } });
  SCENARIOS.push({ name: `agua rizada en mundo alto, giro ${q}`, theme: 'medieval', quarter: q, ticks: 120, highWater: {}, clima: { levels: { wind: [0.9, 0.35], gust: 1 }, frame: { waves: 1 } } });
}
// Lo que flota con el rizado (MaterialProps.afloat): la GPU lee la misma baldosa que la CPU
for (const q of [0, 1, 2, 3] as Quarter[]) SCENARIOS.push({ name: `lo que flota en el agua rizada, giro ${q}`, theme: 'medieval', veg: true, algas: true, flota: true, pos: [172, 170], quarter: q, ticks: 200, stompEvery: 42, clima: { levels: { wind: [0.9, 0.35], gust: 0.6, rain: 0.8 }, frame: { waves: 1, fall: {}, still: 0.25 } } });
SCENARIOS.push({ name: 'lo que flota en el agua rizada con corte', theme: 'medieval', veg: true, algas: true, flota: true, pos: [172, 170], ticks: 60, clima: { levels: { wind: [1, 0], rain: 1 }, frame: { waves: 1 } }, section: { width: 96, painter: true, z: 1, cross: 16 } });
SCENARIOS.push({ name: 'lo que flota en el agua rizada, la ventana corrida', theme: 'medieval', veg: true, algas: true, flota: true, pos: [172, 170], ticks: 60, shift: 'ida', clima: { levels: { wind: [1, 0], rain: 1 }, frame: { waves: 1 } } });
SCENARIOS.push({ name: 'lo que flota sin rizado (con el aire)', theme: 'medieval', veg: true, algas: true, flota: true, pos: [172, 170], ticks: 60, clima: { levels: { wind: [0.9, 0.35], gust: 0.6 } } });
// (con el agua quieta del todo y la corriente baja no se corre ni un píxel: la lluvia sola la mueve, sin aire)
SCENARIOS.push({ name: 'lo que flota con lluvia sin viento y la corriente baja', theme: 'medieval', veg: true, algas: true, flota: true, pos: [172, 170], ticks: 61, clima: { levels: { rain: 1 }, frame: { waves: 1, still: 0.25 } } });
SCENARIOS.push({ name: 'agua rizada que brilla sola', theme: 'medieval', look: toxic, pos: [172, 170], ticks: 120, stompEvery: 42, clima: { levels: { wind: [0.5, -0.8], rain: 1 }, frame: { waves: 1 } } });
SCENARIOS.push({ name: 'agua rizada con corte', theme: 'medieval', pos: [172, 170], ticks: 60, clima: { levels: { wind: [1, 0], rain: 1 }, frame: { waves: 1 } }, section: { width: 96, painter: true, z: 1, cross: 16 } });
SCENARIOS.push({ name: 'agua rizada, sin luces', theme: 'medieval', pos: [172, 170], ticks: 60, lights: false, clima: { levels: { wind: [1, 0], rain: 1 }, frame: { waves: 1 } } });
SCENARIOS.push({ name: 'agua rizada, la ventana corrida', theme: 'medieval', pos: [172, 170], ticks: 60, shift: 'ida', clima: { levels: { wind: [1, 0], rain: 1 }, frame: { waves: 1 } } });
// El sol con nubes que pasan: bajo el tejado en los 4 giros, con entidades, agua y vegetación, con corte (y velo), con todo el
// clima a la vez, sin luz de cueva y corrida la ventana
const solar = { color: [1, 0.86, 0.66] as const, intensity: 0.5, dir: [0.45, -0.5, 0.7] as const };
for (const q of [0, 1, 2, 3] as Quarter[]) {
  SCENARIOS.push({ name: `sol con nubes bajo tejado, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, clima: { levels: { clouds: 0.5, wind: [0.6, 0.2] }, frame: { sunlight: solar } } });
  SCENARIOS.push({ name: `todo el clima, giro ${q}`, theme: 'medieval', veg: true, algas: true, cave: true, pos: [172, 170], quarter: q, ticks: 97, stompEvery: 42, clima: { levels: { clouds: 0.6, wind: [0.8, 0.4], gust: 0.7, rain: 0.6, snow: 0.3 }, frame: { sunlight: solar, fall: {}, cover: true, waves: 1, origin: [23, 41] }, snow: 0.4, wet: 0.6 } });
  SCENARIOS.push({ name: `sol con corte y velo, giro ${q}`, theme: 'medieval', cave: true, quarter: q, ticks: 60, clima: { levels: { clouds: 0.5 }, frame: { sunlight: solar } }, section: { width: 64, painter: true, z: 1, ghost: { alpha: 0.5 } } });
}
// El sol con partículas con luz propia y sin ella, entidades, agua con algas y velo, todo a la vez (el alfa de la luz lo comparten)
for (const q of [0, 1] as Quarter[]) SCENARIOS.push({ name: `sol con partículas, agua, algas y velo, giro ${q}`, theme: 'medieval', veg: true, algas: true, cave: true, pos: [172, 170], quarter: q, ticks: 97, stompEvery: 42, setup: (s, rt) => {
  for (const [dx, dy] of [[-14, 0], [12, 6], [0, -10], [20, 14]] as const) { const x = rt.player.x + dx, y = rt.player.y + dy, z = s.groundAt(x, y) + 6; s.fx.add('brasas', x, y, z); s.fx.add('humo', x + 3, y, z); s.fx.add('chispas', x, y + 4, z); }
}, clima: { levels: { clouds: 0.3, wind: [0.5, 0.2], rain: 0.5 }, frame: { sunlight: solar, fall: {}, waves: 1 } }, section: { width: 96, painter: true, z: 1, ghost: { alpha: 0.5 } } });
SCENARIOS.push({ name: 'sol con multitud', theme: 'medieval', cave: true, ticks: 40, setup: crowd(60), clima: { levels: { clouds: 0.4 }, frame: { sunlight: solar } } });
SCENARIOS.push({ name: 'sol con la ventana corrida', theme: 'medieval', cave: true, pos: [172, 170], ticks: 60, shift: 'ida', clima: { levels: { clouds: 0.5 }, frame: { sunlight: solar } } });
SCENARIOS.push({ ...SCENARIOS.find((s) => s.name === 'oficina entidades y luz dinámica')!, name: 'clima sin nada que se meza', clima: wind });
// Lo mismo, con un cuadro de la GPU ANTES de picar: el fondo nuevo tiene que llegarle (WaterSurface.groundVersion)
for (const q of [0, 1] as Quarter[]) SCENARIOS.push({ name: `agua en mundo alto picando tras un cuadro, giro ${q}`, theme: 'medieval', quarter: q, ticks: 240, highWater: { dig: true, gpuFirst: true } });

function viewOf(depth: number, b: Baked, x: number, y: number, z: number): { vx: number; vy: number } {
  const feet = b.cam.project(x + 0.5, y, z);
  const vx = Math.max(0, Math.min(b.width - VW, Math.floor(feet[0]) - VW / 2));
  const top = Math.max(0, Math.floor(b.cam.project(0, depth - 1 - 2 * TILE, DEFAULT_WALL_H)[1]));
  const vy = Math.max(top, Math.min(b.height - VH, Math.floor(feet[1]) - VH / 2 - 12));
  return { vx, vy };
}

interface Result {
  control?: { differ: number; mulOff2: number; addOff2: number; colorOff: number };   // con clima: la escena sin él
  swayPx?: number;         // con clima: píxeles de la vista que salen de otra columna, y de ellos los que difieren
  swayDiffer?: number;
  climaPx?: number;        // con clima: píxeles de la CPU que el clima cambia
  aquaPx?: number;         // con algas: píxeles de planta de agua en la vista, y de ellos los que difieren
  aquaDiffer?: number;
  waterPx?: number;        // con agua en un mundo alto: píxeles con un tono del agua en la CPU
  secPx?: number;          // con corte al componer: píxeles de la vista sustituidos (máscara 1) y de borde (2)
  secBorder?: number;
  secLine?: number;                          // píxeles del borde dibujado de la ventana en la vista, y los que la GPU no da
  secLineOff?: number;
  secInfo?: unknown;
  backSame?: { cpu: boolean; gpu: boolean };
  gpuShifts?: number;      // con shift: cuántas veces corrió la GPU sus texturas dentro de sí (sin volver a subirlas)   // con shift 'vuelta': la vista de después, igual byte a byte a la de antes
  secDiffer?: number;
  // Con ghost en la sección: píxeles con velo en la vista; de ellos, con algo delante del vóxel (sin velo) y con algo
  // entre las dos superficies; los que el velo cambia respecto a alpha 1 (la CPU), y los que difieren de la GPU
  veilPx?: number;
  veilFront?: number;
  veilBetween?: number;
  veilShown?: number;
  veilDiffer?: number;
  // Con ghost y seq: el velo encendido, apagado, sin nada que velar y de vuelta, cuadro a cuadro: en cada paso, píxeles
  // con el cuadro final distinto entre la CPU y la GPU, los que difieren en más de 2, y los que llevan velo
  veilSeq?: Array<{ step: string; differ: number; big: number; veil: number }>;
  secHoles?: number;       // con pit: píxeles sustituidos transparentes en la CPU (0: el fondo)
  secFill?: number;        // con pit: píxeles sustituidos con el fondo (sin cara)      // de los píxeles con el final distinto, los que están en la capa (máscara 1 o 2)
  secMaxFinal?: number;
  waterPxNear?: number;    // y en el recuadro de pantalla de la poza de "picando la orilla" (entre la salida y el lago)
  alphaOff: number;        // píxeles con el alfa del cuadro distinto (cualquiera es fallo)
  clear: number;           // píxeles transparentes en la CPU (con fondo transparente)
  glErrors?: number[];     // errores de WebGL de la escena (códigos de getError): cualquiera es fallo
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
  diffs: Result['worst'];      // los píxeles con el final distinto (hasta 64), con su color, multiply, add y luz
  gpuMs: number;
  cpuMs: number;
}

function compare(name: string, cpu: { color: Uint8ClampedArray; mul: Uint8ClampedArray; add: Uint8ClampedArray; final: Uint8ClampedArray },
  gpu: { color: Uint8Array; mul: Uint8Array; add: Uint8Array; final: Uint8Array }, ambient: readonly number[], lights: boolean, ms: [number, number], total: Float32Array | null): Result {
  const worst: Result['worst'] = [];
  // Los píxeles con el cuadro final distinto (hasta 64), con todo lo que entra en él: para saber de dónde sale un ±1
  const diffs: Result['worst'] = [];
  const px = (a: ArrayLike<number>, i: number) => [a[i * 4]!, a[i * 4 + 1]!, a[i * 4 + 2]!];
  const n = VW * VH;
  let differ = 0, colorOff = 0, mulOff1 = 0, mulOff2 = 0, addOff2 = 0, maxFinal = 0, alphaOff = 0, clear = 0;
  const level = (m: number, ch: number) => { const base = Math.min(1, ambient[ch]!), room = 1 - base; return room > 0 ? Math.round(((m / 255 - base) / room) * 7) : 0; };
  for (let i = 0; i < n; i++) {
    let fd = 0, cd = 0, md = 0, ad = 0;
    // El alfa del cuadro (con fondo transparente, 0 donde no hay nada): tiene que ser el mismo
    if (cpu.final[i * 4 + 3] !== gpu.final[i * 4 + 3]) alphaOff++;
    if (!cpu.final[i * 4 + 3]) clear++;
    for (let ch = 0; ch < 3; ch++) {
      const o = i * 4 + ch;
      fd = Math.max(fd, Math.abs(cpu.final[o]! - gpu.final[o]!));
      cd = Math.max(cd, Math.abs(cpu.color[o]! - gpu.color[o]!));
      if (lights) {
        md = Math.max(md, Math.abs(level(cpu.mul[o]!, ch) - level(gpu.mul[o]!, ch)));
        ad = Math.max(ad, Math.abs(Math.round((cpu.add[o]! / 255) * 15) - Math.round((gpu.add[o]! / 255) * 15)));
      }
    }
    if (fd) {
      differ++;
      if (diffs.length < 64) diffs.push({ x: i % VW, y: Math.floor(i / VW), cpu: px(cpu.final, i), gpu: px(gpu.final, i), cpuColor: px(cpu.color, i), gpuColor: px(gpu.color, i),
        cpuMul: px(cpu.mul, i), gpuMul: px(gpu.mul, i), cpuAdd: px(cpu.add, i), gpuAdd: px(gpu.add, i), total: total ? [total[i * 3]!, total[i * 3 + 1]!, total[i * 3 + 2]!] : [] });
    }
    maxFinal = Math.max(maxFinal, fd);
    if (cd > 2) colorOff++;
    if (md === 1) mulOff1++;
    if (md > 1) mulOff2++;
    if ((md > 1 || ad > 1 || cd > 2) && worst.length < 12) worst.push({ x: i % VW, y: Math.floor(i / VW), cpu: px(cpu.final, i), gpu: px(gpu.final, i), cpuColor: px(cpu.color, i), gpuColor: px(gpu.color, i),
      cpuMul: px(cpu.mul, i), gpuMul: px(gpu.mul, i), cpuAdd: px(cpu.add, i), gpuAdd: px(gpu.add, i), total: total ? [total[i * 3]!, total[i * 3 + 1]!, total[i * 3 + 2]!] : [] });
    if (ad > 1) addOff2++;
  }
  const share = differ / n;
  return { name, pixels: n, differ, colorOff, mulOff1, mulOff2, addOff2, maxFinal, alphaOff, clear, share, pass: share <= TOL_SHARE && !colorOff && !mulOff2 && !addOff2 && !alphaOff, worst, diffs, cpuMs: ms[0], gpuMs: ms[1] };
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
  const only = new URLSearchParams(location.search).get('solo');   // ?solo=texto: solo las escenas con ese texto en el nombre
  for (const sc of SCENARIOS.filter((x) => !only || x.name.includes(only))) {
    out.textContent += `${sc.name}…\n`;
    await new Promise((r) => setTimeout(r, 0));
    const layout = generateLayout(sc.shape ? { ...THEMES[sc.theme].spec, shape: sc.shape } : THEMES[sc.theme].spec, 7);
    const look = sc.look ? sc.look(THEMES[sc.theme].look) : THEMES[sc.theme].look;
    let { world, state } = buildWorldState(layout, look);
    let highSpawn: { x: number; y: number } | null = null, lake = { x: 0, y: 0 };
    if (sc.highWater) ({ world, state, spawn: highSpawn, lake } = highWaterWorld(!!sc.highWater.dig));
    if (sc.crop || sc.veg || sc.glass) {
      if (sc.crop) world = cropWorld(world, ...sc.crop);
      if (sc.veg) vegetate(world, [204, 184], !!sc.clima, !!sc.algas, !!sc.bare, !!sc.flota);
      if (sc.glass) glaze(world, [layout.spawn.x + 30, world.depth - 1 - layout.spawn.y + 6]);
      state = new WorldState(world.model, world.lights, new WaterLayer(world), { seed: layout.seed, fountain: world.fountain });
      addWorldFloaters(state, world);
      state.warmUp();
    }
    const spawn = highSpawn ?? (sc.pos ? { x: sc.pos[0], y: sc.pos[1] } : { x: layout.spawn.x, y: world.depth - 1 - layout.spawn.y });
    if (sc.cave) {
      // Un tejado de piedra a z 26..29 sobre la salida (más al norte que al sur, para que se vea debajo)
      for (let y = Math.max(0, spawn.y - 8); y < Math.min(world.depth, spawn.y + 40); y++) for (let x = Math.max(0, spawn.x - 40); x < Math.min(world.width, spawn.x + 40); x++)
        for (let z = 26; z < 30; z++) state.solid.set(x, y, z, material(0, 1));
    }
    if (sc.section) {
      // (con pit, sin el anillo: lo primero que se ve en la caja es la losa)
      if (!sc.section.pit) for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 12) continue;
        const x = spawn.x + dx, y = spawn.y + dy;
        if (x < 0 || y < 0 || x >= world.width || y >= world.depth) continue;
        for (let z = 1; z < 29; z++) if (!state.solid.get(x, y, z)) state.solid.set(x, y, z, material(0, 1 + ((dx + dy + z) & 1)));
      }
      if (sc.section.torch) state.lights.addFixed({ kind: 'brazier', x: spawn.x + 6.5, y: spawn.y - 5.5, z: 12 });
      if (sc.section.pit) {
        const fz = rt0FeetZ(state, spawn);
        for (let y = spawn.y - 34; y <= spawn.y - 2; y++) for (let x = spawn.x - 10; x <= spawn.x + 10; x++) {
          state.solid.set(x, y, fz, material(0, 1));                                          // la losa
          if (y >= spawn.y - 32 && y <= spawn.y - 4 && Math.abs(x - spawn.x) <= 6) for (let z = 0; z < fz; z++) state.solid.set(x, y, z, 0);   // el pozo, largo y hasta abajo
        }
      }
    }
    if (sc.shift) for (const x of [8.5, 24.5]) state.lights.addFixed({ kind: 'torch', x, y: spawn.y + 0.5, z: 30 });
    const view = new WorldView(state, sc.quarter ?? 0, sc.highWater?.cut ? { cut: true } : {});
    const b = bakeWorld(view.bakeable(), { topZ: sc.highWater ? 72 : TOPZ, incline: INCLINE, ...(sc.cave ? { sky: true } : {}) });
    if (sc.highWater?.dig) (state.water as WaterLayer).follow(state.watchChanges());
    // (la subida por partes: run(-Infinity) hace una banda por llamada)
    let prep: { run(deadline: number): boolean } | null = null;
    const rt = new Runtime(state, spawn, { radius: 4, speed: 70, model: maiaModel });
    sc.setup?.(state, rt);
    for (let t = 1; t <= sc.ticks; t++) rt.step(sc.stompEvery && t % sc.stompEvery === 0 ? { ...NO_INPUT, stomp: true } : NO_INPUT);
    if (sc.highWater?.cut) {
      // Un corte que baja por debajo del agua, de la salida hacia el lago (el agua de dentro no se dibuja)
      view.setCut({ x0: spawn.x - 40, y0: spawn.y - 40, x1: spawn.x + 40, y1: spawn.y + 40, zTop: 38 });
      rebakeChanged(b, view.frame().lights);
    }
    if (sc.highWater?.dig) {
      if (sc.highWater.prepHalf) { prep = gpu.prepareJob(b); for (let i = 0; i < 20; i++) prep.run(-Infinity); }
      if (sc.highWater.gpuFirst) {
        const m = view.frame().entities.find((e) => e.id === rt.entityId)!, p = viewOf(view.camera.viewDepth, b, m.x, m.y, m.z);
        gpu.read(view.frame(), b, { vx: p.vx, vy: p.vy, vw: VW, vh: VH, time: 0, lights: true, ambient: THEMES[sc.theme].ambient }, 'frame');
      }
      // Una poza ancha de la salida al lago (está a 3 bloques, y el lago es grande), hasta z 40 (el agua está a 44): el
      // agua del lago entra y se ve (picar en seco no crea agua: la que se ve es la que llega del lago)
      clearBox(state, { x0: Math.min(spawn.x, lake.x) - 14, y0: Math.min(spawn.y, lake.y) - 14, z0: 40, x1: Math.max(spawn.x, lake.x) + 14, y1: Math.max(spawn.y, lake.y) + 14, z1: 63 });
      for (let t = 0; t < 120; t++) rt.step(NO_INPUT);
      rebakeChanged(b, view.frame().lights);
    }
    const maia = view.frame().entities.find((e) => e.id === rt.entityId)!;
    const { vx, vy } = viewOf(view.camera.viewDepth, b, maia.x, maia.y, maia.z);
    const ambient = THEMES[sc.theme].ambient;
    let o: Frame2DOptions = { vx, vy, vw: VW, vh: VH, time: sc.ticks / 60, lights: sc.lights ?? true, ambient,
      ...(sc.highlight ? { highlight: { box: view.viewBox(sc.highlight(world)), color: [255, 214, 102] as const, width: 2 } } : {}), ...(sc.lightCap !== undefined ? { entityLightCap: sc.lightCap } : {}),
      ...(sc.xray ? { xray: { color: [120, 220, 255] as const } } : {}), ...(sc.cave ? { cave: [0.1, 0.09, 0.14] as const } : {}),
      ...(sc.clearBg ? { background: 'transparent' as const } : {}),
      ...(sc.fog ? { fog: { focusZ: maia.z + 8, start: 2, full: 10, color: [40, 44, 70] as const, strength: 0.75 } } : {}) };
    // (?sinclima=1: las mismas escenas sin el clima, para saber qué diferencias son de antes)
    const noClima = new URLSearchParams(location.search).has('sinclima');
    const meteo = new Weather({ seed: 11, levels: sc.clima?.levels ?? {} });
    meteo.importState({ ...meteo.exportState(), snow: sc.clima?.snow ?? 0, wet: sc.clima?.wet ?? 0 });
    if (sc.clima && !noClima) o = { ...o, weather: { weather: meteo, tick: sc.ticks, camera: view.camera, ...sc.clima.frame } };
    if (sc.prepared && !prep) prep = gpu.prepareJob(b);
    if (prep) { let n = 0; while (!prep.run(-Infinity)) if (++n > 100000) throw new Error('la subida por partes no acaba'); }
    if (sc.warm) gpu.prewarm(b, o, sc.warm(state));
    // (con ghost y seq: la secuencia de encender y apagar el velo, que se corre después de comparar la escena)
    let ghostSeq: ((r: Result, rs: RenderState) => void) | null = null;
    if (sc.section) {
      const p = rt.player, arm = sc.section.cross;
      const gh = sc.section.ghost;
      const at = (dx: number, alpha = gh?.alpha ?? 0) => {
        const zc = sc.section!.z ?? p.z;
        const cut = { ...sectionAround(view.camera, p.x + dx, p.y, zc, sc.section!.width), ...(gh ? { ghost: { z: zc + (gh.dz ?? 8), alpha, ...(gh.keepFacing ? { keepFacing: true } : {}) } } : {}) };
        if (!arm) return cut;
        const [vx, vy] = view.camera.pointToView(p.x + dx, p.y), [wx, wy] = b.cam.project(vx, vy, p.z + 8);
        const border = sc.section!.border ? { color: '#ffd666', width: sc.section!.border } : null;
        return { ...cut, window: arm === true ? crossWindow(wx, wy, { border }) : crossWindow(wx, wy, { arm, r: arm, border }) };
      };
      const painter = sc.section.painter ? new SectionPainter(b) : null;
      const step = (dx: number, alpha?: number): Frame2DOptions => {
        if (!painter) return { ...o, section: at(dx, alpha) };
        painter.set(at(dx, alpha), 1);
        painter.job()?.run(Infinity);
        return { ...o, sectionLayer: painter.layer() };
      };
      // (con ghost, los cuadros de antes con otras alphas y el cuadro entero: alpha cambia sin subir nada)
      for (const [k, dx] of [-16, -8].entries()) gpu.read(view.frame(), b, step(dx, gh ? [0.9, 0.1][k] : undefined), gh ? 'frame' : 'color');
      o = step(0);
      // El velo que se enciende y se apaga, cuadro a cuadro (lo que hace un juego al salir de una cueva a un tramo sin
      // nada que velar y volver a entrar): en cada paso, el cuadro de la GPU contra el de la CPU. Con el pintor, con la
      // caja de cada cuadro, y con dos capas hechas a mano que dicen no haber cambiado nada salvo llevar o no el velo
      if (gh && painter) ghostSeq = (r, rs) => {
        const seq: NonNullable<Result['veilSeq']> = [];
        const cmp = (name: string, oo: Frame2DOptions) => {
          const cpu = frame2D(rs, b, oo), g = gpu.read(rs, b, oo, 'frame'), L = sectionFor(b, oo), G = L?.ghost;
          let differ = 0, big = 0, veil = 0;
          for (let i = 0; i < VW * VH; i++) {
            let fd = 0;
            for (let ch = 0; ch < 4; ch++) fd = Math.max(fd, Math.abs(cpu[i * 4 + ch]! - g[i * 4 + ch]!));
            if (fd) differ++;
            if (fd > 2) big++;
          }
          if (L && G) for (let j = 0; j < L.h; j++) for (let i = 0; i < L.w; i++) {
            const qq = secIdx(L, L.x + i, j), x = L.x + i - oo.vx, y = L.y + j - oo.vy;
            if (x >= 0 && y >= 0 && x < VW && y < VH && L.mask[qq] === 1 && G.on[qq]) veil++;
          }
          seq.push({ step: name, differ, big, veil });
          if (big > 4 || differ / (VW * VH) > TOL_SHARE) r.pass = false;
        };
        const paint = (cut: ReturnType<typeof at>): Frame2DOptions => { painter.set(cut, 1); painter.job()?.run(Infinity); return { ...o, sectionLayer: painter.layer() }; };
        const { ghost: _g, ...plain } = at(0);
        void _g;
        cmp('pintor: encendido', paint(at(0)));
        cmp('pintor: apagado', paint(plain));
        cmp('pintor: sin nada que velar', paint({ ...plain, ghost: { z: 100000, alpha: gh.alpha } }));
        cmp('pintor: encendido otra vez', paint(at(0)));
        cmp('pintor: otra alpha', paint(at(0, 0.8)));
        const L = painter.layer();
        if (L?.ghost) {
          const bare: SectionLayer = { ...L, ghost: null, base: L, dirty: [] };
          cmp('a mano: la misma capa sin velo, sin columnas sucias', { ...o, sectionLayer: bare });
          cmp('a mano: y con velo otra vez, sin columnas sucias', { ...o, sectionLayer: { ...L, base: bare, dirty: [] } });
          cmp('a mano: sin velo otra vez', { ...o, sectionLayer: { ...bare, base: null } });
        }
        const { sectionLayer: _l, ...noLayer } = o;
        void _l;
        cmp('caja de cada cuadro: encendido', { ...noLayer, section: at(0) });
        cmp('caja de cada cuadro: apagado', { ...noLayer, section: plain });
        cmp('caja de cada cuadro: encendido otra vez', { ...noLayer, section: at(0, 0.6) });
        r.veilSeq = seq;
        // (la secuencia tiene que pasar por pasos con velo y sin él)
        if (!seq.some((s) => s.veil > 0) || !seq.some((s) => s.veil === 0)) r.pass = false;
      };
    }
    let before: { cpu: Uint8ClampedArray; gpu: Uint8Array } | null = null;
    if (ghostSeq && !sc.section?.ghost?.seq) ghostSeq = null;
    if (sc.shift) {
      const s0 = b.source, lights0 = view.frame().lights;
      const clone = new StaticVoxels(s0.palette, s0.width, s0.depth, s0.zMin, s0.zMax);
      clone.importChunks(s0.exportChunks());
      const cpuFinalOf = (rs: RenderState) => { const pp = frame2DParts(rs, b, o), ll = pp.total ? shadeLayers(pp.total, o, b, undefined, pp.sun) : null; return ll ? applyLayers(pp.view, ll) : pp.view.slice(); };
      if (sc.shift === 'vuelta') before = { cpu: cpuFinalOf(view.frame()), gpu: gpu.read(view.frame(), b, o, 'frame').slice() };
      else gpu.read(view.frame(), b, o, 'color');
      const c0 = gpu.shiftCount;
      shiftBaked(b, 1, 0);
      rebakeChanged(b, lights0.map((l) => ({ ...l, x: l.x - 16 })));
      (window as unknown as { __gpuShifts: () => number }).__gpuShifts = () => gpu.shiftCount - c0;
      if (sc.shift === 'ida') o = { ...o, vx: Math.max(0, o.vx - 16) };
      else {
        gpu.read(view.frame(), b, o, 'color');                        // la GPU sigue el corrimiento
        shiftBaked(b, -1, 0);
        for (let z = s0.zMin; z <= s0.zMax; z++) for (let y = 0; y < s0.depth; y++) for (let x = 0; x < 16; x++) { const v = clone.get(x, y, z); if (v) b.source.set(x, y, z, v); }
        rebakeChanged(b, lights0);
      }
    }
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
    const layers = parts.total ? shadeLayers(parts.total, o, b, undefined, parts.sun) : null;
    const secLine = sc.section?.border ? sectionFor(b, o) : null;
    // (con ghost, el cuadro lleva el cielo de la superficie de delante en lo que queda delante de un vóxel con velo: hace
    // falta la profundidad; las capas sueltas, sin ella, como las de la GPU)
    const veiled = !!(sc.section?.ghost && sectionFor(b, o)?.ghost);
    const cpuFinal = layers ? applyLayers(parts.view, veiled ? shadeLayers(parts.total!, o, b, parts.depth, parts.sun) : layers) : o.fog || secLine || veiled ? parts.view.slice() : parts.view;
    if (o.fog) applyFog(cpuFinal, parts.depth, b, o);
    if (o.background === 'transparent') clearTransparent(cpuFinal);
    if (veiled) applyGhost(cpuFinal, parts.depth, rs, b, o);
    // (el borde de la ventana del corte va solo en el cuadro final, encima de todo)
    drawSectionBorder(cpuFinal, secLine, o);
    const c1 = performance.now();
    const gFinal = gpu.read(rs, b, o, 'frame');
    const c2 = performance.now();
    const gColor = gpu.read(rs, b, o, 'color');
    const gMul = gpu.read(rs, b, o, 'multiply');
    const gAdd = gpu.read(rs, b, o, 'add');
    const empty = new Uint8ClampedArray(VW * VH * 4);
    // Los errores de WebGL que haya dejado la escena (una subida inválida no sube nada y no salta por sí sola)
    const gl = (gpu as unknown as { gl: WebGL2RenderingContext }).gl, glErrors: number[] = [];
    for (let e = gl.getError(); e !== gl.NO_ERROR && glErrors.length < 8; e = gl.getError()) glErrors.push(e);
    const r = compare(sc.name, { color: parts.view, mul: layers?.multiply ?? empty, add: layers?.add ?? empty, final: cpuFinal },
      { color: gColor, mul: gMul, add: gAdd, final: gFinal }, ambient, o.lights, [c1 - c0, c2 - c1], parts.total);
    if (sc.clima && !noClima) {
      // El control: la misma escena sin clima. La luz de la escena ya tiene empates sueltos a más de un nivel entre la CPU y la
      // GPU (sombras) que no son del clima: con él puede haber los del control y uno más por cada 20000 píxeles; el color,
      // ninguno
      const o0: Frame2DOptions = { ...o, weather: null }, p0 = frame2DParts(rs, b, o0), l0 = p0.total ? shadeLayers(p0.total, o0, b) : null;
      const c0f = l0 ? applyLayers(p0.view, l0) : p0.view;
      const r0 = compare(sc.name, { color: p0.view, mul: l0?.multiply ?? empty, add: l0?.add ?? empty, final: c0f }, { color: gpu.read(rs, b, o0, 'color'), mul: gpu.read(rs, b, o0, 'multiply'), add: gpu.read(rs, b, o0, 'add'), final: gpu.read(rs, b, o0, 'frame') }, ambient, o.lights, [0, 0], p0.total);
      r.control = { differ: r0.differ, mulOff2: r0.mulOff2, addOff2: r0.addOff2, colorOff: r0.colorOff };
      // (un clima que no cambia nada no prueba nada)
      if (!sc.name.startsWith('clima sin')) { r.climaPx = 0; for (let i = 0; i < VW * VH; i++) if ([0, 1, 2].some((ch) => parts.view[i * 4 + ch] !== p0.view[i * 4 + ch] || (parts.total && (parts.total[i * 3 + ch] !== p0.total![i * 3 + ch] || parts.sun?.amount[i])))) r.climaPx++; if (r.climaPx < 100) r.pass = false; }
      const room = Math.ceil((VW * VH) / 20000);
      if (!r.pass && (r.climaPx ?? 100) >= 100 && r.share <= TOL_SHARE && !r.colorOff && !r.alphaOff && r.mulOff2 <= r0.mulOff2 + room && r.addOff2 <= r0.addOff2 + room) r.pass = true;
    }
    if (glErrors.length) { r.glErrors = glErrors; r.pass = false; }
    if (sc.shift) r.gpuShifts = (window as unknown as { __gpuShifts: () => number }).__gpuShifts();
    if (before) {
      const same = (u: ArrayLike<number>, v: ArrayLike<number>) => { for (let i = 0; i < u.length; i++) if (u[i] !== v[i]) return false; return true; };
      r.backSame = { cpu: same(cpuFinal, before.cpu), gpu: same(gFinal, before.gpu) };
      if (!r.backSame.cpu || !r.backSame.gpu) r.pass = false;
    }
    // Con agua en un mundo alto: cuántos píxeles salen con un tono del agua (antes de la luz), para saber que se ve
    if (sc.highWater) {
      const tones = (state.water as WaterLayer).toneColors;
      let n = 0;
      for (let i = 0; i < VW * VH; i++) if (tones.some((t) => parts.view[i * 4] === t[0] && parts.view[i * 4 + 1] === t[1] && parts.view[i * 4 + 2] === t[2])) n++;
      r.waterPx = n;
      // Y en el recuadro de pantalla de la poza de "picando la orilla" (en las demás, el mismo recuadro, para comparar)
      const [ax, ay] = b.cam.project(Math.min(spawn.x, lake.x) - 14, Math.max(spawn.y, lake.y) + 15, 44), [bx, by] = b.cam.project(Math.max(spawn.x, lake.x) + 15, Math.min(spawn.y, lake.y) - 14, 40);
      let m = 0;
      for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
        const sx = x + vx, sy = y + vy, i = (y * VW + x) * 4;
        if (sx < ax || sx > bx || sy < ay || sy > by) continue;
        if (tones.some((t) => parts.view[i] === t[0] && parts.view[i + 1] === t[1] && parts.view[i + 2] === t[2])) m++;
      }
      r.waterPxNear = m;
    }
    if (sc.section) {
      const L = sectionFor(b, o);
      let n1 = 0, n2 = 0;
      if (L) for (let j = 0; j < L.h; j++) for (let i = 0; i < L.w; i++) {
        const x = L.x + i - vx, y = L.y + j - vy, m = L.mask[secIdx(L, L.x + i, j)];
        if (x < 0 || y < 0 || x >= VW || y >= VH || !m) continue;
        if (m === 1) n1++; else n2++;
        if (m === 1) {
          const qq = secIdx(L, L.x + i, j);
          if (!L.rgba[qq * 4 + 3]) r.secHoles = (r.secHoles ?? 0) + 1;
          else if (L.face[qq] === -1) r.secFill = (r.secFill ?? 0) + 1;
        }
        const q = (y * VW + x) * 4;
        let fd = 0;
        for (let ch = 0; ch < 3; ch++) fd = Math.max(fd, Math.abs(cpuFinal[q + ch]! - gFinal[q + ch]!));
        if (fd) { r.secDiffer = (r.secDiffer ?? 0) + 1; r.secMaxFinal = Math.max(r.secMaxFinal ?? 0, fd); }
      }
      r.secPx = n1; r.secBorder = n2;
      // El velo: cuántos píxeles lo llevan, qué hay delante y entre las dos superficies, y si se ve (contra alpha 1)
      const G = L?.ghost;
      if (sc.section.ghost) {
        r.veilPx = 0; r.veilFront = 0; r.veilBetween = 0; r.veilShown = 0; r.veilDiffer = 0;
        if (L && G) {
          const a0 = G.alpha;
          const o1: Frame2DOptions = o.section?.ghost ? { ...o, section: { ...o.section, ghost: { ...o.section.ghost, alpha: 1 } } } : o;
          G.alpha = 1;
          const opaque = frame2D(rs, b, o1);
          if (o.section) sectionFor(b, o); else G.alpha = a0;
          for (let j = 0; j < L.h; j++) for (let i = 0; i < L.w; i++) {
            const qq = secIdx(L, L.x + i, j), x = L.x + i - vx, y = L.y + j - vy;
            if (x < 0 || y < 0 || x >= VW || y >= VH || L.mask[qq] !== 1 || !G.on[qq]) continue;
            const t = y * VW + x, d = parts.depth[t]!;
            r.veilPx++;
            if (d < L.depth[qq]! - 0.5) r.veilFront++; else if (d < G.depth[qq]! - 0.5) r.veilBetween++;
            let shown = false, fd = 0;
            for (let ch = 0; ch < 4; ch++) { if (cpuFinal[t * 4 + ch] !== opaque[t * 4 + ch]) shown = true; fd = Math.max(fd, Math.abs(cpuFinal[t * 4 + ch]! - gFinal[t * 4 + ch]!)); }
            if (shown) r.veilShown++;
            if (fd > (sc.clima ? 1 : 0)) r.veilDiffer++;        // (con clima, un ±1 es redondeo de lo que hay debajo: agua que se ve a través, sol)
          }
        }
        // (una escena con ghost sin velo a la vista, o en la que no cambia nada, no prueba nada)
        if (!r.veilPx || !r.veilShown) r.pass = false;
        // (y el velo tiene que salir igual en las dos: como mucho unos píxeles de redondeo)
        if (r.veilDiffer > Math.max(4, r.veilPx * 0.005)) r.pass = false;
      }
      // El borde dibujado de la ventana: cuántos píxeles lleva en la vista y en cuántos la GPU no da justo su color
      if (L?.window?.border) {
        const c = rgbOf(L.window.border.color);
        let n = 0, off = 0;
        for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {
          if (!sectionBorderAt(L, x + vx, y + vy)) continue;
          n++;
          const q = (y * VW + x) * 4;
          if (gFinal[q] !== c[0] || gFinal[q + 1] !== c[1] || gFinal[q + 2] !== c[2] || gFinal[q + 3] !== 255) off++;
        }
        r.secLine = n; r.secLineOff = off;
        if (off || !n) r.pass = false;
      }
      r.secInfo = { cut: o.section ?? L?.box ?? null, rect: L ? [L.x, L.y, L.w, L.h, L.count] : null, view: [vx, vy], feet: [rt.player.x, rt.player.y, rt.player.z], ghost: L?.ghost ? [L.ghost.z, L.ghost.count] : null };
    }
    if (sc.clima && sc.veg && !noClima) {
      const L = sectionFor(b, o), from = swaySources(b, sceneLayer(L), L?.ghost?.on ?? null, climateTable(b, o)!, o.vx, o.vy, VW, VH);
      r.swayPx = 0; r.swayDiffer = 0;
      if (from) for (let t = 0; t < VW * VH; t++) {
        if (from[t] === o.vx + (t % VW)) continue;
        r.swayPx++;
        // (un ±1 es redondeo, p. ej. del agua que se ve a través; lo que se busca es que salga de otra columna)
        if ([0, 1, 2, 3].some((ch) => Math.abs(cpuFinal[t * 4 + ch]! - gFinal[t * 4 + ch]!) > 1)) r.swayDiffer++;
      }
      if (sc.algas) {
        const mask = aquaticMask(b, sceneLayer(L), L?.ghost?.on ?? null, from, o.vx, o.vy, VW, VH);
        r.aquaPx = 0; r.aquaDiffer = 0;
        if (mask) for (let t = 0; t < VW * VH; t++) if (mask[t]) { r.aquaPx++; if ([0, 1, 2].some((ch) => Math.abs(cpuFinal[t * 4 + ch]! - gFinal[t * 4 + ch]!) > 1)) r.aquaDiffer++; }
        if (r.aquaPx < 200 || r.aquaDiffer > Math.max(8, r.aquaPx * 0.01)) r.pass = false;
      }
      // (una escena en la que no se mece nada no prueba nada)
      if (!r.swayPx || r.swayDiffer > Math.max(4, r.swayPx * 0.005)) r.pass = false;
    }
    if (ghostSeq) ghostSeq(r, rs);
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
