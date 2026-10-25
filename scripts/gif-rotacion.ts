// Un GIF del modelo girando una vuelta entera, con el mismo render que la app (y, con --luz, iluminado con las fuentes
// del .voxpix.json, como la vista previa con "Iluminación"). Fondo transparente.
//   npx tsx --tsconfig tsconfig.runtime.json scripts/gif-rotacion.ts <modelo.voxpix.json|sample> salida.gif
//       [--cuadros 36] [--escala 3] [--elev 35] [--ms 80] [--luz] [--ambiente 0.35] [--contorno outer|both|none]
import { readFileSync, writeFileSync } from 'node:fs';
import { Model, render, camera, lightField3D, fitFrame, type ModelFile, type RenderOptions } from '../src/core';
import { SOURCE_PRESETS, lightIntensity, lightOf, type SourceKind } from '../src/lighting';
import { buildLayers, applyLayers } from '../src/lighting/shade';
import { medievalScene } from '../src/samples/medieval';
import { encodeGIF } from './lib/gif';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('uso: gif-rotacion.ts <modelo.voxpix.json|sample> salida.gif [--cuadros 36] [--escala 3] [--luz]'); process.exit(1); }
const arg = (name: string, def: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : def; };

type Light = { id: string; kind: SourceKind; x: number; y: number; z: number };
let model: Model, lights: Light[];
if (src === 'sample') { const s = medievalScene(); model = s.model; lights = s.lights; }
else { const f = JSON.parse(readFileSync(src, 'utf8')) as ModelFile & { lights?: Light[] }; model = Model.fromJSON(f); lights = f.lights ?? []; }

const N = Number(arg('cuadros', '36')), scale = Number(arg('escala', '3')), elevation = Number(arg('elev', '35'));
const lit = process.argv.includes('--luz'), a = Number(arg('ambiente', '0.35'));
const ambient: [number, number, number] = [a * 0.86, a * 0.9, a];
const f = fitFrame(model.bounds(), elevation);

const frames = Array.from({ length: N }, (_, i) => {
  const o: RenderOptions = { width: f.W, height: f.H, originX: f.originX, originY: f.originY, yaw: -30 + (360 * i) / N, elevation, outline: arg('contorno', 'outer') as RenderOptions['outline'], pick: lit };
  const img = render(model, o);
  if (!lit) return img.rgba;
  // La luz como en la vista previa de la app (app/src/preview.ts, shot): por cara, con sombras, y por las capas MULTIPLY/ADD
  const pts = lights.map((l) => { const p = SOURCE_PRESETS[l.kind]; return { x: l.x + 0.5, y: l.y + 0.5, z: l.z + 0.5, radius: p.radius, color: p.color, intensity: lightIntensity(lightOf({ id: l.id, kind: l.kind, x: 0, y: 0 }), i / 12) }; });
  const total = lightField3D(model, img, camera(o), pts, ambient);
  for (let p = 0; p < f.W * f.H; p++) {
    if (!Number.isNaN(img.pickKey![p]!) || img.rgba[p * 4 + 3] === 0) continue;
    const x = p % f.W;
    for (const n of [p - 1, p + 1, p - f.W, p + f.W]) {
      if (n < 0 || n >= f.W * f.H || Math.abs((n % f.W) - x) > 1 || Number.isNaN(img.pickKey![n]!)) continue;
      total.copyWithin(p * 3, n * 3, n * 3 + 3);
      break;
    }
  }
  const layers = buildLayers({ cell: 1, cols: f.W, rows: f.H, ambient, total }, { x: 0, y: 0, width: f.W, height: f.H }, { steps: 8, softGlow: true });
  return applyLayers(img.rgba, layers) as Uint8ClampedArray;
});

// El GIF admite 255 colores: con luz hay más. Se quedan los 255 más usados y el resto va al más cercano.
const count = new Map<number, number>();
for (const rgba of frames) for (let p = 0; p < rgba.length; p += 4) if (rgba[p + 3]) { const c = (rgba[p]! << 16) | (rgba[p + 1]! << 8) | rgba[p + 2]!; count.set(c, (count.get(c) ?? 0) + 1); }
if (count.size > 255) {
  const keep = [...count.entries()].sort((x, y) => y[1] - x[1]).slice(0, 255).map(([c]) => c);
  const near = new Map<number, number>();
  const nearest = (c: number) => {
    let hit = near.get(c);
    if (hit !== undefined) return hit;
    let best = keep[0]!, bd = Infinity;
    for (const k of keep) { const d = ((k >> 16) - (c >> 16)) ** 2 + (((k >> 8) & 255) - ((c >> 8) & 255)) ** 2 + ((k & 255) - (c & 255)) ** 2; if (d < bd) { bd = d; best = k; } }
    near.set(c, (hit = best));
    return hit;
  };
  for (const rgba of frames) for (let p = 0; p < rgba.length; p += 4) {
    if (!rgba[p + 3]) continue;
    const c = nearest((rgba[p]! << 16) | (rgba[p + 1]! << 8) | rgba[p + 2]!);
    rgba[p] = c >> 16; rgba[p + 1] = (c >> 8) & 255; rgba[p + 2] = c & 255;
  }
}
writeFileSync(out, encodeGIF(f.W, f.H, frames, Number(arg('ms', '80')), scale));
console.log(`${out}: ${N} cuadros de ${f.W}x${f.H} a x${scale}${lit ? `, con ${lights.length} luces` : ''}, ${count.size} colores`);
