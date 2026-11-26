// INTERFAZ PARA AGENTES: leer el mundo de bloques como texto y dar órdenes con resultado, sin coordenadas de
// pantalla ni ratón. Para pruebas de juego por agentes, para reproducir fallos ("pica X y mira si Y") y para arneses de
// medida. Genérica: el motor pone lo que sabe (la rejilla, lo que se ve, el alcance, los ticks) y el juego registra
// sus órdenes (picar, poner, elegir hueco...) con sus reglas y sus mensajes.
//
//   const agent = new AgentHost({ state, grid, look: () => ({ view, baked, section }), player: () => p, sim: runtime });
//   agent.register('picar', (a) => agent.check(cell(a), { reach: 24, visible: true }) ?? juegoPica(a), 'picar {cell}');
//   installAgent(window, agent);                       // window.voxpixAgent, solo si se pide
//   agent.describe({ at: p, radius: 6 }).text            // capas por z, una letra por celda
//   agent.act('picar', { cell: [86, 70, 6] })            // { ok: false, msg: 'fuera de alcance (30,2 > 24)' }
//   agent.step(10)                                       // 10 ticks, sin reloj
//   agent.entityAt(sx, sy)                               // la entidad que se pinta en ese píxel, o nada
//   agent.goTo({ cell: [86, 70, 6] })                    // andar con los caminos del motor (paths): llegó, o por qué no
//
// Todo lo que devuelve es JSON (objetos y arrays planos). docs/motor.md, "Interfaz para agentes".
import type { WorldState } from '../world/state';
import type { BlockGrid } from '../world/blocks';
import { pickVoxel } from '../world/blocks';
import { unkey } from '../core';
import { WATER_CELL } from '../world/water';
import type { WorldView } from '../world/view';
import type { Baked } from '../world/bake';
import type { SectionLayer } from '../world/section';
import { NO_INPUT, type Steppable, type TickInput } from '../runtime/runtime';
import { sectionAt } from '../world/section';
import { entitySprite, type Frame2DOptions } from '../world/frame2d';
import type { LevelPathField, LevelPoint } from '../world/levelpaths';

export type Vec3 = [number, number, number];
export interface Point { x: number; y: number; z: number }

// Lo que se ve en este cuadro: la vista, su imagen horneada y la capa de sección con que se compone (si la hay)
// (frame: las opciones con que se compone el cuadro; entityAt las usa para el sprite de cada entidad: el contorno cambia
// su borde. Sin ellas, el contorno del horneado)
export interface AgentLook { view: WorldView; baked: Baked; section?: SectionLayer | null; frame?: Partial<Frame2DOptions> }

// Una marca en el texto: un carácter en la celda de sus pies, con su posición exacta en vóxeles
export interface AgentMark { ch: string; x: number; y: number; z: number; name?: string }

export interface AgentResult { ok: boolean; msg: string; [k: string]: unknown }
export type AgentAction = (args: Record<string, unknown>, host: AgentHost) => AgentResult;

export interface AgentHostOptions {
  state: WorldState;
  grid: BlockGrid;
  look?: () => AgentLook | null;           // sin ella, no se sabe qué se ve (visible y probe contestan que no hay vista)
  player?: () => Point | null;             // el cuerpo del jugador: marca '@' y origen del alcance
  marks?: () => AgentMark[];               // marcas del juego (enemigos, objetos), además de las entidades
  sim?: Steppable;                         // lo que avanza step(n) (Runtime o la partida de un juego)
  letters?: Record<string, string>;        // letra fija por id de bloque (el resto se reparte solo)
  entities?: boolean;                      // marcar las entidades del mundo con '*' (por defecto sí, salvo la del jugador)
  playerEntity?: number | string | null;   // la entidad que dibuja al jugador (no se marca dos veces)
  paths?: LevelPathField;                  // los caminos para goTo (con su cuerpo: radio, alto, escalón)
  // La letra del agua de la capa de agua del mundo (state.water) en una celda de aire: '~', o '≈' si '~' ya es la de un
  // bloque; false: sin agua (las celdas con agua salen como aire)
  water?: string | false;
}

// A dónde ir: una celda de la rejilla (encima si es sólida, en su suelo si es aire), lo que se ve en un píxel (encima del
// vóxel) o un punto del mundo
export type GoToTarget = { cell: Vec3 } | { pixel: [number, number] } | { point: Point };
export interface GoToOptions { maxTicks?: number; near?: number; stuckTicks?: number }

export interface DescribeOptions {
  at?: Point;                // el centro, en vóxeles del mundo (por defecto, el jugador)
  radius?: number;           // celdas a cada lado en x e y (4)
  below?: number;            // capas por debajo de la del centro (2)
  above?: number;            // capas por encima (1)
  visible?: boolean;         // minúscula lo que no se ve desde la cámara de ahora (por defecto, si hay look)
}

export interface Description {
  center: Vec3;                                   // la celda del centro
  x: [number, number]; y: [number, number];       // celdas que cubre (incluidas)
  layers: Array<{ bz: number; rows: string[] }>;  // de arriba abajo; cada fila de oeste a este, las filas de norte a sur
  legend: Record<string, string>;                 // letra -> id de bloque
  marks: Array<AgentMark & { cell: Vec3 | null }>;
  visible: boolean;                               // si las minúsculas dicen algo (hubo vista)
  water?: string;                                 // la letra del agua, si sale alguna celda con agua
  text: string;
}

export interface CellSight { cell: Vec3; faces: Array<{ face: Vec3; px: number }>; px: number }

const AIR = '.', OUT = ' ';
const RESERVED = new Set([AIR, OUT, '@', '*', '?']);

export class AgentHost {
  private readonly actions = new Map<string, { fn: AgentAction; help: string }>();
  private letterOf: string[] = [];                 // por índice de bloque (0 = aire)
  private readonly idOf = new Map<string, string>();
  private readonly waterCh: string | null;

  constructor(readonly opts: AgentHostOptions) {
    const set = opts.grid.blocks, fixed = opts.letters ?? {}, used = new Set<string>(RESERVED);
    for (const [id, ch] of Object.entries(fixed)) {
      if (ch.length !== 1 || used.has(ch)) throw new Error(`letra "${ch}" para "${id}": tiene que ser un carácter y no estar usado (reservados: ${[...RESERVED].join(' ')})`);
      used.add(ch); used.add(ch.toLowerCase());
    }
    this.letterOf = [AIR];
    for (let i = 1; i <= set.count; i++) {
      const id = set.get(i).id;
      let ch = fixed[id];
      if (ch === undefined) {
        const cands = [...id.toUpperCase().replace(/[^A-Z0-9]/g, ''), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&$+=<>^~'];
        ch = cands.find((c) => !used.has(c) && !used.has(c.toLowerCase())) ?? '?';
        if (ch !== '?') { used.add(ch); used.add(ch.toLowerCase()); }
      }
      this.letterOf[i] = ch;
      if (ch !== '?') this.idOf.set(ch, id);
    }
    // (después de repartir las letras de los bloques, para no mover ninguna)
    const w = opts.water;
    if (w === false) this.waterCh = null;
    else if (w !== undefined) {
      if (w.length !== 1 || used.has(w) || used.has(w.toLowerCase())) throw new Error(`letra del agua "${w}": tiene que ser un carácter y no estar usado`);
      this.waterCh = w;
    } else this.waterCh = used.has('~') ? '≈' : '~';
  }

  // ---- leer

  // La letra de un tipo de bloque (0 = aire)
  letter(type: number): string { return this.letterOf[type] ?? '?'; }

  // Lo que se ve en este cuadro, por celda: qué caras y cuántos píxeles. Sale de pickVoxel en cada píxel (lo mismo que
  // pickBlock): una celda está aquí si y solo si algún píxel la pica. rect limita la búsqueda a un recuadro de la imagen
  visibleCells(rect?: { x0: number; y0: number; x1: number; y1: number }): Map<string, CellSight> | null {
    const look = this.opts.look?.();
    if (!look) return null;
    const { view, baked, section } = look, grid = this.opts.grid, out = new Map<string, CellSight>();
    const x0 = Math.max(0, rect?.x0 ?? 0), y0 = Math.max(0, rect?.y0 ?? 0);
    const x1 = Math.min(baked.width - 1, rect?.x1 ?? baked.width - 1), y1 = Math.min(baked.height - 1, rect?.y1 ?? baked.height - 1);
    for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
      const p = pickVoxel(view, baked, sx, sy, section);
      const cell = p && grid.cellOf(p.voxel[0], p.voxel[1], p.voxel[2]);
      if (!cell) continue;
      const k = cell.join(',');
      let c = out.get(k);
      if (!c) out.set(k, (c = { cell, faces: [], px: 0 }));
      c.px++;
      const f = c.faces.find((e) => e.face[0] === p.face[0] && e.face[1] === p.face[1] && e.face[2] === p.face[2]);
      if (f) f.px++; else c.faces.push({ face: p.face, px: 1 });
    }
    return out;
  }

  // Las celdas que se ven en un recuadro de la imagen (las mismas que visibleCells en él, sin contar caras ni píxeles): un
  // vóxel se mira una vez aunque lo pinten muchos píxeles
  private seenIn(look: AgentLook, rect: { x0: number; y0: number; x1: number; y1: number }): Set<string> {
    const { view, baked, section } = look, grid = this.opts.grid, out = new Set<string>(), done = new Set<number>();
    const W = baked.width, x0 = Math.max(0, rect.x0), y0 = Math.max(0, rect.y0), x1 = Math.min(W - 1, rect.x1), y1 = Math.min(baked.height - 1, rect.y1);
    let last = NaN;
    for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
      const q = section ? sectionAt(section, sx, sy) : -1;
      const k = q >= 0 ? section!.pick[q]! : baked.pick[sy * W + sx]!, f = q >= 0 ? section!.face[q]! : baked.face[sy * W + sx]!;
      if (Number.isNaN(k) || f < 0 || k === last) continue;
      last = k;
      if (done.has(k)) continue;
      done.add(k);
      const [vx, vy, z] = unkey(k), [x, y] = view.camera.cellToWorld(vx, vy);
      const cell = grid.cellOf(x, y, z);
      if (cell) out.add(`${cell[0]},${cell[1]},${cell[2]}`);
    }
    return out;
  }

  // El recuadro de la imagen por el que pasa una caja de celdas (lo que se ve de ellas no sale de ahí), con margen
  private regionRect(look: AgentLook, bx0: number, by0: number, bz0: number, bx1: number, by1: number, bz1: number): { x0: number; y0: number; x1: number; y1: number } {
    const g = this.opts.grid, N = g.N, o = g.origin, cam = look.view.camera, M = 3;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const wx of [o.x + bx0 * N, o.x + (bx1 + 1) * N - 1]) for (const wy of [o.y + by0 * N, o.y + (by1 + 1) * N - 1]) {
      const [vx, vy] = cam.cellToView(wx, wy);
      for (const z of [o.z + bz0 * N, o.z + (bz1 + 1) * N]) for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const [sx, sy] = look.baked.cam.project(vx + dx, vy + dy, z);
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
    }
    return { x0: Math.floor(x0) - M, y0: Math.floor(y0) - M, x1: Math.ceil(x1) + M, y1: Math.ceil(y1) + M };
  }

  // Lo que hay bajo el píxel (sx, sy) de la imagen horneada: el vóxel, la celda, la cara y el bloque (lo que se pinta)
  probe(sx: number, sy: number): AgentResult {
    const look = this.opts.look?.();
    if (!look) return { ok: false, msg: 'no hay vista' };
    const p = pickVoxel(look.view, look.baked, sx, sy, look.section);
    if (!p) return { ok: false, msg: 'nada en ese píxel' };
    const grid = this.opts.grid, cell = grid.cellOf(p.voxel[0], p.voxel[1], p.voxel[2]);
    const type = cell ? grid.get(cell[0], cell[1], cell[2]) : 0;
    return { ok: true, msg: cell ? `${type ? grid.blocks.get(type).id : 'aire'} ${cell.join(',')}` : 'fuera de la rejilla', voxel: p.voxel, face: p.face, cell, block: type ? grid.blocks.get(type).id : null };
  }

  // La distancia (en vóxeles) de un punto a la caja de una celda, y si está a r o menos. Sin punto, desde el jugador
  reach(cell: Vec3, r: number, from?: Point | null): AgentResult {
    const p = from ?? this.opts.player?.() ?? null;
    if (!p) return { ok: false, msg: 'no hay jugador', distance: null };
    const b = this.opts.grid.box(cell[0], cell[1], cell[2]);
    const d = Math.hypot(gap(p.x, b.x0, b.x1 + 1), gap(p.y, b.y0, b.y1 + 1), gap(p.z, b.z0, b.z1 + 1));
    const ok = d <= r;
    return { ok, msg: ok ? 'al alcance' : `fuera de alcance (${fmt(d)} > ${r})`, distance: d };
  }

  // La entidad que se pinta en el píxel (sx, sy) de la imagen horneada (la más cercana de las que lo cubren y no quedan
  // detrás de lo pintado ahí: el escenario o, donde la sección sustituye, lo que pinta ella; la misma regla que el
  // cuadro, frame2D), o nada. Cuenta el escenario y las entidades; no el agua ni los efectos, que van encima
  entityAt(sx: number, sy: number): AgentResult {
    const look = this.opts.look?.();
    if (!look) return { ok: false, msg: 'no hay vista' };
    const { view, baked, section } = look, rs = view.frame();
    if (sx < 0 || sy < 0 || sx >= baked.width || sy >= baked.height) return { ok: false, msg: 'fuera de la imagen' };
    const q = section ? sectionAt(section, sx, sy) : -1;
    const ground = q >= 0 ? section!.depth[q]! : baked.depth[sy * baked.width + sx]!;
    const o = { vx: 0, vy: 0, vw: baked.width, vh: baked.height, outline: baked.options.outline, ...(look.frame ?? {}) } as Frame2DOptions;
    let best: { id: unknown; depth: number } | null = null;
    for (const e of rs.entities) {
      if (e.ghost !== undefined) continue;
      const d = entitySprite(baked, e, o), i = sx - d.offX, j = sy - d.offY, W = d.img.width, H = d.img.height;
      if (i < 0 || j < 0 || i >= W || j >= H || !d.img.rgba[(j * W + i) * 4 + 3]) continue;
      const depth = Math.fround(d.img.depth[j * W + i]! + Math.fround(d.dOff));
      // (lo de delante la tapa: como frame2D, delante si queda al menos 0,5 por delante de lo pintado)
      if (depth >= ground - 0.5) continue;
      if (!best || depth < best.depth) best = { id: e.id, depth };
    }
    if (!best) return { ok: false, msg: 'ninguna entidad en ese píxel' };
    const e = this.opts.state.entities.get(best.id as never);
    return { ok: true, msg: `entidad ${String(best.id)}`, id: best.id, at: e ? [e.x, e.y, e.z] : null };
  }

  // Andar hasta un sitio con los caminos del motor (opts.paths) y la simulación (opts.sim: la entrada de cada tick es la
  // dirección del camino, como si fueran los mandos), tick a tick hasta llegar (a `near` vóxeles), quedarse sin camino,
  // atascarse (`stuckTicks` sin moverse) o pasar de `maxTicks`. Contesta si llegó, cuántos ticks, dónde está y lo que le
  // quedaba del camino
  goTo(target: GoToTarget, o: GoToOptions = {}): AgentResult {
    const paths = this.opts.paths, sim = this.opts.sim, me = this.opts.player;
    if (!paths) return { ok: false, msg: 'no hay caminos (paths)' };
    if (!sim) return { ok: false, msg: 'no hay simulación' };
    if (!me?.()) return { ok: false, msg: 'no hay jugador' };
    const to = this.goal(target);
    if ('msg' in to) return to;
    const max = o.maxTicks ?? 600, near = o.near ?? 2, stuckTicks = o.stuckTicks ?? 60;
    const where = () => { const p = me()!; return { x: p.x, y: p.y, z: p.z }; };
    const dist = (p: LevelPoint) => Math.hypot(p.x - to.x, p.y - to.y);
    let last = where(), still = 0;
    for (let t = 0; t <= max; t++) {
      const p = where();
      if (dist(p) <= near) return { ok: true, msg: `llegó en ${t} ticks`, ticks: t, at: [p.x, p.y, p.z], goal: [to.x, to.y, to.z] };
      if (t === max) break;
      let d = paths.dir(p, to, near);
      paths.advance();
      if (!d) {
        // (con budget, dir contesta null mientras busca: se espera a que acabe antes de decir que no hay camino. Sin nodo
        // siguiente pero con camino: ya está en la celda de la meta, y va en línea recta al punto)
        if (paths.lag > 0) { sim.step(NO_INPUT); continue; }
        if (!paths.path(p, to, near)) return { ok: false, msg: 'no hay camino', ticks: t, at: [p.x, p.y, p.z], goal: [to.x, to.y, to.z] };
        const l = Math.hypot(to.x - p.x, to.y - p.y) || 1;
        d = { x: (to.x - p.x) / l, y: (to.y - p.y) / l };
      }
      // (si el tick anterior no avanzó, contra una esquina: solo un eje, alternando, para deslizarse por la pared)
      const input = still === 0 ? { dx: d.x, dy: d.y, stomp: false }
        : still % 2 ? { dx: Math.sign(d.x), dy: 0, stomp: false } : { dx: 0, dy: Math.sign(d.y), stomp: false };
      sim.step(input);
      const q = where();
      still = Math.hypot(q.x - last.x, q.y - last.y) < 0.01 ? still + 1 : 0;
      last = q;
      if (still >= stuckTicks) return { ok: false, msg: `atascado (${stuckTicks} ticks sin moverse)`, ticks: t + 1, at: [q.x, q.y, q.z], goal: [to.x, to.y, to.z] };
    }
    const p = where(), rest = paths.path(p, to, near);
    return { ok: false, msg: `no llegó en ${max} ticks (le faltan ${Math.round(dist(p))} vóxeles)`, ticks: max, at: [p.x, p.y, p.z], goal: [to.x, to.y, to.z], path: rest ? rest.slice(0, 8).map((r) => [r.x, r.y, r.z]) : null };
  }

  // El punto de llegada de un objetivo de goTo, o el resultado de por qué no hay
  private goal(t: GoToTarget): LevelPoint | AgentResult {
    if ('point' in t) return { x: t.point.x, y: t.point.y, z: t.point.z };
    const g = this.opts.grid, N = g.N, o = g.origin;
    if ('cell' in t) {
      const c = t.cell;
      if (this.check(c)) return this.check(c)!;
      const solid = g.props(c[0], c[1], c[2]).solid;
      return { x: o.x + (c[0] + 0.5) * N, y: o.y + (c[1] + 0.5) * N, z: o.z + (c[2] + (solid ? 1 : 0)) * N };
    }
    const look = this.opts.look?.();
    if (!look) return { ok: false, msg: 'no hay vista' };
    const v = pickVoxel(look.view, look.baked, t.pixel[0], t.pixel[1], look.section);
    if (!v) return { ok: false, msg: 'nada en ese píxel' };
    return { x: v.voxel[0] + 0.5, y: v.voxel[1] + 0.5, z: v.voxel[2] + 1 };
  }

  // Las comprobaciones de siempre antes de una orden sobre una celda: dentro de la rejilla, al alcance, visible. null
  // si pasa; si no, el resultado que hay que devolver
  check(cell: Vec3, opts: { reach?: number; visible?: boolean } = {}): AgentResult | null {
    const g = this.opts.grid;
    if (cell.length !== 3 || cell.some((v) => !Number.isInteger(v)) || cell[0] < 0 || cell[1] < 0 || cell[2] < 0 || cell[0] >= g.cols || cell[1] >= g.rows || cell[2] >= g.layers)
      return { ok: false, msg: `celda fuera de la rejilla (${cell.join(',')}; hay ${g.cols} x ${g.rows} x ${g.layers})` };
    if (opts.reach !== undefined) { const r = this.reach(cell, opts.reach); if (!r.ok) return r; }
    if (opts.visible) {
      const look = this.opts.look?.();
      if (!look) return { ok: false, msg: 'no hay vista' };
      const [bx, by, bz] = cell;
      if (!this.seenIn(look, this.regionRect(look, bx, by, bz, bx, by, bz)).has(cell.join(','))) return { ok: false, msg: 'no visible' };
    }
    return null;
  }

  // Una zona del mundo como texto: capas por z alrededor de un punto, una letra por celda, con leyenda y marcas
  describe(o: DescribeOptions = {}): Description {
    const g = this.opts.grid, at = o.at ?? this.opts.player?.() ?? null;
    if (!at) throw new Error('describe: sin at ni jugador no hay centro');
    const N = g.N, org = g.origin;
    const c: Vec3 = [Math.floor((at.x - org.x) / N), Math.floor((at.y - org.y) / N), Math.floor((at.z - org.z) / N)];
    const R = o.radius ?? 4, X: [number, number] = [c[0] - R, c[0] + R], Y: [number, number] = [c[1] - R, c[1] + R];
    const zTop = Math.min(g.layers - 1, c[2] + (o.above ?? 1)), zBot = Math.max(0, c[2] - (o.below ?? 2));
    // (lo que se ve, solo en el recuadro de la imagen por el que pasa la zona pedida: lo mismo que visibleCells ahí)
    const look = (o.visible ?? !!this.opts.look) ? this.opts.look?.() ?? null : null;
    const seen = look ? this.seenIn(look, this.regionRect(look, X[0], Y[0], zBot, X[1], Y[1], zTop)) : null;
    let wet = false;
    const marks = this.allMarks().map((m) => {
      const cell = g.cellOf(Math.floor(m.x), Math.floor(m.y), Math.floor(m.z));
      return { ...m, cell };
    });
    const layers: Description['layers'] = [];
    for (let bz = zTop; bz >= zBot; bz--) {
      const rows: string[] = [];
      for (let by = Y[1]; by >= Y[0]; by--) {
        let row = '';
        for (let bx = X[0]; bx <= X[1]; bx++) {
          if (bx < 0 || by < 0 || bx >= g.cols || by >= g.rows) { row += OUT; continue; }
          const m = marks.find((k) => k.cell && k.cell[0] === bx && k.cell[1] === by && k.cell[2] === bz);
          if (m) { row += m.ch; continue; }
          const t = g.get(bx, by, bz), ch = this.letter(t);
          if (!t && this.waterAt(bx, by, bz)) { row += this.waterCh; wet = true; continue; }
          row += t && seen && !seen.has(`${bx},${by},${bz}`) ? ch.toLowerCase() : ch;
        }
        rows.push(row);
      }
      layers.push({ bz, rows });
    }
    const legend: Record<string, string> = {};
    for (const L of layers) for (const r of L.rows) for (const ch of r) { const id = this.idOf.get(ch.toUpperCase()); if (id) legend[ch.toUpperCase()] = id; }
    // El texto: cabecera, leyenda, cada capa con el número de fila (by) a la izquierda y el último dígito de bx arriba
    const head = ' '.repeat(6) + Array.from({ length: X[1] - X[0] + 1 }, (_, i) => String(((X[0] + i) % 10 + 10) % 10)).join('');
    const lines = [
      `celdas bx ${X[0]}..${X[1]}, by ${Y[0]}..${Y[1]}; centro ${c.join(',')}; filas de norte (arriba) a sur, columnas de oeste a este`,
      `leyenda: . aire, ${Object.entries(legend).map(([k, v]) => `${k} ${v}`).join(', ')}${wet ? `, ${this.waterCh} agua` : ''}${seen ? '; minúscula: no se ve desde la cámara' : ''}; @ jugador, * entidad`,
    ];
    for (const L of layers) {
      lines.push(`z ${L.bz}:`, head);
      L.rows.forEach((r, i) => lines.push(`${String(Y[1] - i).padStart(5)} ${r}`));
    }
    for (const m of marks) lines.push(`${m.ch} ${m.name ?? ''} (${fmt(m.x)}, ${fmt(m.y)}, ${fmt(m.z)}) celda ${m.cell ? m.cell.join(',') : 'fuera'}`);
    return { center: c, x: X, y: Y, layers, legend, marks, visible: !!seen, ...(wet ? { water: this.waterCh! } : {}), text: lines.join('\n') };
  }

  // Si hay agua de la capa de agua del mundo (state.water) en la celda: alguna de sus columnas de agua tiene agua entre su
  // fondo y su superficie que pasa por las alturas de la celda
  private waterAt(bx: number, by: number, bz: number): boolean {
    const w = this.opts.state.water;
    if (!w || !this.waterCh) return false;
    const g = this.opts.grid, N = g.N, o = g.origin, z0 = o.z + bz * N, z1 = z0 + N, C = WATER_CELL;
    const xa = o.x + bx * N, ya = o.y + by * N;
    for (let y = Math.floor(ya / C) * C; y < ya + N; y += C) for (let x = Math.floor(xa / C) * C; x < xa + N; x += C) {
      const d = w.depthAt(Math.max(x, xa), Math.max(y, ya));
      if (!(d > 0)) continue;
      const s = w.surfaceAt(Math.max(x, xa), Math.max(y, ya));
      if (s > z0 && s - d < z1) return true;
    }
    return false;
  }

  private allMarks(): AgentMark[] {
    const out: AgentMark[] = [], p = this.opts.player?.();
    if (p) out.push({ ch: '@', x: p.x, y: p.y, z: p.z, name: 'jugador' });
    out.push(...(this.opts.marks?.() ?? []));
    if (this.opts.entities ?? true) for (const e of this.opts.state.entities) {
      if (e.ghost !== undefined || e.id === this.opts.playerEntity) continue;
      out.push({ ch: '*', x: e.x, y: e.y, z: e.z, name: `entidad ${e.id}` });
    }
    return out;
  }

  // ---- actuar

  register(name: string, fn: AgentAction, help = ''): void {
    if (this.actions.has(name)) throw new Error(`ya hay una orden "${name}"`);
    this.actions.set(name, { fn, help });
  }

  list(): Array<{ name: string; help: string }> { return [...this.actions].map(([name, a]) => ({ name, help: a.help })); }

  // Da una orden: siempre contesta (una orden que no existe o que lanza un error es { ok: false, msg })
  act(name: string, args: Record<string, unknown> = {}): AgentResult {
    const a = this.actions.get(name);
    if (!a) return { ok: false, msg: `no hay orden "${name}"; hay: ${[...this.actions.keys()].join(', ') || 'ninguna'}` };
    try {
      const r = a.fn(args, this);
      return r && typeof r.ok === 'boolean' && typeof r.msg === 'string' ? r : { ok: false, msg: `la orden "${name}" no devolvió { ok, msg }` };
    } catch (e) {
      return { ok: false, msg: `error en "${name}": ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Avanza n ticks de la simulación con la misma entrada (por defecto, ninguna), sin el reloj
  step(n = 1, input: TickInput = NO_INPUT): AgentResult {
    const sim = this.opts.sim;
    if (!sim) return { ok: false, msg: 'no hay simulación' };
    if (!Number.isInteger(n) || n < 0) return { ok: false, msg: `n tiene que ser un entero >= 0 (${n})` };
    for (let i = 0; i < n; i++) sim.step(input);
    return { ok: true, msg: `${n} ticks`, tick: sim.tick };
  }
}

// Cuelga el agente de un objeto (window) con un nombre (voxpixAgent): solo lo que es JSON por fuera
export function installAgent(target: Record<string, unknown>, host: AgentHost, name = 'voxpixAgent'): void {
  target[name] = {
    describe: (o?: DescribeOptions) => host.describe(o),
    visible: (rect?: { x0: number; y0: number; x1: number; y1: number }) => { const v = host.visibleCells(rect); return v ? [...v.values()] : null; },
    probe: (sx: number, sy: number) => host.probe(sx, sy),
    reach: (cell: Vec3, r: number) => host.reach(cell, r),
    act: (n: string, a?: Record<string, unknown>) => host.act(n, a),
    actions: () => host.list(),
    step: (n?: number, input?: TickInput) => host.step(n, input),
    entityAt: (sx: number, sy: number) => host.entityAt(sx, sy),
    goTo: (t: GoToTarget, o?: GoToOptions) => host.goTo(t, o),
  };
}

const gap = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
const fmt = (v: number) => (Math.round(v * 100) / 100).toString();
