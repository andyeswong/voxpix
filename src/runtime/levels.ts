// MOVERSE POR NIVELES (NARUTO): un cuerpo con alto que anda por debajo de techos (túneles, cuevas, interiores), cae
// por los huecos y salta. moveBody (body.ts) apoya los pies en lo más alto de cada columna, así que no puede estar
// debajo de nada; esto es una variante aparte, para el juego que la quiera, y moveBody no cambia. Determinista: sin
// reloj ni azar; la gravedad y el salto van por tick. docs/motor.md, "Moverse por niveles".
import { NO_FOOT, type WorldState } from '../world/state';
import { materialsOf } from '../core';

// Un cuerpo: un cilindro de radio r y alto height con los pies en z, y su velocidad vertical (vóxeles por tick)
export interface LevelBody {
  x: number; y: number; z: number; r: number; height: number; vz: number;
  fallFrom?: number;   // dónde empezó la caída que está en curso (lo pone moveBodyLevels, para landed)
}

export interface LevelRules {
  step: number;        // lo más que sube andando (un escalón)
  gravity: number;     // lo que gana vz hacia abajo cada tick (vóxeles por tick²)
  jump: number;        // la vz con la que salta (vóxeles por tick)
  maxFall: number;     // la vz más rápida cayendo
  ladderSpeed?: number;   // vóxeles por tick que sube o baja trepando (materiales con ladder); por defecto LADDER_SPEED
}
export const LEVEL_RULES: LevelRules = { step: 2, gravity: 0.08, jump: 1.3, maxFall: 4 };
export const LADDER_SPEED = 0.5;

const SUBSTEP = 0.5;

// La tabla de materiales de la paleta del mundo (null: todo lo lleno bloquea y se sube), una vez por llamada
type Mt = ReturnType<typeof materialsOf>;

// El suelo más alto de la columna (xi, yi) con la cara de arriba en zTop o por debajo: la cara de arriba del primer
// vóxel que bloquea bajando desde zTop. NO_FOOT si no hay ninguno (un hueco hasta el fondo) o si ese vóxel no se sube
// (un arbusto: material con climb false)
export function footBelow(w: WorldState, xi: number, yi: number, zTop: number, mt: Mt = materialsOf(w.solid.palette)): number {
  const s = w.solid;
  if (xi < 0 || yi < 0 || xi >= s.width || yi >= s.depth) return NO_FOOT;
  // Desde lo más alto que hay en la columna (la rejilla de alturas), no desde zTop
  for (let z = Math.min(s.zMax, Math.floor(zTop) - 1, s.height[yi * s.width + xi]! - 1); z >= s.zMin; z--) {
    const v = s.get(xi, yi, z);
    if (!v || (mt && !mt.blocks[v])) continue;
    if (mt && !mt.climb[v]) return NO_FOOT;
    return z + 1;
  }
  return NO_FOOT;
}

// Lo que dio footBelow en esta llamada a moveBodyLevels, por columna y altura: los subpasos de un tick pisan casi las
// mismas columnas a la misma altura (un cuerpo de radio 3 son ~29 columnas, y support se mira ~6 veces por tick). Es
// el mismo cálculo guardado: los resultados no cambian. Una tabla fija con una marca por llamada (nada que borrar)
const MEMO = 256;
const memoKey = new Float64Array(MEMO), memoVal = new Float64Array(MEMO), memoGen = new Uint32Array(MEMO);
let gen = 0;
function footMemo(w: WorldState, xi: number, yi: number, zTop: number, mt: Mt): number {
  const k = (yi * w.solid.width + xi) * 4096 + zTop;
  let i = (Math.imul(xi, 73856093) ^ Math.imul(yi, 19349663) ^ Math.imul(Math.floor(zTop * 8), 83492791)) & (MEMO - 1);
  for (let probe = 0; probe < 8; probe++, i = (i + 1) & (MEMO - 1)) {
    if (memoGen[i] !== gen) { memoGen[i] = gen; memoKey[i] = k; return (memoVal[i] = footBelow(w, xi, yi, zTop, mt)); }
    if (memoKey[i] === k) return memoVal[i]!;
  }
  return footBelow(w, xi, yi, zTop, mt);
}

// El apoyo del cuerpo en (x, y) con los pies a z: el suelo más alto bajo la huella que no esté por encima de z + step.
// -Infinity si toda la huella es hueco
// El último support de esta llamada con sus argumentos: el del final (¿en el suelo?) suele repetir los del vertical
let lastS = { gen: 0, x: 0, y: 0, z: 0, r: 0, step: 0, top: 0 };
function support(w: WorldState, x: number, y: number, z: number, r: number, step: number, mt: Mt): number {
  const L = lastS;
  if (L.gen === gen && L.x === x && L.y === y && L.z === z && L.r === r && L.step === step) return L.top;
  const top = supportOf(w, x, y, z, r, step, mt);
  L.gen = gen; L.x = x; L.y = y; L.z = z; L.r = r; L.step = step; L.top = top;
  return top;
}
function supportOf(w: WorldState, x: number, y: number, z: number, r: number, step: number, mt: Mt): number {
  const rr = r * r;
  let top = -Infinity;
  for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
    const ex = Math.min(Math.max(x, cx), cx + 1) - x, ey = Math.min(Math.max(y, cy), cy + 1) - y;
    if (ex * ex + ey * ey >= rr) continue;
    const g = footMemo(w, cx, cy, z + step, mt);
    if (g !== NO_FOOT && g > top) top = g;
  }
  return top;
}

// ¿Cabe el cuerpo con los pies a z en (x, y)? Ningún vóxel que bloquee en su huella entre z y z + height, y la
// huella dentro del mundo (fuera es pared, como en moveBody)
function clear(w: WorldState, x: number, y: number, z: number, r: number, height: number, mt: Mt): boolean {
  const rr = r * r, z0 = Math.floor(z + 1e-6), z1 = Math.ceil(z + height - 1e-6) - 1, s = w.solid;
  for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
    const ex = Math.min(Math.max(x, cx), cx + 1) - x, ey = Math.min(Math.max(y, cy), cy + 1) - y;
    if (ex * ex + ey * ey >= rr) continue;
    if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth) return false;
    const top = s.height[cy * s.width + cx]! - 1;                 // lo más alto que hay: por encima, nada
    for (let zz = z0; zz <= Math.min(z1, top); zz++) { const v = s.get(cx, cy, zz); if (v && (!mt || mt.blocks[v])) return false; }
  }
  return true;
}

// Un paso horizontal a (nx, ny): cabe si, apoyado en lo que haya (subiendo como mucho step), el cuerpo entero cabe.
// Si el apoyo queda por debajo, el cuerpo sigue a su altura (en el aire: caerá)
function stepTo(w: WorldState, b: LevelBody, nx: number, ny: number, rules: LevelRules, mt: Mt): boolean {
  const s = support(w, nx, ny, b.z, b.r, rules.step, mt);
  const z = s > b.z ? s : b.z;
  if (!clear(w, nx, ny, z, b.r, b.height, mt)) return false;
  b.x = nx; b.y = ny;
  if (s > b.z) { b.z = s; b.vz = 0; }
  return true;
}

// ¿Toca el cuerpo algún vóxel que se trepa? Su huella (el radio y medio vóxel más, para que pegado a la escala cuente)
// entre los pies y la cabeza
function onLadder(w: WorldState, b: LevelBody, mt: NonNullable<Mt>): boolean {
  const s = w.solid, r = b.r + 0.5, rr = r * r, z0 = Math.max(s.zMin, Math.floor(b.z)), z1 = Math.min(s.zMax, Math.ceil(b.z + b.height) - 1);
  for (let cy = Math.floor(b.y - r); cy <= Math.floor(b.y + r); cy++) for (let cx = Math.floor(b.x - r); cx <= Math.floor(b.x + r); cx++) {
    if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth) continue;
    const ex = Math.min(Math.max(b.x, cx), cx + 1) - b.x, ey = Math.min(Math.max(b.y, cy), cy + 1) - b.y;
    if (ex * ex + ey * ey >= rr) continue;
    for (let z = z0; z <= z1; z++) { const v = s.get(cx, cy, z); if (v && mt.ladder[v]) return true; }
  }
  return false;
}

export interface LevelMove { blocked: boolean; grounded: boolean; landed: number; climbing: boolean }

// Un tick: anda (dx, dy) en subpasos (cada eje por separado, como moveBody, para resbalar por las paredes), salta si
// `jump` y está en el suelo, y cae con la gravedad hasta apoyarse. Un techo corta el salto. landed: la altura de la
// caída si acaba de aterrizar (0 si no), para el daño por caída que quiera el juego.
// Trepar: mientras el cuerpo toca un vóxel de un material con ladder, `up` lo mueve en z (1 sube, -1 baja, 0 se queda,
// ladderSpeed vóxeles por tick) y no cae: sin gravedad, sin caída que contar. Sube lo que deje el techo y baja hasta el
// suelo. Para salir por arriba se anda hacia donde está el suelo: el escalón lo sube encima. Sin vóxeles que se trepan,
// todo es como antes
export function moveBodyLevels(w: WorldState, b: LevelBody, dx: number, dy: number, jump = false, rules: LevelRules = LEVEL_RULES, up = 0): LevelMove {
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / SUBSTEP));
  const ddx = dx / n, ddy = dy / n, mt = materialsOf(w.solid.palette);
  gen = (gen + 1) >>> 0 || 1;                                      // una marca nueva: lo guardado antes no vale
  let hit = false;
  for (let i = 0; i < n; i++) {
    if (ddx !== 0 && !stepTo(w, b, b.x + ddx, b.y, rules, mt)) hit = true;
    if (ddy !== 0 && !stepTo(w, b, b.x, b.y + ddy, rules, mt)) hit = true;
  }
  // Trepando: arriba o abajo con up, sin caer
  if (mt && onLadder(w, b, mt)) {
    const speed = rules.ladderSpeed ?? LADDER_SPEED, g = support(w, b.x, b.y, b.z, b.r, 0, mt);
    b.vz = 0; delete b.fallFrom;
    if (up > 0) {
      const nz = b.z + speed * Math.min(1, up);
      let z = b.z;
      while (z < nz) { const t = Math.min(nz, Math.floor(z) + 1); if (!clear(w, b.x, b.y, t, b.r, b.height, mt)) break; z = t; }
      b.z = z;
    } else if (up < 0) b.z = Math.max(g, b.z - speed * Math.min(1, -up));
    return { blocked: hit, grounded: g >= b.z - 1e-6, landed: 0, climbing: true };
  }
  // Vertical
  const ground = support(w, b.x, b.y, b.z, b.r, 0, mt);
  const onGround = b.vz <= 0 && ground >= b.z - 1e-6;
  if (jump && onGround) b.vz = rules.jump;
  let landed = 0;
  if (b.vz > 0 || !onGround) {
    const startZ = b.z;
    b.vz = Math.max(-rules.maxFall, b.vz - rules.gravity);
    const nz = b.z + b.vz;
    if (b.vz > 0) {
      // Subiendo: lo que deje el techo, vóxel a vóxel
      let z = b.z;
      while (z < nz) { const t = Math.min(nz, Math.floor(z) + 1); if (!clear(w, b.x, b.y, t, b.r, b.height, mt)) { b.vz = 0; break; } z = t; }
      b.z = z;
    } else {
      const g = support(w, b.x, b.y, b.z, b.r, 0, mt);
      if (nz <= g) { landed = (b.fallFrom ?? startZ) - g; b.z = g; b.vz = 0; delete b.fallFrom; }
      else { if (b.fallFrom === undefined) b.fallFrom = startZ; b.z = nz; }
      if (!Number.isFinite(b.z)) { b.z = w.solid.zMin; b.vz = 0; }    // un hueco hasta el fondo del mundo
    }
  }
  const g2 = support(w, b.x, b.y, b.z, b.r, 0, mt);
  return { blocked: hit, grounded: b.vz === 0 && g2 >= b.z - 1e-6, landed: Math.max(0, landed), climbing: false };
}
