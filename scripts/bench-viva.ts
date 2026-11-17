// Lo que cuesta, sin freno, cada parte de correr la ventana viva un trozo al este (LiveWindow, la ventana y el mundo de
// app/viva.html): preparar el corrimiento, el cambio, escribir cada trozo que entra y rehornearlo, por clase de trabajo.
//   bun scripts/bench-viva.ts [giros 1|4] [corrimientos 3]
import { LiveWindow } from '../src/world/live';
import { set, SPEC } from './ventana-mundo';
import type { ViewJob } from '../src/world/bake';

const GIROS = Number(process.argv[2] ?? 1), N = Number(process.argv[3] ?? 3);
// BANDA=32 (columnas por franja del rehorneado), JUNTAR=1 (un recuadro por tramo de trozos), FILAS=64 (filas por paso);
// sin ninguna, la forma por defecto de LiveWindow; ANTES=1, la de antes (franjas de 4 de alto entero, por columna)
const shape = { ...(process.env.BANDA ? { band: Number(process.env.BANDA) } : {}), ...(process.env.JUNTAR === '1' ? { merge: true } : {}), ...(process.env.FILAS ? { rows: Number(process.env.FILAS) } : {}) };
// El paso más largo de la cola (ms) por clase
const spec = { ...SPEC, height: 12, surface: { base: 6, amplitude: 2, scale: 9 }, seaLevel: 5, veins: (SPEC.veins ?? []).map((v) => ({ ...v, z: [1, 4] as [number, number] })), caves: { ...SPEC.caves!, z: [1, 4] as [number, number] } };
let t = performance.now();
const win = new LiveWindow({ blocks: set, spec, nx: 9, ny: 11, chunk: 16, center: [0, 0], margin: { x: 4, n: 6, s: 4 }, quarters: GIROS === 4 ? [0, 1, 2, 3] : [0], ...(Object.keys(shape).length || process.env.ANTES ? { rebake: shape } : {}), bake: { incline: 0.5, sky: true, outline: 'both' } });
console.log(`arranque (99 trozos, ${GIROS} giro(s)): ${(performance.now() - t).toFixed(0)} ms`);
// La cola: cada trabajo hasta acabar, sumando el tiempo por clase (la key hasta ":" o "#", sin el g<q>/)
const by = new Map<string, number>(), most = new Map<string, number>();
let q: ViewJob[] = [];
const budget = { push(j: ViewJob) { const i = q.findIndex((u) => u.key === j.key); if (i >= 0) q[i] = j; else q.push(j); } };
const kind = (k: string) => k.replace(/^g\d\//, '').split(/[:#]/)[0]!;
const T = win.T;
for (let s = 0; s < N; s++) {
  by.clear(); most.clear();
  const x = (win.tx0 + 9 - 4) * T + 1, y = T / 2;   // el objetivo, a menos del margen del borde este
  let guard = 0;
  do {
    win.update(x, y, budget);
    const jobs = q; q = [];
    for (const j of jobs) { const a = performance.now(); for (;;) { const c = performance.now(), ok = j.run(c + 3); const d = performance.now() - c; if (d > (most.get(kind(j.key)) ?? 0)) most.set(kind(j.key), d); if (ok) break; } by.set(kind(j.key), (by.get(kind(j.key)) ?? 0) + performance.now() - a); }
  } while ((win.busy || q.length) && ++guard < 10000);
  win.update(x, y, budget); for (const j of q) { const a = performance.now(); while (!j.run(performance.now() + 4)); by.set(kind(j.key), (by.get(kind(j.key)) ?? 0) + performance.now() - a); } q = [];
  const tot = [...by.values()].reduce((a, b) => a + b, 0);
  console.log(`corrimiento ${s + 1} (tx0 ${win.tx0}): total ${tot.toFixed(0)} ms; ` + [...by].map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ') + `; cambio ${win.lastSwitchMs.toFixed(1)} ms; trozos ${win.stats.loadMs.slice(-11).map((v) => v.toFixed(0)).join(' ')}; llamada más larga (plazo 3 ms): ` + [...most].map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', '));
}

// GIRAR=1: girar con fundido (turnTo, sin los otros giros horneados), 0 -> 1 -> 2 -> 3 -> 0, con el recuadro de la
// página (384 x 216): el núcleo (hasta el cambio: ms de CPU, llamadas con plazo de 3 ms y la más larga) y lo demás
// (la copia y el rehorneado de la cola, hasta que no queda nada)
if (process.env.GIRAR === '1') {
  const w2 = new LiveWindow({ blocks: set, spec, nx: 9, ny: 11, chunk: 16, center: [0, 0], margin: { x: 4, n: 6, s: 4 }, viewport: [384, 216], bake: { incline: 0.5, sky: true, outline: 'both' } });
  const x = T / 2, y = T / 2;
  for (const g of [1, 2, 3, 0] as const) {
    w2.turnTo(g);
    let calls = 0, most = 0, core = 0, rest = 0;
    let guard = 0;
    do {
      w2.update(x, y, budget);
      const jobs = q2(); 
      for (const j of jobs) for (;;) { const c = performance.now(), wasCore = w2.turning?.phase === 'core', ok = j.run(c + 3), d = performance.now() - c; if (wasCore) { calls++; most = Math.max(most, d); core += d; } else rest += d; if (ok) break; }
    } while ((w2.busy || q.length) && ++guard < 100000);
    console.log(`giro a ${g}: núcleo ${core.toFixed(0)} ms de CPU (turnMs ${w2.stats.turnMs.at(-1)!.toFixed(0)}) en ${calls} llamadas de 3 ms, la más larga ${most.toFixed(1)}; lo demás ${rest.toFixed(0)} ms; ${JSON.stringify(w2.lastTurn, (k, v) => typeof v === 'number' ? Math.round(v) : v)}`);
  }
}
function q2(): ViewJob[] { const j = q; q = []; return j; }
