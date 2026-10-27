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

// Un dash: avanza `dist` en la dirección (dx, dy) en línea recta, de una vez (llamarlo en el tick de la simulación).
// Respeta la colisión como moveBody pero sin rodear esquinas: si el avance entero choca, desliza por el eje que aún
// avanza (a lo largo de la pared), y si ninguno avanza se para ahí. Devuelve dónde acabó, cuánto recorrió y si chocó.
// Las cargas, el enfriamiento y la invulnerabilidad son del juego
export interface DashResult { x: number; y: number; z: number; traveled: number; hit: boolean }
export function dashBody(world: WorldState, body: Body, dx: number, dy: number, dist: number, rules: MoveRules = DEFAULT_RULES): DashResult {
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || !(dist > 0)) return { x: body.x, y: body.y, z: body.z, traveled: 0, hit: false };
  const ux = dx / len * dist, uy = dy / len * dist;
  const n = Math.max(1, Math.ceil(dist / SUBSTEP));
  const sx = ux / n, sy = uy / n;
  let hit = false, traveled = 0;
  const go = (nx: number, ny: number) => {
    if (!fits(world, nx, ny, body.z, body.r, rules)) return false;
    traveled += Math.hypot(nx - body.x, ny - body.y);
    body.x = nx;
    body.y = ny;
    body.z = restZ(world, nx, ny, body.r);
    return true;
  };
  for (let i = 0; i < n; i++) {
    if (go(body.x + sx, body.y + sy)) continue;
    hit = true;
    // Desliza por la pared: el eje que más avanza primero
    const axes = Math.abs(sx) >= Math.abs(sy) ? (['x', 'y'] as const) : (['y', 'x'] as const);
    let slid = false;
    for (const a of axes) {
      const d = a === 'x' ? sx : sy;
      if (d !== 0 && go(a === 'x' ? body.x + d : body.x, a === 'y' ? body.y + d : body.y)) { slid = true; break; }
    }
    if (!slid) break;
  }
  return { x: body.x, y: body.y, z: body.z, traveled, hit };
}

// El objeto (world/objects.ts) que tiene delante el cuerpo en la dirección (dx, dy), a `reach` vóxeles: el que le
// cortaría el paso (más alto que lo que sube de un paso). Para empujarlo: moveBody choca y el juego llama a
// world.objects.push con la fuerza de quien empuja. null si delante no hay objeto
export function objectAhead(world: WorldState, body: Body, dx: number, dy: number, reach = 1, rules: MoveRules = DEFAULT_RULES): number | null {
  const len = Math.hypot(dx, dy);
  if (!(len > 0) || !world.objects.size) return null;
  const tx = body.x + dx / len * reach, ty = body.y + dy / len * reach;
  let best: number | null = null;
  for (const [cx, cy] of footprint(tx, ty, body.r)) {
    for (const o of world.objects.inColumn(cx, cy)) {
      if (world.groundAt(cx + 0.5, cy + 0.5) - body.z <= rules.step) continue;
      if (best === null || o.id < best) best = o.id;
    }
  }
  return best;
}
