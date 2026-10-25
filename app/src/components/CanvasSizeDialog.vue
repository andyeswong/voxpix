<script setup lang="ts">
import { computed, reactive } from 'vue';
import { model, ui, gridSize, voxelsOutside, setGridSize, newModelSized } from '../store';

// Tamaño del lienzo (la rejilla donde se edita): ancho (x), fondo (y) y alto (z, las capas), con el pivote en medio.
// Sirve para "Nuevo" (modelo vacío con ese lienzo) y para "Edición > Tamaño del lienzo" (el modelo actual).
const props = defineProps<{ mode: 'nuevo' | 'lienzo' }>();
const now = gridSize();
const f = reactive({ name: props.mode === 'nuevo' ? 'nuevo' : model.value.name, w: now.w, d: now.d, h: now.h, crop: false });
const PRESETS = [16, 32, 64, 128];
const MAX = 256;

const clamp = (v: number) => Math.max(1, Math.min(MAX, Math.round(v) || 1));
const outside = computed(() => (props.mode === 'lienzo' ? voxelsOutside(clamp(f.w), clamp(f.d), clamp(f.h)) : 0));

function preset(n: number): void { f.w = n; f.d = n; f.h = n; }
function accept(): void {
  const w = clamp(f.w), d = clamp(f.d), h = clamp(f.h);
  if (props.mode === 'nuevo') newModelSized(f.name.trim(), w, d, h);
  else setGridSize(w, d, h, f.crop);
  ui.dialog = '';
}
</script>

<template>
  <div class="modal" @click.self="ui.dialog = ''" @keydown.esc="ui.dialog = ''">
    <form class="card dialog" @submit.prevent="accept">
      <h2>{{ mode === 'nuevo' ? 'Modelo nuevo' : 'Tamaño del lienzo' }}</h2>
      <p class="hint">{{ mode === 'nuevo' ? 'Un modelo vacío con la paleta actual.' : 'La rejilla donde se edita, con el pivote en el centro.' }}</p>

      <div v-if="mode === 'nuevo'" class="field"><label>Nombre</label><span class="dots" /><input v-model="f.name" type="text" /></div>

      <div class="group">
        <div class="presets">
          <span class="hint">Rápido</span>
          <div class="seg">
            <button v-for="n in PRESETS" :key="n" type="button" :class="{ on: f.w === n && f.d === n && f.h === n }" @click="preset(n)">{{ n }}³</button>
          </div>
        </div>
        <div class="field"><label>Ancho (x)</label><span class="dots" /><input v-model.number="f.w" type="number" min="1" :max="MAX" /></div>
        <div class="field"><label>Fondo (y)</label><span class="dots" /><input v-model.number="f.d" type="number" min="1" :max="MAX" /></div>
        <div class="field"><label>Alto (z, capas)</label><span class="dots" /><input v-model.number="f.h" type="number" min="1" :max="MAX" /></div>
      </div>

      <div v-if="mode === 'lienzo' && outside" class="warn">
        <span>{{ outside }} vóxeles quedan fuera del lienzo nuevo.</span>
        <label class="check"><input v-model="f.crop" type="checkbox" /> Recortarlos (se puede deshacer)</label>
        <span v-if="!f.crop" class="hint">Si no, se conservan, pero no se ven en la rejilla.</span>
      </div>

      <div class="actions">
        <button type="button" class="ghost" @click="ui.dialog = ''">Cancelar</button>
        <button type="submit" class="primary">{{ mode === 'nuevo' ? 'Crear' : 'Aplicar' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.modal { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(8, 7, 12, .6); backdrop-filter: blur(4px); }
.dialog { width: 420px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.dialog h2 { font-size: 16px; }
.dialog p { margin: 0; }
.group { display: flex; flex-direction: column; gap: 4px; padding: 12px; border-radius: 14px; background: var(--panel-2); }
.presets { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.presets .seg button { min-height: 26px; padding: 0 10px; }
.field input[type=number] { width: 90px; text-align: right; }
.field input[type=text] { width: 200px; }
.warn { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: 12px; border: 1px solid #8a6a2a; background: rgba(240, 185, 81, .08); color: #f0d08a; }
.check { display: inline-flex; align-items: center; gap: 8px; color: var(--text); }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
</style>
