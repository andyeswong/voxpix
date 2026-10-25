// Paleta cerrada por RAMPAS: cada material es una rampa de tonos ordenados de oscuro a claro, ya con su
// cambio de matiz hecho a mano por el artista. La luz no multiplica colores: mueve el tono dentro de la
// rampa. Así el render solo puede producir colores de la paleta (condición de MAIA) y el sombreado
// conserva el matiz que eligió el artista.

export interface Ramp {
  name: string;
  colors: string[];          // '#rrggbb', de oscuro a claro
  emissive?: boolean;        // da luz propia: la luz del mundo no la oscurece (neones, plasma, hojas de energía)
}

export interface Palette {
  ramps: Ramp[];
  outline?: string;          // color fijo del contorno exterior; sin él, el tono más oscuro de la rampa vecina
}

// Un vóxel guarda material = rampa * 16 + tono base. 0 es vacío, así que la rampa 0 tono 0 no existe:
// se reserva el valor 0 y se suma 1.
export const MAX_TONES = 16;

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
  for (const r of p.ramps) {
    if (!r.colors.length || r.colors.length > MAX_TONES) throw new Error(`rampa ${r.name}: entre 1 y ${MAX_TONES} tonos`);
    for (const c of r.colors) rgbOf(c);
  }
  if (p.outline) rgbOf(p.outline);
}
