// Horneado de un mundo de vóxeles para jugarlo en 2D: se renderiza (imagen + profundidad + qué vóxel y qué cara hay
// en cada píxel) y, por cada luz fija, su peso en cada píxel de su zona, con la caída del juego, el ángulo con la
// cara y la sombra de los propios vóxeles. Por cuadro solo queda sumar las luces con su parpadeo (lightView).
//
// Si cambian vóxeles a mitad de partida, rebake() rehace SOLO lo afectado: el recuadro de pantalla de los trozos
// cambiados, la rejilla de sombras de esas columnas y los pesos de las luces que los alcanzan. El resultado es el
// mismo, byte a byte, que hornear el mundo entero de nuevo (hay prueba).
import { render, camera, key, unkey, KEY_OFF, KEY_SPAN, decode, DIR_VECTORS, facingOf, materialsOf, frontFaces, type RenderOptions, type Camera, type VoxelSource } from '../core';
import { resolveLight } from './lightutil';
import { CHUNK, type StaticVoxels, type FaceSet } from './state';
import type { Box3 } from './changes';
import type { WorldLight } from './build';
import type { LightId } from './state';

// Lo que lleva un trabajo de luz: las cajas cambiadas, los píxeles que cambiaron de cara (de cada rehorneado que se
// le sumó) y a qué recuadros espera
export interface LightWork { plans: Plan[]; pixels: Array<() => Int32Array>; waits: Array<() => boolean>; started: boolean }

export interface BakedLight {
  light: WorldLight;
  color: readonly [number, number, number];
  intensity: number;
  rect: { x: number; y: number; w: number; h: number };   // zona de la imagen donde alumbra
  weight: Float32Array;                                    // peso por píxel de la zona (con la intensidad base)
  // Si se rehízo solo en parte sobre los pesos de otra (el rehorneado de lo cambiado): esa (base), y el recuadro de la
  // zona que pudo cambiar (dirty, relativo a rect). Quien guarda una copia de la base solo tiene que poner al día ese
  // recuadro (la GPU); de cualquier otra, la zona entera
  base?: BakedLight;
  dirty?: { x: number; y: number; w: number; h: number };
}

export interface Baked {
  width: number;
  height: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
  depth: Float32Array;
  face: Int8Array;              // qué cara se ve en cada píxel (índice en DIR_VECTORS; -1 = nada)
  pick: Float64Array;           // qué vóxel se ve en cada píxel (clave; NaN = nada)
  options: RenderOptions;
  cam: Camera;
  lights: BakedLight[];
  version: number;              // versión del mundo horneada (para rebakeChanged)
  ms: { render: number; light: number };
  // Para rehornear: el mundo, su rejilla de sombras y el alto máximo
  source: StaticVoxels;
  occ: Uint8Array;              // OBSOLETO, vacío: las sombras leen los vóxeles (source) directamente
  topZ: number;
  // Lo que se ha publicado desde el horneado (para quien guarda una copia, p. ej. las texturas de la GPU): cada
  // recuadro rehorneado con su número de serie. Solo se guardan los últimos; quien se quede atrás lo recarga todo.
  // (sky: true en lo que solo cambió el cielo, no la cara ni el vóxel de los píxeles)
  published: { serial: number; rects: Array<{ serial: number; x0: number; y0: number; x1: number; y1: number; sky?: true }>;
    // Lo que se olvidó de rects (más de PUBLISHED_KEEP): por tandas de PUBLISHED_KEEP, el recuadro que las une y sus
    // seriales [from, to]; como mucho FORGOTTEN_KEEP tandas (publishedSince)
    forgotten?: Array<{ from: number; to: number; x0: number; y0: number; x1: number; y1: number; sky: boolean }> };
  // Las fijas nuevas que se están horneando (rebakeJobs): no se vuelven a pedir, y si se quitan antes de acabar, su
  // trabajo no las publica
  pendingLights?: Set<LightId>;
  // Por luz, el trabajo parcial que está en la cola y aún no ha empezado: los cambios nuevos se le suman (no se crea
  // otro, ni se sustituye: uno sustituido perdería los cambios que llevaba)
  lightWork?: Map<LightId, LightWork>;
  // Las fijas que ya no están (quitadas): un trabajo suyo que quede en la cola no las vuelve a publicar
  goneLights?: Set<LightId>;
  // Los recuadros en marcha, por key (con la ficha del último trabajo que la usa: uno nuevo con la misma key sustituye
  // al viejo en la cola). Las luces y el cielo esperan a que no quede en marcha ninguno de los suyos
  rectsBusy?: Map<string, object>;
  // Quien pinta los recuadros fuera (un worker con su copia de los vóxeles). ask(rect) da un
  // vale (o null: se pinta aquí) y result() el recuadro cuando llega; se publica si ningún trozo suyo cambió desde que se
  // pidió, y si no, se pinta aquí
  remote?: RemoteRects;
  // (para el banco: recuadros publicados de fuera, pintados aquí por haber cambiado mientras, y pintados aquí sin pedirse)
  // (para medir) el cielo del rehorneado: trabajos creados, píxeles calculados (con los rehechos), veces rehecho por un
  // recuadro publicado encima o por vóxeles que cambiaron, y píxeles publicados
  skyStats?: { jobs: number; pixels: number; restartPub: number; restartVox: number; published: number; ms: number };
  remoteStats?: { published: number; stale: number; local: number; localMs: number };
  // El rehorneado que está en la cola sin publicar (recuadros, cielo y luces), con las cajas de lo que rehace; y el número
  // de tanda: al correrse la ventana (shiftBakedJob), lo de la cola se descarta (cancelRebakes: sus trabajos acaban sin
  // hacer nada) y sus trozos se vuelven a marcar como cambiados ya corridos. Antes el cambio esperaba a que se vaciara
  // toda la cola, y a 60 cuadros por segundo eso tardaba más que cruzar un trozo
  pendingPlans?: Map<object, Plan[]>;
  rebakeEpoch?: number;
  // Con { sky: true }: cuánto cielo ve la cara de cada píxel, de 0 a SKY_RAYS (los rayos que llegan arriba). Al
  // componer, con Frame2DOptions.cave, la luz ambiente va de la de cueva (0) a la de siempre (todo el cielo)
  sky?: Uint8Array;
  // Falta preparar lo expuesto (las máscaras de StaticVoxels.forEachExposed): el horneado inicial no las hace (le
  // costaba ~70 %), y la primera rebakeChangedJobs devuelve un trabajo que las hace detrás de todo
  exposurePending?: boolean;
  // Cuántas veces se corrió la ventana (shiftBaked): quien guarde algo en coordenadas de la imagen lo tira al cambiar
  shifts?: number;
  // El último corrimiento: con el número de serie que dejó publicado, cuánto se corrió la imagen (píxel nuevo (x, y) =
  // viejo (x + dx, y - rows)) y lo que se restó a la profundidad (dd) y a la y del mundo (dy). Una copia que estaba al
  // día justo antes (serial - 2) puede correrse igual y subir solo los recuadros publicados con él (lo borrado)
  lastShift?: { serial: number; dx: number; rows: number; dd: number; dy: number };
  // Entre que se corren los vóxeles y se cambia la imagen (shiftBakedJob, dos cuadros): lo que escribe en la imagen espera
  shiftHold?: boolean;
  // Mientras se prepara un corrimiento (shiftBakedJob): las copias pueden ir preparando lo suyo (la GPU, sus texturas)
  shifting?: boolean;
}

// Lo mínimo que necesita el horneado de un mundo
export interface Bakeable {
  model: StaticVoxels;
  lights: readonly WorldLight[];
  width: number;
  depth: number;
}

const BASIN_DEPTH = 10;   // las cuencas del agua bajan hasta z = -8: la imagen se alarga por abajo

// Proyección oblicua 3/4: la altura sube 1:1 y el suelo se acorta por `incline` (1 = sin acortar, como los tiles
// del juego; 0.5 = losetas de 16x8, que deja ver a los personajes de frente con un poco de cabeza). Personajes y
// escenario usan la MISMA proyección. La imagen tiene el norte arriba.
// outline: el contorno del render ('both' marca también los saltos de profundidad: paredes, columnas)
// warmExposure (true por defecto): después, la primera rebakeChangedJobs devuelve un trabajo que prepara lo expuesto de
// todo el mundo (ver exposureJob). false, sin él (quien no rehornea por cambios no lo necesita)
export function bakeWorld(world: Bakeable, opts: { topZ?: number; incline?: number; outline?: 'none' | 'outer' | 'both'; outlineColor?: string; sky?: boolean; warmExposure?: boolean } = {}): Baked {
  const topZ = opts.topZ ?? 40;
  const incline = opts.incline ?? 0.5;
  const originY = Math.ceil(world.depth * incline) + topZ;
  const options: RenderOptions = {
    width: world.width + 2, height: originY + 2 + BASIN_DEPTH, originX: 0, originY,
    yaw: 0, oblique: { y: incline, z: 1 }, pivot: [0, 0, 0], smooth: 0, shadows: false, ao: true, outline: opts.outline ?? 'none', ...(opts.outlineColor ? { outlineColor: opts.outlineColor } : {}), pick: true,
  };
  const t0 = performance.now();
  // Todo el mundo una vez: sin hacer las máscaras de lo expuesto de todas las losas (ver forEachExposed)
  const m = world.model;
  const img = render({ palette: m.palette, get: (x, y, z) => m.get(x, y, z), entries: () => m.entries(), forEachExposed: (fn) => m.forEachExposed(fn, undefined, false) }, options);
  const t1 = performance.now();
  const b: Baked = {
    width: img.width, height: img.height, rgba: img.rgba, depth: img.depth, face: img.pickFace!, pick: img.pickKey!,
    options, cam: camera(options), lights: [], version: cutVersion(world.model), ms: { render: Math.round(t1 - t0), light: 0 },
    source: world.model, occ: new Uint8Array(0), topZ,
    published: { serial: 0, rects: [] },
  };
  for (const l of world.lights) {
    if (l.baked === false) continue;                 // las dinámicas no se hornean: se suman cada cuadro
    const bl = lightWeights(b, l);
    if (bl) b.lights.push(bl);
  }
  b.ms.light = Math.round(performance.now() - t1);
  if (opts.sky) { b.sky = new Uint8Array(b.width * b.height); fillSky(b, 0, 0, b.width - 1, b.height - 1); }
  warmUp(b);
  if (opts.warmExposure !== false) b.exposurePending = true;
  return b;
}

// ---- el cielo: por píxel, cuántos de SKY_RAYS rayos que salen de su cara hacia arriba llegan al cielo: el vertical
// (con la rejilla de alturas: nada encima en la columna) y 4 en diagonal (subiendo 1 por cada vóxel de lado, en x e y)
// de SKY_REACH vóxeles; si no chocan en ese tramo, miran arriba desde donde acaban (llegan si ahí no hay nada encima:
// bajo un techo alto siguen a oscuras). Fuera del mundo, cielo. Así lo que cambia el cielo de un píxel está a
// SKY_REACH de su columna, como mucho, y se puede rehacer por caja
export const SKY_RAYS = 5;
export const SKY_REACH = 8;
const SKY_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
function skyOf(b: Baked, idx: number): number {
  const k = b.pick[idx]!;
  if (Number.isNaN(k)) return SKY_RAYS;
  const s = b.source, f = b.face[idx]!, n = DIR_VECTORS[f]!;
  const vz = (k % KEY_SPAN) - KEY_OFF, rr = Math.floor(k / KEY_SPAN), vy = (rr % KEY_SPAN) - KEY_OFF, vx = Math.floor(rr / KEY_SPAN) - KEY_OFF;
  const cx = vx + n[0], cy = vy + n[1], cz = vz + n[2];
  let open = 0;
  if (cx < 0 || cy < 0 || cx >= s.width || cy >= s.depth || s.height[cy * s.width + cx]! <= cz) open++;
  for (const [dx, dy] of SKY_DIRS) {
    let sky = true;
    for (let t = 1; t <= SKY_REACH; t++) {
      const x = cx + dx * t, y = cy + dy * t, z = cz + t;
      if (x < 0 || y < 0 || x >= s.width || y >= s.depth || z > s.zMax) break;
      if (s.get(x, y, z)) { sky = false; break; }
      if (t === SKY_REACH && s.height[y * s.width + x]! > z) sky = false;   // al final del tramo, algo encima
    }
    if (sky) open++;
  }
  return open;
}
function fillSky(b: Baked, x0: number, y0: number, x1: number, y1: number): void {
  const out = b.sky!;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * b.width + x; out[i] = skyOf(b, i); }
}
// Lo que alcanza un cambio en la caja p: las caras de las columnas a SKY_REACH (y la de al lado) por debajo de ella
function skyRect(b: Baked, p: Plan): ScreenRect {
  const s = b.source, m = SKY_REACH + 1, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const X0 = Math.max(0, p.X0 - m), Y0 = Math.max(0, p.Y0 - m), X1 = Math.min(s.width - 1, p.X1 + m), Y1 = Math.min(s.depth - 1, p.Y1 + m);
  return {
    x0: Math.max(0, X0 - 1), x1: Math.min(b.width - 1, X1 + 2),
    y0: Math.max(0, Math.floor(O - a * (Y1 + 1) - (p.Z1 + 2)) - 1), y1: Math.min(b.height - 1, Math.ceil(O - a * Y0 - s.zMin) + 1 + BASIN_DEPTH),
  };
}
// La luz ambiente por nivel de cielo (0..SKY_RAYS), en float32: la misma tabla en la CPU y en la GPU
export function skyAmbient(ambient: readonly [number, number, number], cave: readonly [number, number, number]): Float32Array {
  const t = new Float32Array((SKY_RAYS + 1) * 3);
  for (let k = 0; k <= SKY_RAYS; k++) for (let c = 0; c < 3; c++) t[k * 3 + c] = cave[c]! + (ambient[c]! - cave[c]!) * (k / SKY_RAYS);
  return t;
}

// El horneado entero como un trabajo que se reanuda (ViewJob), para hornear sin congelar la vista: otro giro de la
// cámara, el nivel siguiente. Mientras el trabajo no acaba, `baked` está a medias y no se enseña; al acabar es el
// mismo, byte a byte, que el de bakeWorld (hay prueba). Lo que cambie en el mundo mientras tanto lo recoge después
// rebakeChangedJobs, como siempre: la versión horneada es la del principio.
export function bakeWorldJob(world: Bakeable, opts: Parameters<typeof bakeWorld>[1] = {}, key = 'bake'): { baked: Baked; job: ViewJob } {
  const topZ = opts.topZ ?? 40;
  const incline = opts.incline ?? 0.5;
  const originY = Math.ceil(world.depth * incline) + topZ;
  const options: RenderOptions = {
    width: world.width + 2, height: originY + 2 + BASIN_DEPTH, originX: 0, originY,
    yaw: 0, oblique: { y: incline, z: 1 }, pivot: [0, 0, 0], smooth: 0, shadows: false, ao: true, outline: opts.outline ?? 'none', ...(opts.outlineColor ? { outlineColor: opts.outlineColor } : {}), pick: true,
  };
  const W = options.width!, H = options.height!;
  const b: Baked = {
    width: W, height: H, rgba: new Uint8ClampedArray(W * H * 4), depth: new Float32Array(W * H), face: new Int8Array(W * H).fill(-1), pick: new Float64Array(W * H).fill(NaN),
    options, cam: camera(options), lights: [], version: cutVersion(world.model), ms: { render: 0, light: 0 },
    source: world.model, occ: new Uint8Array(0), topZ,
    published: { serial: 0, rects: [] },
    ...(opts.sky ? { sky: new Uint8Array(W * H) } : {}),
    ...(opts.warmExposure !== false ? { exposurePending: true } : {}),
  };
  let skyRow = opts.sky ? 0 : H;
  // La imagen se pinta por BALDOSAS (BAKE_BAND filas x las columnas que quepan), directamente en el horneado (nadie lo
  // ve todavía: no hace falta doble búfer), con el camino del rehorneado por recuadro (renderColumns): el mismo
  // resultado byte a byte que de una vez. Antes eran franjas de columnas con toda la altura: con un paso de 2 ms
  // cabían 1-2 columnas, y cada franja renderizaba además una columna de margen a cada lado (el contorno), así que
  // costaba 2-3 veces el horneado de una vez; y una columna entera no se podía partir (a 6x no cabía en 3 ms)
  const lights = world.lights.filter((l) => l.baked !== false);
  // Lo que cuesta cada columna de una banda: las caras al aire de su columna x de vóxeles (y la de al lado, que también
  // se mira) que pueden caer en las filas de la banda, contadas con las máscaras de lo expuesto. Se preparan por grupos
  // de BAKE_GROUP columnas (otra unidad: las máscaras hasta el plazo, y contar), y con lo medido en la banda (ms por
  // cara) cada baldosa se corta para que quepa en lo que queda del plazo de la llamada (entre BAKE_MIN_MS y
  // BAKE_STEP_MS). Antes se estimaba por el volumen de la columna, y donde hay mucha cara al aire en poco volumen (las
  // copas de los árboles) 1 de cada 20 baldosas costaba el doble de lo previsto
  const exposed = new Float64Array(W);
  let band = -1, R0 = 0, R1 = -1, ready = 0;
  const colCost = (c: number) => 1 + exposed[c]! + (c > 0 ? exposed[c - 1]! : 0);
  let rect: ScreenRect = { x0: 0, x1: W - 1, y0: 0, y1: -1 };
  let buf: RectBuffers | null = null;
  const nextBand = (): boolean => {
    band++;
    R0 = band * BAKE_BAND; R1 = Math.min(H - 1, R0 + BAKE_BAND - 1);
    if (R0 >= H) return false;
    rect = { x0: 0, x1: W - 1, y0: R0, y1: R1 };
    const o = R0 * W, n = (R1 - R0 + 1) * W;
    buf = { rgba: b.rgba.subarray(o * 4, (o + n) * 4), depth: b.depth.subarray(o, o + n), face: b.face.subarray(o, o + n), pick: b.pick.subarray(o, o + n), w: W, h: R1 - R0 + 1 };
    col = 0; ready = 0; msPerFace = -1;
    exposed.fill(0);
    return true;
  };
  // Lo que cuesta cada fila del cielo: sus píxeles con algo (los de fondo no lanzan rayos)
  const rowCost = (y: number) => { let n = 1; for (let i = y * W, e = i + W; i < e; i++) if (!Number.isNaN(b.pick[i]!)) n++; return n; };
  let col = W, li = 0, cell = 0, msPerFace = -1, msPerCell = -1, msPerSkyPx = -1, imageDone = !nextBand();
  let zone: BakedLight | null | undefined;
  const job: ViewJob = {
    key,
    run(deadline) {
      do {
        const t = performance.now();
        // Cada unidad (una baldosa, unas filas de cielo, unos píxeles de luz) se corta, según lo medido de su clase, para
        // que quepa en lo que queda del plazo (entre BAKE_MIN_MS y BAKE_STEP_MS)
        const want = Math.min(BAKE_STEP_MS, Math.max(BAKE_MIN_MS, deadline - t));
        if (!imageDone && col >= ready) {
          // Preparar el grupo de columnas siguiente: sus máscaras (hasta el plazo; si no acaban, sigue en la llamada
          // siguiente; son las que haría después el trabajo exposure) y sus caras al aire por columna
          const g1 = Math.min(rect.x1, ready + BAKE_GROUP - 1);
          if (!warmStrip(b, rect, ready, g1, deadline)) continue;
          const { bands } = stripRegion(b, rect, ready, g1);
          for (const part of bands) b.source.forEachExposed((x) => { if (x >= ready && x <= g1) exposed[x]!++; }, { ...part, x0: Math.max(part.x0, ready), x1: Math.min(part.x1, g1) });
          ready = g1 + 1;
          b.ms.render += performance.now() - t;
        } else if (!imageDone) {
          // Una columna (la primera de cada banda, para medir), y las que quepan según lo medido en la banda
          let c1 = col, cost = colCost(col);
          if (msPerFace > 0) while (c1 < ready - 1 && (cost + colCost(c1 + 1)) * msPerFace <= want) cost += colCost(++c1);
          renderColumns(b, rect, buf!, col, c1);
          col = c1 + 1;
          const ms = performance.now() - t, rate = ms / cost;
          msPerFace = msPerFace < 0 ? rate : msPerFace * 0.7 + rate * 0.3;
          b.ms.render += ms;
          if (col > rect.x1) imageDone = !nextBand();
        } else if (skyRow < H) {
          // El cielo, por filas (lee la cara de cada píxel: después de la imagen): una fila (la primera, para medir), y las
          // que quepan según sus píxeles con algo. Por filas a secas, las de arriba (casi vacías) daban una medida que en
          // las de abajo se quedaba diez veces corta: tandas de 20-46 ms
          let y1 = skyRow, cost = rowCost(skyRow);
          if (msPerSkyPx > 0) for (let c = 0; y1 < H - 1 && (cost + (c = rowCost(y1 + 1))) * msPerSkyPx <= want; y1++) cost += c;
          fillSky(b, 0, skyRow, W - 1, y1);
          const rate = (performance.now() - t) / cost;
          msPerSkyPx = msPerSkyPx < 0 ? rate : msPerSkyPx * 0.7 + rate * 0.3;
          skyRow = y1 + 1;
        } else if (li < lights.length) {
          if (zone === undefined) { zone = lightZone(b, lights[li]!); cell = 0; msPerCell = -1; }
          const n = zone ? zone.rect.w * zone.rect.h : 0;
          if (zone && cell < n) {
            // Trozos de píxeles de la zona según lo que se va midiendo de esta luz (el primero, pequeño, para medir)
            const cells = msPerCell > 0 ? Math.max(4, Math.floor(want / msPerCell)) : 16;
            const c1 = Math.min(n, cell + cells);
            weightCells(b, zone, cell, c1);
            const rate = (performance.now() - t) / (c1 - cell);
            msPerCell = msPerCell < 0 ? rate : msPerCell * 0.7 + rate * 0.3;
            cell = c1;
          }
          if (!zone || cell >= n) { if (zone) b.lights.push(zone); zone = undefined; li++; }
          b.ms.light += performance.now() - t;
        }
        if (imageDone && skyRow >= H && li >= lights.length) {
          b.ms.render = Math.round(b.ms.render); b.ms.light = Math.round(b.ms.light);
          return true;
        }
        // Otra unidad en esta llamada solo si cabe al menos la más pequeña (si no, se pasaría del plazo)
      } while (performance.now() < deadline - BAKE_MIN_MS);
      return false;
    },
  };
  return { baked: b, job };
}
const BAKE_STEP_MS = 2;   // lo más que se busca que tarde cada unidad del horneado entero (menos si el plazo es menor)
const BAKE_MIN_MS = 0.25; // y lo menos (aunque el plazo ya haya pasado)
const BAKE_BAND = 16;     // filas de cada banda de baldosas
const BAKE_GROUP = 16;    // columnas que se preparan de una vez (máscaras y caras al aire)

// Calienta el camino del rehorneado (el JIT compila renderColumns al usarlo): si no, la primera vez que algo se
// rompe en la partida, sus primeras franjas cuestan 4-7 ms en vez de ~1. Se renderizan unas franjas de prueba en
// búferes de usar y tirar; no se publica nada.
function warmUp(b: Baked): void {
  const s = b.source;
  const c = Math.floor(s.rows / 2) * s.cols + Math.floor(s.cols / 2);
  const { rect } = chunkRect(b, [c]);
  const buf = rectBuffers(rect);
  for (let k = 0, col = rect.x0; k < 6 && col <= rect.x1; k++, col += RECT_BAND) renderColumns(b, rect, buf, col, Math.min(rect.x1, col + RECT_BAND - 1));
}

// La versión del mundo que se hornea; corta los tramos de cambios (StaticVoxels.cut) para que lo que cambie después
// tenga su caja aparte
function cutVersion(s: StaticVoxels): number {
  s.cut();
  return s.clock;
}

// ---- los rayos de sombra leen los vóxeles del mundo, en la franja de alturas de siempre (Z0 .. topZ + 1)
const gridZ = (topZ: number) => topZ + 2 + BASIN_DEPTH;
const Z0 = -BASIN_DEPTH;

// Cuánta luz llega de p a la luz: 0 tras algo opaco, y por cada vóxel que deja pasar luz, lo que deja pasar
// (MaterialProps.light de su rampa); 1 si no se cruza nada
function transmit(b: Baked, px: number, py: number, pz: number, lx: number, ly: number, lz: number): number {
  const src = b.source, zHi = Z0 + gridZ(b.topZ) - 1;
  // Lo normal (una luz por encima del terreno): el segmento pasa por encima de lo más alto de cada columna que cruza,
  // así que no toca ningún vóxel y llega entera. Se mira por columnas con la rejilla de alturas, mucho más corto
  if (overColumns(src, px, py, pz, lx, ly, lz)) return 1;
  const mt = materialsOf(src.palette);
  // 0 vacío, 1 opaco, 2 + rampa si deja pasar luz (follaje, vidrio: materials.ts)
  const cell = (x: number, y: number, z: number) => {
    if (z < Z0 || z > zHi) return 0;
    const v = src.get(x, y, z);
    return !v ? 0 : mt && mt.light[v] ? 2 + decode(v).ramp : 1;
  };
  let t = 1;
  const dx = lx - px, dy = ly - py, dz = lz - pz;
  let x = Math.floor(px), y = Math.floor(py), z = Math.floor(pz);
  const tx = Math.floor(lx), ty = Math.floor(ly), tz = Math.floor(lz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const ddx = sx ? Math.abs(1 / dx) : Infinity, ddy = sy ? Math.abs(1 / dy) : Infinity, ddz = sz ? Math.abs(1 / dz) : Infinity;
  let mx = sx ? (sx > 0 ? x + 1 - px : px - x) * ddx : Infinity;
  let my = sy ? (sy > 0 ? y + 1 - py : py - y) * ddy : Infinity;
  let mz = sz ? (sz > 0 ? z + 1 - pz : pz - z) * ddz : Infinity;
  for (let i = 0; i < 1024; i++) {
    if (x === tx && y === ty && z === tz) return t;
    if (mx <= my && mx <= mz) { if (mx > 1) return t; x += sx; mx += ddx; }
    else if (my <= mz) { if (my > 1) return t; y += sy; my += ddy; }
    else { if (mz > 1) return t; z += sz; mz += ddz; }
    if (x === tx && y === ty && z === tz) return t;
    const c = cell(x, y, z);
    if (c === 1) return 0;
    if (c >= 2) t *= mt!.light[(c - 2) * 16 + 1]!;
  }
  return t;
}

// ¿Va el segmento p -> l por encima de todos los vóxeles de las columnas que cruza? (la rejilla de alturas: la cara de
// arriba del más alto de cada columna). Si dice que sí, el segmento no toca ningún vóxel; si no, no se sabe
function overColumns(s: StaticVoxels, px: number, py: number, pz: number, lx: number, ly: number, lz: number): boolean {
  const H = s.height, W = s.width, D = s.depth;
  const dx = lx - px, dy = ly - py, dz = lz - pz;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  let x = Math.floor(px), y = Math.floor(py), t0 = 0;
  for (let i = 0; i < 4096; i++) {
    const tX = sx ? ((sx > 0 ? x + 1 : x) - px) / dx : Infinity, tY = sy ? ((sy > 0 ? y + 1 : y) - py) / dy : Infinity;
    const t1 = Math.min(tX, tY, 1);
    const zLow = pz + dz * (dz < 0 ? t1 : t0);
    // Estricto y con margen: rozar la arista de arriba de una columna lo cuenta el recorrido por vóxeles (un empate)
    if (x >= 0 && y >= 0 && x < W && y < D && zLow <= H[y * W + x]! + 1e-6) return false;
    if (t1 >= 1) return true;
    if (tX <= tY) x += sx; else y += sy;
    t0 = t1;
  }
  return false;
}

// ---- pesos de una luz fija: su zona de pantalla y el peso de cada píxel (por cara de vóxel, con sombras)
function lightWeights(b: Baked, l: WorldLight): BakedLight | null {
  const z = lightZone(b, l);
  if (!z) return null;
  const rows = weightRows(b, z, 0, z.rect.h);
  return rows;
}

function lightZone(b: Baked, l: WorldLight, weight?: Float32Array): BakedLight | null {
  const p = resolveLight(l, 0);
  const r = p.radius;
  // Zona de la imagen: la proyección de la caja que rodea la esfera de la luz
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const dx of [-r, r]) for (const dy of [-r, r]) for (const z of [Z0, Math.min(b.topZ, l.z + r)]) {
    const [sx, sy] = b.cam.project(l.x + dx, l.y + dy, z);
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const rx = Math.max(0, Math.floor(x0)), ry = Math.max(0, Math.floor(y0));
  const rect = { x: rx, y: ry, w: Math.min(b.width, Math.ceil(x1)) - rx, h: Math.min(b.height, Math.ceil(y1)) - ry };
  if (rect.w <= 0 || rect.h <= 0) return null;
  return { light: l, color: p.color, intensity: p.base, rect, weight: weight && weight.length === rect.w * rect.h ? weight : new Float32Array(rect.w * rect.h) };
}

// Calcula las filas [j0, j1) de los pesos de una zona (escribe en zone.weight). La caché por cara solo vale dentro de
// la llamada: el resultado no depende de cómo se trocee.
function weightRows(b: Baked, zone: BakedLight, j0: number, j1: number): BakedLight {
  return weightCells(b, zone, j0 * zone.rect.w, j1 * zone.rect.w);
}
// Lo mismo por píxeles de la zona en orden de lectura, [c0, c1): para trocear más fino que una fila
type CellFilter = (px: number, py: number, k: number, f: number) => boolean;

// ¿Alumbra igual? (los pesos viejos de una luz solo valen para la misma luz en el mismo sitio)
function sameLight(a: WorldLight, b: WorldLight): boolean {
  return a === b || (a.kind === b.kind && a.x === b.x && a.y === b.y && a.z === b.z && a.intensity === b.intensity && a.radius === b.radius &&
    String(a.color) === String(b.color) && String(a.dir) === String(b.dir) && a.cone === b.cone);
}

// Los píxeles (fuera de los que cambiaron de vóxel o de cara, que se rehacen siempre) cuyo peso de la luz l puede
// haber cambiado: los de un vóxel dentro de lo cambiado y los que miran a la luz por un segmento que lo cruza (el rayo
// de sombra, de transmit). Las cajas llevan ya el
// margen del rehorneado; aquí, 1 vóxel más para las celdas que el rayo pisa de lado
function touchedBy(l: WorldLight, plans: readonly Plan[]): CellFilter {
  return (_px, _py, k, f) => {
    if (Number.isNaN(k)) return false;
    // unkey sin crear nada (es por píxel)
    const vz = (k % KEY_SPAN) - KEY_OFF, rr = Math.floor(k / KEY_SPAN), vy = (rr % KEY_SPAN) - KEY_OFF, vx = Math.floor(rr / KEY_SPAN) - KEY_OFF;
    // El vóxel mismo dentro de lo cambiado (pudo cambiar su material: cuánta luz recibe por detrás)
    for (let q = 0; q < plans.length; q++) {
      const p = plans[q]!;
      if (vx >= p.X0 && vx <= p.X1 && vy >= p.Y0 && vy <= p.Y1 && vz >= p.Z0 && vz <= p.Z1) return true;
    }
    const n = DIR_VECTORS[f]!;
    const ox = vx + 0.5 + n[0], oy = vy + 0.5 + n[1], oz = vz + 0.5 + n[2];
    for (let q = 0; q < plans.length; q++) {
      const p = plans[q]!;
      if (segmentHitsBox(ox, oy, oz, l.x, l.y, l.z, p.X0 - 1, p.Y0 - 1, p.Z0 - 1, p.X1 + 2, p.Y1 + 2, p.Z1 + 2)) return true;
    }
    return false;
  };
}

// Las filas de pantalla de la sombra (su silueta convexa, no su recuadro), con 2 píxeles de margen en x y en y:
// [x0, x1, y] con x0..x1 incluidos
function shadowRows(b: Baked, l: WorldLight, r: number, p: Plan): Array<[number, number, number]> | 'all' | null {
  const pts = shadowHull(b, l, r, p);
  if (pts === null || pts === 'all') return pts;
  const hull = convexHull(pts), n = hull.length;
  let ya = Infinity, yb = -Infinity;
  for (const [, y] of hull) { ya = Math.min(ya, y); yb = Math.max(yb, y); }
  const Y0 = Math.floor(ya) - 2, Y1 = Math.ceil(yb) + 2;
  // El intervalo en x de la silueta en la franja de cada fila entera [y, y+1)
  const lo = new Float64Array(Y1 - Y0 + 1).fill(Infinity), hi = new Float64Array(Y1 - Y0 + 1).fill(-Infinity);
  const put = (x: number, y: number) => { const j = Math.floor(y) - Y0; if (j >= 0 && j < lo.length) { if (x < lo[j]!) lo[j] = x; if (x > hi[j]!) hi[j] = x; } };
  for (let i = 0; i < n; i++) {
    const [ax, ay] = hull[i]!, [bx, by] = hull[(i + 1) % n]!;
    put(ax, ay);
    const s0 = Math.min(ay, by), s1 = Math.max(ay, by);
    for (let y = Math.ceil(s0); y <= s1; y++) {                // donde el lado cruza una fila entera
      const t = by === ay ? 0 : (y - ay) / (by - ay), x = ax + (bx - ax) * t;
      put(x, y); put(x, y - 1);
    }
  }
  const rows: Array<[number, number, number]> = [];
  for (let j = 0; j < lo.length; j++) {
    let a = Infinity, c = -Infinity;
    for (let k = Math.max(0, j - 2); k <= Math.min(lo.length - 1, j + 2); k++) { a = Math.min(a, lo[k]!); c = Math.max(c, hi[k]!); }
    if (a <= c) rows.push([Math.floor(a) - 2, Math.ceil(c) + 2, Y0 + j]);
  }
  return rows;
}

// La envolvente convexa de unos puntos (cadena monótona), en orden
function convexHull(pts: Array<[number, number]>): Array<[number, number]> {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], c: [number, number]) => (a[0] - o[0]) * (c[1] - o[1]) - (a[1] - o[1]) * (c[0] - o[0]);
  const lower: Array<[number, number]> = [], upper: Array<[number, number]> = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]!; while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// Los puntos de pantalla de la sombra de la caja vista desde la luz: sus 8 esquinas y las mismas alargadas hasta donde
// la luz ya no llega ('all': la sombra abre demasiado; null: la caja queda fuera de su alcance)
function shadowHull(b: Baked, l: WorldLight, r: number, p: Plan): Array<[number, number]> | 'all' | null {
  const x0 = p.X0 - 1, y0 = p.Y0 - 1, z0 = p.Z0 - 1, x1 = p.X1 + 2, y1 = p.Y1 + 2, z1 = p.Z1 + 2;
  const cx = (x0 + x1) / 2 - l.x, cy = (y0 + y1) / 2 - l.y, cz = (z0 + z1) / 2 - l.z, cl = Math.hypot(cx, cy, cz);
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2, hz = (z1 - z0) / 2;
  if (cl - Math.hypot(hx, hy, hz) > r) return null;
  if (cl < 1e-6) return 'all';
  // Lo más que se abren las esquinas respecto al centro: la sombra hasta r cabe en las esquinas alargadas hasta r / cos
  let cosMin = 1;
  const corners: Array<[number, number, number]> = [];
  for (let c = 0; c < 8; c++) {
    const ex = (c & 1 ? x1 : x0) - l.x, ey = (c & 2 ? y1 : y0) - l.y, ez = (c & 4 ? z1 : z0) - l.z, el = Math.hypot(ex, ey, ez);
    if (el < 1e-6) return 'all';
    cosMin = Math.min(cosMin, (ex * cx + ey * cy + ez * cz) / (el * cl));
    corners.push([ex, ey, ez]);
  }
  if (cosMin < 0.35) return 'all';
  const far = r / cosMin;
  const out: Array<[number, number]> = [];
  for (const [ex, ey, ez] of corners) {
    const el = Math.hypot(ex, ey, ez), k = Math.max(1, far / el);
    for (const t of [1, k]) {
      const [sx, sy] = b.cam.project(l.x + ex * t, l.y + ey * t, l.z + ez * t);
      out.push([sx, sy]);
    }
  }
  return out;
}

// ¿Corta el segmento a -> b la caja [x0, x1] x [y0, y1] x [z0, z1]? (por franjas, sin crear nada)
function segmentHitsBox(ax: number, ay: number, az: number, bx: number, by: number, bz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  let t0 = 0, t1 = 1, d = bx - ax;
  if (d === 0) { if (ax < x0 || ax > x1) return false; } else {
    let u = (x0 - ax) / d, v = (x1 - ax) / d;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return false;
  }
  d = by - ay;
  if (d === 0) { if (ay < y0 || ay > y1) return false; } else {
    let u = (y0 - ay) / d, v = (y1 - ay) / d;
    if (u > v) { const w = u; u = v; v = w; }
    if (u > t0) t0 = u; if (v < t1) t1 = v; if (t0 > t1) return false;
  }
  d = bz - az;
  if (d === 0) return az >= z0 && az <= z1;
  let u = (z0 - az) / d, v = (z1 - az) / d;
  if (u > v) { const w = u; u = v; v = w; }
  if (u > t0) t0 = u; if (v < t1) t1 = v;
  return t0 <= t1;
}
function weightCells(b: Baked, zone: BakedLight, c0: number, c1: number, only?: CellFilter, out?: Staged, given?: WeightCtx): BakedLight {
  const ctx = given ?? weightCtx(b, zone, out, c1 - c0);
  for (let c = c0; c < c1; c++) cellWeight(b, zone, ctx, c, only);
  if (!given) ctx.cache.give();
  return zone;
}
// Lo mismo hasta un plazo: de LIGHT_CHECK en LIGHT_CHECK píxeles (el primer grupo siempre), y devuelve por cuál va. Un
// píxel cuyo rayo de sombra cruza mucha roca vóxel a vóxel cuesta cien veces lo normal, y un trozo fijo de ellos se
// pasaba del plazo varios ms. El orden es el mismo: los pesos salen iguales
function weightCellsUntil(b: Baked, zone: BakedLight, c0: number, c1: number, deadline: number, only: CellFilter | undefined, out: Staged | undefined, ctx: WeightCtx): number {
  let c = c0;
  do {
    const e = Math.min(c1, c + LIGHT_CHECK);
    for (; c < e; c++) cellWeight(b, zone, ctx, c, only);
  } while (c < c1 && performance.now() < deadline);
  return c;
}
// Lo mismo para una lista de píxeles de la zona (en orden de lectura de la zona)
function weightList(b: Baked, zone: BakedLight, cells: ArrayLike<number>, from: number, to: number, out?: Staged, given?: WeightCtx): void {
  const ctx = given ?? weightCtx(b, zone, out, to - from);
  for (let q = from; q < to; q++) cellWeight(b, zone, ctx, cells[q]!);
  if (!given) ctx.cache.give();
}
// Pesos rehechos que esperan a publicarse (la zona publicada no cambia hasta que el trabajo acaba): índice y valor
// En arrays de su tamaño, pedidos de una vez al saber cuántos (una lista que crece se copia entera al crecer: con
// cientos de miles, un paso de 4 píxeles se llevaba ms)
interface Staged { i: Int32Array; v: Float64Array; n: number }
const stagedFor = (n: number): Staged => ({ i: new Int32Array(n), v: new Float64Array(n), n: 0 });
// El peso de cada cara de vóxel ya calculada (varios píxeles ven la misma cara). Una tabla de tamaño fijo para los
// píxeles que se van a rehacer: un Map que crece se rehace entero al pasar de 16384 a 16385, y eso era un paso de
// ~2 ms. Las tablas se reutilizan entre trabajos (pedir una nueva de un MB también costaba): al tomarla solo se borran
// sus marcas. Si se llena (más caras de las previstas), deja de guardar y se calcula: el resultado es el mismo
const facePool: FaceCache[] = [];
class FaceCache {
  private keys: Float64Array;
  private vals: Float64Array;
  private used: Uint8Array;
  private n = 0;
  private constructor(readonly bits: number) {
    const size = 1 << bits;
    this.keys = new Float64Array(size); this.vals = new Float64Array(size); this.used = new Uint8Array(size);
  }
  // Una tabla para unas `expected` caras como mucho (un hueco por cara prevista: llena a la mitad, deja de guardar)
  static take(expected: number): FaceCache {
    const bits = Math.max(6, Math.ceil(Math.log2(Math.max(1, expected))));
    let i = -1;                                             // la más pequeña que valga, hasta 4 veces más grande
    for (let k = 0; k < facePool.length; k++) { const c = facePool[k]!; if (c.bits >= bits && c.bits <= bits + 2 && (i < 0 || c.bits < facePool[i]!.bits)) i = k; }
    if (i < 0) return new FaceCache(bits);
    const c = facePool.splice(i, 1)[0]!;
    c.used.fill(0); c.n = 0;
    return c;
  }
  // De vuelta al montón, para el siguiente trabajo
  give(): void { if (facePool.length < 8 && !facePool.includes(this)) facePool.push(this); }
  private slot(k: number): number {
    const lo = k >>> 0, hi = Math.floor(k / 4294967296);
    return Math.imul(lo ^ Math.imul(hi, 0x85ebca77), 0x9e3779b1) >>> (32 - this.bits);
  }
  get(k: number): number | undefined {
    const mask = (1 << this.bits) - 1;
    for (let i = this.slot(k); this.used[i]; i = (i + 1) & mask) if (this.keys[i] === k) return this.vals[i];
    return undefined;
  }
  set(k: number, v: number): void {
    if (this.n * 2 >= 1 << this.bits) return;              // llena: no se guarda más
    const mask = (1 << this.bits) - 1;
    let i = this.slot(k);
    while (this.used[i] && this.keys[i] !== k) i = (i + 1) & mask;
    if (!this.used[i]) { this.used[i] = 1; this.n++; }
    this.keys[i] = k; this.vals[i] = v;
  }
}
interface WeightCtx { r: number; base: number; mt: ReturnType<typeof materialsOf>; cache: FaceCache; out?: Staged }
// cells: cuántos píxeles se van a rehacer con este contexto (el tamaño de su tabla)
function weightCtx(b: Baked, zone: BakedLight, out: Staged | undefined, cells: number): WeightCtx {
  const p = resolveLight(zone.light, 0);
  return { r: p.radius, base: p.base, mt: materialsOf(b.source.palette), cache: FaceCache.take(cells), ...(out ? { out } : {}) };
}
function cellWeight(b: Baked, zone: BakedLight, x: WeightCtx, c: number, only?: CellFilter): void {
  const { light: l, rect, weight } = zone, { r, mt, cache } = x;
  const j = Math.floor(c / rect.w), i = c - j * rect.w;
  const idx = (rect.y + j) * b.width + rect.x + i;
  const k = b.pick[idx]!;
  const f = b.face[idx]!;
  if (only && !only(rect.x + i, rect.y + j, k, f)) return;
  if (Number.isNaN(k)) { if (x.out) { x.out.i[x.out.n] = c; x.out.v[x.out.n++] = 0; } else weight[c] = 0; return; }
  const ck = k * 8 + f;
  let w = cache.get(ck);
  if (w === undefined) {
    const [vx, vy, vz] = unkey(k);
    const n = DIR_VECTORS[f]!;
    const cx = vx + 0.5 + n[0] * 0.5, cy = vy + 0.5 + n[1] * 0.5, cz = vz + 0.5 + n[2] * 0.5;
    const ax = l.x - cx, ay = l.y - cy, az = l.z - cz;
    const d = Math.hypot(ax, ay, az);
    w = 0;
    if (d < r) {
      const back = mt ? mt.backlit[b.source.get(vx, vy, vz)]! : 0;
      const fa = d < 1e-6 ? 1 : facingOf((n[0] * ax + n[1] * ay + n[2] * az) / d, back);
      const k2 = 1 - d / r;
      if (fa > 0) {
        const t = transmit(b, vx + 0.5 + n[0], vy + 0.5 + n[1], vz + 0.5 + n[2], l.x, l.y, l.z);
        if (t > 0) w = t === 1 ? k2 * k2 * fa * x.base : k2 * k2 * fa * x.base * t;
      }
    }
    cache.set(ck, w);
  }
  if (x.out) { x.out.i[x.out.n] = c; x.out.v[x.out.n++] = w; } else weight[c] = w;
}

// ---- rehorneado parcial

// Rehace el horneado de los trozos dados (índices de StaticVoxels): su recuadro de pantalla, la rejilla de sombras
// de sus columnas y los pesos de las luces fijas que los alcanzan.
export function rebake(b: Baked, chunks: readonly number[], lights: readonly WorldLight[], boxes?: ReadonlyMap<number, Box3>): { pixels: number; lights: number } {
  // Lo mismo que los trabajos, de una vez (las pruebas comparan los dos caminos)
  const jobs = rebakeJobs(b, chunks, lights, boxes);
  for (const j of jobs) while (!j.run(Infinity)) { /* el de luz espera a los recuadros, que van antes */ }
  const rects = chunkGroups(b, chunks).map((g) => chunkRect(b, g, boxes).rect);
  return { pixels: rects.reduce((n, r) => n + (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1), 0), lights: jobs.length - rects.length };
}

// ---- el recuadro de pantalla de unos trozos, por franjas de columnas
// Con la cámara sin girar, la columna de vóxeles x cae exactamente en la columna de píxeles x: cada franja de
// columnas se puede renderizar por separado (con sus vóxeles, y los vecinos del mundo entero para caras y oclusión)
// y el resultado es el mismo que de una vez.
export interface ScreenRect { x0: number; x1: number; y0: number; y1: number }
interface RectBuffers { rgba: Uint8ClampedArray; depth: Float32Array; face: Int8Array; pick: Float64Array; w: number; h: number }

function rectBuffers(r: ScreenRect): RectBuffers {
  const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
  return { rgba: new Uint8ClampedArray(w * h * 4), depth: new Float32Array(w * h), face: new Int8Array(w * h), pick: new Float64Array(w * h), w, h };
}

export interface Plan { X0: number; Y0: number; X1: number; Y1: number; Z0: number; Z1: number }
function chunkRect(b: Baked, chunks: readonly number[], boxes?: ReadonlyMap<number, Box3>): { rect: ScreenRect; plan: Plan } {
  const s = b.source;
  // La caja de lo cambiado: la de cada trozo si se sabe (changedBox), si no el trozo entero con toda su altura
  let X0 = Infinity, Y0 = Infinity, Z0b = Infinity, X1 = -Infinity, Y1 = -Infinity, Z1b = -Infinity;
  for (const c of chunks) {
    const k = boxes?.get(c);
    const cx = c % s.cols, cy = Math.floor(c / s.cols);
    const bx = k ?? { x0: cx * CHUNK, y0: cy * CHUNK, z0: s.zMin, x1: Math.min(s.width, (cx + 1) * CHUNK) - 1, y1: Math.min(s.depth, (cy + 1) * CHUNK) - 1, z1: s.zMax };
    X0 = Math.min(X0, bx.x0); Y0 = Math.min(Y0, bx.y0); Z0b = Math.min(Z0b, bx.z0);
    X1 = Math.max(X1, bx.x1); Y1 = Math.max(Y1, bx.y1); Z1b = Math.max(Z1b, bx.z1);
  }
  // Un vóxel que cambia cambia también el tono de las caras vecinas: la oclusión (1 vóxel) y, con smooth, la normal
  // suavizada (3)
  const m = (b.options.smooth ?? 0.6) > 0 ? 3 : 1;
  X0 = Math.max(0, X0 - m); Y0 = Math.max(0, Y0 - m); X1 = Math.min(s.width - 1, X1 + m); Y1 = Math.min(s.depth - 1, Y1 + m);
  Z0b = Math.max(s.zMin, Z0b - m); Z1b = Math.min(s.zMax, Z1b + m);
  // Los píxeles por los que pasa la caja (lo que tapa o destapa no sale de ahí), con 1 de margen para el contorno
  const a = b.options.oblique?.y ?? 1, O = b.options.originY;
  const rect = {
    x0: Math.max(0, X0 - 1), x1: Math.min(b.width - 1, X1 + 2),
    y0: Math.max(0, Math.floor(O - a * (Y1 + 1) - (Z1b + 1)) - 1), y1: Math.min(b.height - 1, Math.ceil(O - a * Y0 - Z0b) + 1),
  };
  return { rect, plan: { X0, Y0, X1, Y1, Z0: Z0b, Z1: Z1b } };
}

// Los trozos de vóxeles de b.source cuyo recuadro de pantalla (su caja de boxes, o el trozo entero con toda su altura,
// como chunkRect) toca el recuadro r de la imagen: lo que hay que hornear para que r quede bien (LiveWindow.turnTo, lo
// visible primero)
// within: solo los que caen enteros dentro de r
export function chunksInScreen(b: Baked, r: ScreenRect, boxes?: ReadonlyMap<number, Box3>, within = false): number[] {
  const s = b.source, out: number[] = [];
  for (let c = 0; c < s.cols * s.rows; c++) {
    const { rect } = chunkRect(b, [c], boxes);
    if (within ? rect.x0 >= r.x0 && rect.x1 <= r.x1 && rect.y0 >= r.y0 && rect.y1 <= r.y1 : rect.x1 >= r.x0 && rect.x0 <= r.x1 && rect.y1 >= r.y0 && rect.y0 <= r.y1) out.push(c);
  }
  return out;
}

// Los trozos cambiados, en grupos que se rehornean cada uno con su recuadro: por columna de trozos, los tramos
// seguidos en y. Dos tramos de la misma columna van juntos si el hueco entre ellos cuesta menos píxeles que la altura
// de las paredes que repetirían dos recuadros. Así unos cambios sueltos por todo el mundo (una caída) no rehacen el
// mundo entero de un recuadro.
function chunkGroups(b: Baked, chunks: readonly number[], merge = false): number[][] {
  const s = b.source, a = b.options.oblique?.y ?? 1;
  const gap = Math.max(1, Math.floor((s.zMax - s.zMin + 2) / (a * CHUNK)));
  const byCol = new Map<number, number[]>();
  for (const c of new Set(chunks)) {
    const cx = c % s.cols;
    const l = byCol.get(cx);
    if (l) l.push(c); else byCol.set(cx, [c]);
  }
  const groups: number[][] = [];
  for (const cx of [...byCol.keys()].sort((p, q) => p - q)) {
    const col = byCol.get(cx)!.sort((p, q) => p - q);
    let g = [col[0]!];
    for (let i = 1; i < col.length; i++) {
      if (Math.floor(col[i]! / s.cols) - Math.floor(col[i - 1]! / s.cols) > gap) { groups.push(g); g = []; }
      g.push(col[i]!);
    }
    groups.push(g);
  }
  if (!merge) return groups;
  // Las de columnas seguidas con el mismo tramo de filas, juntas
  const span = (g: number[]) => `${Math.floor(g[0]! / s.cols)},${Math.floor(g[g.length - 1]! / s.cols)},${g.length}`;
  const out: number[][] = [];
  for (const g of groups) {
    const last = out[out.length - 1], cx = g[0]! % s.cols;
    if (last && (last[last.length - 1]! % s.cols) === cx - 1 && span(last.filter((c) => c % s.cols === cx - 1)) === span(g)) last.push(...g);
    else out.push([...g]);
  }
  return out;
}

// Renderiza las columnas de píxeles c0..c1 del recuadro en sus búferes
// Lo que recorre la franja de columnas c0..c1 del recuadro: la región de vóxeles (sus columnas y las y que pueden caer
// en sus filas) y, por bandas de 16 de y, la franja de alturas que puede caer en esas filas
// (j0..j1: solo esas filas del recuadro; por defecto, todas)
function stripRegion(b: Baked, r: ScreenRect, c0: number, c1: number, j0 = r.y0, j1 = r.y1) {
  const s = b.source, a = b.options.oblique?.y ?? 1, O = b.options.originY;
  // Con contorno, se renderiza con 1 píxel más por cada lado y se recorta: el contorno de un píxel mira a sus 4 vecinos,
  // y los del borde del recuadro tienen que verlos como en el horneado entero. Sin contorno ningún píxel depende de sus
  // vecinos y el margen solo costaría (casi duplica las columnas de un recuadro pequeño)
  const halo = RECT_TUNING.halo === 'always' || (b.options.outline ?? 'none') !== 'none' ? 1 : 0;
  const R0 = j0 - halo, R1 = j1 + halo, C0 = c0 - halo, C1 = c1 + halo;
  // Solo los vóxeles de esas columnas (el borde de una columna de píxeles es la columna de vóxeles de su x) y de las y
  // que pueden caer en esas filas. Por arriba manda lo más alto que haya en esas columnas (la rejilla de alturas), no
  // zMax: en un mundo alto y medio vacío, eso es la mitad de las filas
  const yHi = Math.min(s.depth - 1, Math.ceil((O - R0 - s.zMin) / a) + 1);
  let yLo = Math.max(0, Math.floor((O - R1 - 1 - s.zMax - 1) / a) - 1), top = s.zMin;
  for (let x = Math.max(0, C0 - 1); x <= Math.min(s.width - 1, C1); x++) for (let y = yLo; y <= yHi; y++) top = Math.max(top, s.height[y * s.width + x]!);
  yLo = Math.max(yLo, Math.floor((O - R1 - 1 - top) / a) - 1);
  const region = { x0: C0 - 1, y0: yLo, x1: C1, y1: yHi };
  // Por bandas de 16 filas de y (un trozo), con la franja de alturas que puede caer en las filas R0..R1 (la cara de
  // arriba del vóxel (y, z) va de la fila O - a*(y+1) - (z+1) a la O - a*y - z): el mismo orden que de una vez
  const bands: Array<{ x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }> = [];
  for (let y0 = region.y0; y0 <= region.y1; y0 = (y0 | 15) + 1) {
    const y1 = Math.min(region.y1, y0 | 15);
    bands.push({ x0: region.x0, x1: region.x1, y0, y1, z0: Math.floor(O - R1 - a * (y1 + 1)) - 2, z1: Math.ceil(O - R0 - a * y0) + 1 });
  }
  return { halo, R0, R1, C0, C1, region, bands };
}

// Prepara (hasta el plazo, de WARM_ROWS en WARM_ROWS filas; las primeras siempre) lo que la franja va a recorrer: las
// filas de la máscara de lo expuesto que haya que recalcular. true si está todo
const WARM_ROWS = 64;
// Las tandas que puede necesitar una región como mucho: sus filas de máscara (por trozo, una por y y por z) entre
// WARM_ROWS, y una más. Si se pasan, algo rehace lo hecho: error (si no, se colgaría)
function warmBatches(s: StaticVoxels, r: { x0: number; y0: number; x1: number; y1: number }): number {
  const chunksX = Math.floor(Math.min(s.width - 1, r.x1) / CHUNK) - Math.floor(Math.max(0, r.x0) / CHUNK) + 1;
  const ys = Math.min(s.depth - 1, r.y1) - Math.max(0, r.y0) + 1;
  return Math.ceil((chunksX * ys * (s.zMax - s.zMin + 1)) / WARM_ROWS) + 1;
}
function warmStrip(b: Baked, r: ScreenRect, c0: number, c1: number, deadline: number, j0 = r.y0, j1 = r.y1): boolean {
  const { region, bands } = stripRegion(b, r, c0, c1, j0, j1);
  const parts = (b.options.yaw ?? 0) !== 0 ? [region] : bands;
  for (const part of parts) {
    const most = warmBatches(b.source, part);
    for (let n = 0; !b.source.warmExposed(part, WARM_ROWS, facesOf(b)); n++) {
      // Preparar lo expuesto es solo adelantar: forEachExposed hace lo que falte al recorrer. Si la cuenta se pasa del
      // tope (un fallo: no debería), se apunta y se deja la región así, sin parar el juego
      if (n > most) { exposureFault(`una franja: ${n} tandas en una región que tiene como mucho ${most}`); break; }
      if (performance.now() >= deadline) return false;
    }
  }
  return true;
}

// Un fallo de cuenta al preparar lo expuesto: se apunta (una vez por clase de mensaje, en la consola y en
// exposureFaults) y quien llama sigue sin las máscaras de esa región (forEachExposed las hace al recorrer). Antes era
// un error que paraba el juego
export const exposureFaults: string[] = [];
function exposureFault(msg: string): void {
  exposureFaults.push(msg);
  if (exposureFaults.length <= 3) console.warn(`[voxpix] lo expuesto no acaba: ${msg}`);
}

// Las caras que pinta el render con las opciones del horneado: el rehorneado solo recorre los vóxeles con aire delante
// de alguna de ellas (los otros no pintan nada: la imagen es la misma, y las paredes de canto de un corte hondo no se
// recorren)
const FACES = new WeakMap<Baked, FaceSet>();
function facesOf(b: Baked): FaceSet {
  let f = FACES.get(b);
  if (!f) { f = frontFaces(b.options); FACES.set(b, f); }
  return f;
}

// remember: false para recorrer una sola vez (el horneado inicial): sin las máscaras de lo expuesto (ver forEachExposed)
function renderColumns(b: Baked, r: ScreenRect, buf: RectBuffers, c0: number, c1: number, remember = true, j0 = r.y0, j1 = r.y1): void {
  const s = b.source, O = b.options.originY;
  const { halo, R0, R1, C0, C1, region, bands } = stripRegion(b, r, c0, c1, j0, j1);
  const W = C1 - C0 + 1, H = R1 - R0 + 1, w = c1 - c0 + 1;
  const banded = (fn: (x: number, y: number, z: number, v: number) => void) => {
    for (const band of bands) s.forEachExposed(fn, band, remember, facesOf(b));
  };
  const sub: VoxelSource = { palette: s.palette, get: (x, y, z) => s.get(x, y, z), entries: () => s.entries(region), forEachExposed: (b.options.yaw ?? 0) === 0 ? banded : (fn) => s.forEachExposed(fn, region, remember) };
  const img = render(sub, { ...b.options, width: W, height: H, originX: (b.options.originX ?? 0) - C0, originY: O - R0 });
  for (let j = 0; j <= j1 - j0; j++) for (let i = 0; i < w; i++) {
    const src = (j + halo) * W + i + (c0 - C0), dst = (j + j0 - r.y0) * buf.w + (c0 - r.x0) + i;
    buf.depth[dst] = img.depth[src]!; buf.face[dst] = img.pickFace![src]!; buf.pick[dst] = img.pickKey![src]!;
    for (let ch = 0; ch < 4; ch++) buf.rgba[dst * 4 + ch] = img.rgba[src * 4 + ch]!;
  }
}

// changed (opcional, buf.w x buf.h): se marca 1 donde cambió qué vóxel o qué cara se ve
function publishRect(b: Baked, r: ScreenRect, buf: RectBuffers, changed?: Uint8Array): void {
  // Fila a fila con set (una copia de memoria por array y fila; antes, píxel a píxel: ~8 ms a 6x por recuadro del worker)
  const w = buf.w;
  for (let j = 0; j < buf.h; j++) {
    const src = j * w, dst = (r.y0 + j) * b.width + r.x0;
    if (changed) for (let i = 0; i < w; i++) if (b.face[dst + i] !== buf.face[src + i] || !Object.is(b.pick[dst + i], buf.pick[src + i])) changed[src + i] = 1;
    b.depth.set(buf.depth.subarray(src, src + w), dst);
    b.face.set(buf.face.subarray(src, src + w), dst);
    b.pick.set(buf.pick.subarray(src, src + w), dst);
    b.rgba.set(buf.rgba.subarray(src * 4, (src + w) * 4), dst * 4);
  }
  const pub = b.published;
  pushPublished(b, { serial: ++pub.serial, ...r });
}
// (256: el worker entrega en ráfagas, y con 32 una de recuadros lejanos dejaba sin saber qué había cambiado cerca: en
// viva ?seccion=48&rafaga=40, 48-57 cuadros con franjas viejas estando quieta y ~2200 franjas pintadas, contra 1 y ~1700)
export const PUBLISHED_KEEP = 256, FORGOTTEN_KEEP = 16;
// Publica un recuadro; lo que sale de los PUBLISHED_KEEP se une en la tanda olvidada de ahora (cada tanda, como mucho
// PUBLISHED_KEEP recuadros; como mucho FORGOTTEN_KEEP tandas)
export function pushPublished(b: Baked, r: { serial: number; x0: number; y0: number; x1: number; y1: number; sky?: true }): void {
  const pub = b.published;
  pub.rects.push(r);
  if (pub.rects.length <= PUBLISHED_KEEP) return;
  const o = pub.rects.shift()!, f = (pub.forgotten ??= []);
  const last = f[f.length - 1];
  if (last && o.serial - last.from < PUBLISHED_KEEP) {
    last.to = o.serial; last.x0 = Math.min(last.x0, o.x0); last.y0 = Math.min(last.y0, o.y0); last.x1 = Math.max(last.x1, o.x1); last.y1 = Math.max(last.y1, o.y1);
    last.sky &&= !!o.sky;
  } else {
    f.push({ from: o.serial, to: o.serial, x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1, sky: !!o.sky });
    if (f.length > FORGOTTEN_KEEP) f.shift();
  }
}
// Lo publicado después de `serial`: los recuadros que se guardan y, de lo olvidado, el recuadro que une cada tanda (más
// grande que lo que cambió, nunca más pequeño). null si ni eso llega tan atrás (no se sabe qué cambió). Lo de solo cielo va
// con sky: true
export function publishedSince(b: Baked, serial: number): Array<{ x0: number; y0: number; x1: number; y1: number; sky?: boolean }> | null {
  const pub = b.published;
  if (serial >= pub.serial) return [];
  const out: Array<{ x0: number; y0: number; x1: number; y1: number; sky?: boolean }> = [];
  // (sin recuadros guardados, como antes: lo de antes del último serial no se sabe, el corrimiento suma 2 sin recuadro)
  const oldest = pub.rects.length ? pub.rects[0]!.serial : pub.serial;
  if (serial < oldest - 1) {
    // Lo que falta, (serial, oldest): tiene que estar entero en las tandas olvidadas, seguidas hasta oldest - 1
    const f = pub.forgotten ?? [];
    let need = oldest - 1;
    for (let k = f.length - 1; k >= 0 && need > serial; k--) {
      const t = f[k]!;
      if (t.to < need) return null;                                       // un hueco: algo se perdió sin tanda
      if (t.to > serial) out.push(t);
      need = t.from - 1;
    }
    if (need > serial) return null;
  }
  for (const r of pub.rects) if (r.serial > serial) out.push(r);
  return out;
}

// El recuadro de unos trozos pintado aparte (en un worker con su copia de la ventana) y
// publicado en el horneado del hilo principal. renderRectFor: el recuadro y sus búferes (lo que hace un trabajo rect de
// rebakeJobs, de una vez); publishRectBuffers: lo que hace el hilo principal con lo que le llega
export type RectOut = { rect: ScreenRect; rgba: Uint8ClampedArray; depth: Float32Array; face: Int8Array; pick: Float64Array; w: number; h: number };
export interface RemoteRects { ask(rect: ScreenRect): { result(): RectOut | null; ready?(): boolean } | null }
export function renderRectFor(b: Baked, chunks: readonly number[], band = RECT_BAND): RectOut { return renderRect(b, chunkRect(b, chunks).rect, band); }
export function renderRect(b: Baked, rect: ScreenRect, band = RECT_BAND): RectOut {
  const buf = rectBuffers(rect);
  for (let col = rect.x0; col <= rect.x1; col += band) {
    const c1 = Math.min(rect.x1, col + band - 1);
    warmStrip(b, rect, col, c1, Infinity);
    renderColumns(b, rect, buf, col, c1);
  }
  return { rect, ...buf };
}
export function publishRectBuffers(b: Baked, o: RectOut): void { publishRect(b, o.rect, o); }

// ---- rehorneado como trabajos que se reanudan (para la cola con presupuesto de la vista)
// run(deadline) trabaja hasta que el reloj pasa de `deadline` o acaba, y devuelve true si acabó. Mientras no acaba
// vale lo viejo; lo nuevo se publica de golpe al terminar (doble búfer). Un trabajo nuevo con la misma key sustituye
// al viejo (lo hace la cola).
export interface ViewJob { readonly key: string; run(deadline: number): boolean; readonly priority?: number; waiting?(): boolean }

// Para las pruebas: 'always' fuerza el margen de 1 píxel de cada franja también sin contorno (para comprobar que sin
// contorno no cambia nada); 'auto', solo con contorno
export const RECT_TUNING: { halo: 'auto' | 'always' } = { halo: 'auto' };
const RECT_BAND = 4;      // columnas de píxeles por paso del recuadro
let lightSerial = 0;      // para que cada trabajo parcial de luz tenga su key (la cola no los sustituye entre sí)
const LIGHT_CELLS = 32;   // píxeles de una zona de luz por paso
const LIGHT_OWN = 16;     // píxeles cambiados por paso (cada uno, su rayo de sombra)
const LIGHT_CHECK = 4;    // píxeles entre dos miradas al reloj dentro de un paso de la zona

// boxes (opcional): la caja de lo cambiado en cada trozo (StaticVoxels.changedBox); sin ella, el trozo entero
// lights son TODAS las luces del mundo (o de la vista): las fijas horneadas que ya no están (quitadas, o que pasaron a
// dinámicas) se deshornean al momento, y las fijas que no estaban horneadas (puestas en partida) se hornean enteras,
// aunque no haya cambiado ningún vóxel
// Cómo se reparte el rehorneado (lo de mucho de una vez, como los trozos que entran en la ventana viva):
// - band: columnas de píxeles por franja (RECT_BAND). Cada franja renderiza 1 columna de margen por lado (el contorno) y
//   recorre otra de vóxeles más: con 4, 7 columnas de vóxeles por cada 4 de píxeles. Más ancha, menos repetido, pero
//   cada paso de la cola es más largo.
// - merge: junta en un recuadro las columnas de trozos vecinas con el mismo tramo de filas (un trozo de la ventana entero,
//   en vez de un recuadro por columna de 16 con su margen de 3 por lado)
// - rows: filas por paso (en pasos de band columnas x rows filas). Sin rows, la franja entera: en un recuadro alto (una
//   columna de la ventana viva, cientos de filas) un paso de 4 columnas costaba 13 ms sin freno
// tile: los trozos cambiados se agrupan antes por baldosas de tile x tile trozos de vóxeles (un
// trozo de la ventana viva: T / 16), y cada baldosa da sus recuadros: trabajo acotado (y poco que tirar al cancelar)
export interface RebakeShape { band?: number; merge?: boolean; rows?: number; tile?: number }

// clip: solo los píxeles de ese recuadro de la imagen (LiveWindow.turnTo: lo que se ve). Lo de su borde (1 píxel) puede
// quedar sin contorno bien hecho: quien recorta rehornea después los trozos que se salen de él
export function rebakeJobs(b: Baked, chunks: readonly number[], lights: readonly WorldLight[], boxes?: ReadonlyMap<number, Box3>, shape: RebakeShape = {}, clip?: ScreenRect): ViewJob[] {
  const BAND = shape.band ?? RECT_BAND;
  const fixed = new Map<LightId, WorldLight>();
  for (const l of lights) if (l.baked !== false) fixed.set(l.id, l);
  const gone = (b.goneLights ??= new Set());
  for (let i = b.lights.length - 1; i >= 0; i--) if (!fixed.has(b.lights[i]!.light.id)) { gone.add(b.lights[i]!.light.id); b.lightWork?.delete(b.lights[i]!.light.id); b.lights.splice(i, 1); }
  for (const id of fixed.keys()) gone.delete(id);
  const pend = (b.pendingLights ??= new Set());
  for (const id of [...pend]) if (!fixed.has(id)) pend.delete(id);
  const added = [...fixed.values()].filter((l) => !pend.has(l.id) && !b.lights.some((bl) => bl.light.id === l.id));
  for (const l of added) pend.add(l.id);
  if (!chunks.length) return added.map((l) => lightJob(b, l));
  const jobs: ViewJob[] = [];
  // 1) un recuadro por grupo de trozos, por franjas de columnas (los búferes se piden al empezar, no aquí)
  const plans: Plan[] = [], rects: ScreenRect[] = [], masks = new Map<ScreenRect, Uint8Array>();
  // Los píxeles de la imagen donde cambió el vóxel o la cara que se ve (de las máscaras de los recuadros, que ya se
  // publicaron cuando las luces preguntan); una vez por rehorneado
  let changed: Int32Array | null = null;
  const changedPixels = (): Int32Array => {
    if (changed) return changed;
    const out: number[] = [];
    for (const r of rects) {
      const m = masks.get(r), w = r.x1 - r.x0 + 1;
      for (let j = 0; j <= r.y1 - r.y0; j++) for (let i = 0; i < w; i++) if (!m || m[j * w + i]) out.push((r.y0 + j) * b.width + r.x0 + i);
    }
    return (changed = Int32Array.from(new Set(out)));
  };
  const busy = (b.rectsBusy ??= new Map()), myKeys: string[] = [];
  const epoch = b.rebakeEpoch ?? 0, pp = (b.pendingPlans ??= new Map());
  const stale = () => (b.rebakeEpoch ?? 0) !== epoch;
  // ¿Queda en marcha alguno de los recuadros de este rehorneado? (quien lo acabe: este trabajo o el que lo sustituyó)
  const waiting = () => myKeys.some((k) => busy.has(k));
  const tiles = new Map<string, number[]>();
  if (shape.tile) for (const c of chunks) { const k = `${Math.floor((c % b.source.cols) / shape.tile)},${Math.floor(Math.floor(c / b.source.cols) / shape.tile)}`; const l = tiles.get(k); if (l) l.push(c); else tiles.set(k, [c]); }
  const groupsAll = shape.tile ? [...tiles.values()].flatMap((cs) => chunkGroups(b, cs, shape.merge)) : chunkGroups(b, chunks, shape.merge);
  for (const g of groupsAll) {
    const { rect: whole, plan } = chunkRect(b, g, boxes);
    const rect = clip ? { x0: Math.max(whole.x0, clip.x0), y0: Math.max(whole.y0, clip.y0), x1: Math.min(whole.x1, clip.x1), y1: Math.min(whole.y1, clip.y1) } : whole;
    if (rect.x0 > rect.x1 || rect.y0 > rect.y1) continue;
    plans.push(plan); rects.push(rect);
    const key = `rect:${rect.x0},${rect.y0},${rect.x1},${rect.y1}`, token = {};
    busy.set(key, token); myKeys.push(key);
    pp.set(token, [plan]);
    let buf: RectBuffers | null = null, col = rect.x0, row = rect.y0, est = 0;
    const ROWS = shape.rows ?? Infinity;
    // (el recuadro pedido fuera, y el reloj de cuando se pidió)
    let ticket: { result(): RectOut | null; ready?(): boolean } | null | undefined, askedAt = 0;
    // Lo que se pinta por franjas en varias llamadas: si un trozo del plan cambia entre medias (el corte que avanza, un
    // golpe), lo pintado antes ya no vale; y si su rehorneado (otro trabajo, más pequeño) acaba antes, este lo pisaría
    // con lo de antes al publicar. Se apunta el reloj al empezar y, si algo del plan cambió, se vuelve a pintar (dos veces
    // como mucho: con cambios en cada cuadro, se publica y lo arregla el rehorneado de esos cambios, que va detrás)
    const planChunks: number[] = [];
    { const s = b.source; for (let cy = Math.max(0, Math.floor(plan.Y0 / CHUNK)); cy <= Math.min(s.rows - 1, Math.floor(plan.Y1 / CHUNK)); cy++) for (let cx = Math.max(0, Math.floor(plan.X0 / CHUNK)); cx <= Math.min(s.cols - 1, Math.floor(plan.X1 / CHUNK)); cx++) planChunks.push(cy * s.cols + cx); }
    let started = -1, restarts = 0;
    jobs.push({
      key,
      // (espera al recuadro pedido fuera, si el que lo pinta dice si ya llegó, o a que acabe el corrimiento)
      waiting: () => !stale() && col <= rect.x1 && (!!b.shiftHold || (!!ticket && !!ticket.ready && !ticket.ready())),
      run(deadline) {
        if (stale()) return true;                                          // descartado al correrse la ventana
        if (b.shiftHold) return false;                                     // la ventana se está corriendo: espera
        if (col > rect.x1) return true;
        if (ticket === undefined && b.remote && !buf) { askedAt = b.source.clock; ticket = b.remote.ask(rect); }
        if (ticket) {
          const r = ticket.result();
          if (!r) return false;                                            // espera (sin gastar)
          ticket = null;
          const moved = b.source.changedSince(askedAt);
          const st = (b.remoteStats ??= { published: 0, stale: 0, local: 0, localMs: 0 });
          if (!g.some((c) => moved.includes(c))) {
            st.published++;
            const mask = new Uint8Array(r.w * r.h);
            publishRect(b, rect, r, mask);
            masks.set(rect, mask);
            if (busy.get(key) === token) busy.delete(key);
            pp.delete(token);
            return true;
          }
          // (algo suyo cambió mientras: se pinta aquí)
          st.stale++;
        }
        if (!buf) { buf = rectBuffers(rect); started = b.source.clock; }
        // Una franja por lo menos; otra solo si cabe antes del plazo según lo que tardó la anterior (si no, la
        // última se pasaba del plazo entera)
        let t = performance.now();
        do {
          const c1 = Math.min(rect.x1, col + BAND - 1), r1 = Math.min(rect.y1, row + ROWS - 1);
          // Lo que la franja tiene que recalcular de lo expuesto (tras un cambio grande, como un corte), antes y con plazo:
          // si no da tiempo, se sigue en la llamada siguiente (lo hecho se queda) y la franja no se pasa del plazo por eso
          if (!warmStrip(b, rect, col, c1, deadline, row, r1)) return false;
          renderColumns(b, rect, buf, col, c1, true, row, r1);
          if (r1 < rect.y1) row = r1 + 1; else { row = rect.y0; col = c1 + 1; }
          const now = performance.now();
          est = now - t; t = now;
        } while (col <= rect.x1 && t + est < deadline);
        if (col <= rect.x1) return false;
        if (restarts < 2) {
          const moved = b.source.changedSince(started);
          if (moved.length && planChunks.some((c) => moved.includes(c))) { restarts++; col = rect.x0; row = rect.y0; buf = null; return false; }
        }
        const mask = new Uint8Array(buf.w * buf.h);
        publishRect(b, rect, buf, mask);
        masks.set(rect, mask);
        buf = null;
        if (busy.get(key) === token) busy.delete(key);
        pp.delete(token);
        return true;
      },
    });
  }
  // 2) las luces fijas que alcanzan algún grupo, por filas (después de los recuadros: leen qué vóxel se ve en cada píxel)
  for (const l of lights) {
    if (l.baked === false) {
      // Una fija que pasó a dinámica (la de un objeto que se despertó): sus pesos horneados sobran
      const i = b.lights.findIndex((bl) => bl.light.id === l.id);
      if (i >= 0) b.lights.splice(i, 1);
      continue;
    }
    const r = resolveLight(l, 0).radius;
    if (!plans.some((p) => !(l.x + r < p.X0 || l.x - r > p.X1 + 1 || l.y + r < p.Y0 || l.y - r > p.Y1 + 1))) continue;
    // Si ya hay un trabajo de esta luz esperando en la cola, se le suma esto y no se crea otro
    const works = (b.lightWork ??= new Map());
    const queued = works.get(l.id);
    if (queued && !queued.started) { queued.plans.push(...plans); queued.pixels.push(changedPixels); queued.waits.push(waiting); continue; }
    const work: LightWork = { plans: [...plans], pixels: [changedPixels], waits: [waiting], started: false };
    works.set(l.id, work);
    const lt = {};
    pp.set(lt, work.plans);
    let zone: BakedLight | null | undefined, only: CellFilter | undefined;
    // Lo que hay que rehacer de la zona, en recuadros de la zona [i0, i1) x [j0, j1), y por dónde va
    let spans: Array<[number, number, number, number]> = [], si = 0, row = 0, col = -1, own: number[] = [], oi = 0, staged: Staged | undefined, wctx: WeightCtx | undefined;
    // La preparación por partes: la sombra en pantalla de cada caja (shadowRows), una por paso, con el plazo entre medias
    let shade: { prev: BakedLight; list: number[]; out: Array<[number, number, number, number]>; pi: number; whole: boolean } | null = null;
    jobs.push({
      key: `light:${l.id}#${++lightSerial}`,
      run(deadline) {
        if (stale()) return true;
        if (b.shiftHold) return false;
        if (work.waits.some((w) => w())) return false;     // espera a los recuadros (de todos los rehorneados que lleva)
        if (zone === undefined) {
          work.started = true;
          if (b.lightWork?.get(l.id) === work) b.lightWork.delete(l.id);
          const plans = work.plans;
          const prev = b.lights.find((bl) => bl.light.id === l.id);
          // Con la misma luz, los pesos se rehacen sobre los de antes (en un objeto nuevo, para que quien guarda una
          // copia, como la GPU, sepa que cambió)
          zone = lightZone(b, l, prev && sameLight(prev.light, l) ? prev.weight : undefined);
          if (zone) spans = [[0, zone.rect.w, 0, zone.rect.h]];
          // Si la luz ya estaba horneada con la misma zona, solo cambian los píxeles de los recuadros rehechos y los
          // que miran a la luz a través de lo cambiado: se parte de sus pesos y se rehacen esos, mirando solo los
          // recuadros rehechos y la sombra de cada caja en pantalla
          if (zone && prev && zone.weight === prev.weight && prev.rect.x === zone.rect.x && prev.rect.y === zone.rect.y) {
            only = touchedBy(l, plans);
            staged = stagedFor(0);              // de su tamaño al acabar la preparación
            const zr = zone.rect;
            // Los píxeles que cambiaron de vóxel o de cara, dentro de la zona: se rehacen todos, primero
            // (sin repetir: una marca por píxel de la zona; un Set que crece se rehace entero, como el Map de los pesos)
            const list: number[] = [], seen = new Uint8Array(zr.w * zr.h);
            for (const src of work.pixels) {
              const cp = src();
              for (let q = 0; q < cp.length; q++) {
                const g = cp[q]!, gx = g % b.width, gy = (g - gx) / b.width;
                if (!(gx >= zr.x && gy >= zr.y && gx < zr.x + zr.w && gy < zr.y + zr.h)) continue;
                const c = (gy - zr.y) * zr.w + gx - zr.x;
                if (seen[c]) continue;
                seen[c] = 1; list.push(c);
              }
            }
            own = list;
            shade = { prev, list, out: [], pi: 0, whole: false };
            if (performance.now() >= deadline) return false;
          }
        }
        if (zone && shade) {
          // La sombra en pantalla de cada caja rehecha: lo que mira a la luz a través de lo cambiado
          const sh0 = shade, zr = zone.rect, plans = work.plans;
          const add = (x0: number, y0: number, x1: number, y1: number) => {
            const i0 = Math.max(0, Math.floor(x0) - zr.x), i1 = Math.min(zr.w, Math.ceil(x1) + 1 - zr.x);
            const j0 = Math.max(0, Math.floor(y0) - zr.y), j1 = Math.min(zr.h, Math.ceil(y1) + 1 - zr.y);
            if (i0 < i1 && j0 < j1) sh0.out.push([i0, i1, j0, j1]);
          };
          while (sh0.pi < plans.length && !sh0.whole) {
            const sh = shadowRows(b, l, r, plans[sh0.pi++]!);
            if (sh === 'all') sh0.whole = true;
            else if (sh) for (const [x0, x1, y] of sh) add(x0, y, x1, y);
            if (sh0.pi < plans.length && !sh0.whole && performance.now() >= deadline) return false;
          }
          if (!sh0.whole) {
            spans = sh0.out;
            const prev = sh0.prev;
            let dx0 = Infinity, dy0 = Infinity, dx1 = -Infinity, dy1 = -Infinity;
            for (const [i0, i1, j0, j1] of sh0.out) { dx0 = Math.min(dx0, i0); dx1 = Math.max(dx1, i1); dy0 = Math.min(dy0, j0); dy1 = Math.max(dy1, j1); }
            for (const c of sh0.list) { const ci = c % zr.w, cj = (c - ci) / zr.w; dx0 = Math.min(dx0, ci); dx1 = Math.max(dx1, ci + 1); dy0 = Math.min(dy0, cj); dy1 = Math.max(dy1, cj + 1); }
            zone.base = prev;
            prev.base = undefined;                   // solo un eslabón: no se encadenan los horneados viejos
            zone.dirty = dx1 > dx0 ? { x: dx0, y: dy0, w: dx1 - dx0, h: dy1 - dy0 } : { x: 0, y: 0, w: 0, h: 0 };
          }
          shade = null;
          // Cuántos pesos se van a rehacer como mucho: los propios y los de cada recuadro (pueden solaparse: cuentan dos)
          if (staged) {
            let n = own.length;
            for (const [i0, i1, j0, j1] of spans) n += (i1 - i0) * (j1 - j0);
            const t = stagedFor(n);
            staged.i = t.i; staged.v = t.v; staged.n = 0;
          }
          if (performance.now() >= deadline) return false;
        }
        if (zone && oi < own.length) {
          // Los píxeles que cambiaron, de LIGHT_OWN en LIGHT_OWN (su rayo de sombra puede ser largo: en un foso cruza
          // paredes y va vóxel a vóxel)
          wctx ??= weightCtx(b, zone, staged, staged ? staged.i.length : zone.rect.w * zone.rect.h);
          do { const o1 = Math.min(own.length, oi + LIGHT_OWN); weightList(b, zone, own, oi, o1, staged, wctx); oi = o1; } while (oi < own.length && performance.now() < deadline);
          if (oi < own.length) return false;
        }
        // Los recuadros, de LIGHT_CELLS en LIGHT_CELLS píxeles (no de filas enteras: una fila de una zona grande con
        // sombras largas era un paso de varios ms)
        if (zone) while (si < spans.length) {
          const [i0, i1, j0, j1] = spans[si]!;
          if (row < j0 || col < 0) { row = Math.max(row, j0); col = i0; }
          const c1 = Math.min(i1, col + LIGHT_CELLS);
          wctx ??= weightCtx(b, zone, staged, staged ? staged.i.length : zone.rect.w * zone.rect.h);
          col = weightCellsUntil(b, zone, row * zone.rect.w + col, row * zone.rect.w + c1, deadline, only, staged, wctx) - row * zone.rect.w;
          if (col >= i1) { row++; col = i0; if (row >= j1) { si++; row = 0; col = -1; } }
          if (performance.now() >= deadline) break;
        }
        if (zone && si < spans.length) return false;
        // Los pesos rehechos se ponen ahora, de una vez (la zona es la misma memoria que la publicada)
        if (zone && staged) for (let q = 0; q < staged.n; q++) zone.weight[staged.i[q]!] = staged.v[q]!;
        wctx?.cache.give(); wctx = undefined;
        b.pendingLights?.delete(l.id);
        pp.delete(lt);
        if (b.goneLights?.has(l.id)) return true;          // se quitó mientras: no se publica
        const i = b.lights.findIndex((bl) => bl.light.id === l.id);
        if (i >= 0) { if (zone) b.lights[i] = zone; else b.lights.splice(i, 1); } else if (zone) b.lights.push(zone);
        return true;
      },
    });
  }
  // 3) el cielo de lo que alcanza el cambio (después de los recuadros: lee qué cara se ve en cada píxel). Se calcula
  // aparte y se publica de una vez (lo publicado es lo viejo hasta acabar)
  if (b.sky) for (const p of plans) {
    const sr = skyRect(b, p), r = clip ? { x0: Math.max(sr.x0, clip.x0), y0: Math.max(sr.y0, clip.y0), x1: Math.min(sr.x1, clip.x1), y1: Math.min(sr.y1, clip.y1) } : sr;
    if (r.x0 > r.x1 || r.y0 > r.y1) continue;
    const w = r.x1 - r.x0 + 1, out = new Uint8Array(w * (r.y1 - r.y0 + 1)), st = {};
    pp.set(st, [p]);
    let row = r.y0;
    // Lo que lee: el cielo de cada píxel mira SKY_REACH vóxeles a su alrededor, y los píxeles llegan a SKY_REACH + 1 del
    // cambio. Si un trozo de ahí cambia mientras se calcula por filas, lo calculado antes ya no vale; y si el cielo del
    // rehorneado de ese cambio acaba antes, este lo pisaría con lo de antes al publicar. Se apunta el reloj al empezar y,
    // si algo de eso cambió, se vuelve a calcular (dos veces como mucho, como los recuadros)
    const reads: number[] = [];
    { const s = b.source, m2 = 2 * SKY_REACH + 2;
      for (let cy = Math.max(0, Math.floor((p.Y0 - m2) / CHUNK)); cy <= Math.min(s.rows - 1, Math.floor((p.Y1 + m2) / CHUNK)); cy++)
        for (let cx = Math.max(0, Math.floor((p.X0 - m2) / CHUNK)); cx <= Math.min(s.cols - 1, Math.floor((p.X1 + m2) / CHUNK)); cx++) reads.push(cy * s.cols + cx); }
    let skyStarted = -1, skySerial = -1, skyRestarts = 0;
    const sst = (b.skyStats ??= { jobs: 0, pixels: 0, restartPub: 0, restartVox: 0, published: 0, ms: 0 });
    sst.jobs++;
    jobs.push({
      key: `sky:${r.x0},${r.y0},${r.x1},${r.y1}`,
      // (espera a sus recuadros, o a que acabe el corrimiento: la cola lo salta sin llamarlo)
      waiting: () => !stale() && (!!b.shiftHold || waiting()),
      run(deadline) {
        if (stale()) return true;
        if (b.shiftHold || waiting()) return false;
        if (skyStarted < 0) { skyStarted = b.source.clock; skySerial = b.published.serial; }
        const t0 = performance.now(), r0 = row;
        do { for (let x = r.x0; x <= r.x1; x++) out[(row - r.y0) * w + x - r.x0] = skyOf(b, row * b.width + x); row++; } while (row <= r.y1 && performance.now() < deadline);
        sst.pixels += (row - r0) * w; sst.ms += performance.now() - t0;
        if (row <= r.y1) return false;
        if (skyRestarts < 2) {
          const moved = b.source.changedSince(skyStarted);
          // (y lo que lee de la imagen: la cara y el vóxel de cada píxel, que pone un recuadro; uno de otro rehorneado
          // publicado mientras sobre lo suyo cambia el cielo de esos píxeles, y el cielo de ese rehorneado puede acabar antes)
          const since = publishedSince(b, skySerial);
          const repainted = !since || since.some((q) => !q.sky && q.x1 >= r.x0 && q.x0 <= r.x1 && q.y1 >= r.y0 && q.y0 <= r.y1);
          const voxMoved = moved.length > 0 && reads.some((c) => moved.includes(c));
          if (repainted || voxMoved) { if (repainted) sst.restartPub++; else sst.restartVox++; skyRestarts++; row = r.y0; skyStarted = -1; return false; }
        }
        for (let y = r.y0; y <= r.y1; y++) b.sky!.set(out.subarray((y - r.y0) * w, (y - r.y0 + 1) * w), y * b.width + r.x0);
        pp.delete(st);
        const pub = b.published;
        pushPublished(b, { serial: ++pub.serial, ...r, sky: true });
        sst.published += w * (r.y1 - r.y0 + 1);
        return true;
      },
    });
  }
  // Las fijas nuevas que no alcanzan lo cambiado
  for (const l of added) if (!jobs.some((j) => j.key.startsWith(`light:${l.id}#`))) jobs.push(lightJob(b, l));
  return jobs;
}

// Hornea una luz fija entera como trabajo (una puesta en partida)
function lightJob(b: Baked, l: WorldLight): ViewJob {
  let zone: BakedLight | null | undefined, cell = 0, wctx: WeightCtx | undefined;
  const epoch = b.rebakeEpoch ?? 0;
  return {
    key: `light:${l.id}`,
    run(deadline) {
      // (descartada al correrse la ventana: ya no está en pendingLights y el rehorneado siguiente la vuelve a pedir)
      if ((b.rebakeEpoch ?? 0) !== epoch) return true;
      if (b.shiftHold) return false;
      if (zone === undefined) zone = lightZone(b, l);
      const n = zone ? zone.rect.w * zone.rect.h : 0;
      if (zone) do {
        const c1 = Math.min(n, cell + LIGHT_CELLS);
        wctx ??= weightCtx(b, zone, undefined, zone.rect.w * zone.rect.h);
        cell = weightCellsUntil(b, zone, cell, c1, deadline, undefined, undefined, wctx);
      } while (cell < n && performance.now() < deadline);
      if (zone && cell < n) return false;
      wctx?.cache.give(); wctx = undefined;
      if (!b.pendingLights?.delete(l.id)) return true;   // se quitó mientras: no se publica
      const i = b.lights.findIndex((bl) => bl.light.id === l.id);
      if (i >= 0) b.lights.splice(i, 1);
      if (zone) b.lights.push(zone);
      return true;
    },
  };
}

// Los trabajos de lo que haya cambiado (solo vóxeles) desde el último horneado
// El cielo (y las luces con nearLights: false) van detrás de todos los recuadros y nunca cuentan como "cercanos" para
// el presupuesto aparte de FrameBudget (near.below): su prioridad empieza aquí
export const LIGHT_PRIORITY = 10000;

// near (opcional): dónde está el jugador (x, y del mundo). Los trabajos llevan entonces prioridad (ViewJob.priority, la
// distancia en píxeles de pantalla): FrameBudget hace antes lo más cercano, aunque haya trabajo viejo en la cola.
// Las luces que cambian por el MUNDO (una nueva, o un trozo picado o puesto a su alcance), con el mismo criterio que los
// recuadros (la distancia de la luz en pantalla): una antorcha puesta junto al jugador va con el presupuesto cercano y
// se ve encendida en pocos cuadros. No se adelantan a sus recuadros: esperan a que se publiquen sin gastar nada. Las que
// solo toca de rebote un corte de vista (escrituras de vista: StaticVoxels.viewWrites) van detrás, como el cielo: un
// corte bajo unas antorchas no tiene que quitarle el cercano a sus recuadros. nearLights: false, todas detrás
export function rebakeChangedJobs(b: Baked, lights: readonly WorldLight[], opts: { near?: { x: number; y: number }; nearLights?: boolean; shape?: RebakeShape } = {}): ViewJob[] {
  const since = b.version;
  const { chunks, boxes } = changedBoxes(b);
  // Los trozos que cambiaron por el mundo (no solo por un corte de vista)
  const worldChunks = chunks.filter((c) => b.source.worldChangedSince(c, since));
  const jobs = rebakeJobs(b, chunks, lights, boxes, opts.shape);
  const n = opts.near;
  // Lo expuesto que el horneado inicial no preparó: una vez, sin prioridad (detrás de todo)
  const extra: ViewJob[] = [];
  if (b.exposurePending) { b.exposurePending = false; extra.push(exposureJob(b, n)); }
  if (!n) return [...jobs, ...extra];
  const s = b.source, h = s.height[Math.max(0, Math.min(s.depth - 1, Math.floor(n.y))) * s.width + Math.max(0, Math.min(s.width - 1, Math.floor(n.x)))]!;
  const [px, py] = b.cam.project(n.x, n.y, h);
  const byId = new Map<string, WorldLight>(lights.map((l) => [`light:${l.id}`, l]));
  return jobs.map((j) => {
    let p = 0;
    const m = j.key.match(/^rect:(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/), sk = j.key.match(/^sky:(-?\d+),(-?\d+),(-?\d+),(-?\d+)$/);
    // El cielo, como las luces: detrás de los recuadros y sin contar como cercano
    if (sk) p = LIGHT_PRIORITY + Math.hypot(Math.max(0, +sk[1]! - px, px - +sk[3]!), Math.max(0, +sk[2]! - py, py - +sk[4]!));
    else if (m) p = Math.hypot(Math.max(0, +m[1]! - px, px - +m[3]!), Math.max(0, +m[2]! - py, py - +m[4]!));
    else {
      const l = byId.get(j.key.split('#')[0]!);
      if (l) {
        const [lx, ly] = b.cam.project(l.x, l.y, l.z);
        // Cercana si es nueva (su trabajo es el de hornearla entera: key sin #) o si un trozo cambiado por el mundo cae a
        // su alcance
        const fresh = !j.key.includes('#'), r = resolveLight(l, 0).radius, C = CHUNK;
        const byWorld = fresh || worldChunks.some((c) => {
          const x0 = (c % s.cols) * C, y0 = Math.floor(c / s.cols) * C;
          return !(l.x + r < x0 || l.x - r > x0 + C || l.y + r < y0 || l.y - r > y0 + C);
        });
        p = (opts.nearLights === false || !byWorld ? LIGHT_PRIORITY : 0) + Math.hypot(lx - px, ly - py);
      }
    }
    return { key: j.key, priority: p, run: (d: number) => j.run(d), ...(j.waiting ? { waiting: () => j.waiting!() } : {}) } as ViewJob;
  }).concat(extra);
}

// Prepara lo expuesto de todo el mundo (StaticVoxels.warmExposed), trozo a trozo y de dentro hacia fuera desde `near`
// (si lo hay), por tandas de filas, mirando el plazo entre tandas. Lo que ya hizo una franja (o este trabajo) no se
// rehace: warmExposed solo hace las filas que faltan. Así los cortes y los golpes encuentran hechas las máscaras que el
// horneado inicial no hizo, y su franja no las paga dentro de su plazo
let exposureSerial = 0;
function exposureJob(b: Baked, near?: { x: number; y: number }): ViewJob {
  const s = b.source, n = s.cols * s.rows, order: number[] = [];
  for (let c = 0; c < n; c++) order.push(c);
  if (near) {
    const d = (c: number) => Math.hypot((c % s.cols) * CHUNK + CHUNK / 2 - near.x, Math.floor(c / s.cols) * CHUNK + CHUNK / 2 - near.y);
    order.sort((p, q) => d(p) - d(q) || p - q);
  }
  let k = 0, batches = 0, retried = false, since = s.clock, moved = 0;
  const most = warmBatches(s, { x0: 0, y0: 0, x1: CHUNK - 1, y1: CHUNK - 1 });
  // La ventana viva: al correrse, las máscaras caducan todas (StaticVoxels.shift / shiftJob) y el orden y las regiones de
  // este trabajo son de antes. Se para (sin volver a pedirse): lo que haga falta lo preparan las franjas del rehorneado,
  // con su plazo. Antes seguía, contaba las tandas de antes del corrimiento contra el tope del trozo y acababa en "lo
  // expuesto no acaba" (FERN, abierto a 1x: el trabajo duraba ~6 s y cruzaba una docena de corrimientos)
  const shifts = b.shifts ?? 0;
  return {
    key: `exposure:${++exposureSerial}`,
    run(deadline) {
      if ((b.shifts ?? 0) !== shifts) return true;
      if (b.shiftHold) return false;
      while (k < order.length) {
        const c = order[k]!, x0 = (c % s.cols) * CHUNK, y0 = Math.floor(c / s.cols) * CHUNK;
        const region = { x0, y0, x1: Math.min(s.width - 1, x0 + CHUNK - 1), y1: Math.min(s.depth - 1, y0 + CHUNK - 1) };
        for (; !s.warmExposed(region, WARM_ROWS); batches++) {
          // Si la cuenta se pasa del tope (un fallo: no debería), se apunta y se rehace el trozo desde cero una vez; si
          // vuelve a pasar, se salta (lo que falte lo hace forEachExposed al recorrer). Sin parar el juego ni colgarse
          if (batches > most) {
            // Si el trozo o un vecino cambió desde que se empezó (se escribió un trozo de la ventana, un corte, un golpe),
            // sus máscaras caducaron a mitad: no es un fallo, se vuelve a empezar con él sin apuntar nada (tres veces
            // como mucho; FERN veía 0-2 avisos por carga tras morir lejos con la casa de muñecas)
            const ch = s.changedSince(since), cx = c % s.cols, cy = Math.floor(c / s.cols);
            const near = (q: number) => Math.abs((q % s.cols) - cx) + Math.abs(Math.floor(q / s.cols) - cy) <= 1;
            if (moved < 3 && ch.some(near)) { moved++; batches = 0; since = s.clock; }
            else {
              exposureFault(`el trabajo de lo expuesto: ${batches} tandas en el trozo ${c}, que tiene como mucho ${most}${retried ? '; se salta' : '; se rehace'}`);
              if (retried) break;
              retried = true; batches = 0;
            }
          }
          if (performance.now() >= deadline) return false;
        }
        k++; batches = 0; retried = false; moved = 0; since = s.clock;
        if (performance.now() >= deadline) break;
      }
      return k >= order.length;
    },
  };
}

// Los trozos cambiados desde el último horneado y la caja de lo cambiado en cada uno; pone b.version al día
function changedBoxes(b: Baked): { chunks: number[]; boxes: Map<number, Box3> } {
  const s = b.source, chunks = s.changedSince(b.version), boxes = new Map<number, Box3>();
  for (const c of chunks) { const k = s.changedBox(c, b.version); if (k) boxes.set(c, k); }
  s.cut();
  b.version = s.clock;
  return { chunks, boxes };
}

// MOVER LA VENTANA (la ventana viva): corre el mundo horneado dcx, dcy trozos de vóxeles hacia atrás (b.source.shift) y
// su imagen con él, sin rehornear lo que se queda: la imagen se corre -dcx * CHUNK columnas y +a * dcy * CHUNK filas (lo
// que entra, vacío), la profundidad y las claves de vóxel (pick) se ponen en las coordenadas nuevas, lo que se ve de
// vóxeles que salieron se borra, y cada luz fija pasa a su sitio nuevo con su zona recortada otra vez y sus pesos (la que
// gana píxeles por el borde se hornea de nuevo). Lo que entra y el borde nuevo quedan como cambiados: rebakeChanged /
// rebakeChangedJobs con las luces ya corridas los rehace. Las luces del estado las corre quien llama (las mismas
// -dcx * CHUNK, -dcy * CHUNK). Las copias de la imagen (la GPU) la vuelven a subir.
// De una vez (shiftBaked) o por pasos en la cola (shiftBakedJob): la imagen nueva se hace en otro búfer, por bandas de
// filas, mientras se sigue componiendo (y rehorneando) la vieja; al acabar se cambia de golpe (con los vóxeles y las
// luces). Lo rehorneado en la vieja mientras tanto se vuelve a copiar antes del cambio, y el cambio espera a que no
// quede rehorneado a medias. Cruzar otro borde antes de acabar: merge, que suma el corrimiento y empieza la copia otra vez
// Descarta el rehorneado de la cola (sus trabajos acaban sin hacer nada) y devuelve las cajas de lo que iba a rehacer
export function cancelRebakes(b: Baked): Plan[] {
  const plans = [...(b.pendingPlans?.values() ?? [])].flat();
  b.rebakeEpoch = (b.rebakeEpoch ?? 0) + 1;
  b.rectsBusy?.clear(); b.lightWork?.clear(); b.pendingLights?.clear(); b.pendingPlans?.clear();
  return plans;
}

export function shiftBaked(b: Baked, dcx: number, dcy: number): void {
  const j = shiftBakedJob(b, dcx, dcy);
  while (!j.run(Infinity));
}

export interface ShiftJob {
  readonly key: string;
  readonly priority?: number;
  run(deadline: number): boolean;
  merge(dcx: number, dcy: number): void;        // otro corrimiento antes de acabar: se suma
  readonly done: boolean;
  readonly shift: readonly [number, number];      // el corrimiento total (trozos de vóxeles)
  readonly ms: { voxels: number; recopy: number; swap: number };   // lo que costaron el corrimiento de los vóxeles, la recopia y el cambio
  // Con opts.manual: run acaba (true) al tenerlo todo preparado, sin cambiar; el cambio lo hace quien llama, de una vez
  // con otros (los giros de la ventana viva): canCommit() en todos (pone al día lo rehorneado mientras tanto; false si hay
  // que esperar o si hay que volver a preparar, y entonces prepared vuelve a false y hay que volver a encolarlo) y, si
  // todos pueden, commit() en todos
  readonly prepared: boolean;
  canCommit(): boolean;
  commit(): void;
}

type ImageBuffers = { rgba: Uint8ClampedArray<ArrayBuffer>; depth: Float32Array; face: Int8Array; pick: Float64Array; sky: Uint8Array | undefined };
const BACK = new WeakMap<Baked, ImageBuffers>();

// opts.onSwitch: se llama en el cambio, con los vóxeles y la imagen ya corridos, para correr en el mismo momento lo que va
// en coordenadas de la ventana (la rejilla de bloques, las entidades, las luces): el juego nunca ve un cuadro mezclado
export function shiftBakedJob(b: Baked, dcx: number, dcy: number, opts: { band?: number; priority?: number; key?: string; manual?: boolean; onSwitch?(dcx: number, dcy: number): void } = {}): ShiftJob {
  const W = b.width, H = b.height, a = b.options.oblique?.y ?? 1, band = opts.band ?? 64;
  let tx = dcx, ty = dcy, next = 0, halo = 0, start = b.published.serial, done = false, held = false;
  // El búfer de atrás: el de la imagen de antes del último cambio, si lo hay (se turnan)
  let back = BACK.get(b);
  if (!back || back.rgba.length !== b.rgba.length) {
    back = { rgba: new Uint8ClampedArray(W * H * 4), depth: new Float32Array(W * H), face: new Int8Array(W * H), pick: new Float64Array(W * H), sky: b.sky ? new Uint8Array(W * H) : undefined };
  }
  const bk = back;
  const gone = new Uint8Array(W * H);
  // La caja de lo borrado (vóxeles que salieron y su contorno), en la imagen nueva: se publica para las copias
  let gx0 = W, gy0 = H, gx1 = -1, gy1 = -1;
  const mark = (x: number, y: number) => { if (x < gx0) gx0 = x; if (x > gx1) gx1 = x; if (y < gy0) gy0 = y; if (y > gy1) gy1 = y; };
  const s = b.source;
  const par = () => {
    const DX = tx * CHUNK, DY = ty * CHUNK, rows = a * DY;
    if (!Number.isInteger(rows)) throw new Error(`shiftBaked: el corrimiento en filas (${rows}) no es entero`);
    return { DX, DY, rows, dd: DY * b.cam.fwd[1], dk: key(DX, DY, 0) - key(0, 0, 0) };
  };
  let P = par();
  // Copia las filas y0..y1 de la imagen nueva desde la de ahora (corrida, con la profundidad y las claves puestas al día,
  // y lo de vóxeles que salieron borrado)
  // (x0..x1: solo esas columnas; la recopia de un recuadro publicado no rehace filas enteras)
  const copyRows = (y0: number, y1: number, x0 = 0, x1 = W - 1) => {
    const { DX, rows, dd, dk } = P, sw = s.width, sd = s.depth;
    x0 = Math.max(0, x0); x1 = Math.min(W - 1, x1);
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      const sy = y - rows, o = y * W;
      gone.fill(0, o + x0, o + x1 + 1);
      for (let x = x0; x <= x1; x++) {
        const i = o + x, sx = x + DX;
        if (sy < 0 || sy >= H || sx < 0 || sx >= W) {
          bk.rgba[i * 4] = 0; bk.rgba[i * 4 + 1] = 0; bk.rgba[i * 4 + 2] = 0; bk.rgba[i * 4 + 3] = 0;
          bk.depth[i] = Infinity; bk.face[i] = -1; bk.pick[i] = NaN; if (bk.sky) bk.sky[i] = SKY_RAYS;
          continue;
        }
        const si = sy * W + sx;
        const k = b.pick[si]!;
        let out = false;
        if (k === k) {
          const k2 = k - dk, r = Math.floor(k2 / KEY_SPAN), vy = (r % KEY_SPAN) - KEY_OFF, vx = Math.floor(r / KEY_SPAN) - KEY_OFF;
          out = vx < 0 || vy < 0 || vx >= sw || vy >= sd;
          bk.pick[i] = out ? NaN : k2;
        } else bk.pick[i] = NaN;
        if (out) {
          bk.rgba[i * 4] = 0; bk.rgba[i * 4 + 1] = 0; bk.rgba[i * 4 + 2] = 0; bk.rgba[i * 4 + 3] = 0;
          bk.depth[i] = Infinity; bk.face[i] = -1; if (bk.sky) bk.sky[i] = SKY_RAYS; gone[i] = 1; mark(x, y);
          continue;
        }
        bk.rgba[i * 4] = b.rgba[si * 4]!; bk.rgba[i * 4 + 1] = b.rgba[si * 4 + 1]!; bk.rgba[i * 4 + 2] = b.rgba[si * 4 + 2]!; bk.rgba[i * 4 + 3] = b.rgba[si * 4 + 3]!;
        const d = b.depth[si]!;
        bk.depth[i] = d === Infinity ? d : d - dd;
        bk.face[i] = b.face[si]!;
        if (bk.sky) bk.sky[i] = b.sky![si]!;
      }
    }
  };
  // El contorno de fuera pegado a lo borrado (no tiene vóxel): las filas y0..y1 (con sus vecinas ya copiadas)
  const haloRows = (y0: number, y1: number, x0 = 0, x1 = W - 1) => {
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const i = y * W + x;
      if (gone[i] || bk.pick[i] === bk.pick[i] || !bk.rgba[i * 4 + 3]) continue;
      if ((x > 0 && gone[i - 1]) || (x < W - 1 && gone[i + 1]) || (y > 0 && gone[i - W]) || (y < H - 1 && gone[i + W])) {
        bk.rgba[i * 4] = 0; bk.rgba[i * 4 + 1] = 0; bk.rgba[i * 4 + 2] = 0; bk.rgba[i * 4 + 3] = 0;
        bk.depth[i] = Infinity; bk.face[i] = -1; if (bk.sky) bk.sky[i] = SKY_RAYS; mark(x, y);
      }
    }
  };
  // Los vóxeles, preparados también por pasos en otros búferes (StaticVoxels.shiftJob): en el cambio solo se cambian
  let vox = s.shiftJob(tx, ty);
  b.shifting = true;
  const voxPerBand = Math.ceil(s.rows / Math.ceil(H / band)) + 1;        // filas de trozos por banda: acaban con las bandas
  const restart = () => { next = 0; halo = 0; start = b.published.serial; P = par(); gx0 = W; gy0 = H; gx1 = -1; gy1 = -1; vox = s.shiftJob(tx, ty); };
  // Lo rehorneado en la imagen de ahora desde que se copió: se vuelve a copiar (con su contorno); false si ya no se sabe
  const recopy = (): boolean => {
    const pub = b.published;
    if (pub.serial === start) return true;
    const oldest = pub.rects.length ? pub.rects[0]!.serial : Infinity;
    if (oldest > start + 1) { restart(); return false; }
    for (const r of pub.rects) {
      if (r.serial <= start) continue;
      // (en la imagen nueva, lo de la columna x de ahora va a x - DX)
      const y0 = r.y0 + P.rows - 1, y1 = r.y1 + P.rows + 1, x0 = r.x0 - P.DX - 1, x1 = r.x1 - P.DX + 1;
      copyRows(y0, y1, x0, x1); haloRows(y0 - 1, y1 + 1, x0 - 1, x1 + 1);
    }
    start = pub.serial;
    return true;
  };
  const commit = () => {
    const v0 = performance.now();
    // Lo que quedaba por rehornear se descarta y se vuelve a marcar, en su sitio nuevo, como cambiado
    const plans = cancelRebakes(b);
    vox.commit();
    const marked = new Set<number>(), m = (b.options.smooth ?? 0.6) > 0 ? 3 : 1;   // (el margen que chunkRect sumó a la caja)
    for (const p of plans) {
      const cx0 = Math.floor(Math.min(p.X1, p.X0 + m) / CHUNK), cx1 = Math.floor(Math.max(p.X0, p.X1 - m) / CHUNK);
      const cy0 = Math.floor(Math.min(p.Y1, p.Y0 + m) / CHUNK), cy1 = Math.floor(Math.max(p.Y0, p.Y1 - m) / CHUNK);
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const nx = cx - tx, ny = cy - ty;
        if (nx < 0 || ny < 0 || nx >= s.cols || ny >= s.rows) continue;
        const c = ny * s.cols + nx;
        if (!marked.has(c)) { marked.add(c); s.touch(c); }
      }
    }
    job.ms.voxels = performance.now() - v0;
    held = true;
    const w0 = performance.now();
    swap();
    opts.onSwitch?.(tx, ty);
    job.ms.swap = performance.now() - w0;
  };
  const job: ShiftJob = {
    key: opts.key ?? 'shift',
    ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    get done() { return done; },
    get shift() { return [tx, ty] as const; },
    get prepared() { return !done && (!tx && !ty || (next >= H && halo >= H)); },
    canCommit() {
      if (done || !job.prepared) return false;
      const r0 = performance.now();
      if (!recopy()) return false;
      job.ms.recopy = performance.now() - r0;
      return true;
    },
    commit() {
      if (done) throw new Error('shiftBakedJob: ya acabó');
      if (!tx && !ty) { done = true; return; }
      commit();
    },
    ms: { voxels: 0, recopy: 0, swap: 0 },
    merge(x: number, y: number) {
      if (done) throw new Error('shiftBakedJob: ya acabó');
      // (con los vóxeles ya corridos, otro corrimiento: lo hará otro trabajo después de este)
      if (held) throw new Error('shiftBakedJob: los vóxeles ya se corrieron; corre la ventana otra vez al acabar');
      tx += x; ty += y; restart();
    },
    run(deadline: number): boolean {
      if (done) return true;
      if (!tx && !ty) { if (!opts.manual) done = true; return true; }
      do {
        if (next < H) {
          copyRows(next, next + band - 1);
          next += band;
          for (let k = 0; k < voxPerBand; k++) vox.step();
          // El contorno de las filas cuyas vecinas ya están
          haloRows(halo, Math.min(H, next) - 2);
          halo = Math.max(halo, Math.min(H, next) - 1);
          continue;
        }
        if (halo < H) { haloRows(halo, H - 1); halo = H; continue; }
        // (manual: ya preparado; lo que se publique mientras espera el cambio se recopia aquí, por llamadas, y no todo en el
        // cuadro del cambio)
        if (opts.manual) { if (!recopy()) continue; return true; }
        // Lo rehorneado mientras tanto; y el cambio, cuando no quede rehorneado a medias
        // El cambio, de una vez (los vóxeles, la imagen y lo de onSwitch): un estado a medias (vóxeles corridos y entidades
        // sin correr) haría que el juego leyera mal un cuadro. Con los vóxeles preparados en el otro búfer, cuesta poco
        const r0 = performance.now();
        if (!recopy()) continue;
        job.ms.recopy = performance.now() - r0;
        commit();
        return true;
      } while (performance.now() < deadline);
      return false;
    },
  };
  const swap = () => {
    const { DX, DY, rows } = P;
    const front: ImageBuffers = { rgba: b.rgba, depth: b.depth, face: b.face, pick: b.pick, sky: b.sky };
    b.rgba = bk.rgba; b.depth = bk.depth; b.face = bk.face; b.pick = bk.pick; if (bk.sky) b.sky = bk.sky;
    BACK.set(b, front);
    shiftLights(b, DX, DY, rows);
    b.published.serial += 2;
    b.published.rects = gx1 >= 0 ? [{ serial: b.published.serial, x0: gx0, y0: gy0, x1: gx1, y1: gy1 }] : [];
    b.published.forgotten = [];
    b.lastShift = { serial: b.published.serial, dx: DX, rows, dd: P.dd, dy: DY };
    b.shifts = (b.shifts ?? 0) + 1;
    b.shiftHold = false;
    b.shifting = false;
    done = true;
  };
  return job;
}

// Las luces fijas, en su sitio nuevo: la zona recortada otra vez y los pesos que siguen dentro; la que gana píxeles por el
// borde (estaba recortada) se quita, y el rehorneado la hace de nuevo entera
function shiftLights(b: Baked, DX: number, DY: number, rows: number): void {
  const kept: BakedLight[] = [];
  for (const bl of b.lights) {
    const l = { ...bl.light, x: bl.light.x - DX, y: bl.light.y - DY };
    const z = lightZone(b, l);
    if (!z) continue;
    const o = bl.rect;
    if (z.rect.x + DX < o.x || z.rect.y - rows < o.y || z.rect.x + z.rect.w + DX > o.x + o.w || z.rect.y + z.rect.h - rows > o.y + o.h) continue;
    for (let j = 0; j < z.rect.h; j++) {
      const oy = z.rect.y + j - rows - o.y;
      for (let i = 0; i < z.rect.w; i++) z.weight[j * z.rect.w + i] = bl.weight[oy * o.w + z.rect.x + i + DX - o.x]!;
    }
    kept.push(z);
  }
  b.lights = kept;
  b.lightWork?.clear();
}

// Rehornea lo que haya cambiado (solo vóxeles) desde el último horneado
export function rebakeChanged(b: Baked, lights: readonly WorldLight[]): { chunks: number; pixels: number; lights: number } {
  const { chunks, boxes } = changedBoxes(b);
  const r = rebake(b, chunks, lights, boxes);
  return { chunks: chunks.length, ...r };
}

// Luz total (ambiente + fuentes con su parpadeo en `time`) de una ventana de la imagen horneada
export function lightView(b: Baked, vx: number, vy: number, vw: number, vh: number, ambient: readonly [number, number, number], time: number, cave?: readonly [number, number, number] | null): Float32Array {
  const total = new Float32Array(vw * vh * 3);
  if (cave && b.sky) {
    // La luz ambiente de cada píxel según su cielo (skyAmbient: la misma tabla que la GPU)
    const t = skyAmbient(ambient, cave), sky = b.sky;
    for (let y = 0; y < vh; y++) for (let x = 0; x < vw; x++) {
      const gx = vx + x, gy = vy + y, k = gx >= 0 && gy >= 0 && gx < b.width && gy < b.height ? sky[gy * b.width + gx]! : SKY_RAYS, o = (y * vw + x) * 3;
      total[o] = t[k * 3]!; total[o + 1] = t[k * 3 + 1]!; total[o + 2] = t[k * 3 + 2]!;
    }
  } else for (let i = 0; i < vw * vh; i++) { total[i * 3] = ambient[0]; total[i * 3 + 1] = ambient[1]; total[i * 3 + 2] = ambient[2]; }
  for (const bl of b.lights) {
    const r = bl.rect;
    const ix0 = Math.max(vx, r.x), iy0 = Math.max(vy, r.y), ix1 = Math.min(vx + vw, r.x + r.w), iy1 = Math.min(vy + vh, r.y + r.h);
    if (ix0 >= ix1 || iy0 >= iy1) continue;
    const k = resolveLight(bl.light, time).intensity / bl.intensity;
    const [cr, cg, cb] = bl.color;
    for (let y = iy0; y < iy1; y++) {
      const src = (y - r.y) * r.w - r.x, dst = (y - vy) * vw - vx;
      for (let x = ix0; x < ix1; x++) {
        const w = bl.weight[src + x]!;
        if (!w) continue;
        const o = (dst + x) * 3, kw = w * k;
        total[o] = total[o]! + cr * kw; total[o + 1] = total[o + 1]! + cg * kw; total[o + 2] = total[o + 2]! + cb * kw;
      }
    }
  }
  return total;
}

// La inversa de la proyección oblicua de la imagen horneada: de una fila de píxeles y su profundidad, el punto del
// mundo (en la proyección oblicua la pantalla y la profundidad son dos ecuaciones lineales en y, z). UNA sola fórmula:
// la usan worldPointAt, la luz dinámica de la CPU (por píxel, sin crear nada) y fillWorldY de la GPU.
export interface Unproject { a: number; O: number; f2: number; den: number }
export function unprojector(b: Baked): Unproject {
  const a = b.options.oblique?.y ?? 1, f1 = b.cam.fwd[1], f2 = b.cam.fwd[2];
  return { a, O: b.options.originY, f2, den: a * f2 - f1 };
}
export const rowP = (u: Unproject, sy: number): number => u.O - (sy + 0.5);                  // = a*y + z de la fila
export const worldYAt = (u: Unproject, P: number, d: number): number => (P * u.f2 - d) / u.den;

// El punto del mundo que se ve en un píxel de la imagen horneada. null si ahí no hay nada.
export function worldPointAt(b: Baked, sx: number, sy: number): [number, number, number] | null {
  const d = b.depth[sy * b.width + sx]!;
  if (d === Infinity) return null;
  const u = unprojector(b), P = rowP(u, sy), y = worldYAt(u, P, d);
  return [sx, y, P - u.a * y];
}
