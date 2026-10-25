// Motor de escenario: regiones de terreno (masas de agua y su tamaño).
// PARTE PURA (sim/ puede usarla): funciones sobre la rejilla de tiles, sin canvas, sin azar y sin importar render.
import { blobIndex, neighborMask } from './autotile';

// Una masa es un grupo de celdas del mismo tipo que se tocan por un lado (no basta una diagonal).
// El tamaño de la masa decide cómo se ve el mismo tile: charco, lago u océano.
export type MassKind = 'none' | 'puddle' | 'lake' | 'ocean';
export const KIND_ID: Record<MassKind, number> = { none: 0, puddle: 1, lake: 2, ocean: 3 };
export const KIND_BY_ID: readonly MassKind[] = ['none', 'puddle', 'lake', 'ocean'];

export interface MassOptions {
  puddleMax: number;      // hasta este número de celdas es un charco
  lakeMax: number;        // hasta este número, un lago; más, océano
  edgeIsMember: boolean;  // fuera del mapa cuenta como del mismo tipo (la masa sigue más allá del borde)
}

export const DEFAULT_MASS_OPTIONS: MassOptions = { puddleMax: 4, lakeMax: 120, edgeIsMember: true };

export interface MassMap {
  width: number;
  height: number;
  variant: Uint8Array;    // 0..46: qué pieza del autotile (solo vale donde region >= 0)
  region: Int32Array;     // número de masa de cada celda, -1 si la celda no es del tipo
  kind: Uint8Array;       // KIND_ID de la masa de la celda
  depth: Uint8Array;      // 1 en la orilla y +1 por cada celda hacia dentro (0 si no es del tipo)
  regionSizes: number[];  // celdas dentro del mapa de cada masa
}

// Analiza un tipo de terreno: pieza de autotile, masa, clase de masa y profundidad de cada celda
export function analyzeMasses(
  width: number,
  height: number,
  isMember: (x: number, y: number) => boolean,
  options: Partial<MassOptions> = {},
): MassMap {
  const opt = { ...DEFAULT_MASS_OPTIONS, ...options };
  const count = width * height;
  const member = new Uint8Array(count);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) member[y * width + x] = isMember(x, y) ? 1 : 0;
  const inside = (x: number, y: number): boolean => (x >= 0 && y >= 0 && x < width && y < height ? member[y * width + x] === 1 : opt.edgeIsMember);

  const variant = new Uint8Array(count);
  const region = new Int32Array(count).fill(-1);
  const kind = new Uint8Array(count);
  const depth = new Uint8Array(count);
  const regionSizes: number[] = [];

  // Masas: relleno por inundación, 4 vecinas
  const stack = new Int32Array(count);
  for (let start = 0; start < count; start++) {
    if (member[start] !== 1 || region[start]! >= 0) continue;
    const id = regionSizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    region[start] = id;
    while (top > 0) {
      const cell = stack[--top]!;
      size++;
      const x = cell % width;
      const y = (cell - x) / width;
      const visit = (nx: number, ny: number): void => {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
        const n = ny * width + nx;
        if (member[n] === 1 && region[n]! < 0) { region[n] = id; stack[top++] = n; }
      };
      visit(x + 1, y); visit(x - 1, y); visit(x, y + 1); visit(x, y - 1);
    }
    regionSizes.push(size);
  }

  // Profundidad: distancia (8 vecinas) a la celda de otro tipo más cercana
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = y * width + x;
      if (member[cell] !== 1) continue;
      variant[cell] = blobIndex(neighborMask(inside, x, y));
      let shore = false;
      for (let dy = -1; dy <= 1 && !shore; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx !== 0 || dy !== 0) && !inside(x + dx, y + dy)) { shore = true; break; }
      if (shore) { depth[cell] = 1; queue[tail++] = cell; }
    }
  }
  while (head < tail) {
    const cell = queue[head++]!;
    const x = cell % width;
    const y = (cell - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (member[n] === 1 && depth[n] === 0) { depth[n] = Math.min(255, depth[cell]! + 1); queue[tail++] = n; }
      }
    }
  }

  for (let cell = 0; cell < count; cell++) {
    const id = region[cell]!;
    if (id < 0) continue;
    const size = regionSizes[id]!;
    kind[cell] = KIND_ID[size <= opt.puddleMax ? 'puddle' : size <= opt.lakeMax ? 'lake' : 'ocean'];
    // Una masa sin ninguna orilla dentro del mapa (todo agua hasta el borde) queda con profundidad 0: la tratamos como profunda
    if (depth[cell] === 0) depth[cell] = 255;
  }
  return { width, height, variant, region, kind, depth, regionSizes };
}

export interface MassCell {
  kind: MassKind;
  depth: number;   // 0 si la celda no es del tipo
  region: number;  // -1 si la celda no es del tipo
}

// Lo que la simulación necesita saber de una celda (p. ej. para agua que frena o que bloquea).
// Recibe coordenadas de celda: para un punto del mundo, `Math.floor(x / TILE)`. Fuera del mapa devuelve undefined.
export function massAt(map: MassMap, x: number, y: number): MassCell | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  const i = y * map.width + x;
  return { kind: KIND_BY_ID[map.kind[i]!]!, depth: map.depth[i]!, region: map.region[i]! };
}
