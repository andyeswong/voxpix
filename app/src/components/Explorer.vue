<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { Walker, fpBasis, materialsOf, type FpCamera } from '@core/index';
import { model, editor, ui } from '../store';
import { renderExplore } from '../preview';
import { drawEffectsFp } from '../effects';
import PxIcon from './PxIcon.vue';

// EXPLORAR (pedido de Andrés): caminar por dentro del modelo en primera persona, con un personaje invisible de la
// altura que se elija. El render es renderFirstPerson del núcleo (en la GPU si hay), a baja resolución y ampliado
// sin suavizar, así sigue siendo pixel art. Debajo del modelo hay un suelo infinito (z = 0) para no caer al vacío.
//   Clic: capturar el ratón para mirar · WASD / flechas: andar · Espacio: saltar (subir volando) · Mayús: correr
//   F: volar · C: bajar volando · R: volver al inicio · Esc: soltar el ratón, y otra vez para salir
const RW = 320, RH = 180;                    // la resolución del render (16:9)
const canvas = ref<HTMLCanvasElement>();
const hud = ref('');
const locked = ref(false);
const fly = ref(false);

const bounds = () => model.value.bounds() ?? { minX: -4, maxX: 4, minY: -4, maxY: 4, minZ: 0, maxZ: 0 };
let walker = spawn();
// El inicio: encima del borde sur del modelo, en el centro, mirando al norte (cae hasta lo que haya debajo)
function spawn(): Walker {
  const b = bounds(), m = model.value;
  const x = Math.floor((b.minX + b.maxX) / 2), y = b.minY + 1;
  let top = b.maxZ;
  while (top >= b.minZ && !m.get(x, y, top)) top--;
  const w = new Walker(x + 0.5, y + 0.5, top + 1, { height: editor.explore.height });
  w.yaw = 0; w.pitch = -6;
  return w;
}

// Lo que bloquea: lo que no se atraviesa del modelo (materials.ts) y el suelo infinito bajo z = 0. El agua se vadea.
const WATERY = /^(agua|water)$/i;
function solidFn(): (x: number, y: number, z: number) => boolean {
  const m = model.value, mt = materialsOf(m.palette), b = bounds();
  const floor = Math.min(0, b.minZ);
  const water = new Set(m.palette.ramps.flatMap((r, i) => (WATERY.test(r.name) ? [i] : [])));
  return (x, y, z) => {
    if (z < floor) return true;
    const v = m.get(x, y, z);
    if (!v) return false;
    if (water.has(Math.floor((v - 1) / 16))) return false;
    return !mt || mt.blocks[v] === 1;
  };
}

const keys = new Set<string>();
let raf = 0, last = 0, acc = 0, fps = 0, frames = 0, fpsT = 0, renderMs = 0, renderMax = 0;

function frame(now: number): void {
  raf = requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - (last || now)) / 1000);
  last = now;
  // La altura y el campo de visión se pueden cambiar mientras se anda
  if (walker.height !== editor.explore.height) { walker.height = editor.explore.height; walker.radius = Math.min(0.3, walker.height * 0.3); walker.speed = 4 + walker.height * 1.5; }
  const solid = solidFn();
  acc += dt;
  const k = (...c: string[]) => c.some((x) => keys.has(x));
  const input = {
    forward: (k('w', 'arrowup') ? 1 : 0) - (k('s', 'arrowdown') ? 1 : 0),
    strafe: (k('d', 'arrowright') ? 1 : 0) - (k('a', 'arrowleft') ? 1 : 0),
    jump: k(' '), down: k('c'), run: k('shift'), fly: fly.value,
  };
  while (acc >= 1 / 60) { walker.step(1 / 60, input, solid); acc -= 1 / 60; }
  const t0 = performance.now();
  draw();
  const ms = performance.now() - t0;
  renderMs = renderMs * 0.9 + ms * 0.1;
  if (frames > 10) renderMax = Math.max(renderMax, ms);
  frames++;
  if (now - fpsT > 500) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
  hud.value = `${fps} fps · render ${renderMs.toFixed(1)} ms (peor ${renderMax.toFixed(1)}) · pies ${walker.x.toFixed(1)}, ${walker.y.toFixed(1)}, ${walker.z.toFixed(1)} · altura ${walker.height}${fly.value ? ' · volando' : ''}`;
}

const SKY = [[42, 40, 58], [96, 104, 140]] as const;      // arriba y en el horizonte
const FLOOR = [[58, 62, 74], [54, 58, 69]] as const;       // las losetas del suelo (como la vista previa)
function draw(): void {
  const c = canvas.value;
  if (!c) return;
  const cam: FpCamera = { ...walker.eye(), fov: editor.explore.fov };
  const img = renderExplore(cam, { width: RW, height: RH, outline: editor.view.outline }, performance.now() / 1000);
  const out = new ImageData(RW, RH);
  const floor = Math.min(0, bounds().minZ);
  // Los rayos de los píxeles vacíos (cielo o suelo): la base de la cámara una vez, no por píxel
  const { f, r, u } = fpBasis(cam);
  const th = Math.tan(((cam.fov ?? 70) * Math.PI) / 360), tv = th * (RH / RW);
  for (let j = 0; j < RH; j++) for (let i = 0; i < RW; i++) {
    const p = j * RW + i, o = p * 4;
    if (img.rgba[o + 3]) { out.data[o] = img.rgba[o]!; out.data[o + 1] = img.rgba[o + 1]!; out.data[o + 2] = img.rgba[o + 2]!; out.data[o + 3] = 255; continue; }
    const a = ((i + 0.5) / RW) * 2 - 1, b = 1 - ((j + 0.5) / RH) * 2;
    const d = [f[0] + r[0] * a * th + u[0] * b * tv, f[1] + r[1] * a * th + u[1] * b * tv, f[2] + r[2] * a * th + u[2] * b * tv] as const;
    let col: readonly number[];
    if (d[2] < 0 && cam.z > floor) {
      // El suelo infinito: losetas de 4 vóxeles
      const t = (floor - cam.z) / d[2], x = cam.x + d[0] * t, y = cam.y + d[1] * t;
      col = FLOOR[(Math.floor(x / 4) + Math.floor(y / 4)) & 1]!;
    } else {
      const h = Math.max(0, Math.min(1, d[2] / Math.hypot(d[0], d[1], d[2]) * 2));
      col = SKY[1].map((v, n) => Math.round(v + (SKY[0][n]! - v) * h));
    }
    const k = editor.light.enabled ? Math.min(1, editor.light.ambient * 1.4) : 1;     // de noche, también más oscuros
    out.data[o] = col[0]! * k; out.data[o + 1] = col[1]! * k; out.data[o + 2] = col[2]! * k; out.data[o + 3] = 255;
  }
  drawEffectsFp(out.data, cam, img);
  c.getContext('2d')!.putImageData(out, 0, 0);
}

function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase();
  if (e.type === 'keyup') { keys.delete(k); return; }
  if (k === 'escape') { if (!locked.value) close(); return; }
  keys.add(k);
  if (k === 'f') fly.value = !fly.value;
  if (k === 'r') walker = spawn();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  e.stopPropagation();
}
function onMouse(e: MouseEvent): void {
  if (!locked.value) return;
  walker.yaw = (((walker.yaw + e.movementX * 0.15) % 360) + 360) % 360;
  walker.pitch = Math.max(-89, Math.min(89, walker.pitch - e.movementY * 0.15));
}
function lockChange(): void { locked.value = document.pointerLockElement === canvas.value; }
function capture(): void { canvas.value?.requestPointerLock(); }
function close(): void { if (document.pointerLockElement) document.exitPointerLock(); ui.explore = false; }

const scale = computed(() => Math.max(1, Math.floor(Math.min(innerWidth / RW, (innerHeight - 80) / RH))));

onMounted(() => {
  addEventListener('keydown', onKey, true); addEventListener('keyup', onKey, true);
  addEventListener('mousemove', onMouse);
  document.addEventListener('pointerlockchange', lockChange);
  raf = requestAnimationFrame(frame);
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  removeEventListener('keydown', onKey, true); removeEventListener('keyup', onKey, true);
  removeEventListener('mousemove', onMouse);
  document.removeEventListener('pointerlockchange', lockChange);
});
</script>

<template>
  <div class="explore">
    <canvas ref="canvas" :width="RW" :height="RH" :style="{ width: `${RW * scale}px`, height: `${RH * scale}px` }" @click="capture" />
    <div class="bar pill">
      <span class="title"><PxIcon name="walk" />Explorar</span>
      <label>Altura <input v-model.number="editor.explore.height" type="range" min="1" max="32" step="1" /> <b>{{ editor.explore.height }}</b></label>
      <label>Visión <input v-model.number="editor.explore.fov" type="range" min="45" max="110" step="5" /> <b>{{ editor.explore.fov }}°</b></label>
      <button class="ghost" :class="{ on: fly }" title="Volar (F)" @click="fly = !fly">Volar</button>
      <button class="ghost" title="Volver al inicio (R)" @click="walker = spawn()">Inicio</button>
      <button class="primary" title="Salir (Esc)" @click="close">Salir</button>
    </div>
    <div class="help">{{ locked ? 'WASD andar · Espacio saltar · Mayús correr · F volar · C bajar · R inicio · Esc soltar el ratón' : 'Clic en la vista para mirar con el ratón · Esc para salir' }}</div>
    <div class="hud">{{ hud }}</div>
  </div>
</template>

<style scoped>
.explore { position: fixed; inset: 0; z-index: 50; background: #0d0c12; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
canvas { image-rendering: pixelated; cursor: crosshair; border-radius: 6px; }
.bar { display: flex; align-items: center; gap: 14px; padding: 6px 12px; }
.bar label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted, #8e8ca6); }
.title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.help, .hud { font-size: 12px; color: #8e8ca6; }
.hud { position: fixed; left: 12px; top: 10px; }
</style>
