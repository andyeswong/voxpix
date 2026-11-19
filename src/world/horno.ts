// EL HORNO EN UN WORKER (docs/horno-worker.md). Los recuadros del rehorneado de la ventana viva se pintan fuera del hilo
// principal, con una copia de los vóxeles de cada horneado (el espejo), y el principal solo publica lo que llega.
//
// - BakeWorker (hilo principal): attach(win) una vez. La ventana pone su remote en el horneado del giro que se ve
//   (LiveWindow.setRemote) y avisa de cada corrimiento con lo que se corrió cada fuente (attach, shiftSources). Nada se
//   envuelve: las ediciones y los trozos que entran se ven en las versiones de la fuente (StaticVoxels.dataVersions), y al
//   pedir cada recuadro se mandan los trozos que lee cuya versión no se mandó todavía.
// - BakeWorkerHost (el worker; horno-worker.ts es su entrada): un espejo por fuente (StaticVoxels del mismo tamaño y un
//   horneado sin pintar con las mismas opciones), los trozos que llegan, los corrimientos, y un recuadro pintado por tarea
//   (los mensajes entran entre medias).
//
// Un espejo por fuente, no por giro: la copia girada de cada giro es otra fuente, y se manda solo lo que piden sus
// recuadros. Girar no rehace nada: los espejos de los giros que siguen vivos se quedan, y el del giro que se suelta se
// tira en el corrimiento siguiente (o al pasar de `keep`).
// Lo que se pidió antes de un corrimiento de su espejo se salta (el principal ya lo descartó: un recuadro esperando al
// worker no se traslada).
import type { Palette } from '../core';
import { StaticVoxels, type PreparedSlab } from './state';
import { bakeWorldJob, renderRect, readChunks, skyFromPick, skyReadChunks, type Baked, type RectOut, type RemoteRects, type ScreenRect } from './bake';
import type { LiveWindow } from './live';

type Outline = 'none' | 'outer' | 'both';
export interface MirrorBake { topZ: number; incline: number; outline: Outline; outlineColor?: string; options: string }
// (v: su versión en la fuente; el worker no la usa: para contar lo mandado de más)
export type SentChunk = { c: number; v: number; slabs: Array<PreparedSlab | null>; tops: Int16Array };
export type ToWorker =
  | { kind: 'mirror'; id: number; width: number; depth: number; zMin: number; zMax: number; palette: Palette; bake: MirrorBake }
  | { kind: 'drop'; id: number }
  | { kind: 'chunks'; id: number; list: SentChunk[] }
  | { kind: 'shift'; id: number; dcx: number; dcy: number }
  | { kind: 'rect'; ticket: number; id: number; gen: number; rect: ScreenRect; brake: number }
  | { kind: 'sky'; ticket: number; id: number; gen: number; pick: Float64Array; face: Int8Array; brake: number };
export type FromWorker = { kind: 'rect'; ticket: number; o: RectOut; ms: number } | { kind: 'sky'; ticket: number; sky: Uint8Array; ms: number } | { kind: 'skip'; ticket: number };

export interface BakeWorkerPort {
  postMessage(m: ToWorker, transfer?: Transferable[]): void;
  onmessage: ((e: { data: FromWorker }) => void) | null;
}
export interface BakeWorkerOptions {
  // Lo que se pinta aquí y no fuera (lo cercano: llega antes pintado aquí que de ida y vuelta). Se pregunta al pedir cada
  // recuadro, así que puede cambiar en cada cuadro
  near?: (rect: ScreenRect, b: Baked) => boolean;
  // Cuántos recuadros llegados se entregan por cuadro (frame()); sin él, en cuanto llegan
  perFrame?: number;
  // Freno del worker: tras pintar, espera brake - 1 veces lo que tardó (para medir a 6x, donde el CDP no frena workers)
  brake?: number;
  // Cuántos espejos guarda como mucho (el más viejo se tira)
  keep?: number;
}

// Un espejo, visto desde el principal: su fuente, la versión mandada de cada trozo y cuántos corrimientos lleva
interface Mirror { id: number; source: StaticVoxels; sent: Uint32Array; gen: number; used: number }

// (corre una rejilla de cols x rows trozos como StaticVoxels.shift: lo del trozo c + d pasa a c; lo que entra, a 0)
function shiftSent(a: Uint32Array, cols: number, rows: number, dcx: number, dcy: number): Uint32Array {
  const out = new Uint32Array(a.length);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const sx = cx + dcx, sy = cy + dcy;
    if (sx >= 0 && sy >= 0 && sx < cols && sy < rows) out[cy * cols + cx] = a[sy * cols + sx]!;
  }
  return out;
}

export class BakeWorker {
  readonly stats = { asked: 0, got: 0, skipped: 0, near: 0, unsendable: 0, chunks: 0, syncMs: 0, workerMs: 0, mirrors: 0, dropped: 0, skies: 0, skyMs: 0,
    // (trozos mandados otra vez porque sus vóxeles cambiaron desde el último envío)
    resent: 0 };
  private readonly mirrors = new Map<StaticVoxels, Mirror>();
  private readonly tickets = new Map<number, { out: RectOut | Uint8Array | null; ready: boolean }>();
  private readonly inbox: number[] = [];
  private nextId = 0;
  private nextTicket = 0;
  private tick = 0;
  private off: (() => void) | null = null;

  constructor(private readonly port: BakeWorkerPort, private readonly o: BakeWorkerOptions = {}) {
    port.onmessage = (e) => this.receive(e.data);
  }

  // Se engancha a la ventana: su remote en el horneado del giro que se ve, y sus corrimientos. Una vez
  attach(win: LiveWindow): void {
    this.detach();
    const offShift = win.attach({ shift: () => {}, shiftSources: (list) => this.shifted(list) });
    win.setRemote((b) => this.remoteFor(b));
    this.off = () => { offShift(); win.setRemote(null); };
  }
  detach(): void { this.off?.(); this.off = null; }

  // Cada cuadro: entrega hasta perFrame de los llegados
  frame(): void {
    for (let n = 0; n < (this.o.perFrame ?? Infinity) && this.inbox.length; n++) {
      const t = this.tickets.get(this.inbox.shift()!);
      if (t) t.ready = true;
    }
  }

  private remoteFor(b: Baked): RemoteRects { return { ask: (rect) => this.ask(b, rect), sky: (rect, pick, face) => this.askSky(b, rect, pick, face) }; }

  // Los trozos de `chunks` que el espejo no tiene en su versión de ahora, mandados. false: alguno no cabe en la forma de
  // mandar (lo pedido se hace aquí)
  private sync(b: Baked, m: Mirror, chunks: readonly number[]): boolean {
    const s = b.source, t0 = performance.now(), list: SentChunk[] = [], transfer: Transferable[] = [];
    let ok = true;
    for (const c of chunks) {
      // (la versión de sus vóxeles: un touch, que solo marca para rehornear, no lo vuelve a mandar)
      const v = s.dataVersions[c]!;
      if (m.sent[c] === v) continue;
      const e = s.exportChunkPrepared(c);
      if (!e) { ok = false; break; }
      if (m.sent[c] !== 0) this.stats.resent++;
      list.push({ c, v, ...e });
      m.sent[c] = v;
      transfer.push(e.tops.buffer);
      for (const sl of e.slabs) if (sl) transfer.push(sl.d.buffer, sl.pal.buffer);
    }
    if (list.length) { this.port.postMessage({ kind: 'chunks', id: m.id, list }, transfer); this.stats.chunks += list.length; }
    this.stats.syncMs += performance.now() - t0;
    if (!ok) this.stats.unsendable++;
    return ok;
  }
  private ticket<T extends RectOut | Uint8Array>(): { ticket: number; handle: { result(): T | null; ready(): boolean } } {
    const ticket = ++this.nextTicket, entry = { out: null as RectOut | Uint8Array | null, ready: false };
    this.tickets.set(ticket, entry);
    return { ticket, handle: {
      result: () => {
        if (!entry.ready || !entry.out) return null;
        this.tickets.delete(ticket);
        return entry.out as T;
      },
      ready: () => entry.ready && !!entry.out,
    } };
  }

  private ask(b: Baked, rect: ScreenRect): ReturnType<RemoteRects['ask']> {
    if (this.o.near?.(rect, b)) { this.stats.near++; return null; }
    const m = this.mirror(b);
    // (los trozos que lee: uno que no cabe en la forma de mandar hace que este recuadro se pinte aquí)
    if (!this.sync(b, m, readChunks(b, rect))) return null;
    const { ticket, handle } = this.ticket<RectOut>();
    this.port.postMessage({ kind: 'rect', ticket, id: m.id, gen: m.gen, rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }, brake: this.o.brake ?? 1 });
    this.stats.asked++;
    return handle;
  }

  private askSky(b: Baked, rect: ScreenRect, pick: Float64Array, face: Int8Array): ReturnType<NonNullable<RemoteRects['sky']>> {
    if (this.o.near?.(rect, b)) { this.stats.near++; return null; }
    const m = this.mirror(b);
    if (!this.sync(b, m, skyReadChunks(b, rect))) return null;
    const { ticket, handle } = this.ticket<Uint8Array>();
    this.port.postMessage({ kind: 'sky', ticket, id: m.id, gen: m.gen, pick, face, brake: this.o.brake ?? 1 }, [pick.buffer, face.buffer]);
    this.stats.skies++;
    return handle;
  }

  private mirror(b: Baked): Mirror {
    const s = b.source;
    let m = this.mirrors.get(s);
    if (!m) {
      m = { id: ++this.nextId, source: s, sent: new Uint32Array(s.cols * s.rows), gen: 0, used: 0 };
      const o = b.options;
      this.port.postMessage({ kind: 'mirror', id: m.id, width: s.width, depth: s.depth, zMin: s.zMin, zMax: s.zMax, palette: s.palette,
        bake: { topZ: b.topZ, incline: o.oblique?.y ?? 1, outline: (o.outline ?? 'none') as Outline, ...(o.outlineColor ? { outlineColor: o.outlineColor } : {}), options: JSON.stringify(o) } });
      this.mirrors.set(s, m);
      this.stats.mirrors++;
      const keep = this.o.keep ?? 4;
      while (this.mirrors.size > keep) {
        let old: Mirror | null = null;
        for (const x of this.mirrors.values()) if (x !== m && (!old || x.used < old.used)) old = x;
        if (!old) break;
        this.drop(old);
      }
    }
    m.used = ++this.tick;
    return m;
  }
  private drop(m: Mirror): void {
    this.mirrors.delete(m.source);
    this.port.postMessage({ kind: 'drop', id: m.id });
    this.stats.dropped++;
  }

  // El corrimiento: cada espejo de una fuente viva se corre igual (y lo pedido antes se salta); los de fuentes que ya no
  // están (un giro soltado) se tiran
  private shifted(list: ReadonlyArray<{ source: StaticVoxels; dcx: number; dcy: number }>): void {
    for (const m of [...this.mirrors.values()]) {
      const e = list.find((x) => x.source === m.source);
      if (!e) { this.drop(m); continue; }
      if (!e.dcx && !e.dcy) continue;
      this.port.postMessage({ kind: 'shift', id: m.id, dcx: e.dcx, dcy: e.dcy });
      m.sent = shiftSent(m.sent, m.source.cols, m.source.rows, e.dcx, e.dcy);
      m.gen++;
    }
  }

  private receive(m: FromWorker): void {
    const t = this.tickets.get(m.ticket);
    if (m.kind === 'skip') { this.stats.skipped++; this.tickets.delete(m.ticket); return; }
    if (m.kind === 'sky') this.stats.skyMs += m.ms; else this.stats.got++;
    this.stats.workerMs += m.ms;
    if (!t) return;
    t.out = m.kind === 'sky' ? m.sky : m.o;
    if (this.o.perFrame === undefined) t.ready = true; else this.inbox.push(m.ticket);
  }
}

// El lado del worker. post: cómo contesta (con lo que se transfiere); schedule: cómo deja pasar los mensajes entre dos
// recuadros (setTimeout 0 en el worker; en las pruebas, a mano)
export class BakeWorkerHost {
  private readonly mirrors = new Map<number, { store: StaticVoxels; shell: Baked; gen: number }>();
  private readonly queue: Array<Extract<ToWorker, { kind: 'rect' | 'sky' }>> = [];
  private scheduled = false;
  busyMs = 0;

  constructor(private readonly post: (m: FromWorker, transfer: Transferable[]) => void, private readonly schedule: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); }) {}

  get pending(): number { return this.queue.length; }

  receive(m: ToWorker): void {
    switch (m.kind) {
      case 'mirror': {
        const store = new StaticVoxels(m.palette, m.width, m.depth, m.zMin, m.zMax);
        const shell = bakeWorldJob({ model: store, lights: [], width: m.width, depth: m.depth },
          { topZ: m.bake.topZ, incline: m.bake.incline, outline: m.bake.outline, ...(m.bake.outlineColor ? { outlineColor: m.bake.outlineColor } : {}) }).baked;
        // (las mismas opciones de render que el horneado del principal: si no, lo pintado aquí no sería lo suyo)
        if (JSON.stringify(shell.options) !== m.bake.options) throw new Error(`BakeWorkerHost: opciones distintas del horneado del principal: ${JSON.stringify(shell.options)} / ${m.bake.options}`);
        this.mirrors.set(m.id, { store, shell, gen: 0 });
        break;
      }
      case 'drop': this.mirrors.delete(m.id); break;
      case 'chunks': {
        const x = this.mirrors.get(m.id);
        if (x) for (const ch of m.list) x.store.writeChunkPrepared(ch.c, ch.slabs, ch.tops);
        break;
      }
      case 'shift': {
        const x = this.mirrors.get(m.id);
        if (x) { x.store.shift(m.dcx, m.dcy); x.gen++; }
        break;
      }
      case 'rect':
      case 'sky':
        this.queue.push(m);
        if (!this.scheduled) { this.scheduled = true; this.schedule(() => this.next()); }
        break;
    }
  }

  // Un recuadro por tarea
  next(): void {
    this.scheduled = false;
    const m = this.queue.shift();
    if (m) {
      const x = this.mirrors.get(m.id);
      if (!x || x.gen !== m.gen) this.post({ kind: 'skip', ticket: m.ticket }, []);
      else if (m.kind === 'sky') {
        const a = performance.now(), sky = skyFromPick(x.store, m.pick, m.face), ms = performance.now() - a;
        if (m.brake > 1) { const until = performance.now() + ms * (m.brake - 1); while (performance.now() < until); }
        this.busyMs += performance.now() - a;
        this.post({ kind: 'sky', ticket: m.ticket, sky, ms }, [sky.buffer]);
      } else {
        const a = performance.now(), o = renderRect(x.shell, m.rect), ms = performance.now() - a;
        if (m.brake > 1) { const until = performance.now() + ms * (m.brake - 1); while (performance.now() < until); }
        this.busyMs += performance.now() - a;
        this.post({ kind: 'rect', ticket: m.ticket, o, ms }, [o.rgba.buffer, o.depth.buffer, o.face.buffer, o.pick.buffer]);
      }
    }
    if (this.queue.length && !this.scheduled) { this.scheduled = true; this.schedule(() => this.next()); }
  }
}
