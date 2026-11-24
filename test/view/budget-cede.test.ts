// La cola cede lo que cuesta componer (FrameBudget.cede): apagado, es la de siempre llamada a llamada; encendido, cede con tope y
// suelo, y nunca deja de avanzar
import { describe, expect, it } from 'vitest';
import { FrameBudget, type ViewJob } from '../../src/view/budget';

// Una cola con reloj de mentira y trabajos al azar: la huella de todas las llamadas (cuál, cuándo y con qué plazo)
function run(setup: (b: FrameBudget) => void, frame: (b: FrameBudget, f: number) => void = () => {}): { hash: string; calls: number; spent: number; done: number } {
  let t = 0, seed = 11, h = 0x811c9dc5, calls = 0, spent = 0, done = 0, id = 0;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const add = (v: string) => { for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
  const b = new FrameBudget(3, () => t, { ms: 8, below: 64 });
  setup(b);
  for (let f = 0; f < 1500; f++) {
    for (let n = Math.floor(rnd() * 3); n > 0; n--) {
      const key = `${['rect', 'light', 'sky', 'trozo'][Math.floor(rnd() * 4)]}:${id++ % 97}`, units = 1 + Math.floor(rnd() * 5), cost = 0.2 + rnd() * 4, pr = rnd();
      let left = units;
      const job: ViewJob = { key, ...(pr < 0.6 ? { priority: Math.floor(pr * 200) } : {}), run: (deadline) => {
        calls++;
        do { t += cost; left--; } while (left > 0 && t < deadline);
        add(`${key}|${t.toFixed(3)}|${deadline.toFixed(3)};`);
        if (left <= 0) done++;
        return left <= 0;
      } };
      b.push(job);
    }
    frame(b, f);
    spent += b.run(rnd() < 0.2 ? 2 : 0);
    t += 10;
  }
  return { hash: (h >>> 0).toString(16), calls, spent, done };
}
const off = run(() => {});

describe('ceder lo que cuesta componer', () => {
  it('apagado es la cola de siempre, llamada a llamada (la huella de antes de que existiera)', () => {
    expect([off.hash, off.calls, off.done]).toEqual(['66cdfa0f', 1980, 1421]);
    // apuntar lo que cuesta componer sin cede no cambia nada
    expect(run(() => {}, (b) => b.composed?.(9))).toEqual(off);
  });
  it('encendido y por debajo de la base, o sin datos, lo mismo', () => {
    expect(run((b) => { b.cede = { base: 2, max: 3 }; })).toEqual(off);
    expect(run((b) => { b.cede = { base: 2, max: 3 }; }, (b) => b.composed(1.9))).toEqual(off);
  });
  it('por encima cede: gasta menos por cuadro; más con más tope; y acaba todo lo mismo si la cola tiene sitio', () => {
    const at = (max: number, floor = 1) => run((b) => { b.cede = { base: 2, max, floor }; }, (b) => b.composed(9));
    const one = at(1), three = at(3);
    expect(one.hash).not.toBe(off.hash);
    expect(three.calls).toBeGreaterThan(0);
    expect(three.spent / three.done).toBeLessThanOrEqual(off.spent / off.done + 1);
  });
  it('la media móvil, la base, el tope y el suelo', () => {
    const b = new FrameBudget(3, () => 0);
    b.cede = { base: 2, max: 3, frames: 4 };
    expect(b.ceded).toBe(0);
    for (const v of [2, 4, 4, 2]) b.composed(v);
    expect(b.ceded).toBe(1);
    for (let k = 0; k < 4; k++) b.composed(20);
    expect(b.ceded).toBe(3);
    b.composed(2); b.composed(2);
    expect(b.ceded).toBe(3);
    for (let k = 0; k < 4; k++) b.composed(0);
    expect(b.ceded).toBe(0);
    b.cede = null;
    expect(b.ceded).toBe(0);
    // Los plazos que reciben los trabajos: 8 y 3 con 3 cedidos son 5 y 1 (el suelo); un plazo menor que el suelo no sube
    const deadlines = (ms: number, near: number, cede: FrameBudget['cede']) => { const q = new FrameBudget(ms, () => 0, { ms: near, below: 10 }), out: number[] = []; q.cede = cede; q.composed(50); q.push({ key: 'a:1', priority: 1, run: (d) => { out.push(d); return true; } }); q.push({ key: 'b:1', run: (d) => { out.push(d); return true; } }); q.spare = 0; q.run(); return out; };
    expect(deadlines(3, 8, { base: 2, max: 3, floor: 1 })).toEqual([5, 1]);
    expect(deadlines(3, 8, null)).toEqual([8, 3]);
    expect(deadlines(0.5, 8, { base: 2, max: 30, floor: 1 })).toEqual([1, 0.5]);
  });
  it('por mucho que ceda, en cada cuadro corre al menos un trabajo de cada fase', () => {
    let t = 0, near = 0, far = 0;
    const b = new FrameBudget(3, () => t, { ms: 8, below: 10 });
    b.cede = { base: 0, max: 1000, floor: 0 };
    b.push({ key: 'a:1', priority: 1, run: () => { near++; t += 5; return false; } });
    b.push({ key: 'b:1', run: () => { far++; t += 5; return false; } });
    for (let f = 0; f < 40; f++) { b.composed(500); b.run(); t += 10; }
    expect(near).toBe(40);
    expect(far).toBeGreaterThanOrEqual(10);        // (lo de detrás, al menos cada STARVE_FRAMES cuadros)
  });
});
