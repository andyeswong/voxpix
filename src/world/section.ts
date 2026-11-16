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

export function sectionLayer(b: Baked, cut: SectionCut): SectionLayer | null {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY, ox = b.options.originX ?? 0;
  const depthBack = cut.depth ?? 32;
  const X0 = Math.max(0, cut.x0), X1 = Math.min(s.width - 1, cut.x1), Y0 = Math.max(0, cut.y0), Y1 = Math.min(s.depth - 1, cut.y1);
  if (X0 > X1 || Y0 > Y1) return null;
  const zMin = cut.zMin, top = s.zMax;
  const inBox = (x: number, y: number, z: number) => x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && z >= zMin;
  // El recuadro: donde cae la caja (lo que se sustituye solo puede estar ahí), con 1 de margen
  const rx = Math.max(0, Math.floor(ox + X0) - 1), rx1 = Math.min(b.width - 1, Math.ceil(ox + X1 + 1) + 1);
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
  const bx0 = X0 - 1, bx1 = X1 + 1, zLo = Math.max(s.zMin, zMin - Math.ceil(depthBack * a) - 2);
  const src: VoxelSource = {
    palette: s.palette,
    get,
    entries: () => { throw new Error('la sección se recorre con forEachExposed'); },
    forEachExposed: (fn) => {
      // Detrás: lo expuesto del mundo (no cambia con el corte, salvo la fila pegada a la caja, que va aparte)
      s.forEachExposed((x, y, z, v) => { if (!(y === Y1 + 1 && x >= X0 && x <= X1 && z >= zMin)) fn(x, y, z, v); },
        { x0: bx0, y0: Y1 + 1, x1: bx1, y1: Math.min(s.depth - 1, Y1 + depthBack), z0: zLo, z1: top }, true, faces);
      // La fila de detrás de la caja, con su cara sur destapada
      if (Y1 + 1 < s.depth) for (let z = zMin; z <= top; z++) for (let x = X0; x <= X1; x++) { const v = s.get(x, Y1 + 1, z); if (v) fn(x, Y1 + 1, z, v); }
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
    const colTop = (x: number, y: number) => {
      let t = s.height[y * s.width + x]!;
      if (x >= X0 && x <= X1 && y >= Y0 && y <= Y1 && t > zMin) { t = zMin; while (t > s.zMin && !s.get(x, y, t - 1)) t--; }
      return t;
    };
    for (let t = 0; t < w * h; t++) {
      if (!mask[t]) continue;
      const k = pick[t]!;
      if (Number.isNaN(k)) { sky[t] = SKY_RAYS; continue; }
      const [vx, vy, vz] = unkey(k), n = DIR_VECTORS[face[t]!]!;
      const cx = vx + n[0], cy = vy + n[1], cz = vz + n[2];
      let open = 0;
      if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth || colTop(cx, cy) <= cz) open++;
      for (const [dx, dy] of SKY_DIRS) {
        let clear = true;
        for (let q = 1; q <= SKY_REACH; q++) {
          const x = cx + dx * q, y = cy + dy * q, z = cz + q;
          if (x < 0 || y < 0 || x >= s.width || y >= s.depth || z > s.zMax) break;
          if (get(x, y, z)) { clear = false; break; }
          if (q === SKY_REACH && colTop(x, y) > z) clear = false;
        }
        if (clear) open++;
      }
      sky[t] = open;
    }
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
