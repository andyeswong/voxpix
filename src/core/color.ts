import { rgbOf } from './palette';
import type { Ramp } from './palette';

// Color para la paleta: OKLab / OKLCH (percepción uniforme: la misma distancia se ve igual en cualquier tono), rampas
// generadas desde un color base al estilo del pixel art (las sombras van hacia el frío y las luces hacia el cálido,
// no solo más oscuras) y agrupar una lista de colores suelta (una paleta de Lospec) en rampas.

export type Lab = [number, number, number];          // L (0..1), a, b
export type LCh = [number, number, number];          // L (0..1), croma, tono (grados)

const toLin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toSrgb = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function hexToLab(hex: string): Lab {
  const [r, g, b] = rgbOf(hex).map(toLin) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

// sRGB lineal de un Lab (sin recortar: fuera de [0, 1] es que no cabe en sRGB)
function labToLinear([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

export function labToHex(lab: Lab): string {
  return '#' + labToLinear(lab).map((c) => Math.round(Math.max(0, Math.min(255, toSrgb(Math.max(0, Math.min(1, c)))))).toString(16).padStart(2, '0')).join('');
}

export const labToLch = ([L, a, b]: Lab): LCh => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
export const lchToLab = ([L, C, h]: LCh): Lab => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];
export const hexToLch = (hex: string): LCh => labToLch(hexToLab(hex));

// El color LCh como hex, bajando el croma hasta que cabe en sRGB (así no se desvía el tono al recortar)
export function lchToHex(lch: LCh): string {
  let [L, C, h] = lch;
  L = Math.max(0, Math.min(1, L));
  for (let i = 0; i < 24; i++) {
    const lin = labToLinear(lchToLab([L, C, h]));
    if (lin.every((c) => c >= -1e-4 && c <= 1 + 1e-4)) break;
    C *= 0.85;
  }
  return labToHex(lchToLab([L, C, h]));
}

export function labDistance(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Diferencia de tono en grados, con signo, de a hacia b (-180..180)
const hueDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180;

export interface RampOptions {
  tones?: number;          // cuántos tonos (2..16); por defecto 5
  hueShift?: number;       // grados que giran las sombras hacia el frío y las luces hacia el cálido; por defecto 22
  contrast?: number;       // cuánta luminosidad va del más oscuro al más claro (0..1); por defecto 0.58
}

// Una rampa de oscuro a claro alrededor del color base, que queda dentro de la rampa tal cual. Las sombras giran el
// tono hacia el azul-violeta y bajan de croma; las luces giran hacia el amarillo y también bajan de croma: lo que hace
// a mano un pixel artist (hue shifting) para que las sombras no se vean sucias.
export function rampFromColor(base: string, opts: RampOptions = {}): string[] {
  const n = Math.max(2, Math.min(16, Math.round(opts.tones ?? 5)));
  const shift = opts.hueShift ?? 22, contrast = opts.contrast ?? 0.58;
  const [L0, C0, h0] = hexToLch(base);
  // Dónde cae el base en la rampa: según lo claro que es, para que la rampa no se salga de negro ni de blanco
  const lo = Math.max(0.22, L0 - contrast * 0.5), hi = Math.min(0.95, lo + contrast);
  const span = hi - lo;
  const b = Math.max(0, Math.min(n - 1, Math.round(((L0 - lo) / span) * (n - 1))));
  const COLD = 265, WARM = 85;                       // hacia dónde giran las sombras y las luces
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === b) { out.push(base.toLowerCase()); continue; }
    const t = (i - b) / (n - 1);                     // negativo hacia la sombra, positivo hacia la luz
    const L = i < b ? L0 - (L0 - lo) * ((b - i) / Math.max(1, b)) : L0 + (hi - L0) * ((i - b) / Math.max(1, n - 1 - b));
    const target = t < 0 ? COLD : WARM;
    const d = hueDelta(h0, target);
    const h = (h0 + Math.sign(d) * Math.min(Math.abs(d), shift * Math.abs(t) * 2) + 360) % 360;
    const C = C0 * (1 - 0.45 * Math.abs(t)) + (C0 < 0.02 ? 0 : 0.01);
    out.push(lchToHex([L, C0 < 0.02 ? C0 : C, C0 < 0.02 ? h0 : h]));
  }
  return out;
}

// Nombre corto en español para el tono de un color (para nombrar rampas)
export function hueName(hex: string): string {
  const [L, C, h] = hexToLch(hex);
  if (C < 0.035) return L < 0.3 ? 'negro' : L > 0.85 ? 'blanco' : 'gris';
  // Límites en grados de OKLCH (rojo ~30, naranja ~65, amarillo ~105, verde ~140, cian ~200, azul ~245, violeta ~305)
  const names: Array<[number, string]> = [[10, 'rosa'], [45, 'rojo'], [80, 'naranja'], [115, 'amarillo'], [125, 'lima'], [175, 'verde'], [225, 'cian'], [285, 'azul'], [340, 'violeta'], [360, 'rosa']];
  return names.find(([lim]) => h < lim)![1];
}

// Una lista de colores suelta (una paleta) agrupada en rampas. Las paletas de pixel art se diseñan por rampas que
// giran de tono al aclarar (un marrón oscuro que sube a ocre y a crema), así que no basta con agrupar por tono: se
// encadena, desde el color más oscuro que queda, el siguiente más claro que se le parezca en color (a, b de OKLab),
// mientras se parezca. Cada rampa va de oscuro a claro, con 16 tonos como mucho, y se nombra por su tono del medio.
export function groupIntoRamps(colors: readonly string[], maxTones = 16): Ramp[] {
  const items = [...new Set(colors.map((c) => c.toLowerCase()))].map((hex) => ({ hex, lab: hexToLab(hex) }));
  const left = new Set(items);
  const chains: Array<typeof items> = [];
  while (left.size) {
    const start = [...left].reduce((a, b) => (b.lab[0] < a.lab[0] ? b : a));
    left.delete(start);
    const chain = [start];
    for (;;) {
      const cur = chain[chain.length - 1]!;
      let best: (typeof items)[number] | null = null, bc = Infinity;
      for (const c of left) {
        const dL = c.lab[0] - cur.lab[0];
        if (dL < 0.02 || dL > 0.32) continue;                       // más claro, sin saltarse media rampa
        const dab = Math.hypot(c.lab[1] - cur.lab[1], c.lab[2] - cur.lab[2]);
        if (dab > 0.085) continue;                                  // otro color: otra rampa
        const cost = dab * 2.2 + Math.abs(dL - 0.11);               // parecido, y a un paso de luz razonable
        if (cost < bc) { bc = cost; best = c; }
      }
      if (!best || chain.length >= maxTones) break;
      left.delete(best);
      chain.push(best);
    }
    chains.push(chain);
  }
  // Las rampas largas primero; dentro, por tono, para que la paleta se lea ordenada
  chains.sort((a, b) => b.length - a.length || labToLch(a[Math.floor(a.length / 2)]!.lab)[2] - labToLch(b[Math.floor(b.length / 2)]!.lab)[2]);
  const used = new Map<string, number>();
  return chains.map((chain) => {
    const base = hueName(chain[Math.floor(chain.length / 2)]!.hex);
    const k = (used.get(base) ?? 0) + 1;
    used.set(base, k);
    return { name: k > 1 ? `${base} ${k}` : base, colors: chain.map((c) => c.hex) };
  });
}

// Lee una paleta de texto: .hex (un color por línea), .gpl (GIMP: "r g b nombre"), o una lista de #rrggbb sueltos
export function parsePaletteText(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('//')) continue;
    if (/^GIMP Palette|^Name:|^Columns:|^#\s/.test(line) && !/^#[0-9a-f]{6}\b/i.test(line)) continue;
    const rgb = /^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\b/.exec(line);
    if (rgb) { out.push('#' + rgb.slice(1, 4).map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')); continue; }
    for (const m of line.matchAll(/#?\b([0-9a-f]{6})\b/gi)) out.push(`#${m[1]!.toLowerCase()}`);
  }
  return [...new Set(out)];
}
