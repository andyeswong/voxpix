// MATERIALES (NARUTO, pedido de Andrés): cada rampa de la paleta es un material, y un material es un juego de
// PROPIEDADES que el motor lee por separado. Nadie pregunta "¿es follaje?": la luz pregunta cuánta luz deja pasar,
// el agua si es fondo, la colisión si bloquea. Así un material nuevo (vidrio, metal, hielo...) es una fila de datos,
// no código nuevo en cada sitio.
//
//   { name: 'vidrio', colors: [...], material: 'vidrio' }                 un material de la lista
//   { name: 'cristal-azul', colors: [...], material: 'vidrio', props: { light: 0.6 } }   con un ajuste
//   { name: 'raro', colors: [...], props: { light: 0.3, blocks: false } }  propiedades sueltas sobre el sólido
//
// Compatibilidad: una rampa sin material ni props es SOLID (el comportamiento de siempre, byte a byte), y las rampas
// viejas con kind: 'foliage' (y blocks) son 'follaje' (o 'arbusto').
import { FOLIAGE_T, FOLIAGE_BACKLIT, MAX_RAMPS, MAX_TONES, type Palette, type Ramp } from './palette';

export interface MaterialProps {
  light: number;      // 0..1: cuánta luz deja pasar cada vóxel (0 = opaco: la corta)
  backlit: number;    // luz que recibe una cara iluminada por detrás, por |n·l| (hojas finas); 0 = ninguna
  bed: boolean;       // ¿el agua lo cuenta como fondo y como pared? (el follaje no: el agua lo cubre)
  blocks: boolean;    // ¿bloquea el paso? (jugador, entidades, disparos)
  emissive: boolean;  // da luz propia: la luz del mundo no lo oscurece
  reflect: number;    // 0..1: cuánto refleja. RESERVADO: todavía no lo pinta ningún render (metal, agua: fase 2)
}

export const SOLID: Readonly<MaterialProps> = { light: 0, backlit: 0, bed: true, blocks: true, emissive: false, reflect: 0 };

// La lista de materiales. Añadir uno es añadir una fila; las propiedades que no se dicen son las del sólido.
export const MATERIALS: Readonly<Record<string, Readonly<Partial<MaterialProps>>>> = {
  solido: {},
  follaje: { light: FOLIAGE_T, backlit: FOLIAGE_BACKLIT, bed: false, blocks: false },   // hierba, flores, hojas
  arbusto: { light: FOLIAGE_T, backlit: FOLIAGE_BACKLIT, bed: false, blocks: true },    // follaje que no se atraviesa
  vidrio: { light: 0.85 },                                                             // translúcido: pasa la luz, no el agua ni el jugador
  metal: { reflect: 0.6 },
};

// Las propiedades de una rampa: las del sólido, encima las de su material, encima sus props
export function rampMaterial(r: Ramp): MaterialProps {
  const name = r.material ?? (r.kind === 'foliage' ? (r.blocks ? 'arbusto' : 'follaje') : undefined);
  if (name !== undefined && !MATERIALS[name]) throw new Error(`material desconocido: ${name} (hay: ${Object.keys(MATERIALS).join(', ')})`);
  return { ...SOLID, ...(name ? MATERIALS[name] : {}), ...(r.emissive ? { emissive: true } : {}), ...(r.props ?? {}) };
}

// ---- la tabla por material (rampa*16 + tono + 1) para los bucles calientes y los shaders

// El sol (sombra de sí o no) va en enteros para que la CPU y la GPU den lo mismo: cada vóxel que deja pasar luz
// "gasta" round(-log2(light) * SUN_UNIT) unidades del rayo (255 = opaco), y la celda queda en sombra al gastar
// foliageSunDepth * SUN_UNIT (el follaje, 0,5: 4 unidades, una hoja)
export const SUN_UNIT = 4;
export const SUN_OPAQUE = 255;
export const sunCost = (light: number): number => (light <= 0 ? SUN_OPAQUE : Math.min(SUN_OPAQUE - 1, Math.max(0, Math.round(-Math.log2(light) * SUN_UNIT))));

export interface MaterialTable {
  ramps: MaterialProps[];
  light: Float32Array;     // por material: luz que deja pasar (0 = opaco)
  sun: Uint8Array;         // por material: unidades de sol que gasta (SUN_OPAQUE = opaco)
  backlit: Float32Array;   // por material: luz por detrás
  bed: Uint8Array;         // por material: 1 si el agua lo cuenta como fondo
  blocks: Uint8Array;      // por material: 1 si bloquea el paso
}

// La tabla de una paleta, o null si todos sus materiales tratan la luz, el agua y el paso como el sólido (entonces
// el motor va por el camino de siempre, sin tabla). Se guarda por paleta: si cambian sus rampas, la paleta tiene que
// ser otro objeto (así lo hacen la app y el motor).
const cache = new WeakMap<Palette, MaterialTable | null>();
export function materialsOf(p: Palette): MaterialTable | null {
  let t = cache.get(p);
  if (t !== undefined) return t;
  const ramps = p.ramps.map(rampMaterial);
  const special = ramps.some((m) => m.light > 0 || m.backlit > 0 || !m.bed || !m.blocks);
  if (!special) { cache.set(p, null); return null; }
  const n = MAX_RAMPS * MAX_TONES + 1;
  t = { ramps, light: new Float32Array(n), sun: new Uint8Array(n).fill(SUN_OPAQUE), backlit: new Float32Array(n), bed: new Uint8Array(n).fill(1), blocks: new Uint8Array(n).fill(1) };
  t.sun[0] = 0; t.bed[0] = 0; t.blocks[0] = 0; t.light[0] = 1;
  ramps.forEach((m, i) => {
    const a = i * MAX_TONES + 1, b = a + MAX_TONES;
    t!.light.fill(Math.fround(m.light), a, b); t!.sun.fill(sunCost(m.light), a, b); t!.backlit.fill(Math.fround(m.backlit), a, b);
    t!.bed.fill(m.bed ? 1 : 0, a, b); t!.blocks.fill(m.blocks ? 1 : 0, a, b);
  });
  cache.set(p, t);
  return t;
}
