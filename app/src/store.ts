import { reactive, shallowRef, ref } from 'vue';
import { Model, History, material, type ModelFile } from '@core/index';
import { medievalScene } from '../../src/samples/medieval';

// Estado del editor. El modelo es mutable y no reactivo (es un Map grande); cada cambio sube `version` y
// los componentes que dibujan escuchan ese número.

export type Tool = 'pen' | 'erase' | 'paint' | 'pick' | 'box' | 'fill' | 'light' | 'fluid';
export type LightKind = 'torch' | 'lamp' | 'brazier' | 'neon-pink' | 'neon-cyan' | 'screen';

// La escena de muestra: un rincón medieval de 32 x 32 con sus luces (src/samples/medieval.ts)
const start = medievalScene();
export const model = shallowRef<Model>(start.model);
export const history = shallowRef(new History(model.value));
export const version = ref(0);

export const editor = reactive({
  tool: 'pen' as Tool,
  ramp: 0,
  tone: 2,
  z: 0,
  mirrorX: false,
  mirrorAxis: 0,               // espejo respecto al centro del vóxel x = mirrorAxis
  // La rejilla donde se edita (el lienzo): x e y con el pivote (0, 0) en medio, y z de 0 a maxZ (las capas)
  grid: { minX: -16, maxX: 15, minY: -16, maxY: 15, maxZ: 23 },
  view: { yaw: -30, elevation: 35, outline: 'outer' as 'none' | 'outer' | 'both', scale: 8, turn: 8 },
  mode: 'layers' as 'layers' | 'voxel3d',                    // cómo se edita: por capas o sobre el modelo en 3D
  view3d: { yaw: -30, elevation: 35, zoom: 12, panX: 0, panY: 0 },   // pan: desplazamiento de la vista en píxeles
  // Fuentes de luz de la escena, en el ESPACIO DEL MODELO (celda x, y, z): el render las interpreta en 2.5D.
  // Solo afectan a la vista previa iluminada; no cambian los vóxeles ni la paleta. Se guardan con el modelo.
  light: {
    enabled: false,
    ambient: 0.45,
    kind: 'torch' as LightKind,
    sources: start.lights.map((l) => ({ ...l })) as LightSource3D[],
  },
});

// Lo de la interfaz que no es del modelo: qué paneles flotantes están abiertos y la celda bajo el cursor
export const ui = reactive({
  layersOpen: true,
  previewOpen: true,
  paletteOpen: false,
  menu: '' as '' | 'archivo' | 'edicion' | 'exportar',
  dialog: '' as '' | 'nuevo' | 'lienzo',          // el modal abierto
  cursor: null as [number, number, number] | null,
  renderMs: 0,
  backend: 'gpu' as 'gpu' | 'cpu',               // con qué se renderiza (preview.ts); 'cpu' si no hay WebGL2
  gpuAvailable: false,
});

export interface LightSource3D { id: string; kind: LightKind; x: number; y: number; z: number }

let lightIds = 0;
export function lightAtCell(x: number, y: number, z: number): number {
  return editor.light.sources.findIndex((l) => l.x === x && l.y === y && l.z === z);
}
// Pone una fuente en la celda, o la quita si ya hay una
export function toggleLight(x: number, y: number, z: number): void {
  const i = lightAtCell(x, y, z);
  if (i >= 0) editor.light.sources.splice(i, 1);
  else editor.light.sources.push({ id: `luz-${Date.now().toString(36)}-${++lightIds}`, kind: editor.light.kind, x, y, z });
  editor.light.enabled = true;
}

export const currentMaterial = () => material(editor.ramp, editor.tone);

export function touch(): void {
  version.value++;
}

export function replaceModel(m: Model): void {
  model.value = m;
  history.value = new History(m);
  const b = m.bounds();
  if (b) {
    editor.z = Math.max(0, Math.min(editor.z, b.maxZ));
    editor.grid = {
      minX: Math.min(-20, b.minX - 2), maxX: Math.max(19, b.maxX + 2),
      minY: Math.min(-10, b.minY - 2), maxY: Math.max(9, b.maxY + 2),
      maxZ: Math.max(23, b.maxZ + 2),
    };
  }
  touch();
}

// ---- tamaño del lienzo (la rejilla): ancho (x), fondo (y) y alto (z, las capas)
export function gridSize(): { w: number; d: number; h: number } {
  const g = editor.grid;
  return { w: g.maxX - g.minX + 1, d: g.maxY - g.minY + 1, h: g.maxZ + 1 };
}

// La rejilla de w x d x h centrada en el pivote
function gridOf(w: number, d: number, h: number) {
  const minX = -Math.floor(w / 2), minY = -Math.floor(d / 2);
  return { minX, maxX: minX + w - 1, minY, maxY: minY + d - 1, maxZ: h - 1 };
}

// Cuántos vóxeles del modelo quedarían fuera de una rejilla de ese tamaño
export function voxelsOutside(w: number, d: number, h: number): number {
  const g = gridOf(w, d, h);
  let n = 0;
  for (const [x, y, z] of model.value.entries()) if (x < g.minX || x > g.maxX || y < g.minY || y > g.maxY || z < 0 || z > g.maxZ) n++;
  return n;
}

// Cambia el tamaño del lienzo; con `crop`, lo que queda fuera se borra (en un paso de deshacer)
export function setGridSize(w: number, d: number, h: number, crop: boolean): void {
  const g = gridOf(w, d, h);
  if (crop) {
    const out = [...model.value.entries()].filter(([x, y, z]) => x < g.minX || x > g.maxX || y < g.minY || y > g.maxY || z < 0 || z > g.maxZ);
    if (out.length) {
      history.value.begin();
      for (const [x, y, z] of out) history.value.set(x, y, z, 0);
      history.value.commit();
    }
  }
  editor.grid = g;
  editor.z = Math.min(editor.z, g.maxZ);
  touch();
}

// Modelo nuevo, vacío, con la paleta actual y un lienzo de ese tamaño
export function newModelSized(name: string, w: number, d: number, h: number): void {
  replaceModel(new Model(model.value.palette, name || 'nuevo'));
  editor.grid = gridOf(w, d, h);
  editor.z = 0;
  touch();
}

// Pinta un vóxel (y su espejo si está activo) dentro del paso abierto del historial
export function paint(x: number, y: number, z: number, value: number): void {
  const h = history.value;
  h.set(x, y, z, value);
  if (editor.mirrorX) h.set(2 * editor.mirrorAxis - x, y, z, value);
}

export function loadFile(f: ModelFile & { lights?: LightSource3D[] }): void {
  replaceModel(Model.fromJSON(f));
  editor.light.sources.splice(0, editor.light.sources.length, ...(f.lights ?? []));
  // Si trae luces, se ve con ellas (como al ponerlas con la herramienta)
  if (f.lights?.length) editor.light.enabled = true;
}

// La escena de muestra, de nuevo (Archivo > Escena de muestra), con su lienzo de 32 x 32 y sus luces
export function loadSample(): void {
  const { model: m, lights } = medievalScene();
  replaceModel(m);
  editor.grid = { minX: -16, maxX: 15, minY: -16, maxY: 15, maxZ: 23 };
  editor.light.sources.splice(0, editor.light.sources.length, ...lights.map((l) => ({ ...l })));
  touch();
}

export function newModel(): void {
  replaceModel(new Model(model.value.palette, 'nuevo'));
}

// Estado inicial desde la URL (para enlazar una vista o probar sin clics):
//   ?modo=voxel3d  ·  ?luz=torch:-8,-4,10;neon-cyan:12,2,6 (celdas x,y,z)  ·  ?ambiente=0.4  ·  ?giro=30
{
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  if (q.get('modo') === 'voxel3d') editor.mode = 'voxel3d';
  const luz = q.get('luz');
  if (luz) {
    editor.light.enabled = true;
    for (const part of luz.split(';')) {
      const [kind, xy] = part.split(':');
      const [x, y, z] = (xy ?? '').split(',').map(Number);
      if (kind && [x, y, z].every(Number.isFinite)) { editor.light.kind = kind as LightKind; toggleLight(x!, y!, z!); }
    }
  }
  if (q.get('ambiente')) editor.light.ambient = Number(q.get('ambiente'));
  if (q.get('giro')) editor.view.yaw = Number(q.get('giro'));
  if (q.get('herramienta')) editor.tool = q.get('herramienta') as Tool;
}
