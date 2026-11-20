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

  it('lo corto que cabe no pasa de la mitad de la fase antes de lo demás, y lo que pide no se sale de la fase', () => {
    const { budget, asked, now } = setup();
    for (let f = 0; f < 3; f++) {
      const n0 = asked.size, t1 = now();
      budget.run();
      const spent = now() - t1, asks = asked.size - n0;
      if (!asks) continue;
      // (lo pedido no se sale de los 3 ms de la fase más la llamada que la cruza; lo de aquí, que no cabe, espera)
      expect(asks * 0.1).toBeLessThanOrEqual(3 + 0.1 + 1e-9);
      expect(Math.abs(spent - asks * 0.1) < 1e-6 || Math.abs(spent - asks * 0.1 - 8) < 1e-6).toBe(true);
    }
    expect(asked.size).toBe(30);
  });

  it('a 6x: un pedido caro (4 ms, no cabe en la mitad) y un trozo de 8 ms nunca van en el mismo cuadro; el pedido se adelanta por hambre y avanza', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t);
    let frame = 0;
    const log: Array<{ f: number; what: string }> = [];
    const trozo: ViewJob = { key: 'trozo:1', run: () => { t += 8; log.push({ f: frame, what: 'trozo' }); return false; } };
    const asked = new Set<number>();
    const remote = Array.from({ length: 6 }, (_, i): ViewJob => ({
      key: `rect:R${i}`, costClass: () => (asked.has(i) ? undefined : 'pedir'), waiting: () => asked.has(i),
      run: () => { t += 4; asked.add(i); log.push({ f: frame, what: 'pedir' }); return false; },
    }));
    // (y un cielo que también solo pide, de otra clase sin medir: en el primer cuadro solo va uno de los dos)
    let skyAsked = false;
    const sky: ViewJob = { key: 'sky:S', costClass: () => (skyAsked ? undefined : 'pedir'), waiting: () => skyAsked, run: () => { t += 4; skyAsked = true; log.push({ f: frame, what: 'pedir' }); return false; } };
    for (const j of [trozo, ...remote, sky]) budget.push(j);
    for (frame = 0; frame < 40; frame++) { budget.run(); t += 16; }
    expect(skyAsked).toBe(true);
    const byFrame = new Map<number, Set<string>>();
    for (const e of log) (byFrame.get(e.f) ?? byFrame.set(e.f, new Set()).get(e.f)!).add(e.what);
    // (desde que las clases de pedir se conocen: el primer pedido de cada una, sin medir, va sin contar, uno por fase: el del
    // recuadro en el cuadro 0, el del cielo en el 1)
    for (const [f, w] of byFrame) if (f > 1) expect(w.size).toBe(1);
    expect(log.filter((e) => e.f === 0 && e.what === 'pedir').length).toBe(1);
    expect(log.filter((e) => e.f === 1 && e.what === 'pedir').length).toBe(1);
    expect(asked.size).toBe(6);
    // (el ritmo de pedidos nunca es cero: mientras queda algo sin pedir, uno cada STARVE_FRAMES + 1 cuadros como mucho)
    const askFrames = log.filter((e) => e.what === 'pedir').map((e) => e.f);
    const lastAsk = askFrames[askFrames.length - 1]!;
    for (let f = 0; f + 5 <= lastAsk; f++) expect(askFrames.some((a) => a >= f && a < f + 5)).toBe(true);
    // (y el trozo sigue avanzando: la mayoría de los cuadros)
    expect(log.filter((e) => e.what === 'trozo').length).toBeGreaterThan(25);
  });

  it('clases sin medir: a ciegas, una en la pasada corta y otra como la llamada de la fase; las demás, al cuadro siguiente', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t);
    const ran: string[] = [];
    for (const k of ['a', 'b', 'c']) budget.push({ key: `${k}:1`, costClass: () => (ran.includes(k) ? undefined : 'pedir'), waiting: () => ran.includes(k), run: () => { t += 0.1; ran.push(k); return false; } });
    budget.run();
    expect(ran).toEqual(['a', 'b']);
    t += 16; budget.run();
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  it('pedir en dos escalones (casi siempre 0,2 ms, uno de cada diez 6 ms): se juzga por la mediana, y lo barato va varios por cuadro delante de un trozo de 8 ms', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t);
    let frame = 0;
    const perFrame = new Map<number, number>();
    const trozo: ViewJob = { key: 'trozo:1', run: () => { t += 8; return false; } };
    const asked = new Set<number>();
    const remote = Array.from({ length: 200 }, (_, i): ViewJob => ({
      key: `rect:R${i}`, costClass: () => (asked.has(i) ? undefined : 'pedir'), waiting: () => asked.has(i),
      run: () => { t += i % 10 === 9 ? 6 : 0.2; asked.add(i); perFrame.set(frame, (perFrame.get(frame) ?? 0) + 1); return false; },
    }));
    for (const j of [trozo, ...remote]) budget.push(j);
    for (frame = 0; frame < 30; frame++) { budget.run(); t += 16; }
    // (con el p95, 6 ms, no cabría ninguno en la mitad de la fase, 1,5 ms: uno por cuadro, por hambre)
    const late = [...perFrame].filter(([f]) => f >= 10).map(([, n]) => n);
    expect(late.length).toBeGreaterThan(0);
    expect(Math.max(...late)).toBeGreaterThan(3);
    // (y no más de lo que cabe en la mitad de la fase, 1,5 ms: lo de 0,2 ms empieza antes de la mitad, 8 como mucho)
    expect(Math.max(...late)).toBeLessThanOrEqual(8);
    expect(asked.size).toBeGreaterThan(60);
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
