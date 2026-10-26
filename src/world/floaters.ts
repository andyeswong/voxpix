// LO QUE FLOTA (NARUTO, pedido de Andrés): nenúfares, hojas, maderas... Cada flotante es una entidad del mundo (así
// se pinta igual en la CPU, en la GPU, con luz y en los 4 giros) que mueve el agua: sube y baja con la superficie, la
// arrastra la corriente y la apartan las ondas (un pisotón, alguien que cruza), se frena sola y no sale del agua.
//
// Reglas, para que no cambie la partida (acordado con FERN):
//   - no bloquean nada: ni la colisión, ni los disparos, ni dan sombra de verdad;
//   - no gastan el azar del mundo: solo los mueve la simulación del agua, que es determinista;
//   - sus entidades tienen ids propios ('flota-1', 'flota-2'...), fuera de la secuencia numérica del juego.
// Su estado entra en la instantánea y en la huella del mundo.
import type { VoxelSource } from '../core';
import type { WaterLayer } from './water';
import type { EntityId, WorldState } from './state';

export interface Floater {
  id: EntityId;          // el de su entidad
  x: number; y: number;  // posición continua (la entidad va redondeada)
  vx: number; vy: number;
  yaw: number;           // giro continuo (la entidad va en octavos de vuelta: los sprites guardados)
}

const PUSH = 12;         // balanceo: aceleración por unidad de pendiente de la superficie
const KICK = 9;          // empujón de un pisotón (events.disturb): vóxeles/s por unidad de fuerza, a radio de distancia
const KICK_REACH = 5;    // hasta cuántos radios del pisotón llega el empujón
const CARRY = 1.6;       // cuánto lo arrastra la corriente (por segundo)
const DRAG = 1.8;        // freno del agua (por segundo)
const MAX_SPEED = 16;    // vóxeles por segundo
const SHORE = 0.3;       // no entra donde el agua cubre menos
export const FLOAT_MIN_DEPTH = SHORE;
const TURN = 9;          // grados por segundo por vóxel/s de velocidad

export class Floaters {
  readonly list: Floater[] = [];
  next = 1;
  constructor(private readonly world: WorldState) {}

  // Un flotante con ese modelo en (x, y), sobre el agua que haya ahí. yaw: el giro de partida (sin azar: quien llama lo
  // saca, p. ej., de un hash de la celda)
  add(model: VoxelSource | number, x: number, y: number, yaw = 0): EntityId {
    const id = `flota-${this.next++}`;
    const z = this.world.water?.surfaceAt(x, y) ?? this.world.groundAt(x, y);
    this.world.entities.add({ id, model, x: Math.round(x), y: Math.round(y), z: quarter(z), facing: octant(yaw), castsShadow: false });
    this.list.push({ id, x, y, vx: 0, vy: 0, yaw });
    return id;
  }

  remove(id: EntityId): void {
    const i = this.list.findIndex((f) => f.id === id);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.world.entities.remove(id);
  }

  // Un pisotón (o algo que agita el agua) en (x, y): aparta lo que flota cerca, hacia fuera
  push(x: number, y: number, force: number, radius: number): void {
    const reach = radius * KICK_REACH;
    for (const f of this.list) {
      const dx = f.x - x, dy = f.y - y, d = Math.hypot(dx, dy);
      if (d >= reach) continue;
      const k = KICK * force * (1 - d / reach) / Math.max(d, 0.5);
      f.vx += dx * k; f.vy += dy * k;
    }
  }

  step(dt: number, water: WaterLayer | null): void {
    if (!water) return;
    const ents = this.world.entities;
    for (const f of this.list) {
      if (water.depthAt(f.x, f.y) < 0.05) { f.vx = f.vy = 0; continue; }           // varado: se queda
      const [sx, sy] = water.slopeAt(f.x, f.y), [ux, uy] = water.flowAt(f.x, f.y);
      f.vx += (-sx * PUSH + (ux - f.vx) * CARRY) * dt;
      f.vy += (-sy * PUSH + (uy - f.vy) * CARRY) * dt;
      const k = 1 / (1 + DRAG * dt);
      f.vx *= k; f.vy *= k;
      const sp = Math.hypot(f.vx, f.vy);
      if (sp > MAX_SPEED) { f.vx *= MAX_SPEED / sp; f.vy *= MAX_SPEED / sp; }
      const nx = f.x + f.vx * dt, ny = f.y + f.vy * dt;
      if (water.depthAt(nx, ny) < SHORE) { f.vx *= -0.3; f.vy *= -0.3; }            // la orilla lo devuelve
      else { f.x = nx; f.y = ny; }
      f.yaw = (((f.yaw + (f.vx - f.vy) * TURN * dt) % 360) + 360) % 360;
      // La entidad solo se mueve si cambia lo que se ve (posición redondeada, altura a cuartos, octavo de vuelta)
      const e = ents.get(f.id);
      if (!e) continue;
      const ix = Math.round(f.x), iy = Math.round(f.y), iz = quarter(water.surfaceAt(f.x, f.y)), iyaw = octant(f.yaw);
      if (ix !== e.x || iy !== e.y || iz !== e.z || iyaw !== e.yaw) ents.move(f.id, ix, iy, iz, iyaw);
    }
  }

  exportState(): { list: Floater[]; next: number } { return { list: this.list.map((f) => ({ ...f })), next: this.next }; }
  importState(s: { list: Floater[]; next: number }): void {
    this.list.length = 0;
    this.list.push(...s.list.map((f) => ({ ...f })));
    this.next = s.next;
  }
}

const quarter = (z: number) => Math.round(z * 4) / 4;
const octant = (yaw: number) => ((Math.round(yaw / 45) * 45) % 360 + 360) % 360;
