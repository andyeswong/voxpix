// EL CICLO DEL DÍA: la luz ambiente (y, si se quiere, el fondo) a lo largo de un día, por claves. El día es
// un número de ticks; la hora sale del tick de la simulación, así que es la misma en cualquier máquina y en una
// partida repetida. Lo que se hace de noche (los bichos que salen, las antorchas que se encienden) es del juego.
// docs/motor.md, "El ciclo del día".

export type Rgb = readonly [number, number, number];

// Una clave: en qué momento del día (0..1, 0 = medianoche), la luz ambiente (lo que reciben las caras sin otra luz,
// como Frame2DOptions.ambient) y, opcional, el fondo (0..255, como Frame2DOptions.background)
export interface DayKey { at: number; ambient: Rgb; background?: Rgb }

// El valor en `phase` (0..1, da la vuelta) entre las claves (ordenadas por at); suave (coseno) o recto
function sample(keys: readonly DayKey[], phase: number, pick: (k: DayKey) => Rgb | undefined, smooth: boolean): [number, number, number] | null {
  const ks = keys.filter((k) => pick(k));
  if (!ks.length) return null;
  const p = ((phase % 1) + 1) % 1;
  let i = ks.length - 1;
  while (i > 0 && ks[i]!.at > p) i--;
  if (ks[i]!.at > p) i = ks.length - 1;            // antes de la primera: entre la última (de ayer) y la primera
  const a = ks[i]!, b = ks[(i + 1) % ks.length]!;
  let span = b.at - a.at, t = p - a.at;
  if (span <= 0) span += 1;
  if (t < 0) t += 1;
  let f = span > 0 ? Math.min(1, t / span) : 0;
  if (smooth) f = (1 - Math.cos(Math.PI * f)) / 2;
  const va = pick(a)!, vb = pick(b)!;
  return [va[0] + (vb[0] - va[0]) * f, va[1] + (vb[1] - va[1]) * f, va[2] + (vb[2] - va[2]) * f];
}

export class DayCycle {
  readonly keys: DayKey[];
  readonly ticksPerDay: number;
  readonly start: number;
  readonly smooth: boolean;

  // ticksPerDay: lo que dura un día (a 60 ticks por segundo, 10 minutos son 36000). start: la hora en el tick 0 (0..1)
  constructor(o: { ticksPerDay: number; keys: DayKey[]; start?: number; smooth?: boolean }) {
    if (!(o.ticksPerDay > 0)) throw new Error('ticksPerDay tiene que ser mayor que 0');
    if (!o.keys.length) throw new Error('el día necesita al menos una clave');
    for (const k of o.keys) if (!(k.at >= 0 && k.at < 1)) throw new Error(`la clave en ${k.at} está fuera de 0..1`);
    this.keys = [...o.keys].sort((a, b) => a.at - b.at);
    this.ticksPerDay = o.ticksPerDay;
    this.start = o.start ?? 0;
    this.smooth = o.smooth ?? true;
  }

  // La hora del día en un tick (0..1; 0 = medianoche, 0,5 = mediodía)
  phase(tick: number): number {
    const p = this.start + tick / this.ticksPerDay;
    return ((p % 1) + 1) % 1;
  }
  // Qué día es (0 el primero)
  day(tick: number): number {
    return Math.floor(this.start + tick / this.ticksPerDay);
  }
  ambient(tick: number): [number, number, number] {
    return sample(this.keys, this.phase(tick), (k) => k.ambient, this.smooth)!;
  }
  // El fondo, si alguna clave lo dice; si no, null (el de siempre)
  background(tick: number): [number, number, number] | null {
    return sample(this.keys, this.phase(tick), (k) => k.background, this.smooth);
  }
  // ¿Es de noche? (la luz ambiente por debajo de `below`, en la media de sus tres canales)
  isNight(tick: number, below = 0.25): boolean {
    const a = this.ambient(tick);
    return (a[0] + a[1] + a[2]) / 3 < below;
  }
}
