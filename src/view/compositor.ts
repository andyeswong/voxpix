// VISTA: quién compone el cuadro del modo 2D. La GPU (WebGL2) si la hay; si no, la CPU (frame2D, el mismo
// cálculo y su oráculo), y lo dice en la consola: nunca pantalla negra.
//
// Si la GPU pierde el contexto (en el móvil pasa al ir a segundo plano), mientras tanto pinta la CPU en un lienzo 2D
// que ocupa el sitio del de WebGL; cuando el contexto vuelve, la GPU se rehace, lo sube todo de nuevo desde el Baked
// y su lienzo vuelve a su sitio. Si no vuelve, se queda la CPU.
import { frame2D, entitySprite, warmEntity, HEADINGS, type Frame2DOptions } from '../world/frame2d';
import type { Baked } from '../world/bake';
import type { RenderState } from '../world/state';
import { GpuCompositor, type WarmItem, type AtlasStats, type UploadStats } from './gpu/compositor';
export type { WarmItem, AtlasStats };

export interface CompositorStats {
  frameMs: number;             // lo que tardó frame() en el hilo principal (en la GPU: preparar y subir, no dibujar)
  uploadMs: number;            // de eso, las subidas a la GPU (texturas del horneado, agua, entidades, luces)
  parts?: { baked: number; entities: number; casters: number; water: number; drops: number };   // y por partes (solo la GPU)
}

export interface Compositor {
  readonly kind: 'gpu' | 'cpu';
  // El lienzo donde pinta ahora (cambia si la GPU pierde el contexto o no arranca después de pedirlo)
  readonly canvas: HTMLCanvasElement;
  readonly stats: CompositorStats;
  frame(state: RenderState, b: Baked, o: Frame2DOptions): void;
  // Prepara por adelantado los sprites de esos modelos (en la GPU, también subidos con sus cuerpos), para que el
  // primer cuadro en que aparecen no pague su render. `o` como en frame (cuentan el contorno y si hay luces). Con
  // budgetMs se para al pasarlo y devuelve cuántos quedan; se vuelve a llamar en el cuadro siguiente.
  prewarm(b: Baked, o: Frame2DOptions, list: readonly WarmItem[], budgetMs?: number): number;
  // Sube un horneado sin pintar (en la GPU: sus texturas y los pesos de sus luces), para hacerlo fuera de la partida.
  // La GPU guarda los últimos 4 horneados subidos: volver a uno (otro giro de la cámara) no lo vuelve a subir.
  upload(b: Baked): void;
  // Sube por partes un horneado que aún no se enseña (el giro con fundido: LiveWindow beforeTurnSwap), para que el cuadro
  // en que pase a enseñarse no lo pague entero. null si no hay nada que subir (la CPU)
  prepare(b: Baked): { run(deadline: number): boolean } | null;
  // Suelta lo que guarda de un horneado que ya no se va a pintar (sus texturas en la GPU y la referencia): la ventana viva
  // que gira con fundido (LiveWindow.turnTo) hace uno nuevo por giro, y la caché de 4 retendría sus copias giradas. El
  // de este cuadro no se suelta
  release(b: Baked): void;
  // El atlas de sprites de la GPU (sprites distintos en el último cuadro, en el atlas, tope y desalojos); null en la CPU
  atlasStats(): AtlasStats | null;
  // Lo que subió a la GPU el último cuadro: sprites nuevos, crecimientos del atlas de sprites y de los atlas 3D (cuerpos y
  // ocupación); null en la CPU. Para saber qué hay en un cuadro largo con el juego y la cola parados
  uploadStats(): UploadStats | null;
  // El agua en la GPU: corrimientos de su textura del fondo y celdas subidas por caja (para medir), y la textura leída de
  // vuelta (fondo, pared, cuenca y 0 por celda; para comprobarla contra la vista). null en la CPU
  waterStats(): { shifts: number; uploaded: number } | null;
  readWaterStatic(): Float32Array | null;
}

export function createCompositor(canvas: HTMLCanvasElement, opts: { prefer?: 'gpu' | 'cpu' } = {}): Compositor {
  const prefer = opts.prefer ?? 'gpu';
  const gpu = prefer === 'gpu' ? GpuCompositor.create(canvas) : null;
  if (gpu) console.info('[voxpix] cuadro compuesto en la GPU (WebGL2)');
  else if (prefer === 'gpu') console.warn('[voxpix] sin WebGL2 (o sin EXT_color_buffer_float): el cuadro se compone en la CPU');
  else console.info('[voxpix] cuadro compuesto en la CPU (pedido)');
  return gpu ? new GpuPath(canvas, gpu) : new CpuPath(canvas);
}

// La CPU pinta en un lienzo 2D. Si el que le dan ya tiene un contexto WebGL, pinta en uno nuevo que ocupa su sitio.
class CpuPath implements Compositor {
  readonly kind = 'cpu' as const;
  readonly canvas: HTMLCanvasElement;
  readonly stats: CompositorStats = { frameMs: 0, uploadMs: 0 };
  private readonly g: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    let g = canvas.getContext('2d');
    if (!g) {
      const fresh = canvas.cloneNode(false) as HTMLCanvasElement;
      canvas.replaceWith(fresh);
      canvas = fresh;
      g = canvas.getContext('2d')!;
    }
    this.canvas = canvas;
    this.g = g;
  }

  frame(s: RenderState, b: Baked, o: Frame2DOptions): void {
    const t0 = performance.now();
    const c = this.canvas;
    if (c.width !== o.vw || c.height !== o.vh) { c.width = o.vw; c.height = o.vh; }
    // Por CPU, detalle bajo salvo que se pida otro: es la de reserva y no llega con una multitud
    this.g.putImageData(new ImageData(frame2D(s, b, { ...o, detail: o.detail ?? 'bajo' }) as Uint8ClampedArray<ArrayBuffer>, o.vw, o.vh), 0, 0);
    this.stats.frameMs = performance.now() - t0;
  }

  // La CPU no sube nada (ni guarda nada)
  upload(_b: Baked): void { /* nada */ }
  prepare(_b: Baked): null { return null; }
  release(_b: Baked): void { /* nada */ }
  atlasStats(): null { return null; }
  uploadStats(): null { return null; }
  waterStats(): null { return null; }
  readWaterStatic(): null { return null; }

  // En la CPU basta con dejar el render de cada sprite en la caché de frame2d
  prewarm(b: Baked, o: Frame2DOptions, list: readonly WarmItem[], budgetMs = Infinity): number {
    const t0 = performance.now();
    let left = 0;
    for (const it of list) for (const yaw of it.yaws ?? HEADINGS) {
      if (performance.now() - t0 > budgetMs) { left++; continue; }
      entitySprite(b, warmEntity(it.model, yaw), o);
    }
    return left;
  }
}

// Lo precalentado, para reponerlo: cada prewarm con su lista (modelos, rumbos, si dan sombra). Al recuperar la GPU un
// contexto perdido (en un teléfono, al mandar la pestaña atrás) el compositor nuevo empieza vacío; sin esto, el horneado
// se resubía en el primer cuadro pero los sprites se pintaban uno a uno en mitad de la partida. Se repone con el
// horneado y las opciones del último cuadro (si cambió el nivel, los del nivel de ahora), o si no hubo cuadro, con los
// del prewarm
export class WarmMemory {
  private calls: Array<{ b: Baked; o: Frame2DOptions; list: WarmItem[] }> = [];
  private last: { b: Baked; o: Frame2DOptions } | null = null;
  record(b: Baked, o: Frame2DOptions, list: readonly WarmItem[]): void {
    // La misma lista otra vez (el mismo array, o los mismos modelos y rumbos) no se guarda dos veces
    const same = (a: readonly WarmItem[], c: readonly WarmItem[]) => a.length === c.length && a.every((it, i) => it.model === c[i]!.model && it.casts === c[i]!.casts && (it.yaws ?? HEADINGS).join() === (c[i]!.yaws ?? HEADINGS).join());
    if (this.calls.some((c) => same(c.list, list))) return;
    this.calls.push({ b, o: { ...o }, list: [...list] });
  }
  saw(b: Baked, o: Frame2DOptions): void { this.last = { b, o }; }
  // Un horneado soltado (release): las llamadas que lo guardaban pasan al último visto
  forget(b: Baked): void {
    if (this.last?.b === b) this.last = null;
    this.calls = this.calls.filter((c) => c.b !== b || this.last);
    for (const c of this.calls) if (c.b === b) c.b = this.last!.b;
  }
  get size(): number { return this.calls.reduce((n, c) => n + c.list.length, 0); }
  // Vuelve a precalentar todo en `into` (el compositor nuevo). Devuelve cuántos sprites no cupieron (como prewarm)
  replay(into: Pick<Compositor, 'prewarm'>): number {
    let left = 0;
    for (const c of this.calls) left += into.prewarm(this.last?.b ?? c.b, this.last ? { ...this.last.o } : c.o, c.list);
    return left;
  }
}

class GpuPath implements Compositor {
  private gpu: GpuCompositor | null;
  private cpu: CpuPath | null = null;          // mientras no hay contexto
  private readonly glCanvas: HTMLCanvasElement;
  private readonly warm = new WarmMemory();
  readonly stats: CompositorStats = { frameMs: 0, uploadMs: 0 };

  constructor(canvas: HTMLCanvasElement, gpu: GpuCompositor) {
    this.glCanvas = canvas;
    this.gpu = gpu;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();                       // sin esto el navegador no lo devuelve nunca
      console.warn('[voxpix] la GPU perdió el contexto: pinta la CPU mientras tanto');
      this.gpu = null;
      // La CPU necesita un lienzo 2D: uno nuevo en el sitio del de WebGL (que se guarda para cuando vuelva)
      const holder = document.createElement('canvas');
      holder.className = canvas.className;
      holder.style.cssText = canvas.style.cssText;
      holder.id = canvas.id;
      canvas.replaceWith(holder);
      this.cpu = new CpuPath(holder);
    });
    canvas.addEventListener('webglcontextrestored', () => {
      const again = GpuCompositor.create(canvas);
      if (!again) { console.warn('[voxpix] el contexto volvió pero la GPU no arranca: sigue la CPU'); return; }
      console.info('[voxpix] la GPU recuperó el contexto: lo sube todo de nuevo (y lo precalentado)');
      this.gpu = again;
      this.warm.replay(again);
      if (this.cpu) {
        canvas.style.cssText = this.cpu.canvas.style.cssText;
        this.cpu.canvas.replaceWith(canvas);
        this.cpu = null;
      }
    });
  }

  get kind(): 'gpu' | 'cpu' { return this.gpu ? 'gpu' : 'cpu'; }
  get canvas(): HTMLCanvasElement { return this.cpu?.canvas ?? this.glCanvas; }

  upload(b: Baked): void { this.gpu?.upload(b); }
  prepare(b: Baked): { run(deadline: number): boolean } | null { return this.gpu ? this.gpu.prepareJob(b) : null; }
  release(b: Baked): void { this.warm.forget(b); this.gpu?.release(b); }
  atlasStats(): AtlasStats | null { return this.gpu?.atlasStats() ?? null; }
  uploadStats(): UploadStats | null { return this.gpu ? { ...this.gpu.lastUploads } : null; }
  waterStats(): { shifts: number; uploaded: number } | null { return this.gpu ? { shifts: this.gpu.waterShifts, uploaded: this.gpu.waterStaticUploaded } : null; }
  readWaterStatic(): Float32Array | null { return this.gpu?.readWaterStatic() ?? null; }

  prewarm(b: Baked, o: Frame2DOptions, list: readonly WarmItem[], budgetMs?: number): number {
    this.warm.record(b, o, list);
    if (this.gpu) return this.gpu.prewarm(b, o, list, budgetMs);
    return this.cpu ? this.cpu.prewarm(b, o, list, budgetMs) : 0;
  }

  frame(s: RenderState, b: Baked, o: Frame2DOptions): void {
    this.warm.saw(b, o);
    if (this.gpu) {
      const t0 = performance.now();
      this.gpu.frame(s, b, o);
      this.stats.frameMs = performance.now() - t0;
      this.stats.uploadMs = this.gpu.uploadMs;
      this.stats.parts = this.gpu.parts;
    } else if (this.cpu) {
      this.cpu.frame(s, b, o);
      this.stats.frameMs = this.cpu.stats.frameMs;
      this.stats.uploadMs = 0;
    }
  }
}
