// Coste del corte al componer (src/world/section.ts) en el mundo de bench-corte (MUNDO=bloques por defecto aquí), con el
// objetivo en el túnel: la capa de sección (sectionLayer) y el cuadro de la CPU con y sin ella, por ancho de la caja.
// Sin navegador; '6x' es el tiempo sin freno por 6,7 (como bench-corte). Uso: bun scripts/bench-seccion.ts [anchos 32,384]
if (!process.env.MUNDO) process.env.MUNDO = 'bloques';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { tunnelWorld } from './tunel';

const K = 6.7;
const { s, lights, W, ZT } = tunnelWorld(process.env.MUNDO === 'bloques', process.env.ANT === '2');
const st = new WorldState(s, lights, null);
import { sectionLayer } from '../src/world/section';
import { frame2D, type Frame2DOptions } from '../src/world/frame2d';
void rebakeChangedJobs;
const outline = 'both' as const;
const b = bakeWorld({ model: s, lights, width: W, depth: W }, { topZ: ZT, incline: 0.5, sky: true, outline });
const VW = 384, VH = 216;
// El objetivo en el túnel (y 184..199, pies en z 8), en x 192; la vista centrada en él
const tx = 192, ty = 191, tz = 8;
const [px, py] = b.cam.project(tx, ty, tz);
const base: Frame2DOptions = { vx: Math.max(0, Math.min(b.width - VW, Math.round(px) - VW / 2)), vy: Math.max(0, Math.min(b.height - VH, Math.round(py) - VH / 2)), vw: VW, vh: VH, time: 0, lights: true, ambient: [0.8, 0.8, 0.85], cave: [0.2, 0.2, 0.25] };
const N = 40;
const p = (a: number[], q: number) => [...a].sort((u, v) => u - v)[Math.floor(q * (a.length - 1))]!;
for (const width of (process.argv[2] ?? '32,384').split(',').map(Number)) {
  const cutAt = (x: number) => ({ x0: x - width / 2, x1: x + width / 2 - 1, y0: 0, y1: ty, zMin: tz });
  const tl: number[] = [], tf: number[] = [], tn: number[] = [];
  let count = 0;
  for (let k = 0; k < N + 5; k++) {
    const x = tx + (k % 8) - 4;                                   // el objetivo anda: la caja se mueve cada cuadro
    let a = performance.now(); const L = sectionLayer(b, cutAt(x)); const lt = performance.now() - a;
    count = L?.count ?? 0;
    a = performance.now(); frame2D(st, b, { ...base, section: cutAt(x + 0.5) }); const ft = performance.now() - a;
    a = performance.now(); frame2D(st, b, base); const nt = performance.now() - a;
    if (k >= 5) { tl.push(lt); tf.push(ft); tn.push(nt); }
  }
  console.log(`ancho ${width} vóxeles (${width / 8} bloques): ${count} píxeles sustituidos; la capa p50 ${p(tl, 0.5).toFixed(2)} ms (6x ${(p(tl, 0.5) * K).toFixed(1)}), p95 ${p(tl, 0.95).toFixed(2)}; el cuadro de la CPU con capa p50 ${p(tf, 0.5).toFixed(1)} ms, sin capa ${p(tn, 0.5).toFixed(1)} ms`);
}

// ANDAR=1: el objetivo anda por el túnel a 5 bloques/s (40 vóxeles/s, a 60 cuadros por segundo) con SectionPainter: la
// sección se pinta por franjas con una FrameBudget de SECCION_MS ms por cuadro (4 por defecto) y FRANJAS por delante (4).
// ESCALA=1: todo a 1x (el presupuesto y lo que se cuenta, sin multiplicar); si no, a 6x (los ms de la CPU sin freno por
// 6,7 y el presupuesto dividido).
// Cuenta: el cuadro en que aparece entera la primera vez, los cuadros con hueco después (alguna franja de la caja sin
// pintar), lo que cuesta componer la capa por cuadro y lo que se pinta por cuadro (a 6x)
if (process.env.ANDAR === '1') {
  const { SectionPainter } = await import('../src/world/section');
  const budget6 = Number(process.env.SECCION_MS ?? 4), ahead = Number(process.env.FRANJAS ?? 4);
  const { FrameBudget } = await import('../src/view/budget');
  const KX = process.env.ESCALA === '1' ? 1 : K;
  for (const width of (process.argv[2] ?? '32,128,192,384').split(',').map(Number)) {
    const painter = new SectionPainter(b, { ahead, behind: 1 }), budget = new FrameBudget(budget6 / KX);
    let x = 64, appear = -1, holes = 0;
    const comp: number[] = [], paint: number[] = [], extra: number[] = [], compW: number[] = [];
    for (let f = 0; f < 420 && x < W - 64; f++) {
      x += 40 / 60;
      painter.set({ ...(await import('../src/world/section')).sectionAround(null, x, ty, tz, width) }, 1);
      const j = painter.job();
      if (j) budget.push(j);
      let a = performance.now();
      budget.run();
      paint.push((performance.now() - a) * KX);
      a = performance.now(); const L = painter.layer(); comp.push((performance.now() - a) * KX); if (appear >= 0) compW.push(comp[comp.length - 1]!);
      const ok = painter.ready();
      if (appear < 0 && ok) appear = f;
      else if (appear >= 0 && !ok) holes++;
      if (f % 20 === 0 && L) {
        const opts = { ...base, vx: Math.max(0, Math.min(b.width - VW, Math.round(x) - VW / 2)) };
        a = performance.now(); frame2D(st, b, { ...opts, sectionLayer: L }); const tw = performance.now() - a;
        a = performance.now(); frame2D(st, b, opts); extra.push((tw - (performance.now() - a)) * KX);
      }
    }
    console.log(`ancho ${width / 8} bloques: aparece en el cuadro ${appear}, huecos después ${holes}; componer p95 ${p(comp, 0.95).toFixed(2)} máx ${p(comp, 1).toFixed(1)} ms, andando ya pintada p50 ${compW.length ? p(compW, 0.5).toFixed(2) : '-'} p95 ${compW.length ? p(compW, 0.95).toFixed(2) : '-'} máx ${compW.length ? p(compW, 1).toFixed(1) : '-'} ms; pintar p50 ${p(paint, 0.5).toFixed(1)} p95 ${p(paint, 0.95).toFixed(1)} máx ${p(paint, 1).toFixed(1)} ms; cuadro de la CPU con capa, de más ${extra.length ? p(extra, 0.5).toFixed(1) : '-'} ms (todo a ${KX === 1 ? '1x' : '6x'}); unidades pintadas ${painter.painted}`);
  }
}
