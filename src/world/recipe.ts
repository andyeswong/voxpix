// RECETA DE MUNDO (NARUTO, pedido de Andrés): un mundo entero descrito en DATOS (JSON), para que un agente lo construya
// sin escribir código: el generador y la semilla, los colores de cada papel, las columnas y los muebles como modelos de
// vóxeles estampados, la vegetación, modelos sueltos, luces y efectos. buildRecipe la convierte en layout + mundo +
// estado con las mismas piezas que usa el código (buildWorldState, WorldLook, planFoliage). La misma receta da siempre
// el mismo mundo. Quien escriba código puede pasar además constructores (funciones) en `code`.
import { decode, material, MAX_RAMPS, Model, planFoliage, lilyPadModels, FOLIAGE_RAMPS, FOLIAGE_DEFAULTS, FOLIAGE_TYPES,
  FX_PRESETS, type FoliageType, type FxPreset, type ModelFile, type Palette, type Ramp } from '../core';
import { generateLayout, TILE, type Layout } from '../worldgen';
import type { GeneratorSpec } from '../worldgen/spec';
import { buildWorldState, worldPalette, worldWaterDepth, M, type World, type WorldLight, type WorldLook, type WorldRampSpec, type WorldRole,
  type PillarBuilder, type PropBuilder } from './build';
import type { StaticVoxels, WorldState } from './state';
import { bakeWorld } from './bake';
import { frame2D } from './frame2d';

// Un modelo puesto en el mundo: su origen (0, 0, 0) va a (x, y, z), en ejes del modelo del mundo; yaw en grados (de 90 en 90)
export interface StampSpec { model: ModelFile; x: number; y: number; z?: number; yaw?: number }

// Vegetación con planFoliage: las rampas por NOMBRE (si falta alguna de las de FOLIAGE_RAMPS, se añade)
export interface FoliageRecipe {
  type: FoliageType;
  density?: number;
  seed?: number;                 // por defecto, la semilla de la receta
  ramp?: string;                 // la de la planta; por defecto la del tipo (FOLIAGE_DEFAULTS)
  heads?: string[];              // flores: las de las cabezas
  on?: string[];                 // rampas sobre las que crece; por defecto las de hierba
}

// Una luz de la receta: fija (horneada), en ejes del modelo
export type RecipeLight = Omit<WorldLight, 'id' | 'baked' | 'follow' | 'owner'> & { id?: string };

export interface WorldRecipe {
  seed: number;
  generator: GeneratorSpec;
  ramps?: Partial<Record<WorldRole, WorldRampSpec>>;      // los colores de cada papel (worldPalette); el agua emisiva brilla
  fountain?: boolean;
  pillar?: 'round' | 'none' | ModelFile;                   // un modelo: se estampa centrado en cada loseta de columna (z = 0)
  prop?: 'block' | 'none' | ModelFile;                     // un modelo: centrado en la huella de cada mueble (z = 0)
  foliage?: FoliageRecipe[];
  stamps?: StampSpec[];
  lights?: RecipeLight[];
  effects?: Array<{ preset: FxPreset; x: number; y: number; z: number }>;
  ambient?: readonly [number, number, number];             // la luz ambiente para pintarlo (no entra en el mundo)
}

export interface BuiltRecipe { layout: Layout; world: World; state: WorldState; look: WorldLook; ambient: readonly [number, number, number] }

// Los colores de una paleta del mundo (en el orden de M) como rampas de receta: para partir de un look ya hecho
export function rampsOf(p: Palette): Partial<Record<WorldRole, WorldRampSpec>> {
  const out: Partial<Record<WorldRole, WorldRampSpec>> = {};
  for (const [role, i] of Object.entries(M) as Array<[WorldRole, number]>) {
    const r = p.ramps[i];
    if (!r) continue;
    out[role] = r.emissive || r.material || r.props ? { colors: [...r.colors], ...(r.material ? { material: r.material } : {}), ...(r.emissive ? { emissive: true } : {}), ...(r.props ? { props: { ...r.props } } : {}) } : [...r.colors];
  }
  return out;
}

// Añade a la paleta las rampas de un modelo (las iguales, por nombre y colores, se reutilizan). Devuelve la paleta nueva
// y, por cada rampa del modelo, su índice en ella
function mergeRamps(p: Palette, ramps: readonly Ramp[], what: string): { palette: Palette; map: number[] } {
  const out = [...p.ramps];
  const map = ramps.map((r) => {
    const same = out.findIndex((o) => o.name === r.name && o.colors.join() === r.colors.join() && !!o.emissive === !!r.emissive && o.material === r.material);
    if (same >= 0) return same;
    out.push(structuredClone(r));
    return out.length - 1;
  });
  if (out.length > MAX_RAMPS) throw new Error(`${what}: la paleta del mundo pasaría de ${MAX_RAMPS} rampas (${out.length}); usa menos rampas en los modelos`);
  return { palette: { ...p, ramps: out }, map };
}

// Pone un modelo en el mundo, con sus materiales llevados a la paleta del mundo (map) y girado de 90 en 90
function stampInto(target: StaticVoxels, m: Model, map: number[], x0: number, y0: number, z0: number, yaw = 0): number {
  const q = (((Math.round(yaw / 90) % 4) + 4) % 4);
  let n = 0;
  for (const [x, y, z, v] of m.entries()) {
    const { ramp, tone } = decode(v);
    const [rx, ry] = q === 0 ? [x, y] : q === 1 ? [-y, x] : q === 2 ? [-x, -y] : [y, -x];
    const X = x0 + rx, Y = y0 + ry, Z = z0 + z;
    if (X < 0 || Y < 0 || X >= target.width || Y >= target.depth || Z < target.zMin || Z > target.zMax) continue;
    target.set(X, Y, Z, material(map[ramp]!, tone));
    n++;
  }
  return n;
}

const modelOf = (f: ModelFile, what: string): Model => {
  try { return Model.fromJSON(f); } catch (e) { throw new Error(`${what}: no es un modelo de voxpix (${(e as Error).message})`); }
};

// La receta comprobada: los errores dicen qué falta, como la API del editor
export function checkRecipe(r: WorldRecipe): void {
  if (!r || typeof r !== 'object') throw new Error('la receta es un objeto: { seed, generator, ... }');
  if (!Number.isFinite(r.seed)) throw new Error('la receta necesita seed (un número)');
  if (!r.generator || !Number.isFinite(r.generator.cols) || !Number.isFinite(r.generator.rows)) throw new Error('la receta necesita generator (un GeneratorSpec con cols, rows, floors, facade, water...)');
  for (const k of Object.keys(r.ramps ?? {})) if (!(k in M)) throw new Error(`no hay papel "${k}" en ramps; los papeles son: ${Object.keys(M).join(', ')}`);
  for (const f of r.foliage ?? []) if (!FOLIAGE_TYPES.includes(f.type)) throw new Error(`no hay vegetación "${f.type}"; los tipos son: ${FOLIAGE_TYPES.join(', ')}`);
  for (const e of r.effects ?? []) if (!FX_PRESETS[e.preset]) throw new Error(`no hay efecto "${e.preset}"; los efectos son: ${Object.keys(FX_PRESETS).join(', ')}`);
}

export function buildRecipe(r: WorldRecipe, code: Partial<WorldLook> = {}): BuiltRecipe {
  checkRecipe(r);
  const layout = generateLayout(r.generator, r.seed);
  let palette = worldPalette(r.ramps);
  // Columnas y muebles de modelo: sus rampas entran en la paleta antes de construir (se estampan al construir)
  let pillar: PillarBuilder | null | undefined = r.pillar === 'none' ? null : undefined;
  if (r.pillar && typeof r.pillar === 'object') {
    const m = modelOf(r.pillar, 'pillar');
    const merged = mergeRamps(palette, m.palette.ramps, 'pillar');
    palette = merged.palette;
    pillar = ({ model, x0, y0 }) => { stampInto(model, m, merged.map, x0 + TILE / 2, y0 + TILE / 2, 0); };
  }
  let prop: PropBuilder | null | undefined = r.prop === 'none' ? null : undefined;
  if (r.prop && typeof r.prop === 'object') {
    const m = modelOf(r.prop, 'prop');
    const merged = mergeRamps(palette, m.palette.ramps, 'prop');
    palette = merged.palette;
    prop = ({ model, x0, x1, yS, yN }) => { stampInto(model, m, merged.map, Math.floor((x0 + x1 + 1) / 2), Math.floor((yS + yN + 1) / 2), 0); };
  }
  const look: WorldLook = { ...code, palette, fountain: r.fountain ?? code.fountain ?? false,
    ...(pillar !== undefined ? { pillar } : code.pillar !== undefined ? { pillar: code.pillar } : {}),
    ...(prop !== undefined ? { prop } : code.prop !== undefined ? { prop: code.prop } : {}) };

  const decorate = (w: World) => {
    const m = w.model;
    // Los modelos sueltos
    for (const [k, s] of (r.stamps ?? []).entries()) {
      const sm = modelOf(s.model, `stamps[${k}]`);
      const merged = mergeRamps(m.palette, sm.palette.ramps, `stamps[${k}]`);
      m.palette = merged.palette;
      stampInto(m, sm, merged.map, Math.round(s.x), Math.round(s.y), Math.round(s.z ?? m.walkAt(Math.round(s.x), Math.round(s.y))), s.yaw);
    }
    // La vegetación, en el orden de la receta
    const ensure = (name: string): number => {
      const i = m.palette.ramps.findIndex((x) => x.name === name);
      if (i >= 0) return i;
      const def = FOLIAGE_RAMPS[name];
      if (!def) throw new Error(`no hay rampa "${name}" en el mundo ni entre las de vegetación (${Object.keys(FOLIAGE_RAMPS).join(', ')})`);
      const merged = mergeRamps(m.palette, [def], `foliage ${name}`);
      m.palette = merged.palette;
      return merged.map[0]!;
    };
    const waterDepth = worldWaterDepth(w);
    for (const f of r.foliage ?? []) {
      const names = FOLIAGE_DEFAULTS[f.type];
      const ramp = ensure(f.ramp ?? names[0]!);
      const heads = f.type === 'flowers' ? (f.heads ?? names.slice(1)).map(ensure) : undefined;
      const on = f.on?.map((n) => { const i = m.palette.ramps.findIndex((x) => x.name === n); if (i < 0) throw new Error(`foliage.on: no hay rampa "${n}"`); return i; });
      const plan = planFoliage(m, 0, 0, m.width - 1, m.depth - 1, m.zMax, { type: f.type, ramp, seed: f.seed ?? r.seed, zMin: m.zMin, waterDepth,
        ...(f.density !== undefined ? { density: f.density } : {}), ...(heads ? { heads } : {}), ...(on ? { on } : {}) });
      for (const [x, y, z, v] of plan.voxels) m.set(x, y, z, v);
      if (plan.floats.length) {
        const pads = lilyPadModels(m.palette.ramps[ramp]!);
        w.floaters = [...(w.floaters ?? []), ...plan.floats.map(([x, y, k]) => ({ x, y, model: pads[k]!, yaw: ((x * 7 + y * 13) % 8) * 45 }))];
      }
    }
    for (const [k, l] of (r.lights ?? []).entries()) w.lights.push({ ...l, id: l.id ?? `receta-${k}`, baked: true });
  };
  const { world, state } = buildWorldState(layout, look, { decorate });
  for (const e of r.effects ?? []) state.fx.add(e.preset, e.x, e.y, e.z);
  return { layout, world, state, look, ambient: r.ambient ?? [0.4, 0.46, 0.64] };
}

// Lo que un agente necesita saber de un mundo construido, en datos: tamaño, salida, dónde están las piezas del mapa
// (en ejes del modelo: x este, y norte), las luces, el agua y la paleta
export function describeWorld(b: Pick<BuiltRecipe, 'layout' | 'world' | 'state'>): Record<string, unknown> {
  const { layout: l, world: w, state: s } = b;
  const my = (py: number) => w.depth - 1 - py;
  const pillars: Array<[number, number]> = [];
  for (let cy = 0; cy < l.rows; cy++) for (let cx = 0; cx < l.cols; cx++) {
    const i = cy * l.cols + cx;
    if (l.pillar[i] && !l.prop[i]) pillars.push([cx * TILE + 8, my(cy * TILE + 8)]);
  }
  let wet = 0;
  if (s.water) for (let i = 0; i < s.water.sim.depth.length; i++) if (!s.water.sim.solid[i] && s.water.sim.depth[i]! >= 0.04) wet++;
  return {
    seed: l.seed, width: w.width, depth: w.depth, tile: TILE, cols: l.cols, rows: l.rows,
    spawn: [l.spawn.x, my(l.spawn.y)],
    pillars,
    props: l.props.map((p) => ({ anim: p.anim, x0: p.x * TILE, x1: (p.x + p.w) * TILE - 1, yS: my((p.y + p.h) * TILE - 1), yN: my(p.y * TILE) })),
    fountain: w.fountain ? { x: w.fountain.x, y: w.fountain.y, radius: w.fountain.radius } : null,
    facade: l.facade,
    lights: s.lights.map((x) => ({ id: x.id, kind: x.kind, x: x.x, y: x.y, z: x.z, baked: x.baked !== false })),
    waterCells: wet,
    floaters: s.floaters.list.length,
    ramps: s.solid.palette.ramps.map((r) => r.name),
    hash: s.hash(),
  };
}

// Una foto del mundo, sin GPU (la CPU del render 2D): la vista de width x height centrada en `at` (ejes del modelo; por
// defecto la salida), tras `ticks` pasos del mundo (el agua se asienta, las partículas salen). Devuelve RGBA
export function snapshotWorld(b: Pick<BuiltRecipe, 'layout' | 'world' | 'state' | 'ambient'>, o: {
  at?: readonly [number, number]; width?: number; height?: number; ticks?: number; lights?: boolean; outline?: 'none' | 'outer' | 'both';
  incline?: number; whole?: boolean;
} = {}): { width: number; height: number; rgba: Uint8ClampedArray } {
  const { world, state, layout } = b;
  for (let t = 0; t < (o.ticks ?? 0); t++) state.step();
  const baked = bakeWorld(world, { topZ: 40, incline: o.incline ?? 0.5, outline: o.outline ?? 'both' });
  let W = o.width ?? 384, H = o.height ?? 216, vx = 0, vy = 0;
  if (o.whole) { W = baked.width; H = baked.height; }
  else {
    const [x, y] = o.at ?? [layout.spawn.x, world.depth - 1 - layout.spawn.y];
    const [sx, sy] = baked.cam.project(x + 0.5, y, state.groundAt(Math.round(x), Math.round(y)));
    W = Math.min(W, baked.width); H = Math.min(H, baked.height);
    vx = Math.max(0, Math.min(baked.width - W, Math.floor(sx) - (W >> 1)));
    vy = Math.max(0, Math.min(baked.height - H, Math.floor(sy) - (H >> 1)));
  }
  const rgba = frame2D(state, baked, { vx, vy, vw: W, vh: H, time: 0, lights: o.lights ?? true, ambient: b.ambient, outline: o.outline ?? 'both' });
  return { width: W, height: H, rgba };
}
