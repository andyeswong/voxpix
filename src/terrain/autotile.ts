// Motor de escenario: autotiles de 47 piezas (blob) para bordes de terreno y agua.
// PARTE PURA (sim/ puede usarla): solo números y funciones sobre la rejilla. No importa render ni Phaser.
// Autotile de 8 vecinas ("blob"): cada celda mira a sus vecinas del mismo tipo y eso elige la pieza.
// Los bits van en sentido horario desde el norte.
export const N = 1;
export const NE = 2;
export const E = 4;
export const SE = 8;
export const S = 16;
export const SW = 32;
export const W = 64;
export const NW = 128;

// Una esquina solo cuenta si sus dos lados contiguos también son vecinas: si no, ninguna pieza
// la distingue. De las 256 combinaciones quedan 47 piezas distintas.
export function reduceMask(mask: number): number {
  let m = mask & 0xff;
  if (!((m & N) && (m & E))) m &= ~NE;
  if (!((m & S) && (m & E))) m &= ~SE;
  if (!((m & S) && (m & W))) m &= ~SW;
  if (!((m & N) && (m & W))) m &= ~NW;
  return m;
}

// Las máscaras reducidas, en orden: la posición en esta lista es el índice de la variante (0..46)
export const BLOB47: readonly number[] = [...new Set(Array.from({ length: 256 }, (_, m) => reduceMask(m)))].sort((a, b) => a - b);

const INDEX = new Int8Array(256).fill(-1);
BLOB47.forEach((m, i) => { INDEX[m] = i; });

// Variante (0..46) para una máscara cualquiera
export function blobIndex(mask: number): number {
  return INDEX[reduceMask(mask)]!;
}

// Máscara de una celda: `isMember` dice si la vecina es del mismo tipo (y puede salirse del mapa)
export function neighborMask(isMember: (x: number, y: number) => boolean, x: number, y: number): number {
  return (isMember(x, y - 1) ? N : 0) | (isMember(x + 1, y - 1) ? NE : 0)
    | (isMember(x + 1, y) ? E : 0) | (isMember(x + 1, y + 1) ? SE : 0)
    | (isMember(x, y + 1) ? S : 0) | (isMember(x - 1, y + 1) ? SW : 0)
    | (isMember(x - 1, y) ? W : 0) | (isMember(x - 1, y - 1) ? NW : 0);
}
