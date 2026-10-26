// Animación genérica por partes (NARUTO), para cualquier cuerpo de vóxeles (bichos de varias patas, criaturas...).
// Un rig dice qué vóxeles son cada parte (por su posición y su color en el modelo quieto) y, cuadro a cuadro, cuánto
// se mueve cada una. Con eso se sacan los cuadros como modelos, igual que el walk de MAIA (src/anim/walk.ts, que se
// queda aparte porque es su ciclo aprobado, con la cascada del pelo).
//
// Ejes del modelo como siempre: x este, y norte (el frente mira a -y), z arriba; los pies en z = 0.
import { Model } from '../core';

export interface RigPart {
  name: string;
  // ¿Es de esta parte el vóxel (x, y, z) de color v? Cada vóxel va a la primera parte que lo pide; el resto, al cuerpo
  has(x: number, y: number, z: number, v: number): boolean;
  // Para la zancada: la z que no se mueve (la cadera, el hombro) y la que más (el pie)
  pivotZ?: number;
  footZ?: number;
}

// Lo que hace una parte en un cuadro. stride: cuánto se adelanta (-y) su punta (footZ) mientras pivotZ se queda.
export interface PartMove { dx?: number; dy?: number; dz?: number; stride?: number }

export interface RigFrame {
  moves: Record<string, PartMove>;      // por nombre de parte; 'body' es lo que no es de ninguna
  airborne?: boolean;                   // en el aire (un salto): no tiene por qué tocar z = 0
}

export interface Rig {
  parts: RigPart[];
  frames: RigFrame[];
  frameMs: number;
}

export function rigFrame(base: Model, rig: Rig, f: RigFrame): Model {
  const out = new Model(base.palette, `${base.name}_anim`);
  // Primero el cuerpo y después las partes, en su orden: lo que va después pisa
  const byPart = new Map<string, Array<[number, number, number, number]>>();
  for (const [x, y, z, v] of base.entries()) {
    const p = rig.parts.find((q) => q.has(x, y, z, v));
    const name = p?.name ?? 'body';
    let list = byPart.get(name);
    if (!list) byPart.set(name, (list = []));
    list.push([x, y, z, v]);
  }
  for (const name of ['body', ...rig.parts.map((p) => p.name)]) {
    const list = byPart.get(name);
    if (!list) continue;
    const m = f.moves[name] ?? {};
    const part = rig.parts.find((p) => p.name === name);
    for (const [x, y, z, v] of list) {
      let dy = m.dy ?? 0;
      if (m.stride && part?.pivotZ !== undefined) {
        const foot = part.footZ ?? 0, span = part.pivotZ - foot;
        dy -= span > 0 ? Math.round((m.stride * Math.max(0, Math.min(span, part.pivotZ - z))) / span) : m.stride;
      }
      const nz = z + (m.dz ?? 0);
      if (nz < 0) continue;
      out.set(x + (m.dx ?? 0), y + dy, nz, v);
    }
  }
  return out;
}

export function rigFrames(base: Model, rig: Rig): Model[] {
  return rig.frames.map((f) => rigFrame(base, rig, f));
}

// ---- el rig que se puede guardar (en el .voxpix.json, desde el editor o la API de agentes)
// Cada parte se define por cajas de vóxeles (x0, y0, z0, x1, y1, z1, incluidas) y/o rampas: un vóxel es de la parte si
// cae en ALGUNA de sus cajas (la parte es su unión; sin cajas, todo) y su rampa es una de las suyas (o no tiene
// rampas). Un límite null es abierto: [null, null, null, -5, null, 7] es x <= -5 y z <= 7, crezca lo que crezca el
// modelo. Si un vóxel cae en dos partes, es de la PRIMERA que lo pide (como con has(): parts.find). Lo que no es de
// ninguna es 'body', y también se mueve en los cuadros (moves.body). Las condiciones que no son cajas siguen siendo
// Rig en código.
export type RigBox = [number | null, number | null, number | null, number | null, number | null, number | null];
export interface RigPartSpec {
  name: string;
  boxes?: RigBox[];
  ramps?: number[];
  pivotZ?: number;
  footZ?: number;
}
export interface RigSpec { parts: RigPartSpec[]; frames: RigFrame[]; frameMs: number }

export function rigFromSpec(spec: RigSpec): Rig {
  return {
    frameMs: spec.frameMs,
    frames: spec.frames,
    parts: spec.parts.map((p): RigPart => {
      if (!p.name || p.name === 'body') throw new Error(`una parte necesita nombre (y no puede llamarse body): ${p.name}`);
      // Cada caja como [mín, máx] por eje; null es abierto por ese lado
      const boxes = (p.boxes ?? []).map((bx) => [0, 1, 2].map((k) => {
        const a = bx[k] ?? -Infinity, c = bx[k + 3] ?? Infinity;
        return bx[k] !== null && bx[k + 3] !== null && a > c ? [c, a] : [a, c];
      }) as [[number, number], [number, number], [number, number]]);
      const ramps = p.ramps ? new Set(p.ramps) : null;
      return {
        name: p.name,
        has: (x, y, z, v) => (!boxes.length || boxes.some(([[x0, x1], [y0, y1], [z0, z1]]) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1))
          && (!ramps || ramps.has(Math.floor((v - 1) / 16))),
        ...(p.pivotZ !== undefined ? { pivotZ: p.pivotZ } : {}),
        ...(p.footZ !== undefined ? { footZ: p.footZ } : {}),
      };
    }),
  };
}
