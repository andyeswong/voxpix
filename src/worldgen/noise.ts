// RUIDO con semilla, sin azar ni reloj (el mismo resultado en cualquier máquina): para generar mapas y terrenos.
// valueNoise da un valor suave en 0..1 sobre una rejilla de enteros; fbm suma octavas.

// Un valor en 0..1 por cada punto entero (x, y) y semilla
export function lattice(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Lo mismo en 30 bits enteros (0 .. 2^30 - 1): para bucles que lo piden cientos de veces por cuadro (un entero pequeño no crea
// nada en memoria; un número con decimales devuelto por una función, sí)
export const HASH_ONE = 1 << 30;
export function hash30(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 2;
}

// Ruido de valor suave en 0..1: interpola los de los 4 enteros de alrededor
export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(x0, y0, seed), b = lattice(x0 + 1, y0, seed), c = lattice(x0, y0 + 1, seed), d = lattice(x0 + 1, y0 + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

// Tres octavas con pesos 4, 2 y 1, en 0..1 (la de generateLayout: no cambiarla, cambiaría todos los mapas)
export function fbm(x: number, y: number, seed: number): number {
  return (valueNoise(x, y, seed) * 4 + valueNoise(x * 2, y * 2, seed + 1) * 2 + valueNoise(x * 4, y * 4, seed + 2)) / 7;
}

// N octavas: cada una al doble de frecuencia y la mitad de peso, en 0..1
export function fbmN(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0, norm = 0, w = 1, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, y * f, seed + o) * w;
    norm += w; w /= 2; f *= 2;
  }
  return norm ? sum / norm : 0.5;
}
