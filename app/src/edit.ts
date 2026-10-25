// Ediciones de área, comunes a las herramientas (Caja, Cubo, Fluido > Llenar) y a la API para agentes (api.ts).
// Cada una es UN paso de deshacer (o parte del lote abierto con step) y respeta el espejo, salvo el agua.
import { key } from '@core/index';
import { model, history, editor, paint, touch } from './store';

const MAX_CELLS = 2_000_000;      // tope de una edición (un relleno que se escapa no cuelga el navegador)

// Un paso de deshacer alrededor de fn; dentro de otro (un lote de la API), se suma a ese
let depth = 0;
export function step<T>(fn: () => T): T {
  if (!depth) history.value.begin();
  depth++;
  try { return fn(); } finally { if (!--depth) { history.value.commit(); touch(); } }
}

// Rellena (o borra, con value 0) la caja entre dos esquinas, ambas incluidas. Devuelve cuántas celdas tocó.
export function fillBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, value: number): number {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)], [az, bz] = [Math.max(0, Math.min(z0, z1)), Math.max(z0, z1)];
  if ((bx - ax + 1) * (by - ay + 1) * (bz - az + 1) > MAX_CELLS) throw new Error(`caja demasiado grande (más de ${MAX_CELLS} celdas)`);
  return step(() => {
    let n = 0;
    for (let z = az; z <= bz; z++) for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) { paint(x, y, z, value); n++; }
    return n;
  });
}

// Cubo de pintura: en la capa z, desde (x, y), las celdas contiguas (4 vecinos) con el mismo valor que esa, dentro
// del lienzo, pasan a `value`. Sirve para llenar un hueco o cambiar una mancha de material.
export function floodLayer(x: number, y: number, z: number, value: number): number {
  const g = editor.grid, m = model.value;
  if (x < g.minX || x > g.maxX || y < g.minY || y > g.maxY || z < 0) return 0;
  const from = m.get(x, y, z);
  if (from === value) return 0;
  const cells: Array<[number, number]> = [];
  const seen = new Set<number>([key(x, y, z)]);
  const queue: Array<[number, number]> = [[x, y]];
  while (queue.length) {
    const [cx, cy] = queue.pop()!;
    cells.push([cx, cy]);
    if (cells.length > MAX_CELLS) throw new Error('relleno demasiado grande');
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
      if (nx < g.minX || nx > g.maxX || ny < g.minY || ny > g.maxY) continue;
      const k = key(nx, ny, z);
      if (seen.has(k) || m.get(nx, ny, z) !== from) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return step(() => { for (const [cx, cy] of cells) paint(cx, cy, z, value); return cells.length; });
}

// Agua hasta el nivel z, de una vez: desde la celda vacía (x, y, z), todas las celdas vacías conectadas (6 vecinos)
// que no pasan de esa altura, como se llenaría una cuenca. Los bordes del lienzo hacen de pared; `spill` dice si el
// agua llegó a ellos (en un lienzo cerrado se habría salido).
export function fillWater(x: number, y: number, z: number, value: number): { cells: number; spill: boolean } {
  const g = editor.grid, m = model.value;
  if (m.get(x, y, z) || z < 0 || x < g.minX || x > g.maxX || y < g.minY || y > g.maxY) return { cells: 0, spill: false };
  const cells: Array<[number, number, number]> = [];
  const seen = new Set<number>([key(x, y, z)]);
  const queue: Array<[number, number, number]> = [[x, y, z]];
  let spill = false;
  while (queue.length) {
    const c = queue.pop()!;
    cells.push(c);
    if (cells.length > MAX_CELLS) throw new Error('el agua no tiene fondo: más de 2 millones de celdas');
    const [cx, cy, cz] = c;
    if (cx === g.minX || cx === g.maxX || cy === g.minY || cy === g.maxY) spill = true;
    for (const [nx, ny, nz] of [[cx + 1, cy, cz], [cx - 1, cy, cz], [cx, cy + 1, cz], [cx, cy - 1, cz], [cx, cy, cz - 1], [cx, cy, cz + 1]] as const) {
      if (nz < 0 || nz > z || nx < g.minX || nx > g.maxX || ny < g.minY || ny > g.maxY) continue;
      const k = key(nx, ny, nz);
      if (seen.has(k) || m.get(nx, ny, nz)) continue;
      seen.add(k);
      queue.push([nx, ny, nz]);
    }
  }
  // Sin espejo: el agua va donde cabe, no donde cabría su reflejo
  step(() => { for (const [cx, cy, cz] of cells) history.value.set(cx, cy, cz, value); return cells.length; });
  return { cells: cells.length, spill };
}
