// RUNTIME (FERN): el tick. Uno solo para todo, a 1/60 s fijos, en este orden: entrada -> mover cuerpos y
// resolver colisiones -> eventos sobre el mundo -> world.step(). Determinista: la misma semilla y la misma entrada por
// tick dan la misma partida, byte a byte (lo comprueba test/game/determinism.test.ts). Sin reloj ni Math.random:
// el azar, si hace falta, sale de world.random().
import { TICK, type EntityId, type ShadowMode, type WorldState } from '../world/state';
import type { SourceKind } from '../lighting/lights';
import type { VoxelSource } from '../core';
import { DEFAULT_RULES, moveBody, restZ, WADE, waterFactor, type Body, type MoveRules } from './body';
import { WALK_FRAME_MS } from '../anim/walk';

// Lo que llega de los mandos en un tick. dx, dy en ejes del modelo (dy > 0 = norte); se normaliza la dirección.
export interface TickInput {
  dx: number;
  dy: number;
  stomp: boolean;
}

export const NO_INPUT: TickInput = { dx: 0, dy: 0, stomp: false };

export interface PlayerConfig {
  radius: number;
  speed: number;        // vóxeles por segundo en seco
  model?: VoxelSource | number;   // su modelo (o su id en world.models): el runtime crea la entidad que lo dibuja
  walk?: ReadonlyArray<VoxelSource | number>;   // los cuadros del walk, en orden del ciclo (WALK_FRAME_MS cada uno); sin ellos anda con el quieto
  shadow?: ShadowMode;          // su sombra real: 'always' la reserva siempre (p. ej. el personaje), true compite por cercanía
  carry?: CarryConfig;          // la luz que lleva en la mano (solo de aspecto)
  rules?: MoveRules;
}

// La luz que lleva en la mano (linterna, antorcha): una entidad con su modelo, colocada junto al cuerpo y girada con
// él, y una luz del núcleo que la sigue (follow). Solo de aspecto: no toca el movimiento ni los choques.
export interface CarryConfig {
  model: VoxelSource | number;
  kind: SourceKind;
  cone?: number;                                  // foco: apertura en grados; sin él, luz puntual
  intensity?: number;                             // ajustes sobre el preset de kind
  radius?: number;
  color?: readonly [number, number, number];
  hand: readonly [number, number, number];        // el agarre, desde los pies, mirando al frente (y negativo)
  emit: readonly [number, number, number];        // de dónde sale la luz, desde el agarre
}

// Un vector del marco del cuerpo (mirando al frente) girado al facing de la entidad (grados): la misma cuenta que
// placeFollowers del núcleo, para que la mano y su luz coincidan
export function turn(v: readonly [number, number, number], yaw: number): [number, number, number] {
  const a = (yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

export type Player = Body & { facing: number; inWater: boolean; walked: number; moving: boolean };

export interface RuntimeSnapshot {
  tick: number;
  player: Player;
  world: ReturnType<WorldState['snapshot']>;
}

const RIPPLE_HZ = 12;                     // ondas al andar por el agua

export class Runtime {
  tick = 0;
  readonly player: Player;
  readonly entityId: EntityId | null;     // la entidad del mundo que lo dibuja, si tiene modelo
  readonly carryId: EntityId | null = null;   // la entidad de lo que lleva en la mano, si lleva algo
  readonly carryLightId: number | string | null = null;
  private readonly rules: MoveRules;
  private readonly idleModel: number | null = null;   // ids en world.models: se registran una vez, al crear la partida
  private readonly walkModels: number[] = [];

  constructor(readonly world: WorldState, spawn: { x: number; y: number }, readonly config: PlayerConfig) {
    this.rules = config.rules ?? DEFAULT_RULES;
    const r = config.radius;
    this.player = { x: spawn.x, y: spawn.y, z: restZ(world, spawn.x, spawn.y, r), r, facing: 0, inWater: false, walked: 0, moving: false };
    const p = this.player;
    const id = (m: VoxelSource | number) => (typeof m === 'number' ? m : world.models.register(m));
    if (config.model !== undefined) {
      this.idleModel = id(config.model);
      this.walkModels = (config.walk ?? []).map(id);
    }
    this.entityId = this.idleModel === null ? null
      : world.entities.add({ model: this.idleModel, x: Math.round(p.x), y: Math.round(p.y), z: p.z, facing: 0, castsShadow: config.shadow ?? true });
    const carry = config.carry;
    if (carry && this.entityId !== null) {
      this.carryId = world.entities.add({ model: id(carry.model), x: Math.round(p.x), y: Math.round(p.y), z: p.z, facing: 0, castsShadow: false });
      // La luz sigue al CUERPO (no al objeto) para que el núcleo lo tome por su dueño y su cuerpo no la tape; sale de
      // la mano más emit, los dos en el marco del cuerpo. Un foco apunta al frente y algo hacia el suelo.
      const offset = [carry.hand[0] + carry.emit[0], carry.hand[1] + carry.emit[1], carry.hand[2] + carry.emit[2]] as const;
      this.carryLightId = world.lights.add({
        kind: carry.kind, x: p.x, y: p.y, z: p.z, ...(carry.cone ? { cone: carry.cone } : {}),
        ...(carry.intensity ? { intensity: carry.intensity } : {}), ...(carry.radius ? { radius: carry.radius } : {}),
        ...(carry.color ? { color: carry.color } : {}),
        follow: { entity: this.entityId, offset, ...(carry.cone ? { dir: [0, -1, -0.3] as const } : {}) },
      });
    }
    this.syncEntity();
  }

  step(input: TickInput): void {
    const w = this.world, p = this.player;
    // 1. Mover y resolver colisiones
    const len = Math.hypot(input.dx, input.dy);
    p.moving = len > 0;
    if (len > 0) {
      const depth = w.waterAt(p.x, p.y)?.depth ?? 0;
      const v = this.config.speed * TICK * waterFactor(depth);
      moveBody(w, p, (input.dx / len) * v, (input.dy / len) * v, this.rules);
      p.facing = ((Math.round(Math.atan2(input.dx, -input.dy) / (Math.PI / 4)) % 8) + 8) % 8;   // sur 0, este 2, norte 4
      // 2. Eventos: ondas y salpicaduras al andar por el agua, a RIPPLE_HZ
      const before = Math.floor(p.walked * RIPPLE_HZ);
      p.walked += TICK;
      const wa = w.waterAt(p.x, p.y);
      if (wa && wa.depth > WADE && Math.floor(p.walked * RIPPLE_HZ) !== before) {
        w.events.disturb(p.x, p.y, 0.35);
        w.events.splash(p.x, p.y, wa.surface, 3, 38);
      }
    }
    const wa = w.waterAt(p.x, p.y);
    const inWater = (wa?.depth ?? 0) > WADE;
    if (wa && inWater && !p.inWater) { w.events.disturb(p.x, p.y, 0.7, 2); w.events.splash(p.x, p.y, wa.surface, 14, 70); }
    if (wa && inWater && input.stomp) { w.events.disturb(p.x, p.y, 2.8, 3); w.events.splash(p.x, p.y, wa.surface, 40, 105); }
    p.inWater = inWater;
    this.syncEntity();
    // 3. El mundo
    w.step();
    this.tick++;
  }

  // La entidad que lo dibuja va donde el cuerpo (público para colocarlo a mano fuera de un tick, p. ej. ?pos y ?dir)
  syncEntity(): void {
    if (this.entityId === null) return;
    const p = this.player;
    this.world.entities.move(this.entityId, Math.round(p.x), Math.round(p.y), p.z, p.facing * 45);
    this.world.entities.setModel(this.entityId, this.modelNow());
    if (this.carryId !== null && this.config.carry) {
      const h = turn(this.config.carry.hand, p.facing * 45);
      this.world.entities.move(this.carryId, Math.round(p.x + h[0]), Math.round(p.y + h[1]), p.z + h[2], p.facing * 45);
    }
  }

  // El modelo que toca: andando, el cuadro del walk por lo que lleva andado (determinista, entra en la huella);
  // parado, el quieto
  private modelNow(): number {
    const n = this.walkModels.length;
    if (!this.player.moving || !n) return this.idleModel!;
    return this.walkModels[Math.floor((this.player.walked * 1000) / WALK_FRAME_MS + 1e-9) % n]!;
  }

  snapshot(): RuntimeSnapshot {
    return { tick: this.tick, player: { ...this.player }, world: this.world.snapshot() };
  }

  restore(s: RuntimeSnapshot): void {
    this.tick = s.tick;
    Object.assign(this.player, s.player);
    this.world.restore(s.world);
  }

  // Huella de la partida: la del mundo más la del runtime (FNV-1a de 32 bits)
  hash(): string {
    const p = this.player;
    const view = new DataView(new ArrayBuffer(8 * 8));
    [this.tick, p.x, p.y, p.z, p.facing, p.inWater ? 1 : 0, p.walked, p.moving ? 1 : 0].forEach((v, i) => view.setFloat64(i * 8, v));
    let h = 0x811c9dc5;
    const feed = (u: Uint8Array) => { for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 0x01000193); };
    feed(new TextEncoder().encode(this.world.hash()));
    feed(new Uint8Array(view.buffer));
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}

// El bucle de la vista: convierte tiempo real en ticks fijos. La partida depende solo de la entrada de cada tick, no
// del ritmo de cuadros. Con un cuadro muy largo (pestaña en segundo plano) se hacen como mucho maxTicks y se suelta
// el resto: la partida se frena en vez de encadenar cuadros cada vez más lentos.
// Lo que mueve el bucle: este Runtime o cualquier simulación con step (p. ej. la partida de un juego)
export interface Steppable {
  readonly tick: number;
  step(input: TickInput): void;
}

export class FixedLoop {
  private acc = 0;

  constructor(private readonly runtime: Steppable, private readonly input: (tick: number) => TickInput, private readonly maxTicks = 5) {}

  // seconds: tiempo real desde el cuadro anterior. Devuelve cuántos ticks dio.
  advance(seconds: number): number {
    this.acc += seconds;
    let n = 0;
    while (this.acc >= TICK - 1e-9 && n < this.maxTicks) {
      this.runtime.step(this.input(this.runtime.tick));
      this.acc -= TICK;
      n++;
    }
    if (n === this.maxTicks && this.acc >= TICK) this.acc = 0;
    return n;
  }
}
