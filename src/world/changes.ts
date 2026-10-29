// Qué zona del mundo cambió, para los sistemas del juego que calculan algo a partir de él (caminos, colisiones en
// caché...) y quieren rehacer solo esa zona, como ya hace el horneado. Se usa con WorldState.watchChanges():
//
//   const watch = world.watchChanges();
//   ... cada tick (o cuando convenga):
//   const { boxes, version } = watch.take();     // lo cambiado desde el último take, y se vacía
//   watch.close();                                 // al dejar de escuchar
//
// Las cajas (en vóxeles, extremos incluidos) son de tres clases:
//   'voxels'   una por trozo de 16x16 tocado desde el último take, ajustada a los vóxeles que cambiaron de verdad.
//              Sale del único punto de escritura de vóxeles (StaticVoxels.set): el mundo, los objetos al despertar,
//              dormirse, romperse o morderse, las piezas de VoxelFall, crushAt... ninguna vía se queda sin avisar.
//   'object'   un objeto despierto (ObjectLayer) no está en los vóxeles: es una entidad y moverlo no escribe ninguno.
//              Una caja por objeto (id) con su huella de antes y la de ahora (floor/ceil de la posición continua, más
//              su altura entera); también al despertar y al dormirse, porque deja ese sitio sin escribir vóxeles.
//   'restore'  el mundo entero: restore() cambia los trozos de golpe.
// version es la del mundo al tomar: ninguna caja es posterior a ella (lo que cambie después sale en el take siguiente).
//
// Coste: sin nadie escuchando, una comprobación de null por vóxel escrito y por movimiento de un despierto. Con
// oyentes, la memoria está acotada aunque nunca se llame a take(): una caja por trozo y una por objeto, que crecen
// sin crecer en número.
//
// Límite conocido (v1): el agua (WorldState.dynamicVersions) y las entidades no avisan; para eso está changedSince.

export interface ChangeBox {
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  cause: 'voxels' | 'object' | 'restore';
  id?: number;                     // el objeto, en las 'object'
}

export interface ChangeTake { boxes: ChangeBox[]; version: number }

export interface Box3 { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

export class ChangeWatch {
  private chunks = new Map<number, Int32Array>();      // trozo -> x0, y0, z0, x1, y1, z1
  private objects = new Map<number, Box3>();
  private whole = false;

  constructor(private readonly feed: ChangeFeed) {}

  voxel(c: number, x: number, y: number, z: number): void {
    const b = this.chunks.get(c);
    if (!b) { this.chunks.set(c, Int32Array.of(x, y, z, x, y, z)); return; }
    if (x < b[0]!) b[0] = x; if (y < b[1]!) b[1] = y; if (z < b[2]!) b[2] = z;
    if (x > b[3]!) b[3] = x; if (y > b[4]!) b[4] = y; if (z > b[5]!) b[5] = z;
  }

  object(id: number, r: Box3): void {
    const b = this.objects.get(id);
    if (!b) { this.objects.set(id, { ...r }); return; }
    b.x0 = Math.min(b.x0, r.x0); b.y0 = Math.min(b.y0, r.y0); b.z0 = Math.min(b.z0, r.z0);
    b.x1 = Math.max(b.x1, r.x1); b.y1 = Math.max(b.y1, r.y1); b.z1 = Math.max(b.z1, r.z1);
  }

  everything(): void { this.whole = true; }

  // Cuántas cajas hay guardadas ahora (para medir; take() las da y vacía)
  get pending(): number { return this.chunks.size + this.objects.size + (this.whole ? 1 : 0); }

  take(): ChangeTake {
    const boxes: ChangeBox[] = [];
    if (this.whole) boxes.push({ ...this.feed.worldBox(), cause: 'restore' });
    for (const b of this.chunks.values()) boxes.push({ x0: b[0]!, y0: b[1]!, z0: b[2]!, x1: b[3]!, y1: b[4]!, z1: b[5]!, cause: 'voxels' });
    for (const [id, b] of this.objects) boxes.push({ ...b, cause: 'object', id });
    this.chunks.clear(); this.objects.clear(); this.whole = false;
    return { boxes, version: this.feed.version() };
  }

  close(): void { this.feed.remove(this); }
}

// Los oyentes de un mundo. `list` es null mientras no hay ninguno: así quien avisa solo mira un null
export class ChangeFeed {
  list: ChangeWatch[] | null = null;

  constructor(readonly worldBox: () => Box3, readonly version: () => number) {}

  add(): ChangeWatch {
    const w = new ChangeWatch(this);
    this.list = [...(this.list ?? []), w];
    return w;
  }

  remove(w: ChangeWatch): void {
    if (!this.list) return;
    const rest = this.list.filter((x) => x !== w);
    this.list = rest.length ? rest : null;
  }
}
