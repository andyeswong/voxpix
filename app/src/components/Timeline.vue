<script setup lang="ts">
import { ref } from 'vue';
import { anim, selectFrame, addFrame, deleteFrame, moveFrame, setFrameMs, play, sheetPng, animGif } from '../anim';
import { model, touch } from '../store';

// La línea de tiempo (anim.ts): los cuadros de la animación, el actual resaltado. Se edita el actual con las
// herramientas de siempre. Con rig, el cuadro 0 es la pose de reposo (R) y los demás se generan desde él.
const allMs = ref(false);
const err = ref('');
const scale = ref(4);
const run = (f: () => unknown) => { try { err.value = ''; f(); } catch (e) { err.value = (e as Error).message; } };

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function exportSheet(): Promise<void> { download(await sheetPng(scale.value), `${model.value.name}_${anim.count}cuadros.png`); }
function exportGif(): void { download(animGif(scale.value), `${model.value.name}.gif`); }
</script>

<template>
  <div class="pill timeline" @click.stop>
    <button class="ghost" title="Cuadro anterior" @click="selectFrame(anim.current - 1)">◀</button>
    <button :class="{ on: anim.playing }" title="Reproducir en bucle" @click="play()">{{ anim.playing ? '❚❚' : '▶' }}</button>
    <button class="ghost" title="Cuadro siguiente" @click="selectFrame(anim.current + 1)">▶|</button>
    <div class="frames">
      <button v-for="i in anim.count" :key="i" class="frame" :class="{ on: anim.current === i - 1, rest: anim.rig && i === 1 }"
        :title="anim.rig && i === 1 ? 'Pose de reposo (de aquí salen los cuadros del rig)' : `Cuadro ${i - 1}`" @click="selectFrame(i - 1)">
        {{ anim.rig && i === 1 ? 'R' : i - 1 }}
      </button>
    </div>
    <button class="ghost" title="Un cuadro después del actual, copia del actual" @click="run(() => addFrame())">+ Cuadro</button>
    <button class="ghost" title="Un cuadro vacío después del actual" @click="run(() => addFrame(true))">Vacío</button>
    <button class="ghost" title="Mover el cuadro a la izquierda" :disabled="anim.current === 0" @click="run(() => moveFrame(anim.current, anim.current - 1))">←</button>
    <button class="ghost" title="Mover el cuadro a la derecha" :disabled="anim.current >= anim.count - 1" @click="run(() => moveFrame(anim.current, anim.current + 1))">→</button>
    <button class="ghost" title="Borrar el cuadro" :disabled="anim.count <= 1" @click="run(() => deleteFrame())">Borrar</button>
    <label title="Duración del cuadro en milisegundos">
      <input type="number" min="10" max="5000" step="10" :value="anim.ms" @change="run(() => setFrameMs(Number(($event.target as HTMLInputElement).value), allMs))" /> ms
    </label>
    <label title="Cambiar la duración de todos los cuadros"><input v-model="allMs" type="checkbox" /> todos</label>
    <button :class="{ on: anim.onion }" title="Papel cebolla: el cuadro anterior en fantasma" @click="anim.onion = !anim.onion; touch()">Cebolla</button>
    <button :class="{ on: anim.panel }" title="Rig por partes: mover piezas sin repintar" @click="anim.panel = !anim.panel">Rig…</button>
    <span class="sep" />
    <select v-model.number="scale" title="Escala de la exportación"><option v-for="s in [1, 2, 4, 8]" :key="s" :value="s">×{{ s }}</option></select>
    <button class="ghost" title="Los cuadros en fila, en el ángulo de la vista previa" @click="exportSheet">Hoja PNG</button>
    <button class="ghost" title="GIF animado en el ángulo de la vista previa" @click="exportGif">GIF</button>
    <span v-if="err" class="err">{{ err }}</span>
  </div>
</template>

<style scoped>
.timeline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; max-width: calc(100vw - 32px); font-size: 12px; }
.frames { display: flex; gap: 3px; max-width: 360px; overflow-x: auto; }
.frame { min-width: 26px; padding: 2px 6px; font-variant-numeric: tabular-nums; }
.frame.on { outline: 2px solid var(--accent, #8c78d8); }
.frame.rest { font-weight: 700; }
input[type='number'] { width: 58px; }
.sep { width: 1px; align-self: stretch; background: var(--line-2, #2f2e3b); }
.err { color: #ec6a7e; }
</style>
