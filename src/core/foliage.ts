// VEGETACIÓN (NARUTO, spec de KALADIN): hierba, flores, juncos, nenúfares y arbustos sobre la superficie de un
// modelo. planFoliage solo PLANEA (devuelve los vóxeles a poner): quien llama los aplica, en un paso de deshacer.
// Es determinista por semilla y mira el agua: más hierba cerca de la orilla, juncos donde cubre poco, nenúfares en
// la superficie. Las formas son de pixel art (un vóxel = un píxel): matas de 1 o 2, flores de tallo y cabeza,
// arbustos de radio 2 o 3.
import { decode, material, type Palette, type Ramp } from './palette';
import { rampMaterial } from './materials';
import { Model } from './model';

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
  zMin?: number;                 // hasta dónde bajar buscando la superficie (0 por defecto; las cuencas del juego, menos)
  // El agua como fluido aparte (el juego): la profundidad en cada columna (0 = seca), encima del vóxel más alto.
  // Con ella, juncos y nenúfares la ven aunque no haya vóxeles de agua (worldWaterDepth de src/world/build.ts)
  waterDepth?: (x: number, y: number) => number;
}

export interface FoliageSource {
  readonly palette: Palette;
  get(x: number, y: number, z: number): number;
  // Si la tiene (StaticVoxels): la altura de la cara de arriba de cada columna (índice y * width + x), para no buscar
  // la superficie desde zMax
  readonly height?: Int16Array;
  readonly width?: number;
  readonly depth?: number;
  readonly zMin?: number;                  // con width y depth (StaticVoxels): lo planeado se recorta al mundo
  readonly zMax?: number;
}

export const FOLIAGE_DENSITY: Record<FoliageType, number> = { grass: 0.35, flowers: 0.06, reeds: 0.35, lilies: 0.012, bush: 0.005 };

// Las rampas que la herramienta busca por nombre, y las que añade si faltan
export const FOLIAGE_RAMPS: Record<string, Ramp> = {
  'hierba-alta': { name: 'hierba-alta', colors: ['#24452a', '#3b6a33', '#5c923f', '#8fbf55'], material: 'follaje' },
  'flor-roja': { name: 'flor-roja', colors: ['#5a1424', '#a32638', '#e0504a'], material: 'follaje' },
  'flor-amarilla': { name: 'flor-amarilla', colors: ['#6b4a12', '#c08a1e', '#f2cf4a'], material: 'follaje' },
  'flor-blanca': { name: 'flor-blanca', colors: ['#6c6a78', '#b9b6c4', '#f1eee8'], material: 'follaje' },
  'flor-lila': { name: 'flor-lila', colors: ['#3d2457', '#71449a', '#b07ad8'], material: 'follaje' },
  junco: { name: 'junco', colors: ['#2a3a1e', '#4a5e2c', '#71843d', '#9fae58'], material: 'follaje' },
  nenufar: { name: 'nenufar', colors: ['#173b2a', '#2a6040', '#3f8a52', '#6db36a'], material: 'follaje' },
  arbusto: { name: 'arbusto', colors: ['#183522', '#28532d', '#3f7535', '#6a9a45'], material: 'arbusto' },
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
export const grassRamps = (p: Palette): number[] => p.ramps.flatMap((r, i) => (GRASSY.test(r.name) && rampMaterial(r).bed ? [i] : []));
export const waterRamps = (p: Palette): number[] => p.ramps.flatMap((r, i) => (WATERY.test(r.name) ? [i] : []));

// Hash de una celda en [0, 1): sin Math.random, para que la misma semilla dé lo mismo
function rnd(x: number, y: number, seed: number, salt: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul((seed | 0) + salt * 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

// voxels: los vóxeles a poner. floats: con agua fluida, los nenúfares no son vóxeles sino flotantes que mueve el agua
// (src/world/floaters.ts): x, y del centro y la forma (lilyPadModels)
export interface FoliagePlan { voxels: Array<[number, number, number, number]>; plants: number; floats: Array<[number, number, number]> }

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
  const zMin = o.zMin ?? 0;
  type Surface = { z: number; ramp: number; depth: number; wet: boolean; fluid: boolean } | null;
  // Cada columna se mira una vez (la orilla la consulta mucho): con rejilla de alturas, en un array por columna
  const seen = new Map<number, Surface>();
  const seenArr: Array<Surface | undefined> | null = src.height && src.width && src.depth ? new Array(src.width * src.depth) : null;
  const surface = (x: number, y: number): Surface => {
    if (seenArr) {
      if (x < 0 || y < 0 || x >= src.width! || y >= src.depth!) return null;
      const i = y * src.width! + x;
      let s = seenArr[i];
      if (s === undefined) seenArr[i] = s = scan(x, y);
      return s;
    }
    const k = (y + 32768) * 65536 + (x + 32768);
    let s = seen.get(k);
    if (s === undefined) seen.set(k, (s = scan(x, y)));
    return s;
  };
  const H = src.height, HW = src.width ?? 0, HD = src.depth ?? 0;
  const scan = (x: number, y: number): Surface => {
    let z = zMax;
    if (H) { if (x < 0 || y < 0 || x >= HW || y >= HD) return null; z = Math.min(zMax, H[y * HW + x]! - 1); }
    while (z >= zMin && !src.get(x, y, z)) z--;
    if (z < zMin) return null;
    const ramp = decode(src.get(x, y, z)).ramp;
    let depth = 0;
    if (water.has(ramp)) { let g = z; while (g >= zMin && src.get(x, y, g) && water.has(decode(src.get(x, y, g)).ramp)) g--; depth = z - g; }
    else if (o.waterDepth) {
      // El fluido: las celdas de agua (vacías en el modelo) van encima del vóxel más alto, como si fueran vóxeles
      const d = Math.round(o.waterDepth(x, y));
      if (d >= 1) return { z: z + d, ramp, depth: d, wet: true, fluid: true };
    }
    return { z, ramp, depth, wet: water.has(ramp), fluid: false };
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
  const floats: FoliagePlan['floats'] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s = surface(x, y);
    if (!s) continue;
    const r0 = rnd(x, y, seed, 1), r1 = rnd(x, y, seed, 2), r2 = rnd(x, y, seed, 3);
    switch (o.type) {
      case 'grass': case 'flowers': case 'bush': {
        if (s.wet || !on.has(s.ramp)) break;
        if (r0 >= density * 2 || (r0 >= density && !(o.type === 'grass' && toShore(x, y, false, 3)))) break;   // junto al agua, el doble
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
        // Nenúfares: una hoja de 2 a 4 vóxeles a ras del agua, donde es honda de 1 o más. Con agua de vóxeles sustituye
        // la capa de arriba; con agua fluida es un flotante (que el agua mueve), en floats
        if (!s.wet || s.depth < 1 || r0 >= density) break;
        if (s.fluid) { floats.push([x + 0.5, y + 0.5, Math.floor(r2 * LILY_SHAPES.length) % LILY_SHAPES.length]); plants++; break; }
        const bits = Math.floor(r2 * 8) | 1;
        let n = 0;
        for (const [k, dx, dy] of [[0, 0, 0], [1, 1, 0], [2, 0, 1], [4, 1, 1]] as const) {
          if (k && !(bits & k)) continue;
          const t = k ? surface(x + dx, y + dy) : s;
          if (!t || !t.wet || t.depth < 1 || t.z !== s.z) continue;
          const z = t.fluid ? t.z + 1 : t.z;
          if (t.fluid && !empty(x + dx, y + dy, z)) continue;
          put(x + dx, y + dy, z, mat(o.ramp, k === 0 && r1 < 0.25 ? 3 : 1 + ((dx + dy + Math.floor(r1 * 4)) % 2)));
          n++;
        }
        if (n) plants++;
        break;
      }
    }
  }
  const voxels: FoliagePlan['voxels'] = [];
  // Una planta junto al borde se extiende a las columnas vecinas: con un mundo de medida conocida, lo que caería fuera
  // no se planea (antes salía "vóxel fuera del mundo" al aplicarlo; p. ej. una puerta abierta en el borde)
  const inside = (x: number, y: number, z: number) => (src.width === undefined || (x >= 0 && x < src.width)) && (src.depth === undefined || (y >= 0 && y < src.depth))
    && (src.zMin === undefined || z >= src.zMin) && (src.zMax === undefined || z <= src.zMax);
  for (const [k, v] of planned) { const [x, y, z] = k.split(',').map(Number) as [number, number, number]; if (inside(x, y, z)) voxels.push([x, y, z, v]); }
  return { voxels, plants, floats };
}

// ---- las hojas de nenúfar que flotan: modelos pequeños (los pies en el origen), una por forma
// Cada forma: filas de arriba (norte) a abajo, '#' hoja, '+' hoja clara, '.' nada
const LILY_SHAPES: readonly string[][] = [
  ['##', '#+'],
  ['.#.', '#+#', '##.'],
  ['###', '#+.', '###'],
  ['.##', '##+', '.#.'],
];
// Las formas con la rampa del nenúfar. Comparten paleta: el mundo la añade una sola vez
export function lilyPadModels(ramp: Ramp): Model[] {
  const palette = { ramps: [ramp] };
  const top = ramp.colors.length - 1;
  return LILY_SHAPES.map((rows, k) => {
    const m = new Model(palette, `nenufar-${k}`);
    const h = rows.length, w = rows[0]!.length;
    rows.forEach((row, j) => [...row].forEach((ch, i) => {
      if (ch === '.') return;
      m.set(i - Math.floor(w / 2), Math.floor(h / 2) - j, 0, material(0, ch === '+' ? top : Math.min(top, 1 + ((i + j) % 2))));
    }));
    return m;
  });
}

