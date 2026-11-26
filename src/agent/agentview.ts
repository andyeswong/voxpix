// LA VISTA DEL AGENTE EN COLOR: lo mismo que lee un agente con AgentHost.describe (capas por z, una letra por celda),
// con cada letra del color de su bloque, para enseñarlo al lado del juego. No añade nada a lo que el agente sabe: las
// letras son las de describe, y el color solo ayuda a quien mira.
//
//   const d = agent.describe({ radius: 8, below: 1, above: 0 });
//   const v = agentView(agent, d);                         // JSON: por capa, filas de celdas { ch, color, dim, kind }
//   const { width, height } = agentViewSize(v, { cell: 16 });
//   paintAgentView(canvas.getContext('2d')!, v, { cell: 16 });
//
// El color de un bloque es el más repetido en las caras de arriba de su modelo (lo que se ve desde encima), o el que se
// diga en colors. Lo que no se ve desde la cámara (minúscula en describe) va con su color apagado hacia el fondo; el aire,
// un punto tenue; las marcas (@ el jugador, * las entidades, las del juego) con su propio color.
import { decode, rgbOf } from '../core';
import type { BlockDef, BlockSet } from '../world/blocks';
import type { AgentHost, Description, Vec3 } from './agent';

export type AgentCellKind = 'block' | 'air' | 'mark' | 'out';
export interface AgentViewCell { ch: string; color: string; dim: boolean; kind: AgentCellKind; id?: string }
export interface AgentView {
  center: Vec3;
  x: [number, number]; y: [number, number];
  layers: Array<{ bz: number; rows: AgentViewCell[][] }>;   // como describe: de arriba abajo, filas de norte a sur
  legend: Array<{ ch: string; id: string; color: string }>;
  background: string;
}
export interface AgentViewOptions {
  colors?: Record<string, string>;   // color fijo por id de bloque ('#rrggbb')
  marks?: Record<string, string>;    // color por carácter de marca (por defecto @ amarillo, * rojo, el resto naranja)
  air?: string;                      // el color del aire ('#3a4049')
  background?: string;               // el fondo, hacia el que se apaga lo que no se ve ('#0b0d10')
  dim?: number;                      // 0..1: cuánto se apaga lo que no se ve (0,6)
}
export interface PaintAgentViewOptions {
  cell?: number;                     // lado de una celda en píxeles (16)
  font?: string;                     // la familia de la letra ('monospace'); el tamaño sale de cell
  gap?: number;                      // celdas de separación entre capas (1)
  across?: number;                   // capas por fila del dibujo (1: una debajo de otra)
  labels?: boolean;                  // una línea "z N" encima de cada capa (sí)
  labelColor?: string;               // su color ('#8a929c')
}
// Lo mínimo de un CanvasRenderingContext2D que hace falta para pintar
export interface AgentViewCtx {
  fillStyle: string | CanvasGradient | CanvasPattern;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
}

const MARKS: Record<string, string> = { '@': '#ffd84a', '*': '#ff5a5a' };
const MARK_OTHER = '#ff9f40', AIR = '#3a4049', BACKGROUND = '#0b0d10', DIM = 0.6, LABEL = '#8a929c', GREY = '#808080';

const hex2 = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
// a mezclado hacia b en una parte t (0: a, 1: b), en '#rrggbb'
export function mixColor(a: string, b: string, t: number): string {
  const p = rgbOf(a), q = rgbOf(b);
  return `#${hex2(p[0] + (q[0] - p[0]) * t)}${hex2(p[1] + (q[1] - p[1]) * t)}${hex2(p[2] + (q[2] - p[2]) * t)}`;
}

// El color de un bloque: el más repetido en las caras de arriba de su modelo (el vóxel más alto de cada columna); a
// igualdad, el que va antes en la paleta. Un modelo vacío, gris
export function blockColor(def: BlockDef): string {
  const top = new Map<number, [number, number]>();          // columna -> [z, valor]
  for (const [x, y, z, v] of def.model.entries()) {
    const k = y * 65536 + x, t = top.get(k);
    if (!t || z > t[0]) top.set(k, [z, v]);
  }
  const count = new Map<number, number>();
  for (const [, v] of top.values()) count.set(v, (count.get(v) ?? 0) + 1);
  let best = 0, n = 0;
  for (const [v, c] of count) if (c > n || (c === n && v < best)) { best = v; n = c; }
  if (!best) return GREY;
  const { ramp, tone } = decode(best), r = def.model.palette.ramps[ramp];
  const c = r?.colors[tone];
  return c ? normal(c) : GREY;
}
const normal = (c: string): string => { const [r, g, b] = rgbOf(c); return `#${hex2(r)}${hex2(g)}${hex2(b)}`; };

const colorCache = new WeakMap<BlockSet, Map<string, string>>();
function colorOfId(set: BlockSet, id: string): string {
  let m = colorCache.get(set);
  if (!m) colorCache.set(set, (m = new Map()));
  let c = m.get(id);
  if (c === undefined) { c = blockColor(set.get(set.index(id))); m.set(id, c); }
  return c;
}

// Lo que describe dio, en celdas con color. Las letras son las mismas, una a una (agentViewText lo devuelve igual)
export function agentView(host: AgentHost, d: Description, o: AgentViewOptions = {}): AgentView {
  const set = host.opts.grid.blocks, bg = o.background ?? BACKGROUND, dim = Math.max(0, Math.min(1, o.dim ?? DIM));
  const air = o.air ?? AIR, markColors = { ...MARKS, ...(o.marks ?? {}) };
  const idOf = new Map(Object.entries(d.legend));
  const color = (id: string) => (o.colors?.[id] !== undefined ? normal(o.colors[id]!) : colorOfId(set, id));
  const marked = new Set(d.marks.filter((m) => m.cell).map((m) => m.cell!.join(',')));
  const layers = d.layers.map((L) => ({
    bz: L.bz,
    rows: L.rows.map((row, i) => [...row].map((ch, j): AgentViewCell => {
      const by = d.y[1] - i, bx = d.x[0] + j;
      if (ch === ' ') return { ch, color: bg, dim: false, kind: 'out' };
      if (marked.has(`${bx},${by},${L.bz}`)) return { ch, color: markColors[ch] ?? MARK_OTHER, dim: false, kind: 'mark' };
      if (ch === '.') return { ch, color: air, dim: false, kind: 'air' };
      const id = idOf.get(ch.toUpperCase());
      if (!id) return { ch, color: GREY, dim: false, kind: 'block' };       // ('?': un bloque sin letra libre)
      const hidden = ch !== ch.toUpperCase();
      const c = color(id);
      return { ch, color: hidden ? mixColor(c, bg, dim) : c, dim: hidden, kind: 'block', id };
    })),
  }));
  const legend = Object.entries(d.legend).map(([ch, id]) => ({ ch, id, color: color(id) }));
  return { center: d.center, x: d.x, y: d.y, layers, legend, background: bg };
}

// Las letras de la vista, capa por capa (las filas de describe, sin cabeceras)
export function agentViewText(v: AgentView): string[][] {
  return v.layers.map((L) => L.rows.map((r) => r.map((c) => c.ch).join('')));
}

const layout = (v: AgentView, o: PaintAgentViewOptions) => {
  const cell = Math.max(1, Math.floor(o.cell ?? 16)), gap = Math.max(0, Math.floor(o.gap ?? 1)), labels = o.labels ?? true;
  const across = Math.max(1, Math.floor(o.across ?? 1));
  const cols = v.x[1] - v.x[0] + 1, rows = v.y[1] - v.y[0] + 1, head = labels ? 1 : 0;
  const bw = cols * cell, bh = (rows + head) * cell, n = v.layers.length;
  const per = Math.min(across, Math.max(1, n)), lines = Math.ceil(n / per);
  return { cell, gap, labels, per, bw, bh, head, width: per * bw + (per - 1) * gap * cell, height: lines * bh + (lines - 1) * gap * cell };
};

// El tamaño en píxeles de lo que pinta paintAgentView con esas opciones
export function agentViewSize(v: AgentView, o: PaintAgentViewOptions = {}): { width: number; height: number } {
  const { width, height } = layout(v, o);
  return { width, height };
}

// Pinta la vista desde (0, 0): el fondo, y cada capa con su "z N" encima y una letra por celda, centrada en ella
export function paintAgentView(ctx: AgentViewCtx, v: AgentView, o: PaintAgentViewOptions = {}): { width: number; height: number } {
  const L = layout(v, o), { cell } = L;
  ctx.fillStyle = v.background;
  ctx.fillRect(0, 0, L.width, L.height);
  ctx.font = `${Math.max(1, Math.round(cell * 0.8))}px ${o.font ?? 'monospace'}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  v.layers.forEach((layer, k) => {
    const x0 = (k % L.per) * (L.bw + L.gap * cell), y0 = Math.floor(k / L.per) * (L.bh + L.gap * cell);
    if (L.labels) {
      ctx.fillStyle = o.labelColor ?? LABEL;
      ctx.textAlign = 'left';
      ctx.fillText(`z ${layer.bz}`, x0, y0 + cell / 2);
      ctx.textAlign = 'center';
    }
    layer.rows.forEach((row, i) => row.forEach((c, j) => {
      if (c.kind === 'out') return;
      ctx.fillStyle = c.color;
      ctx.fillText(c.kind === 'air' ? '·' : c.ch, x0 + (j + 0.5) * cell, y0 + (i + L.head + 0.5) * cell);
    }));
  });
  return { width: L.width, height: L.height };
}
