// Paleta cerrada por RAMPAS: cada material es una rampa de tonos ordenados de oscuro a claro, ya con su
// cambio de matiz hecho a mano por el artista. La luz no multiplica colores: mueve el tono dentro de la
// rampa. Así el render solo puede producir colores de la paleta (condición de MAIA) y el sombreado
// conserva el matiz que eligió el artista.

import { rampMaterial, type MaterialProps } from './materials';

export interface Ramp {
  name: string;
  colors: string[];          // '#rrggbb', de oscuro a claro
  emissive?: boolean;        // da luz propia: la luz del mundo no la oscurece (neones, plasma, hojas de energía)
  // El material de la rampa (src/core/materials.ts): un nombre de MATERIALS ('follaje', 'vidrio', 'metal'...) y,
  // si hace falta, propiedades sueltas encima. Sin nada, sólido.
  material?: string;
  props?: Partial<MaterialProps>;
  // Forma vieja (sigue valiendo): kind 'foliage' es el material 'follaje', y con blocks, 'arbusto'
  kind?: 'solid' | 'foliage';
  blocks?: boolean;
}

export interface Palette {
  ramps: Ramp[];
  outline?: string;          // color fijo del contorno exterior; sin él, el tono más oscuro de la rampa vecina
}

// Un vóxel guarda material = rampa * 16 + tono base. 0 es vacío, así que la rampa 0 tono 0 no existe:
// se reserva el valor 0 y se suma 1.
export const MAX_TONES = 16;
// Rampas como mucho: el material de un vóxel (rampa*16 + tono + 1) cabe en 16 bits con margen (la GPU lo guarda así)
export const MAX_RAMPS = 64;

// ---- follaje (vegetación): sus números viven en materials.ts, con el resto de materiales
export { FOLIAGE_T, FOLIAGE_BACKLIT } from './materials';
// El sol (sombra binaria): cada celda deja pasar la luz por entre 1 y FOLIAGE_SUN_MAX hojas, según un hash de su
// posición. Es entero, así que la CPU y la GPU dan exactamente la misma sombra moteada.
export const FOLIAGE_SUN_MAX = 4;
export function foliageSunDepth(x: number, y: number, z: number): number {
  let h = (Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 12)) >>> 0;
  return 1 + (h % FOLIAGE_SUN_MAX);
}

export function material(ramp: number, tone: number): number {
  if (ramp < 0 || tone < 0 || tone >= MAX_TONES) throw new Error(`material fuera de rango: rampa ${ramp}, tono ${tone}`);
  return ramp * MAX_TONES + tone + 1;
}

export function decode(value: number): { ramp: number; tone: number } {
  const v = value - 1;
  return { ramp: Math.floor(v / MAX_TONES), tone: v % MAX_TONES };
}

export function rgbOf(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`color no válido: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rampOf(p: Palette, ramp: number): Ramp {
  const r = p.ramps[ramp];
  if (!r) throw new Error(`la paleta no tiene la rampa ${ramp}`);
  return r;
}

// Todos los colores que la paleta permite, para comprobar que una imagen es cerrada
export function allowedColors(p: Palette): Set<string> {
  const s = new Set<string>();
  for (const r of p.ramps) for (const c of r.colors) s.add(c.toLowerCase());
  if (p.outline) s.add(p.outline.toLowerCase());
  return s;
}

export function validatePalette(p: Palette): void {
  if (!p.ramps.length) throw new Error('paleta sin rampas');
  if (p.ramps.length > MAX_RAMPS) throw new Error(`demasiadas rampas: ${p.ramps.length} (como mucho ${MAX_RAMPS})`);
  for (const r of p.ramps) {
    if (!r.colors.length || r.colors.length > MAX_TONES) throw new Error(`rampa ${r.name}: entre 1 y ${MAX_TONES} tonos`);
    for (const c of r.colors) rgbOf(c);
    rampMaterial(r);                    // un material que no existe falla aquí, con la lista
  }
  if (p.outline) rgbOf(p.outline);
}
