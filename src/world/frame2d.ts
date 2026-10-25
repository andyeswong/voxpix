// Un cuadro del modo 2D del juego a partir del ESTADO DEL MUNDO: lo estático horneado (una vez por nivel), y
// encima, con la misma cámara, prueba de profundidad y luz: las entidades, el agua y las gotas.
import { render, camera, lightField3D, rgbOf, spotFactor, type PointLight3D, type Rendered, type Spot } from '../core';
import { resolveLight } from './lightutil';
import { buildLayers, applyLayers, type LightLayers } from '../lighting/shade';
import { lightView, worldPointAt, type Baked } from './bake';
import { key, unkey, DIR_VECTORS, type VoxelSource } from '../core';
import type { WorldLight } from './build';
import type { WorldState, Entity } from './state';

export interface Frame2DOptions {
  vx: number; vy: number; vw: number; vh: number;      // ventana de la imagen horneada
  time: number;
  lights: boolean;
  ambient: readonly [number, number, number];
  bob?: (e: Entity) => number;                          // saltito al andar (píxeles)
  background?: readonly [number, number, number];
  outline?: 'none' | 'outer' | 'both';                 // contorno de las entidades (por defecto, ninguno)
  outlineColor?: string;                                // su color fijo (si no, el tono 0 de la rampa vecina)
  // 'bajo': para la CPU de reserva con muchas entidades. Sin sombras de verdad de las entidades (solo las de
  // contacto), sin reflejo en el agua, y cada entidad con la luz del suelo bajo sus pies en vez de su luz por cara.
  // Por defecto, 'completo' (y la GPU siempre es completo)
  detail?: 'completo' | 'bajo';
  // Tope de luces por entidad: solo las N más cercanas (de las que llegan) alumbran a cada una. Sin tope, todas.
  entityLightCap?: number;
}

// Lienzo del render de una entidad y dónde caen sus pies
export const EW = 48, EH = 72;
const EOX = 24, EOY = 60;
// El render de una entidad no cambia mientras no cambie su modelo, su giro ni la proyección: se guarda. Con tope
// (los menos usados se sueltan): con giros libres, cada ángulo nuevo es un render nuevo y la caché crecía sin fin
// (FERN lo midió: 220 MB por partida antes de llevar los giros a 8 rumbos).
export const MAX_ENTITY_RENDERS = 1024;
const entityCache = new WeakMap<object, Map<string, Rendered>>();
const entityLru = new Map<string, [object, string]>();      // en orden de uso: el primero es el más viejo
function cacheTouch(model: object, ck: string, id: string): void {
  entityLru.delete(id);
  entityLru.set(id, [model, ck]);
  if (entityLru.size <= MAX_ENTITY_RENDERS) return;
  const [oldId, [m, k]] = entityLru.entries().next().value!;
  entityLru.delete(oldId);
  entityCache.get(m)?.delete(k);
}
// Cuántos renders de entidad hay guardados (para medir)
export const entityRenderCount = (): number => entityLru.size;

export function frame2D(state: WorldState, b: Baked, o: Frame2DOptions): Uint8ClampedArray {
  const { view, total } = frame2DParts(state, b, o);
  return total ? applyLayers(view, shadeLayers(total, o)) : view;
}

// Las capas de luz (MULTIPLY y ADD) de la luz por píxel de la vista
export function shadeLayers(total: Float32Array, o: Frame2DOptions): LightLayers {
  return buildLayers({ cell: 1, cols: o.vw, rows: o.vh, ambient: o.ambient, total }, { x: 0, y: 0, width: o.vw, height: o.vh }, { steps: 8, softGlow: true });
}

// El cuadro antes de la luz: el color de cada píxel y la luz que le llega (null sin luces). El compositor de la GPU
// hace lo mismo; la prueba del oráculo compara los dos.
export function frame2DParts(state: WorldState, b: Baked, o: Frame2DOptions): { view: Uint8ClampedArray; total: Float32Array | null } {
  const { vx, vy, vw, vh, ambient } = o;
  const view = new Uint8ClampedArray(vw * vh * 4);
  const depthBuf = new Float32Array(vw * vh);
  for (let y = 0; y < vh; y++) {
    depthBuf.set(b.depth.subarray((vy + y) * b.width + vx, (vy + y) * b.width + vx + vw), y * vw);
    view.set(b.rgba.subarray(((vy + y) * b.width + vx) * 4, ((vy + y) * b.width + vx + vw) * 4), y * vw * 4);
  }
  const bg = o.background ?? BACKGROUND;
  for (let i = 3; i < view.length; i += 4) if (!view[i]) { view[i - 3] = bg[0]; view[i - 2] = bg[1]; view[i - 1] = bg[2]; view[i] = 255; }
  const total = o.lights ? lightView(b, vx, vy, vw, vh, ambient, o.time) : null;
  if (total) {
    // Luces dinámicas (las añadidas en partida): por cuadro, en su radio
    for (const l of state.lights) if (l.baked === false) addDynamicLight(b, l, total, o);
    // Sombras de las entidades: lo que su cuerpo tapa de cada luz (solo las MAX_CASTERS más cercanas al centro)
    if (o.detail !== 'bajo') for (const e of shadowCasters(state, b, o)) castShadow(state, b, e, total, o);
  }

  // Las entidades: primero todas las sombras de contacto (en el suelo), después, en cada píxel, la entidad más
  // cercana a la cámara, y esa tapa el escenario si está delante. Es lo mismo que hace la GPU con su z-buffer.
  const sprites = state.entities.map((e) => entitySprite(b, e, o)).filter((d) => onView(d, o));
  // Con detalle bajo, cada entidad toma de una vez la luz del suelo bajo sus pies (antes de las sombras de contacto),
  // en vez de su luz por cara: con una multitud, esa es la que no cabe en la CPU
  const low = o.detail === 'bajo';
  const feetLight = low && total ? sprites.map((d) => {
    const x = Math.min(vw - 1, Math.max(0, d.fx - vx)), y = Math.min(vh - 1, Math.max(0, d.fy - vy)), q = (y * vw + x) * 3;
    return [total[q]!, total[q + 1]!, total[q + 2]!] as const;
  }) : [];
  if (total) for (const d of sprites) contactShadow(d, total, o);
  // La profundidad de cada píxel de entidad se calcula en float32 y se compara por la misma clave que el z-buffer de
  // la GPU (entityDepthKey): así, en un casi empate, las dos rutas eligen la misma entidad
  const entDepth = new Float32Array(vw * vh).fill(Infinity), entKey = new Float32Array(vw * vh).fill(Infinity);
  const entOf = new Int32Array(vw * vh).fill(-1), entPx = new Int32Array(vw * vh);
  const range = entityDepthRange(sprites);
  sprites.forEach((d, k) => {
    const dOff = Math.fround(d.dOff);
    for (let j = 0; j < EH; j++) for (let i = 0; i < EW; i++) {
      const s = j * EW + i;
      if (!d.img.rgba[s * 4 + 3]) continue;
      const sx = i + d.offX - vx, sy = j + d.offY - vy;
      if (sx < 0 || sy < 0 || sx >= vw || sy >= vh) continue;
      const t = sy * vw + sx, dd = Math.fround(d.img.depth[s]! + dOff), key = entityDepthKey(dd, range);
      if (key < entKey[t]!) { entKey[t] = key; entDepth[t] = dd; entOf[t] = k; entPx[t] = s; }
    }
  });
  const etotals = total && !low ? sprites.map((d) => entityLight(state, d, o)) : [];
  for (let t = 0; t < vw * vh; t++) {
    const k = entOf[t]!;
    if (k < 0 || entDepth[t]! >= depthBuf[t]! - 0.5) continue;      // lo que hay delante la tapa
    const d = sprites[k]!, s = entPx[t]!;
    depthBuf[t] = entDepth[t]!;
    view[t * 4] = d.img.rgba[s * 4]!; view[t * 4 + 1] = d.img.rgba[s * 4 + 1]!; view[t * 4 + 2] = d.img.rgba[s * 4 + 2]!;
    const et = etotals[k], fl = feetLight[k];
    const tint = d.e.tint;
    if (tint && !Number.isNaN(d.img.pickKey?.[s] ?? NaN)) {
      // Tinte plano (Entity.tint): el vóxel, de ese color y con luz propia; el contorno (sin vóxel) se queda
      view[t * 4] = Math.round(tint[0] * 255); view[t * 4 + 1] = Math.round(tint[1] * 255); view[t * 4 + 2] = Math.round(tint[2] * 255);
      if (total) total.fill(EMISSIVE_LIGHT, t * 3, t * 3 + 3);
    } else if (total && et) { total[t * 3] = et[s * 3]!; total[t * 3 + 1] = et[s * 3 + 1]!; total[t * 3 + 2] = et[s * 3 + 2]!; }
    else if (total && fl) {
      if (emissiveMask(d)?.[s]) total.fill(EMISSIVE_LIGHT, t * 3, t * 3 + 3);
      else { total[t * 3] = fl[0]; total[t * 3 + 1] = fl[1]; total[t * 3 + 2] = fl[2]; }
    }
  }

  // El agua (tapa lo sumergido) y las gotas
  state.water?.draw(b, view, depthBuf, total, vx, vy, vw, vh, ambient, o.time, state.lights, o.detail !== 'bajo');
  const drop = dropLook(state, ambient);
  if (drop) state.drops.draw(b, view, depthBuf, total, vx, vy, vw, vh, drop.color, drop.light);
  return { view, total };
}

export const BACKGROUND = [13, 12, 18] as const;

// El color de las gotas (el tono claro del agua) y su luz
export function dropLook(state: WorldState, ambient: readonly [number, number, number]): { color: [number, number, number]; light: [number, number, number] } | null {
  const wr = state.palette.ramps.find((r) => r.name === 'agua');
  return wr ? { color: rgbOf(wr.colors[4] ?? wr.colors[0]!), light: [ambient[0] * 1.7, ambient[1] * 1.7, ambient[2] * 1.8] } : null;
}

// Las entidades que dan sombra de verdad (con su cuerpo) en un cuadro: como mucho MAX_CASTERS. Primero las de
// castsShadow 'always' (el personaje), y el resto de los huecos, las true de pies más cercanos al centro de la vista;
// las demás solo llevan la de contacto. En el orden de la lista de entidades.
export const MAX_CASTERS = 8;
export function shadowCasters(state: WorldState, b: Baked, o: Frame2DOptions): Entity[] {
  const cx = o.vx + o.vw / 2, cy = o.vy + o.vh / 2;
  const cand = state.entities.map((e, i) => {
    const [sx, sy] = b.cam.project(Math.round(e.x) + 0.5, Math.round(e.y), e.z);
    return { e, i, d: (sx - cx) ** 2 + (sy - cy) ** 2 };
  }).filter((c) => c.e.castsShadow);
  if (cand.length <= MAX_CASTERS) return cand.map((c) => c.e);
  const rank = (c: typeof cand[number]) => (c.e.castsShadow === 'always' ? 0 : 1);
  return cand.sort((a, c) => rank(a) - rank(c) || a.d - c.d || a.i - c.i).slice(0, MAX_CASTERS).sort((a, c) => a.i - c.i).map((c) => c.e);
}

// Lo que hace falta para pintar una entidad: su render (de la caché), dónde cae su lienzo en la imagen horneada,
// cuánto se suma a su profundidad y su sombra de contacto (centro y radio vertical). Lo comparten la CPU y la GPU.
export interface EntitySprite {
  e: Entity;
  img: Rendered;
  key: string;                   // qué render es (modelo y giro): la GPU lo usa para su atlas
  offX: number; offY: number; dOff: number;
  fx: number; fy: number; sry: number;
  X: number; Y: number; Z: number; bob: number;
  ro: ReturnType<typeof entityRenderOptions>;
}
// Lo de antes más su luz por píxel (null sin luces), calculada en la CPU
export interface EntityDraw extends EntitySprite { etotal: Float32Array | null }

const spriteIds = new WeakMap<object, number>();
let nextSpriteId = 1;

// Una entidad del mundo con la misma cámara que el escenario. Su profundidad se pasa a la del mundo.
export function entitySprite(b: Baked, e: Entity, o: Frame2DOptions): EntitySprite {
  const a = b.options.oblique?.y ?? 1;
  const X = Math.round(e.x), Y = Math.round(e.y), Z = e.z;
  const bob = o.bob ? o.bob(e) : 0;
  // Sombra de contacto bajo los pies (la de las luces la hace castShadow con el cuerpo de verdad)
  const feet = b.cam.project(X + 0.5, Y, Z);
  const fx = Math.floor(feet[0]), fy = Math.floor(feet[1]);
  const sry = Math.max(1.2, 2.5 * a);
  const lo = entityRenderOptions(b, e, o);
  let cache = entityCache.get(e.model);
  if (!cache) entityCache.set(e.model, (cache = new Map()));
  const ck = `${e.yaw}|${lo.oblique.y}|${lo.oblique.z}|${lo.pick}|${lo.outline}|${o.outlineColor ?? ''}`;
  let img = cache.get(ck);
  if (!img) { img = withOutlineDepth(render(e.model, lo)); cache.set(ck, img); }
  let mid = spriteIds.get(e.model);
  if (!mid) spriteIds.set(e.model, (mid = nextSpriteId++));
  cacheTouch(e.model, ck, `${mid}|${ck}`);
  const offX = X - EOX, offY = Math.round(b.options.originY - a * Y - Z) - EOY - bob;
  const dOff = Y * b.cam.fwd[1] + Z * b.cam.fwd[2];
  return { e, img, key: `${mid}|${ck}`, offX, offY, dOff, fx, fy, sry, X, Y, Z, bob, ro: lo };
}

// Para precalentar (Compositor.prewarm): una entidad de paso con ese modelo y giro, en el origen. Sus campos de
// mundo no cuentan para el sprite (solo el modelo, el giro y la proyección).
export const HEADINGS = [0, 45, 90, 135, 180, 225, 270, 315] as const;
export function warmEntity(model: VoxelSource, yaw: number): Entity {
  return { id: -1, modelId: -1, model, x: 0, y: 0, z: 0, yaw, castsShadow: false, rampOffset: 0 };
}

function entityRenderOptions(b: Baked, e: Entity, o: Frame2DOptions) {
  return { width: EW, height: EH, originX: EOX, originY: EOY, pivot: [0.5, 0, 0] as [number, number, number], yaw: e.yaw,
    oblique: b.options.oblique ?? { y: 1, z: 1 }, flat: true, outline: o.outline ?? 'none', ...(o.outlineColor ? { outlineColor: o.outlineColor } : {}), pick: o.lights };
}

// ¿Cae algo de su lienzo (o de su sombra de contacto) en la vista?
export function onView(d: EntitySprite, o: Frame2DOptions): boolean {
  return d.offX + EW > o.vx && d.offX < o.vx + o.vw && d.offY + EH > o.vy && d.offY < o.vy + o.vh + 8;
}

// La luz por píxel de una entidad, iluminada por cara con las fuentes del mundo (en los ejes de su modelo, sin girar)
// Las luces del mundo en los ejes del modelo de una entidad (sin girar), con su índice en state.lights
function entityLocalLights(state: WorldState, d: EntitySprite, o: Frame2DOptions): Array<PointLight3D & { index: number }> {
  const { e, X, Y, Z, bob } = d;
  const c = Math.cos((e.yaw * Math.PI) / 180), sn = Math.sin((e.yaw * Math.PI) / 180);
  return state.lights.map((l, index) => {
    const p = resolveLight(l, o.time);
    const dx = l.x - (X + 0.5), dy = l.y - Y;
    // el cono del foco, girado a los ejes del modelo igual que la posición
    const spot = p.spot && { ...p.spot, dir: [p.spot.dir[0] * c + p.spot.dir[1] * sn, -p.spot.dir[0] * sn + p.spot.dir[1] * c, p.spot.dir[2]] as [number, number, number] };
    return { index, x: dx * c + dy * sn + 0.5, y: -dx * sn + dy * c, z: l.z - bob - Z, radius: p.radius, color: p.color, intensity: p.intensity, spot };
  });
}

// Qué luces alumbran a una entidad, con tope: las N que mejor la alcanzan (menor distancia menos radio; en un empate,
// la primera). Devuelve sus índices en state.lights, o null si no hay tope. La GPU recibe lo mismo como máscara por
// entidad, así las dos rutas eligen igual. `radii`: el radio de cada luz, calculado una vez por cuadro (con una
// multitud, resolver las luces por entidad costaba más que dibujarlas).
export function entityLightPick(state: WorldState, d: EntitySprite, o: Frame2DOptions, radii?: readonly number[]): number[] | null {
  const cap = o.entityLightCap;
  if (cap === undefined) return null;
  const ex = d.X + 0.5, ey = d.Y, ez = d.Z + d.bob;
  const best: number[] = [], score: number[] = [];
  const lights = state.lights;
  for (let i = 0; i < lights.length; i++) {
    const l = lights[i]!;
    const dx = l.x - ex, dy = l.y - ey, dz = l.z - ez;
    const m = Math.sqrt(dx * dx + dy * dy + dz * dz) - (radii ? radii[i]! : resolveLight(l, o.time).radius);
    // insertar en orden (son pocas)
    let k = best.length;
    while (k > 0 && score[k - 1]! > m) k--;
    if (k >= cap) continue;
    best.splice(k, 0, i); score.splice(k, 0, m);
    if (best.length > cap) { best.pop(); score.pop(); }
  }
  return best.sort((a, b) => a - b);
}

export function entityLight(state: WorldState, d: EntitySprite, o: Frame2DOptions): Float32Array {
  const pick = entityLightPick(state, d, o);
  const lights: PointLight3D[] = entityLocalLights(state, d, o)
    .filter((l) => Math.hypot(l.x, l.y) < l.radius + 20 && (!pick || pick.includes(l.index)));
  const { e } = d;
  const total = lightField3D(e.model, d.img, camera(d.ro), lights, o.ambient, { floor: false });
  // Lo emisivo lleva su propia luz: se ve con su color, sin que la luz del mundo lo oscurezca
  const em = emissiveMask(d);
  if (em) for (let i = 0; i < em.length; i++) if (em[i]) total.fill(EMISSIVE_LIGHT, i * 3, i * 3 + 3);
  return total;
}

// Qué píxeles del render de una entidad son de una rampa emisiva (null si no tiene ninguna). Lo usa también la GPU.
export const EMISSIVE_LIGHT = 1;
const emissiveCache = new WeakMap<Rendered, Uint8Array | null>();
export function emissiveMask(d: EntitySprite): Uint8Array | null {
  const { img } = d, m = d.e.model;
  if (emissiveCache.has(img)) return emissiveCache.get(img)!;
  let mask: Uint8Array | null = null;
  if (img.pickKey && m.palette.ramps.some((r) => r.emissive)) {
    mask = new Uint8Array(img.width * img.height);
    for (let i = 0; i < mask.length; i++) {
      const k = img.pickKey[i]!;
      if (Number.isNaN(k)) continue;
      const [x, y, z] = unkey(k);
      const v = m.get(x, y, z);
      if (v && m.palette.ramps[Math.floor((v - 1) / 16)]?.emissive) mask[i] = 1;
    }
  }
  emissiveCache.set(img, mask);
  return mask;
}

export function entityDraw(state: WorldState, b: Baked, e: Entity, o: Frame2DOptions): EntityDraw {
  const d = entitySprite(b, e, o);
  return { ...d, etotal: o.lights ? entityLight(state, d, o) : null };
}

// El contorno exterior se pinta en píxeles vacíos, sin profundidad (Infinity): la prueba de profundidad lo
// descartaría. Toma la de su vecino más cercano a la cámara, así tapa y lo tapan como el borde de la figura.
function withOutlineDepth(img: Rendered): Rendered {
  const { width: W, height: H, rgba, depth } = img;
  const d = depth.slice();
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i;
    if (!rgba[k * 4 + 3] || depth[k] !== Infinity) continue;
    let best = Infinity;
    for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]] as const) {
      const ni = i + di, nj = j + dj;
      if (ni >= 0 && nj >= 0 && ni < W && nj < H) best = Math.min(best, depth[nj * W + ni]!);
    }
    d[k] = best;
  }
  return { ...img, depth: d };
}

// El z-buffer de las entidades: su profundidad pasada a [0, 1] con el rango de las de este cuadro. La GPU guarda
// exactamente este valor (float32) y la CPU compara por él, así desempatan igual.
export function entityDepthRange(sprites: readonly EntitySprite[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const d of sprites) { const r = spriteDepthRange(d.img); lo = Math.min(lo, r[0] + d.dOff); hi = Math.max(hi, r[1] + d.dOff); }
  if (lo === Infinity) return [0, 1];
  return [Math.fround(lo - 1), Math.fround(1 / Math.max(1e-3, hi - lo + 2))];
}
export function entityDepthKey(depth: number, [base, scale]: [number, number]): number {
  return Math.min(1, Math.max(0, Math.fround(Math.fround(depth - base) * scale)));
}
const depthRanges = new WeakMap<Rendered, [number, number]>();
function spriteDepthRange(img: Rendered): [number, number] {
  let r = depthRanges.get(img);
  if (!r) {
    let lo = Infinity, hi = -Infinity;
    for (const d of img.depth) if (d !== Infinity) { lo = Math.min(lo, d); hi = Math.max(hi, d); }
    r = lo === Infinity ? [0, 0] : [lo, hi];
    depthRanges.set(img, r);
  }
  return r;
}

// Sombra de contacto bajo los pies: oscurece la luz del suelo en una elipse
function contactShadow(d: EntitySprite, total: Float32Array, o: Frame2DOptions): void {
  const { vx, vy, vw, vh } = o;
  const { fx, fy, sry } = d;
  for (let y = -Math.ceil(sry); y <= Math.ceil(sry); y++) for (let x = -6; x <= 6; x++) {
    if ((x / 6.5) ** 2 + (y / sry) ** 2 > 1) continue;
    const sx = fx - vx + x, sy = fy - vy + y;
    if (sx < 0 || sy < 0 || sx >= vw || sy >= vh) continue;
    const q = (sy * vw + sx) * 3;
    total[q] = total[q]! * 0.7; total[q + 1] = total[q + 1]! * 0.7; total[q + 2] = total[q + 2]! * 0.72;
  }
}

// ---- luces dinámicas y sombras de entidades (sobre la imagen horneada: cada píxel sabe qué punto del mundo es y
// qué cara se ve)

const facing = (ndl: number) => (ndl > 0 ? 0.35 + 0.65 * ndl : 0);

// Aportación (color * peso) de una luz en el punto P con normal n, sin sombras. La misma fórmula que el horneado.
function contribution(l: { x: number; y: number; z: number; radius: number; intensity: number; spot: Spot | null }, P: [number, number, number], n: readonly number[]): number {
  const dx = l.x - P[0], dy = l.y - P[1], dz = l.z - P[2];
  const d = Math.hypot(dx, dy, dz);
  if (d >= l.radius) return 0;
  const k = 1 - d / l.radius;
  return k * k * l.intensity * (d < 1e-6 ? 1 : facing((n[0]! * dx + n[1]! * dy + n[2]! * dz) / d)) * spotFactor(l.spot, -dx, -dy, -dz);
}

// Recuadro de la vista que puede tocar una esfera de radio r alrededor de (x, y, z)
export function screenBox(b: Baked, x: number, y: number, z: number, r: number, o: Frame2DOptions): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const dx of [-r, r]) for (const dy of [-r, r]) for (const zz of [-10, z + r]) {
    const [sx, sy] = b.cam.project(x + dx, y + dy, zz);
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const ix0 = Math.max(o.vx, Math.floor(x0)), iy0 = Math.max(o.vy, Math.floor(y0));
  const ix1 = Math.min(o.vx + o.vw - 1, Math.ceil(x1)), iy1 = Math.min(o.vy + o.vh - 1, Math.ceil(y1));
  return ix0 > ix1 || iy0 > iy1 ? null : [ix0, iy0, ix1, iy1];
}

function addDynamicLight(b: Baked, l: WorldLight, total: Float32Array, o: Frame2DOptions): void {
  const p = resolveLight(l, o.time);
  const box = screenBox(b, l.x, l.y, l.z, p.radius, o);
  if (!box) return;
  const [x0, y0, x1, y1] = box;
  // Sin asignaciones por píxel (con una multitud llevando luces, esto corre millones de veces): el punto del mundo de
  // worldPointAt y la aportación de contribution, en línea y con la misma aritmética, y fuera del radio se descarta
  // antes de la raíz
  const a = b.options.oblique?.y ?? 1, f1 = b.cam.fwd[1], f2 = b.cam.fwd[2], O = b.options.originY, den = a * f2 - f1;
  const r = p.radius, r2 = r * r, [cr, cg, cb] = p.color;
  for (let sy = y0; sy <= y1; sy++) {
    const P = O - (sy + 0.5);
    for (let sx = x0; sx <= x1; sx++) {
      const idx = sy * b.width + sx;
      const f = b.face[idx]!;
      if (f < 0) continue;
      const d = b.depth[idx]!;
      if (d === Infinity) continue;
      const wy = (P * f2 - d) / den, wz = P - a * wy;
      const dx = l.x - sx, dy = l.y - wy, dz = l.z - wz;
      const dd = dx * dx + dy * dy + dz * dz;
      if (dd >= r2) continue;
      // contribution(), en línea
      const dist = Math.hypot(dx, dy, dz), n = DIR_VECTORS[f]!, k = 1 - dist / r;
      const w = k * k * p.intensity * (dist < 1e-6 ? 1 : facing((n[0] * dx + n[1] * dy + n[2] * dz) / dist)) * (p.spot ? spotFactor(p.spot, -dx, -dy, -dz) : 1);
      if (!w) continue;
      const q = ((sy - o.vy) * o.vw + (sx - o.vx)) * 3;
      total[q] = total[q]! + cr * w; total[q + 1] = total[q + 1]! + cg * w; total[q + 2] = total[q + 2]! + cb * w;
    }
  }
}

// El cuerpo de una entidad como conjunto de vóxeles locales (girado al cuarto de vuelta más cercano) y su caja
const occCache = new WeakMap<VoxelSource, Map<number, { set: Set<number>; min: [number, number, number]; max: [number, number, number] }>>();
export function occupancy(model: VoxelSource, yaw: number) {
  const turns = ((Math.round(yaw / 90) % 4) + 4) % 4;
  let m = occCache.get(model);
  if (!m) occCache.set(model, (m = new Map()));
  let o = m.get(turns);
  if (!o) {
    const c = [1, 0, -1, 0][turns]!, s = [0, 1, 0, -1][turns]!;
    const set = new Set<number>();
    const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const [x, y, z] of model.entries()) {
      const rx = x * c - y * s, ry = x * s + y * c;
      set.add(key(rx, ry, z));
      min[0] = Math.min(min[0], rx); min[1] = Math.min(min[1], ry); min[2] = Math.min(min[2], z);
      max[0] = Math.max(max[0], rx + 1); max[1] = Math.max(max[1], ry + 1); max[2] = Math.max(max[2], z + 1);
    }
    m.set(turns, (o = { set, min, max }));
  }
  return o;
}

// Desempate: con entradas enteras, la muestra cae a menudo justo en el borde de un vóxel, y entonces el redondeo
// decide de qué lado (y la GPU, en float32, redondea distinto). Se mide un poco más allá, igual en las dos.
export const TIE = 1 / 1024;

// ¿El segmento de P a la luz L (en coordenadas locales de la entidad) cruza un vóxel de su cuerpo?
function blockedByBody(occ: ReturnType<typeof occupancy>, P: [number, number, number], L: [number, number, number]): boolean {
  // Recorte a la caja (método de las losas)
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = L[i]! - P[i]!;
    if (Math.abs(d) < 1e-9) { if (P[i]! < occ.min[i]! || P[i]! > occ.max[i]!) return false; continue; }
    let a = (occ.min[i]! - P[i]!) / d, b = (occ.max[i]! - P[i]!) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  // Pasos de medio vóxel dentro de la caja
  const len = Math.hypot(L[0] - P[0], L[1] - P[1], L[2] - P[2]) * (t1 - t0);
  const steps = Math.max(1, Math.ceil(len * 2));
  for (let k = 0; k <= steps; k++) {
    const t = t0 + ((t1 - t0) * k) / steps;
    const x = P[0] + (L[0] - P[0]) * t + TIE, y = P[1] + (L[1] - P[1]) * t + TIE, z = P[2] + (L[2] - P[2]) * t + TIE;
    if (occ.set.has(key(Math.floor(x), Math.floor(y), Math.floor(z)))) return true;
  }
  return false;
}

export const SHADOW_REACH = 48;     // hasta dónde se busca sombra alrededor de la entidad (en planta)

function castShadow(state: WorldState, b: Baked, e: Entity, total: Float32Array, o: Frame2DOptions): void {
  const occ = occupancy(e.model, e.yaw);
  const ex = Math.round(e.x), ey = Math.round(e.y), ez = e.z;
  // Las luces que llegan a la zona de la entidad
  // Las luces que llegan a la zona de la entidad, menos las que lleva ella (su cuerpo no les hace sombra)
  const near = state.lights.filter((l) => l.owner !== e.id && Math.hypot(l.x - ex, l.y - ey) < resolveLight(l, 0).radius + SHADOW_REACH);
  if (!near.length) return;
  const box = screenBox(b, ex, ey, ez, SHADOW_REACH, o);
  if (!box) return;
  const baked = new Map(b.lights.map((bl) => [bl.light.id, bl] as const));
  const [x0, y0, x1, y1] = box;
  for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
    const f = b.face[sy * b.width + sx]!;
    if (f < 0) continue;
    const P = worldPointAt(b, sx, sy);
    if (!P || Math.abs(P[0] - ex) > SHADOW_REACH || Math.abs(P[1] - ey) > SHADOW_REACH) continue;
    const n = DIR_VECTORS[f]!;
    // En los ejes de la entidad (sus pies en el origen; el cuerpo ya está girado en `occ`)
    const Pl: [number, number, number] = [P[0] + n[0] * 0.05 - ex, P[1] + n[1] * 0.05 - ey, P[2] + n[2] * 0.05 - ez];
    const q = ((sy - o.vy) * o.vw + (sx - o.vx)) * 3;
    for (const l of near) {
      if (!blockedByBody(occ, Pl, [l.x - ex, l.y - ey, l.z - ez])) continue;
      // Quitar lo que esta luz aportaba aquí
      const p = resolveLight(l, o.time);
      let w = 0;
      const bl = baked.get(l.id);
      if (bl) {
        const r = bl.rect, lx = sx - r.x, ly = sy - r.y;
        if (lx >= 0 && ly >= 0 && lx < r.w && ly < r.h) w = bl.weight[ly * r.w + lx]! * (p.intensity / bl.intensity);
      } else w = contribution(p, P, n);
      if (!w) continue;
      total[q] = Math.max(0, total[q]! - p.color[0] * w);
      total[q + 1] = Math.max(0, total[q + 1]! - p.color[1] * w);
      total[q + 2] = Math.max(0, total[q + 2]! - p.color[2] * w);
    }
  }
}
