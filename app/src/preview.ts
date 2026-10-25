// El render del editor (y su luz): el de la GPU (src/view/gpu/voxrender.ts) si hay WebGL2, el de la CPU si no (o
// con ?ruta=cpu, o si se elige en la barra de estado). Los dos dan los mismos píxeles (app/oraculo-render.html).
// Y lo que comparten la vista previa y la exportación a PNG: el encuadre y la imagen iluminada.
import { render, camera, lightField3D, fitFrame, type RenderOptions, type Rendered, type PointLight3D, type VoxelSource, type Bounds, type Frame } from '@core/index';
import { GpuVoxelRenderer } from '../../src/view/gpu/voxrender';
import { lightIntensity, lightOf, SOURCE_PRESETS } from '../../src/lighting';
import { buildLayers, applyLayers } from '../../src/lighting/shade';
import { model, version, editor, ui } from './store';

let gpu: GpuVoxelRenderer | null | undefined;
function gpuRenderer(): GpuVoxelRenderer | null {
  if (gpu === undefined || gpu?.lost) {
    gpu = new URLSearchParams(location.search).get('ruta') === 'cpu' ? null : GpuVoxelRenderer.create();
    ui.gpuAvailable = !!gpu;
    if (!gpu) ui.backend = 'cpu';
  }
  return gpu;
}

// Como render(), por la ruta elegida. Con el modelo del editor, la versión dice si hay que volver a subirlo.
// Los últimos renders del modelo del editor se guardan: el parpadeo de las luces (12 Hz) no vuelve a rasterizar.
const recent = new Map<string, Rendered>();
let recentOf: unknown = null;
export function renderModel(o: RenderOptions, m: VoxelSource = model.value, rev: unknown = m === model.value ? version.value : undefined): Rendered {
  const cacheable = m === model.value;
  const k = cacheable ? `${ui.backend}|${JSON.stringify(o)}` : '';
  if (cacheable) {
    if (recentOf !== `${version.value}`) { recent.clear(); recentOf = `${version.value}`; }
    const hit = recent.get(k);
    if (hit) return hit;
  }
  const g = ui.backend === 'gpu' ? gpuRenderer() : null;
  const img = (g && g.render(m, o, rev)) || render(m, o);
  if (cacheable) {
    if (recent.size >= 12) recent.delete(recent.keys().next().value!);
    recent.set(k, img);
  }
  return img;
}
// Para la barra de estado: si la GPU está disponible (se prueba al arrancar)
export function probeGpu(): void { gpuRenderer(); }

// fitFrame (src/core/render.ts): 64x48 si el modelo cabe; si no, uno que lo contiene en cualquier giro
export type { Frame } from '@core/index';
export { SPRITE_FRAME } from '@core/index';
export function frameFor(m: VoxelSource & { bounds?: () => Bounds | null }, elevation: number): Frame {
  return fitFrame(m.bounds?.() ?? null, elevation);
}

export function viewOptions(f: Frame, yaw: number, pick: boolean): RenderOptions {
  return { width: f.W, height: f.H, originX: f.originX, originY: f.originY, yaw, elevation: editor.view.elevation, outline: editor.view.outline, pick };
}

// ---- la imagen iluminada (como en el juego): las fuentes del modelo alumbran cada cara de vóxel, con sombras de los
// propios vóxeles, y el resultado pasa por las capas MULTIPLY/ADD del motor de luz
const FLOOR = ['#3a3e4a', '#363a45'];
function hex(c: string): [number, number, number] {
  return [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) as [number, number, number];
}

// Fondo: 'plano' (gris), 'suelo' (losetas, para mirar con luz) o 'nada' (transparente, para exportar)
export type Background = 'plano' | 'suelo' | 'nada';
function compose(rgba: Uint8ClampedArray, W: number, H: number, bg: Background): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(W * H * 4);
  const flat = hex('#8a92a6');
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = (y * W + x) * 4;
    const a = rgba[p + 3]! > 0;
    if (a) { out[p] = rgba[p]!; out[p + 1] = rgba[p + 1]!; out[p + 2] = rgba[p + 2]!; out[p + 3] = 255; continue; }
    if (bg === 'nada') continue;
    let c = flat;
    if (bg === 'suelo') {
      c = hex(FLOOR[((x >> 4) + (y >> 4)) & 1]!);
      if (x % 16 === 0 || y % 16 === 0) c = c.map((v) => v * 0.85) as [number, number, number];
    }
    out[p] = c[0]; out[p + 1] = c[1]; out[p + 2] = c[2]; out[p + 3] = 255;
  }
  return out;
}

// Fuentes de la escena con su parpadeo en el instante `time` (mismos presets y ruido que el juego)
export function lightsAt(time: number): PointLight3D[] {
  return editor.light.sources.map((s) => {
    const p = SOURCE_PRESETS[s.kind];
    return { x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5, radius: p.radius, color: p.color, intensity: lightIntensity(lightOf({ id: s.id, kind: s.kind, x: 0, y: 0 }), time) };
  });
}

export function shot(f: Frame, yaw: number, opts: { lit: boolean; time: number; bg: Background }): Uint8ClampedArray<ArrayBuffer> {
  const { W, H } = f;
  const o = viewOptions(f, yaw, opts.lit);
  const img = renderModel(o);
  const scene = compose(img.rgba, W, H, opts.bg);
  if (!opts.lit) return scene;
  const a = editor.light.ambient;
  const ambient: [number, number, number] = [a * 0.86, a * 0.9, a];
  const lights = lightsAt(opts.time), cam = camera(o);
  const g = ui.backend === 'gpu' ? gpuRenderer() : null;
  const total = (g && g.lightField(model.value, o, cam, lights, ambient, {}, version.value)) || lightField3D(model.value, img, cam, lights, ambient);
  // Los píxeles de contorno no tienen vóxel: toman la luz de su vecino con vóxel para no quedarse a oscuras
  for (let i = 0; i < W * H; i++) {
    if (!Number.isNaN(img.pickKey![i]!) || img.rgba[i * 4 + 3] === 0) continue;
    const x = i % W;
    for (const n of [i - 1, i + 1, i - W, i + W]) {
      if (n < 0 || n >= W * H || Math.abs((n % W) - x) > 1 || Number.isNaN(img.pickKey![n]!)) continue;
      total[i * 3] = total[n * 3]!; total[i * 3 + 1] = total[n * 3 + 1]!; total[i * 3 + 2] = total[n * 3 + 2]!;
      break;
    }
  }
  const layers = buildLayers({ cell: 1, cols: W, rows: H, ambient, total }, { x: 0, y: 0, width: W, height: H }, { steps: 8, softGlow: true });
  return applyLayers(scene, layers) as Uint8ClampedArray<ArrayBuffer>;
}

// PNG con fondo transparente, del mismo render que la exportación a pxl y con el mismo encuadre que la vista previa
// (64x48 con el pivote en 32,42 si el modelo cabe; si no, uno que lo contiene): el ángulo de la vista previa, o la
// hoja con los N ángulos en fila; a escala entera, sin suavizar. Con la iluminación encendida, sale iluminado.
export function pngBlob(what: 'vista' | 'hoja', scale: number): Promise<{ blob: Blob; name: string }> {
  const m = model.value;
  const base = (m.name || 'modelo').replace(/[^a-zA-Z0-9_-]/g, '_');
  const f = frameFor(m, editor.view.elevation);
  const lit = editor.light.enabled;
  const yaws = what === 'vista' ? [editor.view.yaw] : Array.from({ length: editor.view.turn }, (_, i) => Math.round(editor.view.yaw + (360 * i) / editor.view.turn));
  const c = document.createElement('canvas');
  c.width = f.W * yaws.length * scale; c.height = f.H * scale;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  yaws.forEach((yaw, i) => {
    const off = document.createElement('canvas');
    off.width = f.W; off.height = f.H;
    off.getContext('2d')!.putImageData(new ImageData(shot(f, yaw, { lit, time: 0, bg: 'nada' }), f.W, f.H), 0, 0);
    g.drawImage(off, i * f.W * scale, 0, f.W * scale, f.H * scale);
  });
  const name = (what === 'vista' ? `${base}_a${String(((editor.view.yaw % 360) + 360) % 360).padStart(3, '0')}` : `${base}_${yaws.length}angulos`) + (lit ? '_luz' : '') + (scale > 1 ? `_x${scale}` : '') + '.png';
  return new Promise((resolve, reject) => c.toBlob((blob) => (blob ? resolve({ blob, name }) : reject(new Error('sin PNG'))), 'image/png'));
}
