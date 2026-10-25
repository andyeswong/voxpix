// Motor de escenario: el aspecto del agua por teselas (charco, lago, océano).
// PARTE DE VISTA: dibuja piezas. Importa la parte pura; la parte pura NUNCA debe importar este archivo.
import { BLOB47, E, N, NE, NW, S, SE, SW, W } from './autotile';
import { KIND_ID, type MassKind } from './regions';

// Piezas de agua de 16×16, dibujadas por reglas. Son transparentes donde no hay agua, así que van
// SOBRE el suelo y se ve lo que haya debajo. Cada variante es una rejilla de tonos indexados;
// solo después se colorea (según la clase de masa y la profundidad). Así la iluminación podrá
// trabajar sobre los índices sin tocar el dibujo.
export const TILE = 16;
export const TONE = { clear: 0, edge: 1, foam: 2, body: 3, ripple: 4 } as const;
export const DEPTH_STEPS = 4;

const INSET = 2;   // cuánto se retira el agua de un lado que no tiene vecina
const ROUND = 4;   // radio de las esquinas convexas
const FOAM = 2;    // grosor de la espuma, en px, hacia dentro desde el borde

// ¿El punto (px, py), en coordenadas de la pieza, está dentro de la forma del agua retirada `i` px del borde?
// Con i = INSET es el contorno exterior; con i mayor, el mismo contorno desplazado hacia dentro.
function inside(mask: number, px: number, py: number, i: number): boolean {
  const k = i - INSET;
  // Lados sin vecina: el agua se retira
  if (!(mask & N) && py < i) return false;
  if (!(mask & S) && py > TILE - i) return false;
  if (!(mask & W) && px < i) return false;
  if (!(mask & E) && px > TILE - i) return false;
  // Esquinas convexas (dos lados sin vecina): redondeadas
  const r = ROUND - k;
  if (r > 0) {
    const c = INSET + ROUND;
    const far = TILE - c;
    if (!(mask & N) && !(mask & W) && px < c && py < c && Math.hypot(px - c, py - c) > r) return false;
    if (!(mask & N) && !(mask & E) && px > far && py < c && Math.hypot(px - far, py - c) > r) return false;
    if (!(mask & S) && !(mask & W) && px < c && py > far && Math.hypot(px - c, py - far) > r) return false;
    if (!(mask & S) && !(mask & E) && px > far && py > far && Math.hypot(px - far, py - far) > r) return false;
  }
  // Esquinas cóncavas (la diagonal no es agua pero sus dos lados sí): un cuarto de círculo de tierra.
  // Su radio vale lo mismo que el retroceso de los lados (i), y así la orilla casa con la pieza vecina.
  if ((mask & N) && (mask & W) && !(mask & NW) && Math.hypot(px, py) < i) return false;
  if ((mask & N) && (mask & E) && !(mask & NE) && Math.hypot(px - TILE, py) < i) return false;
  if ((mask & S) && (mask & W) && !(mask & SW) && Math.hypot(px, py - TILE) < i) return false;
  if ((mask & S) && (mask & E) && !(mask & SE) && Math.hypot(px - TILE, py - TILE) < i) return false;
  return true;
}

const cache = new Map<number, Uint8Array>();

// Rejilla de tonos (16×16) de una variante del autotile (0..46)
export function waterTone(variant: number): Uint8Array {
  const hit = cache.get(variant);
  if (hit) return hit;
  const mask = BLOB47[variant];
  if (mask === undefined) throw new Error(`variante fuera de rango: ${variant}`);
  const tone = new Uint8Array(TILE * TILE);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let t: number = TONE.clear;
      if (inside(mask, px, py, INSET)) {
        if (!inside(mask, px, py, INSET + 1)) t = TONE.edge;
        else if (!inside(mask, px, py, INSET + 1 + FOAM)) t = TONE.foam;
        else t = (x * 7 + y * 13 + variant * 5) % 29 === 0 ? TONE.ripple : TONE.body;
      }
      tone[y * TILE + x] = t;
    }
  }
  cache.set(variant, tone);
  return tone;
}

export interface WaterPalette {
  edge: string;
  foam: string;
  body: readonly [string, string, string, string];     // de la orilla (0) al fondo (3)
  ripple: readonly [string, string, string, string];
  // Opacidad de cada tono (0..1; por defecto 1). Un charco de gotera pide transparencia: deja ver el suelo y las
  // juntas de debajo, y no parece un agujero. El atlas lleva el alfa; la vista lo mezcla al dibujar.
  alpha?: { edge?: number; foam?: number; body?: number; ripple?: number };
}

export const WATER_PALETTES: Record<Exclude<MassKind, 'none'>, WaterPalette> = {
  // Charco suave y transparente: azul húmedo que deja ver el suelo, borde fino de poco contraste y un brillo en el centro.
  // (El anterior, opaco y casi negro, se leía como un agujero sobre un suelo claro.)
  puddle: { edge: '#34506c', foam: '#c4d8e8', body: ['#5a7ea8', '#5a7ea8', '#52759c', '#52759c'], ripple: ['#dcecf8', '#dcecf8', '#cce0f0', '#cce0f0'], alpha: { edge: 0.55, foam: 0.5, body: 0.5, ripple: 0.7 } },
  lake: { edge: '#0b1a2e', foam: '#8ec0d8', body: ['#2a78ae', '#216499', '#18507e', '#103a62'], ripple: ['#4a98c8', '#3a82b4', '#2a6c9c', '#1e547e'] },
  ocean: { edge: '#08142a', foam: '#9ad0e8', body: ['#1e5c9a', '#164a84', '#0f386a', '#0a2850'], ripple: ['#3a84c0', '#2c6caa', '#205490', '#163e72'] },
};

function rgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

// Pasa una rejilla de tonos a RGBA. `step` (0..3) es la profundidad del cuerpo del agua
export function colorize(tone: Uint8Array, palette: WaterPalette, step: number): Uint8ClampedArray {
  const s = Math.min(DEPTH_STEPS - 1, Math.max(0, step));
  const colors: Record<number, [number, number, number]> = {
    [TONE.edge]: rgb(palette.edge),
    [TONE.foam]: rgb(palette.foam),
    [TONE.body]: rgb(palette.body[s]!),
    [TONE.ripple]: rgb(palette.ripple[s]!),
  };
  const a = palette.alpha ?? {};
  const alphas: Record<number, number> = {
    [TONE.edge]: a.edge ?? 1, [TONE.foam]: a.foam ?? 1, [TONE.body]: a.body ?? 1, [TONE.ripple]: a.ripple ?? 1,
  };
  const out = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < tone.length; i++) {
    const c = colors[tone[i]!];
    if (!c) continue;
    out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, alphas[tone[i]!] ?? 1)));
  }
  return out;
}

// Paso de profundidad (0..3) de una celda: la orilla (profundidad 1) es el paso 0
export function depthStep(depth: number): number {
  return Math.min(DEPTH_STEPS - 1, Math.max(0, depth - 1));
}

// Atlas con todas las piezas: 47 columnas (variantes) × 12 filas (3 clases × 4 profundidades).
// Es lo que se sube a una textura. `cellRect` da dónde está cada una.
export const ATLAS_ROWS = 3 * DEPTH_STEPS;
export function cellRect(variant: number, kind: MassKind, step: number): { x: number; y: number; w: number; h: number } {
  const row = (KIND_ID[kind] - 1) * DEPTH_STEPS + Math.min(DEPTH_STEPS - 1, Math.max(0, step));
  return { x: variant * TILE, y: row * TILE, w: TILE, h: TILE };
}

export function buildWaterAtlas(palettes: Record<Exclude<MassKind, 'none'>, WaterPalette> = WATER_PALETTES): { width: number; height: number; data: Uint8ClampedArray } {
  const width = BLOB47.length * TILE;
  const height = ATLAS_ROWS * TILE;
  const data = new Uint8ClampedArray(width * height * 4);
  for (const kind of ['puddle', 'lake', 'ocean'] as const) {
    for (let step = 0; step < DEPTH_STEPS; step++) {
      for (let v = 0; v < BLOB47.length; v++) {
        const rgba = colorize(waterTone(v), palettes[kind], step);
        const r = cellRect(v, kind, step);
        for (let y = 0; y < TILE; y++) data.set(rgba.subarray(y * TILE * 4, (y + 1) * TILE * 4), ((r.y + y) * width + r.x) * 4);
      }
    }
  }
  return { width, height, data };
}
