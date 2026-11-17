// BLOQUES (NARUTO): un mundo hecho de bloques de N x N x N vóxeles, como un juego de construir y picar. Dos piezas:
//   - BlockSet: el catálogo de tipos de bloque (un .voxset.json, hecho con el editor): cada uno, un modelo de N^3 con
//     su id y sus propiedades. Todos comparten una paleta.
//   - BlockGrid: la rejilla de bloques de un mundo (cols x rows x layers), que es la fuente de verdad; los vóxeles son
//     su dibujo. Escribe con stampModel/clearBox (edit.ts), así que el rehorneado es el de siempre, y entra en la
//     instantánea y la huella del mundo (WorldState.addPart).
// docs/motor.md, "Bloques".
import { Model, decode, material, rampMaterial, DIR_VECTORS, type Palette, type MaterialProps } from '../core';
import { clearBox, rampMap, turnCell, turnPoint, type Yaw } from './edit';
import type { Box3 } from './changes';
import type { WorldState, LightId, StatePart, StateHasher } from './state';
import type { WorldView } from './view';
import type { Baked } from './bake';
import type { SourceKind } from '../lighting/lights';
import { CHUNK as CHUNK_V, SLAB, type PreparedSlab } from './state';
const TEMPLATE_MAP = new Uint8Array(256);              // stampRegion: valor del tipo -> entrada de la paleta de la losa
import { applyRegion, type GeneratedRegion } from './regiongen';
const SLAB_CELLS_V = CHUNK_V * CHUNK_V * SLAB;

// Lo que es un bloque para quien juega con él. solid, light y emissive salen de los materiales de sus rampas (lo que
// de verdad hacen la colisión, la luz horneada y el render); si se escriben, tienen que coincidir
export interface BlockProps {
  solid: boolean;                     // bloquea el paso (alguna de sus rampas bloquea)
  light: 'blocks' | 'passes';         // deja pasar la luz (todas sus rampas dejan pasar algo: hojas, vidrio)
  emissive: boolean;                  // brilla solo (alguna rampa emisiva)
  density: number;                    // kg/m³, la media de sus vóxeles (sus materiales), o la que se diga
  // La luz que pone al colocarse (una fija, addFixed) y dónde, en vóxeles del bloque sin girar (por defecto, el centro de
  // arriba): puesto girado, el punto gira con él
  emits?: { kind: SourceKind; radius?: number; intensity?: number; color?: readonly [number, number, number]; at?: readonly [number, number, number] };
  covered?: string;                   // el bloque en que se convierte cuando tiene uno sólido encima (hierba -> tierra)
}

export interface BlockDef { id: string; model: Model; props: BlockProps }

export interface VoxsetFile {
  format: 'voxpix-set';
  version: 1;
  name: string;
  size: number;                                           // N: cada bloque es de N x N x N
  palette: Palette;                                       // la de todos los bloques
  blocks: Array<{ id: string; voxels: Array<[number, number, number, number]>; props?: Partial<BlockProps> }>;
}

const AIR: BlockProps = { solid: false, light: 'passes', emissive: false, density: 0 };

export class BlockSet {
  private defs: BlockDef[] = [];
  private byId = new Map<string, number>();

  constructor(readonly name: string, readonly size: number, readonly palette: Palette) {}

  static fromJSON(f: VoxsetFile): BlockSet {
    if (f.format !== 'voxpix-set' || f.version !== 1) throw new Error(`no es un .voxset.json de la versión 1 (format ${f.format}, version ${f.version})`);
    const set = new BlockSet(f.name, f.size, f.palette);
    for (const b of f.blocks) set.add(b.id, b.voxels, b.props);
    for (const d of set.defs) if (d.props.covered !== undefined) set.index(d.props.covered);   // que exista
    return set;
  }

  toJSON(): VoxsetFile {
    return {
      format: 'voxpix-set', version: 1, name: this.name, size: this.size, palette: this.palette,
      blocks: this.defs.map((d) => ({ id: d.id, voxels: [...d.model.entries()].map(([x, y, z, v]) => [x, y, z, v] as [number, number, number, number]), props: d.props })),
    };
  }

  // Añade un tipo de bloque: sus vóxeles (0..N-1 en cada eje) y lo que se quiera decir de sus propiedades
  add(id: string, voxels: Iterable<readonly [number, number, number, number]>, props: Partial<BlockProps> = {}): number {
    if (this.byId.has(id)) throw new Error(`ya hay un bloque "${id}"`);
    const N = this.size, m = new Model(this.palette, id);
    const mats: MaterialProps[] = [];
    let n = 0, mass = 0;
    for (const [x, y, z, v] of voxels) {
      if (x < 0 || y < 0 || z < 0 || x >= N || y >= N || z >= N) throw new Error(`el bloque "${id}" tiene un vóxel fuera de 0..${N - 1}: ${x}, ${y}, ${z}`);
      if (!v) continue;
      const r = this.palette.ramps[decode(v).ramp];
      if (!r) throw new Error(`el bloque "${id}" usa la rampa ${decode(v).ramp}, que no está en la paleta del set`);
      const mp = rampMaterial(r);
      mats.push(mp); mass += mp.density; n++;
      m.set(x, y, z, v);
    }
    if (!n) throw new Error(`el bloque "${id}" está vacío`);
    const own: BlockProps = {
      solid: mats.some((p) => p.blocks), light: mats.every((p) => p.light > 0) ? 'passes' : 'blocks', emissive: mats.some((p) => p.emissive), density: mass / n,
    };
    for (const k of ['solid', 'light', 'emissive'] as const) {
      if (props[k] !== undefined && props[k] !== own[k]) throw new Error(`el bloque "${id}" dice ${k}: ${props[k]}, pero sus rampas dan ${own[k]}: se cambia con el material de sus rampas`);
    }
    const full: BlockProps = { ...own, ...(props.density !== undefined ? { density: props.density } : {}), ...(props.emits ? { emits: props.emits } : {}), ...(props.covered !== undefined ? { covered: props.covered } : {}) };
    this.defs.push({ id, model: m, props: full });
    this.byId.set(id, this.defs.length);
    return this.defs.length;
  }

  // Cuántos tipos hay (los índices van de 1 a N; 0 es el aire)
  get count(): number { return this.defs.length; }
  index(id: string): number {
    const i = this.byId.get(id);
    if (i === undefined) throw new Error(`no hay bloque "${id}"; los bloques son: ${this.ids().join(', ')}`);
    return i;
  }
  get(index: number): BlockDef {
    const d = this.defs[index - 1];
    if (!d) throw new Error(`no hay bloque ${index} (hay ${this.defs.length}; 0 es el aire)`);
    return d;
  }
  ids(): string[] { return this.defs.map((d) => d.id); }
}

export interface BlockGridState { cells: Uint16Array; yaw: Uint8Array; lights: Array<[number, LightId]> }

export class BlockGrid implements StatePart {
  readonly cols: number;
  readonly rows: number;
  readonly layers: number;
  readonly N: number;
  private cells: Uint16Array;
  private yaws: Uint8Array;
  private lightOf = new Map<number, LightId>();
  private covered: Int32Array;           // por tipo: el índice de su variante tapada (0 = ninguna)

  // La rejilla cubre el mundo desde origin (en vóxeles) con bloques enteros. Las rampas del set tienen que estar en la
  // paleta del mundo (las mismas: nombre y colores), en cualquier posición. Se añade al mundo como parte "name"
  constructor(readonly state: WorldState, readonly blocks: BlockSet, readonly origin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }, name = 'blocks') {
    const s = state.solid, N = (this.N = blocks.size);
    this.cols = Math.floor((s.width - origin.x) / N);
    this.rows = Math.floor((s.depth - origin.y) / N);
    this.layers = Math.floor((s.zMax + 1 - origin.z) / N);
    if (this.cols < 1 || this.rows < 1 || this.layers < 1) throw new Error(`no cabe ningún bloque de ${N} en el mundo desde ${origin.x}, ${origin.y}, ${origin.z}`);
    rampMap(blocks.palette, s.palette);
    this.cells = new Uint16Array(this.cols * this.rows * this.layers);
    this.yaws = new Uint8Array(this.cells.length);
    this.covered = new Int32Array(blocks.count + 1);
    for (let i = 1; i <= blocks.count; i++) { const c = blocks.get(i).props.covered; this.covered[i] = c === undefined ? 0 : blocks.index(c); }
    state.addPart(name, this);
  }

  private at(bx: number, by: number, bz: number): number {
    return bx < 0 || by < 0 || bz < 0 || bx >= this.cols || by >= this.rows || bz >= this.layers ? -1 : (bz * this.rows + by) * this.cols + bx;
  }

  get(bx: number, by: number, bz: number): number {
    const i = this.at(bx, by, bz);
    return i < 0 ? 0 : this.cells[i]!;
  }

  // El giro (en grados, como set) del bloque de esa celda (se guarda en cuartos de vuelta)
  yawOf(bx: number, by: number, bz: number): Yaw {
    const i = this.at(bx, by, bz);
    return ((i < 0 ? 0 : this.yaws[i]!) * 90) as Yaw;
  }

  props(bx: number, by: number, bz: number): BlockProps {
    const t = this.get(bx, by, bz);
    return t ? this.blocks.get(t).props : AIR;
  }

  // La caja de vóxeles de un bloque (extremos incluidos)
  box(bx: number, by: number, bz: number): Box3 {
    const N = this.N, o = this.origin;
    return { x0: o.x + bx * N, y0: o.y + by * N, z0: o.z + bz * N, x1: o.x + bx * N + N - 1, y1: o.y + by * N + N - 1, z1: o.z + bz * N + N - 1 };
  }

  // El bloque que contiene un vóxel, o null si cae fuera de la rejilla
  cellOf(x: number, y: number, z: number): [number, number, number] | null {
    const N = this.N, o = this.origin;
    const bx = Math.floor((x - o.x) / N), by = Math.floor((y - o.y) / N), bz = Math.floor((z - o.z) / N);
    return this.at(bx, by, bz) < 0 ? null : [bx, by, bz];
  }

  // El bz más alto con un bloque sólido en la columna, o -1
  topAt(bx: number, by: number): number {
    for (let bz = this.layers - 1; bz >= 0; bz--) { const t = this.get(bx, by, bz); if (t && this.blocks.get(t).props.solid) return bz; }
    return -1;
  }

  // Pone un bloque (0 lo quita), girado. Si tiene variante tapada y hay un sólido encima, pone la variante; si es
  // sólido, tapa el de debajo. Pone y quita la luz que emite. Da la caja de los vóxeles que cambiaron, o null
  set(bx: number, by: number, bz: number, type: number, yaw: Yaw = 0): Box3 | null {
    const i = this.at(bx, by, bz);
    if (i < 0) throw new Error(`el bloque ${bx}, ${by}, ${bz} está fuera de la rejilla (${this.cols} x ${this.rows} x ${this.layers})`);
    if (type && this.covered[type] && this.props(bx, by, bz + 1).solid) type = this.covered[type]!;
    let box = this.write(i, bx, by, bz, type, yaw);
    if (type && this.blocks.get(type).props.solid) {
      const below = this.get(bx, by, bz - 1);
      if (below && this.covered[below]) box = union(box, this.write(this.at(bx, by, bz - 1), bx, by, bz - 1, this.covered[below]!, this.yaws[this.at(bx, by, bz - 1)]! * 90 as Yaw));
    }
    return box;
  }

  // Rellena una caja de bloques (extremos incluidos) de un tipo, sin variantes tapadas: para generar
  fill(b0: readonly [number, number, number], b1: readonly [number, number, number], type: number): void {
    for (let bz = Math.min(b0[2], b1[2]); bz <= Math.max(b0[2], b1[2]); bz++)
      for (let by = Math.min(b0[1], b1[1]); by <= Math.max(b0[1], b1[1]); by++)
        for (let bx = Math.min(b0[0], b1[0]); bx <= Math.max(b0[0], b1[0]); bx++) {
          const i = this.at(bx, by, bz);
          if (i >= 0) this.write(i, bx, by, bz, type, 0);
        }
  }

  // Escribe una región generada (regiongen.ts) en (gx, gy, gz) de la rejilla, como applyRegion, pero de una vez por
  // trozo de vóxeles: cada losa se compone en memoria desde las plantillas de sus bloques y se instala entera
  // (StaticVoxels.writeChunkSlabs), sin pasar vóxel a vóxel por set. Deja los mismos vóxeles, alturas y celdas que
  // applyRegion (lo sembrado sigue yendo con set, con sus variantes y luces). Vale cuando la región cubre trozos de
  // vóxeles enteros con toda la altura de la rejilla (lo de encima de la rejilla queda en aire); si no, hace applyRegion
  stampRegion(r: GeneratedRegion, at: readonly [number, number, number] = [0, 0, 0], opts: { skip?: readonly number[] } = {}): void {
    for (const step of this.stampSteps(r, at, opts)) step();
  }

  // Lo mismo por pasos, para la cola con plazo (FrameBudget): las celdas, cada trozo de vóxeles (unos 0,05 ms) y cada
  // estructura sembrada. run(deadline) avanza hasta el plazo (un paso por lo menos) y da true al acabar
  stampRegionJob(r: GeneratedRegion, at: readonly [number, number, number] = [0, 0, 0], opts: { skip?: readonly number[] } = {}, key = 'stamp'): { key: string; run(deadline: number): boolean } {
    const steps = this.stampSteps(r, at, opts);
    let k = 0;
    return { key, run: (deadline: number) => { do { steps[k++]!(); } while (k < steps.length && performance.now() < deadline); return k >= steps.length; } };
  }

  private stampSteps(r: GeneratedRegion, at: readonly [number, number, number], opts: { skip?: readonly number[] }): Array<() => void> {
    const s = this.state.solid, N = this.N, o = this.origin, { width: W, depth: D, height: H } = r.region, [gx, gy, gz] = at;
    const vx0 = o.x + gx * N, vy0 = o.y + gy * N;
    const aligned = CHUNK_V % N === 0 && vx0 % CHUNK_V === 0 && vy0 % CHUNK_V === 0 && (W * N) % CHUNK_V === 0 && (D * N) % CHUNK_V === 0
      && gz === 0 && H === this.layers && o.z === s.zMin && !s.onSet && gx >= 0 && gy >= 0 && gx + W <= this.cols && gy + D <= this.rows;
    if (!aligned) return [() => applyRegion(r, this, at, opts)];
    const skip = new Set(opts.skip ?? []);
    const steps: Array<() => void> = [];
    // 1) las celdas (y las luces de lo que emite, como write)
    steps.push(() => { for (let bz = 0; bz < H; bz++) for (let by = 0; by < D; by++) for (let bx = 0; bx < W; bx++) {
      let type = r.cells[(bz * D + by) * W + bx]!;
      if (skip.has(type)) type = 0;
      const i = this.at(gx + bx, gy + by, gz + bz), old = this.cells[i]!;
      if (old && this.blocks.get(old).props.emits) {
        const id = this.lightOf.get(i);
        if (id !== undefined && this.state.lights.get(id)) this.state.lights.removeFixed(id);
        this.lightOf.delete(i);
      }
      this.cells[i] = type; this.yaws[i] = 0;
      const e = type ? this.blocks.get(type).props.emits : undefined;
      if (e) {
        const b = this.box(gx + bx, gy + by, gz + bz), ep = e.at ?? [N / 2, N / 2, N];
        this.lightOf.set(i, this.state.lights.addFixed({ kind: e.kind, x: b.x0 + ep[0], y: b.y0 + ep[1], z: b.z0 + ep[2], ...(e.radius !== undefined ? { radius: e.radius } : {}), ...(e.intensity !== undefined ? { intensity: e.intensity } : {}), ...(e.color ? { color: e.color } : {}) }));
      }
    } });
    // 2) los vóxeles, trozo a trozo: cada losa se compone ya con índices de 1 byte y su paleta (la entrada 0, el aire),
    // desde las plantillas de sus bloques; un bloque cae entero en una losa (N divide a 16)
    const per = CHUNK_V / N;                                   // bloques por lado de un trozo de vóxeles
    const zOff = o.z - s.zMin;
    for (let cy = vy0 / CHUNK_V; cy < (vy0 + D * N) / CHUNK_V; cy++) for (let cx = vx0 / CHUNK_V; cx < (vx0 + W * N) / CHUNK_V; cx++) steps.push(() => {
      const slabs: Array<PreparedSlab | null> = new Array(s.nz).fill(null);
      const tops = new Int16Array(CHUNK_V * CHUNK_V).fill(s.zMin);
      const bx0 = (cx * CHUNK_V - o.x) / N, by0 = (cy * CHUNK_V - o.y) / N;
      let overflow = false;
      for (let bz = 0; bz < this.layers && !overflow; bz++) for (let ly = 0; ly < per; ly++) for (let lx = 0; lx < per; lx++) {
        const type = this.cells[this.at(bx0 + lx, by0 + ly, bz)]!;
        if (!type) continue;
        const tp = this.template(type), zb = zOff + bz * N, si = zb >> 4;
        const sl = slabs[si] ?? (slabs[si] = { d: new Uint8Array(SLAB_CELLS_V), pal: new Uint16Array(256), palN: 1, count: 0 });
        // Los valores del tipo en la paleta de la losa
        const map = TEMPLATE_MAP;
        for (let q = 0; q < tp.values.length; q++) {
          const v = tp.values[q]!;
          let k = 1;
          while (k < sl.palN && sl.pal[k] !== v) k++;
          if (k === sl.palN) { if (sl.palN === 256) { overflow = true; break; } sl.pal[sl.palN++] = v; }
          map[q] = k;
        }
        if (overflow) break;
        const base = ((zb & 15) << 8) | ((ly * N) << 4) | (lx * N), d = sl.d, rel = tp.rel, slot = tp.slot;
        for (let k = 0; k < rel.length; k++) d[base + rel[k]!] = map[slot[k]!]!;
        sl.count += rel.length;
        const zTop = s.zMin + zb;
        for (let q = 0; q < N * N; q++) {
          const tz = tp.top[q]!;
          if (!tz) continue;
          const col = ((ly * N + Math.floor(q / N)) << 4) | (lx * N + (q % N));
          if (zTop + tz > tops[col]!) tops[col] = zTop + tz;
        }
      }
      if (!overflow) { s.writeChunkPrepared(cy * s.cols + cx, slabs, tops); return; }
      // Más de 256 valores distintos en una losa (no pasa con bloques normales): con valores, como siempre
      const vals: Array<Uint16Array | null> = new Array(s.nz).fill(null);
      for (let bz = 0; bz < this.layers; bz++) for (let ly = 0; ly < per; ly++) for (let lx = 0; lx < per; lx++) {
        const type = this.cells[this.at(bx0 + lx, by0 + ly, bz)]!;
        if (!type) continue;
        const list = this.stampList(type, 0), ox = lx * N, oy = ly * N, oz = zOff + bz * N;
        for (let k = 0; k < list.length; k += 4) {
          const z = oz + list[k + 2]!, si = z >> 4;
          (vals[si] ?? (vals[si] = new Uint16Array(SLAB_CELLS_V)))[((z & 15) << 8) | ((oy + list[k + 1]!) << 4) | (ox + list[k]!)] = list[k + 3]!;
        }
      }
      s.writeChunkSlabs(cy * s.cols + cx, vals);
    });
    // 3) lo sembrado que toca la región, con set (variantes tapadas y luces), recortado a ella: como applyRegion
    const { x0, y0, z0 } = r.region;
    // (una estructura por paso: un árbol son unos cuantos bloques enteros con set)
    for (const sw of r.touching) steps.push(() => { for (const [dx, dy, dz, ty] of r.structures[sw.rule]!) {
      const wx = sw.x + dx, wy = sw.y + dy, wz = sw.z + dz;
      if (wx < x0 || wy < y0 || wz < z0 || wx >= x0 + W || wy >= y0 + D || wz >= z0 + H) continue;
      this.set(gx + wx - x0, gy + wy - y0, gz + wz - z0, ty);
    } });
    return steps;
  }

  private write(i: number, bx: number, by: number, bz: number, type: number, yaw: Yaw): Box3 | null {
    const q = (yaw / 90) & 3;
    if (this.cells[i] === type && (this.yaws[i] === q || !type)) return null;
    const old = this.cells[i]!;
    if (old && this.blocks.get(old).props.emits) {
      const id = this.lightOf.get(i);
      if (id !== undefined && this.state.lights.get(id)) this.state.lights.removeFixed(id);
      this.lightOf.delete(i);
    }
    this.cells[i] = type; this.yaws[i] = type ? q : 0;
    const b = this.box(bx, by, bz);
    let box = clearBox(this.state, b);
    if (type) {
      const def = this.blocks.get(type);
      // Tras vaciar la caja, todo lo que se pone cambia: la caja de lo puesto es la de la lista
      const list = this.stampList(type, q), s = this.state.solid;
      for (let k = 0; k < list.length; k += 4) s.set(b.x0 + list[k]!, b.y0 + list[k + 1]!, b.z0 + list[k + 2]!, list[k + 3]!);
      const bd = this.bounds(type, q);
      if (list.length) box = union(box, { x0: b.x0 + bd[0]!, y0: b.y0 + bd[1]!, z0: b.z0 + bd[2]!, x1: b.x0 + bd[3]!, y1: b.y0 + bd[4]!, z1: b.z0 + bd[5]! });
      const e = def.props.emits;
      if (e) {
        // `at` gira con el bloque, como sus vóxeles: la luz sale de donde está su llama en cualquier giro
        const N = this.N, at = e.at ?? [N / 2, N / 2, N], [ax, ay] = turnPoint(at[0], at[1], (q * 90) as Yaw, N);
        this.lightOf.set(i, this.state.lights.addFixed({ kind: e.kind, x: b.x0 + ax, y: b.y0 + ay, z: b.z0 + at[2], ...(e.radius !== undefined ? { radius: e.radius } : {}), ...(e.intensity !== undefined ? { intensity: e.intensity } : {}), ...(e.color ? { color: e.color } : {}) }));
      }
    }
    return box;
  }

  // Los vóxeles de un tipo girado q cuartos, ya en valores del mundo y relativos a la esquina del bloque: x, y, z, valor
  // (lo mismo que stampModel, preparado una vez por tipo y giro)
  private stamps = new Map<number, { list: Int32Array; bounds: number[] }>();
  private stampEntry(type: number, q: number) {
    const k = type * 4 + q;
    let e = this.stamps.get(k);
    if (!e) {
      const def = this.blocks.get(type), N = this.N, map = rampMap(def.model.palette, this.state.solid.palette);
      const out: number[] = [], bd = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (const [mx, my, mz, v] of def.model.entries()) {
        let [x, y] = turnCell(mx, my, (q * 90) as Yaw);
        x += q === 1 || q === 2 ? N : 0; y += q === 2 || q === 3 ? N : 0;
        const { ramp, tone } = decode(v);
        out.push(x, y, mz, material(map[ramp]!, tone));
        bd[0] = Math.min(bd[0]!, x); bd[1] = Math.min(bd[1]!, y); bd[2] = Math.min(bd[2]!, mz);
        bd[3] = Math.max(bd[3]!, x); bd[4] = Math.max(bd[4]!, y); bd[5] = Math.max(bd[5]!, mz);
      }
      e = { list: Int32Array.from(out), bounds: bd };
      this.stamps.set(k, e);
    }
    return e;
  }
  private stampList(type: number, q: number): Int32Array { return this.stampEntry(type, q).list; }
  // La plantilla de un tipo sin girar para componer losas (stampRegion): por vóxel, su sitio dentro de una losa con el
  // bloque en la esquina ((z << 8) | (y << 4) | x) y cuál de los valores del tipo es; y por columna (y * N + x), la
  // cara de arriba del más alto (z + 1; 0 si no hay)
  private templates = new Map<number, { rel: Uint16Array; slot: Uint8Array; values: Uint16Array; top: Uint8Array }>();
  private template(type: number) {
    let e = this.templates.get(type);
    if (!e) {
      const list = this.stampList(type, 0), N = this.N, n = list.length / 4;
      const rel = new Uint16Array(n), slot = new Uint8Array(n), values: number[] = [], top = new Uint8Array(N * N);
      for (let k = 0; k < n; k++) {
        const x = list[k * 4]!, y = list[k * 4 + 1]!, z = list[k * 4 + 2]!, v = list[k * 4 + 3]!;
        rel[k] = (z << 8) | (y << 4) | x;
        let q = values.indexOf(v);
        if (q < 0) { q = values.length; values.push(v); }
        slot[k] = q;
        if (z + 1 > top[y * N + x]!) top[y * N + x] = z + 1;
      }
      e = { rel, slot, values: Uint16Array.from(values), top };
      this.templates.set(type, e);
    }
    return e;
  }
  private bounds(type: number, q: number): number[] { return this.stampEntry(type, q).bounds; }

  // La ventana viva (live.ts): corre la rejilla dcx, dcy celdas como StaticVoxels.shift corre los vóxeles (la celda
  // (bx, by) pasa a tener lo de (bx + dcx, by + dcy); lo que entra, aire). Las luces de los bloques que salen se quitan
  // del mundo; las de los que se quedan siguen con su celda (sus coordenadas las corre quien corre las luces)
  shift(dcx: number, dcy: number): void {
    if (!dcx && !dcy) return;
    const C = this.cols, R = this.rows, L = this.layers, next = new Map<number, LightId>();
    for (const [i, id] of this.lightOf) {
      const bx = i % C, by = Math.floor(i / C) % R, bz = Math.floor(i / (C * R)), nx = bx - dcx, ny = by - dcy;
      if (nx < 0 || ny < 0 || nx >= C || ny >= R) { if (this.state.lights.get(id)) this.state.lights.removeFixed(id); continue; }
      next.set((bz * R + ny) * C + nx, id);
    }
    this.lightOf = next;
    // Por capa, fila a fila, en el orden que no pisa lo que falta por leer
    const run = C - Math.abs(dcx), sx = Math.max(0, dcx), tx = Math.max(0, -dcx);
    for (let z = 0; z < L; z++) {
      const o = z * R * C;
      for (let k = 0; k < R; k++) {
        const y = dcy > 0 ? k : R - 1 - k, sy = y + dcy, d = o + y * C;
        for (const a of [this.cells, this.yaws]) {
          if (sy < 0 || sy >= R || run <= 0) { a.fill(0, d, d + C); continue; }
          a.copyWithin(d + tx, o + sy * C + sx, o + sy * C + sx + run);
          if (dcx > 0) a.fill(0, d + run, d + C); else if (dcx < 0) a.fill(0, d, d + tx);
        }
      }
    }
  }

  // ---- parte del estado del mundo (WorldState.addPart)
  exportState(): BlockGridState {
    return { cells: this.cells.slice(), yaw: this.yaws.slice(), lights: [...this.lightOf].sort((a, b) => a[0] - b[0]) };
  }
  importState(s: unknown): void {
    const g = s as BlockGridState;
    this.cells.set(g.cells); this.yaws.set(g.yaw);
    this.lightOf = new Map(g.lights);
  }
  hashInto(h: StateHasher): void {
    h.bytes(this.cells); h.bytes(this.yaws);
    for (const [i, id] of [...this.lightOf].sort((a, b) => a[0] - b[0])) { h.num(i); h.str(String(id)); }
  }
}

const union = (a: Box3 | null, b: Box3 | null): Box3 | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), z1: Math.max(a.z1, b.z1) };

// El bloque y la cara que se ven en un píxel de la imagen horneada de una vista (en los 4 giros): la cara es la
// dirección, en ejes del mundo, hacia la que mira (donde iría un bloque puesto contra ella). null si no hay nada o si
// lo que se ve no es de la rejilla
export function pickBlock(grid: BlockGrid, view: WorldView, baked: Baked, sx: number, sy: number): { cell: [number, number, number]; face: [number, number, number] } | null {
  const v = view.voxelAt(baked, sx, sy);
  if (!v) return null;
  const f = baked.face[sy * baked.width + sx]!;
  if (f < 0) return null;
  const n = DIR_VECTORS[f]!;
  const [dx, dy] = view.camera.dirToWorld(n[0], n[1]);
  const cell = grid.cellOf(v[0], v[1], v[2]);
  return cell ? { cell, face: [dx + 0, dy + 0, n[2] + 0] } : null;   // + 0: sin -0
}
