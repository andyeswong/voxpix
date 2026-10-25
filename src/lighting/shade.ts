// Copia de mi motor de luz del juego (escenario-motor/src/engine/lighting, 2026-10-24): la vista previa
// ilumina igual que el juego. Si cambia allí, copiarlo de nuevo.
// PARTE DE VISTA: pasa el mapa de luz a dos capas de píxeles (MULTIPLY y ADD) con pocos niveles y
// tramado, para que la luz conserve el aspecto de pixel art. Importa la parte pura; la pura NUNCA
// debe importar este archivo.
import type { LightField, Region } from './lightmap';

export interface ShadeOptions {
  steps: number;       // niveles por canal (p. ej. 5): menos niveles, más bandas marcadas
  glow: number;        // cuánto de lo que pasa de 1 se suma como brillo (0..1)
  dither: boolean;     // tramado ordenado en el borde de cada nivel
  // Brillo suave (recomendado): el exceso sobre 1 se mide en LUMINANCIA (un solo número por celda), con más niveles y
  // sin trama, y se suma con el TONO de la luz (no blanco: el blanco lava el color y levanta los negros como una
  // niebla). Sin esto el exceso se mide por canal y se trama: cada canal pasa de 1 en un sitio distinto, y salen bordes
  // de color (rosa/amarillo) y píxeles blancos sueltos. Por defecto apagado: no cambia lo que ya se hornea.
  softGlow: boolean;
}

export const DEFAULT_SHADE_OPTIONS: ShadeOptions = { steps: 5, glow: 0.4, dither: true, softGlow: false };

export interface LightLayers {
  width: number;
  height: number;
  multiply: Uint8ClampedArray;  // RGBA: va con blend MULTIPLY sobre el mundo
  add: Uint8ClampedArray;       // RGBA: va con blend ADD encima
}

// Matriz de Bayer 4×4: umbrales 0..15
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function quantize(v: number, steps: number, threshold: number): number {
  const top = steps - 1;
  const level = Math.min(top, Math.max(0, Math.floor(v * top + threshold)));
  return level / top;
}

// Capas de luz a resolución de píxel. Cada celda del mapa de luz se repite (nearest), sin suavizar.
export function buildLayers(field: LightField, region: Region, options: Partial<ShadeOptions> = {}): LightLayers {
  const { steps, glow, dither, softGlow } = { ...DEFAULT_SHADE_OPTIONS, ...options };
  const { width, height } = region;
  const multiply = new Uint8ClampedArray(width * height * 4);
  const add = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = Math.min(field.rows - 1, Math.floor(y / field.cell));
    for (let x = 0; x < width; x++) {
      const col = Math.min(field.cols - 1, Math.floor(x / field.cell));
      const i = (row * field.cols + col) * 3;
      const threshold = dither ? (BAYER[(y & 3) * 4 + (x & 3)]! + 0.5) / 16 : 0.5;
      const o = (y * width + x) * 4;
      // Brillo suave: lo que la luminancia de la luz pasa de 1, sin trama y con el doble de niveles, con el tono de la luz
      let soft = 0, peak = 1;
      if (softGlow) {
        const lum = 0.3 * field.total[i]! + 0.6 * field.total[i + 1]! + 0.1 * field.total[i + 2]!;
        soft = quantize(Math.min(1, Math.max(0, lum - 1) * glow), steps * 2, 0.5);
        peak = Math.max(field.total[i]!, field.total[i + 1]!, field.total[i + 2]!, 1e-6);
      }
      for (let ch = 0; ch < 3; ch++) {
        const t = field.total[i + ch]!;
        const base = Math.min(1, field.ambient[ch]!);
        // Solo lo que aportan las luces se cuantiza y se trama: donde no llega ninguna, el ambiente
        // queda exacto y plano. Si se trama todo, el suelo oscuro se llena de ruido de damero.
        const room = 1 - base;
        const lit = room > 0 ? quantize(Math.min(1, Math.max(0, t - base) / room), steps, threshold) * room : 0;
        multiply[o + ch] = Math.round((base + lit) * 255);
        add[o + ch] = Math.round((softGlow ? soft * Math.min(1, t / peak) : quantize(Math.min(1, Math.max(0, t - 1) * glow), steps, threshold)) * 255);
      }
      multiply[o + 3] = 255;
      add[o + 3] = 255;
    }
  }
  return { width, height, multiply, add };
}

// Lo mismo que hacen los dos blends al dibujar las capas sobre el mundo: escena × multiply + add
export function applyLayers(scene: Uint8ClampedArray, layers: LightLayers): Uint8ClampedArray {
  const out = new Uint8ClampedArray(scene.length);
  for (let i = 0; i < layers.width * layers.height; i++) {
    const o = i * 4;
    for (let ch = 0; ch < 3; ch++) out[o + ch] = scene[o + ch]! * layers.multiply[o + ch]! / 255 + layers.add[o + ch]!;
    out[o + 3] = scene[o + 3]!;
  }
  return out;
}
