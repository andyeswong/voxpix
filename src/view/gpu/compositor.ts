// VISTA (NARUTO): el cuadro del modo 2D compuesto en la GPU con WebGL2. Hace lo mismo que frame2D (CPU), que es su
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
import { DIR_VECTORS, unkey } from '../../core';
import { resolveLight } from '../../world/lightutil';
import { entitySprite, warmEntity, HEADINGS, entityDepthRange, entityLightPick, emissiveMask, onView, shadowCasters, occupancy, screenBox, dropLook, SHADOW_REACH, EW, EH, BACKGROUND, type Frame2DOptions, type EntitySprite } from '../../world/frame2d';
import { worldPointAt, type Baked, type BakedLight } from '../../world/bake';
import type { WorldState } from '../../world/state';
import type { Rendered, VoxelSource } from '../../core';
import { FRAG_CONTACT, FRAG_DROPS, FRAG_ENTITY, FRAG_SCENE, FRAG_SHADE, FRAG_WATER, MAX_BAKED, MAX_CASTERS, MAX_LIGHTS, VERT_CONTACT, VERT_DROPS, VERT_ENTITY, VERT_FULLSCREEN } from './shaders';

export type GpuOutput = 'frame' | 'color' | 'multiply' | 'add';
// Un modelo para precalentar: en qué giros (por defecto los 8 rumbos) y si da sombra de verdad
export interface WarmItem { model: VoxelSource; yaws?: readonly number[]; casts?: boolean }
// Tope del atlas de sprites de entidades (48x72 cada uno, ~40 KB en la GPU y ~60 KB en la CPU)
export const MAX_SPRITE_LAYERS = 1024;

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
  private readonly shade: Program;
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
  readonly parts = { baked: 0, entities: 0, casters: 0, water: 0, drops: 0 };

  // Lo subido del horneado
  private baked: Baked | null = null;
  private bakedSerial = 0;
  private tColor: WebGLTexture | null = null;
  private tDepth: WebGLTexture | null = null;
  private tFace: WebGLTexture | null = null;
  private tWorldY: WebGLTexture | null = null;
  private worldY = new Float32Array(0);
  private tWeights: WebGLTexture | null = null;
  private weightZones: BakedLight[] = [];
  // Entidades: el atlas de sprites (una capa por modelo y giro), el de sus cuerpos sin girar (para el rayo de su
  // propia luz) y los cuerpos girados de las que dan sombra de verdad
  private sprites = new Map<string, number>();
  private spriteImgs: Rendered[] = [];
  private spriteEmissive: Array<Uint8Array | null> = [];
  private spriteCap = 0;
  // Cuándo se usó cada capa por última vez (en cuadros): con el atlas lleno, la nueva ocupa la menos usada
  private spriteUse: number[] = [];
  private frameNo = 0;
  private tSprColor: WebGLTexture | null = null;
  private tSprDepth: WebGLTexture | null = null;
  private tSprVox: WebGLTexture | null = null;
  private bodies = new Map<VoxelSource, { ax: number; min: [number, number, number]; size: [number, number, number]; data: Uint8Array }>();
  private bodyW = 0;
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
  // Destinos de la vista
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
    this.shade = program(gl, VERT_FULLSCREEN, FRAG_SHADE);
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
    [this.entVao, this.entBuf] = instanced(this.ent.prog, [['aPlace', 4], ['aPos', 4], ['aOcc', 4], ['aOccSize', 4], ['aMask', 2], ['aTint', 4]]);
    [this.contactVao, this.contactBuf] = instanced(this.contact.prog, [['aFeet', 3]]);
    this.vao = gl.createVertexArray()!;
    this.dropsVao = gl.createVertexArray()!;
    this.dropsBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.dropsVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dropsBuf);
    const loc = gl.getAttribLocation(this.drops.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
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
  }

  // Pinta el cuadro en el lienzo
  frame(state: WorldState, b: Baked, o: Frame2DOptions): void {
    this.frameNo++;
    this.compose(state, b, o);
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.present(o, 0, true);
  }

  // Para la prueba del oráculo: una salida del cuadro en RGBA, fila 0 arriba (como frame2D)
  read(state: WorldState, b: Baked, o: Frame2DOptions, what: GpuOutput = 'frame'): Uint8Array {
    const gl = this.gl;
    this.frameNo++;
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

  private compose(state: WorldState, b: Baked, o: Frame2DOptions): void {
    const gl = this.gl;
    let up = performance.now();
    this.syncBaked(b);
    this.syncWeights(b);
    let upMs = performance.now() - up;
    this.parts.baked = upMs;
    const [A, B] = this.ensureTargets(o.vw, o.vh);
    gl.viewport(0, 0, o.vw, o.vh);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);

    // Las luces del mundo de este cuadro (las mismas para la escena, las sombras y el agua)
    const lights = state.lights.slice(0, MAX_LIGHTS).map((l) => ({ l, p: resolveLight(l, o.time) }));
    if (state.lights.length > MAX_LIGHTS) warnOnce(`más de ${MAX_LIGHTS} luces: la GPU usa las primeras`);
    const layerOf = new Map(b.lights.map((bl, i) => [bl.light.id, i] as const));

    // Las luces del mundo: la tabla (posición y radio; color e intensidad; capa horneada, k, dinámica)
    const nb = Math.min(MAX_BAKED, b.lights.length);
    const tab = this.lightTab;
    tab.fill(0);
    lights.forEach(({ l, p }, i) => {
      const layer = layerOf.get(l.id);
      const baked = layer !== undefined && layer < nb;
      tab.set([l.x, l.y, l.z, p.radius], (i * 4) * 4);
      tab.set([p.color[0], p.color[1], p.color[2], p.intensity], (i * 4 + 1) * 4);
      tab.set([baked ? layer : -1, baked ? p.intensity / b.lights[layer]!.intensity : 0, l.baked === false ? 1 : 0, p.spot?.cosInner ?? 1], (i * 4 + 2) * 4);
      tab.set(p.spot ? [...p.spot.dir, p.spot.cosOuter] : [0, 0, 0, -2], (i * 4 + 3) * 4);
    });
    uploadTo(gl, gl.TEXTURE_2D, this.tLights);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4, MAX_LIGHTS, gl.RGBA, gl.FLOAT, tab);

    // 0) las entidades y sus sombras de contacto
    up = performance.now();
    const E = this.ensureEntTarget(o.vw, o.vh);
    const sprites = state.entities.map((e) => entitySprite(b, e, o)).filter((d) => onView(d, o));
    this.drawEntities(state, sprites, E, o, lights.length);
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
    const a = b.options.oblique?.y ?? 1;
    gl.uniform2i(s.u.uView, o.vx, o.vy);
    const bg = o.background ?? BACKGROUND;
    gl.uniform3f(s.u.uBg, bg[0] / 255, bg[1] / 255, bg[2] / 255);
    gl.uniform3f(s.u.uAmbient, o.ambient[0], o.ambient[1], o.ambient[2]);
    gl.uniform1i(s.u.uLights, o.lights ? 1 : 0);
    gl.uniform1f(s.u.uA, a);
    gl.uniform1f(s.u.uOriginY, b.options.originY ?? 0);
    gl.uniform1f(s.u.uF1, b.cam.fwd[1]);
    gl.uniform1f(s.u.uF2, b.cam.fwd[2]);
    gl.uniform3fv(s.u.uDirs, DIR_VECTORS.flat());
    // Luces horneadas (lightView)
    const rect = new Int32Array(MAX_BAKED * 4), ck = new Float32Array(MAX_BAKED * 3);
    for (let i = 0; i < nb; i++) {
      const bl = b.lights[i]!;
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
      const yOf = (sy: number, z: number) => (originY - sy - z) / a;
      const gx0 = Math.max(0, Math.floor(o.vx / CELL) - 1), gx1 = Math.min(wl.gw - 1, Math.ceil((o.vx + o.vw) / CELL) + 1);
      const gy0 = Math.max(0, Math.floor(yOf(o.vy + o.vh, -12) / CELL) - 2), gy1 = Math.min(wl.gh - 1, Math.ceil(yOf(o.vy, 12) / CELL) + 2);
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
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 3) las gotas, sobre lo que dejó el agua
    const drop = dropLook(state, o.ambient);
    up = performance.now();
    const n = drop ? this.projectDrops(state, b, o) : 0;
    this.parts.drops = performance.now() - up;
    this.uploadMs = upMs + this.parts.drops;
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
    gl.uniform1i(p.u.uMode, mode);
    gl.uniform1i(p.u.uFlip, flip ? 1 : 0);
    gl.uniform1i(p.u.uHeight, o.vh);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // ---- lo que se sube

  private syncBaked(b: Baked): void {
    const gl = this.gl;
    const pub = b.published;
    if (this.baked !== b || !this.tColor) {
      this.baked = b;
      for (const t of [this.tColor, this.tDepth, this.tFace, this.tWorldY]) if (t) gl.deleteTexture(t);
      this.tColor = tex2D(gl, gl.RGBA8, b.width, b.height, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba);
      this.tDepth = tex2D(gl, gl.R32F, b.width, b.height, gl.RED, gl.FLOAT, b.depth);
      this.tFace = tex2D(gl, gl.R8I, b.width, b.height, gl.RED_INTEGER, gl.BYTE, b.face);
      this.worldY = new Float32Array(b.width * b.height);
      fillWorldY(b, this.worldY, 0, 0, b.width - 1, b.height - 1);
      this.tWorldY = tex2D(gl, gl.R32F, b.width, b.height, gl.RED, gl.FLOAT, this.worldY);
      this.bakedSerial = pub.serial;
      this.weightZones = [];
      return;
    }
    if (pub.serial === this.bakedSerial) return;
    const oldest = pub.rects[0]?.serial ?? Infinity;
    if (oldest > this.bakedSerial + 1) {
      // Se quedó atrás: todo de nuevo
      subImage(gl, this.tColor, 0, 0, b.width, b.height, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba, b.width, 4);
      subImage(gl, this.tDepth!, 0, 0, b.width, b.height, gl.RED, gl.FLOAT, b.depth, b.width, 1);
      subImage(gl, this.tFace!, 0, 0, b.width, b.height, gl.RED_INTEGER, gl.BYTE, b.face, b.width, 1);
      fillWorldY(b, this.worldY, 0, 0, b.width - 1, b.height - 1);
      subImage(gl, this.tWorldY!, 0, 0, b.width, b.height, gl.RED, gl.FLOAT, this.worldY, b.width, 1);
    } else for (const r of pub.rects) {
      if (r.serial <= this.bakedSerial) continue;
      const w = r.x1 - r.x0 + 1, h = r.y1 - r.y0 + 1;
      subImage(gl, this.tColor, r.x0, r.y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b.rgba, b.width, 4);
      subImage(gl, this.tDepth!, r.x0, r.y0, w, h, gl.RED, gl.FLOAT, b.depth, b.width, 1);
      subImage(gl, this.tFace!, r.x0, r.y0, w, h, gl.RED_INTEGER, gl.BYTE, b.face, b.width, 1);
      fillWorldY(b, this.worldY, r.x0, r.y0, r.x1, r.y1);
      subImage(gl, this.tWorldY!, r.x0, r.y0, w, h, gl.RED, gl.FLOAT, this.worldY, b.width, 1);
    }
    this.bakedSerial = pub.serial;
  }

  // Los pesos de las luces fijas: una capa por luz (en el orden de b.lights). Se rehacen cuando cambia alguna zona
  private syncWeights(b: Baked): void {
    const gl = this.gl;
    const zones = b.lights.slice(0, MAX_BAKED);
    if (b.lights.length > MAX_BAKED) warnOnce(`más de ${MAX_BAKED} luces horneadas: la GPU usa las primeras`);
    if (zones.length === this.weightZones.length && zones.every((z, i) => z === this.weightZones[i])) return;
    const W = Math.max(1, ...zones.map((z) => z.rect.w)), H = Math.max(1, ...zones.map((z) => z.rect.h));
    if (this.tWeights) gl.deleteTexture(this.tWeights);
    this.tWeights = texArray(gl, gl.R32F, W, H, Math.max(1, zones.length));
    zones.forEach((z, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, z.rect.w, z.rect.h, 1, gl.RED, gl.FLOAT, z.weight));
    this.weightZones = zones;
  }

  // Las sombras de verdad: las MAX_CASTERS entidades de shadowCasters, con su cuerpo girado (cuartos de vuelta)
  private setCasters(state: WorldState, b: Baked, o: Frame2DOptions, lights: WorldState['lights'][number][]): void {
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
  private drawEntities(state: WorldState, sprites: EntitySprite[], E: EntTarget, o: Frame2DOptions, nLights: number): void {
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
    if (layer !== undefined) { this.spriteUse[layer] = this.frameNo; return layer; }
    const gl = this.gl;
    const cap = Math.min(MAX_SPRITE_LAYERS, gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number);
    if (this.spriteImgs.length < cap) {
      layer = this.spriteImgs.length;
      if (layer >= this.spriteCap) {
        // Atlas lleno: uno el doble de grande, y se vuelven a subir los que había (se guardan en la CPU)
        this.spriteCap = Math.min(cap, Math.max(64, this.spriteCap * 2));
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
      this.spriteImgs[layer] = d.img;
      this.spriteEmissive[layer] = emissiveMask(d);
    }
    this.sprites.set(d.key, layer);
    this.spriteUse[layer] = this.frameNo;
    this.uploadSprite(d.img, layer, this.spriteEmissive[layer] ?? null);
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
    for (const it of list) {
      for (const yaw of it.yaws ?? HEADINGS) {
        if (performance.now() - t0 > budgetMs) { left++; continue; }
        this.spriteLayer(entitySprite(b, warmEntity(it.model, yaw), o));
        if (it.casts) occs.push(occupancy(it.model, yaw));
      }
      if (o.lights) this.body(it.model);
    }
    this.syncBodies();
    if (occs.length) { const place = this.occPlace; this.syncOcc(occs); this.occPlace = place; }
    return left;
  }

  // Cuántos sprites hay en el atlas (para medir)
  get spriteCount(): number { return this.spriteImgs.length; }

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
    bd = { ax: this.bodyW, min: [x0, y0, z0], size, data };
    this.bodyW += size[0];
    this.bodies.set(m, bd);
    this.bodiesDirty = true;
    return bd;
  }
  private bodiesDirty = false;

  private syncBodies(): void {
    if (!this.bodiesDirty) return;
    this.bodiesDirty = false;
    const gl = this.gl;
    let H = 1, D = 1;
    for (const bd of this.bodies.values()) { H = Math.max(H, bd.size[1]); D = Math.max(D, bd.size[2]); }
    const W = Math.max(1, this.bodyW);
    const all = new Uint8Array(W * H * D);
    for (const bd of this.bodies.values()) {
      const [sx, sy, sz] = bd.size;
      for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) all.set(bd.data.subarray((z * sy + y) * sx, (z * sy + y + 1) * sx), (z * H + y) * W + bd.ax);
    }
    uploadTo(gl, gl.TEXTURE_3D, this.tBody);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, W, H, D, 0, gl.RED, gl.UNSIGNED_BYTE, all);
  }

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
      if (this.occSlabs.has(o)) continue;
      const size: [number, number, number] = [o.max[0] - o.min[0], o.max[1] - o.min[1], o.max[2] - o.min[2]];
      const data = new Uint8Array(size[0] * size[1] * size[2]);
      for (const k of o.set) {
        const [x, y, z] = unkey(k);
        data[((z - o.min[2]) * size[1] + (y - o.min[1])) * size[0] + (x - o.min[0])] = 255;
      }
      this.occSlabs.set(o, { ax: this.occW, size, data });
      this.occW += size[0];
      grown = true;
    }
    this.occPlace = occs.map((o) => { const sl = this.occSlabs.get(o)!; return { min: o.min, size: sl.size, ax: sl.ax }; });
    if (!grown) return;
    const gl = this.gl;
    let H = 1, D = 1;
    for (const sl of this.occSlabs.values()) { H = Math.max(H, sl.size[1]); D = Math.max(D, sl.size[2]); }
    const W = Math.max(1, this.occW);
    const all = new Uint8Array(W * H * D);
    for (const sl of this.occSlabs.values()) {
      const [sx, sy, sz] = sl.size;
      for (let z = 0; z < sz; z++) for (let y = 0; y < sy; y++) all.set(sl.data.subarray((z * sy + y) * sx, (z * sy + y + 1) * sx), (z * H + y) * W + sl.ax);
    }
    uploadTo(gl, gl.TEXTURE_3D, this.tOcc);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, W, H, D, 0, gl.RED, gl.UNSIGNED_BYTE, all);
  }
  private occSlabs = new Map<object, { ax: number; size: [number, number, number]; data: Uint8Array }>();
  private occW = 0;

  private syncWater(state: WorldState, b: Baked, o: Frame2DOptions): boolean {
    const gl = this.gl;
    const wl = state.water;
    if (!wl) return false;
    const sim = wl.sim;
    if (this.waterOf !== wl || !this.tWDepth) {
      this.waterOf = wl;
      for (const t of [this.tWDepth, this.tWStatic]) if (t) gl.deleteTexture(t);
      const st = new Float32Array(wl.gw * wl.gh * 4);
      for (let i = 0; i < wl.gw * wl.gh; i++) { st[i * 4] = sim.ground[i]!; st[i * 4 + 1] = sim.solid[i]!; st[i * 4 + 2] = wl.isBasin(i) ? 1 : 0; }
      this.tWStatic = tex2D(gl, gl.RGBA32F, wl.gw, wl.gh, gl.RGBA, gl.FLOAT, st);
      this.tWDepth = tex2D(gl, gl.R32F, wl.gw, wl.gh, gl.RED, gl.FLOAT, sim.depth);
      return true;
    }
    // Cada cuadro, solo las columnas de celdas que se ven (y una más a cada lado, por las vecinas)
    const gx0 = Math.max(0, Math.floor(o.vx / 2) - 2), gx1 = Math.min(wl.gw - 1, Math.ceil((o.vx + o.vw) / 2) + 2);
    subImage(gl, this.tWDepth, gx0, 0, gx1 - gx0 + 1, wl.gh, gl.RED, gl.FLOAT, sim.depth, wl.gw, 1);
    void b;
    return true;
  }

  private waterTones(state: WorldState): Float32Array {
    return new Float32Array(state.water!.toneColors.flat());
  }

  private projectDrops(state: WorldState, b: Baked, o: Frame2DOptions): number {
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

// Floats por entidad en el búfer de instancias (aPlace, aPos, aOcc, aOccSize, aMask)
const REC = 22;

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
