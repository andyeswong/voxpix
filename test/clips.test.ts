// Clips con nombre: la versión 3 del .voxpix.json (con un clip "anim" que se repite, la de siempre, byte a byte), leer
// las versiones 1 y 2 como un clip, el cuadro de un clip en el tiempo, y los clips en el editor (app/src/anim.ts)
import { describe, it, expect } from 'vitest';
import { Model, material, box, animationToFile, clipsToFile, clipsFromFile, clipFrameAt, clipDone, DEFAULT_CLIP, type ModelFileV3 } from '../src/core';
import { replaceModel, model, history } from '../app/src/store';
import { anim, addFrame, clipInfo, selectClip, newClip, renameClip, deleteClip, setLoop, toFile, loadAnimated, frameModels } from '../app/src/anim';

const PAL = { ramps: [{ name: 'c', colors: ['#202020', '#606060', '#a0a0a0'] }] };
function pose(dz: number): Model {
  const m = new Model(PAL, 'bicho');
  box(m, -2, -2, dz, 1, 1, dz + 3, material(0, 1));
  return m;
}

describe('clips en el archivo', () => {
  it('un clip "anim" que se repite se guarda como la versión 1 o 2 de siempre; varios, en la 3', () => {
    const one = [{ model: pose(0), ms: 100 }, { model: pose(1), ms: 120 }];
    expect(JSON.stringify(clipsToFile([{ name: DEFAULT_CLIP, loop: true, frames: one }]))).toBe(JSON.stringify(animationToFile(one)));
    expect(clipsToFile([{ name: DEFAULT_CLIP, loop: true, frames: [one[0]!] }]).version).toBe(1);
    const f = clipsToFile([
      { name: 'quieto', loop: true, frames: [{ model: pose(0), ms: 250 }] },
      { name: 'morir', loop: false, frames: [{ model: pose(1), ms: 80 }, { model: pose(2), ms: 80 }] },
    ]) as ModelFileV3;
    expect(f.version).toBe(3);
    expect(f.voxels).toEqual([...pose(0).entries()]);            // quien lea la 1 ve el primer cuadro
    const back = clipsFromFile(JSON.parse(JSON.stringify(f)));
    expect(back.map((c) => [c.name, c.loop, c.frames.length])).toEqual([['quieto', true, 1], ['morir', false, 2]]);
    expect([...back[1]!.frames[1]!.model.entries()]).toEqual([...pose(2).entries()]);
    expect(() => clipsToFile([{ name: 'a', loop: true, frames: one }, { name: 'a', loop: true, frames: one }])).toThrow(/dos clips/);
  });

  it('las versiones 1 y 2 se leen como un clip "anim" que se repite', () => {
    const v2 = animationToFile([{ model: pose(0), ms: 100 }, { model: pose(1), ms: 100 }]);
    const cs = clipsFromFile(JSON.parse(JSON.stringify(v2)));
    expect(cs.map((c) => [c.name, c.loop, c.frames.length])).toEqual([[DEFAULT_CLIP, true, 2]]);
    expect(clipsFromFile(pose(0).toJSON())[0]!.frames).toHaveLength(1);
  });

  it('el cuadro en el tiempo: repetir da la vuelta; sin repetir se queda en el último y acaba', () => {
    const fr = [{ ms: 100 }, { ms: 50 }, { ms: 100 }] as Array<{ ms: number; model: Model }>;
    expect([0, 99, 100, 149, 150, 249, 250, 260].map((t) => clipFrameAt({ frames: fr, loop: true }, t))).toEqual([0, 0, 1, 1, 2, 2, 0, 0]);
    expect(clipFrameAt({ frames: fr, loop: false }, 1000)).toBe(2);
    expect(clipDone({ frames: fr, loop: false }, 249)).toBe(false);
    expect(clipDone({ frames: fr, loop: false }, 250)).toBe(true);
    expect(clipDone({ frames: fr, loop: true }, 9999)).toBe(false);
  });
});

describe('clips en el editor', () => {
  it('crear, cambiar, renombrar, quitar y guardar: cada clip conserva sus cuadros', () => {
    replaceModel(pose(0));
    expect(clipInfo()).toEqual([{ name: DEFAULT_CLIP, frames: 1, loop: true, current: true }]);
    renameClip(DEFAULT_CLIP, 'quieto');
    addFrame();                                                   // quieto: 2 cuadros
    newClip('andar');                                             // desde la pose del cuadro 0 de quieto
    expect(anim.clip).toBe('andar');
    expect([...model.value.entries()]).toEqual([...pose(0).entries()]);
    history.value.begin(); history.value.set(5, 5, 5, material(0, 2)); history.value.commit();
    addFrame(); addFrame();                                       // andar: 3 cuadros
    newClip('morir', { loop: false });
    setLoop(false);
    expect(clipInfo().map((c) => [c.name, c.frames, c.loop])).toEqual([['quieto', 2, true], ['andar', 3, true], ['morir', 1, false]]);
    selectClip('andar');
    expect(frameModels()).toHaveLength(3);
    expect(model.value.get(5, 5, 5)).not.toBe(0);
    selectClip('quieto');
    expect(frameModels()).toHaveLength(2);
    const f = toFile([]) as ModelFileV3 & { lights: [] };
    expect(f.version).toBe(3);
    expect(f.clips.map((c) => [c.name, c.frames.length, c.loop])).toEqual([['quieto', 2, true], ['andar', 3, true], ['morir', 1, false]]);
    // De vuelta
    loadAnimated(JSON.parse(JSON.stringify(f)));
    expect(clipInfo().map((c) => c.name)).toEqual(['quieto', 'andar', 'morir']);
    selectClip('andar');
    expect(model.value.get(5, 5, 5)).not.toBe(0);
    deleteClip('andar');
    expect(clipInfo().map((c) => [c.name, c.current])).toEqual([['quieto', false], ['morir', true]]);
    deleteClip('quieto');
    expect(() => deleteClip('morir')).toThrow(/al menos un clip/);
  });
});
