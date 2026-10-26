// Motor de escenario: SALAS que se unen en un mapa. Cada sala (un Layout generado con spec.doors) trae cuatro huecos de
// puerta cerrados, uno en el centro de cada lado. openDoors abre los que se pidan; stitchRooms pone varias salas en una
// rejilla (la disposición la decide el juego) y abre solo las puertas que dan a otra sala. PARTE PURA y determinista.
import { analyzeMasses } from '../terrain/regions';
import { NORTH, TILE, WALL, type Layout, type PlacedProp } from './generate';
import type { DoorSlot, Side } from './spec';

// Las losetas del borde que tapan un hueco (en el norte, la tapa y las dos filas de la fachada)
function doorCells(l: Layout, d: DoorSlot): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];     // x, y de la loseta y x, y de la de dentro (para su suelo)
  for (let k = d.from; k <= d.to; k++) {
    if (d.side === 'n') for (let y = 0; y < NORTH; y++) out.push([k, y, k, NORTH]);
    if (d.side === 's') out.push([k, l.rows - 1, k, l.rows - 2]);
    if (d.side === 'w') out.push([0, k, 1, k]);
    if (d.side === 'e') out.push([l.cols - 1, k, l.cols - 2, k]);
  }
  return out;
}

// Abre las puertas de esos lados (cambia el layout). Las de un lado sin hueco, error
export function openDoors(l: Layout, sides: readonly Side[]): Layout {
  for (const side of sides) {
    const d = l.doors?.find((s) => s.side === side);
    if (!d) throw new Error(`la sala no tiene hueco de puerta al ${side}: generala con spec.doors`);
    if (d.open) continue;
    for (const [x, y, ix, iy] of doorCells(l, d)) {
      const i = y * l.cols + x;
      l.wall[i] = WALL.none;
      l.floor[i] = l.floor[iy * l.cols + ix] || l.floor.find((f) => f) || 'piso';
    }
    if (side === 'n') {
      // Donde ahora hay puerta no hay fachada, ni su luz
      for (let x = d.from; x <= d.to; x++) l.facade[x] = '';
      l.sources = l.sources.filter((s) => !(s.id.startsWith('facade-') && Number(s.id.slice(7)) >= d.from && Number(s.id.slice(7)) <= d.to));
    }
    d.open = true;
  }
  return l;
}

const clone = (l: Layout): Layout => ({
  ...l, wall: l.wall.slice(), floor: [...l.floor], water: [...l.water], pillar: l.pillar.slice(), prop: l.prop.slice(),
  props: l.props.map((p) => ({ ...p })), facade: [...l.facade], sources: l.sources.map((s) => ({ ...s })), materials: l.materials.map((m) => ({ ...m })),
  ...(l.doors ? { doors: l.doors.map((d) => ({ ...d })) } : {}),
});

const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };
const STEP: Record<Side, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };

// Une salas del mismo tamaño en un mapa. gx crece hacia el este y gy hacia el SUR (como las filas del mapa). Abre las
// puertas entre salas vecinas (las dos: la pared de cada una) y deja cerradas las que dan fuera. Lo que no cubre
// ninguna sala es el vacío. La fachada decorada es la de las salas de la fila de arriba; la salida, la de la primera sala
export function stitchRooms(blocks: ReadonlyArray<{ layout: Layout; gx: number; gy: number }>): Layout {
  if (!blocks.length) throw new Error('stitchRooms: hace falta al menos una sala');
  const { cols, rows } = blocks[0]!.layout;
  const key = (gx: number, gy: number) => `${gx},${gy}`;
  const at = new Map<string, number>();
  blocks.forEach((b, k) => {
    if (b.layout.cols !== cols || b.layout.rows !== rows) throw new Error(`stitchRooms: todas las salas miden lo mismo (la ${k} mide ${b.layout.cols} x ${b.layout.rows}, la 0 ${cols} x ${rows})`);
    if (!Number.isInteger(b.gx) || !Number.isInteger(b.gy)) throw new Error(`stitchRooms: gx y gy son enteros (sala ${k})`);
    if (at.has(key(b.gx, b.gy))) throw new Error(`stitchRooms: dos salas en ${b.gx},${b.gy}`);
    at.set(key(b.gx, b.gy), k);
  });
  const gx0 = Math.min(...blocks.map((b) => b.gx)), gy0 = Math.min(...blocks.map((b) => b.gy));
  const GW = Math.max(...blocks.map((b) => b.gx)) - gx0 + 1, GH = Math.max(...blocks.map((b) => b.gy)) - gy0 + 1;
  const C = cols * GW, R = rows * GH;

  // Cada sala con sus puertas abiertas hacia las vecinas
  const rooms = blocks.map((b) => {
    const l = clone(b.layout);
    if (!l.doors) throw new Error('stitchRooms: las salas se generan con spec.doors (traen sus huecos de puerta)');
    const sides = (['n', 's', 'e', 'w'] as const).filter((s) => at.has(key(b.gx + STEP[s][0], b.gy + STEP[s][1])));
    return openDoors(l, sides);
  });

  const wall = new Uint8Array(C * R).fill(WALL.outside);
  const floor = new Array<string>(C * R).fill('');
  const water = Array.from({ length: R }, () => '.'.repeat(C).split(''));
  const pillar = new Uint8Array(C * R), prop = new Uint8Array(C * R);
  const facade = new Array<string>(C).fill('');
  const props: PlacedProp[] = [], sources: Layout['sources'] = [], materials: Layout['materials'] = [];
  const doors: Array<DoorSlot & { block: number }> = [];
  const placed: NonNullable<Layout['blocks']> = [];
  let propN = 0;
  rooms.forEach((l, k) => {
    const b = blocks[k]!, ox = (b.gx - gx0) * cols, oy = (b.gy - gy0) * rows;
    placed.push({ gx: b.gx, gy: b.gy, x0: ox, y0: oy });
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x, j = (oy + y) * C + ox + x;
      wall[j] = l.wall[i]!; floor[j] = l.floor[i]!; pillar[j] = l.pillar[i]!; prop[j] = l.prop[i]!;
      water[oy + y]![ox + x] = l.water[y]![x]!;
    }
    // La fila de arriba lleva su fachada decorada (y sus luces); las de abajo, la pared lisa
    if (oy === 0) {
      for (let x = 0; x < cols; x++) facade[ox + x] = l.facade[x] ?? '';
      for (const s of l.sources) if (s.id.startsWith('facade-')) sources.push({ ...s, id: `facade-${Number(s.id.slice(7)) + ox}`, x: s.x + ox * TILE });
    }
    for (const s of l.sources) if (!s.id.startsWith('facade-')) sources.push({ ...s, id: `prop-${propN++}`, x: s.x + ox * TILE, y: s.y + oy * TILE });
    for (const p of l.props) props.push({ ...p, x: p.x + ox, y: p.y + oy });
    for (const m of l.materials) materials.push({ x: m.x + ox * TILE, y: m.y + oy * TILE });
    for (const d of l.doors!) doors.push({ ...d, block: k, from: d.from + (d.side === 'n' || d.side === 's' ? ox : oy), to: d.to + (d.side === 'n' || d.side === 's' ? ox : oy) });
  });
  // Las puertas de las dos salas tienen que encontrarse: misma posición a lo largo del lado
  for (const d of doors) if (d.open) {
    const o = doors.find((e) => e.block !== d.block && e.side === OPPOSITE[d.side] && e.from === d.from && e.open);
    if (!o) throw new Error(`stitchRooms: la puerta ${d.side} de la sala ${d.block} no coincide con la de su vecina`);
  }
  const first = rooms[0]!, f0 = placed[0]!;
  const waterRows = water.map((r) => r.join(''));
  const masses = analyzeMasses(C, R, (x, y) => waterRows[y]![x] === '~', { edgeIsMember: false });
  return {
    seed: first.seed, cols: C, rows: R, caps: first.caps, wall, floor, water: waterRows, masses, pillar, props, prop, facade, sources, materials,
    spawn: { x: first.spawn.x + f0.x0 * TILE, y: first.spawn.y + f0.y0 * TILE }, doors, blocks: placed,
  };
}
