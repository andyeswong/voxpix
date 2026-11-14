<script setup lang="ts">
import { ref, computed } from 'vue';
import { blockSet, addBlock, block, saveBlock, removeBlock, listBlocks, saveSet, closeSet } from '../blockSet';
import { version } from '../store';
import type { BlockProps } from '../../../src/world/blocks';
import { SOURCE_PRESETS } from '../../../src/lighting';

// El set de bloques abierto: la lista (clic: ponerlo en el lienzo), guardar el lienzo como bloque nuevo o en el que
// está abierto, sus propiedades que no salen de las rampas (la luz que emite y la variante tapada) y exportar el
// .voxset.json. Lo mismo que window.voxpix newSet/addBlock/block/saveBlock/saveSet (app/src/blockSet.ts).
const err = ref('');
const newId = ref('');
const kinds = Object.keys(SOURCE_PRESETS);
const list = computed(() => { void version.value; void blockSet.blocks.length; try { return listBlocks(); } catch { return []; } });
const cur = computed(() => blockSet.blocks.find((b) => b.id === blockSet.current) ?? null);
const emits = ref('');
const covered = ref('');
function pull(): void { emits.value = cur.value?.props.emits?.kind ?? ''; covered.value = cur.value?.props.covered ?? ''; }

function props(): Partial<BlockProps> {
  return { ...(emits.value ? { emits: { kind: emits.value as NonNullable<BlockProps['emits']>['kind'] } } : {}), ...(covered.value ? { covered: covered.value } : {}) };
}
function run(fn: () => void): void {
  err.value = '';
  try { fn(); } catch (e) { err.value = (e as Error).message; }
}
function open(id: string | null): void { run(() => { block(id); pull(); }); }
function add(): void { run(() => { addBlock(newId.value.trim(), props()); newId.value = ''; }); }
function save(): void { run(() => { saveBlock(props()); }); }
function remove(id: string): void { run(() => removeBlock(id)); }
function exportSet(): void {
  run(() => {
    const f = saveSet();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(f)], { type: 'application/json' }));
    a.download = `${f.name}.voxset.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}
</script>

<template>
  <div class="blocks">
    <header><strong>Bloques</strong> · {{ blockSet.name }} · {{ blockSet.size }}³</header>
    <ul>
      <li v-for="b in list" :key="b.id" :class="{ on: b.current }">
        <button class="ghost" :title="`${b.voxels} vóxeles`" @click="open(b.id)">{{ b.index }}. {{ b.id }}</button>
        <span class="tags">
          <span v-if="!b.props.solid">se cruza</span>
          <span v-if="b.props.light === 'passes'">luz pasa</span>
          <span v-if="b.props.emissive">brilla</span>
          <span v-if="b.props.emits">luz {{ b.props.emits.kind }}</span>
          <span v-if="b.props.covered">tapado: {{ b.props.covered }}</span>
        </span>
        <button class="ghost x" title="Quitar del set" @click="remove(b.id)">✕</button>
      </li>
      <li v-if="!list.length" class="empty">Pinta el bloque en el lienzo y guárdalo con un nombre.</li>
    </ul>
    <div class="row">
      <label>Luz que pone
        <select v-model="emits"><option value="">ninguna</option><option v-for="k in kinds" :key="k" :value="k">{{ k }}</option></select>
      </label>
      <label>Tapado pasa a
        <select v-model="covered"><option value="">nada</option><option v-for="b in list" :key="b.id" :value="b.id">{{ b.id }}</option></select>
      </label>
    </div>
    <div class="row">
      <input v-model="newId" placeholder="id del bloque nuevo" @keydown.enter="add" />
      <button :disabled="!newId.trim()" @click="add">Guardar como nuevo</button>
      <button v-if="cur" :title="`Guardar el lienzo en ${cur.id}`" @click="save">Guardar en {{ cur.id }}</button>
      <button class="ghost" title="Lienzo vacío para un bloque nuevo" @click="open(null)">Vacío</button>
    </div>
    <div class="row">
      <button :disabled="!list.length" @click="exportSet">Exportar .voxset.json</button>
      <button class="ghost" @click="closeSet()">Cerrar set</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.blocks { display: flex; flex-direction: column; gap: 8px; min-width: 300px; max-width: 380px; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow: auto; }
li { display: flex; align-items: center; gap: 6px; }
li.on > button:first-child { font-weight: 700; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; opacity: 0.75; flex: 1; }
.empty { opacity: 0.7; font-size: 12px; }
.row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.row input { flex: 1; min-width: 120px; }
.x { margin-left: auto; }
.err { color: #e06060; font-size: 12px; margin: 0; }
</style>
