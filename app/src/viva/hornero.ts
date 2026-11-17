// EXPERIMENTO (rama worker-exp): el worker que pinta los recuadros de los trozos que entran en la ventana viva de
// viva.html (?worker=1). Lleva su copia de los vóxeles de la ventana: genera y estampa él cada trozo que escribe el
// principal (la generación es determinista) y se corre con él; pinta el recuadro que le piden y lo manda transferido.
// Con freno N, tras pintar espera N - 1 veces lo que tardó (el CDP no frena los workers: la puerta del 6x)
import { StaticVoxels, WorldState } from '../../../src/world/state';
import { BlockSet, BlockGrid, type VoxsetFile } from '../../../src/world/blocks';
import { generateRegion, type RegionSpec } from '../../../src/world/regiongen';
import { bakeWorldJob, renderRect, type Baked, type ScreenRect } from '../../../src/world/bake';

let store: StaticVoxels, grid: BlockGrid, shell: Baked, spec: RegionSpec, C = 16;
let busyMs = 0, skipped = 0;
// La tanda de rehorneado de ahora (Baked.rebakeEpoch del principal): lo pedido en una tanda vieja ya no vale (un
// corrimiento lo descartó) y se salta. Se pinta de la cola propia, uno por tarea, para que los mensajes nuevos (la tanda,
// sobre todo) entren entre medias
let epoch = 0;
// Dónde está la vista en la imagen (el centro, en píxeles): lo pedido más cerca de ella va primero
let view = { x: 0, y: 0 };
const far = (m: Record<string, unknown>) => { const r = m.rect as ScreenRect; return Math.hypot(Math.max(0, r.x0 - view.x, view.x - r.x1), Math.max(0, r.y0 - view.y, view.y - r.y1)); };
const queue: Array<Record<string, unknown>> = [];
let scheduled = false;
const next = () => {
  scheduled = false;
  if (!queue.length) return;
  // (lo de tandas viejas, fuera; de lo demás, lo más cerca de la vista)
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (far(queue[i]!) < far(queue[best]!)) best = i;
  const m = queue.splice(best, 1)[0]!;
  if ((m.epoch as number) < epoch) skipped++;
  else {
    const a = performance.now(), o = renderRect(shell, m.rect as ScreenRect), ms = performance.now() - a;
    const brake = (m.brake as number) || 1;
    if (brake > 1) { const until = performance.now() + ms * (brake - 1); while (performance.now() < until); }
    busyMs += performance.now() - a;
    (self as unknown as { postMessage(x: unknown, t: Transferable[]): void }).postMessage({ kind: 'rect', id: m.id, ms, busyMs, skipped, o }, [o.rgba.buffer, o.depth.buffer, o.face.buffer, o.pick.buffer]);
  }
  if (queue.length && !scheduled) { scheduled = true; setTimeout(next, 0); }
};
self.onmessage = (e: MessageEvent) => {
  const m = e.data as Record<string, unknown>;
  if (m.kind === 'init') {
    const set = BlockSet.fromJSON(m.voxset as VoxsetFile);
    spec = m.spec as RegionSpec; C = m.chunk as number;
    const W = m.width as number, D = m.depth as number, B = set.size;
    store = new StaticVoxels(set.palette, W, D, 0, spec.height * B - 1);
    grid = new BlockGrid(new WorldState(store, [], null), set);
    shell = bakeWorldJob({ model: store, lights: [], width: W, depth: D }, { topZ: store.zMax + 1, ...(m.bake as object) }).baked;
  } else if (m.kind === 'gen') {
    const [tx, ty] = m.t as [number, number], [bx, by] = m.at as [number, number];
    grid.stampRegion(generateRegion(spec, { x0: tx * C, y0: ty * C, z0: 0, width: C, depth: C, height: spec.height }), [bx, by, 0]);
  } else if (m.kind === 'shift') {
    const [dcx, dcy] = m.chunks as [number, number], [cx, cy] = m.cells as [number, number];
    store.shift(dcx, dcy);
    grid.shift(cx, cy);
  } else if (m.kind === 'view') {
    view = { x: m.x as number, y: m.y as number };
  } else if (m.kind === 'epoch') {
    epoch = m.epoch as number;
  } else if (m.kind === 'rect') {
    // (lo que se pide va con el estado de ahora: un gen o un shift que llegue después se aplica antes de pintarlo; un
    // shift viene detrás de su tanda nueva, y entonces lo pedido antes se salta)
    queue.push(m);
    if (!scheduled) { scheduled = true; setTimeout(next, 0); }
  }
};
