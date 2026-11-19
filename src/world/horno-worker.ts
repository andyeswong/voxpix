// La entrada del worker de BakeWorker (horno.ts):
//   new BakeWorker(new Worker(new URL('voxpix/src/world/horno-worker.ts', import.meta.url), { type: 'module' }))
import { BakeWorkerHost, type ToWorker, type FromWorker } from './horno';

const scope = self as unknown as { postMessage(m: FromWorker, t: Transferable[]): void; onmessage: ((e: { data: ToWorker }) => void) | null };
const host = new BakeWorkerHost((m, t) => scope.postMessage(m, t));
scope.onmessage = (e) => host.receive(e.data);
