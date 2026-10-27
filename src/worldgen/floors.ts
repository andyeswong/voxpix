// Motor de escenario: PISOS. Una partida que sube de piso en piso: cada piso es una sala con forma, con una entrada
// (por donde se llega, junto a la que se aparece) y una salida cerrada que el juego abre cuando toca. También da un
// hueco libre y alcanzable para lo que el juego quiera poner (la tienda). PARTE PURA y determinista: solo depende de
// sus argumentos, sin estado (la curva de balance crea miles).
import { createRng } from '../sim/rng';
import { generateLayout, NORTH, TILE, WALL, type Layout } from './generate';
import type { DoorSlot, GeneratorSpec, ShapeSpec, Side } from './spec';

export interface FloorExit {
  slot: DoorSlot;                          // el hueco (cerrado hasta openDoors o openDoorInWorld)
  x: number;                               // la loseta de suelo justo dentro del hueco, en píxeles (centro)
  y: number;
}

export interface Floor {
  layout: Layout;
  floor: number;
  entry: Side;
  spawn: { x: number; y: number };         // los pies del jugador al llegar, en píxeles (= layout.spawn)
  exit: FloorExit;
  shop: { x: number; y: number };          // centro de una loseta libre con 1 de margen, alcanzable, en píxeles
}

// La semilla de cada piso: distinta por piso y estable
export function floorSeed(seed: number, floor: number): number {
  return (Math.imul(seed | 0, 2654435761) ^ Math.imul((floor | 0) + 1, 40503)) >>> 0;
}

// El piso `floor` (0, 1, 2...) de la partida `seed`. Se entra por el sur y la salida es otro lado, al azar con la
// semilla del piso (nunca el de la entrada). shape la elige el juego; sin ella, la del spec (o el rectángulo).
export function floorLayout(spec: GeneratorSpec, seed: number, floor: number, shape?: ShapeSpec): Floor {
  const fs = floorSeed(seed, floor);
  const entry: Side = 's';
  const sides = ['n', 'e', 'w'] as const;
  const exitSide = sides[Math.floor(createRng(fs ^ 0x5bd1e995)() * sides.length)]!;
  const layout = generateLayout({ ...spec, ...(shape ? { shape } : {}), doors: spec.doors ?? {}, spawnNear: entry }, fs);
  const slot = layout.doors!.find((d) => d.side === exitSide)!;
  const { cols, rows } = layout;
  const at = (x: number, y: number) => y * cols + x;
  const walkable = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && layout.wall[at(x, y)] === WALL.none
    && !layout.pillar[at(x, y)] && layout.water[y]![x] !== '~';

  // Distancias (BFS en losetas) desde el punto de partida
  const dist = new Int32Array(cols * rows).fill(-1);
  const sx = Math.floor(layout.spawn.x / TILE), sy = Math.floor(layout.spawn.y / TILE);
  const q = [at(sx, sy)];
  dist[q[0]!] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h]!, x = c % cols, y = (c / cols) | 0;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (!walkable(nx, ny) || dist[at(nx, ny)]! >= 0) continue;
      dist[at(nx, ny)] = dist[c]! + 1;
      q.push(at(nx, ny));
    }
  }

  // La loseta de dentro del hueco de salida: la más cercana al borde que ya es suelo de la sala, en la fila (o
  // columna) del centro del hueco
  const mid = (slot.from + slot.to) >> 1;
  let ex = mid, ey = mid;
  if (exitSide === 'n') { ey = NORTH; while (ey < rows - 1 && !walkable(ex, ey)) ey++; }
  if (exitSide === 'e') { ex = cols - 2; while (ex > 0 && !walkable(ex, ey)) ex--; }
  if (exitSide === 'w') { ex = 1; while (ex < cols - 1 && !walkable(ex, ey)) ex++; }

  // La tienda: una loseta con sus 8 vecinas libres, alcanzable, a 4 o más losetas de la salida y lo más lejos posible
  // de la llegada (sin pasarse del 70 % del recorrido más largo, para que no quede en el rincón del fondo)
  let far = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i]! > far) far = dist[i]!;
  const target = Math.max(4, Math.round(far * 0.7));
  let best = -1, bestScore = Infinity;
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < cols - 1; x++) {
    const d = dist[at(x, y)]!;
    if (d < 4) continue;
    let clear = true;
    for (let dy = -1; dy <= 1 && clear; dy++) for (let dx = -1; dx <= 1; dx++) if (!walkable(x + dx, y + dy)) { clear = false; break; }
    if (!clear || Math.hypot(x - ex, y - ey) < 4) continue;
    const score = Math.abs(d - target) * 1000 + y * cols + x;           // a igualdad, la primera en orden de lectura
    if (score < bestScore) { bestScore = score; best = at(x, y); }
  }
  if (best < 0) {                                                        // sala muy estrecha: la loseta alcanzable más lejana
    for (let i = 0; i < dist.length; i++) if (dist[i]! > 0 && (best < 0 || dist[i]! > dist[best]!)) best = i;
  }
  const px = (c: number) => ({ x: (c % cols) * TILE + TILE / 2, y: ((c / cols) | 0) * TILE + TILE / 2 });
  return {
    layout, floor, entry,
    spawn: { ...layout.spawn },
    exit: { slot, ...px(at(ex, ey)) },
    shop: px(best),
  };
}
