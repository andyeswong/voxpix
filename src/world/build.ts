// El escenario generado (worldgen de escenario-motor) construido en VÓXELES, 1 vóxel = 1 píxel del juego.
// Ejes del modelo: x hacia el este, y hacia el norte, z hacia arriba. La fila 0 del mapa es el norte.
import { material, type Palette, type Ramp, type VoxelSource } from '../core';
import { StaticVoxels } from './state';
import { WALL, TILE, NORTH, type Layout } from '../worldgen';
import type { SourceKind } from '../lighting/lights';

// Materiales del mundo (índice de rampa): el papel de cada rampa en la paleta del mundo. buildWorld pinta el suelo, las
// paredes, la fachada, la fuente y los muebles con estos índices; quien construye el mundo da los colores (WorldLook).
export const M = {
  floor: 0, wall: 1, cap: 2, column: 3, water: 4, wood: 5, metal: 6, flame: 7,
  neonPink: 8, neonCyan: 9, screen: 10, cloth: 11, warmGlass: 12, darkGlass: 13, grass: 14,
} as const;
export type WorldRole = keyof typeof M;

// Los nombres de las rampas, en el orden de M (el agua se llama 'agua': así la encuentran el render y la vegetación)
const ROLE_NAMES: Record<WorldRole, string> = {
  floor: 'suelo', wall: 'pared', cap: 'tapa', column: 'columna', water: 'agua', wood: 'madera', metal: 'metal', flame: 'llama',
  neonPink: 'neón rosa', neonCyan: 'neón cian', screen: 'pantalla', cloth: 'tela', warmGlass: 'ventana cálida', darkGlass: 'ventana oscura', grass: 'hierba',
};

// Los colores por defecto de cada papel (neutros: piedra gris y agua azul). Quien construye el mundo cambia los que quiera
export const DEFAULT_WORLD_RAMPS: Readonly<Record<WorldRole, readonly string[]>> = {
  floor: ['#1f1a17', '#352e28', '#4e463c', '#6e6454', '#8a7f6a'],
  wall: ['#1e2024', '#30343a', '#484e56', '#686f78', '#878e98'],
  cap: ['#2a2d34', '#3c4048', '#565c66', '#7a818c', '#9aa0aa'],
  column: ['#30291f', '#4a4032', '#625949', '#7c715e', '#9e927c'],
  water: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'],
  wood: ['#2e1c14', '#4a2e1c', '#6e4628', '#946436', '#b88850'],
  metal: ['#1c1e24', '#2e323a', '#4a505c', '#6e7684', '#a0a8b4'],
  flame: ['#a83a12', '#e0641c', '#ff9a3c', '#ffd166', '#fff3c0'],
  neonPink: ['#5a1640', '#a02a78', '#e04cb4', '#ff8ad8', '#ffd0f0'],
  neonCyan: ['#0e3a4a', '#1a7088', '#28b4d0', '#7fe3ff', '#d0f8ff'],
  screen: ['#0c1a34', '#1a3a6e', '#2a5aa0', '#3a78c8', '#a8d0ff'],
  cloth: ['#3a0e18', '#6a1a2a', '#9a2a3a', '#c4464e', '#e07870'],
  warmGlass: ['#3a2410', '#7a4a18', '#c07a28', '#f0b04a', '#ffe08a'],
  darkGlass: ['#0a0c14', '#141824', '#1e2436', '#2c344a', '#46506a'],
  grass: ['#1e2e16', '#2f4a22', '#46692e', '#6a9440', '#8cb85a'],
};

// Una rampa de un papel: sus colores, y si hace falta su material (un agua que brilla: { emissive: true })
export type WorldRampSpec = readonly string[] | { colors: readonly string[]; material?: string; emissive?: boolean; props?: Ramp['props'] };

// La paleta del mundo: las rampas en el orden de M, con los colores por defecto donde no se diga otra cosa
export function worldPalette(ramps: Partial<Record<WorldRole, WorldRampSpec>> = {}): Palette {
  return {
    ramps: (Object.keys(M) as WorldRole[]).map((role) => {
      const r = ramps[role] ?? DEFAULT_WORLD_RAMPS[role];
      const spec = Array.isArray(r) ? { colors: r as readonly string[] } : r as Exclude<WorldRampSpec, readonly string[]>;
      const ramp: Ramp = { name: ROLE_NAMES[role], colors: [...spec.colors] };
      if (spec.material) ramp.material = spec.material;
      if (spec.emissive) ramp.emissive = true;
      if (spec.props) ramp.props = { ...spec.props };
      return ramp;
    }),
  };
}

// Una columna del mapa (layout.pillar sin mueble): la loseta que ocupa, en ejes del modelo, y lo que necesita quien la
// construye. x0..x1, y0..y1 incluidos (TILE x TILE); cx, cy, su centro
export interface PillarSite {
  model: StaticVoxels;
  x0: number; y0: number; x1: number; y1: number;
  cx: number; cy: number;
  seed: number;
  noise(x: number, y: number, z: number): number;      // ruido determinista por vóxel en [0, 1)
}
export type PillarBuilder = (site: PillarSite) => void;

// Una losa del suelo seco (fuera del agua): el tipo de su loseta (layout.floor), su posición dentro de ella (lx, ly; la
// fila 0 de la loseta es su borde norte) y el tono que el motor le daría (0..4). Devuelve el vóxel (material)
export interface FloorSite {
  kind: string;
  cx: number; cy: number;              // la loseta (columna, fila del mapa)
  lx: number; ly: number;
  px: number; py: number;              // el píxel del juego (filas hacia abajo)
  tone: number;
  noise: number;                       // ruido determinista de este vóxel en [0, 1)
  seed: number;
}
export type FloorBuilder = (site: FloorSite) => number;

// Un tramo de la fachada norte (16 vóxeles de ancho, la cara sur de la pared, en y = faceY): la pieza que el
// generador puso ahí (layout.facade) y una ayuda para tallar un hueco de 1 vóxel con su fondo
export interface FacadeSite {
  model: StaticVoxels;
  piece: string;
  cx: number;                          // la columna del mapa
  x0: number;                          // la x del modelo donde empieza el tramo
  faceY: number;                       // la y del modelo de la cara de la pared (lo de delante, faceY - 1)
  seed: number;
  carve(lx0: number, lx1: number, z0: number, z1: number, inner: (lx: number, z: number) => number): void;
}
export type FacadeBuilder = (site: FacadeSite) => void;

// Una fuente de luz de la fachada (layout.sources con id facade-*): quien la construye pone su objeto y su luz
export interface FixtureSite {
  model: StaticVoxels;
  source: Layout['sources'][number];
  x: number;                           // la x del modelo
  faceY: number;
  lights: WorldLight[];
}
export type FixtureBuilder = (site: FixtureSite) => void;

// Un mueble (layout.props): su huella en ejes del modelo (x0..x1; yS al sur, yN al norte, incluidos)
export interface PropSite {
  model: StaticVoxels;
  prop: Layout['props'][number];
  x0: number; x1: number; yS: number; yN: number;
  lights: WorldLight[];
  seed: number;
}
export type PropBuilder = (site: PropSite) => void;

// Cómo se ve un mundo construido: la paleta (en el orden de M; worldPalette la hace), si lleva la fuente y quién
// construye cada pieza del mapa. El motor no sabe de temas ni lee nombres de pieza: cada juego o demo arma el suyo con
// esto (los de muestra, en src/samples/pieces.ts). Lo que no se dice, lo hace el motor de la forma más sencilla.
export interface WorldLook {
  palette: Palette;
  fountain?: boolean;                 // el pilón con agua y fuego (en el sitio libre más cercano a la salida); por defecto no
  pillar?: PillarBuilder | null;      // por defecto roundPillar; null: sin columnas de vóxeles (las pone decorate, o nadie)
  floor?: FloorBuilder;               // por defecto, la losa con el tono del motor (los tipos de loseta no cambian nada)
  facade?: FacadeBuilder;             // por defecto, la pared lisa
  fixture?: FixtureBuilder;           // por defecto, solo la luz (sin objeto), delante de la pared
  prop?: PropBuilder | null;          // por defecto blockProp; null: sin muebles de vóxeles
}

// Lo que el motor hace si el look no dice otra cosa
export const plainFloor: FloorBuilder = ({ tone }) => material(M.floor, Math.max(0, Math.min(4, tone)));
export const lightOnlyFixture: FixtureBuilder = ({ source, x, faceY, lights }) => {
  lights.push({ id: source.id, kind: source.kind, x: x + 0.5, y: faceY - 4, z: 19.5 });
};
// Un mueble como un bloque de madera de 12 de alto, metido 1 en su huella
export const blockProp: PropBuilder = ({ model, x0, x1, yS, yN }) => {
  for (let x = x0 + 1; x <= x1 - 1; x++) for (let y = yS + 1; y <= yN - 1; y++) for (let z = 0; z < 12; z++)
    model.set(x, y, z, material(M.wood, z === 11 ? 3 : 2));
};

// Ruido determinista por vóxel en [0, 1) (la misma semilla da el mismo mundo): el que usa buildWorld, para los constructores
export function worldNoise(x: number, y: number, z: number, seed: number): number { return hash(x, y, z, seed); }
function hash(x: number, y: number, z: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const WALL_H = 32;          // alto de la pared norte (la fachada del juego mide 32)
export const SIDE_WALL_H = 12;           // paredes de los lados: bajas, como tapas (en el juego solo se ve la tapa)
export const SOUTH_WALL_H = 6;           // la del sur, más baja: si no, taparía el suelo de delante
const COLUMN_H = 34;

// La columna de piedra redonda (la de siempre): un fuste de radio 6,5 con basa y capitel de 7,5, en la rampa columna
export const roundPillar: PillarBuilder = ({ model, cx, cy, noise }) => {
  for (let z = 0; z < COLUMN_H; z++) {
    const cap = z >= COLUMN_H - 3 || z < 2;
    const r = cap ? 7.5 : 6.5;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      model.set(x, y, z, material(M.column, cap ? 3 : z % 12 === 0 ? 1 : 2 + (noise(x, y, z) > 0.9 ? 1 : 0)));
    }
  }
};

// Una luz del mundo, en coordenadas del MODELO (vóxeles)
export interface WorldLight {
  id: number | string;
  kind: SourceKind;
  x: number; y: number; z: number;
  intensity?: number; radius?: number; color?: readonly [number, number, number];   // ajustes sobre el preset
  baked?: boolean;           // fija (se hornea); si no, dinámica (se suma cada cuadro)
  // Foco (linterna): alumbra solo dentro de un cono hacia `dir` (ejes del modelo), de `cone` grados de apertura. Sin
  // `dir`, alumbra en todas direcciones. Los focos son siempre dinámicos.
  dir?: readonly [number, number, number];
  cone?: number;
  // La entidad que la lleva (una linterna, un farol): su cuerpo no le hace sombra a esta luz
  owner?: number | string;
  // Va con una entidad: al final de cada tick se coloca en `offset` (y, si es un foco, apunta a `dir`), los dos en
  // los ejes del modelo de la entidad (el frente es -y), girados con su facing. Su dueño es esa entidad.
  follow?: { entity: number | string; offset: readonly [number, number, number]; dir?: readonly [number, number, number] };
}

export interface World {
  model: StaticVoxels;
  lights: WorldLight[];
  width: number;     // en vóxeles (x)
  depth: number;     // en vóxeles (y)
  // Agua inicial, en ejes del modelo (índice y * width + x). El agua es un fluido que se simula aparte; el fondo
  // de cada columna es la rejilla de alturas de los vóxeles sin el follaje (model.floorAt).
  wet: Uint8Array;              // 1 donde empieza habiendo agua
  waterTop: Int8Array;          // altura de su superficie inicial (1 = a ras del suelo; más en la fuente)
  fountain: Fountain | null;
  // Lo que flota al empezar (nenúfares...): buildWorldState los pone en el agua como flotantes (world/floaters.ts)
  floaters?: Array<{ x: number; y: number; model: VoxelSource; yaw?: number }>;
}

// Fuente: pilón redondo con agua por encima del suelo, fuste central y un cuenco con fuego arriba
export interface Fountain {
  x: number; y: number;         // centro, en ejes del modelo
  radius: number;               // radio interior del pilón (vóxeles)
  rim: number;                  // alto del borde
  level: number;                // nivel del agua dentro
  bowl: { z: number; radius: number };   // cuenco de arriba, del que cae el agua
}

// Profundidad máxima de la cuenca según el tamaño de la masa de agua (KIND_ID: 1 charco, 2 lago, 3 océano)
const BASIN_MAX = [0, 2, 4, 7];

// look: la paleta, la fuente y las columnas (WorldLook). Sin look, la paleta por defecto, sin fuente y columnas redondas
export function buildWorld(layout: Layout, look: WorldLook = { palette: worldPalette() }): World {
  const pal = structuredClone(look.palette);
  const W = layout.cols * TILE, D = layout.rows * TILE;
  const model = new StaticVoxels(pal, W, D, -10, 48);
  const my = (py: number) => D - 1 - py;            // fila de píxeles del juego -> y del modelo
  const seed = layout.seed;
  const lights: WorldLight[] = [];
  const cell = (cx: number, cy: number) => cy * layout.cols + cx;

  // ---- cuencas del agua: el fondo baja con la distancia a la orilla, hasta el máximo de su tipo.
  // (Aquí, y solo aquí, se trabaja en filas del worldgen, con y hacia abajo; lo que sale va en ejes del modelo.)
  const ground = new Int8Array(W * D), wet = new Uint8Array(W * D), waterTop = new Int8Array(W * D);
  {
    const dist = new Int32Array(W * D).fill(-1);
    const queue: number[] = [];
    for (let py = 0; py < D; py++) for (let px = 0; px < W; px++) {
      const c = cell(px >> 4, py >> 4);
      if (layout.water[py >> 4]?.[px >> 4] === '~' && layout.wall[c] === WALL.none) wet[py * W + px] = 1;
    }
    for (let i = 0; i < W * D; i++) if (!wet[i]) { dist[i] = 0; queue.push(i); }
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q]!, x = i % W;
      for (const j of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (j < 0 || j >= W * D || dist[j] !== -1) continue;
        dist[j] = dist[i]! + 1; queue.push(j);
      }
    }
    for (let i = 0; i < W * D; i++) {
      if (!wet[i]) continue;
      const px = i % W, py = (i - px) / W;
      const max = BASIN_MAX[layout.masses.kind[cell(px >> 4, py >> 4)] ?? 1] ?? 2;
      ground[i] = -Math.min(max, 1 + Math.floor((dist[i]! - 1) / 6));   // pendiente suave desde la orilla
      waterTop[i] = 1;                                                    // lleno hasta la cara de arriba del suelo
    }
  }

  // ---- suelo (z = 0, o el fondo de la cuenca), con juntas de losetas; cada losa, la del look
  const floorAt = look.floor ?? plainFloor;
  for (let cy = 0; cy < layout.rows; cy++) for (let cx = 0; cx < layout.cols; cx++) {
    const i = cell(cx, cy);
    if (layout.wall[i] !== WALL.none) continue;
    const kind = layout.floor[i] ?? 'piso';
    const wet = layout.water[cy]?.[cx] === '~';
    for (let ly = 0; ly < TILE; ly++) for (let lx = 0; lx < TILE; lx++) {
      const px = cx * TILE + lx, py = cy * TILE + ly;
      const n = hash(px, py, 0, seed);
      let v: number;
      const gz = ground[py * W + px]!;
      if (wet || gz < 0) {
        // fondo de la cuenca: barro oscuro, algo de arena en lo poco hondo
        model.set(px, my(py), gz, material(M.floor, gz >= -1 ? 1 : n < 0.2 ? 1 : 0));
        continue;
      } else if (lx === 0 || ly <= 1) {
        // junta (la horizontal de 2 vóxeles: con el suelo acortado a la mitad sigue saliendo de 1 píxel)
        v = material(M.floor, n < 0.5 ? 0 : 1);
      } else {
        const tone = 2 + (n < 0.035 ? -1 : n > 0.975 ? 1 : 0);   // poco ruido: el suelo no debe competir con los personajes
        v = floorAt({ kind, cx, cy, lx, ly, px, py, tone, noise: n, seed });
      }
      model.set(px, my(py), 0, v);
    }
  }
  // Orillas: donde una columna vecina es más honda, la pared de tierra que queda a la vista
  for (let py = 0; py < D; py++) for (let px = 0; px < W; px++) {
    const i = py * W + px;
    const g0 = ground[i]!;
    let low = g0;
    if (px > 0) low = Math.min(low, ground[i - 1]!);
    if (px < W - 1) low = Math.min(low, ground[i + 1]!);
    if (py > 0) low = Math.min(low, ground[i - W]!);
    if (py < D - 1) low = Math.min(low, ground[i + W]!);
    for (let z = low; z < g0; z++) model.set(px, my(py), z, material(M.floor, (z & 1) === 0 ? 0 : 1));
  }

  // ---- paredes. La norte ocupa solo la última de sus filas y mide 32: en la proyección del juego su cara (la
  // fachada) cae sobre las filas 1 y 2 y su tapa sobre la fila 0, como los tiles de pared del juego. Las demás, bajas.
  const northFront = NORTH * TILE;                 // primera fila de píxeles libre al sur de la pared norte
  for (let cy = 0; cy < layout.rows; cy++) for (let cx = 0; cx < layout.cols; cx++) {
    const i = cell(cx, cy);
    if (layout.wall[i] === WALL.none) continue;
    if (cy < NORTH - 1) continue;                  // detrás de la pared norte: lo tapa la propia pared
    const north = cy === NORTH - 1;
    const h = north ? WALL_H : cy === layout.rows - 1 ? SOUTH_WALL_H : SIDE_WALL_H;
    for (let ly = 0; ly < TILE; ly++) for (let lx = 0; lx < TILE; lx++) {
      const px = cx * TILE + lx, py = cy * TILE + ly;
      for (let z = 0; z < h; z++) {
        const top = z === h - 1;
        const n = hash(px, py, z, seed);
        let v: number;
        if (top) v = material(M.cap, (lx === 0 || ly === 0) ? 1 : 2 + (n > 0.95 ? 1 : 0));
        else v = material(M.wall, z % 8 === 0 || (((px + (z >> 3) * 8) % 16) === 0) ? 1 : 2 + (n > 0.96 ? 1 : n < 0.03 ? -1 : 0));
        model.set(px, my(py), z, v);
      }
    }
  }

  // ---- fachada norte: cada pieza decora su tramo de 16 vóxeles de la cara sur de la pared (la del look)
  const faceY = my(northFront - 1);                // y del modelo de la cara de la pared
  if (look.facade) for (let cx = 1; cx < layout.cols - 1; cx++) {
    const x0 = cx * TILE;
    look.facade({ model, piece: layout.facade[cx] ?? '', cx, x0, faceY, seed, carve: (lx0, lx1, z0, z1, inner) => {
      for (let lx = lx0; lx <= lx1; lx++) for (let z = z0; z <= z1; z++) {
        model.set(x0 + lx, faceY, z, 0);                                    // hueco de 1 vóxel
        model.set(x0 + lx, faceY + 1, z, inner(lx, z));                     // fondo del hueco
      }
    } });
  }

  // ---- fuentes de luz de la fachada: su objeto y su luz (las del look)
  const fixture = look.fixture ?? lightOnlyFixture;
  for (const s of layout.sources) if (s.id.startsWith('facade-')) fixture({ model, source: s, x: Math.round(s.x), faceY, lights });

  // ---- fuente: en el sitio libre (3x3 losetas sin pared, columna, mueble ni agua) más cercano a la salida
  let fountain: Fountain | null = null;
  if (look.fountain) {
    let best: [number, number] | null = null, bd = Infinity;
    const free = (cx: number, cy: number) => {
      if (cx < 1 || cy < 1 || cx >= layout.cols - 1 || cy >= layout.rows - 1) return false;
      const i = cell(cx, cy);
      return layout.wall[i] === WALL.none && !layout.pillar[i] && layout.water[cy]?.[cx] !== '~';
    };
    for (let cy = NORTH + 1; cy < layout.rows - 2; cy++) for (let cx = 2; cx < layout.cols - 2; cx++) {
      let ok = true;
      for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1 && ok; dx++) ok = free(cx + dx, cy + dy);
      if (!ok) continue;
      const fx = cx * TILE + 8, fy = cy * TILE + 8;
      const d = Math.hypot(fx - layout.spawn.x, fy - layout.spawn.y);
      if (d < 70) continue;                                   // que no tape el sitio de pelear de la salida
      if (d < bd) { bd = d; best = [fx, fy]; }
    }
    if (best) {
      const [fx, fy] = best;
      const R = 17, RIM = 5, LEVEL = 3;
      const cxm = fx, cym = my(fy);
      fountain = { x: cxm + 0.5, y: cym + 0.5, radius: R - 2, rim: RIM, level: LEVEL, bowl: { z: 20, radius: 6 } };
      for (let y = cym - R - 1; y <= cym + R + 1; y++) for (let x = cxm - R - 1; x <= cxm + R + 1; x++) {
        const d = Math.hypot(x + 0.5 - cxm, y + 0.5 - cym);
        if (d > R) continue;
        const px = x, py = D - 1 - y, i = py * W + px;
        if (d > R - 2) {
          // borde de piedra (con la piedra de las columnas), la tapa más clara
          for (let z = 0; z < RIM; z++) model.set(x, y, z, material(M.column, z === RIM - 1 ? 3 : z === 0 ? 1 : 2));
        } else {
          // fondo del pilón: piedra oscura; el agua llega a LEVEL
          model.set(x, y, 0, material(M.column, d < 4 ? 1 : 0));
          wet[i] = 1; waterTop[i] = LEVEL;
        }
      }
      // fuste y cuenco
      for (let z = 1; z < 20; z++) for (let y = cym - 3; y <= cym + 3; y++) for (let x = cxm - 3; x <= cxm + 3; x++) {
        if (Math.hypot(x + 0.5 - cxm, y + 0.5 - cym) > 2.6) continue;
        model.set(x, y, z, material(M.column, z % 6 === 0 ? 1 : 2));
        wet[(D - 1 - y) * W + x] = 0;
      }
      for (let z = 20; z <= 22; z++) for (let y = cym - 7; y <= cym + 7; y++) for (let x = cxm - 7; x <= cxm + 7; x++) {
        const d = Math.hypot(x + 0.5 - cxm, y + 0.5 - cym);
        const r = z === 20 ? 4 : 6.5;
        if (d > r) continue;
        if (z === 22 && d < 5) continue;                    // hueco del cuenco
        model.set(x, y, z, material(M.column, z === 22 ? 3 : 2));
      }
      // brasero en el tope: carbones y llama, y su luz
      for (let y = cym - 2; y <= cym + 2; y++) for (let x = cxm - 2; x <= cxm + 2; x++) {
        if (Math.hypot(x + 0.5 - cxm, y + 0.5 - cym) > 2.4) continue;
        model.set(x, y, 22, material(M.metal, 1));
        model.set(x, y, 23, material(M.flame, 2));
      }
      // llama alta: la luz va por encima del borde del cuenco, si no el propio cuenco haría sombra alrededor de la fuente
      for (let z = 24; z <= 30; z++) {
        const r = z < 27 ? 1.6 : z < 29 ? 1.1 : 0.6;
        for (let y = cym - 2; y <= cym + 2; y++) for (let x = cxm - 2; x <= cxm + 2; x++)
          if (Math.hypot(x + 0.5 - cxm, y + 0.5 - cym) <= r) model.set(x, y, z, material(M.flame, z > 27 ? 4 : 3));
      }
      lights.push({ id: 'fuente', kind: 'brazier', x: cxm + 0.5, y: cym + 0.5, z: 33 });
    }
  }

  // ---- columnas (las construye el look) y muebles
  const pillar = look.pillar === undefined ? roundPillar : look.pillar;
  if (pillar) for (let cy = 0; cy < layout.rows; cy++) for (let cx = 0; cx < layout.cols; cx++) {
    const i = cell(cx, cy);
    if (!layout.pillar[i] || layout.prop[i]) continue;
    const x0 = cx * TILE, yTop = my(cy * TILE);
    pillar({ model, x0, x1: x0 + TILE - 1, y0: yTop - TILE + 1, y1: yTop, cx: x0 + 7.5, cy: my(cy * TILE + 7.5), seed, noise: (x, y, z) => hash(x, y, z, seed) });
  }
  const prop = look.prop === undefined ? blockProp : look.prop;
  if (prop) for (const p of layout.props) {
    prop({ model, prop: p, x0: p.x * TILE, x1: (p.x + p.w) * TILE - 1, yN: my(p.y * TILE), yS: my((p.y + p.h) * TILE - 1), lights, seed });
  }

  // Lo que sale, en ejes del modelo
  const wetM = new Uint8Array(W * D), topM = new Int8Array(W * D);
  for (let py = 0; py < D; py++) for (let px = 0; px < W; px++) { const a = py * W + px, b = my(py) * W + px; wetM[b] = wet[a]!; topM[b] = waterTop[a]!; }
  return { model, lights, width: W, depth: D, wet: wetM, waterTop: topM, fountain };
}

// El estado del mundo completo de un nivel: lo estático, el agua (fluido), las luces y las gotas
import { WorldState } from './state';
import { WaterLayer } from './water';
import { FLOAT_MIN_DEPTH } from './floaters';

// La profundidad del agua de partida en cada columna (0 = seca), para colocar cosas antes de que exista el WaterLayer
// (planFoliage con waterDepth: juncos y nenúfares). El fondo es el suelo sin follaje.
export function worldWaterDepth(world: World): (x: number, y: number) => number {
  return (x, y) => {
    if (x < 0 || y < 0 || x >= world.width || y >= world.depth) return 0;
    const i = y * world.width + x;
    return world.wet[i] ? Math.max(0, world.waterTop[i]! - world.model.floorAt(x, y)) : 0;
  };
}

// decorate: cambia el mundo antes de crear el agua y el estado (vegetación con planFoliage, decorados del juego...).
// Si añade rampas, que ponga en world.model.palette una paleta NUEVA.
// Los flotantes de partida del mundo (world.floaters) en el estado, solo donde el simulador tiene agua (sus celdas de
// 2 x 2 toman el fondo más alto: una orilla que en la columna tenía agua puede quedar seca). Para quien crea el
// WorldState a mano; buildWorldState ya lo hace
export function addWorldFloaters(state: WorldState, world: World): void {
  for (const f of world.floaters ?? []) if (state.water && state.water.depthAt(f.x, f.y) >= FLOAT_MIN_DEPTH) state.floaters.add(f.model, f.x, f.y, f.yaw ?? 0);
}

export function buildWorldState(layout: Layout, look?: WorldLook, opts: { decorate?: (world: World) => void } = {}): { world: World; state: WorldState } {
  const world = buildWorld(layout, look);
  opts.decorate?.(world);
  const water = new WaterLayer(world);
  const state = new WorldState(world.model, world.lights, water, { seed: layout.seed, fountain: world.fountain });
  addWorldFloaters(state, world);
  state.warmUp();
  return { world, state };
}
