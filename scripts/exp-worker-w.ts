// EXPERIMENTO: el worker de scripts/exp-worker.ts. Hace su ventana, se corre igual y pinta los recuadros que le piden
import { makeWindow, shiftEast } from './exp-worker-comun';
import { renderRectFor } from '../src/world/bake';
declare const self: { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: unknown, t?: Transferable[]): void };
let win: ReturnType<typeof makeWindow> | null = null;
let entered: number[][] = [];
self.onmessage = (e: MessageEvent) => {
  const m = e.data as { kind: string; path?: string; i?: number; brake?: number };
  if (m.kind === 'init') { const a = performance.now(); win = makeWindow(m.path!); self.postMessage({ kind: 'ready', ms: performance.now() - a }); }
  else if (m.kind === 'shift') { entered = shiftEast(win!); self.postMessage({ kind: 'shifted', n: entered.length }); }
  else if (m.kind === 'rect') {
    const a = performance.now(), o = renderRectFor(win!.baked, entered[m.i!]!), ms = performance.now() - a;
    // El freno propio (la puerta del 6x): el worker no lo frena el CDP; se espera (brake - 1) veces lo trabajado
    if (m.brake && m.brake > 1) { const until = performance.now() + ms * (m.brake - 1); while (performance.now() < until); }
    self.postMessage({ kind: 'rect', i: m.i, ms, wall: performance.now() - a, o }, [o.rgba.buffer, o.depth.buffer, o.face.buffer, o.pick.buffer]);
  }
};
