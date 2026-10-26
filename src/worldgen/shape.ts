// Motor de escenario: la FORMA de la sala (spec.shape). Marca como pared las losetas del interior que no son suelo:
// L, T, salas con pasillos, laberinto o un plano en texto. PARTE PURA y determinista: su azar es propio (con la semilla
// del mapa), así un mapa sin forma gasta el azar del generador igual que siempre. Después, el suelo que no tenga camino
// a la zona más grande se cierra: todo el suelo queda conectado.
import { createRng } from '../sim/rng';
import type { ShapeSpec } from './spec';

// wall: 0 = suelo; lo demás, pared. El interior jugable es x 1..cols-2, y north..rows-2 (filas hacia el sur). Al final,
// lo que no toca el suelo (ni en diagonal) pasa a `outside`: el vacío. Así las paredes siguen la forma, de una loseta de
// grueso, en vez de dejar bloques macizos; la fachada norte (filas 0..north-1) solo queda sobre las columnas que dan a la sala
export function applyShape(shape: ShapeSpec, wall: Uint8Array, cols: number, rows: number, north: number, seed: number, cap: number, outside: number): void {
  const at = (x: number, y: number) => y * cols + x;
  const x0 = 1, x1 = cols - 2, y0 = north, y1 = rows - 2;
  const iw = x1 - x0 + 1, ih = y1 - y0 + 1;
  const block = (ax: number, ay: number, bx: number, by: number) => {
    for (let y = Math.max(y0, ay); y <= Math.min(y1, by); y++) for (let x = Math.max(x0, ax); x <= Math.min(x1, bx); x++) wall[at(x, y)] = cap;
  };
  const carve = (ax: number, ay: number, bx: number, by: number) => {
    for (let y = Math.max(y0, Math.min(ay, by)); y <= Math.min(y1, Math.max(ay, by)); y++) for (let x = Math.max(x0, Math.min(ax, bx)); x <= Math.min(x1, Math.max(ax, bx)); x++) wall[at(x, y)] = 0;
  };
  const frac = (v: number | undefined, def: number, what: string) => {
    const f = v ?? def;
    if (!(f > 0 && f < 1)) throw new Error(`shape ${shape.kind}: ${what} es una fracción entre 0 y 1 (sin incluirlos)`);
    return f;
  };
  const rng = createRng(seed * 2654435761 + 97);

  switch (shape.kind) {
    case 'L': {
      const f = frac(shape.size, 0.45, 'size');
      const w = Math.max(1, Math.round(iw * f)), h = Math.max(1, Math.round(ih * f));
      const c = shape.corner ?? 'ne';
      const east = c === 'ne' || c === 'se', top = c === 'ne' || c === 'nw';
      block(east ? x1 - w + 1 : x0, top ? y0 : y1 - h + 1, east ? x1 : x0 + w - 1, top ? y0 + h - 1 : y1);
      break;
    }
    case 'T': {
      const bd = Math.max(2, Math.round(ih * frac(shape.barDepth, 0.4, 'barDepth')));
      const sw = Math.max(2, Math.round(iw * frac(shape.stem, 0.3, 'stem')));
      const sx0 = x0 + Math.floor((iw - sw) / 2), sx1 = sx0 + sw - 1;
      const north = (shape.bar ?? 'north') === 'north';
      const ay = north ? y0 + bd : y0, by = north ? y1 : y1 - bd;
      block(x0, ay, sx0 - 1, by);
      block(sx1 + 1, ay, x1, by);
      break;
    }
    case 'corridors': {
      const n = Math.max(2, Math.round(shape.rooms ?? 5)), cw = Math.max(1, Math.round(shape.width ?? 3));
      block(x0, y0, x1, y1);
      const rooms: Array<[number, number, number, number]> = [];
      for (let tries = 0; tries < 400 && rooms.length < n; tries++) {
        const w = 5 + Math.floor(rng() * Math.max(1, Math.min(9, iw / 3))), h = 4 + Math.floor(rng() * Math.max(1, Math.min(6, ih / 3)));
        if (w > iw || h > ih) continue;
        const rx = x0 + Math.floor(rng() * (iw - w + 1)), ry = y0 + Math.floor(rng() * (ih - h + 1));
        if (rooms.some(([ax, ay, bx, by]) => rx <= bx + 2 && rx + w - 1 >= ax - 2 && ry <= by + 2 && ry + h - 1 >= ay - 2)) continue;
        rooms.push([rx, ry, rx + w - 1, ry + h - 1]);
      }
      if (!rooms.length) rooms.push([x0, y0, x1, y1]);
      // De izquierda a derecha, cada sala con la siguiente por un pasillo en L (primero en horizontal o en vertical)
      rooms.sort((a, b) => a[0] - b[0]);
      for (const [ax, ay, bx, by] of rooms) carve(ax, ay, bx, by);
      const half = (cw - 1) >> 1;
      for (let k = 1; k < rooms.length; k++) {
        const a = rooms[k - 1]!, b = rooms[k]!;
        const ax = (a[0] + a[2]) >> 1, ay = (a[1] + a[3]) >> 1, bx = (b[0] + b[2]) >> 1, by = (b[1] + b[3]) >> 1;
        if (rng() < 0.5) { carve(ax, ay - half, bx, ay - half + cw - 1); carve(bx - half, ay, bx - half + cw - 1, by); }
        else { carve(ax - half, ay, ax - half + cw - 1, by); carve(ax, by - half, bx, by - half + cw - 1); }
      }
      break;
    }
    case 'maze': {
      const cell = Math.max(2, Math.round(shape.cell ?? 4)), p = cell - 1;
      const loops = shape.loops ?? 0.1;
      if (!(loops >= 0 && loops <= 1)) throw new Error('shape maze: loops es una fracción entre 0 y 1');
      const mx = Math.floor((iw + 1) / cell), my = Math.floor((ih + 1) / cell);
      if (mx < 2 || my < 2) throw new Error(`shape maze: con cell ${cell} no caben dos celdas por lado en un interior de ${iw} x ${ih}`);
      block(x0, y0, x1, y1);
      // El laberinto pegado al borde del interior; las celdas de la última columna y la última fila se ensanchan hasta
      // el borde (así su pared de fuera es la del mapa, y la fachada norte sigue tocando el suelo)
      const cellRect = (i: number, j: number) => [x0 + i * cell, y0 + j * cell,
        i === mx - 1 ? x1 : x0 + i * cell + p - 1, j === my - 1 ? y1 : y0 + j * cell + p - 1] as const;
      const open = (i: number, j: number, di: number, dj: number) => {
        const [ax, ay, bx, by] = cellRect(i, j);
        if (di === 1) carve(bx + 1, ay, bx + 1, by); else if (di === -1) carve(ax - 1, ay, ax - 1, by);
        else if (dj === 1) carve(ax, by + 1, bx, by + 1); else carve(ax, ay - 1, bx, ay - 1);
      };
      const seen = new Uint8Array(mx * my);
      const stack: Array<[number, number]> = [[Math.floor(rng() * mx), Math.floor(rng() * my)]];
      seen[stack[0]![1] * mx + stack[0]![0]] = 1;
      for (let i = 0; i < mx; i++) for (let j = 0; j < my; j++) { const [ax, ay, bx, by] = cellRect(i, j); carve(ax, ay, bx, by); }
      const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
      while (stack.length) {
        const [i, j] = stack[stack.length - 1]!;
        const next = DIRS.filter(([di, dj]) => { const a = i + di, b = j + dj; return a >= 0 && b >= 0 && a < mx && b < my && !seen[b * mx + a]; });
        if (!next.length) { stack.pop(); continue; }
        const [di, dj] = next[Math.floor(rng() * next.length)]!;
        open(i, j, di, dj);
        seen[(j + dj) * mx + i + di] = 1;
        stack.push([i + di, j + dj]);
      }
      // Vueltas: abre al azar una parte de las paredes entre celdas que quedaron cerradas
      for (let i = 0; i < mx; i++) for (let j = 0; j < my; j++) for (const [di, dj] of [[1, 0], [0, 1]] as const) {
        if (i + di >= mx || j + dj >= my) continue;
        if (rng() < loops) open(i, j, di, dj);
      }
      break;
    }
    case 'plan': {
      const r = shape.rows;
      if (!Array.isArray(r) || r.length !== rows || r.some((line) => typeof line !== 'string' || line.length !== cols))
        throw new Error(`shape plan: hacen falta ${rows} filas de ${cols} caracteres ('#' pared, lo demás suelo); el borde y la fachada norte son pared siempre`);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (r[y]![x] === '#') wall[at(x, y)] = cap;
      break;
    }
    default:
      throw new Error(`no hay forma "${(shape as { kind: string }).kind}"; las formas son: L, T, corridors, maze, plan`);
  }

  // Todo el suelo conectado: se queda la zona más grande y se cierran las demás
  const region = new Int32Array(cols * rows).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const s = at(x, y);
    if (wall[s] || region[s] !== -1) continue;
    let size = 0;
    const q = [s];
    region[s] = id;
    while (q.length) {
      const c = q.pop()!;
      size++;
      const cx = c % cols;
      for (const n of [cx > 0 ? c - 1 : -1, cx < cols - 1 ? c + 1 : -1, c - cols, c + cols]) {
        if (n < 0 || n >= wall.length || wall[n] || region[n] !== -1) continue;
        region[n] = id;
        q.push(n);
      }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  if (best < 0) throw new Error(`shape ${shape.kind}: no queda suelo`);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (!wall[at(x, y)] && region[at(x, y)] !== best) wall[at(x, y)] = cap;

  // El vacío: las losetas de pared sin suelo en sus 8 vecinas. Las filas de la fachada van por columnas: la columna
  // entera (tapa y fachada) se queda si su última fila toca el suelo
  const touches = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && wall[at(nx, ny)] === 0) return true;
    }
    return false;
  };
  const out = new Uint8Array(cols * rows);
  for (let y = north; y < rows; y++) for (let x = 0; x < cols; x++) if (wall[at(x, y)] && !touches(x, y)) out[at(x, y)] = 1;
  for (let x = 0; x < cols; x++) if (!touches(x, north - 1)) for (let y = 0; y < north; y++) out[at(x, y)] = 1;
  for (let i = 0; i < out.length; i++) if (out[i]) wall[i] = outside;
}
