<script setup lang="ts">
import { ref, reactive, watch, onMounted, onUnmounted } from 'vue';
import { camera } from '@core/index';
import { SOURCE_PRESETS } from '../../../src/lighting';
import { model, version, editor, ui } from '../store';
import { frameFor, shot, viewOptions, type Frame } from '../preview';
import PxIcon from './PxIcon.vue';

// Vista renderizada con el MISMO render que exporta la CLI (en la GPU si hay, que da los mismos píxeles): lo que ves
// es lo que sale. Con "Iluminación" se ve como en el juego: las fuentes de luz que pusiste en el modelo (herramienta
// "Fuente de luz") alumbran en 2.5D cada cara de vóxel y el suelo, con sombras de los propios vóxeles, y el resultado
// pasa por las mismas capas MULTIPLY/ADD del motor de luz del juego. Solo para mirar: no cambia el modelo.
// El encuadre es el de los sprites (64x48) si el modelo cabe; si no, uno que lo contiene (preview.ts, frameFor).
const CW = 320, CH = 240;                 // el lienzo de la vista, fijo
const main = ref<HTMLCanvasElement>();
const strip = ref<HTMLCanvasElement>();
const ms = ref(0);
const size = ref('');

let frame: Frame = frameFor(model.value, editor.view.elevation);
// El zoom que encaja el encuadre en el lienzo (entero si cabe a 1x o más; si no, 1/2, 1/4...)
function fitZoom(f: Frame): number {
  const z = Math.min(CW / f.W, CH / f.H);
  return z >= 1 ? Math.floor(z) : 2 ** Math.floor(Math.log2(z));
}

function toCanvas(rgba: Uint8ClampedArray<ArrayBuffer>, f: Frame): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = f.W; off.height = f.H;
  off.getContext('2d')!.putImageData(new ImageData(rgba, f.W, f.H), 0, 0);
  return off;
}

function drawMain(time: number): void {
  const c = main.value;
  if (!c) return;
  const t0 = performance.now();
  const s = look.zoom;
  c.width = CW; c.height = CH;
  const lit = editor.light.enabled;
  const x0 = Math.round((CW - frame.W * s) / 2 + look.panX), y0 = Math.round((CH - frame.H * s) / 2 + look.panY);
  const g = c.getContext('2d')!;
  g.fillStyle = lit ? '#3a3e4a' : '#8a92a6';
  g.fillRect(0, 0, CW, CH);
  g.imageSmoothingEnabled = false;
  g.drawImage(toCanvas(shot(frame, editor.view.yaw, { lit, time, bg: lit ? 'suelo' : 'plano' }), frame), x0, y0, frame.W * s, frame.H * s);
  // Dónde están las fuentes (giran con el modelo)
  const cam = camera(viewOptions(frame, editor.view.yaw, false));
  for (const l of editor.light.sources) {
    const [px, py] = cam.project(l.x + 0.5, l.y + 0.5, l.z + 0.5);
    const [r, gg, b] = SOURCE_PRESETS[l.kind].color;
    g.strokeStyle = `rgba(${r * 255},${gg * 255},${b * 255},0.9)`;
    g.beginPath(); g.arc(x0 + px * s, y0 + py * s, Math.max(2, s * 0.8), 0, Math.PI * 2); g.stroke();
  }
  ms.value = Math.round(performance.now() - t0);
  ui.renderMs = ms.value;
}

// Los 8 ángulos en una rejilla de 4 x 2, a la escala que cabe en la tarjeta
function drawStrip(): void {
  if (!strip.value) return;
  const n = editor.view.turn, cols = 4, s = Math.min(1.25, CW / (cols * frame.W));
  strip.value.width = Math.round(cols * frame.W * s); strip.value.height = Math.round(Math.ceil(n / cols) * frame.H * s);
  const g = strip.value.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  for (let i = 0; i < n; i++) {
    const img = shot(frame, editor.view.yaw + (360 * i) / n, { lit: editor.light.enabled, time: 0, bg: editor.light.enabled ? 'suelo' : 'plano' });
    g.drawImage(toCanvas(img, frame), (i % cols) * frame.W * s, Math.floor(i / cols) * frame.H * s, frame.W * s, frame.H * s);
  }
}

// Mirar la vista previa con los mismos controles que la edición 3D: botón derecho gira, botón del medio mueve,
// rueda acerca, doble clic con el del medio vuelve a centrar
const look = reactive({ zoom: fitZoom(frame), panX: 0, panY: 0 });
const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16];
let dragging: 0 | 2 | 3 = 0;
let lastXY: [number, number] = [0, 0];
function down(e: MouseEvent): void {
  if (e.button !== 1 && e.button !== 2) return;
  e.preventDefault();
  dragging = e.button === 2 ? 2 : 3;
  lastXY = [e.clientX, e.clientY];
}
function move(e: MouseEvent): void {
  if (!dragging) return;
  const dx = e.clientX - lastXY[0], dy = e.clientY - lastXY[1];
  lastXY = [e.clientX, e.clientY];
  if (dragging === 2) {
    editor.view.yaw = ((Math.round(editor.view.yaw + dx * 0.5) + 540) % 360) - 180;
    editor.view.elevation = Math.max(0, Math.min(90, Math.round(editor.view.elevation + dy * 0.4)));
  } else { look.panX += dx; look.panY += dy; redrawMain(); }
}
function up(): void { dragging = 0; }
function wheel(e: WheelEvent): void {
  e.preventDefault();
  const i = ZOOMS.findIndex((z) => z >= look.zoom);
  look.zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + (e.deltaY < 0 ? 1 : -1)))]!;
  redrawMain();
}
function recenter(e: MouseEvent): void {
  if (e.button === 1 && e.detail >= 2) { look.zoom = fitZoom(frame); look.panX = 0; look.panY = 0; redrawMain(); }
}

// Solo la vista grande (mover y acercar no cambian los 8 ángulos)
let pendingMain = 0;
function redrawMain(): void {
  cancelAnimationFrame(pendingMain);
  pendingMain = requestAnimationFrame(() => drawMain(performance.now() / 1000));
}

// Si el encuadre cambia (el modelo creció o cambió la elevación), el zoom vuelve a encajarlo
function reframe(): void {
  const f = frameFor(model.value, editor.view.elevation);
  if (f.W !== frame.W || f.H !== frame.H || f.originY !== frame.originY) { frame = f; look.zoom = fitZoom(f); look.panX = 0; look.panY = 0; }
  size.value = `${frame.W}×${frame.H}`;
}

let pending = 0;
function schedule(): void {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => { reframe(); drawMain(performance.now() / 1000); drawStrip(); });
}

// Con luces encendidas, el parpadeo se anima a 12 Hz (como el juego, que recalcula a pocos Hz)
let timer = 0;
function animate(): void {
  clearInterval(timer);
  if (editor.light.enabled && editor.light.sources.length) timer = window.setInterval(() => drawMain(performance.now() / 1000), 1000 / 12);
}

onMounted(() => { schedule(); animate(); });
onUnmounted(() => clearInterval(timer));
watch([version, () => ({ ...editor.view }), () => ui.previewOpen, () => ui.backend], schedule, { deep: true });
watch(() => JSON.stringify(editor.light), () => { schedule(); animate(); });
</script>

<template>
  <div class="view">
    <header>
      <h2>Vista previa</h2>
      <span class="ms" :title="`Encuadre ${size} · ${ui.backend === 'gpu' ? 'render en la GPU' : 'render en la CPU'}`">{{ size }} · {{ ms }} ms</span>
      <button class="ghost round" :title="ui.previewOpen ? 'Plegar' : 'Desplegar'" @click="ui.previewOpen = !ui.previewOpen">{{ ui.previewOpen ? '–' : '+' }}</button>
    </header>
    <template v-if="ui.previewOpen">
      <canvas ref="main" class="main" title="Botón derecho: girar · botón del medio: mover · rueda: zoom · doble clic con el del medio: centrar"
        @mousedown="down" @mousemove="move" @mouseup="up" @mouseleave="up" @contextmenu.prevent @auxclick.prevent="recenter" @wheel="wheel" />
      <div class="props">
        <div class="field"><label>Giro</label><input type="range" min="-180" max="180" step="1" v-model.number="editor.view.yaw" /><span class="value">{{ editor.view.yaw }}°</span></div>
        <div class="field"><label>Elevación</label><input type="range" min="0" max="90" step="1" v-model.number="editor.view.elevation" /><span class="value">{{ editor.view.elevation }}°</span></div>
        <div class="field"><label>Contorno</label><span class="dots" />
          <div class="seg">
            <button :class="{ on: editor.view.outline === 'outer' }" @click="editor.view.outline = 'outer'">Exterior</button>
            <button :class="{ on: editor.view.outline === 'both' }" @click="editor.view.outline = 'both'">Interior</button>
            <button :class="{ on: editor.view.outline === 'none' }" @click="editor.view.outline = 'none'">No</button>
          </div>
        </div>
        <div class="field"><label><PxIcon name="sun" /> Iluminación</label><span class="dots" />
          <button class="switch" :class="{ on: editor.light.enabled }" :title="editor.light.enabled ? 'Apagar' : 'Encender'" @click="editor.light.enabled = !editor.light.enabled" />
        </div>
        <div v-if="editor.light.enabled" class="field"><label>Ambiente</label><input type="range" min="0.1" max="1" step="0.05" v-model.number="editor.light.ambient" /><span class="value">{{ editor.light.ambient.toFixed(2) }}</span></div>
        <p v-if="editor.light.enabled" class="hint">{{ editor.light.sources.length }} fuente(s): se ponen con la herramienta Luz</p>
      </div>
      <canvas ref="strip" class="strip" />
    </template>
  </div>
</template>

<style scoped>
.view { display: flex; flex-direction: column; gap: 12px; }
header { display: flex; align-items: center; gap: 8px; }
header h2 { flex: 1; }
.ms { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.main { width: 320px; height: 240px; image-rendering: pixelated; border-radius: 12px; align-self: center; cursor: grab; }
.props { display: flex; flex-direction: column; gap: 2px; }
.field label { display: inline-flex; align-items: center; gap: 6px; }
.strip { width: 320px; border-radius: 12px; align-self: center; }
.hint { margin: 0; }
</style>
