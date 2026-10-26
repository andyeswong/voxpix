// Importar un .px.js sin ejecutarlo en la página: cada trabajo va a un worker nuevo (app/src/pxl/worker.ts), que se
// mata al acabar o al pasar el tiempo. Lo que vuelve se trata como datos ajenos: se valida antes de tocar el modelo.
import { Model, decode, type ModelFile, type Palette, type Ramp } from '../../../src/core';
import { MATERIALS } from '../../../src/core/materials';

export type PxlJob =
  | { kind: 'inspect'; source: string; name: string }
  | { kind: 'new'; source: string; name: string; modelName: string; sprite?: string; palette?: string; plane: 'front' | 'top'; z: number }
  | { kind: 'into'; source: string; name: string; into: Palette; sprite: string; plane: 'front' | 'top'; z: number }
  | { kind: 'stack'; source: string; name: string; prefix: string };

export type PxlReply =
  | { ok: true; kind: 'inspect'; sprites: string[]; stacks: string[] }
  | { ok: true; kind: 'model'; model: ModelFile }
  | { ok: true; kind: 'voxels'; voxels: Array<[number, number, number, number]> }
  | { ok: false; error: string };

const TIMEOUT_MS = 15000;
const MAX_VOXELS = 256 * 256 * 256;
const HEX = /^#[0-9a-fA-F]{6}$/;

function run(job: PxlJob): Promise<PxlReply> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    const end = (f: () => void) => { clearTimeout(t); w.terminate(); f(); };
    const t = setTimeout(() => end(() => reject(new Error(`el .px.js tardó más de ${TIMEOUT_MS / 1000} s y se paró`))), TIMEOUT_MS);
    w.onmessage = (e: MessageEvent<PxlReply>) => end(() => resolve(e.data));
    w.onerror = (e) => end(() => reject(new Error(e.message || 'el .px.js falló')));
    w.postMessage(job);
  });
}

// Las comprobaciones: solo números, nombres y colores con su forma, y dentro de los límites del editor
const int = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
const str = (s: unknown, max = 200) => typeof s === 'string' && s.length <= max;

// Cada vóxel: coordenadas enteras dentro del lienzo máximo y un material que existe en la paleta donde va a caer
function voxels(list: unknown, pal: Palette): Array<[number, number, number, number]> {
  if (!Array.isArray(list) || list.length > MAX_VOXELS) throw new Error('el .px.js devolvió vóxeles no válidos');
  const out: Array<[number, number, number, number]> = [];
  for (const v of list) {
    if (!Array.isArray(v) || v.length !== 4 || !int(v[0], -256, 256) || !int(v[1], -256, 256) || !int(v[2], 0, 256) || !int(v[3], 1, 0xffff)) throw new Error('el .px.js devolvió un vóxel no válido');
    const { ramp, tone } = decode(v[3]);
    if (!pal.ramps[ramp] || tone >= pal.ramps[ramp]!.colors.length) throw new Error('el .px.js devolvió un vóxel con un color fuera de la paleta');
    out.push([v[0], v[1], v[2], v[3]]);
  }
  return out;
}

const NUM_PROPS = ['light', 'backlit', 'reflect'] as const;
const BOOL_PROPS = ['bed', 'blocks', 'climb', 'emissive'] as const;

// La paleta se rehace campo a campo con lo que se conoce: nada que venga de fuera pasa sin mirarlo
function palette(p: unknown): Palette {
  const pal = p as Palette;
  if (!pal || !Array.isArray(pal.ramps) || pal.ramps.length > 64) throw new Error('el .px.js devolvió una paleta no válida');
  const ramps = pal.ramps.map((r): Ramp => {
    if (!r || !str(r.name, 64) || !Array.isArray(r.colors) || r.colors.length < 1 || r.colors.length > 16 || !r.colors.every((c) => str(c, 7) && HEX.test(c))) throw new Error('el .px.js devolvió una rampa no válida');
    const out: Ramp = { name: r.name, colors: [...r.colors] };
    if (r.emissive === true) out.emissive = true;
    if (r.material !== undefined) {
      if (!str(r.material, 32) || !Object.hasOwn(MATERIALS, r.material)) throw new Error(`el .px.js pide un material que no existe: ${String(r.material).slice(0, 32)}`);
      out.material = r.material;
    }
    if (r.props !== undefined) {
      const props: NonNullable<Ramp['props']> = {};
      for (const k of NUM_PROPS) if (r.props[k] !== undefined) { if (typeof r.props[k] !== 'number' || !Number.isFinite(r.props[k])) throw new Error('propiedad de material no válida'); props[k] = r.props[k]; }
      for (const k of BOOL_PROPS) if (r.props[k] !== undefined) { if (typeof r.props[k] !== 'boolean') throw new Error('propiedad de material no válida'); props[k] = r.props[k]; }
      out.props = props;
    }
    if (r.kind === 'foliage' || r.kind === 'solid') out.kind = r.kind;
    if (r.blocks === true) out.blocks = true;
    return out;
  });
  if (pal.outline !== undefined && !(str(pal.outline, 7) && HEX.test(pal.outline))) throw new Error('el .px.js devolvió un contorno no válido');
  return { ramps, ...(pal.outline !== undefined ? { outline: pal.outline } : {}) };
}

function model(f: unknown): Model {
  const m = f as ModelFile;
  if (!m || m.format !== 'voxpix' || !str(m.name)) throw new Error('el .px.js no devolvió un modelo');
  const pal = palette(m.palette);
  return Model.fromJSON({ format: 'voxpix', version: 1, name: m.name, palette: pal, voxels: voxels(m.voxels, pal) });
}

async function ask(job: PxlJob): Promise<Extract<PxlReply, { ok: true }>> {
  const r = await run(job);
  if (!r || typeof r !== 'object') throw new Error('respuesta no válida del .px.js');
  if (!r.ok) throw new Error(str(r.error, 2000) ? r.error : 'el .px.js falló');
  return r;
}

// Los sprites y las pilas de capas del archivo
export async function inspectPxl(source: string, name: string): Promise<{ sprites: string[]; stacks: string[] }> {
  const r = await ask({ kind: 'inspect', source, name });
  if (r.kind !== 'inspect' || !Array.isArray(r.sprites) || !Array.isArray(r.stacks) || ![...r.sprites, ...r.stacks].every((s) => str(s))) throw new Error('respuesta no válida del .px.js');
  return { sprites: [...r.sprites], stacks: [...r.stacks] };
}

// Un modelo nuevo con la paleta del arte (y el sprite como plano de vóxeles, si se pide)
export async function pxlModel(source: string, name: string, o: { modelName: string; sprite?: string; plane: 'front' | 'top'; z: number }): Promise<Model> {
  const r = await ask({ kind: 'new', source, name, ...o });
  if (r.kind !== 'model') throw new Error('respuesta no válida del .px.js');
  return model(r.model);
}

// El sprite pasado a la paleta dada (la del modelo actual): sus vóxeles
export async function pxlSpriteInto(source: string, name: string, into: Palette, o: { sprite: string; plane: 'front' | 'top'; z: number }): Promise<Array<[number, number, number, number]>> {
  const r = await ask({ kind: 'into', source, name, into: structuredClone(into), ...o });
  if (r.kind !== 'voxels') throw new Error('respuesta no válida del .px.js');
  return voxels(r.voxels, into);
}

// Un modelo desde la pila de capas <prefijo>_zNN
export async function pxlStackModel(source: string, name: string, prefix: string): Promise<Model> {
  const r = await ask({ kind: 'stack', source, name, prefix });
  if (r.kind !== 'model') throw new Error('respuesta no válida del .px.js');
  return model(r.model);
}
