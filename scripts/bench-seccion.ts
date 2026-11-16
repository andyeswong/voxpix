// Coste del corte al componer (src/world/section.ts) en el mundo de bench-corte (MUNDO=bloques por defecto aquí), con el
// objetivo en el túnel: la capa de sección (sectionLayer) y el cuadro de la CPU con y sin ella, por ancho de la caja.
// Sin navegador; '6x' es el tiempo sin freno por 6,7 (como bench-corte). Uso: bun scripts/bench-seccion.ts [anchos 32,384]
if (!process.env.MUNDO) process.env.MUNDO = 'bloques';
import { material } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import type { WorldLight } from '../src/world/build';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { generateTerrain } from '../src/world/terrain';
import type { Palette } from '../src/core';

const W = 384, ZT = 96, B = 8, K = 6.7;
const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
  { name: 'tronco', colors: ['#2b1b12', '#4a2f1d', '#6e4729'] }, { name: 'hojas', colors: ['#1f3a22', '#2f5a2f', '#46803c'], material: 'arbusto' },
] } as Palette;
// El terreno de bench-picar (a media altura, +-3 bloques) con un túnel este-oeste de 1,5 bloques de alto (y 184..199,
// z 8..19), bajo todo el relieve: el corte (zTop 20, en su techo) siempre quita algo
const s = new StaticVoxels(pal, W, W, 0, ZT - 1);
const half = Math.floor(ZT / B / 2);
const hb = (bx: number, by: number) => half + Math.round(3 * Math.sin(bx / 5.3) * Math.cos(by / 4.1));
// MUNDO=bloques: el mundo de bloques de bench-caminos (generateTerrain, árboles con hojas), con el mismo túnel cavado
if (process.env.MUNDO === 'bloques') {
  const cube = (r: number, keep: (x: number, y: number, z: number) => boolean = () => true) => {
    const o: Array<[number, number, number, number]> = [];
    for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) if (keep(x, y, z)) o.push([x, y, z, material(r, 1 + ((x + y + z) % 2))]);
    return o;
  };
  const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: [
    { id: 'piedra', voxels: cube(0) }, { id: 'hierba', voxels: cube(2), props: { covered: 'tierra' } }, { id: 'tierra', voxels: cube(1) },
    { id: 'tronco', voxels: cube(3, (x, y) => Math.hypot(x - 3.5, y - 3.5) < 3.2) },
    { id: 'hojas', voxels: cube(4, (x, y, z) => ((x * 7 + y * 13 + z * 5) % 11) > 1) },
  ] });
  const leaf: Array<[number, number, number, string]> = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leaf.push([dx!, dy!, 4, 'hojas']);
  generateTerrain({
    seed: 1, surface: { base: 6, amplitude: 2, scale: 9, octaves: 3 },
    layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],
    scatter: [{ on: 'hierba', density: 0.02, spacing: 4, structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'tronco'], [0, 0, 3, 'tronco'], ...leaf, [0, 0, 5, 'hojas']] }],
  }, new BlockGrid(new WorldState(s, [], null), set));
  for (let y = 184; y < 200; y++) for (let x = 0; x < W; x++) for (let z = 8; z < 20; z++) s.set(x, y, z, 0);
} else for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const top = hb(x >> 3, y >> 3) * B;
  for (let z = 0; z < top; z++) {
    if (y >= 184 && y < 200 && z >= 8 && z < 20) continue;
    s.set(x, y, z, z >= top - B ? material(2, 2 + ((x + y) & 1)) : z >= top - 3 * B ? material(1, 2) : material(0, 2));
  }
}
const lights: WorldLight[] = process.env.ANT === '2'
  ? [{ id: 'a', kind: 'torch', x: 180.5, y: 191.5, z: 12, baked: true }, { id: 'b', kind: 'torch', x: 230.5, y: 191.5, z: 12, baked: true }]
  : [];
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
