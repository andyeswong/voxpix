// OBJETOS del mundo (NARUTO, pedido de Andrés): muebles, columnas y lo que el juego quiera que se pueda mover o
// romper. Un objeto DORMIDO son vóxeles normales de StaticVoxels (se hornean, hacen sombra y chocan como el resto del
// mundo); lo que añade esta capa es saber de quién es cada vóxel, cuánto pesa y cuánta vida le queda.
//
// Moverlo: al empujarlo DESPIERTA (sus vóxeles salen del mundo a una entidad, que se dibuja como sprite y choca con
// los cuerpos por groundAt) y, quieto SLEEP_AFTER segundos, se DUERME (vuelve al mundo en su sitio nuevo, redondeado
// a vóxel entero). Así solo pagan sprite los que se mueven.
//
// El peso no se pone a mano: es la suma de sus vóxeles, cada uno con la densidad de su material (materials.ts).
import { decode, rampMaterial, VOXEL_M, VOXEL_M3, type Palette } from '../core';
import { Model } from '../core/model';
import type { WorldState, LightId, EntityId } from './state';
import type { VoxelFall, CrumbleOptions } from './fall';

// Un objeto tal como sale de buildWorld (o lo describe el juego): sus vóxeles relativos a la esquina (x, y, z) y lo
// que había en el mundo debajo de cada uno antes de ponerlo (si el mueble pisa el suelo, el suelo de esa celda)
export interface ObjectSpec {
  kind: string;                                  // 'prop', 'pillar' o lo que diga el juego
  name?: string;                                 // la pieza del mapa (en un mueble del layout, su anim)
  x: number; y: number; z: number;               // esquina: el mínimo de sus vóxeles en cada eje
  cells: Int32Array;                             // lx, ly, lz, material por vóxel
  under: Uint16Array;                            // lo que había en el mundo en cada uno (0 = vacío)
  lights?: readonly LightId[];                   // las luces que puso su constructor (una lámpara): van con él
  hp?: number;                                   // vida; por defecto, sus vóxeles
}

export interface WorldObject extends ObjectSpec {
  readonly id: number;
  mass: number;                                  // kg (baja si pierde vóxeles: chip)
  hp: number;
  maxHp: number;
  lights: readonly LightId[];
  // Despierto: es una entidad; (px, py) es su esquina con decimales y (x, y) la de cuando se durmió
  awake: boolean;
  px: number; py: number;
  still: number;                                 // segundos quieto (despierto)
  entity: EntityId | null;
  base: number;                                  // despierto: el suelo más alto bajo él al despertar (no sube a más)
  modelId: number | null;                        // su modelo de entidad, una vez hecho (se reutiliza)
}

// Rozamiento y gravedad del empuje: se mueve si la fuerza pasa de MU·m·g
export const MU = 0.5;
export const GRAVITY_MS2 = 9.81;
// Lo que dura el empujón: la velocidad es (F − MU·m·g) / m · PUSH_T (más despacio cuanto más pesa)
export const PUSH_T = 0.1;
export const SLEEP_AFTER = 1.5;                  // segundos quieto hasta dormirse
// Lo que cabe en un sprite de entidad (frame2d.ts: 48x72 con los pies en 24,60), con la inclinación de 0,5
const SPRITE_HALF_W = 24, SPRITE_DOWN = 12, SPRITE_UP = 60, MAX_INCLINE = 0.5;

export interface PushOptions {
  maxSpeed?: number;                             // vóxeles/s: lo más rápido que va (el paso de quien empuja); 40
  mu?: number;                                   // otro rozamiento (hielo, alfombra); MU
}
export interface PushResult {
  moved: number;                                 // vóxeles que avanzó
  heavy: boolean;                                // no llegó a la fuerza que hace falta: es pared
  blocked: boolean;                              // algo lo paró (pared, otro objeto) o no cabe en un sprite
  need: number;                                  // la fuerza que hace falta (N)
}

// La masa de unos vóxeles (lx, ly, lz, material...) con la paleta del mundo
export function massOf(cells: Int32Array, palette: Palette): number {
  const dens = palette.ramps.map((r) => rampMaterial(r).density * VOXEL_M3);
  let m = 0;
  for (let i = 3; i < cells.length; i += 4) m += dens[decode(cells[i]!).ramp] ?? 0;
  return m;
}

// Lo que pinta `draw` en el mundo, como objeto: oye los cambios de vóxeles mientras dura. null si no pintó nada.
// Lo borrado (un hueco que talla) no es del objeto.
export function captureObject(solid: WorldState['solid'], kind: string, draw: () => void, name?: string): ObjectSpec | null {
  const log = new Map<number, { x: number; y: number; z: number; old: number; v: number }>();
  const W = solid.width, D = solid.depth;
  const prev = solid.onSet;
  solid.onSet = (x, y, z, old, v) => {
    const k = ((z - solid.zMin) * D + y) * W + x;
    const e = log.get(k);
    if (e) e.v = v; else log.set(k, { x, y, z, old, v });
  };
  try { draw(); } finally { solid.onSet = prev; }
  const set = [...log.values()].filter((e) => e.v !== 0);
  if (!set.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  for (const e of set) { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); z0 = Math.min(z0, e.z); }
  const cells = new Int32Array(set.length * 4), under = new Uint16Array(set.length);
  set.forEach((e, i) => { cells.set([e.x - x0, e.y - y0, e.z - z0, e.v], i * 4); under[i] = e.old; });
  return { kind, ...(name !== undefined ? { name } : {}), x: x0, y: y0, z: z0, cells, under };
}

type ObjectFields = Omit<WorldObject, 'lights'> & { lights: LightId[] };
export interface ObjectsState {
  next: number;
  list: ObjectFields[];
}

// Lo que se calcula de los vóxeles de un objeto (no se guarda: sale de cells)
interface Shape {
  w: number; d: number; h: number;               // extensión
  foot: Int32Array;                              // lx, ly de cada columna
  top: Map<number, number>;                      // columna (colKey) -> lz más alta + 1
}
const colKey = (lx: number, ly: number) => ly * 4096 + lx;

// Los objetos de un mundo y de quién es cada vóxel
export class ObjectLayer implements Iterable<WorldObject> {
  private byId = new Map<number, WorldObject>();
  private owner = new Map<number, number>();     // vóxel (clave del mundo) -> id
  private shapes = new Map<number, Shape>();
  private awakeList: WorldObject[] = [];
  next = 1;

  constructor(private readonly w: WorldState) {}

  get size(): number { return this.byId.size; }
  // ¿Hubo alguna vez objetos? (si no, la huella del mundo es la de siempre)
  get used(): boolean { return this.next > 1; }
  get awake(): readonly WorldObject[] { return this.awakeList; }
  [Symbol.iterator](): Iterator<WorldObject> { return [...this.byId.values()].sort((a, b) => a.id - b.id)[Symbol.iterator](); }

  get(id: number): WorldObject | undefined { return this.byId.get(id); }

  // Registra un objeto cuyos vóxeles ya están en el mundo (los de buildWorld). Devuelve su id
  add(spec: ObjectSpec, palette: Palette = this.w.solid.palette): number {
    const id = this.next++;
    const n = spec.cells.length / 4;
    const o: WorldObject = {
      ...spec, id, mass: massOf(spec.cells, palette), hp: spec.hp ?? n, maxHp: spec.hp ?? n, lights: [...(spec.lights ?? [])],
      awake: false, px: spec.x, py: spec.y, still: 0, entity: null, base: 0, modelId: null,
    };
    this.byId.set(id, o);
    this.claim(o);
    return id;
  }

  // Lo olvida (sus vóxeles se quedan en el mundo como vóxeles sin dueño; despierto, se duerme antes)
  remove(id: number): void {
    const o = this.byId.get(id);
    if (!o) return;
    if (o.awake) this.sleep(id);
    this.release(o);
    this.byId.delete(id);
    this.shapes.delete(id);
  }

  // El objeto que tiene el vóxel (x, y, z), o undefined (solo los dormidos: los despiertos no están en el mundo)
  at(x: number, y: number, z: number): WorldObject | undefined {
    const id = this.owner.get(this.key(x, y, z));
    return id === undefined ? undefined : this.byId.get(id);
  }

  // Los objetos con algún vóxel en la columna (x, y): los dormidos por sus vóxeles y los despiertos por su huella
  inColumn(x: number, y: number): WorldObject[] {
    const out = new Set<WorldObject>();
    const s = this.w.solid;
    for (let z = s.zMin; z <= s.zMax; z++) { const o = this.at(x, y, z); if (o) out.add(o); }
    for (const o of this.awakeList) if (this.topAt(o, x, y) !== null) out.add(o);
    return [...out];
  }

  // La masa y la fuerza (N) que hace falta para moverlo
  forceToMove(id: number, mu = MU): number {
    const o = this.byId.get(id);
    return o ? mu * o.mass * GRAVITY_MS2 : Infinity;
  }

  // ¿Cabe en un sprite de entidad? Los que no, no se despiertan (no se pueden mover)
  fitsSprite(id: number): boolean {
    const o = this.byId.get(id);
    if (!o) return false;
    const s = this.shape(o), cx = Math.floor(s.w / 2), cy = Math.floor(s.d / 2);
    return cx <= SPRITE_HALF_W && s.w - 1 - cx < SPRITE_HALF_W && cy * MAX_INCLINE <= SPRITE_DOWN && (s.d - 1 - cy) * MAX_INCLINE + s.h <= SPRITE_UP;
  }

  // Despierta: sus vóxeles salen del mundo (vuelve lo que había debajo) y pasa a ser una entidad. Sus luces pasan a
  // dinámicas (para moverse con él). false si no puede (no existe, ya despierto o no cabe en un sprite)
  wake(id: number): boolean {
    const o = this.byId.get(id);
    if (!o || o.awake || !this.fitsSprite(id)) return false;
    const w = this.w, s = w.solid, sh = this.shape(o);
    this.release(o);
    for (let i = 0; i < o.cells.length; i += 4) {
      const x = o.x + o.cells[i]!, y = o.y + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
      if (s.get(x, y, z) === o.cells[i + 3]) s.set(x, y, z, o.under[i >> 2]!);
    }
    let base = -Infinity;
    for (let i = 0; i < sh.foot.length; i += 2) base = Math.max(base, s.walkAt(o.x + sh.foot[i]!, o.y + sh.foot[i + 1]!));
    o.base = base;
    if (o.modelId === null) o.modelId = w.models.register(this.model(o));
    const [cx, cy] = this.center(o);
    o.entity = w.entities.add({ model: o.modelId, x: o.x + cx, y: o.y + cy, z: o.z });
    o.awake = true; o.px = o.x; o.py = o.y; o.still = 0;
    for (const lid of o.lights) { const l = w.lights.get(lid); if (l) l.baked = false; }
    this.awakeList.push(o);
    this.awakeList.sort((a, b) => a.id - b.id);
    return true;
  }

  // Duerme: vuelve al mundo en su sitio (redondeado), con lo que haya allí como lo de debajo. La entidad se queda
  // dibujada (fantasma, fuera de la partida) hasta dropGhosts: el rehorneado tarda unos cuadros
  sleep(id: number): void {
    const o = this.byId.get(id);
    if (!o || !o.awake) return;
    const w = this.w, s = w.solid;
    const X = Math.round(o.px), Y = Math.round(o.py);
    this.moveLights(o, X - o.px, Y - o.py);
    o.x = X; o.y = Y; o.px = X; o.py = Y;
    for (let i = 0; i < o.cells.length; i += 4) {
      const x = X + o.cells[i]!, y = Y + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
      if (x < 0 || y < 0 || x >= s.width || y >= s.depth || z < s.zMin || z > s.zMax) { o.under[i >> 2] = 0; continue; }
      o.under[i >> 2] = s.get(x, y, z);
      s.set(x, y, z, o.cells[i + 3]!);
    }
    this.claim(o);
    for (const lid of o.lights) { const l = w.lights.get(lid); if (l) l.baked = true; }
    if (o.entity !== null) {
      const e = w.entities.get(o.entity);
      if (e) { const [cx, cy] = this.center(o); e.x = X + cx; e.y = Y + cy; e.ghost = s.clock; }
    }
    o.awake = false; o.entity = null; o.still = 0;
    this.awakeList = this.awakeList.filter((a) => a !== o);
  }

  // Quita los fantasmas de los objetos dormidos cuyo rehorneado ya se ve: `version` es la versión del mundo publicada
  // (la de Baked.version cuando la cola de la vista está vacía). No toca la partida (ni la huella ni el reloj)
  dropGhosts(version: number): number {
    const ents = this.w.entities;
    let n = 0;
    for (let i = ents.length - 1; i >= 0; i--) {
      const g = ents[i]!.ghost;
      if (g !== undefined && g <= version) { ents.splice(i, 1); n++; }
    }
    if (n) ents.reindex();
    return n;
  }

  // Empuja: con fuerza (N) en la dirección (dx, dy) durante dt. Si no llega a MU·m·g, no se mueve (heavy). Si
  // llega, lo despierta y avanza (más despacio cuanto más pesa), chocando con lo fijo y con otros despiertos.
  push(id: number, dx: number, dy: number, force: number, dt: number, opts: PushOptions = {}): PushResult {
    const o = this.byId.get(id);
    const need = this.forceToMove(id, opts.mu);
    const none = { moved: 0, heavy: false, blocked: true, need };
    const len = Math.hypot(dx, dy);
    if (!o || !(len > 0) || !(dt > 0)) return none;
    if (!(force > need)) return { moved: 0, heavy: true, blocked: false, need };
    if (!o.awake && !this.wake(id)) return none;
    const v = Math.min(opts.maxSpeed ?? 40, ((force - need) / o.mass) * PUSH_T / VOXEL_M);
    const dist = v * dt, ux = dx / len * dist, uy = dy / len * dist;
    const n = Math.max(1, Math.ceil(dist / 0.5));
    const x0 = o.px, y0 = o.py;
    let moved = 0, blocked = false;
    for (let k = 0; k < n; k++) {
      let any = false;
      for (const axis of ['x', 'y'] as const) {
        const d = (axis === 'x' ? ux : uy) / n;
        if (d === 0) continue;
        const nx = axis === 'x' ? o.px + d : o.px, ny = axis === 'y' ? o.py + d : o.py;
        if (this.canBeAt(o, nx, ny)) { o.px = nx; o.py = ny; moved += Math.abs(d); any = true; } else blocked = true;
      }
      if (!any) break;
    }
    o.still = 0;
    const [cx, cy] = this.center(o);
    this.w.entities.move(o.entity!, o.px + cx, o.py + cy, o.z);
    this.moveLights(o, o.px - x0, o.py - y0);
    return { moved, heavy: false, blocked, need };
  }

  // Daño: le quita vida y, si llega a 0, lo rompe. Con `fall`, se desmorona en piezas (VoxelFall.crumble: escombro o
  // nada, lo que diga opts.settle) que el juego avanza con fall.step; sin ella, desaparece de golpe. Lo que había debajo
  // (el suelo que pisaba) vuelve, sus luces se apagan y deja de ser objeto. Despierto, se duerme antes en su sitio.
  damage(id: number, amount: number, fall?: VoxelFall, opts: CrumbleOptions = {}): { hp: number; destroyed: boolean; pieces: number } {
    const o = this.byId.get(id);
    if (!o) return { hp: 0, destroyed: false, pieces: 0 };
    o.hp = Math.max(0, o.hp - Math.max(0, amount));
    if (o.hp > 0) return { hp: o.hp, destroyed: false, pieces: 0 };
    return { hp: 0, destroyed: true, pieces: this.destroy(id, fall, opts) };
  }

  // Lo rompe ya (lo que hace damage al llegar a 0). Devuelve las piezas que suelta
  destroy(id: number, fall?: VoxelFall, opts: CrumbleOptions = {}): number {
    const o = this.byId.get(id);
    if (!o) return 0;
    if (o.awake) this.sleep(id);
    this.dropGhostOf(o);
    const w = this.w, s = w.solid;
    let pieces = 0;
    if (fall) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < o.cells.length; i += 4) {
        const x = o.x + o.cells[i]!, y = o.y + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
      }
      pieces = fall.crumble({ x0, y0, z0, x1, y1, z1 }, { ...opts, only: (x, y, z) => this.owner.get(this.key(x, y, z)) === o.id && (!opts.only || opts.only(x, y, z)) });
    }
    // Lo suyo que quede en el mundo se va, y vuelve lo de debajo (crumble lo deja vacío)
    for (let i = 0; i < o.cells.length; i += 4) {
      const x = o.x + o.cells[i]!, y = o.y + o.cells[i + 1]!, z = o.z + o.cells[i + 2]!;
      if (this.owner.get(this.key(x, y, z)) !== o.id) continue;
      const v = s.get(x, y, z);
      if (v === o.cells[i + 3] || v === 0) s.set(x, y, z, o.under[i >> 2]!);
    }
    for (const lid of o.lights) w.lights.remove(lid);
    this.release(o);
    this.byId.delete(id);
    this.shapes.delete(id);
    return pieces;
  }

  // Le arranca los vóxeles a menos de `r` de (x, y, z) (un golpe que muerde): vuelve lo de debajo y baja su masa.
  // Despierto, se duerme antes. Devuelve cuántos perdió; si no le queda ninguno, deja de ser objeto
  chip(id: number, x: number, y: number, z: number, r: number): number {
    const o = this.byId.get(id);
    if (!o) return 0;
    if (o.awake) this.sleep(id);
    this.dropGhostOf(o);
    const s = this.w.solid;
    const keep: number[] = [], keepUnder: number[] = [];
    let lost = 0;
    for (let i = 0; i < o.cells.length; i += 4) {
      const cx = o.x + o.cells[i]!, cy = o.y + o.cells[i + 1]!, cz = o.z + o.cells[i + 2]!;
      if ((cx + 0.5 - x) ** 2 + (cy + 0.5 - y) ** 2 + (cz + 0.5 - z) ** 2 < r * r) {
        if (s.get(cx, cy, cz) === o.cells[i + 3]) s.set(cx, cy, cz, o.under[i >> 2]!);
        const k = this.key(cx, cy, cz);
        if (this.owner.get(k) === o.id) this.owner.delete(k);
        lost++;
      } else { keep.push(o.cells[i]!, o.cells[i + 1]!, o.cells[i + 2]!, o.cells[i + 3]!); keepUnder.push(o.under[i >> 2]!); }
    }
    if (!lost) return 0;
    if (!keepUnder.length) { this.destroy(id); return lost; }
    o.cells = Int32Array.from(keep); o.under = Uint16Array.from(keepUnder);
    o.mass = massOf(o.cells, this.w.solid.palette);
    o.modelId = null;                              // el modelo de entidad se rehace al despertar
    this.shapes.delete(id);
    return lost;
  }

  // Un tick: los despiertos que llevan SLEEP_AFTER quietos se duermen
  step(dt: number): void {
    for (const o of [...this.awakeList]) {
      o.still += dt;
      if (o.still >= SLEEP_AFTER) this.sleep(o.id);
    }
  }

  // La altura de la cara de arriba de los despiertos en la columna (x, y), o -Infinity: para groundAt
  groundAt(x: number, y: number): number {
    let g = -Infinity;
    for (const o of this.awakeList) { const t = this.topAt(o, x, y); if (t !== null) g = Math.max(g, t); }
    return g;
  }

  exportState(): ObjectsState {
    return { next: this.next, list: [...this].map((o) => ({ ...o, cells: o.cells.slice(), under: o.under.slice(), lights: [...o.lights] })) };
  }

  importState(s: ObjectsState): void {
    this.byId.clear(); this.owner.clear(); this.shapes.clear();
    for (const so of s.list) {
      const o: WorldObject = { ...so, cells: so.cells.slice(), under: so.under.slice(), lights: [...so.lights] };
      this.byId.set(o.id, o);
      if (!o.awake) this.claim(o);
    }
    this.awakeList = [...this.byId.values()].filter((o) => o.awake).sort((a, b) => a.id - b.id);
    this.next = s.next;
  }

  // ---- por dentro

  // El fantasma que dejó al dormirse (si sigue): al romperlo o morderlo ya no vale
  private dropGhostOf(o: WorldObject): void {
    const ents = this.w.entities;
    for (let i = ents.length - 1; i >= 0; i--) {
      const e = ents[i]!;
      if (e.ghost !== undefined && e.modelId === o.modelId) ents.splice(i, 1);
    }
    ents.reindex();
  }

  private key(x: number, y: number, z: number): number { return ((z - this.w.solid.zMin) * this.w.solid.depth + y) * this.w.solid.width + x; }
  private claim(o: WorldObject): void { for (let i = 0; i < o.cells.length; i += 4) this.owner.set(this.key(o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!), o.id); }
  private release(o: WorldObject): void {
    for (let i = 0; i < o.cells.length; i += 4) {
      const k = this.key(o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!);
      if (this.owner.get(k) === o.id) this.owner.delete(k);
    }
  }

  private shape(o: WorldObject): Shape {
    let s = this.shapes.get(o.id);
    if (s) return s;
    let w = 0, d = 0, h = 0;
    const top = new Map<number, number>();
    for (let i = 0; i < o.cells.length; i += 4) {
      const lx = o.cells[i]!, ly = o.cells[i + 1]!, lz = o.cells[i + 2]!;
      w = Math.max(w, lx + 1); d = Math.max(d, ly + 1); h = Math.max(h, lz + 1);
      const k = colKey(lx, ly);
      top.set(k, Math.max(top.get(k) ?? 0, lz + 1));
    }
    const foot = new Int32Array(top.size * 2);
    let j = 0;
    for (const k of top.keys()) { foot[j++] = k % 4096; foot[j++] = Math.floor(k / 4096); }
    s = { w, d, h, foot, top };
    this.shapes.set(o.id, s);
    return s;
  }

  // El centro de la base (donde va la entidad): el modelo va relativo a él, para caber en el sprite
  private center(o: WorldObject): [number, number] {
    const s = this.shape(o);
    return [Math.floor(s.w / 2), Math.floor(s.d / 2)];
  }

  private model(o: WorldObject): Model {
    const m = new Model(this.w.models.worldPalette(), `objeto-${o.id}`);
    const [cx, cy] = this.center(o);
    for (let i = 0; i < o.cells.length; i += 4) m.set(o.cells[i]! - cx, o.cells[i + 1]! - cy, o.cells[i + 2]!, o.cells[i + 3]!);
    return m;
  }

  // La cara de arriba de un despierto en la columna (x, y), o null si no la pisa
  private topAt(o: WorldObject, x: number, y: number): number | null {
    const sh = this.shape(o), lx = x - Math.round(o.px), ly = y - Math.round(o.py);
    if (lx < 0 || ly < 0 || lx >= sh.w || ly >= sh.d) return null;
    const t = sh.top.get(colKey(lx, ly));
    return t === undefined ? null : o.z + t;
  }

  // ¿Puede estar (despierto) con la esquina en (nx, ny)? Dentro del mundo, sin suelo más alto que su base debajo y sin
  // pisar a otro despierto
  private canBeAt(o: WorldObject, nx: number, ny: number): boolean {
    const s = this.w.solid, sh = this.shape(o);
    const X = Math.round(nx), Y = Math.round(ny);
    for (let i = 0; i < sh.foot.length; i += 2) {
      const x = X + sh.foot[i]!, y = Y + sh.foot[i + 1]!;
      if (x < 0 || y < 0 || x >= s.width || y >= s.depth) return false;
      if (s.walkAt(x, y) > o.base || !s.climbableAt(x, y)) return false;
      for (const a of this.awakeList) if (a !== o && this.topAt(a, x, y) !== null) return false;
    }
    return true;
  }

  private moveLights(o: WorldObject, dx: number, dy: number): void {
    if (!dx && !dy) return;
    for (const lid of o.lights) { const l = this.w.lights.get(lid); if (l) { l.x += dx; l.y += dy; } }
  }
}
