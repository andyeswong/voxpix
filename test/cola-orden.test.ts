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
});
