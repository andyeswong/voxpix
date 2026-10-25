// EL MUNDO: la única fuente de verdad del juego. Lo leen igual los dos renderizadores (el 2D horneado del juego y
// el vóxel 3D) y la lógica (colisión, agua bajo los pies). Contiene:
//   - vóxeles estáticos en trozos de CHUNK x CHUNK (editables; cada trozo lleva su versión para volver a hornearlo);
//   - el agua: un fluido sobre la misma rejilla (WaterLayer: altura por columna en lagos y charcos);
//   - entidades: un modelo de vóxeles con posición y giro (MAIA, después los demás);
//   - fuentes de luz y gotas.
// Un solo sistema de coordenadas: ejes del modelo (x hacia el este, y hacia el norte, z hacia arriba; 1 unidad =
// 1 vóxel = 1 píxel). La única conversión es la cámara.
//
// SIMULACIÓN DETERMINISTA (acordado con FERN): el runtime lleva el tick (entrada -> mover entidades -> eventos ->
// world.step()). step() avanza 1/60 s fijo, sin reloj ni Math.random: el azar es un mulberry32 del estado, sembrado
// con la semilla de la partida. Misma semilla y mismos eventos dan la misma huella (hash).
import type { Palette, VoxelSource } from '../core';
import { decode, key, unkey } from '../core';
import type { WorldLight, Fountain } from './build';
import type { WaterLayer } from './water';
import { Drops } from './particles';

export const CHUNK = 16;

// Vóxeles estáticos en trozos: una matriz tipada por trozo con la columna entera de zMin a zMax
export class StaticVoxels implements VoxelSource {
  readonly cols: number;
  readonly rows: number;
  readonly zh: number;
  private chunks: Array<Uint16Array | null>;
  // Sello (valor del reloj) del último cambio de VÓXELES de cada trozo. El reloj lo comparten los cambios de agua y
  // entidades (WorldState.changedSince), así una versión dice "todo lo anterior a este momento"
  readonly versions: Uint32Array;
  clock = 0;
  // Altura de la cara de arriba del vóxel sólido más alto de cada columna (índice y * width + x); zMin si no hay
  readonly height: Int16Array;

  constructor(public palette: Palette, readonly width: number, readonly depth: number, readonly zMin: number, readonly zMax: number) {
    this.cols = Math.ceil(width / CHUNK);
    this.rows = Math.ceil(depth / CHUNK);
    this.zh = zMax - zMin + 1;
    this.chunks = new Array(this.cols * this.rows).fill(null);
    this.versions = new Uint32Array(this.cols * this.rows);
    this.height = new Int16Array(width * depth).fill(zMin);
  }

  private where(x: number, y: number, z: number): [Uint16Array | null, number, number] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth || z < this.zMin || z > this.zMax) return [null, -1, -1];
    const c = Math.floor(y / CHUNK) * this.cols + Math.floor(x / CHUNK);
    return [this.chunks[c]!, c, ((z - this.zMin) * CHUNK + (y % CHUNK)) * CHUNK + (x % CHUNK)];
  }

  // (sin crear nada: el render la llama para cada vecino de cada vóxel)
  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth || z < this.zMin || z > this.zMax) return 0;
    const data = this.chunks[((y / CHUNK) | 0) * this.cols + ((x / CHUNK) | 0)];
    return data ? data[((z - this.zMin) * CHUNK + (y % CHUNK)) * CHUNK + (x % CHUNK)]! : 0;
  }

  set(x: number, y: number, z: number, value: number): void {
    let [data, c, i] = this.where(x, y, z);
    if (c < 0) throw new Error(`vóxel fuera del mundo: ${x},${y},${z}`);
    if (!data) { if (!value) return; data = this.chunks[c] = new Uint16Array(CHUNK * CHUNK * this.zh); }
    if (data[i] === value) return;
    data[i] = value;
    this.versions[c] = ++this.clock;
    // Rejilla de alturas: subir es directo; si se vacía el de arriba del todo, se busca el siguiente hacia abajo
    const h = y * this.width + x;
    if (value && z + 1 > this.height[h]!) this.height[h] = z + 1;
    else if (!value && z + 1 === this.height[h]) {
      let t = z - 1;
      while (t >= this.zMin && !this.get(x, y, t)) t--;
      this.height[h] = t >= this.zMin ? t + 1 : this.zMin;
    }
  }

  // Trozos (con su versión) para snapshot y hash; importChunks rehace la rejilla de alturas
  exportChunks(): Array<{ version: number; data: Uint16Array | null }> {
    return this.chunks.map((d, i) => ({ version: this.versions[i]!, data: d ? d.slice() : null }));
  }

  importChunks(cs: Array<{ version: number; data: Uint16Array | null }>): void {
    cs.forEach((c, i) => { this.chunks[i] = c.data ? c.data.slice() : null; this.versions[i] = c.version; });
    this.height.fill(this.zMin);
    for (const [x, y, z] of this.entries()) { const h = y * this.width + x; if (z + 1 > this.height[h]!) this.height[h] = z + 1; }
  }

  chunkOf(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.depth) return -1;
    return Math.floor(y / CHUNK) * this.cols + Math.floor(x / CHUNK);
  }

  // Trozos (índices) cuyos vóxeles cambiaron después de la versión v
  changedSince(v: number): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.versions.length; c++) if (this.versions[c]! > v) out.push(c);
    return out;
  }

  // ¿Hay algún sólido en la columna?
  hasColumn(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.depth && this.height[y * this.width + x]! > this.zMin;
  }

  // Vóxeles llenos de una región (en orden fijo: trozo, z, y, x). Recorre solo la parte de cada trozo que cae en la
  // región, no el trozo entero: una franja estrecha y alta (el rehorneado por columnas) toca muchos trozos.
  *entries(region?: { x0: number; y0: number; x1: number; y1: number }): Generator<[number, number, number, number]> {
    const r = region ?? { x0: 0, y0: 0, x1: this.width - 1, y1: this.depth - 1 };
    const CC = CHUNK * CHUNK;
    for (let cy = Math.max(0, Math.floor(r.y0 / CHUNK)); cy <= Math.min(this.rows - 1, Math.floor(r.y1 / CHUNK)); cy++)
      for (let cx = Math.max(0, Math.floor(r.x0 / CHUNK)); cx <= Math.min(this.cols - 1, Math.floor(r.x1 / CHUNK)); cx++) {
        const data = this.chunks[cy * this.cols + cx];
        if (!data) continue;
        const lx0 = Math.max(0, r.x0 - cx * CHUNK), lx1 = Math.min(CHUNK - 1, r.x1 - cx * CHUNK);
        const ly0 = Math.max(0, r.y0 - cy * CHUNK), ly1 = Math.min(CHUNK - 1, r.y1 - cy * CHUNK);
        for (let lz = 0; lz < this.zh; lz++) for (let ly = ly0; ly <= ly1; ly++) {
          const row = lz * CC + ly * CHUNK;
          for (let lx = lx0; lx <= lx1; lx++) {
            const v = data[row + lx]!;
            if (v) yield [cx * CHUNK + lx, cy * CHUNK + ly, lz + this.zMin, v];
          }
        }
      }
  }

  get size(): number {
    let n = 0;
    for (const d of this.chunks) if (d) for (let i = 0; i < d.length; i++) if (d[i]) n++;
    return n;
  }
}

export type EntityId = number | string;
export type LightId = number | string;

export type ShadowMode = boolean | 'always';

export interface Entity {
  id: EntityId;              // numérico si lo da entities.add; un nombre si viene de addEntity (compatibilidad)
  modelId: number;           // en el registro de modelos del mundo (lo serializable)
  model: VoxelSource;        // su modelo, en sus propios ejes (los pies en el origen)
  x: number;                 // posición de los pies en el mundo (ejes del modelo)
  y: number;
  z: number;
  yaw: number;               // hacia dónde mira, en grados: 0 = sur (a la cámara), 90 = este. Es el `facing` de la API
  // Da sombra de verdad con las luces del mundo. Como mucho MAX_CASTERS por cuadro (frame2d.ts): las 'always'
  // siempre (p. ej. el personaje), y el resto de las true, por cercanía al centro de la vista
  castsShadow: ShadowMode;
  rampOffset: number;        // dónde empiezan sus rampas en la paleta del mundo
  // Tinte plano temporal (r, g, b de 0 a 1), p. ej. el destello de un golpe: sus vóxeles se pintan de ese color, con
  // luz propia, y el contorno se queda. Solo aspecto: no entra en la huella ni hace falta guardarlo (lo pone la vista)
  tint?: readonly [number, number, number] | null;
}

// Las entidades del mundo: un array (se recorre y se busca como siempre) con add / move / remove
export class EntityList extends Array<Entity> {
  static override get [Symbol.species]() { return Array; }
  owner!: WorldState;
  next = 1;
  add(o: { model: VoxelSource | number; x: number; y: number; z: number; facing?: number; castsShadow?: ShadowMode; id?: EntityId }): EntityId {
    const w = this.owner;
    w.touchArea(o.x, o.y, ENTITY_REACH);
    const modelId = typeof o.model === 'number' ? o.model : w.models.register(o.model);
    const model = w.models.get(modelId);
    const id = o.id ?? this.next++;
    this.push({ id, modelId, model, x: o.x, y: o.y, z: o.z, yaw: o.facing ?? 0, castsShadow: o.castsShadow ?? true, rampOffset: w.models.rampOffset(modelId) });
    this.indexed = -1;
    return id;
  }
  // Por id con un índice (con cientos de entidades, buscar en la lista en cada move costaba O(n) por llamada). El
  // índice se rehace si la lista cambió por fuera (restore la vacía y la vuelve a llenar)
  private index = new Map<EntityId, Entity>();
  private indexed = -1;
  get(id: EntityId): Entity | undefined {
    if (this.indexed !== this.length) this.reindex();
    const e = this.index.get(id);
    if (e && e.id === id) return e;
    this.reindex();
    return this.index.get(id);
  }
  reindex(): void {
    this.index.clear();
    for (const e of this) this.index.set(e.id, e);
    this.indexed = this.length;
  }
  move(id: EntityId, x: number, y: number, z: number, facing?: number): void {
    const e = this.get(id);
    if (!e) throw new Error(`no hay entidad ${id}`);
    this.owner.touchArea(e.x, e.y, ENTITY_REACH);
    e.x = x; e.y = y; e.z = z;
    if (facing !== undefined) e.yaw = facing;
    this.owner.touchArea(x, y, ENTITY_REACH);
  }
  // Cambia el modelo de una entidad (p. ej. el cuadro de su walk). Un modelo nuevo se registra; con el mismo id no
  // hace nada (ni marca la zona), así se puede llamar en cada tick
  // El tinte plano de una entidad (null lo quita); ver Entity.tint
  setTint(id: EntityId, color: readonly [number, number, number] | null): void {
    const e = this.get(id);
    if (!e) throw new Error(`no hay entidad ${id}`);
    e.tint = color ? [Math.round(color[0] * 255) / 255, Math.round(color[1] * 255) / 255, Math.round(color[2] * 255) / 255] : null;
  }
  setModel(id: EntityId, model: VoxelSource | number): void {
    const e = this.get(id);
    if (!e) throw new Error(`no hay entidad ${id}`);
    const w = this.owner;
    const modelId = typeof model === 'number' ? model : w.models.register(model);
    if (modelId === e.modelId) return;
    e.modelId = modelId;
    e.model = w.models.get(modelId);
    e.rampOffset = w.models.rampOffset(modelId);
    w.touchArea(e.x, e.y, ENTITY_REACH);
  }
  remove(id: EntityId): void {
    const i = this.findIndex((e) => e.id === id);
    if (i >= 0) { this.owner.touchArea(this[i]!.x, this[i]!.y, ENTITY_REACH); this.splice(i, 1); this.indexed = -1; }
  }
}

// Zona (en planta) que marca una entidad al moverse: su cuerpo y su sombra cercana
const ENTITY_REACH = 24;

// Las luces del mundo: las fijas del worldgen (baked: se hornean) y las que se añaden en partida (dinámicas: se suman
// cada cuadro en su radio). Un array con add / move / remove.
export class LightList extends Array<WorldLight> {
  static override get [Symbol.species]() { return Array; }
  next = 1;
  add(o: Omit<WorldLight, 'id' | 'baked'> & { id?: LightId }): LightId {
    const id = o.id ?? this.next++;
    this.push({ ...o, id, baked: false, ...(o.follow ? { owner: o.follow.entity } : {}) });
    if (o.follow) this.owner?.placeFollowers();
    return id;
  }
  owner?: WorldState;
  get(id: LightId): WorldLight | undefined { return this.find((l) => l.id === id); }
  move(id: LightId, x: number, y: number, z: number): void {
    const l = this.get(id);
    if (!l) throw new Error(`no hay luz ${id}`);
    if (l.baked) throw new Error(`la luz ${id} está horneada: las fijas no se mueven`);
    l.x = x; l.y = y; l.z = z;
  }
  // Apunta un foco (o lo vuelve foco): dirección en ejes del modelo y, si se da, la apertura del cono en grados
  aim(id: LightId, dir: readonly [number, number, number], cone?: number): void {
    const l = this.get(id);
    if (!l) throw new Error(`no hay luz ${id}`);
    if (l.baked) throw new Error(`la luz ${id} está horneada: las fijas no se apuntan`);
    l.dir = [dir[0], dir[1], dir[2]];
    if (cone !== undefined) l.cone = cone;
  }
  remove(id: LightId): void {
    const i = this.findIndex((l) => l.id === id);
    if (i >= 0) this.splice(i, 1);
  }
}

// Registro de modelos: el estado guarda ids (serializable); las rampas de cada modelo se suman una vez a la paleta
export class ModelRegistry {
  private list: VoxelSource[] = [];
  private offsets: number[] = [];
  // Los modelos que comparten paleta (p. ej. los cuadros de una animación) comparten sus rampas en la del mundo
  private paletteOffset = new Map<object, number>();
  constructor(private owner: WorldState) {}
  register(model: VoxelSource): number {
    const i = this.list.indexOf(model);
    if (i >= 0) return i;
    const w = this.owner;
    let off = this.paletteOffset.get(model.palette);
    if (off === undefined) {
      off = w.palette.ramps.length;
      this.paletteOffset.set(model.palette, off);
      w.palette = { ...w.palette, ramps: [...w.palette.ramps, ...model.palette.ramps] };
      w.solid.palette = w.palette;
    }
    this.offsets.push(off);
    this.list.push(model);
    return this.list.length - 1;
  }
  get(id: number): VoxelSource {
    const m = this.list[id];
    if (!m) throw new Error(`no hay modelo ${id}`);
    return m;
  }
  rampOffset(id: number): number { return this.offsets[id]!; }
}

export interface ViewRegion { x0: number; y0: number; x1: number; y1: number }

export class WorldState {
  palette: Palette;
  readonly entities = new EntityList();
  // Sello del último cambio de AGUA o ENTIDADES de cada trozo (mismo reloj que los vóxeles)
  readonly dynamicVersions: Uint32Array;
  readonly lights = new LightList();
  readonly models: ModelRegistry;
  readonly drops: Drops;
  tick = 0;
  private rngState: number;

  constructor(readonly solid: StaticVoxels, lights: WorldLight[], public water: WaterLayer | null,
    opts: { seed?: number; fountain?: Fountain | null } = {}) {
    this.palette = solid.palette;
    this.models = new ModelRegistry(this);
    this.dynamicVersions = new Uint32Array(solid.versions.length);
    this.entities.owner = this;
    this.lights.owner = this;
    // Las del worldgen son fijas: se hornean
    for (const l of lights) this.lights.push({ ...l, baked: l.baked ?? true });
    this.rngState = (opts.seed ?? 1) >>> 0;
    this.fountain = opts.fountain ?? null;
    this.drops = new Drops(() => this.random());
  }

  readonly fountain: Fountain | null;

  // mulberry32 (el mismo de src/sim/rng), con el estado a la vista para snapshot y hash
  random(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // ---- eventos: lo que el juego le hace al mundo dentro del tick (los llama el runtime antes de step)
  readonly events = {
    // Algo empuja el agua (pisar, un golpe): ondas; con fuerza, el agua salta el borde
    disturb: (x: number, y: number, force: number, radius = 1.5) => { this.water?.disturb(x, y, force, radius); },
    // Añade agua en un punto
    pour: (x: number, y: number, amount: number) => { this.water?.pour(x, y, amount); },
    // Gotas que saltan desde (x, y, z)
    splash: (x: number, y: number, z: number, count: number, force: number) => { this.drops.splash(x, y, z, count, force); },
  };

  get width(): number { return this.solid.width; }
  get depth(): number { return this.solid.depth; }

  // Compatibilidad: una entidad con nombre (lo mismo que entities.add con id = nombre). Devuelve la entidad.
  addEntity(id: string, model: VoxelSource, x: number, y: number, z = 0, yaw = 0): Entity {
    this.entities.add({ id, model, x, y, z, facing: yaw });
    return this.entities.get(id)!;
  }

  entity(id: EntityId): Entity | undefined { return this.entities.get(id); }

  // Material de una entidad en la paleta del mundo
  static remap(e: Entity, v: number): number {
    const { ramp, tone } = decode(v);
    return (e.rampOffset + ramp) * 16 + tone + 1;
  }

  // ---- lo que ve un renderizador: lo estático, las entidades y el agua, compuestos al vuelo y sin copias
  view(region: ViewRegion, opts: { entities?: boolean; water?: boolean } = {}): VoxelSource {
    const withEntities = opts.entities ?? true, withWater = opts.water ?? true;
    const ent = new Map<number, number>();
    const entList: Array<[number, number, number, number]> = [];
    if (withEntities) for (const e of this.entities) {
      // En vóxeles, el giro va a la vuelta de 90° más cercana (el 2D gira libre)
      const turns = ((Math.round(e.yaw / 90) % 4) + 4) % 4;
      const c = [1, 0, -1, 0][turns]!, s = [0, 1, 0, -1][turns]!;
      const ox = Math.round(e.x), oy = Math.round(e.y), oz = Math.round(e.z);
      for (const [x, y, z, v] of e.model.entries()) {
        const wx = ox + x * c - y * s, wy = oy + x * s + y * c, wz = oz + z;
        const vv = WorldState.remap(e, v);
        ent.set(key(wx, wy, wz), vv);
        entList.push([wx, wy, wz, vv]);
      }
    }
    const water = withWater ? this.waterColumns(region) : null;
    const solid = this.solid;
    const self = this;
    return {
      get palette() { return self.palette; },
      get(x: number, y: number, z: number): number {
        const s = solid.get(x, y, z);
        if (s) return s;
        if (!ent.size && !water) return 0;
        const k = key(x, y, z);
        return ent.get(k) ?? water?.get(k) ?? 0;
      },
      *entries() {
        for (const v of solid.entries(region)) yield v;
        for (const v of entList) if (!solid.get(v[0], v[1], v[2])) yield v;
        if (water) for (const [k, v] of water) {
          const [x, y, z] = unkey(k);
          if (!solid.get(x, y, z) && !ent.has(k)) yield [x, y, z, v];
        }
      },
    };
  }

  // El agua de una región como vóxeles: cada columna desde el fondo hasta la superficie de ahora
  waterColumns(region: ViewRegion): Map<number, number> {
    const out = new Map<number, number>();
    const w = this.water;
    if (!w) return out;
    const waterRamp = this.palette.ramps.findIndex((r) => r.name === 'agua');
    if (waterRamp < 0) return out;
    const sim = w.sim;
    const gx0 = Math.max(0, Math.floor(region.x0 / 2) - 1), gx1 = Math.min(w.gw - 1, Math.ceil(region.x1 / 2) + 1);
    const gy0 = Math.max(0, Math.floor(region.y0 / 2) - 1), gy1 = Math.min(w.gh - 1, Math.ceil(region.y1 / 2) + 1);
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      const i = gy * w.gw + gx;
      const d = sim.depth[i]!;
      if (d < 0.05 || sim.solid[i]) continue;
      const x0 = gx * 2, y0 = gy * 2;
      if (x0 + 1 < region.x0 || x0 > region.x1 || y0 + 1 < region.y0 || y0 > region.y1) continue;
      const g = sim.ground[i]!, top = Math.round(g + d) - 1;
      for (let z = g + 1; z <= top; z++) {
        const tone = z === top ? 3 : top - z > 3 ? 1 : 2;
        const v = waterRamp * 16 + tone + 1;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) out.set(key(x0 + dx, y0 + dy, z), v);
      }
    }
    return out;
  }

  // ---- consultas del juego (WorldQuery, acordada con FERN). Todo en ejes del modelo: x este, y norte, z arriba.

  // ¿Vóxel sólido estático? (paredes, columnas, muebles, el pilón de la fuente)
  solidAt(x: number, y: number, z: number): boolean {
    return this.solid.get(Math.floor(x), Math.floor(y), Math.floor(z)) !== 0;
  }

  // Altura (entera) de la cara de arriba del sólido más alto de la columna: donde se apoya el pie. El agua no
  // cuenta: sus alturas fraccionarias solo salen por waterAt.
  groundAt(x: number, y: number): number {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.depth) return this.solid.zMin;
    return this.solid.height[yi * this.width + xi]!;
  }

  // Agua en la columna: profundidad y altura de la superficie (null si está seca)
  waterAt(x: number, y: number): { depth: number; surface: number } | null {
    const w = this.water;
    if (!w) return null;
    const depth = w.depthAt(x, y);
    return depth > 0.01 ? { depth, surface: w.surfaceAt(x, y) } : null;
  }

  // ¿Cabe un pie en (x, y) viniendo de la altura feetZ? Sube como mucho `step`; bajar, lo que sea (sin vacío).
  // El agua más honda que `maxWater` no se puede pisar.
  standable(x: number, y: number, feetZ: number, step: number, maxWater = 4.5): boolean {
    const xi = Math.floor(x), yi = Math.floor(y);
    if (!this.solid.hasColumn(xi, yi)) return false;
    if (this.groundAt(xi, yi) - feetZ > step) return false;
    const w = this.waterAt(xi, yi);
    return !(w && w.depth > maxWater);
  }

  // Primer vóxel sólido estático en el segmento de `from` a `to` (DDA): el punto de entrada y la normal de la cara
  raycast(from: [number, number, number], to: [number, number, number]): { hit: [number, number, number]; normal: [number, number, number] } | null {
    const [px, py, pz] = from;
    const dx = to[0] - px, dy = to[1] - py, dz = to[2] - pz;
    let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
    const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
    const ddx = sx ? Math.abs(1 / dx) : Infinity, ddy = sy ? Math.abs(1 / dy) : Infinity, ddz = sz ? Math.abs(1 / dz) : Infinity;
    let mx = sx ? (sx > 0 ? x + 1 - px : px - x) * ddx : Infinity;
    let my = sy ? (sy > 0 ? y + 1 - py : py - y) * ddy : Infinity;
    let mz = sz ? (sz > 0 ? z + 1 - pz : pz - z) * ddz : Infinity;
    if (this.solid.get(x, y, z)) return { hit: [px, py, pz], normal: [0, 0, 0] };
    for (let i = 0; i < 4096; i++) {
      let t: number, normal: [number, number, number];
      if (mx <= my && mx <= mz) { t = mx; x += sx; mx += ddx; normal = [-sx, 0, 0]; }
      else if (my <= mz) { t = my; y += sy; my += ddy; normal = [0, -sy, 0]; }
      else { t = mz; z += sz; mz += ddz; normal = [0, 0, -sz]; }
      if (t > 1) return null;
      if (this.solid.get(x, y, z)) return { hit: [px + dx * t, py + dy * t, pz + dz * t], normal };
    }
    return null;
  }

  // ---- qué ha cambiado (para rehornear y subir a la GPU solo eso)

  // Versión actual del mundo: guardarla y después preguntar changedSince(esa versión)
  get version(): number { return this.solid.clock; }

  // Marca como cambiados (agua o entidades) los trozos que toca un círculo en planta
  touchArea(x: number, y: number, r: number): void {
    const s = this.solid;
    const stamp = ++s.clock;
    for (let cy = Math.max(0, Math.floor((y - r) / CHUNK)); cy <= Math.min(s.rows - 1, Math.floor((y + r) / CHUNK)); cy++)
      for (let cx = Math.max(0, Math.floor((x - r) / CHUNK)); cx <= Math.min(s.cols - 1, Math.floor((x + r) / CHUNK)); cx++)
        this.dynamicVersions[cy * s.cols + cx] = stamp;
  }

  // Trozos que cambiaron después de la versión v: vóxeles, agua o entidades (o solo vóxeles, para el horneado)
  changedSince(v: number, what: 'all' | 'voxels' = 'all'): number[] {
    const out: number[] = [];
    for (let c = 0; c < this.solid.versions.length; c++)
      if (this.solid.versions[c]! > v || (what === 'all' && this.dynamicVersions[c]! > v)) out.push(c);
    return out;
  }

  // Un tick de simulación: 1/60 s fijo
  // Las luces que van con una entidad, en su sitio: el offset (y la dirección) girados con su facing. Si la entidad ya
  // no está, la luz se queda donde estaba.
  placeFollowers(): void {
    for (const l of this.lights) {
      const f = l.follow;
      if (!f) continue;
      const e = this.entities.get(f.entity);
      if (!e) continue;
      const a = (e.yaw * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      const rot = (v: readonly [number, number, number]): [number, number, number] => [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
      const o = rot(f.offset);
      l.x = e.x + 0.5 + o[0]; l.y = e.y + o[1]; l.z = e.z + o[2];
      if (f.dir) l.dir = rot(f.dir);
    }
  }

  step(): void {
    const dt = TICK;
    // La fuente: un chorro de gotas que cae del borde del cuenco al pilón (con el azar del mundo)
    const f = this.fountain;
    if (f) for (let k = 0; k < 3; k++) {
      const ang = this.random() * Math.PI * 2, sp = 10 + this.random() * 8;
      this.drops.emit(f.x + Math.cos(ang) * 6.5, f.y + Math.sin(ang) * 6.5, f.bowl.z + 2, Math.cos(ang) * sp, Math.sin(ang) * sp, 8 + this.random() * 10, 0.012);
    }
    this.water?.step(dt);
    if (this.water) {
      // Las celdas de agua que se movieron marcan su trozo
      const w = this.water, s = this.solid;
      let stamp = 0;
      for (const i of w.sim.activeCells()) {
        const c = s.chunkOf((i % w.gw) * 2, Math.floor(i / w.gw) * 2);
        if (c < 0) continue;
        if (!stamp) stamp = ++s.clock;
        this.dynamicVersions[c] = stamp;
      }
    }
    this.drops.step(dt, this.water, (x, y) => this.groundAt(x, y));
    this.placeFollowers();
    this.tick++;
  }

  // Calienta el JIT de step (agua, gotas, salpicaduras): sin esto el primer tick de la partida tarda ~10 ms en vez de
  // ~0,7 (lo midió FERN). Da unos ticks con un pisotón y vuelve exactamente al estado de antes (misma huella).
  warmUp(ticks = 6): void {
    const s = this.snapshot();
    const w = this.water;
    for (let k = 0; k < ticks; k++) {
      if (w && k === 0) for (let i = 0; i < w.gw * w.gh; i += 97) {
        if (w.sim.depth[i]! <= 1) continue;
        const x = (i % w.gw) * 2 + 1, y = Math.floor(i / w.gw) * 2 + 1;
        this.events.disturb(x, y, 2.8, 3);
        this.events.splash(x, y, w.surfaceAt(x, y), 40, 105);
        break;
      }
      this.step();
    }
    this.restore(s);
  }

  // ---- instantánea y huella
  snapshot(): WorldSnapshot {
    return {
      tick: this.tick, rng: this.rngState,
      chunks: this.solid.exportChunks(),
      water: this.water ? this.water.sim.exportState() : null,
      drops: this.drops.exportState(),
      entities: [...this.entities].sort((a, b) => byId(a.id, b.id)).map((e) => ({ id: e.id, modelId: e.modelId, x: e.x, y: e.y, z: e.z, yaw: e.yaw, castsShadow: e.castsShadow })),
      lights: [...this.lights].sort((a, b) => byId(a.id, b.id)).map((l) => ({ ...l })),
      next: { entity: this.entities.next, light: this.lights.next },
      clock: this.solid.clock, dynamicVersions: this.dynamicVersions.slice(),
    };
  }

  restore(s: WorldSnapshot): void {
    this.tick = s.tick; this.rngState = s.rng;
    this.solid.importChunks(s.chunks);
    if (this.water && s.water) this.water.sim.importState(s.water);
    this.drops.importState(s.drops);
    // Las entidades y luces vuelven a ser exactamente las de la instantánea (las nuevas se van, las quitadas vuelven)
    this.entities.length = 0;
    for (const se of s.entities) {
      const model = this.models.get(se.modelId);
      this.entities.push({ id: se.id, modelId: se.modelId, model, x: se.x, y: se.y, z: se.z, yaw: se.yaw, castsShadow: se.castsShadow, rampOffset: this.models.rampOffset(se.modelId) });
    }
    this.lights.length = 0;
    this.lights.push(...s.lights.map((l) => ({ ...l })));
    this.entities.next = s.next.entity; this.lights.next = s.next.light;
    this.entities.reindex();
    this.solid.clock = s.clock; this.dynamicVersions.set(s.dynamicVersions);
  }

  // Huella (FNV-1a de 32 bits) de todo el estado, en un orden fijo
  hash(): string {
    const h = new Fnv();
    const s = this.snapshot();
    h.num(s.tick); h.num(s.rng);
    for (const c of s.chunks) { h.num(c.version); if (c.data) h.bytes(c.data); else h.num(-1); }
    if (s.water) for (const k of ['depth', 'fl', 'fr', 'ft', 'fb', 'awake'] as const) h.bytes(s.water[k]);
    h.num(s.drops.n); h.bytes(s.drops.data);
    for (const e of s.entities) { h.str(String(e.id)); h.num(e.modelId); h.f64(e.x); h.f64(e.y); h.f64(e.z); h.f64(e.yaw); h.num(e.castsShadow === 'always' ? 2 : e.castsShadow ? 1 : 0); }
    for (const l of s.lights) { h.str(String(l.id)); h.str(l.kind); h.f64(l.x); h.f64(l.y); h.f64(l.z); h.num(l.baked ? 1 : 0); h.f64(l.intensity ?? -1); h.f64(l.radius ?? -1); h.f64(l.dir?.[0] ?? 9); h.f64(l.dir?.[1] ?? 9); h.f64(l.dir?.[2] ?? 9); h.f64(l.cone ?? -1); h.str(String(l.owner ?? '')); h.str(l.follow ? JSON.stringify(l.follow) : ''); }
    h.num(s.next.entity); h.num(s.next.light);
    h.num(s.clock); h.bytes(s.dynamicVersions);
    return h.hex();
  }
}

export const TICK = 1 / 60;

export interface WorldSnapshot {
  tick: number;
  rng: number;
  chunks: Array<{ version: number; data: Uint16Array | null }>;
  water: ReturnType<import('../fluid/shallow').ShallowWater['exportState']> | null;
  drops: { data: Float32Array; n: number };
  entities: Array<{ id: EntityId; modelId: number; x: number; y: number; z: number; yaw: number; castsShadow: ShadowMode }>;
  lights: WorldLight[];
  next: { entity: number; light: number };
  clock: number;
  dynamicVersions: Uint32Array;
}

// FNV-1a de 32 bits sobre los bytes, en orden
class Fnv {
  private h = 0x811c9dc5;
  private buf = new DataView(new ArrayBuffer(8));
  bytes(a: ArrayBufferView): void {
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let h = this.h;
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i]!, 0x01000193);
    this.h = h >>> 0;
  }
  num(n: number): void { this.buf.setInt32(0, n | 0); this.bytes(new Uint8Array(this.buf.buffer, 0, 4)); }
  f64(n: number): void { this.buf.setFloat64(0, n); this.bytes(new Uint8Array(this.buf.buffer, 0, 8)); }
  str(s: string): void { for (let i = 0; i < s.length; i++) this.num(s.charCodeAt(i)); this.num(0); }
  hex(): string { return (this.h >>> 0).toString(16).padStart(8, '0'); }
}

// Orden estable de ids (números antes que nombres)
function byId(a: EntityId, b: EntityId): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
