// Lo que cuesta preparar un giro de la cámara (prepareViewJob) en un mundo de bloques grande: la copia girada y el
// horneado por separado, con llamadas de 2 ms como las da una cola (PLAZO=0.5: de 0,5 ms, lo que son 3 ms a 6x), lo que
// deja por hacer después (el trabajo exposure) y el mismo horneado de una vez.
//   bun scripts/bench-giro.ts [giros=1,2] [tiradas=2]
// El mundo: 384 x 384 x 96 vóxeles (48 x 48 x 12 bloques de 8) de generateTerrain, con el subsuelo lleno de piedra y
// vetas de dos menas (las losas no son de un solo valor), árboles con hojas y un túnel. Sin freno de CPU.
import { material, type Palette } from '../src/core';
import { StaticVoxels, WorldState } from '../src/world/state';
import { prepareViewJob, type Quarter, type PrepStage } from '../src/world/view';
import { WorldView } from '../src/world/view';
import { bakeWorld, rebakeChangedJobs } from '../src/world/bake';
import { BlockSet, BlockGrid } from '../src/world/blocks';
import { generateTerrain } from '../src/world/terrain';

const W = 384, ZT = 96, B = 8;
const quarters = (process.argv[2] ?? '1,2').split(',').map(Number) as Quarter[];
const RUNS = Number(process.argv[3] ?? 2);
const STEP = Number(process.env.PLAZO ?? 2);       // ms por llamada (como los da una cola)
const pal = { ramps: [
  { name: 'piedra', colors: ['#202428', '#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'tierra', colors: ['#2a1a10', '#4a3020', '#6a4a30', '#8a6644', '#aa8460'] },
  { name: 'hierba', colors: ['#10301a', '#1e5028', '#2e7038', '#46904c', '#68b060'] },
  { name: 'tronco', colors: ['#2b1b12', '#4a2f1d', '#6e4729'] }, { name: 'hojas', colors: ['#1f3a22', '#2f5a2f', '#46803c'], material: 'arbusto' },
  { name: 'cobre', colors: ['#3a2010', '#7a4020', '#c07040'] }, { name: 'hierro', colors: ['#302830', '#605060', '#a090a0'] },
] } as Palette;

export function benchWorld(): WorldState {
  const s = new StaticVoxels(pal, W, W, 0, ZT - 1);
  const cube = (r: number, keep: (x: number, y: number, z: number) => boolean = () => true) => {
    const o: Array<[number, number, number, number]> = [];
    for (let z = 0; z < B; z++) for (let y = 0; y < B; y++) for (let x = 0; x < B; x++) if (keep(x, y, z)) o.push([x, y, z, material(r, 1 + ((x + y + z) % 2))]);
    return o;
  };
  const set = BlockSet.fromJSON({ format: 'voxpix-set', version: 1, name: 'banco', size: B, palette: pal, blocks: [
    { id: 'piedra', voxels: cube(0) }, { id: 'hierba', voxels: cube(2), props: { covered: 'tierra' } }, { id: 'tierra', voxels: cube(1) },
    { id: 'tronco', voxels: cube(3, (x, y) => Math.hypot(x - 3.5, y - 3.5) < 3.2) },
    { id: 'hojas', voxels: cube(4, (x, y, z) => ((x * 7 + y * 13 + z * 5) % 11) > 1) },
    { id: 'cobre', voxels: cube(5) }, { id: 'hierro', voxels: cube(6) },
  ] });
  const leaf: Array<[number, number, number, string]> = [];
  for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) leaf.push([dx!, dy!, 4, 'hojas']);
  generateTerrain({
    seed: 1, surface: { base: 7, amplitude: 2, scale: 9, octaves: 3 },
    layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],
    veins: [{ block: 'cobre', in: 'piedra', chance: 0.02, size: [3, 8] }, { block: 'hierro', in: 'piedra', chance: 0.01, size: [2, 6], bz: [0, 4] }],
    scatter: [{ on: 'hierba', density: 0.02, spacing: 4, structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'tronco'], [0, 0, 3, 'tronco'], ...leaf, [0, 0, 5, 'hojas']] }],
  }, new BlockGrid(new WorldState(s, [], null), set));
  for (let y = 184; y < 200; y++) for (let x = 0; x < W; x++) for (let z = 8; z < 20; z++) s.set(x, y, z, 0);
  return new WorldState(s, [{ id: 'a', kind: 'torch', x: 180.5, y: 191.5, z: 12, baked: true }], null);
}

const OPTS = { topZ: 104, incline: 0.5, sky: true, outline: 'both' as const, outlineColor: '#101014' };

if (import.meta.main) {
  const t0 = performance.now();
  const st = benchWorld();
  let filled = 0;
  for (const _ of st.solid.entries()) filled++;
  console.log(`mundo ${W}x${W}x${ZT}: ${(filled / 1e6).toFixed(2)} M vóxeles llenos, generado en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  // Calentar el JIT: el giro 0 de una vez
  bakeWorld(new WorldView(st, 0).bakeable(), OPTS);
  for (let run = 0; run < RUNS; run++) for (const q of quarters) {
    const p = prepareViewJob(st, q, OPTS, { cut: true });
    const bakeCalls: number[] = [];
    const per: Partial<Record<PrepStage, { ms: number; calls: number; max: number }>> = {};
    while (p.stage() !== 'done') {
      const stage = p.stage(), a = performance.now();
      p.job.run(a + STEP);
      const ms = performance.now() - a, r = (per[stage] ??= { ms: 0, calls: 0, max: 0 });
      r.ms += ms; r.calls++; r.max = Math.max(r.max, ms);
      if (stage === 'bake') bakeCalls.push(ms);
    }
    const pb = p.result()!.baked;
    const sorted = [...bakeCalls].sort((x, y) => x - y), pq = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))]!.toFixed(2);
    // Lo que deja por hacer: el trabajo exposure (las máscaras de lo expuesto que el horneado no hizo)
    const e0 = performance.now();
    for (const j of rebakeChangedJobs(pb, p.result()!.view.frame().lights)) while (!j.run(Infinity));
    const expoMs = performance.now() - e0;
    const stageMs = `[llamadas del horneado p50 ${pq(0.5)} p95 ${pq(0.95)} p99 ${pq(0.99)}, > 1 ms: ${sorted.filter((x) => x > 1).length}] (imagen ${pb.ms.render.toFixed(0)}, luz ${pb.ms.light.toFixed(0)}; después, exposure ${expoMs.toFixed(0)} ms)`;
    const a = performance.now();
    const v = new WorldView(st, q, { cut: true });
    const b = performance.now();
    bakeWorld(v.bakeable(), OPTS);
    const once = performance.now() - b, copyOnce = b - a;
    const line = Object.entries(per).map(([k, r]) => `${k} ${r!.ms.toFixed(0)} ms / ${r!.calls} llamadas (máx ${r!.max.toFixed(1)})`).join(' · ');
    console.log(`giro ${q}, tirada ${run + 1}: ${line} ${stageMs} · de una vez: copia ${copyOnce.toFixed(0)} ms, horneado ${once.toFixed(0)} ms`);
  }
}
