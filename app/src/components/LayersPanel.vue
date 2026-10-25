<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted } from 'vue';
import { decode, rampOf } from '@core/index';
import { model, version, editor, ui } from '../store';

// Las capas del modelo (alturas z), de arriba abajo: miniatura vista desde arriba y cuántos vóxeles tiene. Un clic
// elige la capa que se edita; la rueda sobre el lienzo también sube y baja.
const thumbs = ref<HTMLCanvasElement[]>([]);

const layers = computed(() => {
  void version.value;
  const counts = new Map<number, number>();
  let top = 0;
  for (const [, , z] of model.value.entries()) { counts.set(z, (counts.get(z) ?? 0) + 1); top = Math.max(top, z); }
  const n = Math.max(editor.grid.maxZ + 1, top + 1);       // todas las capas del lienzo (y las de fuera, si quedaron)
  return Array.from({ length: n }, (_, i) => { const z = n - 1 - i; return { z, count: counts.get(z) ?? 0 }; });
});

// Una pasada por los vóxeles que hay (no por todas las celdas: con un lienzo grande serían millones)
function drawThumbs(): void {
  const { minX, maxX, minY, maxY } = editor.grid;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const m = model.value;
  const n = layers.value.length;
  const ctx: Array<CanvasRenderingContext2D | null> = layers.value.map((_, i) => {
    const c = thumbs.value[i];
    if (!c) return null;
    c.width = w; c.height = h;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, w, h);
    return g;
  });
  for (const [x, y, z, v] of m.entries()) {
    if (x < minX || x > maxX || y < minY || y > maxY) continue;
    const g = ctx[n - 1 - z];
    if (!g) continue;
    const d = decode(v);
    g.fillStyle = rampOf(m.palette, d.ramp).colors[d.tone] ?? '#f0f';
    g.fillRect(x - minX, maxY - y, 1, 1);
  }
}

// La capa que se edita, siempre a la vista en la lista
const list = ref<HTMLOListElement>();
function showCurrent(): void {
  nextTick(() => list.value?.querySelector('li.on')?.scrollIntoView({ block: 'nearest' }));
}

onMounted(() => { drawThumbs(); showCurrent(); });
watch([() => editor.z, () => layers.value.length, () => ui.layersOpen], showCurrent);
watch([version, () => layers.value.length, () => ui.layersOpen, () => ({ ...editor.grid })], () => nextTick(drawThumbs));
</script>

<template>
  <div class="layers">
    <header>
      <h2>Capas</h2>
      <span class="count">z {{ editor.z }}</span>
      <button class="ghost round" :title="ui.layersOpen ? 'Plegar' : 'Desplegar'" @click="ui.layersOpen = !ui.layersOpen">{{ ui.layersOpen ? '–' : '+' }}</button>
    </header>
    <ol v-if="ui.layersOpen" ref="list">
      <li v-for="l in layers" :key="l.z" :class="{ on: l.z === editor.z, empty: !l.count }" @click="editor.z = l.z">
        <canvas ref="thumbs" />
        <span class="z">z {{ l.z }}</span>
        <span class="n">{{ l.count || '—' }}</span>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.layers { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
header { display: flex; align-items: center; gap: 8px; }
header h2 { flex: 1; }
.count { color: var(--faint); font-size: 12px; }
ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; overflow-y: auto; max-height: calc(100vh - 260px); }
li { display: grid; grid-template-columns: 64px 1fr auto; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 12px; border: 1px solid transparent; cursor: pointer; }
li:hover { background: var(--panel-2); }
li.on { background: var(--panel-2); border-color: var(--accent); }
li.empty canvas { opacity: .35; }
canvas { width: 64px; height: 32px; border-radius: 6px; background: var(--bg); object-fit: contain; }
.z { font-weight: 500; }
.n { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
</style>
