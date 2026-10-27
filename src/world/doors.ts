// Abrir una puerta con la partida en marcha: el hueco de la sala (worldgen, spec.doors) se abre en el layout y en el
// mundo. Lo que sobra de la pared se desmorona hacia fuera en piezas (world/fall.ts) y lo nuevo (el suelo del hueco)
// se pone directamente. Devuelve la caída, para avanzarla por ticks o acabarla de golpe, y las columnas tocadas.
import { openDoors, NORTH, TILE, type Layout, type Side } from '../worldgen';
import { buildWorld, type World, type WorldLook } from './build';
import { VoxelFall, type CrumbleOptions, type FallRect } from './fall';
import type { WorldState } from './state';

export interface OpenDoorOptions {
  decorate?: (world: World) => void;            // el mismo decorate con el que se montó el mundo
  crumble?: CrumbleOptions;                     // por defecto, piezas de 4 empujadas hacia fuera, que desaparecen
  fall?: VoxelFall;                             // para sumar la caída a una que ya esté en marcha
}

const OUT: Record<Side, [number, number]> = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] };   // hacia fuera, ejes del modelo

export function openDoorInWorld(state: WorldState, layout: Layout, side: Side, look?: WorldLook, o: OpenDoorOptions = {}): { fall: VoxelFall; touched: FallRect } {
  const d = layout.doors?.find((s) => s.side === side);
  if (!d) throw new Error(`la sala no tiene hueco de puerta al ${side}: generala con spec.doors`);
  const fall = o.fall ?? new VoxelFall(state);
  const W = layout.cols * TILE, D = layout.rows * TILE;
  // Las losetas del hueco (en filas del worldgen) y una más alrededor: el borde de la pared vecina también cambia
  let tx0: number, tx1: number, ty0: number, ty1: number;
  if (side === 'n') { tx0 = d.from; tx1 = d.to; ty0 = 0; ty1 = NORTH - 1; }
  else if (side === 's') { tx0 = d.from; tx1 = d.to; ty0 = ty1 = layout.rows - 1; }
  else { ty0 = d.from; ty1 = d.to; tx0 = tx1 = side === 'w' ? 0 : layout.cols - 1; }
  tx0 = Math.max(0, tx0 - 1); tx1 = Math.min(layout.cols - 1, tx1 + 1);
  ty0 = Math.max(0, ty0 - 1); ty1 = Math.min(layout.rows - 1, ty1 + 1);
  const x0 = tx0 * TILE, x1 = (tx1 + 1) * TILE - 1;
  const y0 = D - (ty1 + 1) * TILE, y1 = D - 1 - ty0 * TILE;            // filas hacia el sur -> y del modelo al norte
  if (d.open) return { fall, touched: { x0, y0, x1, y1 } };

  openDoors(layout, [side]);
  const next = buildWorld(layout, look);
  o.decorate?.(next);
  const s = state.solid, n = next.model;
  if (n.width !== W || n.depth !== D || s.width !== W || s.depth !== D) throw new Error('openDoorInWorld: el mundo no es el de este layout');

  // Lo que desaparece cae; lo que cambia o aparece se pone ya
  const gone = new Set<number>();
  const key = (x: number, y: number, z: number) => ((z - s.zMin) * D + y) * W + x;
  for (let z = s.zMin; z <= s.zMax; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const a = s.get(x, y, z), b = n.get(x, y, z);
    if (a === b) continue;
    if (a && !b) gone.add(key(x, y, z));
  }
  const [ox, oy] = OUT[side];
  const c = o.crumble ?? {};
  fall.crumble({ x0, y0, z0: s.zMin, x1, y1, z1: s.zMax }, {
    piece: 4, jitter: 25, settle: 'vanish', ...c,
    push: c.push ?? [ox * 70, oy * 70, 30],
    only: (x, y, z) => gone.has(key(x, y, z)) && (!c.only || c.only(x, y, z)),
  });
  for (let z = s.zMin; z <= s.zMax; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const b = n.get(x, y, z);
    if (b && s.get(x, y, z) !== b) s.set(x, y, z, b);
  }
  return { fall, touched: { x0, y0, x1, y1 } };
}
