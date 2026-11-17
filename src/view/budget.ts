// VISTA (FERN): el presupuesto de cada cuadro para el trabajo de la vista que no cabe de una vez (rehornear trozos,
// recalcular pesos de luces, lo que venga). Lo que no cabe se hace más despacio, no más caro: con él, el p95 volvió
// a 16,8 ms con la CPU frenada a 6x. Usa el reloj, así que vive en la vista y no en src/runtime: la simulación no lo
// puede leer.

// Un trabajo que se puede reanudar. run trabaja hasta pasar `deadline` (ms de performance.now) o acabar, y devuelve
// true si acabó. Cada llamada hace al menos una unidad de trabajo, aunque el plazo ya haya vencido: si no, no
// avanzaría nunca. La excepción es un trabajo que todavía no puede empezar (espera a otro): devuelve false sin
// gastar tiempo y la cola sigue con el siguiente. Mientras no acaba, la vista sigue enseñando lo viejo.
export interface ViewJob {
  readonly key: string;     // lo que rehace ("light:12", "rect:3,4"): un trabajo nuevo con la misma key sustituye al viejo
  run(deadline: number): boolean;
  // Opcional: cuanto más bajo, antes (lo que está cerca del jugador). Los que no la llevan van detrás, en su orden
  readonly priority?: number;
  // Opcional: true mientras solo espera (a otro trabajo, a un worker): la cola lo salta sin llamarlo. Lo mismo que si
  // run devolviera false sin gastar, pero sin la llamada (con miles esperando al worker, eran ~10 000 llamadas por
  // segundo)
  waiting?(): boolean;
}

// Cuadros seguidos sin presupuesto (porque otra cosa lo gastó) antes de dar una porción igualmente
const STARVE_FRAMES = 4;
// Cuántas llamadas de cada clase recuerda la cola para saber lo que suele costar la siguiente, y lo que tiene que gastar
// una llamada para contar (las que esperan a otro trabajo no gastan nada)
const COST_SAMPLES = 32;
const MIN_SAMPLE_MS = 0.01;
const FIRST = '|primera';

export class FrameBudget {
  private queue: ViewJob[] = [];
  private starved = 0;

  // ms se puede cambiar entre cuadros. near (opcional): un presupuesto APARTE para lo cercano, los trabajos con
  // priority < near.below, que se hacen antes y pueden llevarse hasta near.ms del cuadro; los demás siguen con ms.
  // Así lo que el jugador tiene que ver ya (el recuadro de un golpe, con rebakeChangedJobs y near) cabe en un cuadro
  // sin dar más tiempo a todo lo demás
  // spare: cuánto de lo que sobra del cercano (si no queda nada cercano) puede llevarse lo demás; por defecto, ms (lo
  // demás, como mucho, el doble); 0, nada. Lo que sobra del cercano no es tiempo libre: es el margen que el juego dejó
  // para la varianza del cuadro (un pico de la simulación). Con el sobrante entero, en un juego a 6x, los cuadros de más
  // de 25 ms pasaban de 8-10 a 28-43 por tirada
  constructor(public ms = 3, private readonly now: () => number = () => performance.now(), public near: { ms: number; below: number } | null = null, public spare?: number) {}

  get pending(): number {
    return this.queue.length;
  }

  // Encola. Si ya hay uno con la misma key, el nuevo ocupa su sitio en la cola (no vuelve al final: lo que cambia
  // a menudo no se quedaría nunca sin hacer) y el viejo se descarta sin acabar.
  // (byKey: el trabajo de cada key que está en la cola, para no buscarlo recorriéndola; sorted: los que llevan prioridad
  // van todos delante, ordenados, y los demás detrás, así que el sitio de uno nuevo se busca partiendo en dos. Con miles
  // de trabajos esperando al worker, buscar por toda la cola en cada push costaba un cuadro a 6x)
  private byKey = new Map<string, ViewJob>();
  private sorted = true;
  push(job: ViewJob): void {
    const old = this.byKey.get(job.key);
    const i = old ? this.queue.indexOf(old) : -1;
    if (i >= 0) {
      this.queue[i] = job;
      // (uno sin prioridad en el sitio de uno con ella: lo de delante ya no está ordenado)
      if (job.priority === undefined && old!.priority !== undefined) this.sorted = false;
    } else this.queue.push(job);
    this.byKey.set(job.key, job);
    if (job.priority === undefined) return;
    // Con prioridad: delante de los que tienen más (o ninguna), detrás de los de igual o menos
    const at = i >= 0 ? i : this.queue.length - 1;
    this.queue.splice(at, 1);
    const p = job.priority, q = this.queue;
    let k: number;
    if (this.sorted) {
      let lo = 0, hi = q.length;
      while (lo < hi) { const mid = (lo + hi) >> 1, j = q[mid]!; if (j.priority === undefined || j.priority > p) hi = mid; else lo = mid + 1; }
      k = lo;
    } else {
      k = q.findIndex((j) => j.priority === undefined || j.priority > p);
      if (k < 0) k = q.length;
    }
    q.splice(k, 0, job);
  }
  // Quita el de la posición i (acabó)
  private removeAt(i: number): void {
    const job = this.queue[i]!;
    this.queue.splice(i, 1);
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key);
    if (!this.queue.length) this.sorted = true;
  }

  // Lo que cuesta cada clase de llamada (la key hasta ":" o "#": rect, light, sky, view-cut...): las últimas
  // COST_SAMPLES, y su p95 como lo esperado de la siguiente. Las llamadas que no gastan nada medible (una espera) no
  // cuentan
  private costs = new Map<string, { ms: number[]; at: number; p95: number }>();
  private static kind(key: string): string {
    const m = /[:#]/.exec(key);
    return m ? key.slice(0, m.index) : key;
  }
  // La primera llamada de un trabajo (la que lo prepara, la cara de un recuadro nuevo) cuesta distinto que las siguientes:
  // cada clase lleva dos estimaciones, la de las primeras y la del resto. `first`: la de las primeras
  expected(key: string, first = false): number {
    return this.costs.get(FrameBudget.kind(key) + (first ? FIRST : ''))?.p95 ?? 0;
  }
  // Los trabajos que ya hicieron una llamada que gastó algo (las siguientes van con la estimación del resto)
  private started = new WeakSet<ViewJob>();
  // Cuántos cuadros seguidos se ha saltado cada trabajo por no caber (y en qué cuadro, para contar uno por cuadro)
  private skipped = new WeakMap<ViewJob, number>();
  private skippedFrame = new WeakMap<ViewJob, number>();
  private frameNo = 0;
  // (para medir) veces que la salvaguarda adelantó a uno que llevaba STARVE_FRAMES cuadros saltado
  starvedRuns = 0;
  private record(k: string, ms: number): void {
    if (!(ms >= MIN_SAMPLE_MS)) return;
    let c = this.costs.get(k);
    if (!c) this.costs.set(k, (c = { ms: [], at: 0, p95: 0 }));
    if (c.ms.length < COST_SAMPLES) c.ms.push(ms);
    else { c.ms[c.at] = ms; c.at = (c.at + 1) % COST_SAMPLES; }
    const sorted = [...c.ms].sort((a, b) => a - b);
    c.p95 = sorted[Math.floor(0.95 * (sorted.length - 1))]!;
  }
  // Corre los trabajos de [i, hasta) de la cola (hasta: el primero que no es de la fase) hasta el plazo. La primera
  // llamada de la fase va siempre (si no, nada avanzaría); las demás, solo si cabe lo que suele costar esa clase de
  // llamada (y si la clase no ha corrido nunca, no: no se sabe lo que cuesta): si no, se prueba con el siguiente (otra
  // clase puede caber), y el resto se queda para el cuadro siguiente
  private phase(deadline: number, inPhase: (j: ViewJob) => boolean, from = 0): void {
    let ran = 0;
    // Uno que lleva STARVE_FRAMES cuadros seguidos saltado por no caber va el primero de la fase (la primera llamada
    // es la que puede no caber). Si no, cuando delante siempre corre algo antes (una espera que el reloj del navegador,
    // de 0,1 ms, mide como trabajo), una clase que no cabe nunca sería la primera y no correría nunca
    let end = from;
    while (end < this.queue.length && inPhase(this.queue[end]!)) end++;
    for (let k = from; k < end; k++) {
      const job = this.queue[k]!;
      if ((this.skipped.get(job) ?? 0) < STARVE_FRAMES || this.skippedFrame.get(job) !== this.frameNo - 1) continue;
      const t = this.now(), r = this.call(job, deadline, t);
      this.starvedRuns++;
      if (r.done) this.removeAt(k);
      if (r.ms >= MIN_SAMPLE_MS) ran++;
      break;
    }
    let i = from;
    // (la prioridad del primero que podía correr en la fase: el escalón de lo que se adelanta por el plazo)
    let tier: number | undefined | null = null;
    while (i < this.queue.length) {
      const job = this.queue[i]!;
      if (!inPhase(job)) break;
      if (job.waiting?.()) { i++; continue; }
      if (tier === null) tier = job.priority;
      const t = this.now();
      if (ran > 0 && t >= deadline) {
        // Lo que queda de la fase y podía correr (no espera), del mismo escalón de prioridad que el primero que podía
        // correr, también se salta este cuadro: cuenta para la salvaguarda. Si no, detrás de algo que se come el plazo en
        // cada llamada, el bucle no llegaba nunca y la racha se rompía: un recuadro cercano esperaba a que lo de delante
        // acabara entero (1,1 s en el juego de FERN con el worker, detrás de recuadros del worker sin prioridad como él).
        // Solo su escalón: si contaban todos, a los 4 cuadros se adelantaban por delante de los de más prioridad, uno por
        // cuadro, y la sección (prioridad 0) perdía su turno (204f7a6: la franja con huecos en 40-67 cuadros de ~300)
        for (let k = i; k < this.queue.length; k++) {
          const q = this.queue[k]!;
          if (!inPhase(q)) break;
          if (q.priority === tier && !q.waiting?.()) this.noteSkip(q);
        }
        break;
      }
      // Una clase que todavía no ha corrido nunca no tiene estimación: solo empieza como primera llamada de la fase
      // (si no, empezaría sin sitio y se pasaría una unidad entera). Si no cabe se salta, y se cuentan los cuadros
      // seguidos que lleva saltado
      const cost = this.costs.get(this.costKey(job));
      if (ran > 0 && (!cost || t + cost.p95 > deadline)) {
        this.noteSkip(job);
        i++;
        continue;
      }
      const r = this.call(job, deadline, t);
      // Una llamada que no gasta nada medible (una espera, o un trabajo que ya no tenía nada que hacer) no cuenta como la
      // llamada de la fase: lo de detrás, aunque sea de una clase sin estimación, todavía puede empezar (si no, una luz
      // que espera a su recuadro dejaría el recuadro sin correr)
      if (r.ms >= MIN_SAMPLE_MS) ran++;
      if (r.done) this.removeAt(i);
      else i++;
    }
  }
  // Un cuadro más saltado (una vez por cuadro; la racha sigue si también se saltó el anterior)
  private noteSkip(job: ViewJob): void {
    const last = this.skippedFrame.get(job);
    if (last === this.frameNo) return;
    this.skipped.set(job, (last === this.frameNo - 1 ? this.skipped.get(job) ?? 0 : 0) + 1);
    this.skippedFrame.set(job, this.frameNo);
  }
  private costKey(job: ViewJob): string { return FrameBudget.kind(job.key) + (this.started.has(job) ? '' : FIRST); }
  // Una llamada: corre, apunta lo que costó (en su clase y posición) y deja de contarla como saltada
  private call(job: ViewJob, deadline: number, t: number): { done: boolean; ms: number } {
    const k = this.costKey(job);
    this.skipped.delete(job); this.skippedFrame.delete(job);
    const done = job.run(deadline), ms = this.now() - t;
    this.record(k, ms);
    if (ms >= MIN_SAMPLE_MS) this.started.add(job);
    return { done, ms };
  }
  // Una vez por cuadro. spentMs: lo que ya se llevó la vista en este cuadro de lo que cuenta contra el mismo
  // presupuesto. Devuelve los ms gastados aquí.
  run(spentMs = 0): number {
    if (!this.queue.length) return 0;
    this.frameNo++;
    const start = this.now();
    // 1) lo cercano, con su presupuesto (va delante en la cola: está ordenada por prioridad)
    const nr = this.near;
    const isNear = (j: ViewJob) => !!nr && j.priority !== undefined && j.priority < nr.below;
    if (nr) {
      this.phase(start + nr.ms, isNear);
      if (!this.queue.length) return this.now() - start;
    }
    // 2) lo demás, con el presupuesto de siempre. Lo cercano ya tuvo su turno: no vuelve a correr aquí (se llevaría
    // otra unidad entera del presupuesto de lo demás)
    let from = 0;
    while (from < this.queue.length && isNear(this.queue[from]!)) from++;
    if (from >= this.queue.length) return this.now() - start;
    const start2 = this.now();
    // Lo que sobra del cercano, si no queda nada cercano en la cola (se acabó, o no había): lo demás se lleva como mucho
    // `spare` (por defecto, ms). Así lo de detrás (el cielo, las luces lejanas, preparar lo expuesto) avanza cuando no
    // hay nada urgente, sin comerse el margen del juego. Si queda algo cercano (no cupo), no: es suyo
    const spare = nr && from === 0 ? Math.min(this.spare ?? this.ms, Math.max(0, start + nr.ms - start2)) : 0;
    let deadline = start2 + this.ms - spentMs + spare;
    if (deadline <= start2) {
      if (++this.starved < STARVE_FRAMES) return this.now() - start;
      deadline = start2;         // una porción mínima: el primer trabajo hace una unidad y para
    }
    this.starved = 0;
    // En orden. Un trabajo que no acaba se deja para el cuadro siguiente y se sigue con el de detrás: o se le acabó el
    // plazo (y entonces la fase para), o no puede avanzar todavía (una luz que espera a que se publique su recuadro,
    // que va detrás en la cola)
    this.phase(deadline, () => true, from);
    return this.now() - start;
  }
}
