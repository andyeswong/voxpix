// VISTA: el cuadro del modo 2D compuesto en la GPU con WebGL2. Hace lo mismo que frame2D (CPU), que es su
// oráculo: la CPU sigue haciendo la simulación, el horneado y el render de cada sprite de entidad (una vez por modelo
// y giro, en un atlas); aquí se hace por píxel lo que costaba por píxel en la CPU: la luz (horneada, dinámica, las
// sombras de las entidades), las entidades (cientos, como quads instanciados, con su luz por cara en el shader), el
// agua y las gotas, y pasar la luz a pixel art.
//
// Lo que sube a la GPU:
//   - una vez por horneado: la imagen (color, profundidad, cara) y los pesos de las luces fijas;
//   - al rehornear: solo los recuadros publicados (Baked.published) y los pesos de las luces que cambian;
//   - una vez por modelo y giro: el sprite de la entidad (color, profundidad, vóxel y cara de cada píxel) y su cuerpo;
//   - cada cuadro: la profundidad del agua de las columnas visibles, las gotas proyectadas, un registro por entidad
//     (dónde va, qué sprite) y la tabla de luces.
import { DIR_VECTORS, unkey, FX_STRIDE } from '../../core';
import { withEffectLights } from '../../world/effects';
import { resolveLight } from '../../world/lightutil';
import { sectionFor } from '../../world/frame2d';
import { secIdx, type SectionLayer } from '../../world/section';
import { backlitAt, highlightMask, entitySprite, entitySky, warmEntity, HEADINGS, entityDepthRange, entityLightPick, emissiveMask, onView, shadowCasters, occupancy, screenBox, dropLook, SHADOW_REACH, EW, EH, BACKGROUND, fogParams, type Frame2DOptions, type EntitySprite } from '../../world/frame2d';
import { worldPointAt, skyAmbient, unprojector, SKY_RAYS, type Baked, type BakedLight } from '../../world/bake';
import { waterRows, waterDepthRects, WATER_ZMIN, WATER_ZMAX } from '../../world/water';
import { materialsOf } from '../../core';
import type { RenderState, LightId } from '../../world/state';
import type { WorldLight } from '../../world/build';
import type { Rendered, VoxelSource } from '../../core';
import { FRAG_SHIFT, FRAG_CONTACT, FRAG_DROPS, FRAG_FX, VERT_FX, FRAG_ENTITY, FRAG_SCENE, FRAG_SHADE, FRAG_WATER, MAX_BAKED, MAX_CASTERS, MAX_LIGHTS, VERT_CONTACT, VERT_DROPS, VERT_ENTITY, VERT_FULLSCREEN } from './shaders';

export type GpuOutput = 'frame' | 'color' | 'multiply' | 'add';
// Un modelo para precalentar: en qué giros (por defecto los 8 rumbos) y si da sombra de verdad
export interface WarmItem { model: VoxelSource; yaws?: readonly number[]; casts?: boolean }
// Tope del atlas de sprites de entidades (48x72 cada uno, ~40 KB en la GPU y ~60 KB en la CPU)
export const MAX_SPRITE_LAYERS = 1024;
export interface AtlasStats { inFrame: number; sprites: number; cap: number; evicted: number }
// Lo que subió a la GPU el último cuadro (para saber qué hay detrás de un cuadro largo sin trabajo en el juego): sprites
// nuevos (renderizados y subidos), veces que el atlas de sprites creció (se rehace y se vuelve a subir entero), y los
// atlas 3D de cuerpos (luz propia) y de ocupación (sombras): subidas enteras (al crecer) y por partes
export interface UploadStats { sprites: number; spriteGrows: number; bodyFull: number; bodyParts: number; occFull: number; occParts: number; ms: number }

interface Target { fbo: WebGLFramebuffer; color: WebGLTexture; light: WebGLTexture; depth: WebGLTexture; dropsFbo: WebGLFramebuffer }
// La capa de entidades (con z-buffer) y la de sombras de contacto
interface EntTarget { fbo: WebGLFramebuffer; color: WebGLTexture; light: WebGLTexture; depth: WebGLTexture; zbuf: WebGLRenderbuffer; contactFbo: WebGLFramebuffer; contact: WebGLTexture }
// Por nombre; la Proxy devuelve null para los que el compilador del shader quitó (WebGL ignora un uniform null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Uniforms = Record<string, any>;
interface Program { prog: WebGLProgram; u: Uniforms }

export class GpuCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly scene: Program;
  private readonly water: Program;
  private readonly drops: Program;
  private readonly fx: Program;
  private readonly fxVao: WebGLVertexArrayObject;
  private readonly fxBuf: WebGLBuffer;
  private fxData = new Float32Array(0);
  private readonly shade: Program;
  private readonly shiftF: Program;
  private readonly ent: Program;
  private readonly contact: Program;
  private readonly entVao: WebGLVertexArrayObject;
  private readonly entBuf: WebGLBuffer;
  private entData = new Float32Array(0);
  private readonly contactVao: WebGLVertexArrayObject;
  private readonly contactBuf: WebGLBuffer;
  private contactData = new Float32Array(0);
  private readonly vao: WebGLVertexArrayObject;
  private readonly dropsVao: WebGLVertexArrayObject;
  private readonly dropsBuf: WebGLBuffer;
  private dropsData = new Float32Array(0);
  // ms del último cuadro en preparar y subir (horneado, pesos, entidades con su luz, agua y gotas): lo que la ruta de
  // la GPU sigue gastando en el hilo principal
  uploadMs = 0;
  // y de eso, por partes (para medir): horneado y pesos, entidades, agua, gotas
  readonly parts = { baked: 0, entities: 0, casters: 0, water: 0, drops: 0, fx: 0 };

  // Lo subido del horneado
  private baked: Baked | null = null;
  private bakedSerial = 0;
  private tColor: WebGLTexture | null = null;
  private tDepth: WebGLTexture | null = null;
  private tFace: WebGLTexture | null = null;
  private tWorldY: WebGLTexture | null = null;
  private tSky: WebGLTexture | null = null;            // el cielo del horneado (Baked.sky), si lo tiene
  private worldY: Float32Array<ArrayBuffer> = new Float32Array(0);
  // La cara de cada píxel tal como se sube: con materiales que reciben luz por detrás, cara + 8 * código, y el
  // código elige su valor en backVals (0 = nada); si la paleta no tiene, b.face tal cual
  private faceUp: Int8Array | null = null;
  private backVals: Float32Array<ArrayBuffer> = new Float32Array(16);
  private tHl: WebGLTexture | null = null;
  private hlMask: Uint8Array | null = null;
  private tWeights: WebGLTexture | null = null;
  // Las capas de la textura de pesos: la zona que tiene subida cada una (null, libre). Una luz conserva su capa mientras
  // siga elegida, así que al moverse la vista o rehacerse una luz solo se sube lo suyo
  private weightZones: Array<BakedLight | null> = [];
  private weightW = 0;
  private weightH = 0;
  // Los otros horneados ya subidos (los giros guardados de una vista girada, el nivel anterior...): volver a uno solo
  // cambia lo que se enlaza y lo pone al día por su número de serie. Como mucho bakedKeep, se sueltan los más viejos.
  private bakedCache = new Map<Baked, BakedGpu>();
  bakedKeep = 4;
  // Entidades: el atlas de sprites (una capa por modelo y giro), el de sus cuerpos sin girar (para el rayo de su
  // propia luz) y los cuerpos girados de las que dan sombra de verdad
  private sprites = new Map<string, number>();
  private spriteImgs: Rendered[] = [];
  private spriteEmissive: Array<Uint8Array | null> = [];
  private spriteCap = 0;
  private up: UploadStats = { sprites: 0, spriteGrows: 0, bodyFull: 0, bodyParts: 0, occFull: 0, occParts: 0, ms: 0 };
  // Lo subido en el último cuadro (frame/read): sprites nuevos, crecimientos del atlas y de los atlas 3D, y lo que tardó
  // la CPU en prepararlo y mandarlo (lo que haga la GPU después no se ve aquí)
  lastUploads: UploadStats = { ...this.up };
  // Cuándo se usó cada capa por última vez (en cuadros): con el atlas lleno, la nueva ocupa la menos usada
  private spriteUse: number[] = [];
  private frameNo = 0;
  // Para atlasStats: sprites distintos del último cuadro, cuántos sacaron a otro del atlas y si es un precalentado
  private usedNow = 0;
  private evicted = 0;
  private warming = false;
  private tSprColor: WebGLTexture | null = null;
  private tSprDepth: WebGLTexture | null = null;
  private tSprVox: WebGLTexture | null = null;
  private bodies = new Map<VoxelSource, { ax: number; min: [number, number, number]; size: [number, number, number]; data: Uint8Array }>();
  private readonly bodyAtlas: Atlas3D;
  private readonly occAtlas: Atlas3D;
  private tBody: WebGLTexture;
  private entTarget: EntTarget | null = null;
  private tOcc: WebGLTexture;
  private tLights: WebGLTexture;
  private lightTab = new Float32Array(4 * MAX_LIGHTS * 4);
  private occPlace: Array<{ min: [number, number, number]; size: [number, number, number]; ax: number }> = [];
  // Agua
  private tWDepth: WebGLTexture | null = null;
  private tWStatic: WebGLTexture | null = null;
  private waterOf: unknown = null;
  private waterGround = -1;                        // la groundVersion del agua cuyo fondo está subido
  private waterStaticV = 0;                        // la versión de staticSince del fondo subido (con WaterView)
  private waterDepthV = 0;                         // la de depthSince de la profundidad subida
  private waterDepthValid: [number, number, number, number] | null = null;   // lo que está al día de la profundidad
  waterDepthUploaded = 0;                          // (para medir) celdas de profundidad subidas
  // Destinos de la vista
  // El corte al componer: la capa subida (se sube cuando cambia) y sus texturas, del tamaño de la mayor
  private secLayer: SectionLayer | null = null;
  private secOf: Baked | null = null;
  private secSize: [number, number] = [0, 0];
  private tSecColor: WebGLTexture | null = null;
  private tSecGeo: WebGLTexture | null = null;
  // ms de la última subida de la capa (0 si no cambió)
  sectionMs = 0;
  private targets: [Target, Target] | null = null;
  private out: { fbo: WebGLFramebuffer; tex: WebGLTexture } | null = null;
  private size = [0, 0];

  static create(canvas: HTMLCanvasElement | OffscreenCanvas): GpuCompositor | null {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false }) as WebGL2RenderingContext | null;
    if (!gl) return null;
    // La luz y la profundidad se guardan en texturas de coma flotante en las que se pinta
    if (!gl.getExtension('EXT_color_buffer_float')) return null;
    try { return new GpuCompositor(gl); } catch (e) { console.warn('[voxpix] compositor GPU: no arranca', e); return null; }
  }

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.scene = program(gl, VERT_FULLSCREEN, FRAG_SCENE);
    this.water = program(gl, VERT_FULLSCREEN, FRAG_WATER);
    this.drops = program(gl, VERT_DROPS, FRAG_DROPS);
    this.fx = program(gl, VERT_FX, FRAG_FX);
    this.shade = program(gl, VERT_FULLSCREEN, FRAG_SHADE);
    this.shiftF = program(gl, VERT_FULLSCREEN, FRAG_SHIFT);
    this.ent = program(gl, VERT_ENTITY, FRAG_ENTITY);
    this.contact = program(gl, VERT_CONTACT, FRAG_CONTACT);
    // Un quad (dos triángulos) que se repite por entidad; los datos de cada una van en un búfer por instancia
    const corners = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const instanced = (prog: WebGLProgram, attrs: Array<[string, number]>): [WebGLVertexArrayObject, WebGLBuffer] => {
      const vao = gl.createVertexArray()!, buf = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, corners);
      const lc = gl.getAttribLocation(prog, 'aCorner');
      gl.enableVertexAttribArray(lc);
      gl.vertexAttribPointer(lc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const stride = attrs.reduce((n, [, k]) => n + k, 0) * 4;
      let off = 0;
      for (const [name, k] of attrs) {
        const loc = gl.getAttribLocation(prog, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, k, gl.FLOAT, false, stride, off);
        gl.vertexAttribDivisor(loc, 1);
        off += k * 4;
      }
      gl.bindVertexArray(null);
      return [vao, buf];
    };
    [this.entVao, this.entBuf] = instanced(this.ent.prog, [['aPlace', 4], ['aPos', 4], ['aOcc', 4], ['aOccSize', 4], ['aMask', 2], ['aTint', 4], ['aSky', 1]]);
    [this.contactVao, this.contactBuf] = instanced(this.contact.prog, [['aFeet', 3]]);
    this.vao = gl.createVertexArray()!;
    this.dropsVao = gl.createVertexArray()!;
    this.dropsBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.dropsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dropsBuf);
    const loc = gl.getAttribLocation(this.drops.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    // Los efectos: x, y, profundidad, r, g, b, tamaño, emisiva (8 floats por punto)
    this.fxVao = gl.createVertexArray()!;
    this.fxBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.fxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
    for (const [name, k, off] of [['aPos', 3, 0], ['aCol', 3, 3], ['aMisc', 2, 6]] as const) {
      const l = gl.getAttribLocation(this.fx.prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, k, gl.FLOAT, false, 32, off * 4);
    }
    gl.bindVertexArray(null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.tBody = gl.createTexture()!;
    uploadTo(gl, gl.TEXTURE_3D, this.tBody);
    nearest(gl, gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.tLights = tex2D(gl, gl.RGBA32F, 4, MAX_LIGHTS, gl.RGBA, gl.FLOAT, null);
    this.tOcc = gl.createTexture()!;
    uploadTo(gl, gl.TEXTURE_3D, this.tOcc);
    nearest(gl, gl.TEXTURE_3D);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.bodyAtlas = new Atlas3D(this.tBody);
    this.occAtlas = new Atlas3D(this.tOcc);
  }

  // Pinta el cuadro en el lienzo
  frame(state: RenderState, b: Baked, o: Frame2DOptions): void {
    this.frameNo++;
    this.usedNow = 0;
    this.compose(state, b, o);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.present(o, 0, true);
  }

  // Para la prueba del oráculo: una salida del cuadro en RGBA, fila 0 arriba (como frame2D)
  read(state: RenderState, b: Baked, o: Frame2DOptions, what: GpuOutput = 'frame'): Uint8Array {
    const gl = this.gl;
    this.frameNo++;
    this.usedNow = 0;
    this.compose(state, b, o);
    if (!this.out) {
      const tex = gl.createTexture()!;
      const fbo = gl.createFramebuffer()!;
      this.out = { tex, fbo };
    }
    uploadTo(gl, gl.TEXTURE_2D, this.out.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, o.vw, o.vh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out.tex, 0);
    this.present(o, { frame: 0, color: 1, multiply: 2, add: 3 }[what], false);
    const px = new Uint8Array(o.vw * o.vh * 4);
    gl.readPixels(0, 0, o.vw, o.vh, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return px;
  }

  // ---- los pasos

  private compose(state: RenderState, b: Baked, o: Frame2DOptions): void {
    this.up = { sprites: 0, spriteGrows: 0, bodyFull: 0, bodyParts: 0, occFull: 0, occParts: 0, ms: 0 };
    const bs0 = { ...this.bodyAtlas.stats }, os0 = { ...this.occAtlas.stats };
    try { this.composeInner(state, b, o); } finally {
      const bs = this.bodyAtlas.stats, os = this.occAtlas.stats;
      this.up.bodyFull = bs.full - bs0.full; this.up.bodyParts = bs.parts - bs0.parts;
      this.up.occFull = os.full - os0.full; this.up.occParts = os.parts - os0.parts;
      this.lastUploads = this.up;
    }
  }
  private composeInner(state: RenderState, b: Baked, o: Frame2DOptions): void {
    state = withEffectLights(state);
    const gl = this.gl;
    let up = performance.now();
    this.syncBaked(b);
    this.syncWeights(b, o);
    const sec = o.section || o.sectionLayer ? sectionFor(b, o) : null;
    this.syncSection(b, sec);
    let upMs = performance.now() - up;
    this.parts.baked = upMs;
    const [A, B] = this.ensureTargets(o.vw, o.vh);
    gl.viewport(0, 0, o.vw, o.vh);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);

    // Las luces del mundo de este cuadro (las mismas para la escena, las sombras y el agua): las que alcanzan la vista
    // y, si son más de MAX_LIGHTS, las más cercanas a su centro, en el orden de la lista
    const lights = viewLights(state.lights, b, o).map((l) => ({ l, p: resolveLight(l, o.time) }));
    const zones = this.weightZones;
    const layerOf = new Map<LightId, number>();
    zones.forEach((z, i) => { if (z) layerOf.set(z.light.id, i); });

    // Las luces del mundo: la tabla (posición y radio; color e intensidad; capa horneada, k, dinámica)
    const nb = zones.length;
    const tab = this.lightTab;
    tab.fill(0);
    lights.forEach(({ l, p }, i) => {
      const layer = layerOf.get(l.id);
      const baked = layer !== undefined && layer < nb;
      tab.set([l.x, l.y, l.z, p.radius], (i * 4) * 4);
      tab.set([p.color[0], p.color[1], p.color[2], p.intensity], (i * 4 + 1) * 4);
      tab.set([baked ? layer : -1, baked ? p.intensity / zones[layer]!.intensity : 0, l.baked === false ? 1 : 0, p.spot?.cosInner ?? 1], (i * 4 + 2) * 4);
      tab.set(p.spot ? [...p.spot.dir, p.spot.cosOuter] : [0, 0, 0, -2], (i * 4 + 3) * 4);
    });
    uploadTo(gl, gl.TEXTURE_2D, this.tLights);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, MAX_LIGHTS, gl.RGBA, gl.FLOAT, tab);

    // 0) las entidades y sus sombras de contacto
    up = performance.now();
    const E = this.ensureEntTarget(o.vw, o.vh);
    const sprites = state.entities.map((e) => entitySprite(b, e, o)).filter((d) => onView(d, o));
    this.drawEntities(state, b, sprites, E, o, lights.length);
    this.parts.entities = performance.now() - up;
    upMs += this.parts.entities;

    // 1) la escena
    const s = this.scene;
    gl.useProgram(s.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    bindTex(gl, 0, gl.TEXTURE_2D, this.tColor, s.u.uColor);
    bindTex(gl, 1, gl.TEXTURE_2D, this.tDepth, s.u.uDepth);
    bindTex(gl, 2, gl.TEXTURE_2D, this.tFace, s.u.uFace);
    bindTex(gl, 3, gl.TEXTURE_2D_ARRAY, this.tWeights, s.u.uWeights);
    bindTex(gl, 4, gl.TEXTURE_2D, E.color, s.u.uEntColor);
    bindTex(gl, 5, gl.TEXTURE_2D, E.depth, s.u.uEntDepth);
    bindTex(gl, 6, gl.TEXTURE_2D, E.light, s.u.uEntLight);
    bindTex(gl, 10, gl.TEXTURE_2D, E.contact, s.u.uContact);
    bindTex(gl, 7, gl.TEXTURE_3D, this.tOcc, s.u.uOcc);
    bindTex(gl, 9, gl.TEXTURE_2D, this.tWorldY, s.u.uWorldY);
    this.bindSection(s, true);
    // El cielo: la luz ambiente de cada píxel según cuánto cielo ve (la misma tabla que lightView en la CPU)
    const useSky = !!(o.lights && o.cave && b.sky && this.tSky);
    gl.uniform1i(s.u.uUseSky, useSky ? 1 : 0);
    bindTex(gl, 13, gl.TEXTURE_2D, useSky ? this.tSky : null, s.u.uSky);
    if (useSky) gl.uniform3fv(s.u.uSkyAmb, skyAmbient(o.ambient, o.cave!));
    // El resalte de un objeto del escenario: la máscara del aro se sube solo cuando cambia (highlightMask la guarda)
    const hl = o.highlight ? highlightMask(b, o.highlight) : null;
    gl.uniform1i(s.u.uHl, hl ? 1 : 0);
    if (hl) {
      if (this.hlMask !== hl.mask) {
        if (this.tHl) gl.deleteTexture(this.tHl);
        const [, , rw, rh] = hl.rect;
        const bytes = new Uint8Array(rw * rh);
        for (let i = 0; i < bytes.length; i++) bytes[i] = hl.mask[i] ? 255 : 0;
        this.tHl = tex2D(gl, gl.R8, rw, rh, gl.RED, gl.UNSIGNED_BYTE, bytes);
        this.hlMask = hl.mask;
      }
      bindTex(gl, 12, gl.TEXTURE_2D, this.tHl, s.u.uHlMask);
      gl.uniform4i(s.u.uHlRect, ...hl.rect);
      const c = o.highlight!.color;
      gl.uniform3f(s.u.uHlColor, c[0] / 255, c[1] / 255, c[2] / 255);
    } else gl.uniform1i(s.u.uHlMask, 12);
    gl.uniform1i(s.u.uXray, o.xray ? 1 : 0);
    if (o.xray) gl.uniform3f(s.u.uXrayColor, o.xray.color[0] / 255, o.xray.color[1] / 255, o.xray.color[2] / 255);
    const a = b.options.oblique?.y ?? 1;
    gl.uniform2i(s.u.uView, o.vx, o.vy);
    const clearBg = o.background === 'transparent';
    const bg: readonly [number, number, number] = o.background && o.background !== 'transparent' ? o.background : clearBg ? [0, 0, 0] : BACKGROUND;
    gl.uniform3f(s.u.uBg, bg[0] / 255, bg[1] / 255, bg[2] / 255);
    gl.uniform1i(s.u.uBgClear, clearBg ? 1 : 0);
    gl.uniform3f(s.u.uAmbient, o.ambient[0], o.ambient[1], o.ambient[2]);
    gl.uniform1i(s.u.uLights, o.lights ? 1 : 0);
    gl.uniform1f(s.u.uA, a);
    gl.uniform1f(s.u.uOriginY, b.options.originY ?? 0);
    gl.uniform1f(s.u.uF1, b.cam.fwd[1]);
    gl.uniform1f(s.u.uF2, b.cam.fwd[2]);
    gl.uniform3fv(s.u.uDirs, DIR_VECTORS.flat());
    gl.uniform1fv(s.u.uBack, this.backVals);
    // Luces horneadas (lightView)
    const rect = new Int32Array(MAX_BAKED * 4), ck = new Float32Array(MAX_BAKED * 3);
    for (let i = 0; i < nb; i++) {
      const bl = zones[i];
      if (!bl) continue;                                   // capa libre: recuadro vacío, no suma
      const k = resolveLight(bl.light, o.time).intensity / bl.intensity;
      rect.set([bl.rect.x, bl.rect.y, bl.rect.w, bl.rect.h], i * 4);
      ck.set([bl.color[0] * k, bl.color[1] * k, bl.color[2] * k], i * 3);
    }
    gl.uniform1i(s.u.uNBaked, nb);
    gl.uniform4iv(s.u.uBakedRect, rect);
    gl.uniform3fv(s.u.uBakedColorK, ck);
    gl.uniform1i(s.u.uNLights, lights.length);
    bindTex(gl, 8, gl.TEXTURE_2D, this.tLights, s.u.uLightTab);
    up = performance.now();
    this.setCasters(state, b, o, lights.map((x) => x.l));
    this.parts.casters = performance.now() - up;
    upMs += this.parts.casters;
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) el agua
    const w = this.water;
    gl.useProgram(w.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, B.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    bindTex(gl, 0, gl.TEXTURE_2D, A.color, w.u.uSrcColor);
    bindTex(gl, 1, gl.TEXTURE_2D, A.light, w.u.uSrcLight);
    bindTex(gl, 2, gl.TEXTURE_2D, A.depth, w.u.uSrcDepth);
    up = performance.now();
    const hasWater = this.syncWater(state, b, o);
    this.parts.water = performance.now() - up;
    upMs += this.parts.water;
    bindTex(gl, 3, gl.TEXTURE_2D, this.tWDepth, w.u.uWDepth);
    bindTex(gl, 4, gl.TEXTURE_2D, this.tWStatic, w.u.uWStatic);
    gl.uniform1i(w.u.uHasWater, hasWater ? 1 : 0);
    const cut = this.secLayer?.box ?? null;
    gl.uniform1i(w.u.uCut, cut ? 1 : 0);
    gl.uniform4i(w.u.uCutBox, cut?.x0 ?? 0, cut?.x1 ?? 0, cut?.y0 ?? 0, cut?.y1 ?? 0);
    gl.uniform1f(w.u.uCutZ, cut?.zMin ?? 0);
    gl.uniform1i(w.u.uLights, o.lights ? 1 : 0);
    gl.uniform2i(w.u.uView, o.vx, o.vy);
    gl.uniform2i(w.u.uViewSize, o.vw, o.vh);
    gl.uniform3f(w.u.uAmbient, o.ambient[0], o.ambient[1], o.ambient[2]);
    gl.uniform1i(w.u.uNLights, lights.length);
    bindTex(gl, 5, gl.TEXTURE_2D, this.tLights, w.u.uLightTab);
    if (hasWater) {
      const wl = state.water!;
      const f1 = b.cam.fwd[1], f2 = b.cam.fwd[2];
      const originY = b.options.originY ?? 0;
      const vlen = Math.hypot(f1, f2);
      const CELL = 2;
      const gx0 = Math.max(0, Math.floor(o.vx / CELL) - 1), gx1 = Math.min(wl.gw - 1, Math.ceil((o.vx + o.vw) / CELL) + 1);
      const zr = wl.zRange ?? [WATER_ZMIN, WATER_ZMAX];
      const [gy0, gy1] = waterRows(originY, a, o.vy, o.vh, wl.gh, zr);
      gl.uniform2f(w.u.uWZ, zr[0], zr[1]);
      gl.uniform2i(w.u.uGrid, wl.gw, wl.gh);
      gl.uniform4i(w.u.uCells, gx0, gx1, gy0, gy1);
      gl.uniform1f(w.u.uA, a);
      gl.uniform1f(w.u.uOriginY, originY);
      gl.uniform1f(w.u.uF1, f1);
      gl.uniform1f(w.u.uF2, f2);
      gl.uniform1f(w.u.uVy, -f1 / vlen);
      gl.uniform1f(w.u.uVz, -f2 / vlen);
      gl.uniform1f(w.u.uTPerPx, 1 / (a * f1 - f2));
      gl.uniform1f(w.u.uDPerT, f1 * f1 - f2 * f2);
      gl.uniform3fv(w.u.uTones, this.waterTones(state));
      gl.uniform1f(w.u.uGlow, state.water!.glow ?? 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3) los efectos y las gotas, sobre lo que dejó el agua
    up = performance.now();
    const nfx = state.effects ? this.projectFx(state, b, o) : 0;
    this.parts.fx = performance.now() - up;
    if (nfx) {
      const p = this.fx;
      gl.useProgram(p.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, B.dropsFbo);
      bindTex(gl, 0, gl.TEXTURE_2D, B.depth, p.u.uDepthNow);
      gl.uniform2f(p.u.uViewSize, o.vw, o.vh);
      gl.bindVertexArray(this.fxVao);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.NONE]);
      gl.uniform1i(p.u.uPass, 0);
      gl.drawArrays(gl.POINTS, 0, nfx);
      if (o.lights) {
        gl.drawBuffers([gl.NONE, gl.COLOR_ATTACHMENT1]);
        gl.uniform1i(p.u.uPass, 1);
        gl.drawArrays(gl.POINTS, 0, nfx);
      }
      gl.bindVertexArray(this.vao);
    }
    const drop = dropLook(state, o.ambient);
    up = performance.now();
    const n = drop ? this.projectDrops(state, b, o) : 0;
    this.parts.drops = performance.now() - up;
    this.uploadMs = upMs + this.parts.drops + this.parts.fx;
    if (n && drop) {
      const d = this.drops;
      gl.useProgram(d.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, B.dropsFbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      bindTex(gl, 0, gl.TEXTURE_2D, B.depth, d.u.uDepthNow);
      gl.uniform2f(d.u.uViewSize, o.vw, o.vh);
      gl.uniform3f(d.u.uDropColor, drop.color[0] / 255, drop.color[1] / 255, drop.color[2] / 255);
      gl.uniform3f(d.u.uDropLight, drop.light[0], drop.light[1], drop.light[2]);
      gl.bindVertexArray(this.dropsVao);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.bindVertexArray(this.vao);
    }
  }

  // 4) la luz a pixel art, al lienzo (dando la vuelta) o a una textura (fila 0 arriba)
  private present(o: Frame2DOptions, mode: number, flip: boolean): void {
    const gl = this.gl;
    const B = this.targets![1];
    const p = this.shade;
    gl.viewport(0, 0, o.vw, o.vh);
    gl.useProgram(p.prog);
    gl.drawBuffers([flip ? gl.BACK : gl.COLOR_ATTACHMENT0]);
    bindTex(gl, 0, gl.TEXTURE_2D, B.color, p.u.uColorTex);
    bindTex(gl, 1, gl.TEXTURE_2D, B.light, p.u.uLightTex);
    gl.uniform1i(p.u.uLights, o.lights ? 1 : 0);
    gl.uniform3f(p.u.uAmbient, o.ambient[0], o.ambient[1], o.ambient[2]);
    const useSky = !!(o.lights && o.cave && this.baked?.sky && this.tSky);
    gl.uniform1i(p.u.uUseSky, useSky ? 1 : 0);
    bindTex(gl, 13, gl.TEXTURE_2D, useSky ? this.tSky : null, p.u.uSky);
    if (useSky) gl.uniform3fv(p.u.uSkyAmb, skyAmbient(o.ambient, o.cave!));
    gl.uniform2i(p.u.uView, o.vx, o.vy);
    this.bindSection(p, false);
    gl.uniform1i(p.u.uMode, mode);
    gl.uniform1i(p.u.uFlip, flip ? 1 : 0);
    gl.uniform1i(p.u.uHeight, o.vh);
    // La niebla por altura, solo en el cuadro (mode 0): las capas sueltas son las de antes
    const fog = mode === 0 && this.baked ? fogParams(o.fog) : null;
    gl.uniform1i(p.u.uFog, fog ? 1 : 0);
    bindTex(gl, 2, gl.TEXTURE_2D, fog ? B.depth : null, p.u.uDepthTex);
    if (fog) {
      const u = unprojector(this.baked!), c = o.fog!.color;
      gl.uniform4f(p.u.uFogP, fog.z0, Number.isFinite(fog.inv) ? fog.inv : 1e30, fog.strength, 0);
      gl.uniform3f(p.u.uFogColor, c[0], c[1], c[2]);
      gl.uniform4f(p.u.uUnproj, u.O, u.a, u.f2, u.den);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- lo que se sube

  // Sube un horneado (y los pesos de sus luces) sin pintar nada: para hacerlo fuera de la partida (al quedar listo un
  // giro, en la tienda) y que el primer cuadro con él no lo pague
  upload(b: Baked): void {
    this.syncBaked(b);
    this.syncWeights(b);
    // Si la ventana se puede correr (shiftBaked), su camino en la GPU se calienta aquí con un corrimiento de cero (copia
    // cada textura a una de repuesto y la deja de repuesto): la primera vez que se usaba costaba ~15 ms a 6x en el cuadro
    // del cambio
    if (b.source.width % 16 === 0 && b.source.depth % 16 === 0 && this.baked === b) {
      const n = this.shiftCount;
      this.gpuShift(b, { serial: 0, dx: 0, rows: 0, dd: 0, dy: 0 });
      this.shiftCount = n;
    }
  }

  // Suelta lo guardado de un horneado que no es el de ahora (Compositor.release)
  release(b: Baked): void {
    const e = this.bakedCache.get(b);
    if (!e) return;
    for (const t of [e.tColor, e.tDepth, e.tFace, e.tWorldY, e.tWeights, e.tSky]) if (t) this.gl.deleteTexture(t);
    this.bakedCache.delete(b);
  }

  // Sube un horneado que aún no se enseña, por partes, para que el cuadro en que pase a enseñarse no lo pague entero (el
  // giro con fundido de la ventana viva: con una imagen de 1410 x 948, preparar la cara y la y del mundo y subir las
  // texturas eran ~100 ms en ese cuadro). Primero reserva las texturas; después, por bandas de filas, la cara y la y del
  // mundo y la subida de cada textura. Al acabar queda guardado como los horneados de antes (bakedCache) con el serial de
  // cuando empezó: al enseñarse, syncBaked lo recupera y sube solo lo publicado después
  prepareJob(b: Baked): { run(deadline: number): boolean } {
    const gl = this.gl, W = b.width, H = b.height, BAND = 32;
    if (this.baked === b || this.bakedCache.has(b)) return { run: () => true };
    let e: BakedGpu | null = null, row = 0;
    const serial = b.published.serial;
    return { run: (deadline: number) => {
      if (this.baked === b || this.bakedCache.has(b)) return true;
      if (!e) {
        const backVals = backlitCodes(b), faceUp = backVals.some((v) => v > 0) ? new Int8Array(W * H) : null;
        e = { serial, tColor: tex2D(gl, gl.RGBA8, W, H, gl.RGBA, gl.UNSIGNED_BYTE, null), tDepth: tex2D(gl, gl.R32F, W, H, gl.RED, gl.FLOAT, null),
          tFace: tex2D(gl, gl.R8I, W, H, gl.RED_INTEGER, gl.BYTE, null), tWorldY: tex2D(gl, gl.R32F, W, H, gl.RED, gl.FLOAT, null),
          worldY: new Float32Array(W * H), faceUp, backVals, tWeights: null, weightZones: [], weightW: 0, weightH: 0,
          tSky: b.sky ? tex2D(gl, gl.R8UI, W, H, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null) : null };
        if (performance.now() >= deadline) return false;
      }
      const g = e;
      do {
        const y0 = row, y1 = Math.min(H - 1, row + BAND - 1), h = y1 - y0 + 1;
        subImage(gl, g.tColor, 0, y0, W, h, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba, W, 4);
        subImage(gl, g.tDepth, 0, y0, W, h, gl.RED, gl.FLOAT, b.depth, W, 1);
        if (g.faceUp) fillFace(b, g.faceUp, g.backVals, 0, y0, W - 1, y1);
        subImage(gl, g.tFace, 0, y0, W, h, gl.RED_INTEGER, gl.BYTE, g.faceUp ?? b.face, W, 1);
        fillWorldY(b, g.worldY, 0, y0, W - 1, y1);
        subImage(gl, g.tWorldY, 0, y0, W, h, gl.RED, gl.FLOAT, g.worldY, W, 1);
        if (g.tSky && b.sky) subImage(gl, g.tSky, 0, y0, W, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, b.sky, W, 1);
        row = y1 + 1;
      } while (row < H && performance.now() < deadline);
      if (row < H) return false;
      // (si mientras se publicó algo, el serial de cuando empezó hace que se suba al enseñarse)
      this.bakedCache.set(b, g);
      return true;
    } };
  }

  private syncBaked(b: Baked): void {
    const gl = this.gl;
    const pub = b.published;
    if (this.baked !== b || !this.tColor) {
      // El que estaba se guarda (con sus pesos); si el nuevo ya se subió antes, se recupera y se pone al día abajo
      if (this.baked && this.tColor) this.bakedCache.set(this.baked, { serial: this.bakedSerial, tColor: this.tColor, tDepth: this.tDepth!, tFace: this.tFace!, tWorldY: this.tWorldY!, worldY: this.worldY, faceUp: this.faceUp, backVals: this.backVals, tWeights: this.tWeights, weightZones: this.weightZones, weightW: this.weightW, weightH: this.weightH, tSky: this.tSky });
      this.baked = b;
      const hit = this.bakedCache.get(b);
      this.bakedCache.delete(b);
      while (this.bakedCache.size > Math.max(0, this.bakedKeep - 1)) {
        const [old, e] = this.bakedCache.entries().next().value!;
        for (const t of [e.tColor, e.tDepth, e.tFace, e.tWorldY, e.tWeights, e.tSky]) if (t) gl.deleteTexture(t);
        this.bakedCache.delete(old);
      }
      if (hit) ({ serial: this.bakedSerial, tColor: this.tColor, tDepth: this.tDepth, tFace: this.tFace, tWorldY: this.tWorldY, worldY: this.worldY, faceUp: this.faceUp, backVals: this.backVals, tWeights: this.tWeights, weightZones: this.weightZones, weightW: this.weightW, weightH: this.weightH, tSky: this.tSky } = hit);
      else {
        this.tColor = tex2D(gl, gl.RGBA8, b.width, b.height, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba);
        this.tDepth = tex2D(gl, gl.R32F, b.width, b.height, gl.RED, gl.FLOAT, b.depth);
        this.backVals = backlitCodes(b);
        this.faceUp = this.backVals.some((v) => v > 0) ? new Int8Array(b.width * b.height) : null;
        if (this.faceUp) fillFace(b, this.faceUp, this.backVals, 0, 0, b.width - 1, b.height - 1);
        this.tFace = tex2D(gl, gl.R8I, b.width, b.height, gl.RED_INTEGER, gl.BYTE, this.faceUp ?? b.face);
        this.worldY = new Float32Array(b.width * b.height);
        fillWorldY(b, this.worldY, 0, 0, b.width - 1, b.height - 1);
        this.tWorldY = tex2D(gl, gl.R32F, b.width, b.height, gl.RED, gl.FLOAT, this.worldY);
        this.tSky = b.sky ? tex2D(gl, gl.R8UI, b.width, b.height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, b.sky) : null;
        this.bakedSerial = pub.serial;
        this.tWeights = null;              // los pesos del que se fue se quedaron guardados con él
        this.weightZones = [];
        this.weightW = 0; this.weightH = 0;
        return;
      }
    }
    if (b.shifting && b === this.baked) this.prepareSpares(b);
    if (pub.serial === this.bakedSerial) return;
    // La ventana se corrió (shiftBaked) y esto estaba al día justo antes: se corre dentro de la GPU, y abajo se sube solo lo
    // publicado con el corrimiento (lo borrado)
    // (si después se rehorneó algo más, sus recuadros siguen en la lista: se suben abajo)
    const ls = b.lastShift;
    if (ls && this.bakedSerial === ls.serial - 2 && pub.serial >= ls.serial && (pub.rects.length ? pub.rects[0]!.serial <= ls.serial + 1 : pub.serial === ls.serial)) {
      this.gpuShift(b, ls);
      for (const r of pub.rects) if (r.serial === ls.serial) this.uploadRect(b, r);
      this.bakedSerial = ls.serial;
      if (pub.serial === this.bakedSerial) return;
    }
    const tColor = this.tColor!;
    const oldest = pub.rects[0]?.serial ?? Infinity;
    if (oldest > this.bakedSerial + 1) {
      // Se quedó atrás: todo de nuevo
      subImage(gl, tColor, 0, 0, b.width, b.height, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba, b.width, 4);
      subImage(gl, this.tDepth!, 0, 0, b.width, b.height, gl.RED, gl.FLOAT, b.depth, b.width, 1);
      if (this.faceUp) fillFace(b, this.faceUp, this.backVals, 0, 0, b.width - 1, b.height - 1);
      subImage(gl, this.tFace!, 0, 0, b.width, b.height, gl.RED_INTEGER, gl.BYTE, this.faceUp ?? b.face, b.width, 1);
      fillWorldY(b, this.worldY, 0, 0, b.width - 1, b.height - 1);
      subImage(gl, this.tWorldY!, 0, 0, b.width, b.height, gl.RED, gl.FLOAT, this.worldY, b.width, 1);
      if (this.tSky && b.sky) subImage(gl, this.tSky, 0, 0, b.width, b.height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, b.sky, b.width, 1);
    } else for (const r of pub.rects) {
      if (r.serial <= this.bakedSerial) continue;
      this.uploadRect(b, r);
    }
    this.bakedSerial = pub.serial;
  }

  // La capa del corte. Las texturas guardan cada columna x de la imagen en la columna x mod secTW (un anillo en x): una
  // capa de SectionPainter dice qué columnas cambiaron desde la anterior (base, dirty) y solo se suben esas; si no, toda.
  // Lo que la GPU necesita por píxel: su color; y su profundidad, la y del mundo (como fillWorldY, con la profundidad de
  // la capa), la cara con el código de su luz por detrás (como fillFace, con el vóxel de la capa) y máscara + 16 * cielo
  private syncSection(b: Baked, sec: SectionLayer | null): void {
    this.sectionMs = 0;
    if (sec === this.secLayer && b === this.secOf) return;
    const up = this.secOf === b ? this.secLayer : null;
    this.secLayer = sec; this.secOf = b;
    if (!sec) return;
    const t0 = performance.now(), gl = this.gl;
    let full = !(sec.base && up && sec.base === up && sec.dirty && sec.y === up.y && sec.h === up.h);
    if (!this.tSecColor || sec.w > this.secSize[0] || sec.h > this.secSize[1]) {
      for (const tx of [this.tSecColor, this.tSecGeo]) if (tx) gl.deleteTexture(tx);
      let W = 256;
      while (W < sec.w) W *= 2;
      const H = Math.max(sec.h, this.secSize[1]);
      this.tSecColor = tex2D(gl, gl.RGBA8, W, H, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.tSecGeo = tex2D(gl, gl.RGBA32F, W, H, gl.RGBA, gl.FLOAT, null);
      this.secSize = [W, H];
      full = true;
    }
    const cols: ReadonlyArray<readonly [number, number]> = full ? [[sec.x, sec.x + sec.w - 1]] : sec.dirty!;
    for (const [g0, g1] of cols) {
      const a = Math.max(sec.x, g0), z = Math.min(sec.x + sec.w - 1, g1);
      if (a <= z) this.uploadSectionCols(sec, a, z);
    }
    this.sectionMs = performance.now() - t0;
  }

  // Las columnas de imagen g0..g1 de la capa a las texturas del anillo (en dos trozos si dan la vuelta). La y del mundo
  // y la luz por detrás vienen hechas en la capa (se calculan al pintarla)
  private uploadSectionCols(sec: SectionLayer, g0: number, g1: number): void {
    const gl = this.gl, { h } = sec, n = g1 - g0 + 1, TW = this.secSize[0];
    const geo = new Float32Array(n * h * 4), color = new Uint8Array(n * h * 4);
    const vals = this.backVals;
    for (let j = 0; j < h; j++) for (let k = 0; k < n; k++) {
      const q = secIdx(sec, g0 + k, j), o = (j * n + k) * 4, m = sec.mask[q]!;
      if (!m) { geo[o] = Infinity; continue; }
      color[o] = sec.rgba[q * 4]!; color[o + 1] = sec.rgba[q * 4 + 1]!; color[o + 2] = sec.rgba[q * 4 + 2]!; color[o + 3] = sec.rgba[q * 4 + 3]!;
      const f = sec.face[q]!, back = f >= 0 ? sec.back[q]! : 0;
      geo[o] = sec.depth[q]!;
      geo[o + 1] = sec.wy[q]!;
      geo[o + 2] = back > 0 ? f + 8 * vals.indexOf(Math.fround(back), 1) : f;
      geo[o + 3] = m + 16 * (sec.sky ? sec.sky[q]! : 0);
    }
    for (let k0 = 0; k0 < n;) {
      const tx = (g0 + k0) % TW, pw = Math.min(n - k0, TW - tx);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, n);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, k0);
      uploadTo(gl, gl.TEXTURE_2D, this.tSecColor!);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, 0, pw, h, gl.RGBA, gl.UNSIGNED_BYTE, color);
      uploadTo(gl, gl.TEXTURE_2D, this.tSecGeo!);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, tx, 0, pw, h, gl.RGBA, gl.FLOAT, geo);
      k0 += pw;
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  }

  // Las texturas y el recuadro de la capa, en la escena (all) o en el paso de la luz (solo la de la máscara y el cielo)
  private bindSection(p: Program, all: boolean): void {
    const gl = this.gl, sec = this.secLayer;
    gl.uniform1i(p.u.uSec, sec ? 1 : 0);
    gl.uniform4i(p.u.uSecRect, sec?.x ?? 0, sec?.y ?? 0, sec?.w ?? 0, sec?.h ?? 0);
    gl.uniform1i(p.u.uSecTW, this.secSize[0] || 1);
    bindTex(gl, 14, gl.TEXTURE_2D, sec ? this.tSecGeo : null, p.u.uSecGeo);
    if (all) bindTex(gl, 11, gl.TEXTURE_2D, sec ? this.tSecColor : null, p.u.uSecColor);
  }

  // Sube un recuadro de la imagen horneada a sus texturas
  private uploadRect(b: Baked, r: { x0: number; y0: number; x1: number; y1: number }): void {
    const gl = this.gl, w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
    subImage(gl, this.tColor!, r.x0, r.y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba, b.width, 4);
    subImage(gl, this.tDepth!, r.x0, r.y0, w, h, gl.RED, gl.FLOAT, b.depth, b.width, 1);
    if (this.faceUp) fillFace(b, this.faceUp, this.backVals, r.x0, r.y0, r.x1, r.y1);
    subImage(gl, this.tFace!, r.x0, r.y0, w, h, gl.RED_INTEGER, gl.BYTE, this.faceUp ?? b.face, b.width, 1);
    fillWorldY(b, this.worldY, r.x0, r.y0, r.x1, r.y1);
    subImage(gl, this.tWorldY!, r.x0, r.y0, w, h, gl.RED, gl.FLOAT, this.worldY, b.width, 1);
    if (this.tSky && b.sky) subImage(gl, this.tSky, r.x0, r.y0, w, h, gl.RED_INTEGER, gl.UNSIGNED_BYTE, b.sky, b.width, 1);
  }

  // Corre las texturas de la imagen horneada como shiftBaked corrió la imagen (píxel nuevo (x, y) = viejo (x + dx, y - rows)):
  // color, cara y cielo con blitFramebuffer (lo que entra, vacío), profundidad e y del mundo con un paso que les resta lo
  // suyo. Cada una a una textura nueva (no se puede leer y escribir la misma)
  shiftMs = 0;
  shiftCount = 0;
  // Las texturas de repuesto para correr (las de antes del último corrimiento; o creadas de una en una, cuadro a cuadro,
  // mientras se prepara el primero: crearlas todas en el cuadro del cambio costaba ~15 ms a 6x)
  private spares: Record<string, WebGLTexture | null> = { color: null, face: null, sky: null, depth: null, worldY: null };
  private spareSize: [number, number] = [0, 0];
  private prepareSpares(b: Baked): void {
    const gl = this.gl;
    if (this.spareSize[0] !== b.width || this.spareSize[1] !== b.height) {
      for (const k of Object.keys(this.spares)) { const x = this.spares[k]; if (x) gl.deleteTexture(x); this.spares[k] = null; }
      this.spareSize = [b.width, b.height];
    }
    const make: Record<string, () => WebGLTexture> = {
      color: () => tex2D(gl, gl.RGBA8, b.width, b.height, gl.RGBA, gl.UNSIGNED_BYTE, null),
      face: () => tex2D(gl, gl.R8I, b.width, b.height, gl.RED_INTEGER, gl.BYTE, null),
      sky: () => tex2D(gl, gl.R8UI, b.width, b.height, gl.RED_INTEGER, gl.UNSIGNED_BYTE, null),
      depth: () => tex2D(gl, gl.R32F, b.width, b.height, gl.RED, gl.FLOAT, null),
      worldY: () => tex2D(gl, gl.R32F, b.width, b.height, gl.RED, gl.FLOAT, null),
    };
    for (const k of Object.keys(make)) if (!this.spares[k] && (k !== 'sky' || this.tSky)) { this.spares[k] = make[k]!(); return; }   // una por cuadro
  }
  private takeSpare(k: string, b: Baked, create: () => WebGLTexture): WebGLTexture {
    const x = this.spareSize[0] === b.width && this.spareSize[1] === b.height ? this.spares[k] : null;
    this.spares[k] = null;
    return x ?? create();
  }          // cuántas veces se corrieron las texturas dentro de la GPU (para probar)
  private gpuShift(b: Baked, ls: NonNullable<Baked['lastShift']>): void {
    const t0 = performance.now(), gl = this.gl, W = b.width, H = b.height, { dx, rows } = ls;
    const rd = gl.createFramebuffer()!, dr = gl.createFramebuffer()!;
    const dx0 = Math.max(0, -dx), dx1 = W - Math.max(0, dx), dy0 = Math.max(0, rows), dy1 = H + Math.min(0, rows);
    const keep = (k: string, x: WebGLTexture) => {
      // (si los repuestos eran de otro tamaño, fuera todos: no se mezclan)
      if (this.spareSize[0] !== W || this.spareSize[1] !== H) {
        for (const q of Object.keys(this.spares)) { const y = this.spares[q]; if (y) gl.deleteTexture(y); this.spares[q] = null; }
        this.spareSize = [W, H];
      }
      const old = this.spares[k];
      if (old) gl.deleteTexture(old);
      this.spares[k] = x;
    };
    const blit = (k: string, src: WebGLTexture, internal: number, format: number, type: number, clear: () => void): WebGLTexture => {
      const dst = this.takeSpare(k, b, () => tex2D(gl, internal, W, H, format, type, null));
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dr);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      clear();
      if (dx0 < dx1 && dy0 < dy1) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rd);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.blitFramebuffer(dx0 + dx, dy0 - rows, dx1 + dx, dy1 - rows, dx0, dy0, dx1, dy1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      keep(k, src);
      return dst;
    };
    this.tColor = blit('color', this.tColor!, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, () => gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]));
    this.tFace = blit('face', this.tFace!, gl.R8I, gl.RED_INTEGER, gl.BYTE, () => gl.clearBufferiv(gl.COLOR, 0, [-1, 0, 0, 0]));
    if (this.tSky) this.tSky = blit('sky', this.tSky, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, () => gl.clearBufferuiv(gl.COLOR, 0, [SKY_RAYS, 0, 0, 0]));
    const p = this.shiftF;
    const pass = (k: string, src: WebGLTexture, delta: number, empty: number): WebGLTexture => {
      const dst = this.takeSpare(k, b, () => tex2D(gl, gl.R32F, W, H, gl.RED, gl.FLOAT, null));
      gl.bindFramebuffer(gl.FRAMEBUFFER, dr);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, W, H);
      gl.disable(gl.BLEND);
      gl.useProgram(p.prog);
      bindTex(gl, 0, gl.TEXTURE_2D, src, p.u.uSrc);
      gl.uniform2i(p.u.uOff, dx, -rows);
      gl.uniform2i(p.u.uSize, W, H);
      gl.uniform1f(p.u.uDelta, delta);
      gl.uniform1f(p.u.uEmpty, empty);
      gl.bindVertexArray(this.vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      keep(k, src);
      return dst;
    };
    this.tDepth = pass('depth', this.tDepth!, ls.dd, Infinity);
    this.tWorldY = pass('worldY', this.tWorldY!, ls.dy, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(rd); gl.deleteFramebuffer(dr);
    this.shiftMs = performance.now() - t0;
    this.shiftCount++;
  }

  // Los pesos de las luces fijas: una capa por luz elegida. Se eligen las que tocan la vista (todas, si no se dice) y,
  // si son más de MAX_BAKED, las más cercanas a su centro. Cada luz conserva su capa; se sube solo la capa cuya zona
  // cambió, y de una zona rehecha en parte sobre la que ya estaba subida, solo su recuadro sucio
  private syncWeights(b: Baked, view?: { vx: number; vy: number; vw: number; vh: number }): void {
    const gl = this.gl;
    let cand = view ? b.lights.filter((z) => z.rect.x < view.vx + view.vw && z.rect.x + z.rect.w > view.vx && z.rect.y < view.vy + view.vh && z.rect.y + z.rect.h > view.vy) : b.lights;
    if (cand.length > MAX_BAKED) {
      if (view) {
        const cx = view.vx + view.vw / 2, cy = view.vy + view.vh / 2;
        const d = (z: BakedLight) => (z.rect.x + z.rect.w / 2 - cx) ** 2 + (z.rect.y + z.rect.h / 2 - cy) ** 2;
        const keep = new Set([...cand].sort((p, q) => d(p) - d(q)).slice(0, MAX_BAKED));
        cand = cand.filter((z) => keep.has(z));
      } else cand = cand.slice(0, MAX_BAKED);
      warnOnce(`más de ${MAX_BAKED} luces horneadas en la vista: la GPU usa las más cercanas al centro`);
    }
    const old = this.weightZones;
    const byId = new Map(cand.map((z) => [z.light.id, z] as const));
    const next: Array<BakedLight | null> = old.map((z) => (z && byId.has(z.light.id) ? byId.get(z.light.id)! : null));
    const placed = new Set(next.filter((z) => z).map((z) => z!.light.id));
    for (const z of cand) {
      if (placed.has(z.light.id)) continue;
      const free = next.indexOf(null);
      if (free >= 0) next[free] = z; else next.push(z);
    }
    while (next.length && !next[next.length - 1]) next.pop();
    // La textura: del tamaño de la zona más grande del horneado y MAX_BAKED capas (así moverse no la rehace)
    const W = Math.max(1, ...b.lights.map((z) => z.rect.w)), H = Math.max(1, ...b.lights.map((z) => z.rect.h));
    const fresh = !this.tWeights || W > this.weightW || H > this.weightH;
    if (fresh) {
      if (this.tWeights) gl.deleteTexture(this.tWeights);
      this.tWeights = texArray(gl, gl.R32F, W, H, MAX_BAKED);
      this.weightW = W; this.weightH = H;
    }
    uploadTo(gl, gl.TEXTURE_2D_ARRAY, this.tWeights!);
    next.forEach((z, i) => {
      if (!z || (!fresh && old[i] === z)) return;
      const r = z.rect, d = z.dirty;
      if (!fresh && d && z.base && old[i] === z.base) {
        // El recuadro sucio, dentro de la zona (si no, la subida es inválida y no sube nada)
        const x0 = Math.max(0, d.x), y0 = Math.max(0, d.y), x1 = Math.min(r.w, d.x + d.w), y1 = Math.min(r.h, d.y + d.h);
        if (x1 <= x0 || y1 <= y0) return;
        // En una subida 3D, UNPACK_IMAGE_HEIGHT a 0 vale el alto de la subida, y entonces SKIP_ROWS + alto se pasa de la
        // imagen: Chromium la rechaza ("invalid unpack params combination"). La imagen es la zona: r.h filas de r.w
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, r.w);
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, r.h);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x0, y0, i, x1 - x0, y1 - y0, 1, gl.RED, gl.FLOAT, z.weight);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      } else gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, r.w, r.h, 1, gl.RED, gl.FLOAT, z.weight);
    });
    this.weightZones = next;
  }

  // Las sombras de verdad: las MAX_CASTERS entidades de shadowCasters, con su cuerpo girado (cuartos de vuelta)
  private setCasters(state: RenderState, b: Baked, o: Frame2DOptions, lights: WorldLight[]): void {
    const u = this.scene.u, gl = this.gl;
    const ents = o.lights ? shadowCasters(state, b, o) : [];
    const box = new Int32Array(MAX_CASTERS * 4), pos = new Float32Array(MAX_CASTERS * 3);
    const omin = new Int32Array(MAX_CASTERS * 4), osize = new Int32Array(MAX_CASTERS * 3), near = new Uint32Array(MAX_CASTERS);
    this.syncOcc(ents.map((e) => occupancy(e.model, e.yaw)));
    ents.forEach((e, i) => {
      const ex = Math.round(e.x), ey = Math.round(e.y), ez = e.z;
      pos.set([ex, ey, ez], i * 3);
      box.set(screenBox(b, ex, ey, ez, SHADOW_REACH, o) ?? [1, 1, 0, 0], i * 4);
      const op = this.occPlace[i]!;
      omin.set([op.min[0], op.min[1], op.min[2], op.ax], i * 4); osize.set(op.size, i * 3);
      let mask = 0;
      lights.forEach((l, j) => { if (l.owner !== e.id && Math.hypot(l.x - ex, l.y - ey) < resolveLight(l, 0).radius + SHADOW_REACH) mask |= 1 << j; });
      near[i] = mask >>> 0;
    });
    gl.uniform1i(u.uNEnt, ents.length);
    gl.uniform4iv(u.uEntBox, box);
    gl.uniform3fv(u.uEntPos, pos);
    gl.uniform4iv(u.uEntOccMin, omin);
    gl.uniform3iv(u.uEntOccSize, osize);
    gl.uniform1uiv(u.uEntNear, near);
  }

  // Las entidades a la capa de entidades (color, su luz, profundidad, con z-buffer) y sus sombras de contacto
  private drawEntities(state: RenderState, b: Baked, sprites: EntitySprite[], E: EntTarget, o: Frame2DOptions, nLights: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, E.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 2, [Infinity, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    // Contacto: se empieza en 1 (sin sombra) y cada elipse multiplica
    gl.bindFramebuffer(gl.FRAMEBUFFER, E.contactFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [1, 1, 1, 1]);
    if (!sprites.length) return;

    // Registro por entidad: dónde va su lienzo, qué capa del atlas, su luz y su cuerpo
    const n = sprites.length;
    if (this.entData.length < n * REC) this.entData = new Float32Array(Math.max(64, n * 2) * REC);
    if (this.contactData.length < n * 3) this.contactData = new Float32Array(Math.max(64, n * 2) * 3);
    const ed = this.entData, cd = this.contactData;
    // Radio de cada luz, una vez por cuadro (para el tope de luces por entidad)
    const radii = o.entityLightCap !== undefined ? state.lights.map((l) => resolveLight(l, o.time).radius) : undefined;
    // El rango de profundidad de las entidades de este cuadro, para el z-buffer (el mismo que usa la CPU)
    const range = entityDepthRange(sprites);
    for (let k = 0; k < n; k++) {
      const d = sprites[k]!, q = k * REC;
      const body = o.lights ? this.body(d.e.model) : null;
      ed[q] = d.offX - o.vx; ed[q + 1] = d.offY - o.vy; ed[q + 2] = this.spriteLayer(d); ed[q + 3] = d.dOff;
      ed[q + 4] = d.X + 0.5; ed[q + 5] = d.Y; ed[q + 6] = d.Z + d.bob; ed[q + 7] = (d.e.yaw * Math.PI) / 180;
      if (body) {
        ed[q + 8] = body.ax; ed[q + 9] = body.min[0]; ed[q + 10] = body.min[1]; ed[q + 11] = body.min[2];
        ed[q + 12] = body.size[0]; ed[q + 13] = body.size[1]; ed[q + 14] = body.size[2]; ed[q + 15] = 1;
      } else for (let c = 8; c < 16; c++) ed[q + c] = 0;
      // Qué luces la alumbran: todas, o las de entityLightPick (con tope)
      const pick = o.lights ? entityLightPick(state, d, o, radii) : null;
      let mask = 0xffffffff;
      if (pick) { mask = 0; for (const i of pick) if (i < 32) mask |= 1 << i; mask >>>= 0; }
      ed[q + 16] = mask & 0xffff; ed[q + 17] = mask >>> 16;
      const tint = d.e.tint;
      if (tint) { ed[q + 18] = tint[0]; ed[q + 19] = tint[1]; ed[q + 20] = tint[2]; ed[q + 21] = 1; } else ed[q + 21] = 0;
      ed[q + 22] = entitySky(b, d, o);
      cd[k * 3] = d.fx - o.vx; cd[k * 3 + 1] = d.fy - o.vy; cd[k * 3 + 2] = d.sry;
    }
    this.syncBodies();

    if (o.lights) {
      const c = this.contact;
      gl.useProgram(c.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      gl.uniform2f(c.u.uViewSize, o.vw, o.vh);
      gl.bindVertexArray(this.contactVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.contactBuf);
      gl.bufferData(gl.ARRAY_BUFFER, cd.subarray(0, n * 3), gl.DYNAMIC_DRAW);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
      gl.disable(gl.BLEND);
    }

    const p = this.ent;
    gl.bindFramebuffer(gl.FRAMEBUFFER, E.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.useProgram(p.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    bindTex(gl, 0, gl.TEXTURE_2D_ARRAY, this.tSprColor, p.u.uSprColor);
    bindTex(gl, 1, gl.TEXTURE_2D_ARRAY, this.tSprDepth, p.u.uSprDepth);
    bindTex(gl, 2, gl.TEXTURE_2D_ARRAY, this.tSprVox, p.u.uSprVox);
    bindTex(gl, 3, gl.TEXTURE_3D, this.tBody, p.u.uBody);
    bindTex(gl, 4, gl.TEXTURE_2D, this.tLights, p.u.uLightTab);
    gl.uniform2f(p.u.uViewSize, o.vw, o.vh);
    gl.uniform2f(p.u.uCell, EW, EH);
    gl.uniform1i(p.u.uLights, o.lights ? 1 : 0);
    gl.uniform3f(p.u.uAmbient, o.ambient[0], o.ambient[1], o.ambient[2]);
    const entSky = !!(o.lights && o.cave && b.sky);
    gl.uniform1i(p.u.uUseSky, entSky ? 1 : 0);
    if (entSky) gl.uniform3fv(p.u.uSkyAmb, skyAmbient(o.ambient, o.cave!));
    gl.uniform3fv(p.u.uDirs, DIR_VECTORS.flat());
    gl.uniform1i(p.u.uNLights, nLights);
    gl.uniform2f(p.u.uDepthRange, range[0], range[1]);
    gl.bindVertexArray(this.entVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.entBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ed.subarray(0, n * REC), gl.DYNAMIC_DRAW);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.vao);
  }

  // La capa del atlas de un sprite (modelo, giro, contorno): se sube la primera vez que aparece. El atlas crece hasta
  // MAX_SPRITE_LAYERS capas; lleno, la nueva sustituye a la que lleva más cuadros sin usarse (con giros libres,
  // cada ángulo es un sprite nuevo y el atlas crecía sin fin)
  private spriteLayer(d: EntitySprite): number {
    let layer = this.sprites.get(d.key);
    if (layer !== undefined) {
      if (!this.warming && this.spriteUse[layer] !== this.frameNo) this.usedNow++;
      this.spriteUse[layer] = this.frameNo;
      return layer;
    }
    const gl = this.gl;
    const cap = Math.min(MAX_SPRITE_LAYERS, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    if (this.spriteImgs.length < cap) {
      layer = this.spriteImgs.length;
      if (layer >= this.spriteCap) {
        // Atlas lleno: uno el doble de grande, y se vuelven a subir los que había (se guardan en la CPU)
        this.spriteCap = Math.min(cap, Math.max(64, this.spriteCap * 2));
        if (!this.warming) this.up.spriteGrows++;
        for (const t of [this.tSprColor, this.tSprDepth, this.tSprVox]) if (t) gl.deleteTexture(t);
        this.tSprColor = texArray(gl, gl.RGBA8, EW, EH, this.spriteCap);
        this.tSprDepth = texArray(gl, gl.R32F, EW, EH, this.spriteCap);
        this.tSprVox = texArray(gl, gl.RGBA8UI, EW, EH, this.spriteCap);
        this.spriteImgs.forEach((img, i) => this.uploadSprite(img, i, this.spriteEmissive[i] ?? null));
      }
      this.spriteImgs.push(d.img);
      this.spriteEmissive.push(emissiveMask(d));
    } else {
      // La menos usada (nunca una de este cuadro: ya tiene su sitio en el registro de entidades)
      layer = 0;
      for (let i = 1; i < this.spriteUse.length; i++) if (this.spriteUse[i]! < this.spriteUse[layer]!) layer = i;
      if (this.spriteUse[layer] === this.frameNo) warnOnce(`más de ${cap} sprites distintos en un cuadro`);
      for (const [k, v] of this.sprites) if (v === layer) { this.sprites.delete(k); break; }
      this.evicted++;
      this.spriteImgs[layer] = d.img;
      this.spriteEmissive[layer] = emissiveMask(d);
    }
    this.sprites.set(d.key, layer);
    if (!this.warming) this.usedNow++;
    this.spriteUse[layer] = this.frameNo;
    const u0 = performance.now();
    this.uploadSprite(d.img, layer, this.spriteEmissive[layer] ?? null);
    if (!this.warming) { this.up.sprites++; this.up.ms += performance.now() - u0; }
    return layer;
  }

  // Precalentar: renderiza y sube por adelantado los sprites de esos modelos (en esos giros; por defecto los 8
  // rumbos), sus cuerpos para el rayo de su propia luz y, si dan sombra, sus cuerpos girados; así el primer cuadro en
  // que aparecen no paga nada de eso. Con un presupuesto en ms se para al pasarlo y devuelve cuántos sprites quedan
  // (se vuelve a llamar en otro cuadro: lo ya subido se salta).
  prewarm(b: Baked, o: Frame2DOptions, list: readonly WarmItem[], budgetMs = Infinity): number {
    const t0 = performance.now();
    let left = 0;
    const occs: Array<ReturnType<typeof occupancy>> = [];
    this.warming = true;
    try {
      for (const it of list) {
        for (const yaw of it.yaws ?? HEADINGS) {
          if (performance.now() - t0 > budgetMs) { left++; continue; }
          this.spriteLayer(entitySprite(b, warmEntity(it.model, yaw), o));
          if (it.casts) { const oc = occupancy(it.model, yaw); if (!oc.empty) occs.push(oc); }
        }
        if (o.lights) this.body(it.model);
      }
    } finally { this.warming = false; }
    this.syncBodies();
    if (occs.length) { const place = this.occPlace; this.syncOcc(occs); this.occPlace = place; }
    return left;
  }

  // Cuántos sprites hay en el atlas (para medir)
  get spriteCount(): number { return this.spriteImgs.length; }

  // El atlas de sprites, para medir: los distintos que usó el último cuadro (sin contar los precalentados), los que
  // hay, el tope (MAX_SPRITE_LAYERS o el de la GPU, el menor) y cuántas veces uno nuevo sacó a otro por estar lleno
  atlasStats(): AtlasStats {
    const gl = this.gl;
    return { inFrame: this.usedNow, sprites: this.spriteImgs.length, cap: Math.min(MAX_SPRITE_LAYERS, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number), evicted: this.evicted };
  }

  private uploadSprite(img: Rendered, layer: number, emissive: Uint8Array | null): void {
    const gl = this.gl;
    // Vóxel y cara de cada píxel (para su luz por cara): x, y, z + 128 y la cara (255 = ninguna, p. ej. el contorno),
    // con el bit 128 si el vóxel es de una rampa emisiva
    const vox = new Uint8Array(EW * EH * 4).fill(255);
    if (img.pickKey && img.pickFace) for (let i = 0; i < EW * EH; i++) {
      const k = img.pickKey[i]!;
      if (Number.isNaN(k)) continue;
      const [x, y, z] = unkey(k);
      vox.set([x + 128, y + 128, z + 128, img.pickFace[i]! | (emissive?.[i] ? 128 : 0)], i * 4);
    }
    uploadTo(gl, gl.TEXTURE_2D_ARRAY, this.tSprColor!);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, EW, EH, 1, gl.RGBA, gl.UNSIGNED_BYTE, img.rgba);
    uploadTo(gl, gl.TEXTURE_2D_ARRAY, this.tSprDepth!);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, EW, EH, 1, gl.RED, gl.FLOAT, img.depth);
    uploadTo(gl, gl.TEXTURE_2D_ARRAY, this.tSprVox!);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, EW, EH, 1, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, vox);
  }

  // El cuerpo (sin girar) de un modelo, para el rayo de su propia luz: se apunta y se sube con syncBodies
  private body(m: VoxelSource) {
    let bd = this.bodies.get(m);
    if (bd) return bd;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const vs: Array<[number, number, number]> = [];
    for (const [x, y, z] of m.entries()) {
      vs.push([x, y, z]);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    if (!vs.length) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 0; }
    const size: [number, number, number] = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
    const data = new Uint8Array(size[0] * size[1] * size[2]);
    for (const [x, y, z] of vs) data[((z - z0) * size[1] + (y - y0)) * size[0] + (x - x0)] = 255;
    bd = { ax: this.bodyAtlas.add(size, data), min: [x0, y0, z0], size, data };
    this.bodies.set(m, bd);
    return bd;
  }

  private syncBodies(): void { this.bodyAtlas.sync(this.gl); }

  private ensureEntTarget(w: number, h: number): EntTarget {
    const t = this.entTarget;
    if (t && this.entSize[0] === w && this.entSize[1] === h) return t;
    const gl = this.gl;
    const color = tex2D(gl, gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const light = tex2D(gl, gl.RGBA32F, w, h, gl.RGBA, gl.FLOAT, null);
    const depth = tex2D(gl, gl.R32F, w, h, gl.RED, gl.FLOAT, null);
    const zbuf = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, zbuf);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH32F_STENCIL8, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, light, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, depth, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, zbuf);
    checkFbo(gl);
    const contact = tex2D(gl, gl.RGBA16F, w, h, gl.RGBA, gl.HALF_FLOAT, null);
    const contactFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, contactFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, contact, 0);
    checkFbo(gl);
    this.entTarget = { fbo, color, light, depth, zbuf, contactFbo, contact };
    this.entSize = [w, h];
    return this.entTarget;
  }
  private entSize = [0, 0];

  // Los cuerpos girados de las que dan sombra, en un atlas 3D que se queda: cada cuerpo (modelo y cuarto de vuelta) se
  // sube una vez, la primera vez que hace falta (con el walk cambian cada 100 ms: rehacerlo entero costaba)
  private syncOcc(occs: Array<ReturnType<typeof occupancy>>): void {
    let grown = false;
    for (const o of occs) {
      if (this.occSlabs.has(o) || o.empty) continue;
      const size: [number, number, number] = [o.max[0] - o.min[0], o.max[1] - o.min[1], o.max[2] - o.min[2]];
      const data = new Uint8Array(size[0] * size[1] * size[2]);
      for (const k of o.set) {
        const [x, y, z] = unkey(k);
        data[((z - o.min[2]) * size[1] + (y - o.min[1])) * size[0] + (x - o.min[0])] = 255;
      }
      this.occSlabs.set(o, { ax: this.occAtlas.add(size, data), size, data });
      grown = true;
    }
    // Un cuerpo vacío (no debería llegar: shadowCasters lo salta) va como caja vacía en el sitio 0
    this.occPlace = occs.map((o) => { const sl = this.occSlabs.get(o); return sl ? { min: o.min, size: sl.size, ax: sl.ax } : { min: [0, 0, 0] as [number, number, number], size: [0, 0, 0] as [number, number, number], ax: 0 }; });
    if (grown) this.occAtlas.sync(this.gl);
  }
  private occSlabs = new Map<object, { ax: number; size: [number, number, number]; data: Uint8Array }>();

  // Cuántas veces se rehízo entero y cuántos cuerpos se subieron sueltos, en cada atlas 3D (para medir y probar)
  atlas3DStats(): { bodies: Atlas3DStats; occupancy: Atlas3DStats } { return { bodies: { ...this.bodyAtlas.stats }, occupancy: { ...this.occAtlas.stats } }; }

  private syncWater(state: RenderState, b: Baked, o: Frame2DOptions): boolean {
    const gl = this.gl;
    const wl = state.water;
    if (!wl) return false;
    const sim = wl.sim;
    // El fondo, las paredes y las cuencas: al cambiar de agua y cada vez que cambian (con follow, al picar o poner)
    const staticOf = () => {
      const st = new Float32Array(wl.gw * wl.gh * 4);
      for (let i = 0; i < wl.gw * wl.gh; i++) { st[i * 4] = sim.ground[i]!; st[i * 4 + 1] = sim.solid[i]!; st[i * 4 + 2] = wl.isBasin(i) ? 1 : 0; }
      return st;
    };
    if (this.waterOf !== wl || !this.tWDepth) {
      this.waterOf = wl;
      this.waterDepthV = wl.depthSince ? wl.depthSince(-1).v : 0;
      this.waterDepthValid = null;
      this.waterGround = wl.groundVersion ?? 0;
      this.waterStaticV = wl.staticSince ? wl.staticSince(-1).v : 0;
      for (const t of [this.tWDepth, this.tWStatic]) if (t) gl.deleteTexture(t);
      this.tWStatic = tex2D(gl, gl.RGBA32F, wl.gw, wl.gh, gl.RGBA, gl.FLOAT, staticOf());
      this.tWDepth = tex2D(gl, gl.R32F, wl.gw, wl.gh, gl.RED, gl.FLOAT, sim.depth);
      return true;
    }
    if (wl.staticSince) {
      // Con registro (WaterView): se corre la textura dentro de la GPU como se corrió la copia y se sube solo la caja que
      // cambió (cargar un trozo, picar); entera solo si el registro no llega tan atrás
      const ch = wl.staticSince(this.waterStaticV);
      this.waterStaticV = ch.v;
      this.waterGround = wl.groundVersion ?? 0;
      if (ch.all) subImage(gl, this.tWStatic!, 0, 0, wl.gw, wl.gh, gl.RGBA, gl.FLOAT, staticOf(), wl.gw, 4);
      else {
        if (ch.shift) this.tWStatic = this.shiftWaterStatic(this.tWStatic!, wl.gw, wl.gh, ch.shift[0], ch.shift[1]);
        if (ch.box) {
          const [x0, y0, x1, y1] = ch.box, w = x1 - x0 + 1, h = y1 - y0 + 1, st = new Float32Array(w * h * 4);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = (y0 + y) * wl.gw + x0 + x, o = (y * w + x) * 4;
            st[o] = sim.ground[i]!; st[o + 1] = sim.solid[i]!; st[o + 2] = wl.isBasin(i) ? 1 : 0;
          }
          uploadTo(gl, gl.TEXTURE_2D, this.tWStatic!);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, w, h, gl.RGBA, gl.FLOAT, st);
          this.waterStaticUploaded += w * h;
        }
      }
    } else if ((wl.groundVersion ?? 0) !== this.waterGround) {
      this.waterGround = wl.groundVersion ?? 0;
      subImage(gl, this.tWStatic!, 0, 0, wl.gw, wl.gh, gl.RGBA, gl.FLOAT, staticOf(), wl.gw, 4);
    }
    // Cada cuadro, solo las celdas que se ven: sus columnas (y una más a cada lado, por las vecinas) y las filas en que su
    // agua puede caer en la vista (waterRows, las mismas que pinta el agua, con dos de margen por las vecinas)
    const gx0 = Math.max(0, Math.floor(o.vx / 2) - 2), gx1 = Math.min(wl.gw - 1, Math.ceil((o.vx + o.vw) / 2) + 2);
    const [ry0, ry1] = waterRows(b.options.originY ?? 0, b.options.oblique?.y ?? 1, o.vy, o.vh, wl.gh, wl.zRange ?? [WATER_ZMIN, WATER_ZMAX]);
    const gy0 = Math.max(0, ry0 - 2), gy1 = Math.min(wl.gh - 1, ry1 + 2);
    if (gy0 > gy1) return true;
    const up = (x0: number, y0: number, x1: number, y1: number) => {
      x0 = Math.max(x0, gx0); y0 = Math.max(y0, gy0); x1 = Math.min(x1, gx1); y1 = Math.min(y1, gy1);
      if (x0 > x1 || y0 > y1) return;
      subImage(gl, this.tWDepth!, x0, y0, x1 - x0 + 1, y1 - y0 + 1, gl.RED, gl.FLOAT, sim.depth, wl.gw, 1);
      this.waterDepthUploaded += (x1 - x0 + 1) * (y1 - y0 + 1);
    };
    const ch = wl.depthSince ? wl.depthSince(this.waterDepthV) : null;
    if (ch) this.waterDepthV = ch.v;
    for (const r of waterDepthRects(ch, this.waterDepthValid, [gx0, gy0, gx1, gy1])) up(...r);
    this.waterDepthValid = ch ? [gx0, gy0, gx1, gy1] : null;
    return true;
  }

  // La textura del fondo del agua corrida dx, dy celdas (la celda (x, y) pasa a tener la de (x + dx, y + dy)) en una nueva:
  // lo que entra, pared seca (fondo 0, pared 1, sin cuenca), como la franja de la capa
  private shiftWaterStatic(src: WebGLTexture, W: number, H: number, dx: number, dy: number): WebGLTexture {
    const gl = this.gl, dst = tex2D(gl, gl.RGBA32F, W, H, gl.RGBA, gl.FLOAT, null);
    const rd = gl.createFramebuffer()!, dr = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dr);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 1, 0, 0]);
    const x0 = Math.max(0, -dx), x1 = W - Math.max(0, dx), y0 = Math.max(0, -dy), y1 = H - Math.max(0, dy);
    if (x0 < x1 && y0 < y1) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, rd);
      gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.blitFramebuffer(x0 + dx, y0 + dy, x1 + dx, y1 + dy, x0, y0, x1, y1, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(rd); gl.deleteFramebuffer(dr);
    gl.deleteTexture(src);
    this.waterShifts++;
    return dst;
  }
  // (para medir y probar) corrimientos de la textura del fondo del agua y celdas subidas por caja
  waterShifts = 0;
  waterStaticUploaded = 0;
  // Lee la textura del fondo del agua (fondo, pared, cuenca por celda): para el oráculo
  readWaterStatic(): Float32Array | null {
    const gl = this.gl, t = this.tWStatic, wl = this.waterOf as { gw: number; gh: number } | null;
    if (!t || !wl) return null;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    const out = new Float32Array(wl.gw * wl.gh * 4);
    gl.readPixels(0, 0, wl.gw, wl.gh, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return out;
  }

  private waterTones(state: RenderState): Float32Array {
    return new Float32Array(state.water!.toneColors.flat());
  }

  // Los puntos de los efectos, proyectados en la CPU (como las gotas: así la GPU pinta los mismos píxeles)
  private projectFx(state: RenderState, b: Baked, o: Frame2DOptions): number {
    const gl = this.gl;
    let total = 0;
    for (const s of state.effects!.sources) total += s.count;
    if (!total) return 0;
    if (this.fxData.length < total * 8) this.fxData = new Float32Array(Math.max(256, total * 2) * 8);
    let out = this.fxData;
    let n = 0;
    for (const s of state.effects!.sources) {
      const d = s.packed;
      for (let k = 0; k < s.count; k++) {
        const q = k * FX_STRIDE;
        const [sx, sy, depth] = b.cam.project(d[q]!, d[q + 1]!, d[q + 2]!);
        const tx = Math.floor(sx) - o.vx, ty0 = Math.floor(sy) - o.vy, px = d[q + 6]!, len = d[q + 8]!;
        for (let st = 0; st < len; st++) {
          const ty = ty0 - st;
          if (tx + px <= 0 || ty + px <= 0 || tx >= o.vw || ty >= o.vh) continue;
          if (out.length < (n + 1) * 8) { const grown = new Float32Array(out.length * 2); grown.set(out); out = this.fxData = grown; }
          const w = n * 8;
          out[w] = tx; out[w + 1] = ty; out[w + 2] = depth;
          out[w + 3] = d[q + 3]!; out[w + 4] = d[q + 4]!; out[w + 5] = d[q + 5]!; out[w + 6] = px; out[w + 7] = d[q + 7]!;
          n++;
        }
      }
    }
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fxBuf);
      gl.bufferData(gl.ARRAY_BUFFER, out.subarray(0, n * 8), gl.DYNAMIC_DRAW);
    }
    return n;
  }

  private projectDrops(state: RenderState, b: Baked, o: Frame2DOptions): number {
    const gl = this.gl;
    const dr = state.drops;
    if (this.dropsData.length < dr.count * 3) this.dropsData = new Float32Array(Math.max(256, dr.count * 2) * 3);
    let n = 0;
    for (let k = 0; k < dr.count; k++) {
      const [x, y, z] = dr.at(k);
      const [sx, sy, depth] = b.cam.project(x, y, z);
      const tx = Math.floor(sx) - o.vx, ty = Math.floor(sy) - o.vy;
      if (tx < 0 || ty < 0 || tx >= o.vw || ty >= o.vh) continue;
      this.dropsData[n * 3] = tx; this.dropsData[n * 3 + 1] = ty; this.dropsData[n * 3 + 2] = depth;
      n++;
    }
    if (n) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dropsBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.dropsData.subarray(0, n * 3), gl.DYNAMIC_DRAW);
    }
    return n;
  }

  private ensureTargets(w: number, h: number): [Target, Target] {
    if (this.targets && this.size[0] === w && this.size[1] === h) return this.targets;
    const gl = this.gl;
    const make = (): Target => {
      const color = tex2D(gl, gl.RGBA8, w, h, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const light = tex2D(gl, gl.RGBA32F, w, h, gl.RGBA, gl.FLOAT, null);
      const depth = tex2D(gl, gl.R32F, w, h, gl.RED, gl.FLOAT, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, light, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, depth, 0);
      checkFbo(gl);
      const dropsFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dropsFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, light, 0);
      checkFbo(gl);
      return { fbo, color, light, depth, dropsFbo };
    };
    this.targets = [make(), make()];
    this.size = [w, h];
    const c = gl.canvas;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return this.targets;
  }
}

// La y del mundo que se ve en cada píxel (worldPointAt, en doble precisión y guardada en float32). En la GPU, la
// reconstrucción en float32 a partir de la profundidad se equivoca en milésimas, y en el borde de un vóxel eso basta
// para que el rayo de sombra de una entidad caiga en el vóxel de al lado.
function fillWorldY(b: Baked, out: Float32Array, x0: number, y0: number, x1: number, y1: number): void {
  for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
    const P = b.face[sy * b.width + sx]! >= 0 ? worldPointAt(b, sx, sy) : null;
    out[sy * b.width + sx] = P ? P[1] : 0;
  }
}

// Los valores distintos de luz por detrás de la paleta (como mucho 15), en la posición de su código (0 = nada)
function backlitCodes(b: Baked): Float32Array<ArrayBuffer> {
  const out = new Float32Array(16);
  const mt = materialsOf(b.source.palette);
  if (!mt) return out;
  let n = 0;
  for (const m of mt.ramps) {
    const v = Math.fround(m.backlit);
    if (v > 0 && !out.slice(1, n + 1).includes(v)) { if (n >= 15) throw new Error('más de 15 valores de luz por detrás en la paleta'); out[++n] = v; }
  }
  return out;
}

// Lo subido de un horneado que no es el de este cuadro (GpuCompositor.bakedCache)
interface BakedGpu {
  serial: number; tColor: WebGLTexture; tDepth: WebGLTexture; tFace: WebGLTexture; tWorldY: WebGLTexture;
  worldY: Float32Array<ArrayBuffer>; faceUp: Int8Array | null; backVals: Float32Array<ArrayBuffer>; tWeights: WebGLTexture | null; weightZones: Array<BakedLight | null>; weightW: number; weightH: number; tSky: WebGLTexture | null;
}

// La cara con el código de su luz por detrás (+8 * código)
function fillFace(b: Baked, out: Int8Array, vals: Float32Array, x0: number, y0: number, x1: number, y1: number): void {
  const mt = materialsOf(b.source.palette);
  for (let sy = y0; sy <= y1; sy++) for (let sx = x0; sx <= x1; sx++) {
    const i = sy * b.width + sx, f = b.face[i]!;
    const back = f >= 0 ? backlitAt(b, mt, i) : 0;
    out[i] = back > 0 ? f + 8 * vals.indexOf(back, 1) : f;
  }
}

// Floats por entidad en el búfer de instancias (aPlace, aPos, aOcc, aOccSize, aMask, aTint, aSky)
const REC = 23;

// ---- utilidades de WebGL

const occIds = new WeakMap<object, number>();
let nextOcc = 1;
function occId(o: object): number {
  let id = occIds.get(o);
  if (!id) occIds.set(o, (id = nextOcc++));
  return id;
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[voxpix] compositor GPU: ${msg}`);
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): Program {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`programa: ${gl.getProgramInfoLog(prog)}`);
  const u: Uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(prog, i)!;
    const name = info.name.replace(/\[0\]$/, '');
    u[name] = gl.getUniformLocation(prog, info.name);
  }
  return { prog, u: new Proxy(u, { get: (t, k: string) => t[k] ?? null }) };
}

function nearest(gl: WebGL2RenderingContext, target: number): void {
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// Las subidas usan su propia unidad de textura: si no, enlazar para subir pisaría lo que un paso ya enlazó
const UPLOAD_UNIT = 15;
export interface Atlas3DStats { full: number; parts: number; width: number; capacity: [number, number, number] }

// Un atlas 3D de cuerpos (R8), uno detrás de otro en x (lo leen los shaders con texelFetch dentro de cada uno: lo que
// sobra alrededor no se lee). Lo nuevo se sube solo (texSubImage3D); el atlas se rehace entero solo cuando no cabe
// (el doble de ancho, y el alto y el hondo del mayor). Antes se rehacía y se subía entero con cada cuerpo nuevo: con
// muchos modelos, precalentar uno costaba lo de todos
export class Atlas3D {
  private readonly slabs: Array<{ ax: number; size: [number, number, number]; data: Uint8Array }> = [];
  private pending: number[] = [];
  private cap: [number, number, number] = [0, 0, 0];
  private width = 0;
  readonly stats: Atlas3DStats = { full: 0, parts: 0, width: 0, capacity: [0, 0, 0] };
  constructor(private readonly tex: WebGLTexture) {}
  // Apunta un cuerpo (size: x, y, z; data: x más rápido, luego y, luego z) y devuelve su x en el atlas
  add(size: [number, number, number], data: Uint8Array): number {
    const ax = this.width;
    this.slabs.push({ ax, size, data });
    this.pending.push(this.slabs.length - 1);
    this.width += size[0];
    return ax;
  }
  sync(gl: WebGL2RenderingContext): void {
    if (!this.pending.length) return;
    let H = this.cap[1], D = this.cap[2];
    for (const k of this.pending) { const s = this.slabs[k]!.size; H = Math.max(H, s[1]); D = Math.max(D, s[2]); }
    uploadTo(gl, gl.TEXTURE_3D, this.tex);
    if (this.width > this.cap[0] || H > this.cap[1] || D > this.cap[2]) {
      // No cabe: uno nuevo, más grande, con todos
      const W = Math.max(64, this.width > this.cap[0] ? Math.max(this.width, this.cap[0] * 2) : this.cap[0]);
      H = Math.max(1, H); D = Math.max(1, D);
      const all = new Uint8Array(W * H * D);
      for (const sl of this.slabs) {
        const [sx, sy, sz] = sl.size;
        for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) all.set(sl.data.subarray((z * sy + y) * sx, (z * sy + y + 1) * sx), (z * H + y) * W + sl.ax);
      }
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, W, H, D, 0, gl.RED, gl.UNSIGNED_BYTE, all);
      this.cap = [W, H, D];
      this.stats.full++;
    } else {
      for (const k of this.pending) {
        const sl = this.slabs[k]!, [sx, sy, sz] = sl.size;
        if (sx && sy && sz) gl.texSubImage3D(gl.TEXTURE_3D, 0, sl.ax, 0, 0, sx, sy, sz, gl.RED, gl.UNSIGNED_BYTE, sl.data);
        this.stats.parts++;
      }
    }
    this.pending = [];
    this.stats.width = this.width; this.stats.capacity = [...this.cap];
  }
}

function uploadTo(gl: WebGL2RenderingContext, target: number, t: WebGLTexture): void {
  gl.activeTexture(gl.TEXTURE0 + UPLOAD_UNIT);
  gl.bindTexture(target, t);
}

function tex2D(gl: WebGL2RenderingContext, internal: number, w: number, h: number, format: number, type: number, data: ArrayBufferView | null): WebGLTexture {
  const t = gl.createTexture()!;
  uploadTo(gl, gl.TEXTURE_2D, t);
  nearest(gl, gl.TEXTURE_2D);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  return t;
}

function texArray(gl: WebGL2RenderingContext, internal: number, w: number, h: number, layers: number): WebGLTexture {
  const t = gl.createTexture()!;
  uploadTo(gl, gl.TEXTURE_2D_ARRAY, t);
  nearest(gl, gl.TEXTURE_2D_ARRAY);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internal, w, h, layers);
  return t;
}

// Un recuadro de un array que tiene `rowLen` elementos por fila y `comps` componentes por elemento
function subImage(gl: WebGL2RenderingContext, t: WebGLTexture, x: number, y: number, w: number, h: number, format: number, type: number, data: ArrayBufferView, rowLen: number, comps: number): void {
  void comps;
  uploadTo(gl, gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, rowLen);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, format, type, data);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
}

function bindTex(gl: WebGL2RenderingContext, unit: number, target: number, t: WebGLTexture | null, loc: WebGLUniformLocation | null): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, t);
  if (loc) gl.uniform1i(loc, unit);
}

function checkFbo(gl: WebGL2RenderingContext): void {
  const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`framebuffer incompleto: 0x${st.toString(16)}`);
}

// Las luces que alcanzan la vista (su caja de alcance proyectada la toca) y, si son más de MAX_LIGHTS, las más
// cercanas a su centro; en el orden de la lista, que es el de la suma en la CPU
function viewLights(all: readonly WorldLight[], b: Baked, o: Frame2DOptions): WorldLight[] {
  const cx = o.vx + o.vw / 2, cy = o.vy + o.vh / 2;
  const near: Array<{ l: WorldLight; d: number; i: number }> = [];
  all.forEach((l, i) => {
    const r = resolveLight(l, 0).radius;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const dx of [-r, r]) for (const dy of [-r, r]) for (const dz of [-r, r]) {
      const [sx, sy] = b.cam.project(l.x + dx, l.y + dy, l.z + dz);
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    if (x1 < o.vx || x0 > o.vx + o.vw || y1 < o.vy || y0 > o.vy + o.vh) return;
    const [px, py] = b.cam.project(l.x, l.y, l.z);
    near.push({ l, d: (px - cx) ** 2 + (py - cy) ** 2, i });
  });
  if (near.length > MAX_LIGHTS) {
    warnOnce(`más de ${MAX_LIGHTS} luces en la vista: la GPU usa las más cercanas al centro`);
    near.sort((p, q) => p.d - q.d).length = MAX_LIGHTS;
    near.sort((p, q) => p.i - q.i);
  }
  return near.map((n) => n.l);
}
