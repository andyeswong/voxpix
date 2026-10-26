// EFECTOS en el editor (src/core/effects.ts): emisores que son objetos del modelo, como las luces (celda x, y, z, en
// el espacio del modelo), y se guardan con él. Mientras haya alguno, las partículas corren a 60 Hz y chocan con los
// vóxeles del modelo y con el suelo (z < 0); se pintan encima del editor 3D (con su profundidad: lo que hay delante
// las tapa) y en Explorar. No cambian los vóxeles ni la paleta.
import { reactive } from 'vue';
import { FxSystem, fxRandom, FX_PRESETS, FX_STRIDE, materialsOf, fpBasis, type FxPreset, type FpCamera, type Rendered } from '@core/index';
import { model } from './store';

export interface EffectSource { id: string; preset: FxPreset; x: number; y: number; z: number }
export const FX_KINDS = Object.keys(FX_PRESETS) as FxPreset[];

export const fx = reactive({
  sources: [] as EffectSource[],
  kind: 'humo' as FxPreset,      // el que pone la herramienta
  running: true,                 // pausa (la barra de la herramienta)
  alive: 0,
  frame: 0,                      // sube con cada paso: quien pinta las partículas lo escucha
});

let sys = new FxSystem(fxRandom(1));
const ids = new Map<string, number>();       // id del emisor del editor -> id en el sistema
let fxIds = 0;

// Rehace el sistema desde los emisores (al cargar un modelo, al quitar uno)
export function resetEffects(): void {
  sys = new FxSystem(fxRandom(1));
  ids.clear();
  for (const s of fx.sources) ids.set(s.id, sys.add(s.preset, s.x + 0.5, s.y + 0.5, s.z + 0.5));
  ensureLoop();
}

export function addEffect(preset: FxPreset, x: number, y: number, z: number): string {
  if (!FX_PRESETS[preset]) throw new Error(`efecto desconocido: ${preset} (hay ${FX_KINDS.join(', ')})`);
  const id = `fx-${Date.now().toString(36)}-${++fxIds}`;
  fx.sources.push({ id, preset, x, y, z });
  ids.set(id, sys.add(preset, x + 0.5, y + 0.5, z + 0.5));
  ensureLoop();
  return id;
}

export function removeEffect(id: string): boolean {
  const i = fx.sources.findIndex((s) => s.id === id);
  if (i < 0) return false;
  fx.sources.splice(i, 1);
  const sid = ids.get(id);
  if (sid !== undefined) sys.remove(sid);
  ids.delete(id);
  return true;
}

// La herramienta: clic en una celda pone un emisor del tipo elegido; sobre uno, lo quita
export function toggleEffect(x: number, y: number, z: number): void {
  const s = fx.sources.find((e) => e.x === x && e.y === y && e.z === z);
  if (s) removeEffect(s.id); else addEffect(fx.kind, x, y, z);
}

// Una ráfaga suelta (sin emisor): para probar un golpe
export function burstEffect(preset: FxPreset, x: number, y: number, z: number, count?: number): void {
  sys.burst(preset, x + 0.5, y + 0.5, z + 0.5, count);
  ensureLoop();
}

export function loadEffects(list: EffectSource[] | undefined): void {
  fx.sources.splice(0, fx.sources.length, ...(list ?? []).filter((s) => FX_PRESETS[s.preset]).map((s) => ({ ...s })));
  resetEffects();
}

// ---- el bucle: 60 pasos por segundo mientras haya emisores o partículas vivas
let timer = 0;
function solid(): (x: number, y: number, z: number) => boolean {
  const m = model.value, mt = materialsOf(m.palette);
  return (x, y, z) => {
    if (z < 0) return true;
    const v = m.get(x, y, z);
    return !!v && (!mt || mt.blocks[v] === 1);
  };
}
function ensureLoop(): void {
  if (timer || typeof window === 'undefined') return;
  timer = window.setInterval(() => {
    if (!fx.running) return;
    sys.step(1 / 60, solid());
    fx.alive = sys.alive;
    fx.frame++;
    if (!fx.sources.length && !sys.alive) { clearInterval(timer); timer = 0; }
  }, 1000 / 60);
}

export function fxPoints(): { n: number; d: Float32Array } { return { n: sys.count, d: sys.packed }; }

// ---- pintar
// Sobre una imagen ya renderizada con la cámara de la vista (render.ts): cada partícula con su color y tamaño (a
// `ppu` píxeles por vóxel, como mínimo 1), detrás de lo que tenga delante
export function drawEffects3D(g: CanvasRenderingContext2D, project: (x: number, y: number, z: number) => [number, number, number], img: Rendered, ppu: number): void {
  const { n, d } = fxPoints();
  const W = img.width, H = img.height;
  const size = Math.max(1, Math.round(ppu * 0.35));
  for (let k = 0; k < n; k++) {
    const q = k * FX_STRIDE;
    const [sx, sy, depth] = project(d[q]!, d[q + 1]!, d[q + 2]!);
    const tx = Math.floor(sx), ty = Math.floor(sy);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
    if (depth >= img.depth[ty * W + tx]! - 0.3) continue;
    const s = size * d[q + 6]!, len = d[q + 8]!;
    g.fillStyle = `rgb(${d[q + 3]},${d[q + 4]},${d[q + 5]})`;
    g.fillRect(tx - (s >> 1), ty - (s >> 1) - (len - 1) * size, s, s + (len - 1) * size);
  }
}

// En la primera persona (Explorar): en la imagen de baja resolución, 1 o 2 píxeles, con su profundidad (la distancia
// por delante de la cámara, como renderFirstPerson)
export function drawEffectsFp(out: Uint8ClampedArray, cam: FpCamera, img: Rendered): void {
  const { n, d } = fxPoints();
  const W = img.width, H = img.height;
  const { f, r, u } = fpBasis(cam);
  const th = Math.tan(((cam.fov ?? 70) * Math.PI) / 360), tv = th * (H / W);
  for (let k = 0; k < n; k++) {
    const q = k * FX_STRIDE;
    const dx = d[q]! - cam.x, dy = d[q + 1]! - cam.y, dz = d[q + 2]! - cam.z;
    const zc = dx * f[0] + dy * f[1] + dz * f[2];
    if (zc < 0.2) continue;
    const a = (dx * r[0] + dy * r[1] + dz * r[2]) / (zc * th), b = (dx * u[0] + dy * u[1] + dz * u[2]) / (zc * tv);
    const i = Math.floor(((a + 1) / 2) * W), j = Math.floor(((1 - b) / 2) * H);
    // Más cerca, más grande (hasta 3 píxeles)
    const s = Math.max(1, Math.min(3, Math.round((d[q + 6]! * 6) / zc)));
    for (let jj = 0; jj < s; jj++) for (let ii = 0; ii < s; ii++) {
      const x = i + ii, y = j + jj;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const p = y * W + x;
      if (img.rgba[p * 4 + 3] && zc >= img.depth[p]! - 0.05) continue;
      out[p * 4] = d[q + 3]!; out[p * 4 + 1] = d[q + 4]!; out[p * 4 + 2] = d[q + 5]!; out[p * 4 + 3] = 255;
    }
  }
}
