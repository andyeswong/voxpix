<script setup lang="ts">
import { model, editor, version, ui } from '../store';

// La paleta completa (rampas): se elige el MATERIAL (rampa) y su tono base. La luz del render se mueve dentro de la
// rampa a partir de ese tono. Sale como tarjeta flotante desde los colores de la barra de abajo.
void version;
</script>

<template>
  <div class="pal">
    <header>
      <h2>Paleta</h2>
      <span class="hint">{{ model.palette.ramps.length }} rampas</span>
      <button class="ghost round" title="Cerrar" @click="ui.paletteOpen = false">×</button>
    </header>
    <div class="ramps">
      <div v-for="(r, ri) in model.palette.ramps" :key="ri" class="ramp" :class="{ sel: ri === editor.ramp }">
        <span class="name">{{ r.name }}</span>
        <div class="tones">
          <button
            v-for="(c, ti) in r.colors" :key="ti" class="tone" :class="{ on: ri === editor.ramp && ti === editor.tone }"
            :style="{ background: c }" :title="`${r.name} · tono ${ti} · ${c}`"
            @click="editor.ramp = ri; editor.tone = ti"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pal { display: flex; flex-direction: column; gap: 12px; }
header { display: flex; align-items: center; gap: 8px; }
header h2 { flex: 1; }
.ramps { display: flex; flex-direction: column; gap: 6px; max-height: 50vh; overflow-y: auto; padding-right: 4px; }
.ramp { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 12px; }
.ramp.sel { background: var(--panel-2); }
.name { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tones { display: flex; gap: 6px; flex-wrap: wrap; }
.tone { width: 26px; height: 26px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(0, 0, 0, .35) inset; }
.tone:hover { border-color: var(--line-2); }
.tone.on { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); }
</style>
