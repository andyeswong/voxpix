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
import { render, unkey, key, KEY_SPAN, KEY_OFF, decode, innerGapFor, rgbOf, materialsOf, type VoxelSource, DIR_VECTORS } from '../core';
import { SKY_RAYS, SKY_REACH, unprojector, rowP, worldYAt, publishedSince, type Baked } from './bake';
import type { FaceSet } from './state';
import { frontFaces } from '../core';

export interface SectionCut {
  x0: number; x1: number; y0: number; y1: number; zMin: number;
  depth?: number;                       // lo que se mira detrás de la caja (filas de vóxeles; 32)
  fill?: string | null;                 // el fondo de lo sustituido bajo tierra sin nada detrás (SECTION_FILL); null, transparente
}

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
  // La y del mundo de lo que se ve en cada píxel (worldYAt con su profundidad; 0 sin cara) y la luz por detrás de su
  // material: lo que necesita la luz por píxel (el compositor de la GPU lo sube tal cual)
  readonly wy: Float32Array;
  readonly back: Float32Array;
  readonly count: number;               // píxeles sustituidos (los de borde no cuentan)
  // Los arrays van por filas de `stride` (por defecto w). Con ring (los de SectionPainter), la columna de imagen gx está
  // en gx mod ring (un anillo: al mover la caja no se copia nada); si no, en gx - x. secIdx da el índice
  readonly stride?: number;
  readonly ring?: number;
  // Solo en las de SectionPainter: la capa anterior y las columnas de píxeles (de la imagen) que cambiaron desde ella;
  // lo demás de las columnas que comparten es igual. Para subir solo eso (el compositor de la GPU)
  readonly base?: SectionLayer | null;
  // La caja del corte (en vóxeles de la vista): lo que se dibuja encima de la imagen (el agua) la respeta
  readonly box?: SectionCut;
  readonly dirty?: ReadonlyArray<readonly [number, number]>;
}

// El índice en los arrays de la capa del píxel de la columna de imagen gx y la fila j de la capa (sin mirar el recuadro)
export function secIdx(L: SectionLayer, gx: number, j: number): number {
  return j * (L.stride ?? L.w) + (L.ring ? gx & (L.ring - 1) : gx - L.x);
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

// rows (opcional): solo esas filas de la imagen (y0..y1) del recuadro (se pinta con una fila de margen a cada lado y solo
// se recorre lo que puede caer en ellas): así una unidad se pinta por bandas de filas, en pasos más cortos
export function sectionRows(b: Baked, cut: SectionCut): [number, number] {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const Y0 = Math.max(0, cut.y0), Y1 = Math.min(s.depth - 1, cut.y1);
  return [Math.max(0, Math.floor(O - a * (Y1 + 1) - (s.zMax + 1)) - 1), Math.min(b.height - 1, Math.ceil(O - a * Y0 - cut.zMin) + 1)];
}

export function sectionLayer(b: Baked, cut: SectionCut, cols?: { x0: number; x1: number }, rows?: { y0: number; y1: number }): SectionLayer | null {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY, ox = b.options.originX ?? 0;
  const depthBack = cut.depth ?? 32;
  const X0 = Math.max(0, cut.x0), X1 = Math.min(s.width - 1, cut.x1), Y0 = Math.max(0, cut.y0), Y1 = Math.min(s.depth - 1, cut.y1);
  if (X0 > X1 || Y0 > Y1) return null;
  const zMin = cut.zMin, top = s.zMax;
  const inBox = (x: number, y: number, z: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && z >= zMin;
  // El recuadro: donde cae la caja (lo que se sustituye solo puede estar ahí), con 1 de margen; o las columnas pedidas
  const rx = Math.max(0, cols ? Math.floor(ox + cols.x0) : Math.floor(ox + X0) - 1), rx1 = Math.min(b.width - 1, cols ? Math.ceil(ox + cols.x1) : Math.ceil(ox + X1 + 1) + 1);
  const fy0 = Math.max(0, Math.floor(O - a * (Y1 + 1) - (top + 1)) - 1), fy1 = Math.min(b.height - 1, Math.ceil(O - a * Y0 - zMin) + 1);
  // (con rows: la banda pedida y una fila de margen a cada lado, dentro del recuadro entero)
  const oy0 = rows ? Math.max(fy0, rows.y0) : fy0, oy1 = rows ? Math.min(fy1, rows.y1) : fy1;
  const ry = Math.max(fy0, oy0 - 1), ry1 = Math.min(fy1, oy1 + 1);
  if (rx > rx1 || ry > ry1 || oy0 > oy1) return null;
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
  const bx0 = Math.max(X0 - 1, rx - ox - 1), bx1 = Math.min(X1 + 1, rx1 - ox + 1);
  // Las alturas que pueden caer en las filas ry..ry1 desde lo de detrás (y de Y1 + 1 a Y1 + depthBack), con margen
  const zLo = Math.max(s.zMin, zMin - Math.ceil(depthBack * a) - 2, Math.floor(O - a * (Y1 + depthBack + 1) - 1 - ry1) - 2);
  const zHi = Math.min(top, Math.ceil(O - a * (Y1 + 1) - ry) + 2);
  const src: VoxelSource = {
    palette: s.palette,
    get,
    entries: () => { throw new Error('la sección se recorre con forEachExposed'); },
    forEachExposed: (fn) => {
      // Detrás: lo expuesto del mundo (no cambia con el corte, salvo la fila pegada a la caja, que va aparte)
      s.forEachExposed((x, y, z, v) => { if (!(y === Y1 + 1 && x >= cx0 && x <= cx1 && z >= zMin)) fn(x, y, z, v); },
        { x0: bx0, y0: Y1 + 1, x1: bx1, y1: Math.min(s.depth - 1, Y1 + depthBack), z0: zLo, z1: zHi }, true, faces);
      // La fila de detrás de la caja, con su cara sur destapada
      if (Y1 + 1 < s.depth) for (let z = Math.max(zMin, zLo); z <= zHi; z++) for (let x = cx0; x <= cx1; x++) { const v = s.get(x, Y1 + 1, z); if (v) fn(x, Y1 + 1, z, v); }
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
  // La geometría de la luz por píxel
  const wy = new Float32Array(w * h), back = new Float32Array(w * h), u = unprojector(b), mt = materialsOf(s.palette);
  for (let j = 0; j < h; j++) {
    const P = rowP(u, ry + j);
    for (let i = 0; i < w; i++) {
      const q = j * w + i;
      if (!mask[q]) continue;
      if (face[q]! >= 0 && depth[q] !== Infinity) wy[q] = worldYAt(u, P, depth[q]!);
      if (mt && !Number.isNaN(pick[q]!)) { const [x, y, z] = unkey(pick[q]!); back[q] = mt.backlit[s.get(x, y, z)]!; }
    }
  }
  // Lo sustituido donde detrás no se encontró nada (más allá de depth): si su rayo pasa por debajo de la tierra en alguna
  // fila de detrás de la caja (un pozo, una cueva, el suelo que sigue), el fondo de la sección (cut.fill, oscuro por
  // defecto); si va por encima de todo, transparente (el cielo del juego)
  const fill = cut.fill === null ? null : rgbOf(cut.fill ?? SECTION_FILL);
  if (fill) for (let j = 0; j < h; j++) {
    const P = O - (ry + j + 0.5);                                  // = a * y + z de la fila
    for (let i = 0; i < w; i++) {
      const q = j * w + i;
      if (mask[q] !== 1 || rgba[q * 4 + 3]) continue;
      const x = rx + i - ox;
      if (x < 0 || x >= s.width) continue;
      let under = false;
      for (let y = Y1 + 1; y <= Math.min(s.depth - 1, Y1 + depthBack) && !under; y++) under = P - a * y < s.height[y * s.width + x]!;
      if (!under) continue;
      rgba[q * 4] = fill[0]; rgba[q * 4 + 1] = fill[1]; rgba[q * 4 + 2] = fill[2]; rgba[q * 4 + 3] = 255;
    }
  }
  if (oy0 === ry && oy1 === ry1) return { x: rx, y: ry, w, h, mask, rgba, depth, face, pick, sky, wy, back, count, box: cut };
  // Solo las filas pedidas (sin el margen)
  const j0 = oy0 - ry, n = (oy1 - oy0 + 1) * w, a0 = j0 * w;
  let cnt = 0;
  for (let q = a0; q < a0 + n; q++) if (mask[q] === 1) cnt++;
  return { x: rx, y: oy0, w, h: oy1 - oy0 + 1, mask: mask.slice(a0, a0 + n), rgba: rgba.slice(a0 * 4, (a0 + n) * 4), depth: depth.slice(a0, a0 + n),
    face: face.slice(a0, a0 + n), pick: pick.slice(a0, a0 + n), sky: sky ? sky.slice(a0, a0 + n) : null, wy: wy.slice(a0, a0 + n), back: back.slice(a0, a0 + n), count: cnt };
}

// El fondo de lo sustituido bajo tierra donde detrás no hay nada (SectionCut.fill)
export const SECTION_FILL = '#0e0d14';

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
const AHEAD_MIN = 3;        // franjas por delante que se pintan con prioridad (lo que cuesta llegar a andar un poco)
const STARVE = 30;          // llamadas seguidas sin sitio antes de pintar un paso de la caja igualmente
export const BAND = 48;     // y cada unidad, por bandas de BAND filas de la imagen (un paso de la cola)
export const UNIT = 4;      // y se pinta de UNIT en UNIT (un paso de la cola: unos 1,6 ms sin freno)

// Lo compuesto de SectionPainter: un anillo de RW columnas (potencia de 2) por h filas
interface Raw {
  RW: number; h: number; ry: number; rx: number; w: number;
  mask: Uint8Array; rgba: Uint8ClampedArray; depth: Float32Array; face: Int8Array; pick: Float64Array; sky: Uint8Array | null; wy: Float32Array; back: Float32Array;
  units: Map<number, SectionLayer | null>;     // las unidades que están (la capa de cada una, para saber si sigue siendo esa)
  edges: [number, number];                     // las columnas de píxeles de los bordes de la caja (llevan los arreglos)
}

// Los tramos de las columnas de imagen gx0..gx1 que caen seguidos en el anillo: [gx, n]
function ringRuns(RW: number, gx0: number, gx1: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let g = gx0; g <= gx1;) { const n = Math.min(gx1 - g + 1, RW - (g & (RW - 1))); out.push([g, n]); g += n; }
  return out;
}

// Las bandas de filas de una unidad (en orden, de arriba abajo; null: sin nada) en una sola capa de las filas fy0..fy1
function joinRows(parts: Array<SectionLayer | null>, fy0: number, fy1: number): SectionLayer | null {
  const first = parts.find((q) => q);
  if (!first) return null;
  const w = first.w, h = fy1 - fy0 + 1, n = w * h;
  const mask = new Uint8Array(n), rgba = new Uint8ClampedArray(n * 4), depth = new Float32Array(n).fill(Infinity), face = new Int8Array(n).fill(-1);
  const pick = new Float64Array(n).fill(NaN), sky = first.sky ? new Uint8Array(n) : null, wy = new Float32Array(n), back = new Float32Array(n);
  let count = 0;
  for (const q of parts) {
    if (!q) continue;
    const o = (q.y - fy0) * w;
    mask.set(q.mask, o); rgba.set(q.rgba, o * 4); depth.set(q.depth, o); face.set(q.face, o); pick.set(q.pick, o);
    if (sky && q.sky) sky.set(q.sky, o);
    wy.set(q.wy, o); back.set(q.back, o);
    count += q.count;
  }
  return count ? { x: first.x, y: fy0, w, h, mask, rgba, depth, face, pick, sky, wy, back, count } : null;
}

// Columnas sin sección
function clearCols(to: Raw, gx0: number, gx1: number): void {
  for (const [g, n] of ringRuns(to.RW, gx0, gx1)) for (let j = 0; j < to.h; j++) {
    const a = j * to.RW + (g & (to.RW - 1)), z = a + n;
    to.mask.fill(0, a, z); to.rgba.fill(0, a * 4, z * 4); to.depth.fill(Infinity, a, z); to.face.fill(-1, a, z); to.pick.fill(NaN, a, z);
    to.wy.fill(0, a, z); to.back.fill(0, a, z);
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

// Copia las columnas de imagen gx0..gx1 de la capa de una unidad (sin anillo) al anillo, una copia por fila, tramo y array
function copyCols(from: SectionLayer, to: Raw, gx0: number, gx1: number): void {
  for (const [g, n] of ringRuns(to.RW, gx0, gx1)) for (let j = 0; j < to.h; j++) {
    const fq = j * from.w + g - from.x, tq = j * to.RW + (g & (to.RW - 1));
    to.mask.set(from.mask.subarray(fq, fq + n), tq);
    to.rgba.set(from.rgba.subarray(fq * 4, (fq + n) * 4), tq * 4);
    to.depth.set(from.depth.subarray(fq, fq + n), tq);
    to.face.set(from.face.subarray(fq, fq + n), tq);
    to.pick.set(from.pick.subarray(fq, fq + n), tq);
    to.wy.set(from.wy.subarray(fq, fq + n), tq);
    to.back.set(from.back.subarray(fq, fq + n), tq);
    if (to.sky && from.sky) to.sky.set(from.sky.subarray(fq, fq + n), tq);
  }
}

export class SectionPainter {
  // (rows: las filas de la imagen que pintó, fy0..fy1 de sectionRows: lo que la invalida tiene que caer cerca de ellas)
  private strips = new Map<number, { layer: SectionLayer | null; serial: number; id: number; rows: readonly [number, number] }>();
  private track = '';
  private cut: SectionCut | null = null;
  private dir = 0;
  private composed: { key: string; layer: SectionLayer | null } | null = null;
  // Lo copiado de las unidades para la caja de ahora, sin los arreglos de los bordes (se lleva al mover la caja)
  private raw: Raw | null = null;
  private last: SectionLayer | null = null;      // la última capa compuesta (la base de la siguiente)
  // El cielo de cueva de las columnas junto a cada borde de la caja, por posición de la caja (se adelanta en la cola)
  // (vale mientras las unidades de esas columnas sigan siendo las mismas y al día)
  private edgeSkies = new Map<string, { sky: Uint8Array; units: Array<SectionLayer | null | undefined> }>();
  // Franjas que se pintan por delante (en la dirección en que anda) y por detrás
  ahead: number;
  behind: number;
  // Franjas pintadas (para medir)
  painted = 0;

  constructor(readonly b: Baked, opts: { ahead?: number; behind?: number } = {}) {
    this.ahead = opts.ahead ?? 4; this.behind = opts.behind ?? 1;
  }

  // La caja de este cuadro (o null: sin corte) y hacia dónde anda en x de la vista (-1, 0, 1). La caja se lleva a
  // franjas enteras en x (las que toca), y en y y en z se queda con holgura
  set(cut: SectionCut | null, dir = 0): void {
    this.dir = dir;
    if (!cut) { this.cut = null; return; }
    // (con el mismo ancho siempre: la caja siguiente es esta desplazada una franja, y lo que se adelanta para ella vale)
    const x0 = Math.floor(cut.x0 / STRIP) * STRIP, x1 = x0 + Math.ceil((cut.x1 - cut.x0 + 1) / STRIP) * STRIP - 1;
    // En y y en z, con holgura: lo pintado sigue valiendo mientras el objetivo se mueve un poco (si no, cada vóxel que se
    // mueve en y o en z lo repinta todo). La caja nunca acaba más de una fila antes de los pies (siempre corta lo de
    // delante) y puede acabar hasta STRIP filas detrás; nunca corta más de un vóxel por debajo de los pies (el suelo) y
    // puede empezar hasta 4 por encima. Fuera de eso, a los pies de ahora. (Redondear a bloques de 8 no vale: en un mundo
    // cuyos pies no caen en múltiplos de 8, cortaba el suelo)
    // Mientras se prepara un corrimiento, lo pintado se pone al día cada cuadro (fresh apunta el serial): al cambiar solo se
    // corre lo que estaba al día justo antes
    if (this.b.shifting) for (const i of this.strips.keys()) this.fresh(i);
    // La ventana se corrió (shiftBakedJob): lo pintado se corre con la imagen en vez de tirarlo
    const sh = this.b.shifts ?? 0;
    if (sh !== this.seenShifts) {
      if (sh === this.seenShifts + 1 && this.b.lastShift && this.cut) this.shiftStrips(this.b.lastShift);
      else this.clearAll();
      this.seenShifts = sh;
    }
    const prev = this.cut;
    const y1 = prev && prev.y1 >= cut.y1 - 1 && prev.y1 <= cut.y1 + STRIP ? prev.y1 : cut.y1;
    const zMin = prev && prev.zMin >= cut.zMin - 1 && prev.zMin <= cut.zMin + 4 ? prev.zMin : cut.zMin;
    this.cut = { ...cut, x0, x1, y1, zMin };
    const track = `${cut.y0},${y1},${zMin},${cut.depth ?? ''}`;
    if (track !== this.track) { if (this.track) this.resets++; this.track = track; this.clearAll(); }
  }
  // (para medir) veces que lo pintado se tiró por moverse la caja en y o en z
  resets = 0;
  // (para medir) las franjas de la caja de ahora que no están al día: sin pintar nunca (o tiradas) y pintadas pero viejas
  // (un rehorneado las tocó); y si la caja cambió de franja desde la llamada anterior
  boxState(): { missing: number; stale: number; moved: boolean } {
    const c = this.cut;
    let missing = 0, stale = 0;
    if (c) for (let i = c.x0 / UNIT; i <= (c.x1 + 1) / UNIT - 1; i++) {
      if (i < 0 || i * UNIT >= this.b.source.width) continue;
      if (!this.strips.has(i)) missing++; else if (!this.fresh(i)) stale++;
    }
    const moved = !!c && this.lastBoxX !== c.x0;
    this.lastBoxX = c ? c.x0 : null;
    return { missing, stale, moved };
  }
  private lastBoxX: number | null = null;

  private seenShifts = 0;
  private clearAll(): void { this.strips.clear(); this.pending.clear(); this.composed = null; this.raw = null; this.last = null; this.edgeSkies.clear(); }

  // Corre lo pintado como shiftBakedJob corrió la imagen, en x (en y no: ver abajo): el píxel nuevo x es el viejo x + DX
  // y el vóxel de cada píxel, corrido (key - dk). Se
  // queda lo que estaba al día justo antes del corrimiento (su serial era el de entonces: el corrimiento suma 2) y sigue
  // en la imagen; queda con el serial de antes del recuadro que publicó el corrimiento (lo borrado), así que una franja
  // que lo toque se repinta. La caja y su seguimiento, en las coordenadas nuevas. Lo demás (lo compuesto, el anillo, los
  // cielos de los bordes, lo que se pintaba a medias), de nuevo
  private shiftStrips(ls: { serial: number; dx: number; dy: number }): void {
    const b = this.b, DX = ls.dx, before = ls.serial - 2;
    const dk = key(DX, 0, 0) - key(0, 0, 0), maxI = Math.floor((b.source.width - 1) / UNIT), sw = b.source.width;
    const old = this.strips;
    this.strips = new Map();
    this.clearAll();
    // Solo en x: al correrse en y el objetivo se movió en y, y la caja con él (su seguimiento cambia y se repinta igual)
    if (DX % UNIT || ls.dy !== 0) return;
    for (const [i, st] of old) {
      const ni = i - DX / UNIT;
      if (st.serial !== before || ni < 0 || ni > maxI) continue;
      const L = st.layer;
      if (!L) { this.strips.set(ni, { layer: null, serial: ls.serial - 1, id: st.id, rows: st.rows }); continue; }
      // (la profundidad, la y del mundo y lo demás no cambian: misma fila, misma profundidad)
      const pick = new Float64Array(L.w * L.h);
      let out = false;
      for (let q = 0; q < pick.length && !out; q++) {
        const k = L.pick[q]!;
        // (solo los píxeles de la capa llevan vóxel)
        if (!L.mask[q] || k !== k) { pick[q] = k; continue; }
        const k2 = k - dk, vx = Math.floor(Math.floor(k2 / KEY_SPAN) / KEY_SPAN) - KEY_OFF;
        if (vx < 0 || vx >= sw) out = true;
        pick[q] = k2;
      }
      // (un vóxel suyo salió de la ventana: se repinta)
      if (out) continue;
      this.strips.set(ni, { layer: { ...L, x: L.x - DX, pick }, serial: ls.serial - 1, id: st.id, rows: st.rows });
    }
    const c = this.cut!;
    this.cut = { ...c, x0: c.x0 - DX, x1: c.x1 - DX };
  }

  // ¿La franja i está pintada y al día con la imagen?
  private fresh(i: number): boolean {
    const st = this.strips.get(i);
    if (!st) return false;
    const pub = this.b.published;
    if (pub.serial === st.serial) return true;
    // (lo publicado desde entonces: lo que se guarda y, de lo olvidado, lo que une cada tanda; null, ya no se sabe)
    const since = publishedSince(this.b, st.serial);
    if (!since) return false;
    for (const r of since) if (this.touches(r, i, st.rows[0], st.rows[1])) return false;
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

  // Un trabajo de la cola. null si no falta nada. Pinta por pasos (una banda de filas de una unidad) hasta el plazo, y
  // un paso solo empieza si cabe (lo que suelen costar los pasos): puede no dar ninguno si no hay margen (devuelve false
  // sin gastar tiempo, como un trabajo que espera). Mientras falta algo de la caja va con priority 0 (lo cercano de la
  // cola); si solo queda lo de delante (y el cielo de los bordes de la caja siguiente), sin prioridad: con lo que sobre
  job(): { key: string; priority?: number; run(deadline: number): boolean; unit(): number } | null {
    const w = this.wanted();
    if (!w.length && !this.nextEdge()) return null;
    // Sin prioridad solo con la caja hecha y AHEAD_MIN franjas pintadas por delante (si no, al andar se ven huecos)
    const boxDone = this.ready() && this.aheadFresh() >= AHEAD_MIN * (STRIP / UNIT);
    const run = (deadline: number) => {
      if (this.b.shiftHold) return false;                                  // la ventana se está corriendo: espera
      // En el cuadro en que la caja salta de franja (toca componer) y con la caja ya pintada, lo de delante espera: no se
      // suma a la composición
      if (this.ready() && !this.composedBox()) return false;
      for (;;) {
        const now = performance.now();
        // Sin sitio, nada; salvo si la caja lleva STARVE llamadas sin avanzar (que acabe apareciendo aunque no sobre)
        // (al no caber se olvida la muestra más vieja: unos pasos lentos sueltos, los primeros sin compilar, no lo paran;
        // a los pocos cuadros vuelve a probar con un paso de verdad)
        if (now + this.stepEstimate() > deadline && !(this.declined >= STARVE && !this.ready())) { this.declined++; this.steps.shift(); return false; }
        this.declined = 0;
        // En orden: lo de la caja, el cielo de los bordes de la caja siguiente (para que componer al saltar no lo pague) y
        // lo de delante
        const i = this.wanted()[0], c = this.cut!, inBox = i !== undefined && i >= c.x0 / UNIT && i <= (c.x1 + 1) / UNIT - 1;
        if (inBox) { this.paintStep(i); this.noteStep(performance.now() - now); continue; }
        const e = this.nextEdge();
        if (e) { this.edgeSky(e.c, e.side, e.ry, e.h); this.noteStep(performance.now() - now); continue; }
        if (i === undefined) return true;
        this.paintStep(i); this.noteStep(performance.now() - now);
      }
    };
    // (unit: lo que cuesta un paso; la cola mira eso para saber si cabe, no lo que gastó la llamada, que llena el plazo)
    const unit = () => this.stepEstimate();
    return boxDone ? { key: 'section', run, unit } : { key: 'section', priority: 0, run, unit };
  }

  // Las unidades seguidas ya pintadas por delante de la caja (en la dirección en que anda)
  private aheadFresh(): number {
    const c = this.cut;
    if (!c) return 0;
    const i0 = c.x0 / UNIT, i1 = (c.x1 + 1) / UNIT - 1, fwd = this.dir >= 0 ? 1 : -1, maxI = Math.floor((this.b.source.width - 1) / UNIT);
    let n = 0;
    for (let i = fwd > 0 ? i1 + 1 : i0 - 1; i >= 0 && i <= maxI && this.fresh(i); i += fwd) n++;
    if (fwd > 0 ? i1 + n + 1 > maxI : i0 - n - 1 < 0) return Infinity;   // hasta el borde del mundo: no falta nada
    return n;
  }

  // Lo que suelen costar los pasos: el tercero mayor de los últimos 8 (ms, sin freno; uno suelto lento no lo para todo)
  private steps: number[] = [];
  private declined = 0;
  private stepEstimate(): number { const s = [...this.steps].sort((a, b) => b - a); return s[Math.min(2, s.length - 1)] ?? 0; }
  private noteStep(ms: number): void { this.steps.push(ms); if (this.steps.length > 8) this.steps.shift(); }
  // (para medir) lo que costó el último paso
  get stepMs(): number { return this.steps[this.steps.length - 1] ?? 0; }

  // ¿La última composición es de la caja de ahora?
  private composedBox(): boolean {
    const c = this.cut;
    return !!c && !!this.composed && this.composed.key.startsWith(`${c.x0},${c.x1}:`);
  }


  // El primer cielo de borde que falta de la caja de ahora o de la siguiente (con sus unidades pintadas)
  private nextEdge(): { c: SectionCut; side: 0 | 1; ry: number; h: number } | null {
    const c = this.cut;
    if (!c) return null;
    const fwd = this.dir >= 0 ? STRIP : -STRIP;
    const rows = this.rows(c);
    if (!rows) return null;
    for (const box of [c, { ...c, x0: c.x0 + fwd, x1: c.x1 + fwd }]) for (const side of [0, 1] as const) {
      if (this.edgeValid(box, side)) continue;
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
  private edgeCols(c: SectionCut, side: 0 | 1): number[] { const m = SKY_REACH + 1, o: number[] = []; for (let k = 0; k < m; k++) o.push(side ? c.x1 - k : c.x0 + k); return o; }
  private edgeValid(c: SectionCut, side: 0 | 1): boolean {
    const e = this.edgeSkies.get(this.edgeKey(c, side));
    if (!e) return false;
    return this.edgeCols(c, side).every((x, k) => { const i = Math.floor(x / UNIT); return this.strips.get(i)?.layer === e.units[k] && (e.units[k] === undefined || this.fresh(i)); });
  }
  private edgeSky(c: SectionCut, side: 0 | 1, ry: number, h: number): Uint8Array {
    const key = this.edgeKey(c, side);
    if (this.edgeValid(c, side)) return this.edgeSkies.get(key)!.sky;
    const b = this.b, m = SKY_REACH + 1, X0 = Math.max(0, c.x0), X1 = Math.min(b.source.width - 1, c.x1);
    const Y0 = Math.max(0, c.y0), Y1 = Math.min(b.source.depth - 1, c.y1);
    const out = new Uint8Array(m * h).fill(255), units: Array<SectionLayer | null | undefined> = [];
    for (let k = 0; k < m; k++) {
      const x = side ? c.x1 - k : c.x0 + k, i = Math.floor(x / UNIT), st = this.fresh(i) ? this.strips.get(i)?.layer : undefined;
      units.push(st);
      if (!st) continue;
      const sk = (b.options.originX ?? 0) + x - st.x;
      for (let j = 0; j < h; j++) {
        const sq = j * st.w + sk;
        if (st.mask[sq]) out[j * m + k] = cutSky(b, X0, X1, Y0, Y1, c.zMin, st.pick[sq]!, st.face[sq]!);
      }
    }
    this.edgeSkies.set(key, { sky: out, units });
    if (this.edgeSkies.size > 64) this.edgeSkies.delete(this.edgeSkies.keys().next().value!);
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
  paintAll(): void { for (let i = this.wanted()[0]; i !== undefined; i = this.wanted()[0]) this.paintStep(i); }

  // Un paso: la banda siguiente de filas de la unidad i (BAND filas). Con la última, la unidad queda pintada. Las bandas
  // de una unidad se pintan con la misma imagen: si se rehornea algo cerca a medias, se empieza de nuevo
  private pending = new Map<number, { serial: number; next: number; fy0: number; fy1: number; parts: Array<SectionLayer | null> }>();
  private paintStep(i: number): void {
    const c = this.cut!, b = this.b;
    const wide: SectionCut = { ...c, x0: -1e9, x1: 1e9 };
    const [fy0, fy1] = sectionRows(b, wide);
    let p = this.pending.get(i);
    if (p && (!this.unchangedSince(i, p.serial) || p.fy0 !== fy0 || p.fy1 !== fy1)) p = undefined;
    if (!p) { p = { serial: b.published.serial, next: fy0, fy0, fy1, parts: [] }; this.pending.set(i, p); }
    // Con una columna de margen a cada lado (el contorno, el borde y la costura miran a los vecinos); se copian sus UNIT
    const y1 = Math.min(fy1, p.next + BAND - 1);
    p.parts.push(sectionLayer(b, wide, { x0: i * UNIT - 1, x1: i * UNIT + UNIT }, { y0: p.next, y1 }));
    p.next = y1 + 1;
    if (p.next <= fy1) return;
    this.pending.delete(i);
    this.strips.set(i, { layer: joinRows(p.parts, fy0, fy1), serial: p.serial, id: this.painted + 1, rows: [fy0, fy1] });
    this.painted++;
  }
  // ¿Nada rehorneado cerca de la unidad i desde serial?
  private unchangedSince(i: number, serial: number): boolean {
    if (this.b.published.serial === serial) return true;
    const since = publishedSince(this.b, serial);
    if (!since) return false;
    const p = this.pending.get(i);
    const [ry0, ry1] = p ? [p.fy0, p.fy1] : [-Infinity, Infinity];
    for (const r of since) if (this.touches(r, i, ry0, ry1)) return false;
    return true;
  }
  // ¿Un recuadro publicado toca lo que pinta la unidad i en las filas ry0..ry1? Lo que pinta depende de sus columnas y, por
  // el tono y el cielo, de lo que hay a SKY_REACH + 1 vóxeles a cada lado y por encima: en la imagen, SKY_REACH + 1
  // columnas a cada lado y (a + 1) * (SKY_REACH + 1) filas (un vóxel de lado y de alto se ve a + 1 filas más arriba). Antes
  // solo se miraban las columnas: un recuadro lejos al sur (más abajo en la imagen) en las mismas columnas la tiraba
  private touches(r: { x0: number; y0: number; x1: number; y1: number }, i: number, ry0: number, ry1: number): boolean {
    const ox = this.b.options.originX ?? 0, m = SKY_REACH + 1, x0 = ox + i * UNIT, x1 = x0 + UNIT - 1;
    if (r.x1 < x0 - m || r.x0 > x1 + m) return false;
    const a = this.b.options.oblique?.y ?? 1, mr = Math.ceil((a + 1) * m) + 1;
    return r.y1 >= ry0 - mr && r.y0 <= ry1 + mr;
  }

  // La capa de la caja de ahora, con lo que ya está pintado (las franjas que falten, sin sustituir todavía)
  layer(): SectionLayer | null {
    const c = this.cut;
    if (!c) return null;
    const i0 = c.x0 / UNIT, i1 = (c.x1 + 1) / UNIT - 1;
    let ready = '';
    for (let i = i0; i <= i1; i++) ready += this.fresh(i) ? `${this.strips.get(i)!.id},` : '0,';
    // (lo que cambia la capa: la caja, qué unidades están al día y lo pintado; no la imagen entera: un rehorneado lejos
    // no la toca, y el de cerca deja su unidad sin estar al día)
    const key = `${c.x0},${c.x1}:${ready}`;
    if (this.composed && this.composed.key === key) return this.composed.layer;
    const layer = this.compose(c);
    this.composed = { key, layer };
    return layer;
  }

  // Lo que pisan los arreglos de los bordes: el píxel y todo lo suyo, para deshacerlo en la composición siguiente
  private undo: number[] = [];
  private save(r: Raw, q: number): void {
    this.undo.push(q, r.mask[q]!, r.rgba[q * 4]!, r.rgba[q * 4 + 1]!, r.rgba[q * 4 + 2]!, r.rgba[q * 4 + 3]!, r.depth[q]!, r.face[q]!, r.pick[q]!, r.sky ? r.sky[q]! : 0, r.wy[q]!, r.back[q]!);
  }
  private undoEdges(r: Raw): void {
    const u = this.undo;
    for (let k = u.length - 12; k >= 0; k -= 12) {
      const q = u[k]!;
      r.mask[q] = u[k + 1]!; r.rgba[q * 4] = u[k + 2]!; r.rgba[q * 4 + 1] = u[k + 3]!; r.rgba[q * 4 + 2] = u[k + 4]!; r.rgba[q * 4 + 3] = u[k + 5]!;
      r.depth[q] = u[k + 6]!; r.face[q] = u[k + 7]!; r.pick[q] = u[k + 8]!; if (r.sky) r.sky[q] = u[k + 9]!; r.wy[q] = u[k + 10]!; r.back[q] = u[k + 11]!;
    }
    u.length = 0;
  }

  private compose(c: SectionCut): SectionLayer | null {
    const b = this.b, ox = b.options.originX ?? 0;
    const rows = this.rows(c);
    if (!rows) return null;
    const { ry, h } = rows;
    // (el mismo recuadro que sectionLayer con esta caja)
    const rx = Math.max(0, Math.floor(ox + c.x0) - 1), rx1 = Math.min(b.width - 1, Math.ceil(ox + c.x1 + 1) + 1), w = rx1 - rx + 1;
    // Un anillo: lo que ya está de la composición anterior no se mueve (la columna gx está siempre en gx mod RW). La capa
    // que se devolvió antes deja de valer
    let RW = 256;
    while (RW < w) RW *= 2;
    const old = this.raw;
    const prev = old && old.h === h && old.ry === ry && old.RW === RW ? old : null;
    const raw: Raw = prev ?? { RW, h, ry, rx, w, mask: new Uint8Array(RW * h), rgba: new Uint8ClampedArray(RW * h * 4), depth: new Float32Array(RW * h).fill(Infinity),
      face: new Int8Array(RW * h).fill(-1), pick: new Float64Array(RW * h).fill(NaN), sky: b.sky ? new Uint8Array(RW * h) : null, wy: new Float32Array(RW * h), back: new Float32Array(RW * h), units: new Map(), edges: [0, -1] };
    const prevRx = prev ? prev.rx : 0, prevW = prev ? prev.w : 0, prevUnits = prev ? prev.units : new Map<number, SectionLayer | null>(), prevEdges = prev ? prev.edges : [0, -1];
    raw.rx = rx; raw.w = w; raw.units = new Map(); raw.edges = [ox + c.x0, ox + c.x1];
    // Lo de antes vale tal cual salvo los arreglos de sus bordes: se deshacen (se guardó lo que pisaron)
    const m = SKY_REACH + 1;
    const dirty: Array<[number, number]> = [];
    if (prev) {
      this.undoEdges(raw);
      dirty.push([prevEdges[0]! - 1, prevEdges[0]! + m], [prevEdges[1]! - m, prevEdges[1]! + 1]);
    } else this.undo.length = 0;
    // Las columnas: las que ya están se quedan; las demás, de una unidad o vacías
    let count = 0;
    const put = (L: SectionLayer | null, gx0: number, gx1: number) => {
      if (L) copyCols(L, raw, gx0, gx1); else clearCols(raw, gx0, gx1);
      const d = dirty[dirty.length - 1];
      if (d && d[1] === gx0 - 1) d[1] = gx1; else dirty.push([gx0, gx1]);
    };
    if (ox + c.x0 > rx) put(null, rx, ox + c.x0 - 1);
    for (let i = c.x0 / UNIT; i <= (c.x1 + 1) / UNIT - 1; i++) {
      const gx0 = Math.max(rx, ox + i * UNIT), gx1 = Math.min(rx1, ox + i * UNIT + UNIT - 1);
      if (gx0 > gx1) continue;
      if (!this.fresh(i)) { put(null, gx0, gx1); continue; }
      const L = this.strips.get(i)!.layer;
      raw.units.set(i, L);
      count += L ? unitCount(L, ox + i * UNIT) : 0;
      if (prev && prevUnits.get(i) === L && gx0 >= prevRx && gx1 < prevRx + prevW) continue;
      put(L, gx0, gx1);
    }
    if (ox + c.x1 < rx1) put(null, ox + c.x1 + 1, rx1);
    this.raw = raw;
    const { mask, rgba, depth, face, pick, sky, wy, back } = raw;
    const base = prev ? this.last : null;
    // (y lo que cambian los arreglos de los bordes de ahora)
    dirty.push([ox + c.x0 - 1, ox + c.x0 + m], [ox + c.x1 - m, ox + c.x1 + 1]);
    if (!count) { this.last = null; return null; }
    // El cielo cerca de los bordes en x (a SKY_REACH + 1 columnas): con la caja de verdad (las franjas lo hicieron con
    // la ancha, que deja ver cielo de lado)
    if (sky) {
      const m = SKY_REACH + 1;
      for (const side of [0, 1] as const) {
        const es = this.edgeSky(c, side, ry, h);
        for (let k = 0; k < m; k++) {
          const gx = ox + (side ? c.x1 - k : c.x0 + k);
          if (gx < rx || gx > rx1) continue;
          for (let j = 0; j < h; j++) { const v = es[j * m + k]!; if (v !== 255) { const q = j * RW + (gx & (RW - 1)); this.save(raw, q); sky[q] = v; } }
        }
      }
    }
    // Los bordes en x: el píxel horneado de fuera junto a uno sustituido es borde (con su luz y su vóxel: lo horneado),
    // y el sustituido junto a uno horneado mucho más cerca lleva el contorno de la costura
    const gap = b.options.innerGap ?? innerGapFor(b.options), both = b.options.outline === 'both';
    const fixed = b.options.outlineColor ? rgbOf(b.options.outlineColor) : null;
    const u = unprojector(b), mt = materialsOf(b.source.palette);
    for (const [inX, outX] of [[ox + c.x0, ox + c.x0 - 1], [ox + c.x1, ox + c.x1 + 1]] as const) {
      if (outX < rx || outX > rx1) continue;
      for (let j = 0; j < h; j++) {
        const q = j * RW + (inX & (RW - 1)), qo = j * RW + (outX & (RW - 1)), gi = (ry + j) * b.width + outX;
        if (mask[q] !== 1) continue;
        if (!mask[qo] && !Number.isNaN(b.pick[gi]!)) {
          this.save(raw, qo);
          mask[qo] = 2;
          rgba.set(b.rgba.subarray(gi * 4, gi * 4 + 4), qo * 4); depth[qo] = b.depth[gi]!; face[qo] = b.face[gi]!; pick[qo] = b.pick[gi]!;
          if (sky && b.sky) sky[qo] = b.sky[gi]!;
          wy[qo] = face[qo]! >= 0 && depth[qo] !== Infinity ? worldYAt(u, rowP(u, ry + j), depth[qo]!) : 0;
          const [vx, vy, vz] = unkey(pick[qo]!);
          back[qo] = mt ? mt.backlit[b.source.get(vx, vy, vz)]! : 0;
        }
        if (both && depth[q] !== Infinity && b.depth[gi]! < depth[q]! - gap) {
          let col: readonly [number, number, number];
          if (fixed) col = fixed;
          else { const [x, y, z] = unkey(pick[q]!), { ramp } = decode(b.source.get(x, y, z)); col = rgbOf(b.source.palette.ramps[ramp]?.colors[0] ?? '#000000'); }
          this.save(raw, q);
          rgba[q * 4] = col[0]; rgba[q * 4 + 1] = col[1]; rgba[q * 4 + 2] = col[2]; rgba[q * 4 + 3] = 255;
        }
      }
    }
    const layer: SectionLayer = { x: rx, y: ry, w, h, mask, rgba, depth, face, pick, sky, wy, back, count, base, dirty, stride: RW, ring: RW, box: c };
    this.last = layer;
    return layer;
  }
}
