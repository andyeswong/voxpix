// El .px.js se ejecuta aquí, en un worker, y no en la página. Un .px.js es CÓDIGO (el DSL de pxl es JavaScript) y en un
// editor publicado cualquiera puede compartir uno: dentro de la página leería y cambiaría el DOM, localStorage y lo
// que el sitio guarde. En el worker no hay DOM ni localStorage, y antes de ejecutarlo se le quitan la red, el
// almacenamiento y los subworkers. Solo vuelve un JSON (modelo o lista de vóxeles) que la página valida
// (app/src/pxl/sandbox.ts). Un bucle infinito solo cuelga el worker, y la página lo mata por tiempo.
import { loadPxl, pxlAssets, stackPrefixes, paletteFromPxl, spriteToVoxels, stackFromPxl, pxlDirectives, applyDirectives } from '../../../src/pxl/bridge';
import { Model, type Palette } from '../../../src/core';
import type { PxlJob, PxlReply } from './sandbox';

// Lo que el código del archivo no debe tener: red, almacenamiento del sitio, más código, más workers
const STRIP = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'cookieStore', 'BroadcastChannel', 'Worker', 'SharedWorker', 'navigator', 'storageBuckets', 'webkitRequestFileSystem', 'webkitRequestFileSystemSync'];
function strip(): void {
  const g = self as unknown as Record<string, unknown>;
  for (const k of STRIP) {
    for (let o: object | null = g; o; o = Object.getPrototypeOf(o)) {
      try { delete (o as Record<string, unknown>)[k]; } catch { /* no configurable */ }
    }
    try { Object.defineProperty(g, k, { value: undefined, writable: false, configurable: false }); } catch { /* ya está */ }
  }
}

const reply = self.postMessage.bind(self) as (r: PxlReply) => void;

self.onmessage = (e: MessageEvent<PxlJob>) => {
  const job = e.data;
  self.onmessage = null;          // un trabajo por worker: el archivo no puede pedir otro
  strip();
  try {
    const p = loadPxl(job.source, job.name);
    if (job.kind === 'inspect') return reply({ ok: true, kind: 'inspect', sprites: pxlAssets(p), stacks: stackPrefixes(p) });
    if (job.kind === 'new') {
      const pal = applyDirectives(paletteFromPxl(p, job.sprite ?? job.palette), pxlDirectives(job.source));
      const m = new Model(pal, job.modelName);
      if (job.sprite) spriteToVoxels(p, job.sprite, m, { plane: job.plane, z: job.z });
      return reply({ ok: true, kind: 'model', model: m.toJSON() });
    }
    if (job.kind === 'into') {
      const m = new Model(job.into as Palette);
      spriteToVoxels(p, job.sprite, m, { plane: job.plane, z: job.z });
      return reply({ ok: true, kind: 'voxels', voxels: [...m.entries()] });
    }
    const m = new Model(applyDirectives(paletteFromPxl(p, `${job.prefix}_z00`), pxlDirectives(job.source)), job.prefix);
    stackFromPxl(p, job.prefix, m);
    return reply({ ok: true, kind: 'model', model: m.toJSON() });
  } catch (err) {
    reply({ ok: false, error: String((err as Error)?.message ?? err) });
  }
};
