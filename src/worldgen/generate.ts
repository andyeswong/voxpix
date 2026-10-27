// Motor de escenario: el generador determinista de mapas por teselas.
// PARTE PURA (sim/ puede usarla): genera un nivel entero desde una semilla y un GeneratorSpec. La misma
// semilla y el mismo spec dan siempre el mismo mundo. Todo el azar sale de sim/rng.ts (con semilla).
import type { LightSource } from '../lighting/lights';
import { createRng } from '../sim/rng';
import { analyzeMasses, DEFAULT_MASS_OPTIONS, type MassMap } from '../terrain/regions';
import type { DoorSlot, GeneratorSpec } from './spec';
import { applyShape } from './shape';

export const TILE = 16;
export const FACADE_ROWS = 2;               // la fachada norte ocupa 2 filas de tiles (16x32 px)
export const NORTH = 1 + FACADE_ROWS;       // filas de la pared norte: tapa + fachada

// outside: fuera de la sala (con forma): ni suelo ni pared, el vacío. Solo hay pared donde toca el suelo de la sala
export const WALL = { none: 0, cap: 1, facadeTop: 2, facadeBottom: 3, outside: 4 } as const;

export interface PlacedProp {
  anim: string;
  x: number;                                // celda de la esquina noroeste de su huella
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  seed: number;
  cols: number;
  rows: number;
  caps: readonly [string, string];
  wall: Uint8Array;                         // WALL.* de cada celda
  floor: string[];                          // animación del suelo de cada celda ('' bajo las paredes)
  water: string[];                          // una fila por tile: '~' agua, '.' tierra (el contrato del nivel)
  masses: MassMap;
  pillar: Uint8Array;                       // 1 donde algo sólido bloquea paso y luz: columnas y muebles
  props: PlacedProp[];                      // muebles (sus celdas también están en pillar)
  prop: Uint8Array;                         // 1 donde hay un mueble (para que la vista no dibuje ahí una columna)
  facade: string[];                         // pieza de la fachada de cada columna
  sources: LightSource[];                   // fuentes de luz: las piezas de fachada que emiten y después los muebles que emiten
  materials: Array<{ x: number; y: number }>;
  spawn: { x: number; y: number };          // los pies del jugador, en píxeles
  doors?: DoorSlot[];                       // los huecos de puerta (spec.doors), abiertos o cerrados
  blocks?: Array<{ gx: number; gy: number; x0: number; y0: number }>;   // las salas de un mapa unido (stitchRooms), en losetas
}

// Ruido de valor suave con semilla (enteros, sin azar)
function lattice(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(x0, y0, seed), b = lattice(x0 + 1, y0, seed), c = lattice(x0, y0 + 1, seed), d = lattice(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}
function fbm(x: number, y: number, seed: number): number {
  return (valueNoise(x, y, seed) * 4 + valueNoise(x * 2, y * 2, seed + 1) * 2 + valueNoise(x * 4, y * 4, seed + 2)) / 7;
}

// Distancia (en losetas, contando las diagonales como 1) de cada loseta a la pared más cercana
function chebyshevToWall(wall: Uint8Array, cols: number, rows: number): Int32Array {
  const d = new Int32Array(cols * rows).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < wall.length; i++) if (wall[i]) { d[i] = 0; q.push(i); }
  for (let k = 0; k < q.length; k++) {
    const i = q[k]!, x = i % cols, y = (i - x) / cols;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (d[j] !== -1) continue;
      d[j] = d[i]! + 1; q.push(j);
    }
  }
  return d;
}

function pickWeighted<T extends { weight: number }>(items: readonly T[], r: number): T {
  let left = r * items.reduce((a, i) => a + i.weight, 0);
  for (const it of items) { left -= it.weight; if (left <= 0) return it; }
  return items[items.length - 1]!;
}

export function generateLayout(spec: GeneratorSpec, seed: number): Layout {
  const { cols, rows } = spec;
  const rng = createRng(seed * 7919 + 13);
  const at = (x: number, y: number) => y * cols + x;

  // Paredes: tapa por todo el borde y la fachada (dos filas) bajo la tapa norte
  const wall = new Uint8Array(cols * rows);
  for (let x = 0; x < cols; x++) { wall[x] = WALL.cap; wall[at(x, rows - 1)] = WALL.cap; }
  for (let y = 0; y < rows; y++) { wall[at(0, y)] = WALL.cap; wall[at(cols - 1, y)] = WALL.cap; }
  for (let x = 1; x < cols - 1; x++) { wall[at(x, 1)] = WALL.facadeTop; wall[at(x, 2)] = WALL.facadeBottom; }
  // La forma de la sala (shape.ts): las paredes de dentro
  const shaped = !!(spec.shape || spec.doors);
  const doors = shaped ? applyShape(spec.shape ?? null, spec.doors ?? null, wall, cols, rows, NORTH, seed, WALL.cap, WALL.outside) : undefined;

  // Agua: un océano en un costado, un lago y unos charcos, con la orilla rota por ruido. Deja dos tiles libres junto a las paredes.
  // En el rectángulo es la caja de dentro; con forma, lo que está a 3 o más losetas de cualquier pared (en el rectángulo,
  // lo mismo)
  const wallDist = shaped ? chebyshevToWall(wall, cols, rows) : null;      // (el vacío cuenta como pared)
  const inInterior = wallDist ? (x: number, y: number) => wallDist[at(x, y)]! >= 3
    : (x: number, y: number) => x >= 3 && x <= cols - 4 && y >= NORTH + 2 && y <= rows - 4;
  const side = Math.floor(rng() * 3);   // 0 izquierda, 1 derecha, 2 abajo
  const oceanY = rows * (0.45 + rng() * 0.25), oceanX = cols * (0.35 + rng() * 0.3);
  const lakeX = side === 0 ? cols * (0.6 + rng() * 0.2) : side === 1 ? cols * (0.2 + rng() * 0.2) : cols * (rng() < 0.5 ? 0.2 : 0.8);
  const lakeY = rows * (0.35 + rng() * 0.15), lakeRx = 4.6 + rng() * 1.6, lakeRy = 3.2 + rng() * 1.2;
  const puddles = Array.from({ length: spec.water.puddles }, () => ({ x: 5 + rng() * (cols - 10), y: NORTH + 3 + rng() * (rows - NORTH - 7), rx: 0.55 + rng() * 0.45, ry: 0.55 + rng() * 0.4 }));
  const buildWater = (grow: number): Uint8Array => {
    const w = new Uint8Array(cols * rows);
    const blob = (cx: number, cy: number, rx: number, ry: number, salt: number) => {
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (!inInterior(x, y)) continue;
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (d < 1 + (fbm(x * 0.32, y * 0.32, seed + salt) - 0.5) * 0.9) w[at(x, y)] = 1;
      }
    };
    if (spec.water.ocean) {
      const o = side === 0 ? [0, oceanY, 10, 14] : side === 1 ? [cols, oceanY, 10, 14] : [oceanX, rows + 1, 15, 8];
      blob(o[0]!, o[1]!, o[2]! * grow, o[3]! * grow, 100);
    }
    if (spec.water.lake) blob(lakeX, lakeY, lakeRx, lakeRy, 200);
    puddles.forEach((p, i) => blob(p.x, p.y, p.rx, p.ry, 300 + i));
    return w;
  };
  const analyze = (w: Uint8Array) => analyzeMasses(cols, rows, (x, y) => w[at(x, y)] === 1, { edgeIsMember: false });
  let water = buildWater(1);
  let masses = analyze(water);
  // Si hay océano tiene que serlo de verdad (más celdas que un lago): crece hasta serlo
  if (spec.water.ocean) {
    for (let grow = 1.12; grow < 2 && Math.max(0, ...masses.regionSizes) <= DEFAULT_MASS_OPTIONS.lakeMax + 20; grow += 0.12) {
      water = buildWater(grow);
      masses = analyze(water);
    }
  }
  // Un charco tiene que PARECER un charco: 1 celda, 2 pegadas o un 2x2. Una L o una raya de tres se lee como una tubería.
  // Los que salieron con otra forma se recortan a lo que sí es válido (nunca se borra del todo).
  let trimmed = false;
  masses.regionSizes.forEach((size, id) => {
    if (size > DEFAULT_MASS_OPTIONS.puddleMax || size < 3) return;
    const cells: Array<[number, number]> = [];
    for (let i = 0; i < masses.region.length; i++) if (masses.region[i] === id) cells.push([i % cols, Math.floor(i / cols)]);
    const xs = cells.map((c) => c[0]), ys = cells.map((c) => c[1]);
    const square = size === 4 && Math.max(...xs) - Math.min(...xs) === 1 && Math.max(...ys) - Math.min(...ys) === 1;
    if (square) return;
    const keep = cells[0]!;
    const mate = cells.find((c) => Math.abs(c[0] - keep[0]) + Math.abs(c[1] - keep[1]) === 1) ?? keep;
    for (const [x, y] of cells) if (!((x === keep[0] && y === keep[1]) || (x === mate[0] && y === mate[1]))) { water[at(x, y)] = 0; trimmed = true; }
  });
  if (trimmed) masses = analyze(water);
  // Y si se pidieron charcos tiene que haber al menos uno: si no salió ninguno se pone uno de una celda
  if (spec.water.puddles > 0 && !masses.regionSizes.some((n) => n <= DEFAULT_MASS_OPTIONS.puddleMax)) {
    for (let tries = 0; tries < 200; tries++) {
      const x = 4 + Math.floor(rng() * (cols - 8)), y = NORTH + 3 + Math.floor(rng() * (rows - NORTH - 7));
      let free = !wallDist || inInterior(x, y);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (water[at(x + dx, y + dy)]) free = false;
      if (!free) continue;
      water[at(x, y)] = 1;
      masses = analyze(water);
      break;
    }
  }

  // Punto de partida en tierra firme, lo más cerca posible del centro
  const landish = (x: number, y: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const cx = x + dx, cy = y + dy;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows || water[at(cx, cy)] === 1 || wall[at(cx, cy)] !== WALL.none) return false;
    }
    return true;
  };
  // El ancla: el centro, o el hueco de spec.spawnNear
  let ax = cols / 2, ay = rows / 2;
  if (spec.spawnNear) {
    const d = doors?.find((s) => s.side === spec.spawnNear);
    if (!d) throw new Error(`spawnNear: '${spec.spawnNear}' necesita spec.doors`);
    const mid = (d.from + d.to + 1) / 2;
    [ax, ay] = d.side === 'n' ? [mid, 0] : d.side === 's' ? [mid, rows] : d.side === 'w' ? [0, mid] : [cols, mid];
  }
  let sx = cols >> 1, sy = (rows >> 1) + 2, best = Infinity;
  // Con 2 losetas libres alrededor; si la forma no lo deja (pasillos estrechos), con 1, y si no, la loseta sola.
  // Junto a una puerta basta 1 de margen: mejor cerca de ella (en un pasillo) que en la otra punta con 2
  for (let r = spec.spawnNear ? 1 : 2; r >= 0 && best === Infinity; r--) for (let y = NORTH + r; y < rows - r; y++) for (let x = r; x < cols - r; x++) {
    if ((r === 2 && (y < NORTH + 2 || y >= rows - 2 || x < 2 || x >= cols - 2)) || !landish(x, y, r)) continue;
    const d = (x - ax) ** 2 + (y - ay) ** 2;
    if (d < best) { best = d; sx = x; sy = y; }
  }

  const pillar = new Uint8Array(cols * rows);
  const prop = new Uint8Array(cols * rows);
  const props: PlacedProp[] = [];
  const propSources: LightSource[] = [];

  // Muebles: huella entera sobre tierra, con una celda libre alrededor (para poder rodearlos), lejos de la salida
  for (const ps of spec.props ?? []) for (let n = 0; n < ps.count; n++) {
    for (let tries = 0; tries < 300; tries++) {
      let x = 2 + Math.floor(rng() * (cols - 3 - ps.w)), y = NORTH + 3 + Math.floor(rng() * (rows - NORTH - 5 - ps.h));
      if (ps.edge) {                                                  // pegado a una pared, elegida al azar
        const side = Math.floor(rng() * 4);
        if (side === 0) y = NORTH; else if (side === 1) y = rows - 1 - ps.h;
        else { y = NORTH + 2 + Math.floor(rng() * (rows - NORTH - 4 - ps.h)); x = side === 2 ? 1 : cols - 1 - ps.w; }
      }
      let ok = true;
      for (let dy = -1; dy <= ps.h && ok; dy++) for (let dx = -1; dx <= ps.w && ok; dx++) {
        const cx = x + dx, cy = y + dy;
        const inside = dx >= 0 && dx < ps.w && dy >= 0 && dy < ps.h;
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows || water[at(cx, cy)] === 1 || pillar[at(cx, cy)] === 1) ok = false;
        else if (wall[at(cx, cy)] !== WALL.none && (inside || !ps.edge)) ok = false;   // pegado a la pared sí, dentro de ella no
      }
      for (let dy = 0; dy < ps.h && ok; dy++) for (let dx = 0; dx < ps.w; dx++) if (Math.hypot(x + dx - sx, y + dy - sy) < 4.5) ok = false;
      if (!ok) continue;
      for (let dy = 0; dy < ps.h; dy++) for (let dx = 0; dx < ps.w; dx++) { pillar[at(x + dx, y + dy)] = 1; prop[at(x + dx, y + dy)] = 1; }
      if (ps.emits) propSources.push({ id: `prop-${props.length}`, kind: ps.emits, x: (x + ps.w / 2) * TILE, y: y * TILE + 1 });
      props.push({ anim: ps.anim, x, y, w: ps.w, h: ps.h });
      break;
    }
  }

  // Columnas: sobre tierra, lejos del agua, de las paredes, del punto de partida y entre sí
  let placed = 0;
  for (let tries = 0; tries < 400 && placed < spec.pillars; tries++) {
    const x = 3 + Math.floor(rng() * (cols - 6)), y = NORTH + 2 + Math.floor(rng() * (rows - NORTH - 5));
    if (!landish(x, y, 1) || Math.hypot(x - sx, y - sy) < 4.5) continue; // 4,5 celdas: deja >= 48 px libres para pelear
    if (wallDist && wallDist[at(x, y)]! < 3) continue;                     // con forma, ni en un pasillo: 2 losetas libres hasta la pared
    let near = false;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (pillar[at(x + dx, y + dy)]) near = true;
    if (near) continue;
    pillar[at(x, y)] = 1; placed++;
  }

  // Fachada norte: dos puertas con su pieza a cada lado, escudo en el centro, estandartes repartidos, y el resto al azar
  const f = spec.facade;
  const facade: string[] = new Array<string>(cols).fill(f.neutral);
  // Las posiciones son proporcionales al ancho: la arena puede ser de cualquier tamaño (con posiciones fijas
  // para 40 columnas, una puerta caía fuera de la pared en arenas más estrechas)
  const clampCol = (x: number) => Math.min(Math.max(Math.round(x), 3), cols - 4);
  const d1 = clampCol(cols * 0.14 + rng() * cols * 0.17);
  const d2 = Math.max(clampCol(cols * 0.55 + rng() * cols * 0.25), Math.min(d1 + 6, cols - 4));
  const fixed = new Map<number, string>();
  for (const d of [d1, d2]) {
    fixed.set(d, f.door);
    if (f.flank) { fixed.set(d - 1, f.flank); fixed.set(d + 1, f.flank); }
  }
  const mid = Math.floor((d1 + d2) / 2);
  if (f.crest) { fixed.set(mid, f.crest); fixed.set(mid + 1, f.crest); }
  if (f.banner) for (const b of [3, Math.floor((d1 + mid) / 2) + 1, Math.floor((mid + d2) / 2) + 2, cols - 4]) if (!fixed.has(b)) fixed.set(b, f.banner);
  let prev = '';
  for (let x = 1; x < cols - 1; x++) {
    let name = fixed.get(x);
    if (!name) {
      for (let attempt = 0; attempt < 12; attempt++) {
        name = pickWeighted(f.fill, rng()).anim;
        if (name !== prev || name === f.neutral) break;
      }
    }
    facade[x] = name!;
    prev = name!;
  }
  // Las piezas que emiten luz son fuentes: el ancla está en la mitad de la fachada
  const sources: LightSource[] = [];
  if (shaped) for (let x = 1; x < cols - 1; x++) if (wall[at(x, 2)] === WALL.outside) facade[x] = '';   // sobre el vacío, no hay fachada
  for (let x = 1; x < cols - 1; x++) {
    const kind = f.emits[facade[x]!];
    if (kind) sources.push({ id: `facade-${x}`, kind, x: x * TILE + 8, y: TILE + TILE });
  }
  sources.push(...propSources);

  // Suelo: al azar con peso, distinto en cada nivel (la semilla entra en el azar de cada celda)
  const floor: string[] = new Array<string>(cols * rows).fill('');
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (wall[at(x, y)] === WALL.none) floor[at(x, y)] = pickWeighted(spec.floors, lattice(x, y, seed + 7)).anim;
  }

  // Materiales sueltos sobre tierra, fuera de las columnas
  const materials: Array<{ x: number; y: number }> = [];
  for (let tries = 0; tries < 300 && materials.length < spec.materials; tries++) {
    const x = 2 + Math.floor(rng() * (cols - 4)), y = NORTH + 1 + Math.floor(rng() * (rows - NORTH - 3));
    if (water[at(x, y)] || wall[at(x, y)] || pillar[at(x, y)]) continue;
    materials.push({ x: x * TILE + 3, y: y * TILE + 3 });
  }

  const waterRows: string[] = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) line += water[at(x, y)] ? '~' : '.';
    waterRows.push(line);
  }
  return { seed, cols, rows, caps: spec.caps, wall, floor, water: waterRows, masses, pillar, props, prop, facade, sources, materials, spawn: { x: sx * TILE + 8, y: sy * TILE + 12 }, ...(doors ? { doors } : {}) };
}
