// VEGETACIÓN (NARUTO, spec de KALADIN): hierba, flores, juncos, nenúfares y arbustos sobre la superficie de un
// modelo. planFoliage solo PLANEA (devuelve los vóxeles a poner): quien llama los aplica, en un paso de deshacer.
// Es determinista por semilla y mira el agua: más hierba cerca de la orilla, juncos donde cubre poco, nenúfares en
// la superficie. Las formas son de pixel art (un vóxel = un píxel): matas de 1 o 2, flores de tallo y cabeza,
// arbustos de radio 2 o 3.
import { decode, material, type Palette, type Ramp } from './palette';

export type FoliageType = 'grass' | 'flowers' | 'reeds' | 'lilies' | 'bush';
export const FOLIAGE_TYPES: readonly FoliageType[] = ['grass', 'flowers', 'reeds', 'lilies', 'bush'];

export interface FoliageOptions {
  type: FoliageType;
  density?: number;              // 0..1: probabilidad por columna (cada tipo trae la suya)
  seed?: number;
  ramp: number;                  // la rampa de la planta (para las flores, la del tallo)
  heads?: readonly number[];     // flores: las rampas de las cabezas (una al azar por flor)
  on?: readonly number[];        // rampas sobre las que crece (hierba, flores, arbustos); por defecto las de hierba
  water?: readonly number[];     // rampas de agua; por defecto las que se llaman agua o water
}

export interface FoliageSource {
  readonly palette: Palette;
  get(x: number, y: number, z: number): number;
}

export const FOLIAGE_DENSITY: Record<FoliageType, number> = { grass: 0.35, flowers: 0.06, reeds: 0.35, lilies: 0.1, bush: 0.005 };

// Las rampas que la herramienta busca por nombre, y las que añade si faltan
export const FOLIAGE_RAMPS: Record<string, Ramp> = {
  'hierba-alta': { name: 'hierba-alta', colors: ['#24452a', '#3b6a33', '#5c923f', '#8fbf55'], kind: 'foliage' },
  'flor-roja': { name: 'flor-roja', colors: ['#5a1424', '#a32638', '#e0504a'], kind: 'foliage' },
  'flor-amarilla': { name: 'flor-amarilla', colors: ['#6b4a12', '#c08a1e', '#f2cf4a'], kind: 'foliage' },
  'flor-blanca': { name: 'flor-blanca', colors: ['#6c6a78', '#b9b6c4', '#f1eee8'], kind: 'foliage' },
  'flor-lila': { name: 'flor-lila', colors: ['#3d2457', '#71449a', '#b07ad8'], kind: 'foliage' },
  junco: { name: 'junco', colors: ['#2a3a1e', '#4a5e2c', '#71843d', '#9fae58'], kind: 'foliage' },
  nenufar: { name: 'nenufar', colors: ['#173b2a', '#2a6040', '#3f8a52', '#6db36a'], kind: 'foliage' },
  arbusto: { name: 'arbusto', colors: ['#183522', '#28532d', '#3f7535', '#6a9a45'], kind: 'foliage', blocks: true },
};
// Qué rampas usa cada tipo por defecto (la primera, la planta; en las flores, el resto son las cabezas)
export const FOLIAGE_DEFAULTS: Record<FoliageType, readonly string[]> = {
  grass: ['hierba-alta'],
  flowers: ['hierba-alta', 'flor-roja', 'flor-amarilla', 'flor-blanca', 'flor-lila'],
  reeds: ['junco'],
  lilies: ['nenufar'],
  bush: ['arbusto'],
};

const GRASSY = /^(hierba|grass|pasto|c[eé]sped|prado)$/i;
const WATERY = /^(agua|water)$/i;
export const grassRamps = (p: Palette): number[] => p.ramps.flatMap((r, i) => (GRASSY.test(r.name) && r.kind !== 'foliage' ? [i] : []));
export const waterRamps = (p: Palette): number[] => p.ramps.flatMap((r, i) => (WATERY.test(r.name) ? [i] : []));

// Hash de una celda en [0, 1): sin Math.random, para que la misma semilla dé lo mismo
function rnd(x: number, y: number, seed: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul((seed | 0) + salt * 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export interface FoliagePlan { voxels: Array<[number, number, number, number]>; plants: number }

// Planea la vegetación en el rectángulo [x0..x1] x [y0..y1] (incluidos). zMax: hasta dónde buscar la superficie.
export function planFoliage(src: FoliageSource, x0: number, y0: number, x1: number, y1: number, zMax: number, o: FoliageOptions): FoliagePlan {
  const pal = src.palette;
  const seed = o.seed ?? 1;
  const density = Math.max(0, Math.min(1, o.density ?? FOLIAGE_DENSITY[o.type]));
  const on = new Set(o.on ?? grassRamps(pal));
  const water = new Set(o.water ?? waterRamps(pal));
  const tones = (r: number) => pal.ramps[r]?.colors.length ?? 1;
  const mat = (r: number, t: number) => material(r, Math.max(0, Math.min(tones(r) - 1, t)));
  const planned = new Map<string, number>();
  const empty = (x: number, y: number, z: number) => !planned.has(`${x},${y},${z}`) && !src.get(x, y, z);
  const put = (x: number, y: number, z: number, v: number) => { planned.set(`${x},${y},${z}`, v); };

  // La superficie de una columna: el vóxel más alto, su rampa, y si es agua, cuánta y dónde está el fondo
  const surface = (x: number, y: number) => {
    let z = zMax;
    while (z >= 0 && !src.get(x, y, z)) z--;
    if (z < 0) return null;
    const ramp = decode(src.get(x, y, z)).ramp;
    let depth = 0;
    if (water.has(ramp)) { let g = z; while (g >= 0 && src.get(x, y, g) && water.has(decode(src.get(x, y, g)).ramp)) g--; depth = z - g; }
    return { z, ramp, depth, wet: water.has(ramp) };
  };
  // Distancia (en columnas, hasta `max`) a la orilla: desde tierra, al agua más cercana; desde el agua, a la tierra
  const toShore = (x: number, y: number, wet: boolean, max: number) => {
    for (let r = 1; r <= max; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const s = surface(x + dx, y + dy);
      if (s && s.wet !== wet) return r;
    }
    return 0;
  };

  let plants = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s = surface(x, y);
    if (!s) continue;
    const r0 = rnd(x, y, seed, 1), r1 = rnd(x, y, seed, 2), r2 = rnd(x, y, seed, 3);
    switch (o.type) {
      case 'grass': case 'flowers': case 'bush': {
        if (s.wet || !on.has(s.ramp)) break;
        const boost = o.type === 'grass' && toShore(x, y, false, 3) ? 2 : 1;
        if (r0 >= density * boost) break;
        const z = s.z + 1;
        if (o.type === 'grass') {
          if (!empty(x, y, z)) break;
          const tall = r1 < 0.3;
          put(x, y, z, mat(o.ramp, tall ? 1 : 1 + Math.floor(r2 * 2)));
          if (tall && empty(x, y, z + 1)) put(x, y, z + 1, mat(o.ramp, 2 + Math.floor(r2 * 2)));
        } else if (o.type === 'flowers') {
          const stem = 1 + (r1 < 0.4 ? 1 : 0);
          let ok = true;
          for (let k = 0; k <= stem; k++) if (!empty(x, y, z + k)) ok = false;
          if (!ok) break;
          for (let k = 0; k < stem; k++) put(x, y, z + k, mat(o.ramp, 1 + k));
          const heads = o.heads?.length ? o.heads : [o.ramp];
          const head = heads[Math.floor(r2 * heads.length) % heads.length]!;
          put(x, y, z + stem, mat(head, tones(head) - 1 - Math.floor(rnd(x, y, seed, 4) * 2)));
        } else {
          // Arbusto: una mancha de radio 2 o 3 que se apoya en el suelo de su centro
          const R = 2 + (r1 < 0.5 ? 1 : 0), Hh = R;
          for (let dz = 0; dz <= Hh; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
            const d = Math.hypot(dx / (R + 0.4), dy / (R + 0.4), dz / (Hh + 0.6));
            if (d > 1 || rnd(x + dx, y + dy, seed + dz, 5) < 0.12) continue;
            const cx = x + dx, cy = y + dy, cz = z + dz;
            if (!empty(cx, cy, cz)) continue;
            if (dz === 0 && !src.get(cx, cy, cz - 1)) continue;          // no flota sobre un hueco
            put(cx, cy, cz, mat(o.ramp, dz >= Hh - 1 ? 2 + (rnd(cx, cy, seed, 6) < 0.3 ? 1 : 0) : 1));
          }
        }
        plants++;
        break;
      }
      case 'reeds': {
        // Juncos: donde el agua cubre 1 o 2, pegados a la orilla; salen del fondo y asoman de 1 a 2
        if (!s.wet || s.depth < 1 || s.depth > 2 || r0 >= density || !toShore(x, y, true, 1)) break;
        const g = s.z - s.depth, top = s.z + 1 + (r1 < 0.5 ? 1 : 0);
        for (let z = g + 1; z <= top; z++) put(x, y, z, mat(o.ramp, z <= s.z ? 1 : z === top ? 3 : 2));
        plants++;
        break;
      }
      case 'lilies': {
        // Nenúfares: una hoja a ras del agua (sustituye la capa de arriba), donde el agua es honda de 1 o más
        if (!s.wet || s.depth < 1 || r0 >= density) break;
        put(x, y, s.z, mat(o.ramp, r1 < 0.25 ? 3 : 1 + Math.floor(r2 * 2)));
        plants++;
        break;
      }
    }
  }
  const voxels: FoliagePlan['voxels'] = [];
  for (const [k, v] of planned) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; voxels.push([x, y, z, v]); }
  return { voxels, plants };
}
