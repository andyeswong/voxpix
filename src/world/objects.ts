// OBJETOS del mundo (NARUTO, pedido de Andrés): muebles, columnas y lo que el juego quiera que se pueda mover o
// romper. Un objeto DORMIDO son vóxeles normales de StaticVoxels (se hornean, hacen sombra y chocan como el resto del
// mundo); lo que añade esta capa es saber de quién es cada vóxel, cuánto pesa y cuánta vida le queda. Despertarlo
// (sacarlo a una entidad para moverlo), empujarlo y romperlo van encima de esto.
//
// El peso no se pone a mano: es la suma de sus vóxeles, cada uno con la densidad de su material (materials.ts).
import { decode, rampMaterial, VOXEL_M3, type Palette } from '../core';
import type { StaticVoxels, LightId } from './state';

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
  readonly mass: number;                         // kg
  hp: number;
  maxHp: number;
  lights: readonly LightId[];
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
export function captureObject(solid: StaticVoxels, kind: string, draw: () => void, name?: string): ObjectSpec | null {
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

export interface ObjectsState {
  next: number;
  list: Array<{ id: number; kind: string; name?: string; x: number; y: number; z: number; cells: Int32Array; under: Uint16Array; mass: number; hp: number; maxHp: number; lights: LightId[] }>;
}

// Los objetos de un mundo y de quién es cada vóxel
export class ObjectLayer implements Iterable<WorldObject> {
  private byId = new Map<number, WorldObject>();
  private owner = new Map<number, number>();     // vóxel (clave del mundo) -> id
  next = 1;

  constructor(private readonly solid: StaticVoxels) {}

  get size(): number { return this.byId.size; }
  // ¿Hubo alguna vez objetos? (si no, la huella del mundo es la de siempre)
  get used(): boolean { return this.next > 1; }
  [Symbol.iterator](): Iterator<WorldObject> { return [...this.byId.values()].sort((a, b) => a.id - b.id)[Symbol.iterator](); }

  get(id: number): WorldObject | undefined { return this.byId.get(id); }

  // Registra un objeto cuyos vóxeles ya están en el mundo (los de buildWorld). Devuelve su id
  add(spec: ObjectSpec, palette: Palette = this.solid.palette): number {
    const id = this.next++;
    const n = spec.cells.length / 4;
    const o: WorldObject = {
      ...spec, id, mass: massOf(spec.cells, palette), hp: spec.hp ?? n, maxHp: spec.hp ?? n, lights: [...(spec.lights ?? [])],
    };
    this.byId.set(id, o);
    this.claim(o);
    return id;
  }

  // Lo olvida (sus vóxeles se quedan en el mundo como vóxeles sin dueño)
  remove(id: number): void {
    const o = this.byId.get(id);
    if (!o) return;
    this.release(o);
    this.byId.delete(id);
  }

  // El objeto que tiene el vóxel (x, y, z), o undefined
  at(x: number, y: number, z: number): WorldObject | undefined {
    const id = this.owner.get(this.key(x, y, z));
    return id === undefined ? undefined : this.byId.get(id);
  }

  // Los objetos con algún vóxel en la columna (x, y)
  inColumn(x: number, y: number): WorldObject[] {
    const out = new Set<WorldObject>();
    for (let z = this.solid.zMin; z <= this.solid.zMax; z++) { const o = this.at(x, y, z); if (o) out.add(o); }
    return [...out];
  }

  exportState(): ObjectsState {
    return {
      next: this.next,
      list: [...this].map((o) => ({ id: o.id, kind: o.kind, ...(o.name !== undefined ? { name: o.name } : {}), x: o.x, y: o.y, z: o.z, cells: o.cells.slice(), under: o.under.slice(), mass: o.mass, hp: o.hp, maxHp: o.maxHp, lights: [...o.lights] })),
    };
  }

  importState(s: ObjectsState): void {
    this.byId.clear(); this.owner.clear();
    for (const so of s.list) {
      const o: WorldObject = { ...so, cells: so.cells.slice(), under: so.under.slice(), lights: [...so.lights] };
      this.byId.set(o.id, o);
      this.claim(o);
    }
    this.next = s.next;
  }

  private key(x: number, y: number, z: number): number { return ((z - this.solid.zMin) * this.solid.depth + y) * this.solid.width + x; }
  private claim(o: WorldObject): void { for (let i = 0; i < o.cells.length; i += 4) this.owner.set(this.key(o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!), o.id); }
  private release(o: WorldObject): void {
    for (let i = 0; i < o.cells.length; i += 4) {
      const k = this.key(o.x + o.cells[i]!, o.y + o.cells[i + 1]!, o.z + o.cells[i + 2]!);
      if (this.owner.get(k) === o.id) this.owner.delete(k);
    }
  }
}
