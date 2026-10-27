// Lo que se aplasta (NARUTO, pedido de Andrés): la vegetación no se empuja, se aplasta al pasar o se rompe al
// golpearla. Trabaja sobre los vóxeles del mundo de los materiales con crush (materials.ts: follaje y arbusto), en las
// columnas a menos de r de (x, y). No despierta nada: solo cambian vóxeles, y el rehorneado es el de siempre (local).
import { decode, rampMaterial, material } from '../core';
import type { WorldState } from './state';

export interface CrushOptions {
  // 'flatten': se queda tumbada, como mucho `keep` vóxeles de alto sobre su base (lo de más arriba se va);
  // 'break': se va entera
  mode?: 'flatten' | 'break';
  keep?: number;                // con 'flatten': el alto que queda (1)
  // con 'flatten': lo que queda, un tono más oscuro (pisado). Cada llamada oscurece otra vez, y cambiar vóxeles
  // rehornea: para lo que se llama en cada tick al pasar, mejor sin él (false)
  darken?: boolean;
}

// Aplasta o rompe la vegetación de las columnas a menos de r de (x, y). Devuelve cuántos vóxeles cambió
export function crushAt(world: WorldState, x: number, y: number, r: number, o: CrushOptions = {}): number {
  const s = world.solid, mode = o.mode ?? 'flatten', keep = Math.max(0, o.keep ?? 1), darken = o.darken ?? false;
  const crush = s.palette.ramps.map((rp) => rampMaterial(rp).crush);
  let n = 0;
  for (let cy = Math.max(0, Math.floor(y - r)); cy <= Math.min(s.depth - 1, Math.floor(y + r)); cy++) {
    for (let cx = Math.max(0, Math.floor(x - r)); cx <= Math.min(s.width - 1, Math.floor(x + r)); cx++) {
      if ((cx + 0.5 - x) ** 2 + (cy + 0.5 - y) ** 2 > r * r) continue;
      // De abajo arriba: cada tramo seguido de vegetación, desde su base
      let base: number | null = null;
      for (let z = s.zMin; z <= s.zMax; z++) {
        const v = s.get(cx, cy, z);
        if (!v || !crush[decode(v).ramp]) { base = null; continue; }
        if (base === null) base = z;
        if (mode === 'break' || z - base >= keep) { s.set(cx, cy, z, 0); n++; }
        else if (darken) {
          const { ramp, tone } = decode(v);
          if (tone > 0) { s.set(cx, cy, z, material(ramp, tone - 1)); n++; }
        }
      }
    }
  }
  return n;
}
