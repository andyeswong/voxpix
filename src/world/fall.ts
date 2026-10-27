// Vóxeles que caen: un trozo del mundo se suelta en piezas (cubos de `piece` vóxeles) que caen con gravedad y, al
// aterrizar, vuelven a ser vóxeles del mundo. Dos usos:
//   crumble  la zona se desmorona: las piezas salen con un empujón, caen sobre lo que haya debajo y se quedan como
//            escombro (o desaparecen). P. ej. una pared que se abre.
//   rebuild  la zona se monta desde el cielo: cada pieza cae a su sitio, en orden de abajo arriba. P. ej. un piso
//            nuevo que se arma al llegar.
// Mientras caen, las piezas son entidades (se dibujan como sprites, sin rehornear nada); solo al aterrizar se tocan los
// vóxeles. Se avanza por ticks de la simulación (step) o de golpe (finish): el estado final es el mismo pase lo que
// pase en medio. El azar es el del mundo. No va en el snapshot: hay que acabarla (finish) antes de guardar.
import { Model } from '../core/model';
import { TICK, type EntityId, type WorldState } from './state';

export interface FallBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }   // vóxeles, ambos extremos incluidos
export interface FallRect { x0: number; y0: number; x1: number; y1: number }                           // columnas tocadas

export interface CrumbleOptions {
  piece?: number;                               // lado de cada pieza (4)
  push?: readonly [number, number, number];     // velocidad inicial común, vóxeles/s (0, 0, 20)
  jitter?: number;                              // más una al azar de hasta esto en cada eje (30)
  settle?: 'stay' | 'vanish';                   // al aterrizar: escombro o nada ('stay')
  only?: (x: number, y: number, z: number) => boolean;   // solo los vóxeles de la caja que cumplan esto
}
export interface RebuildOptions {
  piece?: number;                               // lado de cada pieza (8)
  drop?: number;                                // desde cuánto más arriba caen (60)
  launch?: number;                              // segundos entre la primera y la última que se sueltan (1,2)
  // Cuándo vuelven al mundo: 'landing', cada una al aterrizar; 'end', todas juntas cuando ha aterrizado la última
  // (hasta entonces se quedan quietas en su sitio como entidades). Con 'end' el mundo cambia dos veces (al soltarse y
  // al acabar) y se rehornea dos veces, no en cada tick de la caída. El final es el mismo. ('landing')
  // Con 'end', al acabar las piezas siguen dibujadas encima de sus vóxeles hasta release(): el rehorneado tarda unos
  // cuadros y, si se quitaran ya, se vería el sitio vacío. Llamar a release() cuando la vista lo haya publicado.
  commit?: 'landing' | 'end';
}

interface Piece {
  id: EntityId | null;                          // null mientras espera a soltarse (no se ve)
  model: Model;
  ox: number; oy: number;                       // esquina de la pieza en el mundo (enteros); el modelo va relativo a ella
  x: number; y: number; z: number;              // posición actual de esa esquina (z con decimales)
  vx: number; vy: number; vz: number;
  target: number | null;                        // rebuild: la z donde se queda
  wait: number;                                 // segundos hasta soltarse
  bottom: Array<[number, number, number]>;      // por columna de la pieza: (lx, ly, la z más baja)
  settle: 'stay' | 'vanish';
  hold: boolean;                                // commit 'end': al llegar se queda quieta como entidad
  held: boolean;                                // ya llegó y espera a las demás
}

const GRAVITY = 260;                            // vóxeles/s², la de las gotas

export class VoxelFall {
  private pieces: Piece[] = [];
  private rect: FallRect | null = null;
  private lingering: EntityId[] = [];           // commit 'end': las ya escritas en el mundo, hasta release()
  constructor(readonly world: WorldState, readonly gravity = GRAVITY) {}

  get done(): boolean { return this.pieces.length === 0; }
  get active(): number { return this.pieces.length; }
  // Piezas ya escritas en el mundo que aún se dibujan (commit 'end'), hasta release()
  get held(): number { return this.lingering.length; }
  release(): void { for (const id of this.lingering) this.world.entities.remove(id); this.lingering = []; }
  // Las columnas que han cambiado (o cambiarán) desde que se creó: para rehornear solo eso
  get touched(): FallRect | null { return this.rect ? { ...this.rect } : null; }

  crumble(box: FallBox, o: CrumbleOptions = {}): number {
    const push = o.push ?? [0, 0, 20], jitter = o.jitter ?? 30, w = this.world;
    const made = this.lift(box, o.piece ?? 4, o.only);
    for (const p of made) {
      p.vx = push[0] + (w.random() * 2 - 1) * jitter;
      p.vy = push[1] + (w.random() * 2 - 1) * jitter;
      p.vz = push[2] + w.random() * jitter;
      p.settle = o.settle ?? 'stay';
    }
    return made.length;
  }

  rebuild(box: FallBox, o: RebuildOptions = {}): number {
    const drop = o.drop ?? 60, launch = o.launch ?? 1.2, hold = o.commit === 'end', w = this.world;
    const made = this.lift(box, o.piece ?? 8);
    // De abajo arriba; a igual altura, al azar
    const order = made.map((p) => ({ p, k: p.z + w.random() * 0.5 })).sort((a, b) => a.k - b.k).map((e) => e.p);
    order.forEach((p, i) => {
      p.target = p.z;
      p.z += drop;
      p.wait = order.length > 1 ? (launch * i) / (order.length - 1) : 0;
      p.hold = hold;
      w.entities.remove(p.id!);
      p.id = null;
    });
    return made.length;
  }

  // Un tick de la simulación
  step(dt = TICK): void {
    const w = this.world, s = w.solid;
    const keep: Piece[] = [];
    for (const p of this.pieces) {
      if (p.held) { keep.push(p); continue; }
      if (p.wait > 0) { p.wait -= dt; keep.push(p); continue; }
      if (p.id === null) p.id = w.entities.add({ model: p.model, x: p.x, y: p.y, z: p.z, castsShadow: false });
      const z0 = p.z;
      p.vz -= this.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.target !== null) {
        if (p.z <= p.target) {
          if (!p.hold) { this.land(p, p.target); continue; }
          p.z = p.target; p.held = true;
        }
      } else {
        if (Math.round(p.x) < -16 || Math.round(p.y) < -16 || Math.round(p.x) >= s.width + 16 || Math.round(p.y) >= s.depth + 16 || p.z < s.zMin - 32) { this.drop(p); continue; }
        let floor = this.floorUnder(p, p.x, p.y);
        // Lo de delante está más alto que donde iba: choca de lado (no se sube encima). Vuelve atrás en planta y
        // sigue cayendo en vertical
        if (floor > z0) {
          p.x -= p.vx * dt; p.y -= p.vy * dt; p.vx = 0; p.vy = 0;
          floor = this.floorUnder(p, p.x, p.y);
          // Algo aterrizó justo donde estaba (otra pieza en el mismo tick): se queda donde está, sin subirse encima;
          // lo que choca con lo ya puesto se pierde (land solo escribe en celdas vacías)
          if (floor > z0) { this.land(p, Math.max(z0, p.z)); continue; }
        }
        if (p.vz <= 0 && p.z <= floor) { this.land(p, floor); continue; }
      }
      w.entities.move(p.id!, p.x, p.y, p.z);
      keep.push(p);
    }
    this.pieces = keep;
    // commit 'end': cuando todas han llegado, vuelven al mundo de una vez
    if (keep.length && keep.every((p) => p.held)) {
      for (const p of keep) { this.lingering.push(p.id!); p.id = null; this.land(p, p.target!); }
      this.pieces = [];
    }
  }

  // De golpe: el mismo final que a ticks
  finish(maxTicks = 20_000): void {
    for (let t = 0; t < maxTicks && this.pieces.length; t++) {
      if (this.pieces.every((p) => p.target !== null)) { for (const p of this.pieces) this.land(p, p.target!); this.pieces = []; break; }
      this.step();
    }
    for (const p of this.pieces) this.drop(p);
    this.pieces = [];
  }

  // Saca del mundo los vóxeles de la caja, en piezas, y pone cada pieza como entidad donde estaba
  private lift(box: FallBox, size: number, only?: (x: number, y: number, z: number) => boolean): Piece[] {
    const w = this.world, s = w.solid;
    const x0 = Math.max(0, Math.min(box.x0, box.x1)), x1 = Math.min(s.width - 1, Math.max(box.x0, box.x1));
    const y0 = Math.max(0, Math.min(box.y0, box.y1)), y1 = Math.min(s.depth - 1, Math.max(box.y0, box.y1));
    const z0 = Math.max(s.zMin, Math.min(box.z0, box.z1)), z1 = Math.min(s.zMax, Math.max(box.z0, box.z1));
    const made: Piece[] = [];
    if (x0 > x1 || y0 > y1 || z0 > z1) return made;
    this.grow({ x0, y0, x1, y1 });
    const n = Math.max(1, Math.round(size));
    for (let pz = z0; pz <= z1; pz += n) for (let py = y0; py <= y1; py += n) for (let px = x0; px <= x1; px += n) {
      const model = new Model(w.palette, 'fall');
      const low = new Map<number, number>();
      for (let z = pz; z < pz + n && z <= z1; z++) for (let y = py; y < py + n && y <= y1; y++) for (let x = px; x < px + n && x <= x1; x++) {
        const v = s.get(x, y, z);
        if (!v || (only && !only(x, y, z))) continue;
        model.set(x - px, y - py, z - pz, v);
        const k = (y - py) * n + (x - px);
        if (!low.has(k)) low.set(k, z - pz);
      }
      if (!model.size) continue;
      for (const [x, y, z] of model.entries()) s.set(px + x, py + y, pz + z, 0);
      const bottom = [...low].map(([k, lz]) => [k % n, (k / n) | 0, lz] as [number, number, number]);
      const id = w.entities.add({ model, x: px, y: py, z: pz, castsShadow: false });
      const p: Piece = { id, model, ox: px, oy: py, x: px, y: py, z: pz, vx: 0, vy: 0, vz: 0, target: null, wait: 0, bottom, settle: 'stay', hold: false, held: false };
      made.push(p);
      this.pieces.push(p);
    }
    return made;
  }

  // Aterriza: sus vóxeles vuelven al mundo (solo en celdas vacías) y la entidad se va
  private land(p: Piece, z: number): void {
    const w = this.world, s = w.solid;
    if (p.settle === 'stay') {
      const X = p.target !== null ? p.ox : Math.round(p.x), Y = p.target !== null ? p.oy : Math.round(p.y), Z = Math.round(z);
      for (const [x, y, lz, v] of p.model.entries()) {
        const cx = X + x, cy = Y + y, cz = Z + lz;
        if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth || cz < s.zMin || cz > s.zMax || s.get(cx, cy, cz)) continue;
        s.set(cx, cy, cz, v);
        this.grow({ x0: cx, y0: cy, x1: cx, y1: cy });
      }
    }
    if (p.id !== null) w.entities.remove(p.id);
  }

  // La z más alta a la que puede bajar la pieza en (x, y): la cara de arriba de lo sólido bajo cada columna suya
  private floorUnder(p: Piece, x: number, y: number): number {
    const s = this.world.solid, X = Math.round(x), Y = Math.round(y);
    let floor = -Infinity;
    for (const [lx, ly, lz] of p.bottom) {
      const cx = X + lx, cy = Y + ly;
      const top = cx >= 0 && cy >= 0 && cx < s.width && cy < s.depth ? s.height[cy * s.width + cx]! : s.zMin - 64;
      floor = Math.max(floor, top - lz);
    }
    return floor;
  }

  private drop(p: Piece): void { if (p.id !== null) this.world.entities.remove(p.id); }

  private grow(r: FallRect): void {
    const c = this.rect;
    this.rect = c ? { x0: Math.min(c.x0, r.x0), y0: Math.min(c.y0, r.y0), x1: Math.max(c.x1, r.x1), y1: Math.max(c.y1, r.y1) } : { ...r };
  }
}
