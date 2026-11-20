// wrapJob: un envoltorio de un trabajo de la cola (para medirlo, cambiar su clave, su prioridad o su run) pasa TODOS los
// opcionales de ViewJob. Los envoltorios hechos a mano perdían alguno (dead, unit, costClass...) y la cola no se enteraba
import { it, expect } from 'vitest';
import { wrapJob, type ViewJob } from '../src/world/bake';
import type { ViewJob as QueueJob } from '../src/view/budget';

// (las dos definiciones de ViewJob, la de la cola y la del horneado, con los mismos campos)
type Same<A, B> = [keyof A] extends [keyof B] ? ([keyof B] extends [keyof A] ? true : false) : false;
const same: Same<ViewJob, QueueJob> = true;

it('pasa cada opcional (llamando al de dentro) y cambia solo lo que se le pide', () => {
  expect(same).toBe(true);
  const calls: string[] = [];
  // (Required: si ViewJob gana un opcional, esta prueba no compila hasta añadirlo aquí)
  const full: Required<ViewJob> = {
    key: 'rect:1', priority: 5,
    run: () => { calls.push('run'); return true; },
    waiting: () => { calls.push('waiting'); return true; },
    unit: () => { calls.push('unit'); return 2; },
    dead: () => { calls.push('dead'); return false; },
    costClass: () => { calls.push('costClass'); return 'pedir'; },
    lastCostClass: () => { calls.push('lastCostClass'); return 'llegada'; },
  };
  const w = wrapJob(full);
  const opt = Object.keys(full).filter((k) => k !== 'key' && k !== 'run' && k !== 'priority') as Array<Exclude<keyof ViewJob, 'key' | 'run' | 'priority'>>;
  expect(opt.length).toBe(5);
  for (const k of opt) {
    expect(typeof w[k]).toBe('function');
    calls.length = 0;
    expect((w[k] as () => unknown)()).toEqual((full[k] as () => unknown)());
    expect(calls).toEqual([k, k]);
  }
  expect([w.key, w.priority, w.run(0)]).toEqual(['rect:1', 5, true]);
  // Lo que se cambia
  let mine = 0;
  const v = wrapJob(full, { key: 'g1/rect:1', priority: undefined, run: () => { mine++; return false; } });
  expect(v.key).toBe('g1/rect:1');
  expect('priority' in v).toBe(false);
  expect(v.run(0)).toBe(false);
  expect(mine).toBe(1);
  expect(v.costClass!()).toBe('pedir');
  // Y lo que no tiene, no lo inventa
  const bare = wrapJob({ key: 'k', run: () => true });
  expect(Object.keys(bare).sort()).toEqual(['key', 'run']);
});
