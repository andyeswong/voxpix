// API para agentes: window.voxpix. Lo mismo que las herramientas de la app, sin ratón: un agente que controla el
// navegador (CDP, Playwright...) llama a estas funciones con evaluate y ve el resultado en la app, como una persona.
// Cada llamada que cambia el modelo es UN paso de deshacer; voxpix.batch(fn) junta varias en uno.
// voxpix.help() devuelve esta guía en texto.
//
// Coordenadas: x hacia el este, y hacia el norte, z hacia arriba (z >= 0); el pivote (0, 0, 0) en el centro del
// lienzo. Material: un número (rampa*16 + tono + 1), "nombre" (la rampa con ese nombre, tono 2 o el del medio),
// "nombre:tono", [rampa, tono] o null (vacío = borrar).
import { Model, material as mat, decode, validatePalette, type ModelFile } from '@core/index';
import { model, history, editor, ui, touch, replaceModel, loadFile, setGridSize, newModelSized, gridSize, toggleLight, lightAtCell, paint, type LightKind, type LightSource3D } from './store';
import { fillBox, floodLayer, fillWater, step } from './edit';
import { pngBlob } from './preview';
import { loadPxl, paletteFromPxl, stackFromPxl, stackPrefixes, pxlDirectives, applyDirectives } from '../../src/pxl/bridge';
import { SOURCE_PRESETS } from '../../src/lighting';

export type Material = number | string | [number, number] | null;

function ramps() {
  return model.value.palette.ramps.map((r, index) => ({ index, name: r.name, colors: r.colors, ...(r.emissive ? { emissive: true } : {}) }));
}

// El material como número (0 = vacío)
export function resolve(m: Material): number {
  if (m === null || m === 0) return 0;
  if (typeof m === 'number') return m;
  const rs = model.value.palette.ramps;
  if (Array.isArray(m)) {
    const [r, t] = m;
    if (!rs[r]) throw new Error(`no hay rampa ${r} (hay ${rs.length})`);
    if (t < 0 || t >= rs[r]!.colors.length) throw new Error(`la rampa ${rs[r]!.name} tiene tonos 0..${rs[r]!.colors.length - 1}`);
    return mat(r, t);
  }
  const [name, tone] = m.split(':');
  const r = rs.findIndex((x) => x.name === name);
  if (r < 0) throw new Error(`no hay rampa "${name}"; las rampas son: ${rs.map((x) => x.name).join(', ')}`);
  return resolve([r, tone === undefined ? Math.min(2, Math.floor((rs[r]!.colors.length - 1) / 2)) : Number(tone)]);
}

const int = (...v: number[]) => { for (const n of v) if (!Number.isInteger(n)) throw new Error(`las coordenadas son enteras: ${v.join(', ')}`); };

const KINDS = Object.keys(SOURCE_PRESETS) as LightKind[];

const HELP = `voxpix: la app VoxPix sin ratón. Cada llamada que cambia el modelo es un paso de deshacer.
Coordenadas: x este, y norte, z arriba (z >= 0); el pivote (0,0,0) en el centro del lienzo.
Material: número, "rampa", "rampa:tono", [rampa, tono] o null (vacío).

  info()                                   nombre, lienzo, vóxeles, rampas, luces, render (gpu/cpu)
  get(x, y, z)                             {ramp, tone, name} o null
  set(x, y, z, material)                   un vóxel (null lo borra)
  voxels([[x, y, z, material], ...])       muchos de una vez
  box(x0, y0, z0, x1, y1, z1, material)    la caja entre dos esquinas (incluidas); null la vacía
  fill(x, y, z, material)                  cubo: la mancha de la capa z que empieza en (x, y)
  water(x, y, z, material?)                agua hasta la altura z desde esa celda vacía, de una vez
                                           (material por defecto: la rampa "agua" o "water"); da {cells, spill}
  light(x, y, z, kind?)                    una fuente de luz (kind: ${KINDS.join(', ')}); da su id
  removeLight(idOrX, y?, z?)               la quita
  lights()                                 las fuentes
  palette([{name, colors, emissive?}], outline?)   cambia la paleta (rampas de oscuro a claro; no se deshace)
  canvas(w, d, h, crop?)                   tamaño del lienzo (crop: borra lo que quede fuera)
  newModel(name, w, d, h)                  modelo vacío con la paleta actual
  load(json)                               abre un .voxpix.json (objeto o texto)
  save()                                   el .voxpix.json (objeto)
  importPxl(source, stackPrefix?)          un .px.js: con prefijo, la pila de capas <prefijo>_zNN como modelo
  view({yaw, elevation, outline, lit, ambient})   la vista previa (y lo que exporta png)
  png({sheet?, scale?})                    PNG de la vista (o la hoja de ángulos), en base64; con luz si lit
  batch(fn)                                lo que haga fn, en un solo paso de deshacer
  undo(), redo()
  tool(name)                               cambia la herramienta de la interfaz (para enseñar lo que haces)`;

export const api = {
  version: 1,
  help: () => HELP,

  info() {
    const g = editor.grid, s = gridSize();
    return {
      name: model.value.name, voxels: model.value.size,
      canvas: { w: s.w, d: s.d, h: s.h, minX: g.minX, maxX: g.maxX, minY: g.minY, maxY: g.maxY, maxZ: g.maxZ },
      ramps: ramps(), lights: api.lights(), lightKinds: KINDS,
      view: { ...editor.view, lit: editor.light.enabled, ambient: editor.light.ambient },
      backend: ui.backend,
    };
  },

  get(x: number, y: number, z: number) {
    const v = model.value.get(x, y, z);
    if (!v) return null;
    const d = decode(v);
    return { ramp: d.ramp, tone: d.tone, name: model.value.palette.ramps[d.ramp]?.name ?? '?', value: v };
  },

  set(x: number, y: number, z: number, m: Material): void {
    int(x, y, z);
    const v = resolve(m);
    step(() => paint(x, y, z, v));
  },

  voxels(list: Array<[number, number, number, Material]>): number {
    const vals = list.map(([x, y, z, m]) => { int(x, y, z); return [x, y, z, resolve(m)] as const; });
    step(() => { for (const [x, y, z, v] of vals) paint(x, y, z, v); });
    return vals.length;
  },

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: Material): number {
    int(x0, y0, z0, x1, y1, z1);
    return fillBox(x0, y0, z0, x1, y1, z1, resolve(m));
  },

  fill(x: number, y: number, z: number, m: Material): number {
    int(x, y, z);
    return floodLayer(x, y, z, resolve(m));
  },

  water(x: number, y: number, z: number, m?: Material) {
    int(x, y, z);
    let v: number;
    if (m === undefined) {
      const r = model.value.palette.ramps.findIndex((x) => /^(agua|water)$/i.test(x.name));
      if (r < 0) throw new Error('no hay rampa "agua" ni "water": pasa el material');
      v = resolve([r, Math.min(2, model.value.palette.ramps[r]!.colors.length - 1)]);
    } else v = resolve(m);
    return fillWater(x, y, z, v);
  },

  light(x: number, y: number, z: number, kind: LightKind = 'torch'): string {
    int(x, y, z);
    if (!KINDS.includes(kind)) throw new Error(`tipos de luz: ${KINDS.join(', ')}`);
    const i = lightAtCell(x, y, z);
    if (i >= 0) { editor.light.sources[i]!.kind = kind; return editor.light.sources[i]!.id; }
    const before = editor.light.kind;
    editor.light.kind = kind;
    toggleLight(x, y, z);
    editor.light.kind = before;
    return editor.light.sources[editor.light.sources.length - 1]!.id;
  },

  removeLight(idOrX: string | number, y?: number, z?: number): boolean {
    const i = typeof idOrX === 'string' ? editor.light.sources.findIndex((l) => l.id === idOrX) : lightAtCell(idOrX, y!, z!);
    if (i < 0) return false;
    editor.light.sources.splice(i, 1);
    return true;
  },

  lights(): LightSource3D[] { return editor.light.sources.map((l) => ({ ...l })); },

  // Cambia la paleta: rampas de 1 a 16 colores (#rrggbb), de oscuro a claro. No se deshace. Los vóxeles guardan el
  // índice de rampa y tono: si ya hay modelo, las rampas que usa tienen que seguir existiendo.
  palette(rampList: Array<{ name: string; colors: string[]; emissive?: boolean }>, outline?: string) {
    const p = { ramps: rampList.map((r) => ({ name: r.name, colors: [...r.colors], ...(r.emissive ? { emissive: true } : {}) })), ...(outline ? { outline } : {}) };
    validatePalette(p);
    for (const [, , , v] of model.value.entries()) {
      const d = decode(v);
      if (!p.ramps[d.ramp] || d.tone >= p.ramps[d.ramp]!.colors.length) throw new Error(`el modelo usa la rampa ${d.ramp} tono ${d.tone}, que la paleta nueva no tiene`);
    }
    model.value.palette = p;
    touch();
    return ramps();
  },

  canvas(w: number, d: number, h: number, crop = false) { setGridSize(w, d, h, crop); return api.info().canvas; },

  newModel(name: string, w: number, d: number, h: number) {
    newModelSized(name, w, d, h);
    editor.light.sources.splice(0);
    return api.info();
  },

  load(json: string | (ModelFile & { lights?: LightSource3D[] })) {
    loadFile(typeof json === 'string' ? JSON.parse(json) : json);
    return api.info();
  },

  save() { return { ...model.value.toJSON(), lights: api.lights() }; },

  importPxl(source: string, stackPrefix?: string) {
    const p = loadPxl(source, 'api.px.js');
    const prefix = stackPrefix ?? stackPrefixes(p)[0];
    if (!prefix) throw new Error('el .px.js no tiene capas <prefijo>_zNN');
    const m = new Model(applyDirectives(paletteFromPxl(p, `${prefix}_z00`), pxlDirectives(source)), prefix);
    stackFromPxl(p, prefix, m);
    replaceModel(m);
    return api.info();
  },

  view(v: { yaw?: number; elevation?: number; outline?: 'outer' | 'both' | 'none'; lit?: boolean; ambient?: number } = {}) {
    if (v.yaw !== undefined) editor.view.yaw = v.yaw;
    if (v.elevation !== undefined) editor.view.elevation = v.elevation;
    if (v.outline !== undefined) editor.view.outline = v.outline;
    if (v.lit !== undefined) editor.light.enabled = v.lit;
    if (v.ambient !== undefined) editor.light.ambient = v.ambient;
    return api.info().view;
  },

  async png(o: { sheet?: boolean; scale?: number } = {}): Promise<{ name: string; base64: string }> {
    const { blob, name } = await pngBlob(o.sheet ? 'hoja' : 'vista', o.scale ?? 1);
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { name, base64: btoa(s) };
  },

  batch<T>(fn: () => T): T { return step(fn); },

  undo(): boolean { const ok = history.value.undo(); touch(); return ok; },
  redo(): boolean { const ok = history.value.redo(); touch(); return ok; },

  tool(name: typeof editor.tool) { editor.tool = name; },
};

export function installApi(): void {
  (window as unknown as { voxpix: typeof api }).voxpix = api;
}
