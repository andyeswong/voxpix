// EXPERIMENTO (rama worker-exp): lo que comparten el hilo principal y el worker de scripts/exp-worker.ts. Los dos hacen la
// misma ventana viva (el mundo de MUNDO) y la corren igual: la generación es determinista, así que el worker tiene una
// copia de la ventana sin que le pasen vóxeles
import { readFileSync } from 'node:fs';
import { LiveWindow } from '../src/world/live';
import { BlockSet } from '../src/world/blocks';
import type { ViewJob } from '../src/world/bake';

export function makeWindow(path: string): LiveWindow {
  const ext = JSON.parse(readFileSync(path, 'utf8'));
  return new LiveWindow({ blocks: BlockSet.fromJSON(ext.voxset), spec: ext.spec, nx: 9, ny: 11, chunk: 16, center: ext.center, margin: ext.margin, bake: ext.bake });
}
// Correr la ventana un trozo al este y dejarlo todo hecho (escribir lo que entra y rehornearlo), sin reloj: lo mismo en
// los dos lados. Devuelve los trozos de vóxeles de cada trozo del mundo que entró
export function shiftEast(win: LiveWindow): number[][] {
  let q: ViewJob[] = [];
  const budget = { push(j: ViewJob) { const i = q.findIndex((u) => u.key === j.key); if (i >= 0) q[i] = j; else q.push(j); } };
  const x = (win.tx0 + 9 - 4) * win.T + 1, y = (win.ty0 + 5) * win.T + 1;
  const t0 = win.tx0;
  for (let g = 0; g < 10000; g++) {
    win.update(x, y, budget);
    const js = q; q = [];
    for (const j of js) while (!j.run(Infinity));
    if (win.tx0 !== t0 && !win.busy && !q.length) break;
  }
  // Los trozos que entraron: la última columna de trozos, en trozos de vóxeles del store (T / 16 por lado)
  const k = win.T / 16, cols = win.store.cols, out: number[][] = [];
  for (let ty = 0; ty < 11; ty++) {
    const cs: number[] = [];
    for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) cs.push((ty * k + j) * cols + 8 * k + i);
    out.push(cs);
  }
  return out;
}
