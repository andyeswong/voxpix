// El walk de MAIA en vóxeles (NARUTO), a partir de su modelo quieto. Es el mismo ciclo que el walk 2D aprobado
// (arte/aseprite-maia/v2_moonlighter/maia_anim.lua: 8 cuadros de 100 ms, contactos con el cuerpo 1 abajo, paso con
// una pierna adelantada y la rodilla doblada, y la cascada de arrastre del pelo y los faldones). En 2D solo se podía
// insinuar con tonos; en vóxeles las piernas y los brazos se mueven de verdad hacia delante y hacia atrás, así que
// el mismo modelo sirve para las 4 vistas (y las 8).
//
// Ejes del modelo: x al este (la derecha de la pantalla vista de frente), y al norte (el frente mira a -y, a la
// cámara), z arriba. Los pies en z = 0, y el pivote (0.5, 0, 0) no se mueve: el pie de apoyo toca siempre z = 0.
import { Model } from '../core';

export const WALK_FRAME_MS = 100;

// Las partes del cuerpo, por posición en el modelo quieto (medidas sobre maia.json)
const LEG_TOP = 4;          // z de la cadera (la franja que se pierde cuando el cuerpo baja)
const LEG_MAX_X = 5;        // |x| de las piernas (más allá, a esa altura, están las manos)
const ARM_MIN_X = 6;        // |x| de mangas y manos
const ARM_Z = [4, 14] as const;
const SHOULDER_Z = 14;
const SKIRT_Z = [5, 10] as const;   // faldones de la chaqueta
const HEAD_Z = 13;          // de aquí arriba se rellenan los huecos de la cabeza
const FLARE_TOP = 19;       // la melena se abre de la altura de los ojos hacia abajo

// Rampas del modelo de MAIA (maia_capas.px.js): 0 pelo, 1 piel, 2 abrigo
const HAIR = 0, SKIN = 1, COAT = 2;
const rampOf = (v: number) => Math.floor((v - 1) / 16);

// Un cuadro del ciclo. body/hair/skirt: cuánto bajan (como en maia_anim.lua). lift: la pierna que pasa con la
// rodilla doblada. front/back: cuánto adelanta (-y) cada pierna en el pie. arm: cuánto adelanta la mano izquierda
// (la derecha, lo contrario).
interface Pose { body: number; hair: number; skirt: number; flare?: boolean; lift?: 'L' | 'R'; legL: number; legR: number; arm: number }

const S = 2;   // medio paso, en vóxeles, en el pie
const A = 2;   // vaivén de la mano
// Contacto (0-1 y 4-5): las dos botas en el suelo, una delante y otra detrás, el cuerpo abajo.
// Paso (2-3 y 6-7): el pie de apoyo bajo el cuerpo, la pierna de atrás pasa con la rodilla doblada, el cuerpo arriba y la melena se abre al
// aterrizar. El brazo contrario a la pierna adelantada va hacia delante.
export const WALK_POSES: readonly Pose[] = [
  { body: 1, hair: 0, skirt: 0, legL: -S, legR: S, arm: -A },
  { body: 1, hair: 0, skirt: 1, legL: -S, legR: S, arm: -A },
  { body: 0, hair: 1, skirt: 1, flare: true, lift: 'R', legL: 0, legR: 0, arm: 0 },
  { body: 0, hair: 1, skirt: 0, lift: 'R', legL: 0, legR: 0, arm: A / 2 },
  { body: 1, hair: 0, skirt: 0, legL: S, legR: -S, arm: A },
  { body: 1, hair: 0, skirt: 1, legL: S, legR: -S, arm: A },
  { body: 0, hair: 1, skirt: 1, flare: true, lift: 'L', legL: 0, legR: 0, arm: 0 },
  { body: 0, hair: 1, skirt: 0, lift: 'L', legL: 0, legR: 0, arm: -A / 2 },
];

type Part = 'legL' | 'legR' | 'armL' | 'armR' | 'skirt' | 'hair' | 'body';

function partOf(x: number, z: number, v: number): Part {
  const r = rampOf(v);
  if (z <= LEG_TOP && Math.abs(x) <= LEG_MAX_X && (x < ARM_MIN_X - 1 || r !== SKIN)) return x <= 0 ? 'legL' : 'legR';
  if (z >= ARM_Z[0] && z <= ARM_Z[1] && Math.abs(x) >= ARM_MIN_X && (r === COAT || r === SKIN)) return x < 0 ? 'armL' : 'armR';
  if (r === HAIR) return 'hair';
  if (z >= SKIRT_Z[0] && z <= SKIRT_Z[1] && Math.abs(x) <= LEG_MAX_X && r === COAT) return 'skirt';
  return 'body';
}

// Una pierna: el pie se adelanta `step` y la cadera no (cizalla), y si pasa, sube 1 y pierde la franja de la cadera
function legOffset(z: number, step: number): number {
  return Math.round((step * (LEG_TOP + 1 - z)) / (LEG_TOP + 1));
}

// El brazo gira en el hombro: la mano se adelanta `swing` y el hombro no
function armOffset(z: number, swing: number): number {
  return Math.round((swing * (SHOULDER_Z - z)) / (SHOULDER_Z - ARM_Z[0]));
}

export function walkFrame(base: Model, pose: Pose): Model {
  const out = new Model(base.palette, `${base.name}_walk`);
  const hairVox: Array<[number, number, number, number]> = [];
  // 1) todo menos el pelo, en orden: el cuerpo, los brazos, las piernas y los faldones (lo de delante pisa)
  const placed: Array<[Part, number, number, number, number]> = [];
  for (const [x, y, z, v] of base.entries()) {
    const part = partOf(x, z, v);
    if (part === 'hair') { hairVox.push([x, y, z, v]); continue; }
    placed.push([part, x, y, z, v]);
  }
  const order: Part[] = ['body', 'armL', 'armR', 'legL', 'legR', 'skirt'];
  for (const want of order) for (const [part, x, y, z, v] of placed) {
    if (part !== want) continue;
    let nx = x, ny = y, nz = z;
    if (part === 'body') nz = z - pose.body;
    else if (part === 'armL' || part === 'armR') {
      nz = z - pose.body;
      ny = y + armOffset(z, part === 'armL' ? pose.arm : -pose.arm);
    } else if (part === 'legL' || part === 'legR') {
      const side = part === 'legL' ? 'L' : 'R';
      ny = y + legOffset(z, side === 'L' ? pose.legL : pose.legR);
      // la franja de la cadera la ocupa el cuerpo cuando baja, y la pierna que pasa (rodilla doblada) la pierde
      if (z === LEG_TOP && (pose.body || pose.lift === side)) continue;
      if (pose.lift === side) nz = z + 1;
    } else if (part === 'skirt') nz = z - pose.skirt;
    if (nz < 0) continue;
    out.set(nx, ny, nz, v);
  }
  // 2) el pelo, con su retraso, y al aterrizar la melena se abre un vóxel hacia fuera
  for (const [x, y, z, v] of hairVox) out.set(x, y, z - pose.hair, v);
  if (pose.flare) {
    const add: Array<[number, number, number, number]> = [];
    for (const [x, y, z, v] of hairVox) {
      const nz = z - pose.hair;
      if (nz > FLARE_TOP || Math.abs(x) < 6) continue;
      const nx = x + Math.sign(x);
      if (!out.get(nx, y, nz) && !base.get(nx, y, z)) add.push([nx, y, nz, v]);
    }
    for (const [x, y, z, v] of add) out.set(x, y, z, v);
  }
  // 3) huecos de la cabeza que deja el desfase entre pelo y cara: con el color del modelo quieto en ese sitio
  const b = base.bounds()!;
  for (let z = HEAD_Z; z <= b.maxZ; z++) for (let y = b.minY; y <= b.maxY; y++) for (let x = b.minX; x <= b.maxX; x++) {
    if (out.get(x, y, z)) continue;
    const orig = base.get(x, y, z);
    if (!orig) continue;
    if (out.get(x, y, z + 1) && out.get(x, y, z - 1)) out.set(x, y, z, orig);
  }
  return out;
}

export function walkFrames(base: Model): Model[] {
  return WALK_POSES.map((p) => walkFrame(base, p));
}
