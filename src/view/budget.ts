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
}

// Cuadros seguidos sin presupuesto (porque otra cosa lo gastó) antes de dar una porción igualmente
const STARVE_FRAMES = 4;
// Cuántas llamadas de cada clase recuerda la cola para saber lo que suele costar la siguiente, y lo que tiene que gastar
// una llamada para contar (las que esperan a otro trabajo no gastan nada)
const COST_SAMPLES = 32;
const MIN_SAMPLE_MS = 0.01;

export class FrameBudget {
  private queue: ViewJob[] = [];
  private starved = 0;

  // ms se puede cambiar entre cuadros. near (opcional): un presupuesto APARTE para lo cercano, los trabajos con
  // priority < near.below, que se hacen antes y pueden llevarse hasta near.ms del cuadro; los demás siguen con ms.
  // Así lo que el jugador tiene que ver ya (el recuadro de un golpe, con rebakeChangedJobs y near) cabe en un cuadro
  // sin dar más tiempo a todo lo demás
  constructor(public ms = 3, private readonly now: () => number = () => performance.now(), public near: { ms: number; below: number } | null = null) {}

  get pending(): number {
    return this.queue.length;
  }

  // Encola. Si ya hay uno con la misma key, el nuevo ocupa su sitio en la cola (no vuelve al final: lo que cambia
  // a menudo no se quedaría nunca sin hacer) y el viejo se descarta sin acabar.
  push(job: ViewJob): void {
    const i = this.queue.findIndex((j) => j.key === job.key);
    if (i >= 0) this.queue[i] = job;
    else this.queue.push(job);
    if (job.priority === undefined) return;
    // Con prioridad: delante de los que tienen más (o ninguna), detrás de los de igual o menos
    const at = i >= 0 ? i : this.queue.length - 1;
    this.queue.splice(at, 1);
    const p = job.priority;
    let k = this.queue.findIndex((j) => j.priority === undefined || j.priority > p);
    if (k < 0) k = this.queue.length;
    this.queue.splice(k, 0, job);
  }

  // Lo que cuesta cada clase de llamada (la key hasta ":" o "#": rect, light, sky, view-cut...): las últimas
  // COST_SAMPLES, y su p95 como lo esperado de la siguiente. Las llamadas que no gastan nada medible (una espera) no
  // cuentan
  private costs = new Map<string, { ms: number[]; at: number; p95: number }>();
  private static kind(key: string): string {
    const m = /[:#]/.exec(key);
    return m ? key.slice(0, m.index) : key;
  }
  expected(key: string): number {
    return this.costs.get(FrameBudget.kind(key))?.p95 ?? 0;
  }
  private record(key: string, ms: number): void {
    if (!(ms >= MIN_SAMPLE_MS)) return;
    const k = FrameBudget.kind(key);
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
    let i = from, ran = 0;
    while (i < this.queue.length) {
      const job = this.queue[i]!;
      if (!inPhase(job)) break;
      const t = this.now();
      if (ran > 0 && t >= deadline) break;
      // Una clase que todavía no ha corrido nunca no tiene estimación: solo empieza como primera llamada de la fase
      // (si no, empezaría sin sitio y se pasaría una unidad entera)
      const cost = this.costs.get(FrameBudget.kind(job.key));
      if (ran > 0 && (!cost || t + cost.p95 > deadline)) { i++; continue; }
      const done = job.run(deadline), ms = this.now() - t;
      this.record(job.key, ms);
      // Una llamada que no gasta nada medible (una espera, o un trabajo que ya no tenía nada que hacer) no cuenta como la
      // llamada de la fase: lo de detrás, aunque sea de una clase sin estimación, todavía puede empezar (si no, una luz
      // que espera a su recuadro dejaría el recuadro sin correr)
      if (ms >= MIN_SAMPLE_MS) ran++;
      if (done) this.queue.splice(i, 1);
      else i++;
    }
  }
  // Una vez por cuadro. spentMs: lo que ya se llevó la vista en este cuadro de lo que cuenta contra el mismo
  // presupuesto. Devuelve los ms gastados aquí.
  run(spentMs = 0): number {
    if (!this.queue.length) return 0;
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
    let deadline = start2 + this.ms - spentMs;
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
