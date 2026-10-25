// RUNTIME (FERN): el movimiento de un cuerpo sobre el estado del mundo. Puro y determinista: solo lee
// las consultas del mundo (WorldQuery), sin reloj ni azar. Ejes del modelo: x este, y norte, z arriba.
import type { WorldState } from '../world/state';

// Un cuerpo es un círculo de radio r apoyado en el suelo: (x, y) su centro y z la altura de sus pies
export interface Body {
  x: number;
  y: number;
  z: number;
  r: number;
}

export interface MoveRules {
  step: number;      // lo más que sube de un paso (un escalón)
  maxWater: number;  // agua más honda que esto no se pisa
}

export const DEFAULT_RULES: MoveRules = { step: 2, maxWater: 4.5 };

// El agua frena según la profundidad bajo los pies (los números de la demo de NARUTO). Menos de WADE es suelo
// mojado: ni frena ni salpica.
export const WADE = 0.3;
export function waterFactor(depth: number): number {
  return depth < WADE ? 1 : depth < 2.5 ? 0.8 : 0.55;
}

// Lo más que avanza en un subpaso: con menos de 1 vóxel no se salta una pared de 1 de grueso
const SUBSTEP = 0.5;

// Las columnas de vóxeles que pisa el círculo: las celdas cuyo punto más cercano al centro queda a menos de r
export function footprint(x: number, y: number, r: number): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
    for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
      const nx = Math.min(Math.max(x, cx), cx + 1) - x;
      const ny = Math.min(Math.max(y, cy), cy + 1) - y;
      if (nx * nx + ny * ny < r * r) cells.push([cx, cy]);
    }
  }
  return cells;
}

// ¿Cabe el cuerpo en (x, y) viniendo con los pies a feetZ? Todas las columnas que pisa tienen que ser pisables
export function fits(world: WorldState, x: number, y: number, feetZ: number, r: number, rules: MoveRules = DEFAULT_RULES): boolean {
  for (const [cx, cy] of footprint(x, y, r)) {
    if (!world.standable(cx + 0.5, cy + 0.5, feetZ, rules.step, rules.maxWater)) return false;
  }
  return true;
}

// Dónde se apoya: la columna más alta de las que pisa
export function restZ(world: WorldState, x: number, y: number, r: number): number {
  let z = -Infinity;
  for (const [cx, cy] of footprint(x, y, r)) z = Math.max(z, world.groundAt(cx + 0.5, cy + 0.5));
  return z;
}

// Mueve el cuerpo (dx, dy) en subpasos, cada eje por separado: si un eje choca, el otro sigue, y así resbala por
// las paredes. Contra algo redondo (una columna) eso no basta: los dos ejes chocan con la curva y el cuerpo se queda
// clavado. Entonces el eje que choca prueba a avanzar desviándose un poco hacia un lado (lo mismo que avanza, o el
// doble), primero hacia donde no empuja el otro eje: así rodea la curva como lo haría un círculo. Devuelve si algo
// lo frenó.
export function moveBody(world: WorldState, body: Body, dx: number, dy: number, rules: MoveRules = DEFAULT_RULES): boolean {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / SUBSTEP));
  let blocked = false;
  const go = (nx: number, ny: number) => {
    if (!fits(world, nx, ny, body.z, body.r, rules)) return false;
    body.x = nx;
    body.y = ny;
    body.z = restZ(world, nx, ny, body.r);
    return true;
  };
  for (let i = 0; i < n; i++) {
    let moved = false;
    for (const axis of ['x', 'y'] as const) {
      const d = (axis === 'x' ? dx : dy) / n;
      if (d === 0) continue;
      if (go(axis === 'x' ? body.x + d : body.x, axis === 'y' ? body.y + d : body.y)) { moved = true; continue; }
      blocked = true;
    }
    if (moved) continue;
    // Ningún eje avanzó: desvío. Se prueba el avance entero con un paso de lado, hacia fuera de lo que choca.
    deflect: for (const axis of ['x', 'y'] as const) {
      const d = (axis === 'x' ? dx : dy) / n;
      if (d === 0) continue;
      const other = axis === 'x' ? dy : dx;
      const signs = other > 0 ? [-1, 1] : other < 0 ? [1, -1] : [-1, 1];
      for (const k of [1, 2]) for (const s of signs) {
        const side = s * k * Math.abs(d);
        if (go(axis === 'x' ? body.x + d : body.x + side, axis === 'y' ? body.y + d : body.y + side)) break deflect;
      }
    }
  }
  return blocked;
}
