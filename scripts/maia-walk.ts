// El walk de MAIA en vóxeles para revisar, con la cámara del juego (oblicua, suelo a 0.5):
//   - maia_walk_x6.png: filas frente, derecha, espalda, izquierda (vóxeles) y frente y espalda del walk 2D
//     aprobado; columnas: quieto + los 8 cuadros;
//   - maia_walk_x6.gif: los mismos 6 en una fila, animados a 100 ms por cuadro.
// Guarda también cada cuadro como modelo (models/maia/walk/maia_walk_N.json) para el juego.
// Con APPROVED=<hoja PNG del walk 2D aprobado> añade sus dos filas para comparar.
//   [MODEL=otro.json] [APPROVED=walk.png] npx tsx --tsconfig tsconfig.runtime.json scripts/maia-walk.ts [carpeta de salida]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Model, render, type ModelFile } from '../src/core';
import { encodePNG, onBackground } from '../src/core/png';
import { walkFrames, WALK_FRAME_MS } from '../src/anim/walk';
import { encodeGIF } from './lib/gif';

const outDir = process.argv[2] ?? 'out';
// El sprite aprobado con el que se compara (PNG); sin APPROVED no se compara
const APPROVED = process.env.APPROVED ?? '';
const BG: [number, number, number] = [58, 62, 74];
const MODEL = process.env.MODEL ?? 'models/maia/maia.json';
const maia = Model.fromJSON(JSON.parse(readFileSync(MODEL, 'utf8')) as ModelFile);
const frames = walkFrames(maia);

// Los cuadros como modelos solo con el modelo aprobado (con MODEL=otro.json es una prueba y no se guardan)
if (!process.env.MODEL) {
  mkdirSync('models/maia/walk', { recursive: true });
  frames.forEach((f, i) => writeFileSync(`models/maia/walk/maia_walk_${i}.json`, JSON.stringify(f.toJSON())));
}

// Celda del juego (frame2d: 48x72, pies en (24, 60)), recortada a la figura con margen
const W = 48, H = 72, OX = 24, OY = 60;
const CX = 10, CY = 20, CW = 28, CH = 44;
const VIEWS = [0, 90, 180, 270];                 // frente, derecha, espalda, izquierda

function voxelCell(m: Model, yaw: number): Uint8ClampedArray {
  const img = render(m, { width: W, height: H, originX: OX, originY: OY, pivot: [0.5, 0, 0], yaw, oblique: { y: 0.5, z: 1 }, flat: true, outline: 'none' });
  const out = new Uint8ClampedArray(CW * CH * 4);
  for (let y = 0; y < CH; y++) out.set(img.rgba.subarray(((CY + y) * W + CX) * 4, ((CY + y) * W + CX + CW) * 4), y * CW * 4);
  return out;
}

// El walk 2D aprobado: hoja de 24x34 por cuadro (maia_walk = 4..11, maia_espalda_walk = 16..23, quietos 0 y 12),
// con sus pies (fila 33) en la fila de los pies de la celda del juego
const approved = APPROVED ? decodePNG(readFileSync(APPROVED)) : null;
const AW = 24, AH = 34;
function approvedCell(index: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(CW * CH * 4);
  if (!approved) return out;
  const dx = (CW - AW) / 2, dy = OY - CY - AH + 1;
  for (let y = 0; y < AH; y++) for (let x = 0; x < AW; x++) {
    const s = (y * approved.width + index * AW + x) * 4, ty = dy + y, tx = dx + x;
    if (ty < 0 || ty >= CH || !approved.rgba[s + 3]) continue;
    out.set(approved.rgba.subarray(s, s + 4), (ty * CW + tx) * 4);
  }
  return out;
}

// cells[fila][columna]: columna 0 = quieto, 1..8 = cuadros
const cells: Uint8ClampedArray[][] = [
  ...VIEWS.map((yaw) => [voxelCell(maia, yaw), ...frames.map((f) => voxelCell(f, yaw))]),
  ...(approved ? [
    [approvedCell(0), ...Array.from({ length: 8 }, (_, i) => approvedCell(4 + i))],
    [approvedCell(12), ...Array.from({ length: 8 }, (_, i) => approvedCell(16 + i))],
  ] : []),
];

function grid(rows: Uint8ClampedArray[][]): { w: number; h: number; rgba: Uint8ClampedArray } {
  const cols = rows[0]!.length, w = cols * CW, h = rows.length * CH;
  const rgba = new Uint8ClampedArray(w * h * 4);
  rows.forEach((row, r) => row.forEach((c, k) => {
    for (let y = 0; y < CH; y++) rgba.set(c.subarray(y * CW * 4, (y + 1) * CW * 4), ((r * CH + y) * w + k * CW) * 4);
  }));
  return { w, h, rgba };
}

mkdirSync(outDir, { recursive: true });
const sheet = grid(cells);
writeFileSync(`${outDir}/maia_walk_x6.png`, encodePNG(sheet.w, sheet.h, onBackground(sheet.rgba, BG), 6));
// GIF: una fila con las 6 vistas por cuadro
const anim = Array.from({ length: 8 }, (_, i) => grid([cells.map((row) => row[i + 1]!)]));
writeFileSync(`${outDir}/maia_walk_x6.gif`, encodeGIF(anim[0]!.w, anim[0]!.h, anim.map((a) => onBackground(a.rgba, BG)), WALK_FRAME_MS, 6));
console.log(`${outDir}/maia_walk_x6.png (${sheet.w}x${sheet.h}) y .gif, ${frames.length} cuadros -> models/maia/walk/`);

// PNG de 8 bits por canal (RGBA o RGB), sin entrelazar: lo justo para leer la hoja de Aseprite
function decodePNG(buf: Buffer): { width: number; height: number; rgba: Uint8ClampedArray } {
  let o = 8, width = 0, height = 0, ct = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); ct = data[9]!; if (data[8] !== 8 || data[12]) throw new Error('PNG no soportado'); }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG de tipo ${ct} no soportado`);
  const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!, line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp]! : 0, b = y ? px[(y - 1) * stride + x]! : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      px[y * stride + x] = (line[x]! + pred) & 255;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) { for (let c = 0; c < bpp; c++) rgba[i * 4 + c] = px[i * bpp + c]!; if (bpp === 3) rgba[i * 4 + 3] = 255; }
  return { width, height, rgba };
}
