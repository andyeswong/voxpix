import type { Model } from './model';

// Herramientas de modelado por código. Todas reciben coordenadas enteras y escriben `value` (0 borra).
// Los límites son inclusivos.

export function box(m: Model, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, value: number): void {
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) m.set(x, y, z, value);
}

// Elipsoide centrado en (cx, cy, cz), que pueden ser medios enteros (x.5) para tamaños pares
export function ellipsoid(m: Model, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, value: number): void {
  for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + ((z - cz) / rz) ** 2;
        if (d <= 1) m.set(x, y, z, value);
      }
}

// Cilindro vertical (elíptico) entre z0 y z1
export function cylinder(m: Model, cx: number, cy: number, z0: number, z1: number, rx: number, ry: number, value: number): void {
  for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++)
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) m.set(x, y, z, value);
}

// Línea 3D de vóxeles (pasos del eje dominante)
export function line(m: Model, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, value: number): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  for (let i = 0; i <= n; i++) {
    const t = n ? i / n : 0;
    m.set(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), Math.round(z0 + (z1 - z0) * t), value);
  }
}

// Copia en espejo respecto al plano x = axis (axis puede ser x.5 para modelos de ancho par).
// side: qué mitad manda; la otra se sobrescribe.
export function mirrorX(m: Model, axis: number, side: 'neg' | 'pos' = 'neg'): void {
  const src = [...m.entries()].filter(([x]) => (side === 'neg' ? x < axis : x > axis));
  for (const [x, y, z] of [...m.entries()]) if (side === 'neg' ? x > axis : x < axis) m.set(x, y, z, 0);
  for (const [x, y, z, v] of src) m.set(Math.round(2 * axis - x), y, z, v);
}

// Repinta los vóxeles que cumplen `where` (sin cambiar la forma)
export function recolor(m: Model, where: (x: number, y: number, z: number, v: number) => boolean, value: number): void {
  for (const [x, y, z, v] of [...m.entries()]) if (where(x, y, z, v)) m.set(x, y, z, value);
}
