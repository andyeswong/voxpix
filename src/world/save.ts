// GUARDAR Y CARGAR: una instantánea del mundo (WorldState.snapshot) a bytes y de vuelta, para guardar una
// partida. El archivo:
//   "VXSNAP" · versión (1 byte) · banderas (1 byte; 1 = diferencia contra una base) · largo del esqueleto (u32) ·
//   el esqueleto en JSON (UTF-8) · los bloques binarios, cada uno: clase (u8), tipo (u8), largo (u32) y sus bytes
// El esqueleto es la instantánea con cada array tipado sustituido por {"$b": n} (su bloque) y los números que JSON no
// guarda (NaN, Infinity) por {"$n": "..."}. Los vóxeles de cada trozo van por LOSAS de 16 x 16 x 16: cada losa distinta
// se guarda una sola vez (un mundo de bloques repite las mismas muchas veces: toda piedra, todo aire) en un diccionario
// comprimido por tramos (RLE de 16 bits), y el trozo es la lista de sus losas: {"$s": [losas], "n": vóxeles}. Con una BASE (la instantánea del mundo recién generado, que el juego
// puede rehacer con su semilla), los trozos iguales a los de la base no se guardan: solo lo que cambió en la partida.
// Enteros en little-endian. Ida y vuelta exacta: restore(decode(encode(s))) da la misma huella. docs/motor.md, "Guardar
// y cargar".
import type { WorldSnapshot } from './state';

const MAGIC = 'VXSNAP';
const VERSION = 1;
const TYPES = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, Uint8ClampedArray] as const;
type Typed = InstanceType<(typeof TYPES)[number]>;
const RAW = 0, RLE16 = 1, BASE = 2, DELTA = 3;   // DELTA: los bytes XOR los de la base, por tramos (RLE de bytes)

function typeId(a: ArrayBufferView): number {
  const i = TYPES.findIndex((T) => a.constructor === T);
  if (i < 0) throw new Error(`no sé guardar un ${a.constructor.name}`);
  return i;
}

// RLE de 16 bits: pares (cuántos - 1, valor), cuántos de 1 a 65536
function rle16(a: Uint16Array): Uint16Array {
  const out: number[] = [];
  for (let i = 0; i < a.length;) {
    const v = a[i]!;
    let j = i + 1;
    while (j < a.length && a[j] === v && j - i < 65536) j++;
    out.push(j - i - 1, v);
    i = j;
  }
  return Uint16Array.from(out);
}
// RLE de bytes: tríos (cuántos - 1 en 16 bits, valor), cuántos de 1 a 65536
function rle8(a: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < a.length;) {
    const v = a[i]!;
    let j = i + 1;
    while (j < a.length && a[j] === v && j - i < 65536) j++;
    const k = j - i - 1;
    out.push(k & 255, k >> 8, v);
    i = j;
  }
  return Uint8Array.from(out);
}
function unrle8(r: Uint8Array, out: Uint8Array): void {
  let o = 0;
  for (let i = 0; i < r.length; i += 3) { const k = (r[i]! | (r[i + 1]! << 8)) + 1; out.fill(r[i + 2]!, o, o + k); o += k; }
  if (o !== out.length) throw new Error('instantánea dañada: una diferencia no cuadra con la base');
}
const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
// Lo que hay en la base en el mismo sitio de la instantánea (path con puntos)
function at(base: unknown, path: string): unknown {
  let v = base;
  for (const k of path.split('.')) { if (v === null || typeof v !== 'object') return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
}

function unrle16(r: Uint16Array, n: number): Uint16Array {
  const out = new Uint16Array(n);
  let o = 0;
  for (let i = 0; i < r.length; i += 2) { const k = r[i]! + 1; out.fill(r[i + 1]!, o, o + k); o += k; }
  if (o !== n) throw new Error(`instantánea dañada: un trozo da ${o} vóxeles y deberían ser ${n}`);
  return out;
}

// ¿Los mismos bytes? (sin Buffer: también en el navegador)
function same(a: ArrayBufferView, b: ArrayBufferView | null | undefined): boolean {
  if (!b || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

// La instantánea a bytes. base (opcional): la del mundo de partida; lo igual a lo suyo no se guarda y lo parecido va
// como diferencia. Si así ocupara más que entera (una partida muy larga), va entera
export function encodeSnapshot(s: WorldSnapshot, base?: WorldSnapshot): Uint8Array {
  const whole = encode(s);
  if (!base) return whole;
  const diff = encode(s, base);
  return diff.length < whole.length ? diff : whole;
}

function encode(s: WorldSnapshot, base?: WorldSnapshot): Uint8Array {
  const blobs: Array<{ kind: number; type: number; bytes: Uint8Array }> = [];
  // El diccionario de losas: cada una, sus valores; por huella, las que la tienen (para las colisiones)
  const dict: Uint16Array[] = [], byHash = new Map<number, number[]>();
  const slabId = (a: Uint16Array): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i]!, 16777619);
    const list = byHash.get(h);
    if (list) for (const id of list) { const d = dict[id]!; if (d.length === a.length && same(d, a)) return id; }
    dict.push(a.slice());
    if (list) list.push(dict.length - 1); else byHash.set(h, [dict.length - 1]);
    return dict.length - 1;
  };
  const SLAB = 16 * 16 * 16;
  const blob = (a: ArrayBufferView, path: string): { $b: number } => {
    const type = typeId(a);
    let kind = RAW, bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const was = base ? at(base, path) : undefined;
    if (ArrayBuffer.isView(was) && same(a, was)) { kind = BASE; bytes = new Uint8Array(0); }
    else if (ArrayBuffer.isView(was) && was.constructor === a.constructor && was.byteLength === a.byteLength) {
      const x = bytesOf(a), y = bytesOf(was), d = new Uint8Array(x.length);
      for (let i = 0; i < x.length; i++) d[i] = x[i]! ^ y[i]!;
      const r = rle8(d);
      if (r.length < x.length) { kind = DELTA; bytes = r; }
    }
    if (kind === RAW && a instanceof Uint16Array) {
      const r = rle16(a);
      if (r.byteLength + 4 < a.byteLength) {
        kind = RLE16;
        bytes = new Uint8Array(4 + r.byteLength);
        new DataView(bytes.buffer).setUint32(0, a.length, true);
        bytes.set(new Uint8Array(r.buffer), 4);
      }
    }
    blobs.push({ kind, type, bytes });
    return { $b: blobs.length - 1 };
  };
  const walk = (v: unknown, path: string): unknown => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $n: String(v) };
    if (v === null || typeof v !== 'object') return v;
    if (ArrayBuffer.isView(v)) {
      const m = /^chunks\.(\d+)\.data$/.exec(path);
      const was = base ? at(base, path) : undefined;
      if (m && v instanceof Uint16Array && !(ArrayBuffer.isView(was) && was.byteLength === v.byteLength)) {
        const ids: number[] = [];
        for (let o = 0; o < v.length; o += SLAB) ids.push(slabId(v.subarray(o, Math.min(v.length, o + SLAB))));
        return { $s: ids, n: v.length };
      }
      return blob(v, path);
    }
    if (v instanceof Map || v instanceof Set) throw new Error(`no sé guardar un ${v.constructor.name} (en ${path})`);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`));
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = walk(x, path ? `${path}.${k}` : k);
    return o;
  };
  const tree = walk(s, '') as Record<string, unknown>;
  // El diccionario, todo seguido, como un bloque más (comprimido si sale a cuenta); y cuánto mide cada losa
  let total = 0;
  for (const d of dict) total += d.length;
  const all = new Uint16Array(total);
  let off = 0;
  for (const d of dict) { all.set(d, off); off += d.length; }
  tree.$dict = { data: blob(all, '$dict'), sizes: dict.map((d) => d.length) };
  const skel = new TextEncoder().encode(JSON.stringify(tree));
  let n = MAGIC.length + 2 + 4 + skel.length;
  for (const b of blobs) n += 6 + b.bytes.length;
  const out = new Uint8Array(n), dv = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < MAGIC.length; i++) out[o++] = MAGIC.charCodeAt(i);
  out[o++] = VERSION; out[o++] = base ? 1 : 0;
  dv.setUint32(o, skel.length, true); o += 4;
  out.set(skel, o); o += skel.length;
  for (const b of blobs) {
    out[o++] = b.kind; out[o++] = b.type;
    dv.setUint32(o, b.bytes.length, true); o += 4;
    out.set(b.bytes, o); o += b.bytes.length;
  }
  return out;
}

// De bytes a instantánea (para WorldState.restore). Si se guardó contra una base, hace falta la misma base
export function decodeSnapshot(bytes: Uint8Array, base?: WorldSnapshot): WorldSnapshot {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[o++] !== MAGIC.charCodeAt(i)) throw new Error('no es una instantánea de VoxPix');
  const version = bytes[o++]!, flags = bytes[o++]!;
  if (version !== VERSION) throw new Error(`instantánea de la versión ${version}; esta sabe leer la ${VERSION}`);
  if (flags & 1 && !base) throw new Error('la instantánea se guardó contra una base (el mundo de partida): hay que dársela');
  const sl = dv.getUint32(o, true); o += 4;
  const skel = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + sl))); o += sl;
  const blobs: Array<{ kind: number; type: number; bytes: Uint8Array }> = [];
  while (o < bytes.length) {
    const kind = bytes[o++]!, type = bytes[o++]!, len = dv.getUint32(o, true); o += 4;
    blobs.push({ kind, type, bytes: bytes.subarray(o, o + len) }); o += len;
  }
  const typed = (b: { kind: number; type: number; bytes: Uint8Array }, path: string): Typed => {
    const T = TYPES[b.type];
    if (!T) throw new Error(`instantánea dañada: tipo ${b.type}`);
    if (b.kind === RAW) { const c = b.bytes.slice(); return new T(c.buffer, 0, c.byteLength / T.BYTES_PER_ELEMENT) as Typed; }
    if (b.kind === RLE16) {
      const n = new DataView(b.bytes.buffer, b.bytes.byteOffset).getUint32(0, true), r = b.bytes.slice(4);
      return unrle16(new Uint16Array(r.buffer, 0, r.byteLength / 2), n) as Typed;
    }
    if (b.kind === BASE || b.kind === DELTA) {
      const was = at(base, path);
      if (!ArrayBuffer.isView(was) || was.constructor !== T) throw new Error(`la base no tiene ${path}: no es la base con la que se guardó`);
      const out = bytesOf(was).slice();
      if (b.kind === DELTA) { const d = new Uint8Array(out.length); unrle8(b.bytes, d); for (let i = 0; i < out.length; i++) out[i]! ^= d[i]!; }
      return new T(out.buffer, 0, out.byteLength / T.BYTES_PER_ELEMENT) as Typed;
    }
    throw new Error(`instantánea dañada: clase de bloque ${b.kind}`);
  };
  // El diccionario de losas
  const dj = (skel as Record<string, unknown>).$dict as { data: { $b: number }; sizes: number[] } | undefined;
  const slabs: Uint16Array[] = [];
  if (dj) {
    const all = typed(blobs[dj.data.$b]!, '$dict') as Uint16Array;
    let off = 0;
    for (const n of dj.sizes) { slabs.push(all.subarray(off, off + n)); off += n; }
  }
  delete (skel as Record<string, unknown>).$dict;
  const walk = (v: unknown, path: string): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}.${i}`));
    const r = v as Record<string, unknown>;
    if ('$b' in r) return typed(blobs[r.$b as number]!, path);
    if ('$s' in r) {
      const out = new Uint16Array(r.n as number);
      let o2 = 0;
      for (const id of r.$s as number[]) { const sl = slabs[id]; if (!sl) throw new Error(`instantánea dañada: no hay losa ${id}`); out.set(sl, o2); o2 += sl.length; }
      if (o2 !== out.length) throw new Error(`instantánea dañada: un trozo da ${o2} vóxeles y deberían ser ${out.length}`);
      return out;
    }
    if ('$n' in r) return Number(r.$n);
    const o2: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(r)) o2[k] = walk(x, path ? `${path}.${k}` : k);
    return o2;
  };
  return walk(skel, '') as WorldSnapshot;
}
