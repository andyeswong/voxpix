// EXPERIMENTO (rama worker-exp): hornear en un worker los recuadros de los trozos que entran en la ventana viva.
// El hilo principal y el worker hacen la misma ventana y se corren igual; el worker pinta el recuadro de cada trozo que
// entró y lo manda (búferes transferidos); el principal lo compara con el suyo byte a byte y mide lo que le cuesta
// publicarlo contra lo que le costaría pintarlo.
//   MUNDO=<json> bun scripts/exp-worker.ts [freno 1]
import { makeWindow, shiftEast } from './exp-worker-comun';
import { renderRectFor, publishRectBuffers, type RectOut } from '../src/world/bake';

const path = process.env.MUNDO!, BRAKE = Number(process.argv[2] ?? 1);
const worker = new Worker(new URL('./exp-worker-w.ts', import.meta.url).href);
const ask = (m: unknown) => new Promise<Record<string, unknown>>((res) => { worker.onmessage = (e) => res(e.data); worker.postMessage(m); });
const ready = ask({ kind: 'init', path });
let a = performance.now();
const win = makeWindow(path);
console.log(`ventana: principal ${(performance.now() - a).toFixed(0)} ms, worker ${(((await ready).ms) as number).toFixed(0)} ms (a la vez)`);
const wShift = ask({ kind: 'shift' });
const entered = shiftEast(win);
await wShift;
const f = (v: number) => v.toFixed(1);
let same = 0, renderMs = 0, workerMs = 0, wallMs = 0, publishMs = 0, bytes = 0;
for (let i = 0; i < entered.length; i++) {
  const t = performance.now(), ref = renderRectFor(win.baked, entered[i]!);
  renderMs += performance.now() - t;
  const r = await ask({ kind: 'rect', i, brake: BRAKE }) as { ms: number; wall: number; o: RectOut };
  workerMs += r.ms; wallMs += r.wall;
  const o = r.o;
  let eq = o.rect.x0 === ref.rect.x0 && o.rect.y0 === ref.rect.y0 && o.w === ref.w && o.h === ref.h;
  for (let k = 0; eq && k < ref.rgba.length; k++) eq = o.rgba[k] === ref.rgba[k];
  for (let k = 0; eq && k < ref.depth.length; k++) eq = Object.is(o.depth[k], ref.depth[k]) && o.face[k] === ref.face[k] && Object.is(o.pick[k], ref.pick[k]);
  if (eq) same++;
  bytes += o.rgba.byteLength + o.depth.byteLength + o.face.byteLength + o.pick.byteLength;
  const p = performance.now(); publishRectBuffers(win.baked, o); publishMs += performance.now() - p;
}
console.log(`${entered.length} trozos que entran: iguales byte a byte ${same}/${entered.length}`);
console.log(`hilo principal: pintar ${f(renderMs)} ms en total (${f(renderMs / entered.length)} por trozo); publicar lo del worker ${f(publishMs)} ms (${f(publishMs / entered.length)} por trozo)`);
console.log(`worker: pintar ${f(workerMs)} ms (freno ${BRAKE}: ${f(wallMs)} ms de reloj); ${(bytes / 1e6).toFixed(1)} MB transferidos`);
worker.terminate();
