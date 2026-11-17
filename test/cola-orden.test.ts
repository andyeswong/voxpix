// La cola (FrameBudget.push): con el índice por key y la búsqueda partiendo en dos, el orden es el mismo que el de
// recorrerla entera (la versión de antes, aquí como referencia), también sustituyendo, con y sin prioridad, y quitando
// los que acaban
import { describe, it, expect } from 'vitest';
import { FrameBudget, type ViewJob } from '../src/view/budget';

// La de antes
function refPush(q: ViewJob[], job: ViewJob): void {
  const i = q.findIndex((j) => j.key === job.key);
  if (i >= 0) q[i] = job; else q.push(job);
  if (job.priority === undefined) return;
  const at = i >= 0 ? i : q.length - 1;
  q.splice(at, 1);
  const p = job.priority;
  let k = q.findIndex((j) => j.priority === undefined || j.priority > p);
  if (k < 0) k = q.length;
  q.splice(k, 0, job);
}

describe('cola: el orden de push', () => {
  it('igual que recorrerla entera, con 20 000 pushes al azar (keys repetidas, prioridades, sin prioridad, y los que acaban)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let round = 0; round < 20; round++) {
      // Un reloj parado: cada run hace una llamada; los trabajos acaban al azar
      const budget = new FrameBudget(1, () => 0);
      const ref: ViewJob[] = [];
      const done = new Set<ViewJob>();
      for (let n = 0; n < 1000; n++) {
        const key = `k${Math.floor(rnd() * 60)}`, r = rnd();
        const job: ViewJob = { key, ...(r < 0.3 ? {} : { priority: Math.floor(rnd() * 8) }), run: () => { done.add(job); return true; } };
        budget.push(job); refPush(ref, job);
        const q = (budget as unknown as { queue: ViewJob[] }).queue;
        expect(q.map((j) => j.key)).toEqual(ref.map((j) => j.key));
        expect(q.every((j, i) => j === ref[i])).toBe(true);
        // A veces corre la cola: quita los que acabaron, en los dos
        if (rnd() < 0.05) {
          budget.run();
          for (let i = ref.length - 1; i >= 0; i--) if (done.has(ref[i]!)) ref.splice(i, 1);
          expect((budget as unknown as { queue: ViewJob[] }).queue).toEqual(ref);
        }
      }
    }
  });

  it('waiting: la cola salta sin llamarlo al que solo espera, y lo corre en cuanto deja de esperar', () => {
    const budget = new FrameBudget(5);
    let wait = true, calls = 0, other = 0;
    budget.push({ key: 'espera', priority: 0, waiting: () => wait, run: () => { calls++; return true; } });
    budget.push({ key: 'otro', priority: 1, run: () => { other++; return other >= 3; } });
    for (let f = 0; f < 5; f++) budget.run();
    expect(calls).toBe(0);
    expect(other).toBe(3);
    wait = false;
    budget.run();
    expect(calls).toBe(1);
    expect(budget.pending).toBe(0);
  });

  // Lo del juego de FERN con el worker: la fase normal tiene 3 ms; delante del recuadro cercano (sin prioridad), los recuadros
  // del worker (sin prioridad, más viejos) que cada cuadro dejan de esperar (2 por cuadro) y se publican; cada uno se come
  // el plazo
  it('salvaguarda: un recuadro cercano sin prioridad detrás de recuadros del worker sin prioridad que se publican y se comen el plazo corre en pocos cuadros', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t, { ms: 8, below: 64 });
    for (let k = 0; k < 8; k++) { budget.push({ key: `rect:a${k}`, run: () => { t += 9; return true; } }); budget.run(); t += 16; }
    budget.push({ key: 'section', priority: 0, run: () => { t += 7; return false; } });
    // 60 del worker, que van llegando de 2 en 2 por cuadro; publicar uno cuesta 4 ms
    const ready = new Set<number>();
    for (let k = 0; k < 60; k++) budget.push({ key: `rect:w${k}`, waiting: () => !ready.has(k), run: () => { t += 4; return true; } });
    let ran = -1, f = 0, next = 0;
    budget.push({ key: 'rect:cerca', run: () => { t += 9; ran = f; return true; } });
    for (; f < 200 && ran < 0; f++) { ready.add(next++); ready.add(next++); budget.run(); t += 16; }
    expect(ran).toBeGreaterThanOrEqual(0);
    expect(ran).toBeLessThanOrEqual(6);
  });

  it('salvaguarda: lo que el plazo deja sin mirar no pasa delante de uno con más prioridad (la sección, con prioridad 0, que se come el plazo de lo cercano, corre en cada cuadro)', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t, { ms: 8, below: 64 });
    for (let k = 0; k < 8; k++) { budget.push({ key: `rect:a${k}`, priority: 20, run: () => { t += 3; return true; } }); budget.run(); t += 16; }
    let sectionRuns = 0;
    // (la sección se come todo el plazo de lo cercano: el bucle para ahí sin llegar a los de detrás)
    budget.push({ key: 'section', priority: 0, run: () => { t += 8.5; sectionRuns++; return false; } });
    // Cercanos de más prioridad numérica (detrás de la sección), que nunca acaban
    for (let k = 0; k < 4; k++) budget.push({ key: `rect:n${k}`, priority: 20 + k, run: () => { t += 3; return false; } });
    for (let f = 0; f < 60; f++) { budget.run(); t += 16; }
    expect(sectionRuns).toBe(60);
  });

  // Lo que vio FERN con 204f7a6: varios recuadros sin prioridad, de varias llamadas cada uno, en la fase normal. Con la
  // salvaguarda adelantándolos por turnos, ninguno acababa de una vez: avanzaban a trozos, uno por cuadro, y cada uno que
  // acababa tarde se publicaba encima de la sección y la hacía repintar
  it('salvaguarda: recuadros sin prioridad de varias llamadas acaban en orden, sin turnarse (el que avanza no cede ante los que esperan)', () => {
    let t = 0;
    const budget = new FrameBudget(3, () => t, { ms: 8, below: 64 });
    for (let k = 0; k < 8; k++) { budget.push({ key: `rect:a${k}`, run: () => { t += 3.5; return true; } }); budget.run(); t += 16; }
    // (con la sección en la fase cercana, como en el juego: lo normal no se lleva lo que sobra de lo cercano)
    budget.push({ key: 'section', priority: 0, run: () => { t += 7; return false; } });
    const done: Array<[string, number]> = [];
    let f = 0;
    for (const name of ['r1', 'r2', 'r3', 'r4']) {
      let left = 8;
      budget.push({ key: `rect:${name}`, run: () => { t += 3.5; if (--left > 0) return false; done.push([name, f]); return true; } });
    }
    for (; f < 200 && done.length < 4; f++) { budget.run(); t += 16; }
    expect(done.map((d) => d[0])).toEqual(['r1', 'r2', 'r3', 'r4']);
    // (8 llamadas cada uno, una por cuadro: el primero en el cuadro 7, el último hacia el 31)
    expect(done[0]![1]).toBeLessThanOrEqual(8);
  });
});
