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
import { StaticVoxels, ChunkPackWriter, ChunkPackReader } from './state';
import { bakeWorldJob, renderRect, readChunks, skyFromPick, skyReadChunks, shiftParams, shiftKeys, type Baked, type RectOut, type RemoteRects, type ScreenRect } from './bake';
import type { LiveWindow } from './live';

type Outline = 'none' | 'outer' | 'both';
export interface MirrorBake { topZ: number; incline: number; outline: Outline; outlineColor?: string; options: string }
// (v: su versión en la fuente; el worker no la usa: para contar lo mandado de más)
// (los trozos van empaquetados en buf, uno detrás de otro: at y len, su sitio; ChunkPackWriter)
export type SentChunk = { c: number; v: number; at: number; len: number };
export type ToWorker =
  | { kind: 'mirror'; id: number; width: number; depth: number; zMin: number; zMax: number; palette: Palette; bake: MirrorBake }
  | { kind: 'drop'; id: number }
  | { kind: 'chunks'; id: number; list: SentChunk[]; buf: ArrayBuffer }
  // (y lo que se corre su imagen: el worker traslada lo pedido que tiene en cola, en vez de saltarlo)
  | { kind: 'shift'; id: number; dcx: number; dcy: number; DX: number; rows: number; dk: number }
  // (urgent: va antes que lo no urgente de la cola, en orden entre los urgentes: el núcleo de un giro con fundido)
  | { kind: 'rect'; ticket: number; id: number; gen: number; rect: ScreenRect; brake: number; urgent?: boolean }
  | { kind: 'sky'; ticket: number; id: number; gen: number; pick: Float64Array; face: Int8Array; brake: number; urgent?: boolean }
  // (lo pedido que ya no hace falta: si aún no se empezó, no se pinta)
  | { kind: 'cancel'; ticket: number };
// (gen: los corrimientos de su espejo cuando se pintó; si el principal ya se corrió otra vez, llega en el sitio de antes)
export type FromWorker = { kind: 'rect'; ticket: number; o: RectOut; ms: number; gen: number; first?: FirstInfo } | { kind: 'sky'; ticket: number; sky: Uint8Array; ms: number; gen: number; first?: FirstInfo } | { kind: 'skip'; ticket: number; why: 'shift' | 'mirror' };

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

// Lo pedido y aún no recogido: de qué horneado y qué recuadro (para volver a preguntar near), y lo que llegó
// (m y gen: su espejo y en qué corrimiento de él tiene que llegar; se trasladan con él)
interface Ticket { out: RectOut | Uint8Array | null; ready: boolean; failed: boolean; b: Baked; rect: ScreenRect; sky: boolean; m: Mirror; gen: number }

// Un espejo, visto desde el principal: su fuente, la versión mandada de cada trozo y cuántos corrimientos lleva
// (b: el último horneado de esa fuente que pidió: lo que se corre su imagen al correrse)
interface Mirror { id: number; source: StaticVoxels; sent: Uint32Array; gen: number; used: number; b: Baked; log: MirrorLog }
// Lo que tardó cada espejo en dar su primer recuadro (diagnóstico, BakeWorker.mirrorLog): cuándo se creó, cuándo se mandó
// lo primero pedido, con cuántos trozos y cuánto se tardó en mandarlos hasta entonces, cuándo llegó lo primero, y lo que
// dice el worker de ese primer recuadro (crear su espejo, escribir sus trozos, lo que esperó en la cola)
export interface MirrorLog { id: number; at: number; firstAsk: number; chunksFirst: number; syncMsFirst: number; firstGot: number; worker: FirstInfo | null }
export interface FirstInfo { buildMs: number; chunksMs: number; chunks: number; queuedMs: number; renderMs: number }

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
  readonly stats = { asked: 0, got: 0, skipped: 0, skippedShift: 0, skippedMirror: 0, near: 0, unsendable: 0, chunks: 0, syncMs: 0, workerMs: 0, mirrors: 0, dropped: 0, skies: 0, skyMs: 0,
    // (trozos mandados otra vez porque sus vóxeles cambiaron desde el último envío)
    resent: 0,
    // (lo retirado del worker porque pasó a ser cercano mientras estaba fuera: se pinta aquí sin esperarlo)
    retired: 0, retiredSky: 0,
    // (lo pedido que seguía fuera al correrse la ventana: trasladado; lo que llegó pintado en el sitio de antes, que se hace
    // aquí; y lo descartado que se canceló en el worker)
    moved: 0, movedSky: 0, lateShift: 0, canceled: 0,
    // (lo pedido con prioridad: el núcleo de un giro con fundido)
    urgent: 0,
    // (lo mandado en bytes, y lo más que tardó un envío entero y su postMessage)
    bytes: 0, syncMaxMs: 0, postMaxMs: 0,
    // (veces que el búfer de un envío tuvo que crecer: con el tamaño exacto, 0)
    packGrown: 0 };
  private readonly mirrors = new Map<StaticVoxels, Mirror>();
  // (los últimos 32 espejos creados, con lo que tardó el primero de cada uno)
  readonly mirrorLog: MirrorLog[] = [];
  private readonly tickets = new Map<number, Ticket>();
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
    win.setRemote((b, o) => this.remoteFor(b, !!o?.urgent));
    this.off = () => { offShift(); win.setRemote(null); };
  }
  detach(): void { this.off?.(); this.off = null; }

  // Cada cuadro: entrega hasta perFrame de los llegados
  frame(): void {
    this.retire();
    for (let n = 0; n < (this.o.perFrame ?? Infinity) && this.inbox.length; n++) {
      const t = this.tickets.get(this.inbox.shift()!);
      if (t) t.ready = true;
    }
  }

  // (lo pedido que aún no llegó ni se saltó)
  get outstanding(): number { return this.tickets.size; }

  private remoteFor(b: Baked, urgent = false): RemoteRects { return { ask: (rect) => this.ask(b, rect, urgent), sky: (rect, pick, face) => this.askSky(b, rect, pick, face, urgent), shifts: true }; }

  // Los trozos de `chunks` que el espejo no tiene en su versión de ahora, mandados. false: alguno no cabe en la forma de
  // mandar (lo pedido se hace aquí)
  private sync(b: Baked, m: Mirror, chunks: readonly number[]): boolean {
    const s = b.source, t0 = performance.now(), list: SentChunk[] = [];
    let ok = true, w: ChunkPackWriter | null = null;
    // (primero lo que falta y lo que ocupa: el búfer se reserva de una vez, del tamaño exacto. Al doblarse desde 64 KB, en un
    // juego, publicar lo pedido se llevaba más de la mitad de su tiempo en doblar y copiar)
    const todo: Array<{ c: number; v: number }> = [];
    let size = 0;
    for (const c of chunks) {
      // (la versión de sus vóxeles: un touch, que solo marca para rehornear, no lo vuelve a mandar)
      const v = s.dataVersions[c]!;
      if (m.sent[c] === v) continue;
      const n = s.packedSize(c);
      if (n < 0) { ok = false; break; }
      todo.push({ c, v }); size += n;
    }
    if (todo.length) {
      w = new ChunkPackWriter(size);
      for (const { c, v } of todo) {
        const at = w.n;
        s.packChunk(c, w);
        if (m.sent[c] !== 0) this.stats.resent++;
        list.push({ c, v, at, len: w.n - at });
        m.sent[c] = v;
      }
      this.stats.packGrown += w.grown;
    }
    if (list.length) {
      // (un solo búfer transferido por mensaje: el clon cuesta por búfer)
      const t1 = performance.now();
      this.port.postMessage({ kind: 'chunks', id: m.id, list, buf: w!.buffer }, [w!.buffer]);
      this.stats.chunks += list.length; this.stats.bytes += w!.n;
      this.stats.postMaxMs = Math.max(this.stats.postMaxMs, performance.now() - t1);
    }
    this.stats.syncMs += performance.now() - t0;
    this.stats.syncMaxMs = Math.max(this.stats.syncMaxMs, performance.now() - t0);
    if (m.log.firstAsk < 0) { m.log.chunksFirst += list.length; m.log.syncMsFirst += performance.now() - t0; }
    if (!ok) this.stats.unsendable++;
    return ok;
  }
  private ticket<T extends RectOut | Uint8Array>(b: Baked, rect: ScreenRect, sky: boolean, m: Mirror): { ticket: number; handle: { result(): T | null; ready(): boolean; failed(): boolean; cancel(): void } } {
    const ticket = ++this.nextTicket, entry: Ticket = { out: null, ready: false, failed: false, b, rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }, sky, m, gen: m.gen };
    this.tickets.set(ticket, entry);
    return { ticket, handle: {
      result: () => {
        if (!entry.ready || !entry.out) return null;
        this.tickets.delete(ticket);
        return entry.out as T;
      },
      ready: () => entry.ready && !!entry.out,
      failed: () => entry.failed,
      // (descartado: si aún no llegó, que el worker no lo pinte)
      cancel: () => {
        if (this.tickets.get(ticket) !== entry) return;
        this.tickets.delete(ticket);
        if (!entry.out) { this.port.postMessage({ kind: 'cancel', ticket }); this.stats.canceled++; }
      },
    } };
  }
  // Lo que está fuera y ahora cumple near (entrar bajo tierra, el corte que se mueve): falla (su trabajo lo hace aquí) y
  // se le dice al worker que no lo pinte si aún no empezó
  private retire(): void {
    const near = this.o.near;
    if (!near) return;
    for (const [ticket, t] of this.tickets) {
      // (lo que ya llegó vale: se usa, aunque ahora sea cercano)
      if (t.out || !near(t.rect, t.b)) continue;
      t.failed = true;
      this.tickets.delete(ticket);
      this.port.postMessage({ kind: 'cancel', ticket });
      if (t.sky) this.stats.retiredSky++; else this.stats.retired++;
    }
  }

  private ask(b: Baked, rect: ScreenRect, urgent = false): ReturnType<RemoteRects['ask']> {
    if (this.o.near?.(rect, b)) { this.stats.near++; return null; }
    const m = this.mirror(b);
    // (los trozos que lee: uno que no cabe en la forma de mandar hace que este recuadro se pinte aquí)
    if (!this.sync(b, m, readChunks(b, rect))) return null;
    const { ticket, handle } = this.ticket<RectOut>(b, rect, false, m);
    this.port.postMessage({ kind: 'rect', ticket, id: m.id, gen: m.gen, rect: { x0: rect.x0, y0: rect.y0, x1: rect.x1, y1: rect.y1 }, brake: this.o.brake ?? 1, ...(urgent ? { urgent } : {}) });
    if (urgent) this.stats.urgent++;
    this.stats.asked++;
    if (m.log.firstAsk < 0) m.log.firstAsk = performance.now();
    return handle;
  }

  private askSky(b: Baked, rect: ScreenRect, pick: Float64Array, face: Int8Array, urgent = false): ReturnType<NonNullable<RemoteRects['sky']>> {
    if (this.o.near?.(rect, b)) { this.stats.near++; return null; }
    const m = this.mirror(b);
    if (!this.sync(b, m, skyReadChunks(b, rect))) return null;
    const { ticket, handle } = this.ticket<Uint8Array>(b, rect, true, m);
    this.port.postMessage({ kind: 'sky', ticket, id: m.id, gen: m.gen, pick, face, brake: this.o.brake ?? 1, ...(urgent ? { urgent } : {}) }, [pick.buffer, face.buffer]);
    if (urgent) this.stats.urgent++;
    this.stats.skies++;
    if (m.log.firstAsk < 0) m.log.firstAsk = performance.now();
    return handle;
  }

  private mirror(b: Baked): Mirror {
    const s = b.source;
    let m = this.mirrors.get(s);
    if (!m) {
      m = { id: ++this.nextId, source: s, sent: new Uint32Array(s.cols * s.rows), gen: 0, used: 0, b, log: { id: this.nextId, at: performance.now(), firstAsk: -1, chunksFirst: 0, syncMsFirst: 0, firstGot: -1, worker: null } };
      this.mirrorLog.push(m.log);
      if (this.mirrorLog.length > 32) this.mirrorLog.shift();
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
    m.used = ++this.tick; m.b = b;
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
      const P = shiftParams(m.b, e.dcx, e.dcy);
      this.port.postMessage({ kind: 'shift', id: m.id, dcx: e.dcx, dcy: e.dcy, DX: P.DX, rows: P.rows, dk: P.dk });
      m.sent = shiftSent(m.sent, m.source.cols, m.source.rows, e.dcx, e.dcy);
      // Lo pedido a este espejo: lo que aún no llegó, a su sitio nuevo (el worker hace lo mismo con su cola); lo llegado sin
      // recoger está pintado en el sitio de antes: falla y se hace aquí
      for (const [k, t] of this.tickets) {
        if (t.m !== m) continue;
        if (t.out) { t.out = null; t.failed = true; this.tickets.delete(k); this.stats.lateShift++; continue; }
        t.gen = m.gen + 1;
        t.rect = { x0: t.rect.x0 - P.DX, x1: t.rect.x1 - P.DX, y0: t.rect.y0 + P.rows, y1: t.rect.y1 + P.rows };
        if (t.sky) this.stats.movedSky++; else this.stats.moved++;
      }
      m.gen++;
    }
  }

  private receive(m: FromWorker): void {
    const t = this.tickets.get(m.ticket);
    // (saltado: si alguien aún lo espera, falla y se hace aquí; nada se queda esperando un pedido que no va a llegar)
    if (m.kind === 'skip') { this.stats.skipped++; if (m.why === 'shift') this.stats.skippedShift++; else this.stats.skippedMirror++; if (t) t.failed = true; this.tickets.delete(m.ticket); return; }
    if (m.kind === 'sky') this.stats.skyMs += m.ms; else this.stats.got++;
    this.stats.workerMs += m.ms;
    if (!t) return;
    if (t.m.log.firstGot < 0) { t.m.log.firstGot = performance.now(); t.m.log.worker = m.first ?? null; }
    // (pintado antes de que el worker supiera del último corrimiento: en el sitio de antes; se hace aquí)
    if (m.gen !== t.gen) { t.failed = true; this.tickets.delete(m.ticket); this.stats.lateShift++; return; }
    t.out = m.kind === 'sky' ? m.sky : m.o;
    if (this.o.perFrame === undefined) t.ready = true; else this.inbox.push(m.ticket);
  }
}

// El lado del worker. post: cómo contesta (con lo que se transfiere); schedule: cómo deja pasar los mensajes entre dos
// recuadros (setTimeout 0 en el worker; en las pruebas, a mano)
export class BakeWorkerHost {
  private readonly mirrors = new Map<number, { store: StaticVoxels; shell: Baked; gen: number; first: FirstInfo | null }>();
  private readonly queue: Array<Extract<ToWorker, { kind: 'rect' | 'sky' }>> = [];
  // (cuándo llegó cada pedido, para el diagnóstico del primero de cada espejo)
  private readonly arrived = new Map<number, number>();
  private scheduled = false;
  busyMs = 0;
  // (lo pedido que se retiró antes de empezar a pintarlo; lo que estaba en cola al correrse y se trasladó)
  canceled = 0;
  moved = 0;

  constructor(private readonly post: (m: FromWorker, transfer: Transferable[]) => void, private readonly schedule: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); }) {}

  get pending(): number { return this.queue.length; }

  receive(m: ToWorker): void {
    switch (m.kind) {
      case 'mirror': {
        const a0 = performance.now();
        const store = new StaticVoxels(m.palette, m.width, m.depth, m.zMin, m.zMax);
        const shell = bakeWorldJob({ model: store, lights: [], width: m.width, depth: m.depth },
          { topZ: m.bake.topZ, incline: m.bake.incline, outline: m.bake.outline, ...(m.bake.outlineColor ? { outlineColor: m.bake.outlineColor } : {}) }).baked;
        // (las mismas opciones de render que el horneado del principal: si no, lo pintado aquí no sería lo suyo)
        if (JSON.stringify(shell.options) !== m.bake.options) throw new Error(`BakeWorkerHost: opciones distintas del horneado del principal: ${JSON.stringify(shell.options)} / ${m.bake.options}`);
        this.mirrors.set(m.id, { store, shell, gen: 0, first: { buildMs: performance.now() - a0, chunksMs: 0, chunks: 0, queuedMs: 0, renderMs: 0 } });
        break;
      }
      case 'drop': this.mirrors.delete(m.id); break;
      case 'chunks': {
        const x = this.mirrors.get(m.id);
        const a0 = performance.now();
        if (x) for (const ch of m.list) x.store.unpackChunk(ch.c, new ChunkPackReader(m.buf, ch.at));
        if (x?.first) { x.first.chunksMs += performance.now() - a0; x.first.chunks += m.list.length; }
        break;
      }
      case 'shift': {
        const x = this.mirrors.get(m.id);
        if (!x) break;
        x.store.shift(m.dcx, m.dcy);
        // Lo que tiene en cola de este espejo, a su sitio nuevo, como la imagen: el recuadro; y en un cielo, las claves de
        // vóxel de su pick. Lo que se sale (el principal lo descarta y lo cancela) se queda con el corrimiento de antes: se salta
        for (const q of this.queue) {
          if (q.id !== m.id || q.gen !== x.gen) continue;
          if (q.kind === 'rect') {
            const r = { x0: q.rect.x0 - m.DX, x1: q.rect.x1 - m.DX, y0: q.rect.y0 + m.rows, y1: q.rect.y1 + m.rows };
            if (r.x0 < 0 || r.y0 < 0 || r.x1 >= x.shell.width || r.y1 >= x.shell.height) continue;
            q.rect = r;
          } else if (!shiftKeys(x.shell, q.pick, null, { dk: m.dk, dd: 0 })) continue;
          q.gen = x.gen + 1;
          this.moved++;
        }
        x.gen++;
        break;
      }
      case 'cancel': {
        const k = this.queue.findIndex((q) => q.ticket === m.ticket);
        if (k >= 0) { this.arrived.delete(this.queue[k]!.ticket); this.queue.splice(k, 1); this.canceled++; }
        break;
      }
      case 'rect':
      case 'sky':
        // (lo urgente, detrás del último urgente y delante de lo demás)
        if (m.urgent) { let k = 0; while (k < this.queue.length && this.queue[k]!.urgent) k++; this.queue.splice(k, 0, m); } else this.queue.push(m);
        this.arrived.set(m.ticket, performance.now());
        if (!this.scheduled) { this.scheduled = true; this.schedule(() => this.next()); }
        break;
    }
  }

  // Un recuadro por tarea
  next(): void {
    this.scheduled = false;
    const m = this.queue.shift();
    if (m) {
      const x = this.mirrors.get(m.id), came = this.arrived.get(m.ticket) ?? performance.now();
      this.arrived.delete(m.ticket);
      // (el primero que pinta este espejo lleva lo que tardó: crearlo, sus trozos hasta ahora, lo que esperó en la cola)
      const first = x?.first && x.gen === m.gen ? { ...x.first, queuedMs: performance.now() - came } : undefined;
      if (first) x!.first = null;
      if (!x || x.gen !== m.gen) this.post({ kind: 'skip', ticket: m.ticket, why: x ? 'shift' : 'mirror' }, []);
      else if (m.kind === 'sky') {
        const a = performance.now(), sky = skyFromPick(x.store, m.pick, m.face), ms = performance.now() - a;
        if (m.brake > 1) { const until = performance.now() + ms * (m.brake - 1); while (performance.now() < until); }
        this.busyMs += performance.now() - a;
        this.post({ kind: 'sky', ticket: m.ticket, sky, ms, gen: m.gen, ...(first ? { first: { ...first, renderMs: ms } } : {}) }, [sky.buffer]);
      } else {
        const a = performance.now(), o = renderRect(x.shell, m.rect), ms = performance.now() - a;
        if (m.brake > 1) { const until = performance.now() + ms * (m.brake - 1); while (performance.now() < until); }
        this.busyMs += performance.now() - a;
        this.post({ kind: 'rect', ticket: m.ticket, o, ms, gen: m.gen, ...(first ? { first: { ...first, renderMs: ms } } : {}) }, [o.rgba.buffer, o.depth.buffer, o.face.buffer, o.pick.buffer]);
      }
    }
    if (this.queue.length && !this.scheduled) { this.scheduled = true; this.schedule(() => this.next()); }
  }
}
