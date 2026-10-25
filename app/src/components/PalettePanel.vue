<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { rampFromColor, hueName, groupIntoRamps, parsePaletteText, MAX_RAMPS, MAX_TONES } from '@core/index';
import { model, editor, version, ui } from '../store';
import { PRESET_PALETTES } from '../../../src/samples/palettes';
import { setTone, renameRamp, toggleEmissive, addTone, removeTone, addRamp, deleteRamp, moveRamp, removeUnusedRamps, loadColors, rampUsage } from '../paletteOps';

// La paleta completa (rampas): se elige el MATERIAL (rampa) y su tono base; la luz del render se mueve dentro de la
// rampa a partir de ese tono. Tres pestañas:
//   - Rampas: elegir; con "Editar", cambiar cada tono (clic), añadir o quitar tonos, renombrar, mover, emisiva, borrar;
//   - Nueva: una rampa generada desde un color (las sombras giran hacia el frío y las luces hacia el cálido);
//   - Paletas: paletas de pixel art de la comunidad (Lospec) o un archivo .hex / .gpl, añadidas o en lugar de la actual.
// Todo se deshace con Ctrl+Z (paleta y vóxeles juntos).
const tab = ref<'rampas' | 'nueva' | 'paletas'>('rampas');
const editing = ref(false);
const msg = ref('');
const ramps = computed(() => { void version.value; return model.value.palette.ramps; });
const usage = computed(() => { void version.value; return rampUsage(); });

function run(fn: () => unknown, ok?: string): void {
  try { const r = fn(); msg.value = ok ? ok.replace('{n}', String(r)) : ''; } catch (e) { msg.value = String((e as Error).message ?? e); }
}

function pickTone(ri: number, ti: number): void { editor.ramp = ri; editor.tone = ti; }

// ---- Nueva rampa
const nueva = reactive({ base: '#3f6b33', tones: 5, shift: 22, name: '' });
const preview = computed(() => { try { return rampFromColor(nueva.base, { tones: nueva.tones, hueShift: nueva.shift }); } catch { return []; } });
function crear(): void {
  run(() => addRamp({ name: nueva.name.trim() || hueName(nueva.base), colors: preview.value }), 'rampa añadida');
  nueva.name = '';
  tab.value = 'rampas';
}

// ---- Paletas
const archivo = ref<{ name: string; colors: string[] } | null>(null);
const pegado = ref('');
function leerArchivo(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = '';
  if (!f) return;
  f.text().then((t) => {
    const colors = parsePaletteText(t);
    archivo.value = colors.length ? { name: f.name.replace(/\.[^.]+$/, ''), colors } : null;
    msg.value = colors.length ? '' : `${f.name}: no tiene colores #rrggbb ni r g b`;
  });
}
const pegados = computed(() => parsePaletteText(pegado.value));
function cargar(colors: readonly string[], mode: 'añadir' | 'reemplazar', name?: string): void {
  run(() => loadColors(colors, mode, name), mode === 'añadir' ? '{n} rampas añadidas' : 'paleta cambiada: {n} rampas; lo pintado pasó al color más parecido');
  tab.value = 'rampas';
}
const rampsOf = (colors: readonly string[]) => groupIntoRamps(colors).length;
</script>

<template>
  <div class="pal">
    <header>
      <h2>Paleta</h2>
      <span class="hint">{{ ramps.length }}/{{ MAX_RAMPS }} rampas</span>
      <button class="ghost round" title="Cerrar" @click="ui.paletteOpen = false">×</button>
    </header>
    <div class="seg tabs">
      <button :class="{ on: tab === 'rampas' }" @click="tab = 'rampas'">Rampas</button>
      <button :class="{ on: tab === 'nueva' }" @click="tab = 'nueva'">Nueva</button>
      <button :class="{ on: tab === 'paletas' }" @click="tab = 'paletas'">Paletas</button>
    </div>
    <p v-if="msg" class="msg">{{ msg }}</p>

    <!-- Rampas: elegir y editar -->
    <template v-if="tab === 'rampas'">
      <div class="bar">
        <label class="check"><input v-model="editing" type="checkbox" /> Editar</label>
        <button v-if="editing" class="ghost small" title="Quita las rampas que ningún vóxel usa" @click="run(removeUnusedRamps, '{n} rampas sin usar quitadas')">Quitar sin usar</button>
      </div>
      <div class="ramps">
        <div v-for="(r, ri) in ramps" :key="ri" class="ramp" :class="{ sel: ri === editor.ramp, edit: editing }">
          <input v-if="editing" class="name" :value="r.name" title="Nombre de la rampa" @change="run(() => renameRamp(ri, ($event.target as HTMLInputElement).value))" />
          <span v-else class="name" :title="`${r.name}${r.emissive ? ' · emisiva' : ''} · ${usage.get(ri) ?? 0} vóxeles`">{{ r.name }}<span v-if="r.emissive" class="glow"> ✦</span></span>
          <div class="tones">
            <button v-if="editing" class="ghost add" :disabled="r.colors.length >= MAX_TONES" title="Un tono más oscuro al principio" @click="run(() => addTone(ri, 'oscuro'))">+</button>
            <template v-for="(c, ti) in r.colors" :key="ti">
              <label v-if="editing" class="tone" :style="{ background: c }" :title="`${r.name} · tono ${ti} · ${c} · clic: cambiar · clic derecho: quitar`"
                @contextmenu.prevent="r.colors.length > 1 && run(() => removeTone(ri, ti))">
                <input type="color" :value="c" @change="run(() => setTone(ri, ti, ($event.target as HTMLInputElement).value))" />
              </label>
              <button v-else class="tone" :class="{ on: ri === editor.ramp && ti === editor.tone }" :style="{ background: c }"
                :title="`${r.name} · tono ${ti} · ${c}`" @click="pickTone(ri, ti)" />
            </template>
            <button v-if="editing" class="ghost add" :disabled="r.colors.length >= MAX_TONES" title="Un tono más claro al final" @click="run(() => addTone(ri, 'claro'))">+</button>
          </div>
          <div v-if="editing" class="row-actions">
            <button class="ghost small" :disabled="ri === 0" title="Subir" @click="run(() => moveRamp(ri, ri - 1))">↑</button>
            <button class="ghost small" :disabled="ri === ramps.length - 1" title="Bajar" @click="run(() => moveRamp(ri, ri + 1))">↓</button>
            <button class="ghost small" :class="{ on: r.emissive }" title="Emisiva: brilla sola, la luz del mundo no la oscurece" @click="run(() => toggleEmissive(ri))">✦</button>
            <button class="ghost small danger" :disabled="ramps.length <= 1" :title="`Borrar la rampa (${usage.get(ri) ?? 0} vóxeles pasan al color más parecido de las demás)`" @click="run(() => deleteRamp(ri))">✕</button>
          </div>
        </div>
      </div>
      <p v-if="editing" class="hint">Clic en un tono para cambiarlo; clic derecho para quitarlo. Ctrl+Z lo deshace.</p>
    </template>

    <!-- Nueva rampa desde un color -->
    <template v-else-if="tab === 'nueva'">
      <div class="group">
        <div class="field"><label>Color base</label><span class="dots" /><input v-model="nueva.base" type="color" /></div>
        <div class="field"><label>Tonos</label><input v-model.number="nueva.tones" type="range" min="2" :max="Math.min(8, MAX_TONES)" step="1" /><span class="value">{{ nueva.tones }}</span></div>
        <div class="field"><label>Giro de tono</label><input v-model.number="nueva.shift" type="range" min="0" max="45" step="1" /><span class="value">{{ nueva.shift }}°</span></div>
        <div class="field"><label>Nombre</label><span class="dots" /><input v-model="nueva.name" type="text" :placeholder="hueName(nueva.base)" /></div>
      </div>
      <div class="strip big"><span v-for="(c, i) in preview" :key="i" :style="{ background: c }" :title="c" :class="{ base: c === nueva.base.toLowerCase() }" /></div>
      <p class="hint">Las sombras giran hacia el frío y las luces hacia el cálido, como en el pixel art hecho a mano. El color base queda dentro de la rampa.</p>
      <div class="actions"><button class="primary" :disabled="ramps.length >= MAX_RAMPS" @click="crear">Añadir rampa</button></div>
    </template>

    <!-- Paletas de la comunidad y archivos -->
    <template v-else>
      <p class="hint">Se agrupan en rampas solas. <b>Añadir</b> las pone detrás de las tuyas; <b>Reemplazar</b> cambia la paleta y lo pintado pasa al color más parecido.</p>
      <div class="presets">
        <div v-for="p in PRESET_PALETTES" :key="p.id" class="preset">
          <div class="pname"><strong>{{ p.name }}</strong><span class="hint">{{ p.author }} · {{ p.colors.length }} colores · {{ rampsOf(p.colors) }} rampas</span></div>
          <div class="strip"><span v-for="c in p.colors" :key="c" :style="{ background: c }" :title="c" /></div>
          <div class="actions">
            <button class="ghost small" @click="cargar(p.colors, 'añadir', p.name)">Añadir</button>
            <button class="ghost small" @click="cargar(p.colors, 'reemplazar')">Reemplazar</button>
          </div>
        </div>
      </div>
      <div class="group">
        <label class="btn ghost small"><input type="file" accept=".hex,.gpl,.txt,.pal" @change="leerArchivo" />Desde archivo (.hex, .gpl)…</label>
        <template v-if="archivo">
          <div class="strip"><span v-for="c in archivo.colors" :key="c" :style="{ background: c }" :title="c" /></div>
          <div class="actions">
            <button class="ghost small" @click="cargar(archivo.colors, 'añadir', archivo.name)">Añadir</button>
            <button class="ghost small" @click="cargar(archivo.colors, 'reemplazar')">Reemplazar</button>
          </div>
        </template>
        <textarea v-model="pegado" rows="2" placeholder="o pega colores: #ff004d #29adff… (de Lospec: «Copy HEX»)" />
        <div v-if="pegados.length" class="actions">
          <span class="hint">{{ pegados.length }} colores</span>
          <button class="ghost small" @click="cargar(pegados, 'añadir', 'pegada')">Añadir</button>
          <button class="ghost small" @click="cargar(pegados, 'reemplazar')">Reemplazar</button>
        </div>
      </div>
      <p class="hint">Paletas de <a href="https://lospec.com/palette-list" target="_blank" rel="noopener">Lospec</a>, con el mérito de sus autores.</p>
    </template>
  </div>
</template>

<style scoped>
.pal { display: flex; flex-direction: column; gap: 10px; }
header { display: flex; align-items: center; gap: 8px; }
header h2 { flex: 1; }
.tabs { align-self: stretch; }
.tabs button { flex: 1; }
.msg { margin: 0; color: var(--accent-2); font-size: 12px; }
.bar { display: flex; align-items: center; justify-content: space-between; }
.check { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.ramps { display: flex; flex-direction: column; gap: 4px; max-height: 46vh; overflow-y: auto; padding-right: 4px; }
.ramp { display: grid; grid-template-columns: 90px 1fr; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 12px; }
.ramp.edit { grid-template-columns: 90px 1fr auto; }
.ramp.sel { background: var(--panel-2); }
.name { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
input.name { width: 90px; min-height: 24px; padding: 2px 6px; font-size: 12px; }
.glow { color: #ffd166; }
.tones { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
.tone { width: 24px; height: 24px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(0, 0, 0, .35) inset; cursor: pointer; position: relative; }
.tone:hover { border-color: var(--line-2); }
.tone.on { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); }
label.tone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.add { width: 22px; height: 22px; min-height: 0; padding: 0; border-radius: 50%; font-size: 14px; color: var(--muted); }
.row-actions { display: flex; gap: 2px; }
.small { min-height: 24px; padding: 0 8px; font-size: 12px; }
.row-actions .small { padding: 0 6px; }
.small.on { color: #ffd166; }
.danger:hover { color: #ec6a7e; }
.group { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 14px; background: var(--panel-2); }
.group .field input[type=text] { width: 150px; }
.group .field input[type=color] { width: 48px; height: 28px; padding: 0; border: none; background: none; }
.group label.btn input { display: none; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 12px; }
.strip { display: flex; flex-wrap: wrap; gap: 2px; }
.strip span { width: 14px; height: 14px; border-radius: 3px; }
.strip.big span { width: 32px; height: 32px; border-radius: 6px; }
.strip.big span.base { outline: 2px solid #fff; outline-offset: 1px; }
.presets { display: flex; flex-direction: column; gap: 10px; max-height: 40vh; overflow-y: auto; padding-right: 4px; }
.preset { display: flex; flex-direction: column; gap: 4px; }
.pname { display: flex; align-items: baseline; gap: 8px; }
.actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; }
.hint { margin: 0; }
a { color: var(--accent-2); }
</style>
