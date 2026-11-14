// SET DE BLOQUES en el editor (NARUTO): varios modelos de N x N x N con nombre que comparten la paleta, para un mundo
// de bloques (src/world/blocks.ts). Se pinta cada bloque en el lienzo de siempre (de N x N x N) con las herramientas de
// siempre; el set guarda los bloques y exporta un .voxset.json. Lo usan la API (window.voxpix: newSet, addBlock,
// block, saveBlock, removeBlock, blocks, saveSet, loadSet) y el panel "Bloques".
import { reactive } from 'vue';
import { Model, material, decode, iconSheet, type Palette, type IconOptions, type IconSheet } from '@core/index';
import { BlockSet, type BlockProps, type VoxsetFile } from '../../src/world/blocks';
import { model, editor, replaceModel, newModelSized, touch } from './store';

interface StoredBlock {
  id: string;
  voxels: Array<[number, number, number, number]>;    // en 0..N-1, con los valores de `palette`
  palette: Palette;                                     // la paleta con la que se guardó (para traducirlo al exportar)
  props: Partial<BlockProps>;
}

export const blockSet = reactive({
  active: false,
  name: '',
  size: 8,
  current: null as string | null,          // el bloque que está en el lienzo
  blocks: [] as StoredBlock[],
});

// El lienzo de un bloque: x e y de -N/2 a N/2-1 y z de 0 a N-1 (el pivote en el centro de la base, como siempre)
const origin = () => ({ x: -Math.floor(blockSet.size / 2), y: -Math.floor(blockSet.size / 2) });

function need(): void {
  if (!blockSet.active) throw new Error('no hay set de bloques abierto: newSet(nombre, tamaño) o loadSet(json)');
}

// Lo que hay en el lienzo, como vóxeles de bloque (0..N-1); error si algo cae fuera
function canvasVoxels(): Array<[number, number, number, number]> {
  const N = blockSet.size, o = origin(), out: Array<[number, number, number, number]> = [];
  for (const [x, y, z, v] of model.value.entries()) {
    const bx = x - o.x, by = y - o.y;
    if (bx < 0 || by < 0 || z < 0 || bx >= N || by >= N || z >= N) throw new Error(`hay un vóxel fuera del bloque de ${N}: ${x}, ${y}, ${z} (el lienzo del bloque va de ${o.x} a ${o.x + N - 1} en x e y, y de 0 a ${N - 1} en z)`);
    out.push([bx, by, z, v]);
  }
  if (!out.length) throw new Error('el lienzo está vacío: pinta el bloque antes de guardarlo');
  return out;
}

function showBlock(b: StoredBlock | null): void {
  const N = blockSet.size, o = origin();
  const m = new Model(model.value.palette, b?.id ?? 'bloque');
  if (b) for (const [x, y, z, v] of translate(b.voxels, b.palette, model.value.palette)) m.set(x + o.x, y + o.y, z, v);
  replaceModel(m);
  editor.grid = { minX: o.x, maxX: o.x + N - 1, minY: o.y, maxY: o.y + N - 1, maxZ: N - 1 };
  editor.z = 0;
  blockSet.current = b?.id ?? null;
  touch();
}

// Vóxeles de una paleta a otra por el NOMBRE de su rampa (el tono se queda, dentro de los que tenga)
function translate(vox: ReadonlyArray<readonly [number, number, number, number]>, from: Palette, to: Palette): Array<[number, number, number, number]> {
  if (from === to) return vox.map(([x, y, z, v]) => [x, y, z, v]);
  return vox.map(([x, y, z, v]) => {
    const { ramp, tone } = decode(v);
    const name = from.ramps[ramp]?.name;
    const j = to.ramps.findIndex((r) => r.name === name);
    if (j < 0) throw new Error(`la rampa "${name}" de un bloque ya no está en la paleta: vuelve a ponerla o repinta el bloque`);
    return [x, y, z, material(j, Math.min(tone, to.ramps[j]!.colors.length - 1))];
  });
}

// El set entero con la paleta de ahora, comprobado por el motor (BlockSet.fromJSON: propiedades, covered...)
function file(): VoxsetFile {
  const pal = model.value.palette;
  const f: VoxsetFile = {
    format: 'voxpix-set', version: 1, name: blockSet.name, size: blockSet.size,
    palette: { ...pal, ramps: pal.ramps.map((r) => ({ ...r, colors: [...r.colors] })) },
    blocks: blockSet.blocks.map((b) => ({ id: b.id, voxels: translate(b.voxels, b.palette, pal), ...(Object.keys(b.props).length ? { props: b.props } : {}) })),
  };
  return BlockSet.fromJSON(f).toJSON();
}

export function newSet(name: string, size = 8): void {
  if (!Number.isInteger(size) || size < 1 || size > 64) throw new Error('el tamaño del bloque va de 1 a 64');
  Object.assign(blockSet, { active: true, name: name || 'bloques', size, current: null, blocks: [] });
  newModelSized(name || 'bloque', size, size, size);
  showBlock(null);
}

// Guarda lo que hay en el lienzo como un bloque NUEVO con ese id, y se queda en él
export function addBlock(id: string, props: Partial<BlockProps> = {}): number {
  need();
  if (!id) throw new Error('el bloque necesita un id');
  if (blockSet.blocks.some((b) => b.id === id)) throw new Error(`ya hay un bloque "${id}": para cambiarlo, block("${id}") y saveBlock()`);
  const b = { id, voxels: canvasVoxels(), palette: model.value.palette, props: { ...props } };
  check(b);
  blockSet.blocks.push(b);
  blockSet.current = id;
  model.value.name = id;
  return blockSet.blocks.length;
}

// Pone en el lienzo un bloque (por id o por número desde 1) para verlo o cambiarlo; null deja el lienzo vacío
export function block(which: string | number | null): string | null {
  need();
  if (which === null) { showBlock(null); return null; }
  const b = typeof which === 'number' ? blockSet.blocks[which - 1] : blockSet.blocks.find((x) => x.id === which);
  if (!b) throw new Error(`no hay bloque ${JSON.stringify(which)}; hay: ${blockSet.blocks.map((x) => x.id).join(', ') || 'ninguno'}`);
  showBlock(b);
  return b.id;
}

// Guarda el lienzo en el bloque que está abierto (y cambia sus propiedades si se dan)
export function saveBlock(props?: Partial<BlockProps>): string {
  need();
  const b = blockSet.blocks.find((x) => x.id === blockSet.current);
  if (!b) throw new Error('no hay bloque abierto: addBlock(id) para uno nuevo, o block(id)');
  const next = { ...b, voxels: canvasVoxels(), palette: model.value.palette, props: props ? { ...props } : b.props };
  check(next);
  Object.assign(b, next);
  return b.id;
}

export function removeBlock(id: string): void {
  need();
  const i = blockSet.blocks.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`no hay bloque "${id}"`);
  blockSet.blocks.splice(i, 1);
  if (blockSet.current === id) blockSet.current = null;
}

// Que el motor acepte el bloque solo (sus propiedades contra sus rampas)
function check(b: StoredBlock): void {
  const props = { ...b.props };
  delete props.covered;                 // puede nombrar un bloque que todavía no existe; se comprueba al exportar
  new BlockSet(blockSet.name, blockSet.size, model.value.palette).add(b.id, translate(b.voxels, b.palette, model.value.palette), props);
}

export function listBlocks(): Array<{ index: number; id: string; voxels: number; props: BlockProps; current: boolean }> {
  need();
  const set = new BlockSet(blockSet.name, blockSet.size, model.value.palette);
  return blockSet.blocks.map((b, i) => {
    const props = { ...b.props }; delete props.covered;
    set.add(b.id, translate(b.voxels, b.palette, model.value.palette), props);
    return { index: i + 1, id: b.id, voxels: b.voxels.length, props: { ...set.get(i + 1).props, ...(b.props.covered ? { covered: b.props.covered } : {}) }, current: b.id === blockSet.current };
  });
}

export function saveSet(): VoxsetFile {
  need();
  if (!blockSet.blocks.length) throw new Error('el set no tiene bloques');
  return file();
}

// La hoja de iconos del set: cada bloque pintado con el mismo ángulo y escala en su celda (iconSheet, en el núcleo), con
// su índice id -> recuadro
export function setIcons(o: IconOptions = {}): IconSheet {
  need();
  const set = BlockSet.fromJSON(saveSet());
  return iconSheet(set.ids().map((id) => ({ id, model: set.get(set.index(id)).model })), o);
}

// La hoja (o un icono suelto: { width, height, rgba }) a PNG (en el navegador, por un lienzo)
export function sheetToPng(s: Pick<IconSheet, 'width' | 'height' | 'rgba'>): Promise<Blob> {
  const c = document.createElement('canvas');
  c.width = s.width; c.height = s.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(s.rgba), s.width, s.height), 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('sin PNG'))), 'image/png'));
}

export function loadSet(json: string | VoxsetFile): { name: string; size: number; blocks: string[] } {
  const f = typeof json === 'string' ? JSON.parse(json) as VoxsetFile : json;
  const set = BlockSet.fromJSON(f);           // comprueba el archivo
  const pal: Palette = { ...f.palette, ramps: f.palette.ramps.map((r) => ({ ...r, colors: [...r.colors] })) };
  replaceModel(new Model(pal, f.name));
  Object.assign(blockSet, {
    active: true, name: f.name, size: f.size, current: null,
    blocks: f.blocks.map((b) => ({ id: b.id, voxels: b.voxels.map(([x, y, z, v]) => [x, y, z, v] as [number, number, number, number]), palette: model.value.palette, props: { ...(b.props ?? {}) } })),
  });
  showBlock(blockSet.blocks[0] ?? null);
  return { name: f.name, size: f.size, blocks: set.ids() };
}

export function closeSet(): void {
  Object.assign(blockSet, { active: false, name: '', current: null, blocks: [] });
}
