import { describe, it, expect } from 'vitest';
import { FrameBudget, type ViewJob } from '../../src/view/budget';

// Un reloj falso y trabajos de N unidades de `cost` ms cada una, que respetan el contrato de ViewJob
function harness() {
  let t = 0;
  const log: string[] = [];
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const job = (key: string, units: number, cost = 1): ViewJob & { left: number } => {
    const j = {
      key, left: units,
      run(deadline: number) {
        do { clock.advance(cost); j.left--; log.push(key); } while (j.left > 0 && clock.now() < deadline);
        return j.left === 0;
      },
    };
    return j;
  };
  return { clock, log, job };
}

describe('presupuesto de la vista por cuadro', () => {
  it('no pasa del presupuesto: un trabajo de 10 ms se reparte en cuadros de 3', () => {
    const { clock, job } = harness();
    const b = new FrameBudget(3, clock.now);
    const j = job('rect:0,0', 10);
    b.push(j);
    const spent: number[] = [];
    while (b.pending) spent.push(b.run());
    expect(spent).toEqual([3, 3, 3, 1]);
    expect(j.left).toBe(0);
  });

  it('en orden de llegada, y si uno acaba a medio cuadro, sigue el siguiente', () => {
    const { clock, log, job } = harness();
    const b = new FrameBudget(3, clock.now);
    b.push(job('a', 2)); b.push(job('b', 2)); b.push(job('c', 2));
    b.run(); b.run();
    expect(log).toEqual(['a', 'a', 'b', 'b', 'c', 'c']);
    expect(b.pending).toBe(0);
  });

  it('la misma key sustituye al trabajo viejo en su sitio: el viejo no sigue', () => {
    const { clock, log, job } = harness();
    const b = new FrameBudget(3, clock.now);
    const old = job('light:7', 10);
    b.push(old); b.push(job('rect:1,1', 1));
    b.run();                                   // el viejo avanza 3
    b.push(job('light:7', 2));                 // la luz cambia otra vez: trabajo nuevo, mismo sitio
    while (b.pending) b.run();
    expect(old.left).toBe(7);                  // el viejo no volvió a correr
    expect(log.slice(3)).toEqual(['light:7', 'light:7', 'rect:1,1']);
  });

  it('lo que ya gastó otra cosa en el cuadro se descuenta', () => {
    const { clock, job } = harness();
    const b = new FrameBudget(3, clock.now);
    b.push(job('a', 10));
    expect(b.run(2)).toBe(1);
  });

  it('sin presupuesto no corre, pero tras 4 cuadros sin nada da una unidad: nunca se queda parado del todo', () => {
    const { clock, job } = harness();
    const b = new FrameBudget(3, clock.now);
    const j = job('a', 10);
    b.push(j);
    expect([b.run(5), b.run(5), b.run(5)]).toEqual([0, 0, 0]);
    expect(j.left).toBe(10);
    expect(b.run(5)).toBe(1);
    expect(j.left).toBe(9);
  });

  it('un trabajo que no acaba ni gasta tiempo no cuelga el cuadro', () => {
    const { clock } = harness();
    const b = new FrameBudget(3, clock.now);
    b.push({ key: 'roto', run: () => false });
    expect(b.run()).toBe(0);
    expect(b.pending).toBe(1);
  });

  it('un trabajo que espera a otro que va detrás no bloquea la cola (la luz que espera a su recuadro)', () => {
    const { clock, log, job } = harness();
    const b = new FrameBudget(3, clock.now);
    const rect = job('rect:0,0,32,32', 4);
    const light = job('light:3', 2);
    // La luz solo puede correr cuando el recuadro ha acabado
    const waiting: ViewJob = { key: 'light:3', run: (d) => (rect.left > 0 ? false : light.run(d)) };
    b.push(job('light:3', 5));          // trabajo viejo de la luz...
    b.push(rect);
    b.push(waiting);                    // ...sustituido en su sitio, delante de su recuadro
    let frames = 0;
    while (b.pending && frames < 20) { b.run(); frames++; }
    expect(b.pending).toBe(0);
    expect(log).toEqual(['rect:0,0,32,32', 'rect:0,0,32,32', 'rect:0,0,32,32', 'rect:0,0,32,32', 'light:3', 'light:3']);
  });

  it('sin trabajos no mira el reloj ni gasta nada', () => {
    let calls = 0;
    const b = new FrameBudget(3, () => { calls++; return 0; });
    expect(b.run()).toBe(0);
    expect(calls).toBe(0);
  });
  it('lo cercano no empieza una llamada que no cabe: lo que cuesta cada clase sale de sus últimas llamadas', () => {
    const { clock, log, job } = harness();
    const b = new FrameBudget(3, clock.now, { ms: 8, below: 64 });
    // Recuadros cercanos de franjas de 4 ms: en un cuadro de 8 caben dos franjas, no tres
    const r1 = job('rect:0,0,8,8', 3, 4), r2 = job('rect:9,0,16,8', 3, 4);
    b.push({ ...r1, key: r1.key, priority: 0, run: (d) => r1.run(d) });
    b.push({ ...r2, key: r2.key, priority: 1, run: (d) => r2.run(d) });
    const spent: number[] = [];
    while (b.pending) spent.push(b.run());
    // El primer cuadro todavía no sabe lo que cuesta un recuadro: hace r1 hasta el plazo (8) y no empieza r2
    // (empezaría con 0 ms libres). Después, con 3 franjas que quedan de 4 ms y 8 por cuadro: nunca más de 8
    expect(spent.every((ms) => ms <= 8)).toBe(true);
    expect(log.filter((k) => k.startsWith('rect')).length).toBe(6);
  });

  it('con lo que cuesta conocido, la cola salta lo que no cabe y prueba con otra clase más barata', () => {
    const { clock, log, job } = harness();
    const b = new FrameBudget(3, clock.now, { ms: 8, below: 64 });
    const near = (j: ViewJob, p: number): ViewJob => ({ key: j.key, priority: p, run: (d) => j.run(d) });
    // Una llamada de recuadro de 5 ms y otra de cielo de 1 ms, para que la cola las conozca
    b.push(near(job('rect:a', 1, 5), 0)); b.push(near(job('sky:a', 1, 1), 1));
    b.run();
    log.length = 0;
    // Ahora: un recuadro de 5 (va el primero: siempre hace una llamada), otro de 5 (no cabe en los 3 que quedan) y un
    // cielo de 1 (cabe)
    b.push(near(job('rect:b', 1, 5), 0)); b.push(near(job('rect:c', 1, 5), 1)); b.push(near(job('sky:b', 1, 1), 2));
    expect(b.run()).toBe(6);
    expect(log).toEqual(['rect:b', 'sky:b']);
    b.run();
    expect(log).toEqual(['rect:b', 'sky:b', 'rect:c']);
  });

  it('lo cercano que no acabó no vuelve a correr con el presupuesto de lo demás en el mismo cuadro', () => {
    const { clock, log, job } = harness();
    const b = new FrameBudget(3, clock.now, { ms: 8, below: 64 });
    const r = job('rect:0,0', 20, 4), l = job('light:1', 2, 1);
    b.push({ key: r.key, priority: 0, run: (d) => r.run(d) });
    b.push({ key: l.key, priority: 10000, run: (d) => l.run(d) });
    expect(b.run()).toBe(8 + 2);                       // 8 del recuadro (2 franjas) y la luz, que es de lo demás
    expect(log).toEqual(['rect:0,0', 'rect:0,0', 'light:1', 'light:1']);
  });

  it('las llamadas que esperan (no gastan nada) no cuentan para lo que cuesta su clase', () => {
    const { clock } = harness();
    const b = new FrameBudget(3, clock.now, { ms: 8, below: 64 });
    let ready = false;
    b.push({ key: 'light:1#1', priority: 0, run: () => ready });
    for (let k = 0; k < 40; k++) b.run();
    expect(b.expected('light:1#2')).toBe(0);
    ready = true;
    b.push({ key: 'light:2#3', priority: 0, run: () => { clock.advance(2); return true; } });
    b.run();
    expect(b.expected('light:9#9')).toBe(2);
  });
  it('contrato: con franjas de 4 ms y plazo cercano de 8, ningún run() pasa de near.ms + ms, y acaba igual que sin plazo', () => {
    // Trabajos como los de verdad: hacen unidades mientras quepa la siguiente según lo que tardó la anterior (la primera
    // siempre), y cada unidad escribe su parte del resultado. Recuadros cercanos de franjas de 4 ms, luces y cielo de
    // lo demás de 1 y 2 ms, que llegan a tandas mientras la cola trabaja
    let t = 0;
    const out = new Map<string, number[]>();
    const make = (key: string, units: number, cost: number, priority: number): ViewJob => {
      let done = 0;
      return {
        key, priority,
        run(deadline) {
          let est = 0;
          do { t += cost; est = cost; (out.get(key) ?? out.set(key, []).get(key)!).push(done++); } while (done < units && t + est < deadline);
          return done >= units;
        },
      };
    };
    const batches = (n: number) => Array.from({ length: n }, (_, k) => [
      make(`rect:${k},0`, 5, 4, k), make(`rect:${k},1`, 3, 4, 20 + k),
      make(`light:${k}#${k}`, 6, 1, 10000 + k), make(`sky:${k},0`, 3, 2, 10100 + k),
    ]);
    // La cola tiene que conocer ya cada clase: la primera llamada de una clase que nunca ha corrido no tiene estimación
    // (cuenta 0) y puede pasarse de su fase una unidad. Una tanda de calentamiento, aparte
    const q = new FrameBudget(3, () => t, { ms: 8, below: 64 });
    for (const j of batches(1)[0]!) q.push({ ...j, key: j.key.replace(/^(\w+)[:#]/, '$1:calentar,'), run: (d) => j.run(d) });
    while (q.pending) q.run();
    out.clear();
    // Con plazo: una tanda cada 3 cuadros
    const plan = batches(8), runs: number[] = [];
    for (let f = 0; f < 400 && (q.pending || plan.length); f++) {
      if (f % 3 === 0 && plan.length) for (const j of plan.shift()!) q.push(j);
      runs.push(q.run());
    }
    expect(q.pending).toBe(0);
    expect(Math.max(...runs)).toBeLessThanOrEqual(8 + 3);
    const withBudget = new Map(out);
    // Sin plazo: los mismos trabajos de una vez
    out.clear();
    for (const j of batches(8).flat()) while (!j.run(Infinity));
    expect(withBudget).toEqual(out);
  });
});
