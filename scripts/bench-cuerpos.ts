// Lo que cuesta mover muchos cuerpos (runtime/body.ts, moveBody) sobre un mundo de muestra: N cuerpos de radios 2, 4 y
// 6 que andan en direcciones que cambian, como una oleada. Mide el tiempo por paso de todos, y una huella de dónde
// acaban (para comprobar que un cambio en el motor no mueve nada). Uso: npx tsx scripts/bench-cuerpos.ts [tema] [N]
// (con node: V8, como el navegador; con bun la huella sale otra, porque Math.cos y Math.sin no dan igual). WAKE=n
// despierta n objetos del mundo, que cuentan en groundAt
import { floorLayout } from '../src/worldgen';
import { THEMES } from '../src/samples/themes';
import { buildWorldState } from '../src/world/build';
import { moveBody, restZ, type Body } from '../src/runtime/body';

const theme = (process.argv[2] ?? 'medieval') as keyof typeof THEMES;
const N = Number(process.argv[3] ?? 220);
const SPEC = { ...THEMES[theme].spec, cols: 20, rows: 14 };
const { state: w } = buildWorldState(floorLayout(SPEC, 3, 1).layout, { ...THEMES[theme].look, objects: true });
const WAKE = Number(process.env.WAKE ?? 0);
const woken = [...w.objects].slice(0, WAKE);
for (const o of woken) w.objects.wake(o.id);

// Azar fijo (mulberry32) para que todas las vueltas hagan lo mismo
let seed = 12345;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const bodies: Body[] = [];
while (bodies.length < N) {
  const r = [2, 4, 6][bodies.length % 3]!;
  const x = r + rnd() * (w.width - 2 * r), y = r + rnd() * (w.depth - 2 * r);
  const b: Body = { x, y, z: 0, r };
  b.z = restZ(w, x, y, r);
  if (Number.isFinite(b.z) && w.standable(x, y, b.z, 2)) bodies.push(b);
}
const dirs = bodies.map(() => rnd() * Math.PI * 2);

const STEPS = Number(process.env.STEPS ?? 300);
const times: number[] = [];
for (let s = 0; s < STEPS; s++) {
  const t = performance.now();
  for (let i = 0; i < bodies.length; i++) {
    if (s % 40 === i % 40) dirs[i] = rnd() * Math.PI * 2;
    const sp = 0.9;
    moveBody(w, bodies[i]!, Math.cos(dirs[i]!) * sp, Math.sin(dirs[i]!) * sp);
  }
  times.push(performance.now() - t);
}
const warm = times.slice(30).sort((a, b) => a - b);
const q = (p: number) => warm[Math.floor(p * (warm.length - 1))]!.toFixed(2);
let h = 2166136261;
for (const b of bodies) for (const v of [b.x, b.y, b.z]) { const f = new Float64Array([v]); for (const byte of new Uint8Array(f.buffer)) h = Math.imul(h ^ byte, 16777619); }
console.log(`${theme} ${w.width}x${w.depth}, ${N} cuerpos, ${woken.length} despiertos, agua ${w.water ? 'sí' : 'no'}, ${STEPS} pasos: mediana ${q(0.5)} ms/paso, p95 ${q(0.95)}; huella ${(h >>> 0).toString(16)}`);
