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
});
