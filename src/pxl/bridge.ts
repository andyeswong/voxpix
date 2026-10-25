// Integración nativa con pxl (github.com/crsolver/claude-pxl, MIT), el "pixel art como código" que ya usa el
// equipo (p. ej. arte/maia24-ropa.px.js). Usa su núcleo, que no depende de Node ni del navegador, así que
// sirve igual en la CLI y en la app.
//
// - Importar: se evalúa un .px.js con el DSL de pxl y se toma su PALETA (con sus rampas, que en pxl también
//   van de oscuro a claro) y sus sprites (para pasarlos a vóxeles).
// - Exportar: un render de VoxPix se escribe como .px.js (pal + ramps + un sprite por ángulo + una hoja), que
//   `pxl build` convierte en PNG, hoja + JSON y vistas previas, igual que el resto del arte del equipo.
import { Project, toHex, channels, type Img } from 'pxl-core';
import { Model, material, rgbOf, decode, type Palette, type Ramp } from '../core';

// ---------------------------------------------------------------- importar

// Evalúa la fuente de un .px.js (sin include: los ficheros incluidos no se pueden leer desde aquí)
export function loadPxl(source: string, name = 'art.px.js'): Project {
  const p = new Project();
  const env = p.env();
  p.addFile(name);
  // La fuente es arte del propio usuario: se ejecuta con las funciones del DSL como únicas variables globales
  new Function(...Object.keys(env), source)(...Object.values(env));
  return p;
}

export function pxlAssets(p: Project): string[] {
  return p.exported();
}

// Paleta de VoxPix desde la de pxl (la del sprite dado, o la última activa): cada rampa de pxl es una rampa.
// Los colores sueltos (fuera de rampas) entran como rampas de un tono, pero solo los que tienen nombre en
// pal() o que usa algún sprite: pal() extiende la paleta por defecto (pico8) y esos colores no son del arte.
// Directivas de VoxPix dentro de un .px.js (pxl solo admite claves de una letra en la paleta, así que lo que pxl no
// sabe guardar va en un comentario, y así la ida y vuelta es simétrica):
//   // voxpix: outline #12101c        color fijo del contorno (palette.outline)
//   // voxpix: emissive Cc Bb         rampas con luz propia (por sus teclas, como en ramps())
export interface PxlDirectives { outline?: string; emissive: string[] }
export function pxlDirectives(source: string): PxlDirectives {
  const out: PxlDirectives = { emissive: [] };
  for (const m of source.matchAll(/^\s*\/\/\s*voxpix:\s*(\w+)\s+(.+?)\s*$/gm)) {
    if (m[1] === 'outline' && /^#[0-9a-fA-F]{6}$/.test(m[2]!)) out.outline = m[2]!.toLowerCase();
    if (m[1] === 'emissive') out.emissive.push(...m[2]!.split(/\s+/));
  }
  return out;
}
// La paleta con las directivas aplicadas (y un contorno explícito, si se pasa, por encima de la directiva)
export function applyDirectives(pal: Palette, d: PxlDirectives, outline?: string): Palette {
  const o = outline ?? d.outline;
  return { ...pal, ...(o ? { outline: o } : {}), ramps: pal.ramps.map((r) => (d.emissive.includes(r.name) ? { ...r, emissive: true } : r)) };
}

export function paletteFromPxl(p: Project, asset?: string): Palette {
  const pal = asset ? (p.assets.get(asset)?.pal ?? p.pal) : p.pal;
  const ramps: Ramp[] = [];
  const used = new Set<string>();
  const hexOf = (k: string) => toHex(pal.keys.get(k)!).slice(0, 7);
  for (const r of pal.ramps) {
    const keys = [...r];
    ramps.push({ name: r, colors: keys.map(hexOf) });
    keys.forEach((k) => used.add(k));
  }
  const inArt = new Set<number>();
  for (const name of asset ? [asset] : p.exported()) {
    try { for (const c of p.image(name).data) if (c & 255) inArt.add(c >>> 0); } catch { /* sprite que no se puede construir aquí */ }
  }
  const seen = new Set(ramps.flatMap((r) => r.colors));
  for (const k of pal.order) {
    if (used.has(k) || !(pal.aliases.has(k) || inArt.has(pal.keys.get(k)!))) continue;
    const hex = hexOf(k);
    if (seen.has(hex)) continue;
    seen.add(hex);
    ramps.push({ name: k, colors: [hex] });
  }
  return { ramps };
}

// Material de la paleta para un color: el exacto si está; si no, el más cercano
function materialFor(palette: Palette, rgb: [number, number, number]): number {
  let best = 0, bd = Infinity;
  palette.ramps.forEach((r, ri) => r.colors.forEach((c, ti) => {
    const [a, b, d] = rgbOf(c);
    const dist = (a - rgb[0]) ** 2 + (b - rgb[1]) ** 2 + (d - rgb[2]) ** 2;
    if (dist < bd) { bd = dist; best = material(ri, ti); }
  }));
  return best;
}

export interface SpriteImport {
  plane: 'front' | 'top';   // de frente: columnas = x, filas = z (de abajo arriba), en y = depth; desde arriba: capa z
  z?: number;               // capa (plano 'top')
  y?: number;               // profundidad (plano 'front')
}

// Pone un sprite de pxl como vóxeles, centrado en x sobre el pivote
export function spriteToVoxels(p: Project, name: string, model: Model, how: SpriteImport): number {
  const img: Img = p.image(name);
  const half = Math.floor(img.w / 2);
  let n = 0;
  for (let py = 0; py < img.h; py++) for (let px = 0; px < img.w; px++) {
    const c = img.data[py * img.w + px]!;
    const [r, g, b, a] = channels(c);
    if (a < 128) continue;
    const v = materialFor(model.palette, [r, g, b]);
    if (how.plane === 'front') model.set(px - half, how.y ?? 0, img.h - 1 - py, v);
    else model.set(px - half, Math.floor(img.h / 2) - py, how.z ?? 0, v);
    n++;
  }
  return n;
}

// ---------------------------------------------------------------- exportar

// Teclas de una letra para los colores (las reservadas de pxl son . _ # y el espacio)
const KEYS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@$%&*+=?!~^';

export interface PxlFrame {
  name: string;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

// pal() + ramps() de la paleta del modelo, y la tecla de cada color
function paletteSource(model: Model): { keyOf: Map<string, string>; lines: string[] } {
  const keyOf = new Map<string, string>();
  const pal: string[] = [];
  const rampLines: string[] = [];
  let next = 0;
  const assign = (hex: string): string => {
    const h = hex.toLowerCase();
    let k = keyOf.get(h);
    if (!k) {
      k = KEYS[next++];
      if (!k) throw new Error('demasiados colores para teclas de una letra');
      keyOf.set(h, k);
      pal.push(`  ${k}: "${h}",`);
    }
    return k;
  };
  for (const r of model.palette.ramps) {
    const ks = r.colors.map(assign).join('');
    if (ks.length > 1) rampLines.push(JSON.stringify(ks));
  }
  if (model.palette.outline) assign(model.palette.outline);
  // Lo que pxl no guarda, como directivas (pxlDirectives las lee de vuelta)
  const directives: string[] = [];
  if (model.palette.outline) directives.push(`// voxpix: outline ${model.palette.outline.toLowerCase()}`);
  const emissive = model.palette.ramps.filter((r) => r.emissive).map((r) => r.colors.map((c) => keyOf.get(c.toLowerCase())!).join(''));
  if (emissive.length) directives.push(`// voxpix: emissive ${emissive.join(' ')}`);
  return { keyOf, lines: [...directives, 'pal({', ...pal, '})', ...(rampLines.length ? [`ramps(${rampLines.join(', ')})`] : [])] };
}

// Escribe renders de VoxPix como un .px.js. Todos los colores deben ser de la paleta (el render ya lo garantiza).
export function toPxlSource(model: Model, frames: PxlFrame[], opts: { sheet?: string; comment?: string } = {}): string {
  const { keyOf, lines } = paletteSource(model);

  const sprites = frames.map((f) => {
    const rows: string[] = [];
    for (let y = 0; y < f.height; y++) {
      let row = '';
      for (let x = 0; x < f.width; x++) {
        const p = (y * f.width + x) * 4;
        if (f.rgba[p + 3] === 0) { row += '.'; continue; }
        const hex = '#' + [0, 1, 2].map((i) => f.rgba[p + i]!.toString(16).padStart(2, '0')).join('');
        const k = keyOf.get(hex);
        if (!k) throw new Error(`color fuera de la paleta en ${f.name}: ${hex}`);
        row += k;
      }
      rows.push('  ' + row);
    }
    // w y h explícitos: las filas y columnas vacías del borde cuentan (mantienen el pivote en su sitio)
    return `sprite(${JSON.stringify(f.name)}, { w: ${f.width}, h: ${f.height} }, \`\n${rows.join('\n')}\`)`;
  });

  const out = [
    `// ${opts.comment ?? `Exportado de VoxPix: ${model.name}`}`,
    '// Generado: no editar a mano (se regenera desde el modelo).',
    ...lines,
    '',
    ...sprites,
  ];
  if (opts.sheet) out.push('', `sheet(${JSON.stringify(opts.sheet)}, [${frames.map((f) => JSON.stringify(f.name)).join(', ')}], { pad: 1 })`);
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- pila de capas (slices)
//
// Un modelo como pila de capas horizontales: un sprite `<prefijo>_zNN` por altura, visto desde arriba
// (norte arriba), todos del mismo tamaño impar y con el pivote en el centro: columna x = 0 en el centro del
// ancho y fila y = 0 en el centro del alto. Es el mismo formato al importar y al exportar.

const STACK_RE = (prefix: string) => new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_z(\\d+)$`);

// Prefijos de pila que hay en un proyecto de pxl (sprites que acaban en _zNN)
export function stackPrefixes(p: Project): string[] {
  const out = new Set<string>();
  for (const n of p.exported()) { const m = /^(.*)_z\d+$/.exec(n); if (m) out.add(m[1]!); }
  return [...out];
}

export function stackFromPxl(p: Project, prefix: string, model: Model): number {
  const re = STACK_RE(prefix);
  const layers = p.exported().map((n) => [n, re.exec(n)] as const).filter(([, m]) => m);
  if (!layers.length) throw new Error(`no hay capas "${prefix}_zNN"`);
  let size: [number, number] | null = null;
  let n = 0;
  for (const [name, m] of layers) {
    const img = p.image(name);
    if (!size) size = [img.w, img.h];
    else if (img.w !== size[0] || img.h !== size[1]) throw new Error(`la capa ${name} mide ${img.w}x${img.h} y las demás ${size[0]}x${size[1]}: todas iguales`);
    n += spriteToVoxels(p, name, model, { plane: 'top', z: Number(m![1]) });
  }
  return n;
}

// El modelo entero como capas .px.js (z = 0 hasta la más alta; las vacías también, para que la altura no cambie)
export function toPxlStack(model: Model, prefix: string, opts: { comment?: string } = {}): string {
  const b = model.bounds();
  const { keyOf, lines } = paletteSource(model);
  const halfX = b ? Math.max(-b.minX, b.maxX, 0) : 0, halfY = b ? Math.max(-b.minY, b.maxY, 0) : 0;
  const w = 2 * halfX + 1, h = 2 * halfY + 1;
  const top = b ? b.maxZ : 0;
  const hexOf = (v: number) => { const { ramp, tone } = decode(v); return model.palette.ramps[ramp]!.colors[tone]!.toLowerCase(); };
  const sprites: string[] = [];
  for (let z = 0; z <= top; z++) {
    const rows: string[] = [];
    for (let py = 0; py < h; py++) {
      let row = '';
      for (let px = 0; px < w; px++) {
        const v = model.get(px - halfX, halfY - py, z);
        row += v ? keyOf.get(hexOf(v))! : '.';
      }
      rows.push('  ' + row);
    }
    sprites.push(`sprite("${prefix}_z${String(z).padStart(2, '0')}", { w: ${w}, h: ${h} }, \`\n${rows.join('\n')}\`)`);
  }
  return [
    `// ${opts.comment ?? `VoxPix: ${model.name} como pila de ${top + 1} capas de ${w}x${h} (vistas desde arriba, norte arriba, pivote en el centro)`}`,
    ...lines,
    '',
    ...sprites,
  ].join('\n') + '\n';
}
