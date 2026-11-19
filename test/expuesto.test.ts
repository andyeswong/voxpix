// Lo expuesto que el horneado inicial no prepara (StaticVoxels.forEachExposed sin máscaras): la primera
// rebakeChangedJobs devuelve, una vez y sin prioridad, el trabajo que lo prepara (exposure:...). Al acabar no queda
// nada por hacer; no rehace lo que ya hizo una franja (ni él mismo); y un rehorneado con las máscaras hechas da lo
// mismo, byte a byte, que hornear de cero. Con warmExposure: false, no hay trabajo
import { describe, it, expect } from 'vitest';
import { material, frontFaces } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { WorldView } from '../src/world/view';
import { bakeWorld, bakeWorldJob, rebakeChanged, rebakeChangedJobs, type Baked , exposureFaults } from '../src/world/bake';

const PAL = { ramps: [{ name: 'piedra', colors: ['#202020', '#404040', '#606060', '#808080'] }] };
function world(): StaticVoxels {
  const s = new StaticVoxels(PAL, 64, 56, 0, 47);
  for (let y = 0; y < 56; y++) for (let x = 0; x < 64; x++) {
    const top = 30 + ((x >> 3) + (y >> 3)) % 4;
    for (let z = 0; z < top; z++) if (!(y >= 20 && y < 28 && z >= 12 && z < 24)) s.set(x, y, z, material(0, 1 + ((x + y + z) & 1)));
  }
  return s;
}
const OPTS = { topZ: 47, incline: 0.5 };
const ALL = { x0: 0, y0: 0, x1: 63, y1: 55 };
// Con tope: si algo rehiciera siempre lo hecho, no acabaría nunca (que falle, no que se cuelgue)
const drain = (jobs: Array<{ run(d: number): boolean }>) => { for (const j of jobs) { let n = 0; while (!j.run(Infinity)) if (++n > 1000) throw new Error('no acaba'); } };

describe('preparar lo expuesto después del horneado', () => {
  it('sale una vez, sin prioridad; al acabar no queda nada; con warmExposure: false no sale', () => {
    const s = world();
    const b = bakeWorld({ model: s, lights: [], width: 64, depth: 56 }, OPTS);
    const first = rebakeChangedJobs(b, [], { near: { x: 30, y: 24 } });
    const job = first.find((j) => j.key.startsWith('exposure:'))!;
    expect(job).toBeDefined();
    expect(job.priority).toBeUndefined();
    expect(rebakeChangedJobs(b, [], { near: { x: 30, y: 24 } }).some((j) => j.key.startsWith('exposure:'))).toBe(false);
    expect(s.warmExposed(ALL, 1)).toBe(false);                    // antes, falta
    let calls = 0;
    while (!job.run(-1)) if (++calls > 5000) throw new Error('no acaba');   // con el plazo vencido: por tandas
    expect(calls).toBeGreaterThan(3);
    expect(s.warmExposed(ALL, 1)).toBe(true);                     // después, nada
    const b2 = bakeWorld({ model: world(), lights: [], width: 64, depth: 56 }, { ...OPTS, warmExposure: false });
    expect(rebakeChangedJobs(b2, []).some((j) => j.key.startsWith('exposure:'))).toBe(false);
    const { baked: b3, job: bj } = bakeWorldJob({ model: world(), lights: [], width: 64, depth: 56 }, OPTS);
    while (!bj.run(Infinity));
    expect(rebakeChangedJobs(b3, []).some((j) => j.key.startsWith('exposure:'))).toBe(true);
  });

  it('no rehace lo hecho: ni otro trabajo después, ni lo que una franja preparó antes', () => {
    const fresh = () => { const s = world(); return { s, b: bakeWorld({ model: s, lights: [], width: 64, depth: 56 }, OPTS) }; };
    const run = (b: Baked) => drain(rebakeChangedJobs(b, []).filter((j) => j.key.startsWith('exposure:')));
    // Solo el trabajo: cuántas filas hace
    const a = fresh(), a0 = a.s.exposureRows;
    run(a.b);
    const total = a.s.exposureRows - a0;
    expect(total).toBeGreaterThan(0);
    // Otro trabajo encima: ninguna
    a.b.exposurePending = true;
    run(a.b);
    expect(a.s.exposureRows - a0).toBe(total);
    // Una franja (warmExposed de una región) antes, y el trabajo después: entre los dos, las mismas filas, ninguna dos veces
    const c = fresh(), c0 = c.s.exposureRows;
    for (let g = 0; !c.s.warmExposed({ x0: 20, y0: 10, x1: 40, y1: 40 }, 64); g++) if (g > 5000) throw new Error('no acaba');
    const part = c.s.exposureRows - c0;
    expect(part).toBeGreaterThan(0);
    run(c.b);
    expect(c.s.exposureRows - c0).toBe(total);
  });

  it('con las máscaras hechas, un corte rehorneado da lo mismo, byte a byte, que hornear de cero', () => {
    const st = new WorldState(world(), [], null);
    const view = new WorldView(st, 0, { cut: true });
    const b = bakeWorld(view.bakeable(), OPTS);
    drain(rebakeChangedJobs(b, view.frame().lights));             // el trabajo de lo expuesto, acabado
    view.setCut({ x0: 16, y0: 12, x1: 47, y1: 35, zTop: 24 });
    rebakeChanged(b, view.frame().lights);
    const ref = bakeWorld(view.bakeable(), OPTS);
    expect(Buffer.from(b.rgba.buffer).equals(Buffer.from(ref.rgba.buffer))).toBe(true);
    expect(b.depth).toEqual(ref.depth);
    expect(b.face).toEqual(ref.face);
  });

  it('un fallo de cuenta no para el juego: se apunta, el trozo se rehace una vez y luego se salta; la franja sigue', () => {
    const s = world();
    const b = bakeWorld({ model: s, lights: [], width: 64, depth: 56 }, OPTS);
    // Un fallo a propósito: lo expuesto no acaba nunca
    s.warmExposed = () => false;
    const warn = console.warn; let warned = 0;
    console.warn = () => { warned++; };
    try {
      const before = exposureFaults.length;
      s.set(30, 24, 5, 0);                                          // (un vóxel lleno: un recuadro con su franja)
      const jobs = rebakeChangedJobs(b, []);
      // Todo acaba (con tope: ni se cuelga ni lanza)
      for (const j of jobs) { let n = 0; while (!j.run(Infinity)) if (++n > 1000) throw new Error('se cuelga'); }
      const faults = exposureFaults.slice(before);
      expect(faults.some((f) => f.startsWith('una franja'))).toBe(true);
      expect(faults.some((f) => f.includes('se rehace'))).toBe(true);
      expect(faults.some((f) => f.includes('se salta'))).toBe(true);
      expect(warned).toBeGreaterThan(0);
    } finally { console.warn = warn; }
  });

  it('un trozo que se reescribe mientras se prepara su máscara no es un fallo: se vuelve a empezar con él sin apuntar nada', () => {
    const before = exposureFaults.length;
    for (const ms of [0.02, 0.05, 0.1, 0.2]) {
      const s = world();
      const b = bakeWorld({ model: s, lights: [], width: 64, depth: 56 }, OPTS);
      const job = rebakeChangedJobs(b, []).find((j) => j.key.startsWith('exposure:'))!;
      // Reescribir un vóxel de cada trozo cada pocas llamadas (como escribir trozos de la ventana viva mientras tanto)
      let calls = 0, done = false;
      for (; calls < 20000 && !done; calls++) {
        if (calls < 40 && calls % 4 === 1) for (let cy = 0; cy < 56; cy += 16) for (let cx = 0; cx < 64; cx += 16) { const v = s.get(cx + 3, cy + 3, 5); s.set(cx + 3, cy + 3, 5, v ? 0 : material(0, 1)); }
        done = job.run(performance.now() + ms);
      }
      expect([ms, done]).toEqual([ms, true]);
    }
    expect(exposureFaults.slice(before)).toEqual([]);
  });
  it('al correrse, las máscaras de lo expuesto se corren con su trozo y dan lo mismo que rehacerlas (con y sin juego de caras); lo que entra y el borde nuevo se rehacen', () => {
    // Un mundo de 128 x 128 con relieve y un hueco, desde la columna ox del mundo
    const W = 128, D = 128, top = (x: number, y: number) => 20 + ((x >> 2) + 3 * (y >> 3)) % 7;
    const fill = (s: StaticVoxels, ox: number, oy: number, x0 = 0, y0 = 0, x1 = W - 1, y1 = D - 1) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const wx = x + ox, wy = y + oy, t = top(wx, wy);
        for (let z = 0; z < t; z++) if (!(wx >= 30 && wx < 50 && wy >= 20 && wy < 34 && z >= 8 && z < 16)) s.set(x, y, z, material(0, 1 + ((wx + wy + z) & 1)));
      }
    };
    const faces = frontFaces({ incline: 0.5 } as never);
    const exposed = (s: StaticVoxels, f?: typeof faces) => { const out: string[] = []; s.forEachExposed((x, y, z, v) => out.push(`${x},${y},${z},${v}`), { x0: 0, y0: 0, x1: W - 1, y1: D - 1 }, true, f); return out.sort(); };
    // (de una vez, shift, y por pasos, shiftJob: el de la ventana viva)
    for (const [dcx, dcy, byJob] of [[1, 0, false], [0, 1, false], [-1, 0, false], [1, -1, false], [1, 0, true], [-1, 1, true]] as const) {
      const s = new StaticVoxels(PAL, W, D, 0, 47);
      fill(s, 0, 0);
      // (las máscaras hechas antes de correr, con y sin caras)
      exposed(s); exposed(s, faces);
      const full = s.exposureRows;
      if (byJob) { const j = s.shiftJob(dcx, dcy); while (!j.step()); j.commit(); } else s.shift(dcx, dcy);
      // Lo que entra, escrito en su sitio nuevo
      const DX = dcx * 16, DY = dcy * 16;
      const ex0 = DX > 0 ? W - DX : 0, ex1 = DX > 0 ? W - 1 : DX < 0 ? -DX - 1 : -1;
      const ey0 = DY > 0 ? D - DY : 0, ey1 = DY > 0 ? D - 1 : DY < 0 ? -DY - 1 : -1;
      if (ex1 >= ex0) fill(s, DX, DY, ex0, 0, ex1, D - 1);
      if (ey1 >= ey0) fill(s, DX, DY, 0, ey0, W - 1, ey1);
      const ref = new StaticVoxels(PAL, W, D, 0, 47);
      fill(ref, DX, DY);
      expect({ at: [dcx, dcy, byJob], n: exposed(s).join('|') === exposed(ref).join('|') }).toEqual({ at: [dcx, dcy, byJob], n: true });
      expect({ at: [dcx, dcy, byJob], f: exposed(s, faces).join('|') === exposed(ref, faces).join('|') }).toEqual({ at: [dcx, dcy, byJob], f: true });
      // Y se rehizo solo lo que entró y el borde nuevo, con sus vecinos (no todas: antes se daban por caducadas). En 8 x 8
      // trozos: un corrimiento por un eje rehace 4 columnas de 8 (la mitad); en diagonal, el 75 %; tirándolas, el 100 %
      expect(s.exposureRows - full).toBeLessThan(0.9 * full);
    }
  });
  it('copia girada de un trozo que queda vacío (copyRotatedChunk): sus alturas y lo expuesto, como copiarlo todo de nuevo (antes se quedaban con lo de antes)', () => {
    const W = 64;
    const src = new StaticVoxels(PAL, W, W, 0, 31), dst = new StaticVoxels(PAL, W, W, 0, 31);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) for (let z = 0; z < 10; z++) src.set(x, y, z, material(0, 1));
    for (let c = 0; c < src.cols * src.rows; c++) dst.copyRotatedChunk(src, 1, c);
    const exposed = (s: StaticVoxels) => { const out: string[] = []; s.forEachExposed((x, y, z, v) => out.push(`${x},${y},${z},${v}`)); return out.sort().join('|'); };
    exposed(dst);
    // Un trozo del mundo, vacío del todo, y copiado otra vez
    for (let y = 16; y < 32; y++) for (let x = 16; x < 32; x++) for (let z = 0; z < 10; z++) src.set(x, y, z, 0);
    const before = dst.clock;
    dst.copyRotatedChunk(src, 1, 1 * src.cols + 1);
    const ref = new StaticVoxels(PAL, W, W, 0, 31);
    for (let c = 0; c < src.cols * src.rows; c++) ref.copyRotatedChunk(src, 1, c);
    expect(exposed(dst)).toBe(exposed(ref));
    expect([...dst.height]).toEqual([...ref.height]);
    // (y queda como cambiado, para quien hornea)
    expect(dst.changedSince(before).length).toBe(1);
  });
});
