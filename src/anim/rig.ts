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
