import { describe, it, expect } from 'vitest';
import { Model, material } from '../src/core';
import { History } from '../src/core/history';
import { TEST_PALETTE } from '../src/samples/basic';

describe('history', () => {
  it('deshace y rehace un trazo entero', () => {
    const m = new Model(TEST_PALETTE);
    const h = new History(m);
    m.set(0, 0, 0, material(0, 1));
    h.begin();
    h.set(0, 0, 0, material(0, 3));
    h.set(1, 0, 0, material(0, 3));
    h.set(1, 0, 0, material(0, 4));      // el mismo vóxel dos veces en el trazo: el "antes" es el original
    expect(h.commit()).toBe(true);
    h.undo();
    expect([m.get(0, 0, 0), m.get(1, 0, 0)]).toEqual([material(0, 1), 0]);
    h.redo();
    expect([m.get(0, 0, 0), m.get(1, 0, 0)]).toEqual([material(0, 3), material(0, 4)]);
  });

  it('un trazo que no cambia nada no ocupa un paso, y uno nuevo borra el rehacer', () => {
    const m = new Model(TEST_PALETTE);
    const h = new History(m);
    h.begin(); h.set(0, 0, 0, 0); expect(h.commit()).toBe(false);
    h.begin(); h.set(0, 0, 0, material(1, 1)); h.commit();
    h.undo(); expect(h.canRedo).toBe(true);
    h.begin(); h.set(2, 0, 0, material(1, 1)); h.commit();
    expect(h.canRedo).toBe(false);
  });
});
