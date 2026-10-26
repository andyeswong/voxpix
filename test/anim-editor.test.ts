// La animación del editor (app/src/anim.ts): las operaciones sobre la lista de cuadros no reinician la animación
// (fallo de la primera entrega: generar, borrar o mover dejaban un solo cuadro) y generateFromRig sustituye los
// cuadros 1..n, dejando el 0 como pose de reposo
import { describe, it, expect } from 'vitest';
import { Model, box, material } from '../src/core';
import { model, replaceModel, history } from '../app/src/store';
import { anim, addFrame, deleteFrame, moveFrame, generateFromRig, frameModels, selectFrame, toFile, loadAnimated } from '../app/src/anim';
import type { RigSpec } from '../src/anim/rig';

function bug(): Model {
  const m = new Model({ ramps: [{ name: 'c', colors: ['#202020', '#606060', '#a0a0a0'] }, { name: 'p', colors: ['#400000', '#800000'] }] }, 'bicho');
  box(m, -4, -2, 4, 4, 2, 7, material(0, 1));
  box(m, -3, 0, 0, -3, 0, 3, material(1, 1));
  return m;
}
const SPEC: RigSpec = { frameMs: 90, parts: [{ name: 'L', boxes: [[-9, -9, 0, -1, 9, 3]] }], frames: [{ moves: { L: { dz: 1 } } }, { moves: {} }, { moves: { L: { dy: 1 } } }, { moves: {} }] };

describe('la animación del editor', () => {
  it('añadir, borrar y mover cuadros no reinicia la animación', () => {
    replaceModel(bug());
    addFrame(); addFrame(); addFrame();
    expect(anim.count).toBe(4);
    history.value.begin(); history.value.set(0, 0, 10, material(0, 2)); history.value.commit();   // pinta el cuadro 3
    deleteFrame(1);
    expect(anim.count).toBe(3);
    moveFrame(0, 2);
    expect(anim.count).toBe(3);
    expect(frameModels().filter((m) => m.get(0, 0, 10)).length).toBe(1);   // lo pintado sigue en un solo cuadro
    expect(frameModels()).toContain(model.value);
  });

  it('generateFromRig sustituye los cuadros 1..n y deja el 0: un rig de 4 deja 5, y otra vez, 5', () => {
    replaceModel(bug());
    addFrame(); addFrame(); addFrame();
    const base = frameModels()[0];
    expect(generateFromRig(SPEC)).toBe(4);
    expect(anim.count).toBe(5);
    expect(frameModels()[0]).toBe(base);
    expect(generateFromRig(SPEC)).toBe(4);
    expect(anim.count).toBe(5);
    expect(frameModels()[1]!.get(-3, 0, 4)).toBe(material(1, 1));    // el cuadro 1 lleva la pata subida (dz 1)
  });

  it('guardar y abrir conserva los cuadros, sus duraciones y el rig', () => {
    replaceModel(bug());
    generateFromRig(SPEC);
    const f = JSON.parse(JSON.stringify(toFile([])));
    expect(f.version).toBe(2);
    replaceModel(bug());
    expect(anim.count === 1 || frameModels().length === 1).toBe(true);
    loadAnimated(f);
    expect(anim.count).toBe(5);
    expect(anim.rig?.frameMs).toBe(90);
    selectFrame(1);
    expect(model.value.get(-3, 0, 4)).toBe(material(1, 1));
  });
});
