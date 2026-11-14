// EDITAR EL MUNDO EN PARTIDA (NARUTO): poner un modelo de vóxeles en el escenario y vaciar una caja. Escriben por
// StaticVoxels.set, así que watchChanges da sus cajas 'voxels' de siempre y rebakeChangedJobs rehace solo lo que
// cambió (docs/motor.md, "Editar el mundo en partida").
import { decode, material, type Palette, type Ramp, type VoxelSource } from '../core';
import type { Box3 } from './changes';
import type { WorldState } from './state';

export type Yaw = 0 | 90 | 180 | 270;

// Las rampas de un modelo en la paleta del mundo: la misma rampa (mismo nombre y mismos colores) en cualquier sitio de
// la paleta. Se guarda por paleta del modelo y del mundo
const rampMaps = new WeakMap<Palette, { world: Palette; map: Int16Array }>();
const sameRamp = (a: Ramp, b: Ramp) => a === b || (a.name === b.name && a.colors.length === b.colors.length && a.colors.every((c, i) => c.toLowerCase() === b.colors[i]!.toLowerCase()));
export function rampMap(model: Palette, world: Palette): Int16Array {
  const hit = rampMaps.get(model);
  if (hit && hit.world === world) return hit.map;
  const map = new Int16Array(model.ramps.length);
  model.ramps.forEach((r, i) => {
    const j = world.ramps.findIndex((w) => sameRamp(r, w));
    if (j < 0) throw new Error(`la rampa "${r.name}" del modelo no está en la paleta del mundo: hay que ponerla al construirlo (las del mundo son: ${world.ramps.map((w) => w.name).join(', ')})`);
    map[i] = j;
  });
  rampMaps.set(model, { world, map });
  return map;
}

// Una celda del modelo girada en cuartos de vuelta alrededor de su origen (el eje z): 90 lleva lo que miraba al sur
// (-y) a mirar al este (+x). Se gira la celda entera (su centro), así que el resultado ocupa celdas enteras
export function turnCell(x: number, y: number, yaw: Yaw): [number, number] {
  switch (yaw) {
    case 90: return [-y - 1, x];
    case 180: return [-x - 1, -y - 1];
    case 270: return [y, -x - 1];
    default: return [x, y];
  }
}

const grow = (b: Box3 | null, x: number, y: number, z: number): Box3 => {
  if (!b) return { x0: x, y0: y, z0: z, x1: x, y1: y, z1: z };
  if (x < b.x0) b.x0 = x; if (y < b.y0) b.y0 = y; if (z < b.z0) b.z0 = z;
  if (x > b.x1) b.x1 = x; if (y > b.y1) b.y1 = y; if (z > b.z1) b.z1 = z;
  return b;
};

// Pone los vóxeles llenos del modelo con su origen en (x, y, z) del mundo, girado `yaw`. Lo vacío del modelo no toca
// nada (para sustituir lo que hubiera, clearBox antes). Las rampas del modelo tienen que estar en la paleta del mundo
// (rampMap). Lo que cae fuera del mundo se ignora. Devuelve la caja de los vóxeles que cambiaron de verdad, o null
export function stampModel(state: WorldState, model: VoxelSource, x: number, y: number, z: number, yaw: Yaw = 0): Box3 | null {
  const s = state.solid, map = rampMap(model.palette, s.palette);
  let box: Box3 | null = null;
  for (const [mx, my, mz, v] of model.entries()) {
    const [rx, ry] = turnCell(mx, my, yaw);
    const wx = x + rx, wy = y + ry, wz = z + mz;
    if (wx < 0 || wy < 0 || wx >= s.width || wy >= s.depth || wz < s.zMin || wz > s.zMax) continue;
    const { ramp, tone } = decode(v);
    const w = material(map[ramp]!, tone);
    if (s.get(wx, wy, wz) === w) continue;
    s.set(wx, wy, wz, w);
    box = grow(box, wx, wy, wz);
  }
  return box;
}

// Vacía los vóxeles de la caja (extremos incluidos; lo que cae fuera del mundo se ignora). Devuelve la caja de los
// que cambiaron de verdad (los que estaban llenos), o null
export function clearBox(state: WorldState, b: Box3): Box3 | null {
  const s = state.solid;
  let box: Box3 | null = null;
  const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0), z0 = Math.max(s.zMin, b.z0);
  const x1 = Math.min(s.width - 1, b.x1), y1 = Math.min(s.depth - 1, b.y1), z1 = Math.min(s.zMax, b.z1);
  for (let wz = z1; wz >= z0; wz--) for (let wy = y0; wy <= y1; wy++) for (let wx = x0; wx <= x1; wx++) {
    if (!s.get(wx, wy, wz)) continue;
    s.set(wx, wy, wz, 0);
    box = grow(box, wx, wy, wz);
  }
  return box;
}
