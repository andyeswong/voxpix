// ANIMACIÓN (NARUTO, pedido de Andrés): un modelo con cuadros. Cada cuadro es el modelo entero (todos con la misma
// paleta), con su duración. El archivo .voxpix.json sube a la versión 2 solo si hay más de un cuadro o un rig:
//   { format: 'voxpix', version: 2, name, palette, voxels: <cuadro 0>, animation: { frames: [{ ms }, { ms, voxels }, ...], rig? } }
// El cuadro 0 va en `voxels`, así quien lea la versión 1 ve el primer cuadro. Sin animación se guarda en la versión 1,
// con los mismos bytes que antes de que existiera.
import { Model, type ModelFile } from './model';
import type { Palette } from './palette';

export interface AnimFrame { model: Model; ms: number }
export const DEFAULT_FRAME_MS = 100;

// El rig se guarda tal cual (src/anim/rig.ts, RigSpec): el núcleo no lo interpreta
export interface AnimationFile {
  frames: Array<{ ms: number; voxels?: Array<[number, number, number, number]> }>;
  rig?: unknown;
}
export interface ModelFileV2 extends Omit<ModelFile, 'version'> { version: 2; animation: AnimationFile }

export function animationToFile(frames: readonly AnimFrame[], rig?: unknown): ModelFile | ModelFileV2 {
  const base = frames[0]!.model;
  if (frames.length <= 1 && rig === undefined) return base.toJSON();
  return {
    format: 'voxpix', version: 2, name: base.name, palette: base.palette, voxels: [...base.entries()],
    animation: {
      frames: frames.map((f, i) => (i === 0 ? { ms: f.ms } : { ms: f.ms, voxels: [...f.model.entries()] })),
      ...(rig !== undefined ? { rig } : {}),
    },
  };
}

export function animationFromFile(f: ModelFile | ModelFileV2): { frames: AnimFrame[]; rig?: unknown } {
  const base = Model.fromJSON({ ...f, version: 1 } as ModelFile);
  if (f.version !== 2 || !('animation' in f)) return { frames: [{ model: base, ms: DEFAULT_FRAME_MS }] };
  const a = f.animation, pal: Palette = base.palette;
  const frames: AnimFrame[] = a.frames.map((fr, i) => {
    if (i === 0) return { model: base, ms: fr.ms };
    const m = new Model(pal, base.name);
    for (const [x, y, z, v] of fr.voxels ?? []) m.set(x, y, z, v);
    return { model: m, ms: fr.ms };
  });
  if (!frames.length) frames.push({ model: base, ms: DEFAULT_FRAME_MS });
  return { frames, ...(a.rig !== undefined ? { rig: a.rig } : {}) };
}
