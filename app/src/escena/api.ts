// API de MUNDOS para agentes (NARUTO, pedido de Andrés): window.voxpixWorld en la demo de escenario. Lo que hace la
// demo con el teclado, y construir un mundo entero desde una receta en datos (src/world/recipe.ts), sin escribir
// código. Se ve en vivo: el agente construye y la persona lo ve. Todo en ejes del modelo del mundo (x este, y norte,
// z arriba; 1 vóxel = 1 píxel del juego). Los errores dicen qué hacer, como window.voxpix en el editor.
import { FX_PRESETS, FOLIAGE_TYPES, Model, type FxPreset, type ModelFile } from '@core/index';
import { describeWorld, type WorldRecipe, type StampSpec, type RecipeLight } from '../../../src/world/recipe';
import { M } from '../../../src/world/build';
import { frame2D } from '../../../src/world/frame2d';
import { THEME_IDS, type ThemeId } from '../../../src/samples/themes';
import type { RecipeInput } from '../../../src/samples/recipes';
import type { Layout } from '../../../src/worldgen';
import type { World } from '../../../src/world/build';
import type { Baked } from '../../../src/world/bake';
import type { WorldState, Entity } from '../../../src/world/state';
import type { SourceKind } from '../../../src/lighting/lights';

export interface WorldApiContext {
  readonly state: WorldState | null;
  readonly world: World | null;
  readonly layout: Layout;
  readonly baked: Baked | null;
  readonly recipe: (WorldRecipe & { theme?: ThemeId }) | null;
  readonly mode: '2d' | 'voxel' | 'explore';
  readonly ambient: readonly [number, number, number];
  readonly theme: ThemeId;
  readonly seed: number;
  readonly maia: Entity | null;
  readonly lightsOn: boolean;
  readonly outline: 'outer' | 'both' | 'none';
  readonly vox: { yaw: number; elevation: number; zoom: number; dirty: boolean };
  readonly VW: number;
  readonly VH: number;
  build(r: RecipeInput | null): Promise<void>;
  goto(x: number, y: number): void;
  setMode(m: '2d' | 'voxel' | 'explore'): void;
  setWeather(w: string): void;
  setLights(on: boolean): void;
  frame3D(): Uint8ClampedArray;
  view(): { vx: number; vy: number };
}

const HELP = `voxpixWorld: construir y mirar mundos de vóxeles (ejes del modelo: x este, y norte, z arriba).
Construir (cada una reconstruye el mundo y devuelve una promesa con info()):
  build(receta)                 un mundo desde una receta. Con theme ('medieval', 'cyberpunk', 'oficina') se completa con
                                ese tema de muestra. Campos: seed, generator, shape (la forma de la sala: {kind: 'L'|'T'|
                                'corridors'|'maze'|'plan', ...}), ramps {papel: colores | {colors, emissive}},
                                fountain, wallHeight (alto de todas las paredes, 16), pillar ('round'|'none'|modelo), prop ('block'|'none'|modelo), foliage [{type,
                                density, ramp, heads, on}], stamps [{model, x, y, z?, yaw?}], lights [{kind, x, y, z,
                                radius?, intensity?, color?}], effects [{preset, x, y, z}], ambient [r, g, b]
  update(cambios)               la receta de ahora con esos campos cambiados (p. ej. { ramps: { water: [...] } })
  seed(n)                       la misma receta con otra semilla
  stamp(modelo, x, y, z?, yaw?) añade un modelo de vóxeles (un ModelFile, el JSON de voxpix) al mundo
  foliage(tipo, opciones?)      añade vegetación (tipos: ${FOLIAGE_TYPES.join(', ')})
  themes()                      vuelve a la demo con su tema (sin receta)
En vivo (sin reconstruir):
  light({kind, x, y, z, ...})   una luz dinámica; devuelve su id. removeLight(id)
  effect(preset, x, y, z)       un emisor de partículas; devuelve su id. removeEffect(id). burst(preset, x, y, z, n?)
  weather('nada'|'lluvia'|'nieve')   lights(true|false)
Mirar:
  goto(x, y)                    lleva a MAIA (y la cámara) ahí
  mode('2d'|'voxel'|'explore')  camera({ yaw, elevation, zoom })   (modo vóxel)
  png({ scale? })               lo que se ve ahora: { width, height, base64 }
Consultar:
  info()                        tamaño, salida, dónde está MAIA, columnas, muebles, fuente, fachada, luces, agua, rampas, huella
  recipe()                      la receta de ahora (JSON: guárdala y vuelve a pasarla a build)
  groundAt(x, y)  solidAt(x, y, z)  waterAt(x, y)  hash()
  roles()                       los papeles de las rampas del mundo (floor, wall, water...) para ramps
  presets()                     los efectos y las vegetaciones que hay
Errores: excepciones que dicen qué falta.`;

const LIGHT_KINDS: SourceKind[] = ['torch', 'lamp', 'brazier', 'neon-pink', 'neon-cyan', 'lantern', 'screen'];

export function installWorldApi(ctx: WorldApiContext): void {
  const st = (): WorldState => { if (!ctx.state) throw new Error('el mundo aún no está construido: espera a build()'); return ctx.state; };
  const num = (v: unknown, what: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what} tiene que ser un número`); return v; };
  const current = (): RecipeInput => ctx.recipe ?? { theme: ctx.theme, seed: ctx.seed };
  const info = () => ({ ...describeWorld({ layout: ctx.layout, world: ctx.world!, state: st() }), mode: ctx.mode, maia: ctx.maia ? [ctx.maia.x, ctx.maia.y, ctx.maia.z] : null, theme: ctx.recipe ? ctx.recipe.theme ?? null : ctx.theme, fromRecipe: !!ctx.recipe });
  const rebuild = async (r: RecipeInput | null) => { await ctx.build(r); return info(); };
  const model = (m: unknown, what: string): ModelFile => {
    try { return (m instanceof Model ? m.toJSON() : Model.fromJSON(m as ModelFile).toJSON()); }
    catch (e) { throw new Error(`${what}: hace falta un modelo de voxpix (el JSON de "Guardar" del editor o voxpix.save()): ${(e as Error).message}`); }
  };
  const fxPreset = (p: string): FxPreset => { if (!FX_PRESETS[p as FxPreset]) throw new Error(`no hay efecto "${p}"; hay: ${Object.keys(FX_PRESETS).join(', ')}`); return p as FxPreset; };

  const api = {
    help: () => HELP,
    // ---- construir
    build: (r: RecipeInput) => rebuild(r),
    update: (patch: Partial<WorldRecipe>) => rebuild({ ...current(), ...patch } as RecipeInput),
    seed: (n: number) => rebuild({ ...current(), seed: num(n, 'la semilla') } as RecipeInput),
    stamp: (m: unknown, x: number, y: number, z?: number, yaw?: number) => {
      const s: StampSpec = { model: model(m, 'stamp'), x: num(x, 'x'), y: num(y, 'y'), ...(z !== undefined ? { z: num(z, 'z') } : {}), ...(yaw !== undefined ? { yaw: num(yaw, 'yaw') } : {}) };
      const r = current();
      return rebuild({ ...r, stamps: [...(r.stamps ?? []), s] } as RecipeInput);
    },
    foliage: (type: string, o: Record<string, unknown> = {}) => {
      if (!FOLIAGE_TYPES.includes(type as never)) throw new Error(`no hay vegetación "${type}"; hay: ${FOLIAGE_TYPES.join(', ')}`);
      const r = current();
      return rebuild({ ...r, foliage: [...(r.foliage ?? []), { ...o, type }] } as RecipeInput);
    },
    themes: () => rebuild(null),
    // ---- en vivo
    light: (l: RecipeLight) => {
      if (!LIGHT_KINDS.includes(l?.kind)) throw new Error(`light({ kind, x, y, z }): kind es uno de ${LIGHT_KINDS.join(', ')}`);
      return st().lights.add({ ...l, x: num(l.x, 'x'), y: num(l.y, 'y'), z: num(l.z, 'z') });
    },
    removeLight: (id: string | number) => { st().lights.remove(id); },
    effect: (p: string, x: number, y: number, z: number) => st().fx.add(fxPreset(p), num(x, 'x'), num(y, 'y'), num(z, 'z')),
    removeEffect: (id: number) => { st().fx.remove(id); },
    burst: (p: string, x: number, y: number, z: number, n?: number) => { st().fx.burst(fxPreset(p), num(x, 'x'), num(y, 'y'), num(z, 'z'), n); },
    weather: (w: string) => ctx.setWeather(w),
    lights: (on: boolean) => ctx.setLights(!!on),
    // ---- mirar
    goto: (x: number, y: number) => ctx.goto(num(x, 'x'), num(y, 'y')),
    mode: (m: '2d' | 'voxel' | 'explore') => {
      if (!['2d', 'voxel', 'explore'].includes(m)) throw new Error("mode: '2d', 'voxel' o 'explore'");
      ctx.setMode(m);
    },
    camera: (c: { yaw?: number; elevation?: number; zoom?: number }) => {
      if (c.yaw !== undefined) ctx.vox.yaw = num(c.yaw, 'yaw');
      if (c.elevation !== undefined) ctx.vox.elevation = Math.max(5, Math.min(89, num(c.elevation, 'elevation')));
      if (c.zoom !== undefined) ctx.vox.zoom = Math.max(1, Math.min(8, Math.round(num(c.zoom, 'zoom'))));
      ctx.vox.dirty = true;
      return { yaw: ctx.vox.yaw, elevation: ctx.vox.elevation, zoom: ctx.vox.zoom };
    },
    png: (o: { scale?: number } = {}) => {
      const s = st();
      let rgba: Uint8ClampedArray;
      if (ctx.mode === '2d') {
        const { vx, vy } = ctx.view();
        rgba = frame2D(s, ctx.baked!, { vx, vy, vw: ctx.VW, vh: ctx.VH, time: performance.now() / 1000, lights: ctx.lightsOn, ambient: ctx.ambient, outline: ctx.outline });
      } else if (ctx.mode === 'voxel') rgba = ctx.frame3D();
      else {
        // Explorar: lo que hay en el lienzo de la primera persona
        const c = Array.from(document.querySelectorAll('canvas')).find((x) => x.style.display !== 'none' && x.getContext('2d'));
        if (!c) throw new Error('no hay lienzo de primera persona a la vista');
        rgba = c.getContext('2d')!.getImageData(0, 0, ctx.VW, ctx.VH).data;
      }
      // PNG con un lienzo (src/core/png usa zlib de Node): escalado sin suavizar
      const k = Math.max(1, Math.min(8, Math.round(o.scale ?? 1)));
      const src = document.createElement('canvas');
      src.width = ctx.VW; src.height = ctx.VH;
      src.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), ctx.VW, ctx.VH), 0, 0);
      const out = document.createElement('canvas');
      out.width = ctx.VW * k; out.height = ctx.VH * k;
      const g = out.getContext('2d')!;
      g.imageSmoothingEnabled = false;
      g.drawImage(src, 0, 0, out.width, out.height);
      return { width: out.width, height: out.height, base64: out.toDataURL('image/png').split(',')[1]! };
    },
    // ---- consultar
    info,
    recipe: () => structuredClone(current()),
    groundAt: (x: number, y: number) => st().groundAt(num(x, 'x'), num(y, 'y')),
    solidAt: (x: number, y: number, z: number) => st().solidAt(num(x, 'x'), num(y, 'y'), num(z, 'z')),
    waterAt: (x: number, y: number) => st().waterAt(num(x, 'x'), num(y, 'y')),
    hash: () => st().hash(),
    roles: () => Object.keys(M),
    presets: () => ({ effects: Object.keys(FX_PRESETS), foliage: [...FOLIAGE_TYPES], lights: LIGHT_KINDS, themes: THEME_IDS }),
  };
  (window as unknown as { voxpixWorld: typeof api }).voxpixWorld = api;
}
