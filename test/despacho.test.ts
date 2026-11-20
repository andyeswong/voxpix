// La cola (FrameBudget) y lo que solo pide a un worker: lo que declara su clase de coste (costClass) se mide aparte y va
// antes en su fase, hasta la mitad de su tiempo. Detrás de recuadros que se pintan aquí y se comen la fase entera, lo que
// solo pide se pide igual (antes no llegaba nunca: el worker ocioso con la cola llena), y lo de aquí sigue avanzando
import { describe, it, expect } from 'vitest';
import { FrameBudget, type ViewJob } from '../src/view/budget';

describe('cola: lo que solo pide a un worker', () => {
  // Un reloj a mano: cada llamada lo adelanta lo que cuesta
  const setup = () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t);
    // Delante, 3 recuadros que se pintan aquí: 8 ms cada llamada (se comen la fase), 6 llamadas cada uno
    const local = [0, 1, 2].map((i) => { let calls = 0; const job: ViewJob & { calls: () => number } = { key: `rect:L${i}`, calls: () => calls, run: () => { t += 8; return ++calls >= 6; } }; return job; });
    // Detrás, 30 que solo piden (0,1 ms) y luego esperan al worker, que no contesta en la prueba
    const asked = new Set<number>();
    const remote = Array.from({ length: 30 }, (_, i): ViewJob => ({
      key: `rect:R${i}`,
      costClass: () => (asked.has(i) ? undefined : 'pedir'),
      waiting: () => asked.has(i),
      run: () => { t += 0.1; asked.add(i); return false; },
    }));
    for (const j of [...local, ...remote]) budget.push(j);
    return { budget, local, asked, now: () => t, tick: () => { t += 16; } };
  };

  it('detrás de recuadros que se comen la fase, los que solo piden se piden igual, en pocos cuadros; y lo de aquí sigue avanzando', () => {
    const { budget, local, asked, tick } = setup();
    for (let f = 0; f < 4; f++) { budget.run(); tick(); }
    expect(asked.size).toBe(30);
    // (lo de aquí: una llamada por cuadro, como sin nada que pedir; no ha acabado)
    expect(local[0]!.calls()).toBe(4);
    expect(budget.pending).toBeGreaterThanOrEqual(30);
  });

  it('pedir no se lleva más de la mitad de la fase (más la llamada que la cruza)', () => {
    const { budget, asked, now } = setup();
    for (let f = 0; f < 2; f++) {
      const n0 = asked.size, t1 = now();
      budget.run();
      const asks = asked.size - n0;
      // (la primera vez la clase aún no se conoce: la primera se pide igual y desde ahí se sabe que cuesta 0,1)
      expect(asks).toBeGreaterThan(5);
      expect(asks * 0.1).toBeLessThanOrEqual(1.5 + 0.1 + 1e-9);
      // (y lo de aquí tuvo su llamada: 8 ms)
      expect(now() - t1).toBeCloseTo(asks * 0.1 + 8, 6);
    }
  });

  it('un pedido que no sale y se pinta aquí en la misma llamada se apunta como pintar (lastCostClass), no como pedir: lo que sí pide sigue cabiendo', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t);
    // (delante, cinco que anuncian pedir, pero no sale: pintan aquí 8 ms en esa llamada y acaban)
    const refused = [0, 1, 2, 3, 4].map((i): ViewJob => ({ key: `rect:N${i}`, costClass: () => 'pedir', lastCostClass: () => undefined, run: () => { t += 8; return true; } }));
    const asked = new Set<number>();
    const remote = Array.from({ length: 30 }, (_, i): ViewJob => {
      let last: string | undefined;
      return { key: `rect:R${i}`, costClass: () => (asked.has(i) ? undefined : 'pedir'), lastCostClass: () => last, waiting: () => asked.has(i), run: () => { t += 0.1; asked.add(i); last = 'pedir'; return false; } };
    });
    for (const j of [...refused, ...remote]) budget.push(j);
    for (let f = 0; f < 9; f++) { budget.run(); t += 16; }
    expect(asked.size).toBe(30);
  });
});
