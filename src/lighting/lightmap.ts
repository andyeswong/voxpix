// Copia de mi motor de luz del juego (escenario-motor/src/engine/lighting, 2026-10-24): la vista previa
// ilumina igual que el juego. Si cambia allí, copiarlo de nuevo.
// PARTE PURA (sim/ puede usarla): el mapa de luz. Funciones sobre la rejilla de tiles, sin canvas.
import { lightIntensity, type Ambient, type Light } from './lights';

// Zona del mundo que se ilumina, en píxeles
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LightOptions {
  cell: number;   // px de mundo por celda del mapa de luz (2 o 4: más grande, más barato y más "pixel")
  tile: number;   // px de mundo por tile del mapa de oclusión
  occluders?: readonly Occluder[];   // cuerpos que se mueven (el personaje, un enemigo) y también dan sombra
}

// Un cuerpo opaco que no cabe en la rejilla de tiles: una elipse de centro (x, y) en píxeles de mundo.
// Da sombra a lo que queda detrás de él visto desde una luz, pero no a sí mismo ni a la luz que lleva
// dentro (el farol del personaje no se tapa con el personaje).
export interface Occluder {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

// ¿El segmento a-b pasa por el cuerpo? Se escala la elipse a un círculo unidad y se mide la distancia al segmento.
export function shadowedBy(ax: number, ay: number, bx: number, by: number, o: Occluder): boolean {
  const ux = (ax - o.x) / o.rx, uy = (ay - o.y) / o.ry;
  const vx = (bx - o.x) / o.rx, vy = (by - o.y) / o.ry;
  if (ux * ux + uy * uy < 1 || vx * vx + vy * vy < 1) return false;   // luz o destino dentro del cuerpo
  const dx = vx - ux, dy = vy - uy;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return false;
  const t = Math.min(1, Math.max(0, -(ux * dx + uy * dy) / len2));
  const cx = ux + t * dx, cy = uy + t * dy;
  return cx * cx + cy * cy < 1;
}

export const DEFAULT_LIGHT_OPTIONS: LightOptions = { cell: 2, tile: 16 };

// Luz total por celda y canal: ambiente + suma de luces. Puede pasar de 1 (deslumbra).
export interface LightField {
  cell: number;
  cols: number;
  rows: number;
  ambient: readonly [number, number, number];   // lo que hay donde no llega ninguna luz
  total: Float32Array;                          // cols * rows * 3
}

// ¿Hay un tile opaco entre a y b? Recorre la rejilla de tiles (Amanatides-Woo). El tile de origen
// y el de destino no cuentan: una luz pegada a un muro lo alumbra, y una pared recibe luz en su cara.
export function blocked(
  ax: number, ay: number, bx: number, by: number,
  tile: number,
  opaque: (tx: number, ty: number) => boolean,
): boolean {
  let x = Math.floor(ax / tile);
  let y = Math.floor(ay / tile);
  const targetX = Math.floor(bx / tile);
  const targetY = Math.floor(by / tile);
  if (x === targetX && y === targetY) return false;
  const dx = bx - ax;
  const dy = by - ay;
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const deltaX = dx !== 0 ? Math.abs(tile / dx) : Infinity;
  const deltaY = dy !== 0 ? Math.abs(tile / dy) : Infinity;
  let maxX = dx !== 0 ? ((dx > 0 ? (x + 1) * tile - ax : ax - x * tile) / Math.abs(dx)) : Infinity;
  let maxY = dy !== 0 ? ((dy > 0 ? (y + 1) * tile - ay : ay - y * tile) / Math.abs(dy)) : Infinity;
  const limit = Math.abs(targetX - x) + Math.abs(targetY - y) + 2;
  for (let i = 0; i < limit; i++) {
    if (maxX < maxY) { x += stepX; maxX += deltaX; } else { y += stepY; maxY += deltaY; }
    if (x === targetX && y === targetY) return false;
    if (opaque(x, y)) return true;
  }
  return false;
}

// Calcula la luz de una zona. `opaque` dice qué tiles bloquean la luz (muros, columnas...).
export function computeLight(
  region: Region,
  lights: readonly Light[],
  ambient: Ambient,
  opaque: (tx: number, ty: number) => boolean,
  time: number,
  options: Partial<LightOptions> = {},
): LightField {
  const { cell, tile } = { ...DEFAULT_LIGHT_OPTIONS, ...options };
  const occluders = options.occluders ?? [];
  const cols = Math.ceil(region.width / cell);
  const rows = Math.ceil(region.height / cell);
  const total = new Float32Array(cols * rows * 3);
  for (let i = 0; i < cols * rows; i++) {
    total[i * 3] = ambient.color[0]; total[i * 3 + 1] = ambient.color[1]; total[i * 3 + 2] = ambient.color[2];
  }
  for (const light of lights) {
    const strength = lightIntensity(light, time);
    if (strength <= 0 || light.radius <= 0) continue;
    // Solo las celdas dentro del cuadrado que rodea a la luz
    const c0 = Math.max(0, Math.floor((light.x - light.radius - region.x) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((light.x + light.radius - region.x) / cell));
    const r0 = Math.max(0, Math.floor((light.y - light.radius - region.y) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((light.y + light.radius - region.y) / cell));
    for (let r = r0; r <= r1; r++) {
      const py = region.y + (r + 0.5) * cell;
      for (let c = c0; c <= c1; c++) {
        const px = region.x + (c + 0.5) * cell;
        const d = Math.hypot(px - light.x, py - light.y);
        if (d >= light.radius) continue;
        const k = 1 - d / light.radius;
        const att = k * k * strength;
        if (att < 0.002) continue;
        if (blocked(light.x, light.y, px, py, tile, opaque)) continue;
        if (occluders.some((o) => shadowedBy(light.x, light.y, px, py, o))) continue;
        const i = (r * cols + c) * 3;
        total[i] = total[i]! + light.color[0] * att;
        total[i + 1] = total[i + 1]! + light.color[1] * att;
        total[i + 2] = total[i + 2]! + light.color[2] * att;
      }
    }
  }
  return { cell, cols, rows, ambient: ambient.color, total };
}
