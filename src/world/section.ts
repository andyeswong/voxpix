// CORTE AL COMPONER (capa de sección): ver de perfil lo que hay detrás del objetivo, sin rehornear. Una caja de la
// imagen horneada (columnas [x0, x1] x [y0, y1], de zMin hacia arriba; y1 es la fila del objetivo y y0 la del lado de
// la cámara) se trata como aire al componer: los píxeles cuya primera superficie horneada cae dentro de la caja se
// sustituyen por lo que se ve detrás, pintado al momento con el mismo render que el horneado. Lo de detrás nunca se
// horneó (lo tapaba lo de delante), así que no se puede sacar de la imagen.
//   const layer = sectionLayer(baked, { x0, x1, y0, y1, zMin });      // o Frame2DOptions.section con la caja
// Lo que se pinta: el suelo que queda dentro de la caja (las caras de arriba de z = zMin - 1) y, detrás de la fila y1,
// `depth` filas (por defecto 32: el rayo de esta proyección baja 0,5 por cada vóxel hacia el fondo y en un túnel choca
// enseguida). Un píxel cuyo rayo no da con nada en ese tramo queda de fondo (no pasa bajo tierra).
// En qué difiere del corte horneado (WorldView.setCut + rehorneado): la luz de las luces fijas en los píxeles de la
// sección llega sin sombras (como la de las dinámicas), y el tono (AO) de los vóxeles horneados que tocan la caja es
// el de antes de cortar. El cielo de cueva y el contorno de la costura sí son los del corte.
import { render, unkey, decode, innerGapFor, rgbOf, type VoxelSource, DIR_VECTORS } from '../core';
import { SKY_RAYS, SKY_REACH, type Baked } from './bake';
import type { FaceSet } from './state';
import { frontFaces } from '../core';

export interface SectionCut { x0: number; x1: number; y0: number; y1: number; zMin: number; depth?: number }

export interface SectionLayer {
  readonly x: number; readonly y: number; readonly w: number; readonly h: number;   // el recuadro en la imagen horneada
  // 1: el píxel se sustituye (su primera superficie horneada está en la caja); 2: borde, un píxel horneado junto a uno
  // sustituido, que se repinta con su mismo vóxel (su contorno y su tono cambian con el corte) y guarda su luz horneada
  readonly mask: Uint8Array;
  readonly rgba: Uint8ClampedArray;     // lo de detrás (con el contorno de la costura); alfa 0: nada (fondo)
  readonly depth: Float32Array;
  readonly face: Int8Array;
  readonly pick: Float64Array;
  readonly sky: Uint8Array | null;      // rayos de cielo por píxel (si el horneado tiene cielo)
  readonly count: number;               // píxeles sustituidos (los de borde no cuentan)
}

const SKY_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

// cols (opcional): solo esas columnas de vóxeles (x0..x1) del recuadro, con la caja del corte tal cual (puede ser más
// ancha que ellas): así se pinta una sección por franjas (SectionPainter). Sin cols, las de la caja con 1 de margen
// Los rayos de cielo (como skyOf del horneado) de la cara `f` del vóxel `k`, con la caja [X0, X1] x [Y0, Y1] desde zMin
// cortada
function cutSky(b: Baked, X0: number, X1: number, Y0: number, Y1: number, zMin: number, k: number, f: number): number {
  if (Number.isNaN(k) || f < 0) return SKY_RAYS;
  const s = b.source;
  const inBox = (x: number, y: number, z: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && z >= zMin;
  const colTop = (x: number, y: number) => {
    let t = s.height[y * s.width + x]!;
    if (x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && t > zMin) { t = zMin; while (t > s.zMin && !s.get(x, y, t - 1)) t--; }
    return t;
  };
  const [vx, vy, vz] = unkey(k), n = DIR_VECTORS[f]!;
  const cx = vx + n[0], cy = vy + n[1], cz = vz + n[2];
  let open = 0;
  if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth || colTop(cx, cy) <= cz) open++;
  for (const [dx, dy] of SKY_DIRS) {
    let clear = true;
    for (let q = 1; q <= SKY_REACH; q++) {
      const x = cx + dx * q, y = cy + dy * q, z = cz + q;
      if (x < 0 || y < 0 || x >= s.width || y >= s.depth || z > s.zMax) break;
      if (!inBox(x, y, z) && s.get(x, y, z)) { clear = false; break; }
      if (q === SKY_REACH && colTop(x, y) > z) clear = false;
    }
    if (clear) open++;
  }
  return open;
}

export function sectionLayer(b: Baked, cut: SectionCut, cols?: { x0: number; x1: number }): SectionLayer | null {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY, ox = b.options.originX ?? 0;
  const depthBack = cut.depth ?? 32;
  const X0 = Math.max(0, cut.x0), X1 = Math.min(s.width - 1, cut.x1), Y0 = Math.max(0, cut.y0), Y1 = Math.min(s.depth - 1, cut.y1);
  if (X0 > X1 || Y0 > Y1) return null;
  const zMin = cut.zMin, top = s.zMax;
  const inBox = (x: number, y: number, z: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && z >= zMin;
  // El recuadro: donde cae la caja (lo que se sustituye solo puede estar ahí), con 1 de margen; o las columnas pedidas
  const rx = Math.max(0, cols ? Math.floor(ox + cols.x0) : Math.floor(ox + X0) - 1), rx1 = Math.min(b.width - 1, cols ? Math.ceil(ox + cols.x1) : Math.ceil(ox + X1 + 1) + 1);
  const ry = Math.max(0, Math.floor(O - a * (Y1 + 1) - (top + 1)) - 1), ry1 = Math.min(b.height - 1, Math.ceil(O - a * Y0 - zMin) + 1);
  if (rx > rx1 || ry > ry1) return null;
  const w = rx1 - rx + 1, h = ry1 - ry + 1;
  // Qué píxeles se sustituyen
  const mask = new Uint8Array(w * h);
  let count = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = b.pick[(ry + j) * b.width + rx + i]!;
    if (Number.isNaN(k)) continue;
    const [x, y, z] = unkey(k);
    if (inBox(x, y, z)) { mask[j * w + i] = 1; count++; }
  }
  if (!count) return null;
  // El borde: los píxeles horneados junto a uno sustituido. Se repintan con su vóxel (el mismo) con el mundo cortado
  const border: Array<[number, number, number]> = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (mask[j * w + i]) continue;
    let near = false;
    for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const ni = i + di, nj = j + dj;
      if (ni >= 0 && nj >= 0 && ni < w && nj < h && mask[nj * w + ni] === 1) { near = true; break; }
    }
    if (!near) continue;
    const k = b.pick[(ry + j) * b.width + rx + i]!;
    if (Number.isNaN(k)) continue;
    mask[j * w + i] = 2;
    border.push(unkey(k));
  }
  // El mundo cortado, solo lo que se puede ver: lo expuesto de siempre detrás de la caja (con las caras que pinta el
  // render), y lo que el corte destapa (la cara sur de la fila y1 + 1 y la de arriba del suelo de la caja)
  const get = (x: number, y: number, z: number) => (inBox(x, y, z) ? 0 : s.get(x, y, z));
  const faces: FaceSet = frontFaces(b.options);
  // (con cols, lo de la caja solo en esas columnas y su vecina)
  const cx0 = Math.max(X0, rx - ox - 1), cx1 = Math.min(X1, rx1 - ox + 1);
  const bx0 = Math.max(X0 - 1, rx - ox - 1), bx1 = Math.min(X1 + 1, rx1 - ox + 1), zLo = Math.max(s.zMin, zMin - Math.ceil(depthBack * a) - 2);
  const src: VoxelSource = {
    palette: s.palette,
    get,
    entries: () => { throw new Error('la sección se recorre con forEachExposed'); },
    forEachExposed: (fn) => {
      // Detrás: lo expuesto del mundo (no cambia con el corte, salvo la fila pegada a la caja, que va aparte)
      s.forEachExposed((x, y, z, v) => { if (!(y === Y1 + 1 && x >= cx0 && x <= cx1 && z >= zMin)) fn(x, y, z, v); },
        { x0: bx0, y0: Y1 + 1, x1: bx1, y1: Math.min(s.depth - 1, Y1 + depthBack), z0: zLo, z1: top }, true, faces);
      // La fila de detrás de la caja, con su cara sur destapada
      if (Y1 + 1 < s.depth) for (let z = zMin; z <= top; z++) for (let x = cx0; x <= cx1; x++) { const v = s.get(x, Y1 + 1, z); if (v) fn(x, Y1 + 1, z, v); }
      // El suelo de la caja (sus caras de arriba destapadas) y los lados de la caja por debajo de zMin
      for (let y = Y0; y <= Y1; y++) for (let x = bx0; x <= bx1; x++) for (let z = Math.max(s.zMin, zMin - 2); z < zMin; z++) { const v = s.get(x, y, z); if (v) fn(x, y, z, v); }
      // Los vóxeles de los píxeles del borde
      for (const [x, y, z] of border) { const v = get(x, y, z); if (v) fn(x, y, z, v); }
    },
  };
  const img = render(src, { ...b.options, width: w, height: h, originX: ox - rx, originY: O - ry, outline: b.options.outline === 'both' ? 'both' : 'none' });
  // La costura: un píxel de la sección junto a uno horneado (no sustituido) mucho más cerca lleva contorno, como en el
  // corte horneado (el contorno interior marca el píxel lejano de un salto de profundidad)
  const rgba = img.rgba, depth = img.depth, face = img.pickFace!, pick = img.pickKey!;
  if (b.options.outline === 'both') {
    const gap = b.options.innerGap ?? innerGapFor(b.options), fixed = b.options.outlineColor ? rgbOf(b.options.outlineColor) : null;
    const out: number[] = [];
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const t = j * w + i;
      if (!mask[t] || depth[t] === Infinity) continue;
      for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
        const ni = i + di, nj = j + dj, gx = rx + ni, gy = ry + nj;
        if (gx < 0 || gy < 0 || gx >= b.width || gy >= b.height) continue;
        // Los vecinos repintados ya los mira el render (su contorno interior); aquí, los horneados de fuera
        if (ni >= 0 && nj >= 0 && ni < w && nj < h && mask[nj * w + ni]) continue;
        const nd = b.depth[gy * b.width + gx]!;
        if (nd < depth[t]! - gap) { out.push(t); break; }
      }
    }
    for (const t of out) {
      let c: readonly [number, number, number];
      if (fixed) c = fixed;
      else { const [x, y, z] = unkey(pick[t]!), { ramp } = decode(get(x, y, z)); c = rgbOf(s.palette.ramps[ramp]?.colors[0] ?? '#000000'); }
      rgba[t * 4] = c[0]; rgba[t * 4 + 1] = c[1]; rgba[t * 4 + 2] = c[2]; rgba[t * 4 + 3] = 255;
    }
  }
  // El cielo de cueva de cada píxel de la sección, con el mundo cortado (como skyOf del horneado)
  let sky: Uint8Array | null = null;
  if (b.sky) {
    sky = new Uint8Array(w * h);
    for (let q = 0; q < w * h; q++) if (mask[q]) sky[q] = cutSky(b, X0, X1, Y0, Y1, zMin, pick[q]!, face[q]!);
  }
  return { x: rx, y: ry, w, h, mask, rgba, depth, face, pick, sky, count };
}

// La caja del corte para un objetivo en (x, y, z) del MUNDO (los pies de un cuerpo): `width` vóxeles de ancho centrados
// en él, de su fila hasta el borde del lado de la cámara, de sus pies hacia arriba; en los ejes de la vista girada
// (WorldView.camera; sin girar, null): ahí "hacia la cámara" es siempre -y
export function sectionAround(camera: { pointToView(x: number, y: number): [number, number] } | null, x: number, y: number, z: number, width: number, depth?: number): SectionCut {
  const [vx, vy] = camera ? camera.pointToView(x, y) : [x, y];
  const x0 = Math.floor(vx - width / 2);
  return { x0, x1: x0 + Math.max(1, Math.round(width)) - 1, y0: 0, y1: Math.floor(vy), zMin: Math.round(z), ...(depth !== undefined ? { depth } : {}) };
}

// ---- La sección por franjas, pintada por delante (para seguir a un objetivo que anda sin repintarla en cada cuadro)
// Las columnas se pintan por franjas de STRIP con la caja "ancha" (todas las columnas cortadas: el píxel de una columna
// solo depende de las de al lado por su tono y su cielo), una vez, como trabajo de la cola con plazo; al componer la
// caja de cada cuadro (por franjas enteras) solo se copian. En la columna de cada borde de la caja, el tono (AO) y,
// hasta SKY_REACH columnas hacia dentro, el cielo de cueva son los de un corte que siguiera (lo mide la prueba); el
// contorno de la costura en los bordes sí es el del corte. Una franja caduca si se rehornea algo en sus columnas, y
// todas si cambian la fila del objetivo, sus pies o y0.
export const STRIP = 8;     // la caja se mueve por franjas de STRIP columnas
export const UNIT = 4;      // y se pinta de UNIT en UNIT (un paso de la cola: unos 1,6 ms sin freno)

interface Raw {
  rx: number; w: number; h: number; ry: number;
  mask: Uint8Array; rgba: Uint8ClampedArray; depth: Float32Array; face: Int8Array; pick: Float64Array; sky: Uint8Array | null;
  units: Map<number, SectionLayer | null>;     // las unidades copiadas (la capa de cada una, para saber si sigue siendo esa)
  edges: [number, number];                     // las columnas de píxeles de los bordes de la caja (llevan los arreglos)
}
type CopySource = { x?: number; rx?: number; w: number; mask: Uint8Array; rgba: Uint8ClampedArray; depth: Float32Array; face: Int8Array; pick: Float64Array; sky: Uint8Array | null };

// Columnas sin sección
function clearCols(to: Raw, gx0: number, gx1: number): void {
  for (let j = 0; j < to.h; j++) {
    const a = j * to.w + gx0 - to.rx, z = a + gx1 - gx0 + 1;
    to.mask.fill(0, a, z); to.rgba.fill(0, a * 4, z * 4); to.depth.fill(Infinity, a, z); to.face.fill(-1, a, z); to.pick.fill(NaN, a, z);
    if (to.sky) to.sky.fill(0, a, z);
  }
}

// Los píxeles sustituidos de las UNIT columnas de una unidad (desde la columna de píxeles gx), una vez por capa
const UNIT_COUNT = new WeakMap<SectionLayer, number>();
function unitCount(L: SectionLayer, gx: number): number {
  let n = UNIT_COUNT.get(L);
  if (n !== undefined) return n;
  n = 0;
  for (let j = 0; j < L.h; j++) for (let k = gx - L.x; k < gx - L.x + UNIT; k++) if (k >= 0 && k < L.w && L.mask[j * L.w + k] === 1) n++;
  UNIT_COUNT.set(L, n);
  return n;
}

// Copia las columnas de píxeles gx0..gx1 (globales) de una capa a otra con las mismas filas, una copia por fila y array
function copyCols(from: CopySource, to: Raw, gx0: number, gx1: number): void {
  const fx = from.x ?? from.rx!, n = gx1 - gx0 + 1, fw = from.w, tw = to.w;
  void tw;
  for (let j = 0; j < to.h; j++) {
    const fq = j * fw + gx0 - fx, tq = j * to.w + gx0 - to.rx;
    to.mask.set(from.mask.subarray(fq, fq + n), tq);
    to.rgba.set(from.rgba.subarray(fq * 4, (fq + n) * 4), tq * 4);
    to.depth.set(from.depth.subarray(fq, fq + n), tq);
    to.face.set(from.face.subarray(fq, fq + n), tq);
    to.pick.set(from.pick.subarray(fq, fq + n), tq);
    if (to.sky && from.sky) to.sky.set(from.sky.subarray(fq, fq + n), tq);
  }
}

export class SectionPainter {
  private strips = new Map<number, { layer: SectionLayer | null; serial: number }>();
  private track = '';
  private cut: SectionCut | null = null;
  private dir = 0;
  private composed: { key: string; layer: SectionLayer | null } | null = null;
  // Lo copiado de las unidades para la caja de ahora, sin los arreglos de los bordes (se lleva al mover la caja)
  private raw: Raw | null = null;
  private spare: Raw | null = null;
  // El cielo de cueva de las columnas junto a cada borde de la caja, por posición de la caja (se adelanta en la cola)
  private edgeSkies = new Map<string, Uint8Array>();
  private edgeSerial = -1;
  // Franjas que se pintan por delante (en la dirección en que anda) y por detrás
  ahead: number;
  behind: number;
  // Franjas pintadas (para medir)
  painted = 0;

  constructor(readonly b: Baked, opts: { ahead?: number; behind?: number } = {}) {
    this.ahead = opts.ahead ?? 4; this.behind = opts.behind ?? 1;
  }

  // La caja de este cuadro (o null: sin corte) y hacia dónde anda en x de la vista (-1, 0, 1). La caja se lleva a
  // franjas enteras (las que toca)
  set(cut: SectionCut | null, dir = 0): void {
    this.dir = dir;
    if (!cut) { this.cut = null; return; }
    const x0 = Math.floor(cut.x0 / STRIP) * STRIP, x1 = Math.floor(cut.x1 / STRIP) * STRIP + STRIP - 1;
    this.cut = { ...cut, x0, x1 };
    const track = `${cut.y0},${cut.y1},${cut.zMin},${cut.depth ?? ''}`;
    if (track !== this.track) { this.track = track; this.strips.clear(); this.composed = null; this.raw = null; this.edgeSkies.clear(); }
  }

  // ¿La franja i está pintada y al día con la imagen?
  private fresh(i: number): boolean {
    const st = this.strips.get(i);
    if (!st) return false;
    const pub = this.b.published;
    if (pub.serial === st.serial) return true;
    const oldest = pub.rects.length ? pub.rects[0]!.serial : pub.serial;
    if (st.serial < oldest - 1) return false;                             // ya no se sabe qué cambió
    // Lo que pinta una unidad depende de sus columnas y, por el tono y el cielo, de SKY_REACH + 1 a cada lado
    const ox = this.b.options.originX ?? 0, m = SKY_REACH + 1, x0 = ox + i * UNIT, x1 = x0 + UNIT - 1;
    for (const r of pub.rects) if (r.serial > st.serial && r.x1 >= x0 - m && r.x0 <= x1 + m) return false;
    st.serial = pub.serial;
    return true;
  }

  // Las franjas que faltan, en orden: las de la caja (de la del centro hacia fuera), las de delante y las de detrás
  private wanted(): number[] {
    const c = this.cut;
    if (!c) return [];
    // (en unidades de UNIT columnas; ahead y behind van en franjas)
    const per = STRIP / UNIT, i0 = c.x0 / UNIT, i1 = (c.x1 + 1) / UNIT - 1, mid = Math.floor((i0 + i1) / 2), out: number[] = [];
    for (let d = 0; mid - d >= i0 || mid + d <= i1; d++) { if (mid + d <= i1) out.push(mid + d); if (d && mid - d >= i0) out.push(mid - d); }
    const fwd = this.dir >= 0 ? 1 : -1;
    for (let k = 1; k <= this.ahead * per; k++) out.push(fwd > 0 ? i1 + k : i0 - k);
    for (let k = 1; k <= this.behind * per; k++) out.push(fwd > 0 ? i0 - k : i1 + k);
    const maxI = Math.floor((this.b.source.width - 1) / UNIT);
    return out.filter((i) => i >= 0 && i <= maxI && !this.fresh(i));
  }

  // Un trabajo de la cola: pinta franjas hasta el plazo (una por lo menos). null si no falta ninguna
  // (y, si ya están todas, el cielo de los bordes de la caja siguiente en la dirección en que anda). Con slack (ms que
  // le quedan al cuadro sin el trabajo), un paso solo empieza si cabe entero: un paso cuesta lo que el último
  job(): { key: string; priority: number; run(deadline: number): boolean } | null {
    if (!this.wanted().length && !this.nextEdge()) return null;
    return { key: 'section', priority: 0, run: (deadline: number) => {
      for (let first = true; ; first = false) {
        const now = performance.now();
        if (!first && now + this.stepMs > deadline) break;
        const i = this.wanted()[0];
        if (i !== undefined) { this.paint(i); this.stepMs = performance.now() - now; continue; }
        const e = this.nextEdge();
        if (!e) return true;
        this.edgeSky(e.c, e.side, e.ry, e.h);
        if (performance.now() >= deadline) break;
      }
      return !this.wanted().length && !this.nextEdge();
    } };
  }

  // Lo que costó el último paso de pintado (ms, sin freno): para no empezar uno que no cabe
  stepMs = 0;

  // El primer cielo de borde que falta de la caja de ahora o de la siguiente (con sus unidades pintadas)
  private nextEdge(): { c: SectionCut; side: 0 | 1; ry: number; h: number } | null {
    const c = this.cut;
    if (!c) return null;
    const fwd = this.dir >= 0 ? STRIP : -STRIP;
    const rows = this.rows(c);
    if (!rows) return null;
    for (const box of [c, { ...c, x0: c.x0 + fwd, x1: c.x1 + fwd }]) for (const side of [0, 1] as const) {
      if (this.edgeSkies.has(this.edgeKey(box, side))) continue;
      const e0 = side ? box.x1 - SKY_REACH : box.x0, e1 = side ? box.x1 : box.x0 + SKY_REACH;
      let ok = e0 >= 0 && e1 < this.b.source.width;
      for (let i = Math.floor(e0 / UNIT); ok && i <= Math.floor(e1 / UNIT); i++) ok = this.fresh(i);
      if (ok) return { c: box, side, ry: rows.ry, h: rows.h };
    }
    return null;
  }

  private rows(c: SectionCut): { ry: number; h: number } | null {
    for (const st of this.strips.values()) if (st.layer) return { ry: st.layer.y, h: st.layer.h };
    void c;
    return null;
  }

  private edgeKey(c: SectionCut, side: 0 | 1): string { return `${side}:${c.x0},${c.x1}`; }

  // El cielo de las SKY_REACH + 1 columnas del borde `side` (0 el izquierdo, 1 el derecho) de la caja c, con la caja de
  // verdad (las unidades lo hicieron con la ancha, que deja ver cielo de lado). 255: sin píxel de la sección
  private edgeSky(c: SectionCut, side: 0 | 1, ry: number, h: number): Uint8Array {
    if (this.edgeSerial !== this.b.published.serial) { this.edgeSkies.clear(); this.edgeSerial = this.b.published.serial; }
    const key = this.edgeKey(c, side);
    let out = this.edgeSkies.get(key);
    if (out) return out;
    const b = this.b, m = SKY_REACH + 1, X0 = Math.max(0, c.x0), X1 = Math.min(b.source.width - 1, c.x1);
    const Y0 = Math.max(0, c.y0), Y1 = Math.min(b.source.depth - 1, c.y1);
    out = new Uint8Array(m * h).fill(255);
    for (let k = 0; k < m; k++) {
      const x = side ? c.x1 - k : c.x0 + k, st = this.strips.get(Math.floor(x / UNIT))?.layer;
      if (!st || !this.fresh(Math.floor(x / UNIT))) continue;
      const sk = (b.options.originX ?? 0) + x - st.x;
      for (let j = 0; j < h; j++) {
        const sq = j * st.w + sk;
        if (st.mask[sq]) out[j * m + k] = cutSky(b, X0, X1, Y0, Y1, c.zMin, st.pick[sq]!, st.face[sq]!);
      }
    }
    this.edgeSkies.set(key, out);
    return out;
  }

  // ¿Están pintadas (y al día) todas las franjas de la caja de ahora? Si no, en esas columnas aún no se ve la sección
  ready(): boolean {
    const c = this.cut;
    if (!c) return true;
    for (let i = c.x0 / UNIT; i <= (c.x1 + 1) / UNIT - 1; i++) if (i >= 0 && i * UNIT < this.b.source.width && !this.fresh(i)) return false;
    return true;
  }

  // Pinta ya todas las que faltan (para probar y medir)
  paintAll(): void { for (let i = this.wanted()[0]; i !== undefined; i = this.wanted()[0]) this.paint(i); }

  private paint(i: number): void {
    const c = this.cut!;
    const wide: SectionCut = { ...c, x0: -1e9, x1: 1e9 };
    // Con una columna de margen a cada lado (el contorno, el borde y la costura miran a los vecinos); se copian sus 8
    this.strips.set(i, { layer: sectionLayer(this.b, wide, { x0: i * UNIT - 1, x1: i * UNIT + UNIT }), serial: this.b.published.serial });
    this.painted++;
  }

  // La capa de la caja de ahora, con lo que ya está pintado (las franjas que falten, sin sustituir todavía)
  layer(): SectionLayer | null {
    const c = this.cut;
    if (!c) return null;
    const i0 = c.x0 / UNIT, i1 = (c.x1 + 1) / UNIT - 1;
    let ready = '';
    for (let i = i0; i <= i1; i++) ready += this.fresh(i) ? '1' : '0';
    const key = `${c.x0},${c.x1}:${ready}:${this.b.published.serial}`;
    if (this.composed && this.composed.key === key) return this.composed.layer;
    const layer = this.compose(c);
    this.composed = { key, layer };
    return layer;
  }

  private compose(c: SectionCut): SectionLayer | null {
    const b = this.b, ox = b.options.originX ?? 0;
    const rows = this.rows(c);
    if (!rows) return null;
    const { ry, h } = rows;
    // (el mismo recuadro que sectionLayer con esta caja)
    const rx = Math.max(0, Math.floor(ox + c.x0) - 1), rx1 = Math.min(b.width - 1, Math.ceil(ox + c.x1 + 1) + 1), w = rx1 - rx + 1;
    // Dos búferes que se turnan: se escribe en uno leyendo lo de antes del otro (la capa que se devolvió hace dos
    // composiciones deja de valer)
    const prev = this.raw?.h === h && this.raw.ry === ry ? this.raw : null;
    let raw = this.spare;
    if (!raw || raw.w !== w || raw.h !== h) {
      raw = { rx, w, h, ry, mask: new Uint8Array(w * h), rgba: new Uint8ClampedArray(w * h * 4), depth: new Float32Array(w * h),
        face: new Int8Array(w * h), pick: new Float64Array(w * h), sky: b.sky ? new Uint8Array(w * h) : null, units: new Map(), edges: [0, -1] };
    }
    raw.rx = rx; raw.ry = ry; raw.units = new Map(); raw.edges = [ox + c.x0, ox + c.x1];
    // Lo de antes vale salvo cerca de sus bordes (donde lleva los arreglos de los bordes): eso, de las unidades
    const m = SKY_REACH + 1, nearPrevEdge = (gx0: number, gx1: number) =>
      !!prev && (gx0 <= prev.edges[0] + m && gx1 >= prev.edges[0] - 1 || gx0 <= prev.edges[1] + 1 && gx1 >= prev.edges[1] - m);
    // Las columnas: de lo de antes (en tramos seguidos: una copia por fila y tramo), de una unidad, o vacías
    let count = 0, run0 = -1, run1 = -1, src: CopySource | null = null;
    const flush = () => { if (run0 >= 0) { if (src) copyCols(src, raw!, run0, run1); else clearCols(raw!, run0, run1); } run0 = -1; };
    const take = (s: CopySource | null, gx0: number, gx1: number) => {
      if (run0 >= 0 && s === src && s !== null && s === prev && gx0 === run1 + 1) { run1 = gx1; return; }
      if (run0 >= 0 && s === null && src === null && gx0 === run1 + 1) { run1 = gx1; return; }
      flush(); src = s; run0 = gx0; run1 = gx1;
    };
    if (ox + c.x0 > rx) take(null, rx, ox + c.x0 - 1);
    for (let i = c.x0 / UNIT; i <= (c.x1 + 1) / UNIT - 1; i++) {
      const gx0 = Math.max(rx, ox + i * UNIT), gx1 = Math.min(rx1, ox + i * UNIT + UNIT - 1);
      if (gx0 > gx1) continue;
      if (!this.fresh(i)) { take(null, gx0, gx1); continue; }
      const L = this.strips.get(i)!.layer;
      raw.units.set(i, L);
      count += L ? unitCount(L, ox + i * UNIT) : 0;
      if (prev && L && prev.units.get(i) === L && gx0 >= prev.rx && gx1 < prev.rx + prev.w && !nearPrevEdge(gx0, gx1)) take(prev, gx0, gx1);
      else take(L, gx0, gx1);
    }
    if (ox + c.x1 < rx1) take(null, ox + c.x1 + 1, rx1);
    flush();
    this.spare = this.raw; this.raw = raw;
    const { mask, rgba, depth, face, pick, sky } = raw;
    if (!count) return null;
    // El cielo cerca de los bordes en x (a SKY_REACH + 1 columnas): con la caja de verdad (las franjas lo hicieron con
    // la ancha, que deja ver cielo de lado)
    if (sky) {
      const m = SKY_REACH + 1;
      for (const side of [0, 1] as const) {
        const es = this.edgeSky(c, side, ry, h);
        for (let k = 0; k < m; k++) {
          const li = ox + (side ? c.x1 - k : c.x0 + k) - rx;
          if (li < 0 || li >= w) continue;
          for (let j = 0; j < h; j++) { const v = es[j * m + k]!; if (v !== 255) sky[j * w + li] = v; }
        }
      }
    }
    // Los bordes en x: el píxel horneado de fuera junto a uno sustituido es borde (con su luz y su vóxel: lo horneado),
    // y el sustituido junto a uno horneado mucho más cerca lleva el contorno de la costura
    const gap = b.options.innerGap ?? innerGapFor(b.options), both = b.options.outline === 'both';
    const fixed = b.options.outlineColor ? rgbOf(b.options.outlineColor) : null;
    for (const [inX, outX] of [[ox + c.x0, ox + c.x0 - 1], [ox + c.x1, ox + c.x1 + 1]] as const) {
      const li = inX - rx, lo = outX - rx;
      if (lo < 0 || lo >= w) continue;
      for (let j = 0; j < h; j++) {
        const q = j * w + li, qo = j * w + lo, gi = (ry + j) * b.width + outX;
        if (mask[q] !== 1) continue;
        if (!mask[qo] && !Number.isNaN(b.pick[gi]!)) {
          mask[qo] = 2;
          rgba.set(b.rgba.subarray(gi * 4, gi * 4 + 4), qo * 4); depth[qo] = b.depth[gi]!; face[qo] = b.face[gi]!; pick[qo] = b.pick[gi]!;
          if (sky && b.sky) sky[qo] = b.sky[gi]!;
        }
        if (both && depth[q] !== Infinity && b.depth[gi]! < depth[q]! - gap) {
          let col: readonly [number, number, number];
          if (fixed) col = fixed;
          else { const [x, y, z] = unkey(pick[q]!), { ramp } = decode(b.source.get(x, y, z)); col = rgbOf(b.source.palette.ramps[ramp]?.colors[0] ?? '#000000'); }
          rgba[q * 4] = col[0]; rgba[q * 4 + 1] = col[1]; rgba[q * 4 + 2] = col[2]; rgba[q * 4 + 3] = 255;
        }
      }
    }
    return { x: rx, y: ry, w, h, mask, rgba, depth, face, pick, sky, count };
  }
}
