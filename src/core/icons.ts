// HOJA DE ICONOS (NARUTO): varios modelos pintados con el mismo ángulo y la misma escala, cada uno en su celda de una
// hoja, con un índice id -> recuadro. Para la barra de un juego (los bloques del inventario) sacados de los mismos
// modelos con los que se construye el mundo. docs/editor.md, "Sets de bloques".
import { Model } from './model';
import { render, fitFrame } from './render';

export interface IconOptions {
  yaw?: number;                 // giro (grados; por defecto -30, la vista del editor)
  elevation?: number;           // elevación (grados; 35)
  outline?: 'none' | 'outer' | 'both';   // contorno ('outer')
  outlineColor?: string;        // color fijo del contorno (#rrggbb), como en el render; si no, el de la paleta o el tono
                                // más oscuro de la rampa vecina
  cell?: number;                // lado de la celda en píxeles antes de escalar (por defecto, el del icono más grande)
  scale?: number;               // escala entera de la hoja (1)
  columns?: number;             // celdas por fila (por defecto, la raíz del número de iconos, hacia arriba)
}
export interface IconSheet {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;      // fondo transparente
  cell: number;                 // lado de la celda en la hoja (ya escalado)
  icons: Record<string, { x: number; y: number; w: number; h: number; hash: string }>;   // la celda de cada id y la huella de su icono
  hash: string;                 // la huella de la hoja entera (FNV-1a de 32 bits de sus píxeles): el mismo set, la misma hoja
}

// Un icono suelto (un objeto, una criatura): el modelo pintado y centrado en una imagen de cell x cell (escalada),
// fondo transparente, con su huella
export interface Icon { size: number; rgba: Uint8ClampedArray; hash: string }

// FNV-1a de 32 bits de unos bytes, en hexadecimal
export function fnv32(bytes: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Un modelo pintado y recortado a lo que tiene (con su contorno). Se centra en x e y antes de pintar: los bloques de un
// set van de 0 a N-1, y el pivote del render es el origen
function iconOf(m: Model, o: IconOptions): { w: number; h: number; rgba: Uint8ClampedArray } {
  const b = m.bounds();
  const c = new Model(m.palette, m.name);
  const dx = b ? -Math.floor((b.minX + b.maxX + 1) / 2) : 0, dy = b ? -Math.floor((b.minY + b.maxY + 1) / 2) : 0;
  for (const [x, y, z, v] of m.entries()) c.set(x + dx, y + dy, z, v);
  const f = fitFrame(c.bounds(), o.elevation ?? 35);
  const img = render(c, { width: f.W, height: f.H, originX: f.originX, originY: f.originY, yaw: o.yaw ?? -30, elevation: o.elevation ?? 35, outline: o.outline ?? 'outer', ...(o.outlineColor ? { outlineColor: o.outlineColor } : {}) });
  let x0 = f.W, y0 = f.H, x1 = -1, y1 = -1;
  for (let y = 0; y < f.H; y++) for (let x = 0; x < f.W; x++) if (img.rgba[(y * f.W + x) * 4 + 3]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  if (x1 < 0) return { w: 0, h: 0, rgba: new Uint8ClampedArray(0) };
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.rgba.subarray(((y + y0) * f.W + x0) * 4, ((y + y0) * f.W + x0 + w) * 4), y * w * 4);
  return { w, h, rgba: out };
}

export function iconSheet(items: ReadonlyArray<{ id: string; model: Model }>, o: IconOptions = {}): IconSheet {
  if (!items.length) throw new Error('la hoja de iconos necesita al menos un modelo');
  const icons = items.map((it) => ({ id: it.id, ...iconOf(it.model, o) }));
  const need = Math.max(1, ...icons.map((i) => Math.max(i.w, i.h)));
  const cell0 = o.cell ?? need;
  const big = icons.find((i) => i.w > cell0 || i.h > cell0);
  if (big) throw new Error(`el icono "${big.id}" mide ${big.w} x ${big.h} y la celda es de ${cell0}: hace falta una celda de ${need} o más`);
  const s = Math.max(1, Math.round(o.scale ?? 1)), cell = cell0 * s;
  const cols = Math.max(1, o.columns ?? Math.ceil(Math.sqrt(items.length))), rows = Math.ceil(items.length / cols);
  const width = cols * cell, height = rows * cell, rgba = new Uint8ClampedArray(width * height * 4);
  const out: IconSheet['icons'] = {};
  icons.forEach((ic, k) => {
    const cx = (k % cols) * cell, cy = Math.floor(k / cols) * cell;
    out[ic.id] = { x: cx, y: cy, w: cell, h: cell, hash: '' };
    // Centrado en su celda, a la escala de la hoja (sin suavizar)
    const ox = cx + Math.floor((cell0 - ic.w) / 2) * s, oy = cy + Math.floor((cell0 - ic.h) / 2) * s;
    for (let y = 0; y < ic.h * s; y++) for (let x = 0; x < ic.w * s; x++) {
      const src = (Math.floor(y / s) * ic.w + Math.floor(x / s)) * 4, dst = ((oy + y) * width + ox + x) * 4;
      for (let c = 0; c < 4; c++) rgba[dst + c] = ic.rgba[src + c]!;
    }
  });
  // La huella de cada icono: los píxeles de su celda
  for (const id of Object.keys(out)) {
    const r = out[id]!, px = new Uint8ClampedArray(cell * cell * 4);
    for (let y = 0; y < cell; y++) px.set(rgba.subarray(((r.y + y) * width + r.x) * 4, ((r.y + y) * width + r.x + cell) * 4), y * cell * 4);
    r.hash = fnv32(px);
  }
  return { width, height, rgba, cell, icons: out, hash: fnv32(rgba) };
}

// Un icono suelto: lo mismo que una celda de iconSheet, para un modelo solo
export function modelIcon(model: Model, o: Omit<IconOptions, 'columns'> = {}): Icon {
  const s = iconSheet([{ id: 'icono', model }], { ...o, columns: 1 });
  return { size: s.cell, rgba: s.rgba, hash: s.icons.icono!.hash };
}
