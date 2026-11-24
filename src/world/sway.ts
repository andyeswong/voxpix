// EL VAIVÉN: los vóxeles de las rampas que se mecen (MaterialProps.sway) se pintan corridos unos píxeles a un lado al
// componer, sin tocar la imagen horneada. Es un cambio de qué píxel de la imagen se ve en cada píxel de la vista, así que
// lo corrido lleva su color, su profundidad y su luz: las del vóxel quieto. El pick, la máscara, la colisión y lo que
// lee la simulación son los de la imagen. La CPU (frame2d.ts) y la GPU (FRAG_SCENE) hacen la misma cuenta, con enteros.
import { KEY_OFF, KEY_SPAN, rampMaterial, MAX_RAMPS, MAX_TONES, type Palette } from '../core';
import type { Baked } from './bake';
import type { StaticVoxels } from './state';
import { unprojector, rowP, worldYAt } from './bake';
import { secIdx, type SectionLayer } from './section';
import { climateLean, type ClimateTable } from './climate';

export const SWAY_MAX = 3;                  // píxeles que se corre algo como mucho
export const SWAY_UNIT = 32;                // el código de un vóxel: cuánto se mece en 1 / SWAY_UNIT de píxel
export const SWAY_AQUATIC = 128;            // y este bit si es de los de agua
export const SWAY_FILL = SWAY_MAX + 2;      // hasta dónde se busca con qué llenar el hueco que deja algo al correrse
const WALK = 48;                            // vóxeles que se bajan (o suben) como mucho buscando la raíz

interface SwayTable { amount: Float32Array; anchor: Uint8Array; reach: Float32Array; aquatic: Uint8Array }
const cache = new WeakMap<Palette, SwayTable | null>();
// Lo que se mece de una paleta, por valor de vóxel; null si nada
export function swayTable(p: Palette): SwayTable | null {
  let t = cache.get(p);
  if (t !== undefined) return t;
  const ms = p.ramps.map(rampMaterial);
  if (!ms.some((m) => m.sway > 0 || m.aquatic)) { cache.set(p, null); return null; }
  const n = MAX_RAMPS * MAX_TONES + 1;
  t = { amount: new Float32Array(n), anchor: new Uint8Array(n), reach: new Float32Array(n).fill(1), aquatic: new Uint8Array(n) };
  ms.forEach((m, i) => {
    const a = i * MAX_TONES + 1, b = a + MAX_TONES;
    t!.amount.fill(Math.max(0, Math.min(SWAY_MAX, m.sway)), a, b);
    t!.anchor.fill(m.anchor === 'root' ? 1 : m.anchor === 'top' ? 2 : 0, a, b);
    t!.reach.fill(Math.max(1, m.reach), a, b);
    t!.aquatic.fill(m.aquatic ? SWAY_AQUATIC : 0, a, b);
  });
  cache.set(p, t);
  return t;
}

// El código del vóxel de una clave (Baked.pick): 0 si no se mece. Anclado abajo (o arriba), según los vóxeles que hay
// hasta lo primero que no se mece: el aire de en medio cuenta, así una flor más ancha que su tallo va con él
export function swayCode(t: SwayTable, s: Pick<StaticVoxels, 'get'>, k: number): number {
  if (Number.isNaN(k)) return 0;
  const z = (k % KEY_SPAN) - KEY_OFF, r = Math.floor(k / KEY_SPAN), y = (r % KEY_SPAN) - KEY_OFF, x = Math.floor(r / KEY_SPAN) - KEY_OFF;
  const v = s.get(x, y, z), a = t.amount[v]!;
  if (a <= 0) return t.aquatic[v]!;
  const anchor = t.anchor[v]!;
  let f = 1;
  if (anchor) {
    const dir = anchor === 1 ? -1 : 1, reach = t.reach[v]!;
    let h = 1;
    for (; h <= WALK && h <= reach; h++) { const u = s.get(x, y, z + dir * h); if (u && !(t.amount[u]! > 0)) break; }
    f = Math.min(1, h / reach);
  }
  return t.aquatic[v]! | Math.floor(a * f * SWAY_UNIT + 0.5);
}

// Cuánto se corre (en píxeles, a la derecha) un píxel con ese código y esa inclinación del aire
export function swayShift(code: number, lean: number): number {
  const a = code & 127;
  return a ? Math.max(-SWAY_MAX, Math.min(SWAY_MAX, Math.floor((a / SWAY_UNIT) * lean + 0.5))) : 0;
}

// De qué columna de la imagen sale cada píxel de la vista, o null si en la vista no se mece nada. Gana lo más cercano a
// la cámara de lo que cae en el píxel. Si lo que había se corrió y no cae nada, el hueco se llena con el primer píxel
// quieto y no más cercano del lado de donde viene; si no lo hay, se queda lo que había
// (veil: los píxeles con velo del ghost de la sección, que no se mecen)
export function swaySources(b: Baked, sec: SectionLayer | null, veil: Uint8Array | null, c: ClimateTable, vx: number, vy: number, vw: number, vh: number): Int32Array | null {
  const tab = swayTable(b.source.palette);
  if (!tab || !c.sway) return null;
  const u = unprojector(b), M = SWAY_FILL, n = vw + 2 * M;
  const code = new Uint8Array(n), shift = new Int8Array(n), depth = new Float32Array(n), cls = new Uint8Array(n);
  const out = new Int32Array(vw * vh);
  let any = false;
  for (let y = 0; y < vh; y++) {
    const gy = vy + y, P = rowP(u, gy);
    for (let i = 0; i < n; i++) {
      const gx = vx - M + i, inside = gx >= 0 && gy >= 0 && gx < b.width && gy < b.height;
      code[i] = 0; shift[i] = 0; cls[i] = inside ? 0 : 2; depth[i] = Infinity;
      if (!inside) continue;
      const q = secAt(sec, gx, gy), m = q >= 0 ? sec!.mask[q]! : 0;
      depth[i] = m ? sec!.depth[q]! : b.depth[gy * b.width + gx]!;
      cls[i] = m === 1 ? 1 : 0;
      if (m === 1 && veil?.[q]) continue;
      const k = m ? sec!.pick[q]! : b.pick[gy * b.width + gx]!;
      code[i] = swayCode(tab, b.source, k);
      if (code[i]! & 127 && depth[i] !== Infinity) shift[i] = swayShift(code[i]!, climateLean(c, gx, worldYAt(u, P, depth[i]!), code[i]! >= SWAY_AQUATIC));
    }
    for (let x = 0; x < vw; x++) {
      const h = x + M;
      let best = -1, bd = Infinity;
      if (shift[h] === 0) { best = h; bd = depth[h]!; }
      for (let d = 1; d <= SWAY_MAX; d++) for (const e of [d, -d]) {
        const i = h - e;
        if (shift[i] === e && cls[i] === cls[h] && depth[i]! < bd) { best = i; bd = depth[i]!; }
      }
      if (best < 0) {
        const dir = shift[h]! > 0 ? -1 : 1;
        for (let k = 1; k <= SWAY_FILL; k++) {
          const i = h + dir * k;
          if (cls[i] === cls[h] && !(code[i]! & 127) && depth[i]! > depth[h]! - 0.5) { best = i; break; }
        }
        if (best < 0) best = h;
      }
      if (best !== h) any = true;
      out[y * vw + x] = vx - M + best;
    }
  }
  return any ? out : null;
}
const secAt = (sec: SectionLayer | null, gx: number, gy: number): number =>
  sec && gx >= sec.x && gy >= sec.y && gx < sec.x + sec.w && gy < sec.y + sec.h ? secIdx(sec, gx, gy - sec.y) : -1;
