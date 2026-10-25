// Copia de mi motor de luz del juego (escenario-motor/src/engine/lighting, 2026-10-24): la vista previa
// ilumina igual que el juego. Si cambia allí, copiarlo de nuevo.
// PARTE PURA (sim/ puede usarla): luces como datos. Sin Phaser, sin canvas, sin azar sin semilla.

// Una luz de punto. Las coordenadas son del mundo, en píxeles del juego.
export interface Light {
  x: number;
  y: number;
  radius: number;                           // a esta distancia ya no alumbra
  color: readonly [number, number, number]; // 0..1 por canal
  intensity: number;                        // 1 = alumbra al máximo; por encima, deslumbra (capa ADD)
  flicker?: { amount: number; speed: number; seed: number };  // amount 0..1, speed en cambios por segundo
  source?: string;                          // id de la fuente de la que nace (ver LightSource)
}

// Lo que se ve donde no llega ninguna luz: un multiplicador por canal (0..1)
export interface Ambient {
  color: readonly [number, number, number];
}

// Ruido de valor determinista: la misma semilla y el mismo instante dan siempre lo mismo
function hash01(seed: number, n: number): number {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Intensidad de una luz en el instante `time` (segundos), con su parpadeo
export function lightIntensity(light: Light, time: number): number {
  const f = light.flicker;
  if (!f || f.amount === 0) return light.intensity;
  const t = time * f.speed;
  const i = Math.floor(t);
  const k = t - i;
  const s = k * k * (3 - 2 * k);                       // suavizado entre dos valores
  const n = hash01(f.seed, i) * (1 - s) + hash01(f.seed, i + 1) * s;
  return light.intensity * (1 + f.amount * (n * 2 - 1));
}

// UNA LUZ NUNCA SALE DE LA NADA: nace de un objeto que se ve (antorcha, farol, brasero, letrero de neón,
// linterna). Una fuente es ese objeto: su tipo dice cómo se ve y cómo alumbra, y la luz se coloca en su
// llama. Dibujar la fuente es cosa de la vista; aquí solo se fija dónde está la llama y qué luz da.
export type SourceKind = 'torch' | 'lamp' | 'brazier' | 'neon-pink' | 'neon-cyan' | 'lantern' | 'screen';

export interface SourcePreset {
  flame: { dx: number; dy: number };         // dónde está la llama respecto al ancla del objeto, en px
  radius: number;
  color: readonly [number, number, number];
  intensity: number;
  flicker?: { amount: number; speed: number };
}

export const SOURCE_PRESETS: Record<SourceKind, SourcePreset> = {
  torch: { flame: { dx: 0, dy: -5 }, radius: 110, color: [1, 0.62, 0.28], intensity: 1.3, flicker: { amount: 0.25, speed: 9 } },
  // Para que se lea cálida el rojo tiene que subir bastante más que el azul: con [1, 0.92, 0.75] los tres canales llegan a 1 y sale blanca
  lamp: { flame: { dx: 0, dy: -3 }, radius: 100, color: [1, 0.72, 0.38], intensity: 0.9, flicker: { amount: 0.06, speed: 5 } },
  brazier: { flame: { dx: 0, dy: -8 }, radius: 120, color: [1, 0.55, 0.22], intensity: 1.4, flicker: { amount: 0.3, speed: 8 } },
  'neon-pink': { flame: { dx: 0, dy: -1 }, radius: 64, color: [1, 0.31, 0.85], intensity: 1, flicker: { amount: 0.08, speed: 6 } },
  'neon-cyan': { flame: { dx: 0, dy: -1 }, radius: 64, color: [0.21, 0.95, 1], intensity: 1, flicker: { amount: 0.08, speed: 6 } },
  lantern: { flame: { dx: 0, dy: -2 }, radius: 78, color: [0.62, 0.85, 1], intensity: 0.9 },
  // pantalla de ordenador: fría y corta, con un temblor casi imperceptible
  screen: { flame: { dx: 0, dy: -8 }, radius: 52, color: [0.45, 0.7, 1], intensity: 0.7, flicker: { amount: 0.04, speed: 3 } },
};

// Un objeto que emite luz. (x, y) es el ancla del objeto en el mundo, en píxeles. Lo que no se da sale del
// preset del tipo; los campos opcionales ajustan UNA fuente (cada dibujo tiene su llama a su altura, y un
// ambiente claro pide menos intensidad que uno de noche: ver maxSafeIntensity).
export interface LightSource {
  id: string;        // único en el nivel: de él sale la semilla del parpadeo, así que no cambia entre partidas
  kind: SourceKind;
  x: number;
  y: number;
  sprite?: string;   // animación con la que la vista dibuja el objeto, con el pie en (x, y); la luz ni la mira
  flame?: { dx: number; dy: number };      // dónde está la llama de ESTE dibujo, respecto al ancla
  intensity?: number;
  radius?: number;
  color?: readonly [number, number, number];
}

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

// La luz de una fuente: en su llama, con su color, su radio y su parpadeo
export function lightOf(source: LightSource): Light {
  const p = SOURCE_PRESETS[source.kind];
  const flame = source.flame ?? p.flame;
  return {
    x: source.x + flame.dx,
    y: source.y + flame.dy,
    radius: source.radius ?? p.radius,
    color: source.color ?? p.color,
    intensity: source.intensity ?? p.intensity,
    ...(p.flicker ? { flicker: { amount: p.flicker.amount, speed: p.flicker.speed, seed: hashId(source.id) } } : {}),
    source: source.id,
  };
}

export function lightsOf(sources: readonly LightSource[]): Light[] {
  return sources.map(lightOf);
}

// La mayor intensidad con la que una luz de ese color NO pasa de 1 en ningún canal, contando el pico del
// parpadeo, sobre ese ambiente. Por encima de 1 la capa ADD empieza a trabajar: con el sombreado por defecto
// deja píxeles sueltos y bordes de color (cada canal pasa de 1 en un sitio distinto); con softGlow (shade.ts)
// no hay ese problema y esto no hace falta. Medido por FERN: [1, 0.72, 0.38] sobre un ambiente de 0.6 -> 0.4.
export function maxSafeIntensity(
  ambient: readonly [number, number, number],
  color: readonly [number, number, number],
  flickerAmount = 0,
): number {
  let best = Infinity;
  for (let ch = 0; ch < 3; ch++) {
    const c = color[ch]!;
    if (c <= 0) continue;
    best = Math.min(best, Math.max(0, 1 - ambient[ch]!) / (c * (1 + flickerAmount)));
  }
  return best === Infinity ? 0 : best;
}
