// ANIMACIÓN en el editor (pedido de Andrés): una línea de tiempo de cuadros, cada uno el modelo entero con su propio
// historial de deshacer y todos con la misma paleta. Se edita el cuadro actual con las herramientas de siempre (el
// cuadro actual ES model.value). Encima, el rig por partes (src/anim/rig.ts, RigSpec): con un rig, el cuadro 0 es la
// pose de reposo y los demás salen de él (generateFromRig); la reproducción y la exportación usan entonces los
// cuadros 1..n. Lo mismo por la API de agentes (api.ts, anim*).
import { reactive, watch } from 'vue';
import { History, Model, clipsToFile, clipsFromFile, fitFrame, encodeGIF, DEFAULT_FRAME_MS, DEFAULT_CLIP, type ModelFile, type ModelFileV2, type ModelFileV3 } from '@core/index';
import { shot } from './preview';
import { rigFrames, rigFromSpec, type RigSpec } from '../../src/anim/rig';
import { model, history, touch, replaceModel, editor, type LightSource3D } from './store';
import { fx, loadEffects, type EffectSource } from './effects';

interface Frame { model: Model; history: History; ms: number }
// Los clips con nombre (quieto, andar, atacar...): cada uno sus cuadros, su rig y si se repite. `frames` son los del
// clip abierto; todo lo demás (cuadros, rig, reproducir, exportar) trabaja sobre él
interface ClipState { name: string; frames: Frame[]; rig: RigSpec | null; loop: boolean }
let clips: ClipState[] = [];
let ci = 0;
let frames: Frame[] = [];

export const anim = reactive({
  count: 1,
  current: 0,
  playing: false,
  onion: false,                  // papel cebolla: el cuadro anterior, en fantasma, al editar
  ms: DEFAULT_FRAME_MS,          // la duración del cuadro actual
  rig: null as RigSpec | null,
  panel: false,                  // el panel del rig abierto
  clip: DEFAULT_CLIP,            // el clip abierto
  clips: [DEFAULT_CLIP] as string[],
  loop: true,                    // si el clip abierto se repite
});

// Al salir del modo Animación, la reproducción para
watch(() => editor.mode, (m) => { if (m !== 'animacion' && anim.playing) play(false); });

// Si el modelo cambió por fuera (abrir, nuevo, muestra), la animación vuelve a ser un solo cuadro
function ensure(): void {
  if (frames[anim.current]?.model === model.value) return;
  frames = [{ model: model.value, history: history.value, ms: DEFAULT_FRAME_MS }];
  clips = [{ name: DEFAULT_CLIP, frames, rig: null, loop: true }];
  ci = 0;
  anim.current = 0; anim.count = 1; anim.ms = DEFAULT_FRAME_MS; anim.rig = null;
  anim.clip = DEFAULT_CLIP; anim.clips = [DEFAULT_CLIP]; anim.loop = true;
}

// ---- clips
function syncClip(): void {
  const c = clips[ci]!;
  c.frames = frames; c.rig = anim.rig; c.loop = anim.loop;
}
function openClip(i: number, frame = 0): void {
  play(false);
  syncClip();
  ci = i;
  const c = clips[i]!;
  frames = c.frames;
  anim.rig = c.rig; anim.loop = c.loop; anim.clip = c.name; anim.count = frames.length;
  select(Math.min(frame, frames.length - 1));
}
export function clipNames(): string[] { ensure(); return clips.map((c) => c.name); }
export function clipInfo(): Array<{ name: string; frames: number; loop: boolean; current: boolean }> {
  ensure(); syncClip();
  return clips.map((c, i) => ({ name: c.name, frames: c.frames.length, loop: c.loop, current: i === ci }));
}
// Abre un clip por su nombre
export function selectClip(name: string): void {
  ensure();
  const i = clips.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`no hay clip "${name}"; hay: ${clips.map((c) => c.name).join(', ')}`);
  if (i !== ci) openClip(i);
}
// Un clip nuevo con un cuadro: copia del cuadro 0 del clip abierto (la pose de reposo), o vacío; y lo abre
export function newClip(name: string, o: { empty?: boolean; loop?: boolean } = {}): void {
  ensure();
  if (!name) throw new Error('el clip necesita un nombre');
  if (clips.some((c) => c.name === name)) throw new Error(`ya hay un clip "${name}"`);
  const src = frames[0]!.model;
  const m = o.empty ? new Model(src.palette, src.name) : src.clone();
  m.palette = model.value.palette;
  clips.push({ name, frames: [{ model: m, history: new History(m), ms: frames[0]!.ms }], rig: null, loop: o.loop ?? true });
  anim.clips = clips.map((c) => c.name);
  openClip(clips.length - 1);
}
export function renameClip(from: string, to: string): void {
  ensure();
  const c = clips.find((x) => x.name === from);
  if (!c) throw new Error(`no hay clip "${from}"`);
  if (!to || clips.some((x) => x.name === to)) throw new Error(`nombre no válido o repetido: "${to}"`);
  c.name = to;
  anim.clips = clips.map((x) => x.name);
  if (clips[ci] === c) anim.clip = to;
}
export function deleteClip(name: string): void {
  ensure();
  const i = clips.findIndex((c) => c.name === name);
  if (i < 0) throw new Error(`no hay clip "${name}"`);
  if (clips.length <= 1) throw new Error('el modelo necesita al menos un clip');
  play(false);
  syncClip();
  const open = clips[ci]!;
  clips.splice(i, 1);
  anim.clips = clips.map((c) => c.name);
  const k = clips.indexOf(open);
  if (k >= 0) { ci = k; return; }             // el abierto sigue: solo cambia su posición
  ci = Math.min(i, clips.length - 1);
  const c = clips[ci]!;
  frames = c.frames; anim.rig = c.rig; anim.loop = c.loop; anim.clip = c.name; anim.count = frames.length;
  select(0);
}
// Si el clip abierto se repite (andar) o se queda en su último cuadro (morir)
export function setLoop(on: boolean): void { ensure(); anim.loop = on; clips[ci]!.loop = on; }

export function frameModels(): Model[] { ensure(); return frames.map((f) => f.model); }
export function frameMs(): number[] { ensure(); return frames.map((f) => f.ms); }
// Los cuadros que se reproducen y se exportan: con rig, sin la pose de reposo
export function playRange(): number[] { ensure(); const all = frames.map((_, i) => i); return anim.rig && frames.length > 1 ? all.slice(1) : all; }

export function selectFrame(i: number): void {
  ensure();
  select(i);
}

// Sin ensure(): para las operaciones que acaban de cambiar la lista de cuadros (si no, ensure creería que el modelo
// cambió por fuera y reiniciaría la animación)
function select(i: number): void {
  const f = frames[Math.max(0, Math.min(frames.length - 1, i))]!;
  f.model.palette = model.value.palette;        // una sola paleta: la que tenga el cuadro que se deja
  model.value = f.model; history.value = f.history;
  anim.current = frames.indexOf(f); anim.ms = f.ms;
  touch();
}

// Un cuadro nuevo después del actual: copia del actual (o vacío)
export function addFrame(empty = false): number {
  ensure();
  const cur = frames[anim.current]!;
  const m = empty ? new Model(cur.model.palette, cur.model.name) : cur.model.clone();
  m.palette = cur.model.palette;
  frames.splice(anim.current + 1, 0, { model: m, history: new History(m), ms: cur.ms });
  anim.count = frames.length;
  select(anim.current + 1);
  return anim.current;
}

export function deleteFrame(i = anim.current): void {
  ensure();
  if (frames.length <= 1) throw new Error('la animación necesita al menos un cuadro');
  frames.splice(i, 1);
  anim.count = frames.length;
  select(Math.min(i, frames.length - 1));
}

export function moveFrame(from: number, to: number): void {
  ensure();
  if (from < 0 || from >= frames.length || to < 0 || to >= frames.length) throw new Error(`cuadros 0..${frames.length - 1}`);
  const [f] = frames.splice(from, 1);
  frames.splice(to, 0, f!);
  select(to);
}

export function setFrameMs(ms: number, all = false): void {
  ensure();
  const v = Math.max(10, Math.min(5000, Math.round(ms)));
  for (const f of all ? frames : [frames[anim.current]!]) f.ms = v;
  anim.ms = v;
}

let timer = 0;
export function play(on = !anim.playing): void {
  ensure();
  clearTimeout(timer);
  anim.playing = on;
  if (!on) return;
  const tick = () => {
    if (!anim.playing) return;
    const range = playRange();
    const k = range.indexOf(anim.current);
    select(range[(k + 1) % range.length]!);
    timer = window.setTimeout(tick, frames[anim.current]!.ms);
  };
  timer = window.setTimeout(tick, frames[anim.current]!.ms);
}

// ---- el rig: con él, el cuadro 0 es la pose de reposo y los demás se generan
export function setRig(spec: RigSpec | null): void {
  if (spec) rigFromSpec(spec);                   // falla aquí si una parte está mal
  anim.rig = spec ? JSON.parse(JSON.stringify(spec)) as RigSpec : null;
}
export function generateFromRig(spec = anim.rig): number {
  ensure();
  if (!spec) throw new Error('no hay rig: setRig primero');
  setRig(spec);
  const base = frames[0]!.model;
  const made = rigFrames(base, rigFromSpec(spec)).map((m): Frame => { m.palette = base.palette; m.name = base.name; return { model: m, history: new History(m), ms: spec.frameMs }; });
  frames = [frames[0]!, ...made];
  clips[ci]!.frames = frames;
  anim.count = frames.length;
  select(1);
  return made.length;
}

// ---- archivo
// Con los emisores de efectos (effects.ts) solo si hay alguno: así un modelo sin ellos se guarda como siempre
export function toFile(lights: LightSource3D[]): (ModelFile | ModelFileV2 | ModelFileV3) & { lights: LightSource3D[]; effects?: EffectSource[] } {
  ensure();
  syncClip();
  for (const c of clips) for (const f of c.frames) f.model.palette = model.value.palette;
  const file = clipsToFile(clips.map((c) => ({ name: c.name, loop: c.loop, frames: c.frames.map((f) => ({ model: f.model, ms: f.ms })), ...(c.rig ? { rig: c.rig } : {}) })));
  return { ...file, lights, ...(fx.sources.length ? { effects: fx.sources.map((s) => ({ ...s })) } : {}) };
}

export function loadAnimated(f: (ModelFile | ModelFileV2 | ModelFileV3) & { lights?: LightSource3D[]; effects?: EffectSource[] }): void {
  play(false);
  const cs = clipsFromFile(f);
  replaceModel(cs[0]!.frames[0]!.model);
  clips = cs.map((c, k) => ({
    name: c.name, loop: c.loop, rig: (c.rig as RigSpec | undefined) ?? null,
    frames: c.frames.map((fr, i) => ({ model: fr.model, history: k === 0 && i === 0 ? history.value : new History(fr.model), ms: fr.ms })),
  }));
  ci = 0; frames = clips[0]!.frames;
  anim.count = frames.length; anim.current = 0; anim.ms = frames[0]!.ms;
  anim.rig = clips[0]!.rig; anim.loop = clips[0]!.loop; anim.clip = clips[0]!.name; anim.clips = clips.map((c) => c.name);
  editor.light.sources.splice(0, editor.light.sources.length, ...(f.lights ?? []));
  if (f.lights?.length) editor.light.enabled = true;
  loadEffects(f.effects);
  touch();
}

// ---- exportar: la hoja (los cuadros en fila) y el GIF, en el ángulo de la vista previa, con el mismo encuadre para
// todos (el que contiene a todos los cuadros) y con luz si la vista previa la tiene
export function renderFrames(): { W: number; H: number; images: Uint8ClampedArray<ArrayBuffer>[]; ms: number[] } {
  ensure();
  play(false);
  const keep = anim.current, range = playRange();
  let b: ReturnType<Model['bounds']> = null;
  for (const i of range) {
    const fb = frames[i]!.model.bounds();
    if (!fb) continue;
    b = b ? { minX: Math.min(b.minX, fb.minX), maxX: Math.max(b.maxX, fb.maxX), minY: Math.min(b.minY, fb.minY), maxY: Math.max(b.maxY, fb.maxY), minZ: Math.min(b.minZ, fb.minZ), maxZ: Math.max(b.maxZ, fb.maxZ) } : fb;
  }
  const f = fitFrame(b, editor.view.elevation);
  const images: Uint8ClampedArray<ArrayBuffer>[] = [];
  for (const i of range) { select(i); images.push(shot(f, editor.view.yaw, { lit: editor.light.enabled, time: 0, bg: 'nada' })); }
  select(keep);
  return { W: f.W, H: f.H, images, ms: range.map((i) => frames[i]!.ms) };
}

export function sheetPng(scale = 1): Promise<Blob> {
  const { W, H, images } = renderFrames();
  const c = document.createElement('canvas');
  c.width = W * images.length * scale; c.height = H * scale;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  images.forEach((img, k) => {
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    off.getContext('2d')!.putImageData(new ImageData(img, W, H), 0, 0);
    g.drawImage(off, k * W * scale, 0, W * scale, H * scale);
  });
  return new Promise((res, rej) => c.toBlob((bl) => (bl ? res(bl) : rej(new Error('sin PNG'))), 'image/png'));
}

// El GIF lleva una sola duración por cuadro: la media de las suyas (GIF89a mínimo, src/core/gif.ts)
export function animGif(scale = 1): Blob {
  const { W, H, images, ms } = renderFrames();
  const avg = Math.round(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length));
  return new Blob([new Uint8Array(encodeGIF(W, H, images, avg, scale))], { type: 'image/gif' });
}
