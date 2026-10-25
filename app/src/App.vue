<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import LayerEditor from './components/LayerEditor.vue';
import Voxel3DEditor from './components/Voxel3DEditor.vue';
import Viewport from './components/Viewport.vue';
import PalettePanel from './components/PalettePanel.vue';
import LayersPanel from './components/LayersPanel.vue';
import CanvasSizeDialog from './components/CanvasSizeDialog.vue';
import { vDraggable } from './drag';
import PxIcon from './components/PxIcon.vue';
import { model, history, editor, touch, loadFile, replaceModel, version, paint, ui, gridSize, loadSample } from './store';
import type { LightKind, Tool } from './store';
import { Model, assertClosedPalette } from '@core/index';
import { frameFor, renderModel, probeGpu, viewOptions, pngBlob } from './preview';
import { fluidState, settleNow, startPour, stopPour } from './fluidTool';
import { loadPxl, pxlAssets, paletteFromPxl, spriteToVoxels, toPxlSource, stackPrefixes, stackFromPxl, toPxlStack, pxlDirectives, applyDirectives } from '../../src/pxl/bridge';

const LIGHT_KINDS: Array<[LightKind, string]> = [['torch', 'antorcha'], ['lamp', 'lámpara'], ['brazier', 'brasero'], ['neon-pink', 'neón rosa'], ['neon-cyan', 'neón cian'], ['screen', 'pantalla']];
const TOOLS: Array<[Tool, string, string, string, string]> = [
  ['pen', 'pen', 'Lápiz', 'B', 'Lápiz'], ['erase', 'erase', 'Borrar', 'E', 'Borrar'], ['paint', 'paint', 'Repintar', 'P', 'Repintar'],
  ['pick', 'pick', 'Cuentagotas', 'I', 'Gotero'], ['box', 'box', 'Caja', 'R', 'Caja'], ['fill', 'fill', 'Cubo de pintura', 'G', 'Cubo'],
  ['light', 'light', 'Fuente de luz', 'L', 'Luz'], ['fluid', 'fluid', 'Fluido', 'F', 'Fluido'],
];
// Lo que hace cada herramienta, para la píldora de opciones
const TOOL_HINT: Record<Tool, string> = {
  pen: 'clic pinta · clic derecho borra', erase: 'clic borra', paint: 'cambia el material de lo que ya hay',
  pick: 'copia el material de un vóxel', light: 'clic pone una fuente; sobre una fuente, la quita', fluid: 'mantén pulsado para verter',
  box: 'arrastra de una esquina a otra · clic derecho borra', fill: 'rellena la mancha de la capa · clic derecho la borra',
};
// En 3D el botón derecho gira: la caja va de hueco a hueco (con las alturas entre los dos) y el cubo no borra
const TOOL_HINT_3D: Partial<Record<Tool, string>> = { pen: 'clic pinta', box: 'arrastra de un hueco a otro: rellena la caja entre los dos', fill: 'rellena la mancha de su capa' };
// Escala de la exportación a PNG
const pngScale = ref(4);
// Los menús se cierran al hacer clic fuera
function closeMenus(): void { ui.menu = ''; }
function toggleMenu(m: 'archivo' | 'edicion' | 'exportar'): void { ui.menu = ui.menu === m ? '' : m; }

function undo(): void { if (history.value.undo()) touch(); }
function redo(): void { if (history.value.redo()) touch(); }

function download(name: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function save(): void {
  download(`${model.value.name || 'modelo'}.voxpix.json`, JSON.stringify({ ...model.value.toJSON(), lights: editor.light.sources }), 'application/json');
}

function readFile(e: Event, then: (text: string, name: string) => void): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) file.text().then((t) => then(t, file.name));
  input.value = '';
}

function open(e: Event): void {
  readFile(e, (t) => loadFile(JSON.parse(t)));
}

// ---- pxl
const pxl = ref<{ name: string; source: string; sprites: string[]; stacks: string[]; sprite: string; plane: 'front' | 'top'; error: string } | null>(null);

function importPxl(e: Event): void {
  readFile(e, (source, name) => {
    try {
      const p = loadPxl(source, name);
      const sprites = pxlAssets(p);
      pxl.value = { name, source, sprites, stacks: stackPrefixes(p), sprite: sprites[0] ?? '', plane: 'front', error: '' };
    } catch (err) {
      pxl.value = { name, source, sprites: [], stacks: [], sprite: '', plane: 'front', error: String(err) };
    }
  });
}

// Modelo nuevo con la paleta del arte (y el sprite, si se eligió)
function pxlAsNew(withSprite: boolean): void {
  const d = pxl.value!;
  const p = loadPxl(d.source, d.name);
  const m = new Model(applyDirectives(paletteFromPxl(p, withSprite ? d.sprite : undefined), pxlDirectives(d.source)), withSprite ? d.sprite : d.name.replace(/\.px\.[jt]s$/, ''));
  if (withSprite) spriteToVoxels(p, d.sprite, m, { plane: d.plane, z: editor.z });
  replaceModel(m);
  pxl.value = null;
}

// El sprite dentro del modelo actual, con los colores más cercanos de su paleta (deshacer lo quita)
function pxlIntoCurrent(): void {
  const d = pxl.value!;
  const p = loadPxl(d.source, d.name);
  const tmp = new Model(model.value.palette);
  spriteToVoxels(p, d.sprite, tmp, { plane: d.plane, z: editor.z });
  history.value.begin();
  for (const [x, y, z, v] of tmp.entries()) paint(x, y, z, v);
  history.value.commit();
  touch();
  pxl.value = null;
}

// Modelo nuevo desde una pila de capas <prefijo>_zNN
function pxlStack(prefix: string): void {
  const d = pxl.value!;
  const p = loadPxl(d.source, d.name);
  const m = new Model(applyDirectives(paletteFromPxl(p, `${prefix}_z00`), pxlDirectives(d.source)), prefix);
  try { stackFromPxl(p, prefix, m); } catch (err) { d.error = String(err); return; }
  replaceModel(m);
  pxl.value = null;
}

function exportStack(): void {
  const base = (model.value.name || 'modelo').replace(/[^a-zA-Z0-9_-]/g, '_');
  download(`${base}_capas.px.js`, toPxlStack(model.value, base), 'text/javascript');
}

function exportPxl(): void {
  const m = model.value;
  const n = editor.view.turn;
  const base = (m.name || 'modelo').replace(/[^a-zA-Z0-9_-]/g, '_');
  const f = frameFor(m, editor.view.elevation);
  const frames = Array.from({ length: n }, (_, i) => {
    const yaw = Math.round(editor.view.yaw + (360 * i) / n);
    const img = renderModel(viewOptions(f, yaw, false));
    assertClosedPalette(img, m);
    return { name: `${base}_a${String(((yaw % 360) + 360) % 360).padStart(3, '0')}`, ...img };
  });
  download(`${base}.px.js`, toPxlSource(m, frames, { sheet: base, comment: `VoxPix: ${m.name}, ${n} ángulos de ${f.W}x${f.H}, pivote en ${f.originX},${f.originY}` }), 'text/javascript');
}

function exportPng(what: 'vista' | 'hoja', scale: number): void {
  pngBlob(what, scale).then(({ blob, name }) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

function key(e: KeyboardEvent): void {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (e.key === 'b') editor.tool = 'pen';
  else if (e.key === 'e') editor.tool = 'erase';
  else if (e.key === 'i') editor.tool = 'pick';
  else if (e.key === 'p') editor.tool = 'paint';
  else if (e.key === 'l') editor.tool = 'light';
  else if (e.key === 'f') editor.tool = 'fluid';
  else if (e.key === 'r') editor.tool = 'box';
  else if (e.key === 'g') editor.tool = 'fill';
  else if (e.key === 'Tab') { e.preventDefault(); editor.mode = editor.mode === 'layers' ? 'voxel3d' : 'layers'; }
  else if (e.key === 'm') editor.mirrorX = !editor.mirrorX;
  else if (e.key === 'PageUp' || e.key === 'w') editor.z = Math.min(editor.grid.maxZ, editor.z + 1);
  else if (e.key === 'PageDown' || e.key === 's') editor.z = Math.max(0, editor.z - 1);
}

onMounted(() => {
  probeGpu();
  window.addEventListener('keydown', key);
  window.addEventListener('click', closeMenus);
  // ?verter=x,y,z: vierte un segundo de agua en esa celda (para probar la herramienta sin ratón)
  const v = new URLSearchParams(location.search).get('verter')?.split(',').map(Number);
  if (v && v.length === 3 && v.every(Number.isFinite)) {
    const water = model.value.palette.ramps.findIndex((r) => r.name === 'agua');
    if (water >= 0) { editor.ramp = water; editor.tone = 3; }
    editor.tool = 'fluid';
    startPour(v[0]!, v[1]!, v[2]!);
    setTimeout(stopPour, 1200);
  }
});
onUnmounted(() => { window.removeEventListener('keydown', key); window.removeEventListener('click', closeMenus); });
void version;
</script>

<template>
  <!-- El lienzo ocupa toda la ventana; todo lo demás flota encima -->
  <main class="stage" :style="{ '--free-left': ui.layersOpen ? '256px' : '24px', '--free-right': ui.previewOpen ? '392px' : '24px' }">
    <LayerEditor v-if="editor.mode === 'layers'" />
    <Voxel3DEditor v-else />
  </main>

  <!-- Arriba a la izquierda: el archivo -->
  <div class="float top-left pill" data-repel @click.stop>
    <span class="logo">VoxPix</span>
    <span class="name" :title="`${model.size} vóxeles`">{{ model.name }}</span>
    <button class="ghost" :class="{ on: ui.menu === 'archivo' }" @click="toggleMenu('archivo')">Archivo ▾</button>
    <button class="ghost" :class="{ on: ui.menu === 'edicion' }" @click="toggleMenu('edicion')">Edición ▾</button>
    <div v-if="ui.menu === 'edicion'" class="menu card edicion" data-repel>
      <button class="ghost" :disabled="!history.canUndo" @click="undo(); closeMenus()"><PxIcon name="undo" />Deshacer <span class="kbd">Ctrl+Z</span></button>
      <button class="ghost" :disabled="!history.canRedo" @click="redo(); closeMenus()"><PxIcon name="redo" />Rehacer <span class="kbd">Ctrl+Y</span></button>
      <hr />
      <button class="ghost" @click="ui.dialog = 'lienzo'; closeMenus()"><PxIcon name="layers" />Tamaño del lienzo… <span class="kbd">{{ gridSize().w }}×{{ gridSize().d }}×{{ gridSize().h }}</span></button>
    </div>
    <div v-if="ui.menu === 'archivo'" class="menu card" data-repel>
      <button class="ghost" @click="ui.dialog = 'nuevo'; closeMenus()"><PxIcon name="new" />Nuevo…</button>
      <button class="ghost" @click="loadSample(); closeMenus()"><PxIcon name="sample" />Escena de muestra</button>
      <label class="btn ghost"><input type="file" accept=".json" @change="open($event); closeMenus()" /><PxIcon name="open" />Abrir…</label>
      <button class="ghost" @click="save(); closeMenus()"><PxIcon name="save" />Guardar</button>
      <hr />
      <label class="btn ghost" title="Arte de pxl (.px.js): paleta con rampas, sprites y capas"><input type="file" accept=".js,.ts" @change="importPxl($event); closeMenus()" /><PxIcon name="import" />Importar de pxl…</label>
    </div>
  </div>

  <!-- Arriba en el centro: cómo se edita -->
  <div class="float top-center pill" data-repel>
    <div class="seg big">
      <button :class="{ on: editor.mode === 'layers' }" title="Editar por capas (Tab)" @click="editor.mode = 'layers'"><PxIcon name="layers" />Capas</button>
      <button :class="{ on: editor.mode === 'voxel3d' }" title="Editar sobre el modelo en 3D (Tab)" @click="editor.mode = 'voxel3d'"><PxIcon name="cube" />3D</button>
    </div>
  </div>

  <!-- Arriba a la derecha: deshacer, rehacer y exportar -->
  <div class="float top-right" data-repel @click.stop>
    <div class="pill">
      <button class="ghost round" :disabled="!history.canUndo" title="Deshacer (Ctrl+Z)" @click="undo"><PxIcon name="undo" /></button>
      <button class="ghost round" :disabled="!history.canRedo" title="Rehacer (Ctrl+Y)" @click="redo"><PxIcon name="redo" /></button>
    </div>
    <div class="pill">
      <button class="primary" @click="toggleMenu('exportar')"><PxIcon name="export" />Exportar ▾</button>
    </div>
    <div v-if="ui.menu === 'exportar'" class="menu card right" data-repel>
      <button class="ghost" title="Un sprite por ángulo + hoja" @click="exportPxl(); closeMenus()"><PxIcon name="export" />pxl: {{ editor.view.turn }} ángulos</button>
      <button class="ghost" title="Un sprite por altura, vistas desde arriba" @click="exportStack(); closeMenus()"><PxIcon name="layers" />pxl: capas</button>
      <button class="ghost" @click="save(); closeMenus()"><PxIcon name="save" />Modelo (.voxpix.json)</button>
      <hr />
      <div class="png-row">
        <span class="png-label"><PxIcon name="export" />PNG</span>
        <div class="seg">
          <button v-for="sc in [1, 2, 4, 8]" :key="sc" :class="{ on: pngScale === sc }" @click="pngScale = sc">×{{ sc }}</button>
        </div>
      </div>
      <button class="ghost" title="El ángulo de la vista previa, fondo transparente" @click="exportPng('vista', pngScale); closeMenus()">PNG: esta vista</button>
      <button class="ghost" :title="`Los ${editor.view.turn} ángulos en una fila`" @click="exportPng('hoja', pngScale); closeMenus()">PNG: hoja de {{ editor.view.turn }} ángulos</button>
    </div>
  </div>

  <!-- Izquierda: capas -->
  <aside v-draggable="'capas'" class="float left card" :class="{ folded: !ui.layersOpen }"><LayersPanel /></aside>

  <!-- Derecha: la vista previa -->
  <aside v-draggable="'vista-previa'" class="float right card" :class="{ folded: !ui.previewOpen }"><Viewport /></aside>

  <!-- Abajo: herramientas y colores, y encima las opciones de la herramienta -->
  <div class="float bottom" data-repel>
    <div class="pill options">
      <strong>{{ TOOLS.find((x) => x[0] === editor.tool)?.[2] }}</strong>
      <span class="hint">{{ editor.tool === 'fluid' && fluidState.fillMode ? 'clic llena de agua hasta esa altura' : editor.tool === 'fluid' && fluidState.faucetMode ? 'clic pone o quita un grifo' : editor.mode === 'voxel3d' ? (TOOL_HINT_3D[editor.tool] ?? TOOL_HINT[editor.tool]) : TOOL_HINT[editor.tool] }}</span>
      <template v-if="editor.tool === 'light'">
        <select v-model="editor.light.kind"><option v-for="[k, name] in LIGHT_KINDS" :key="k" :value="k">{{ name }}</option></select>
      </template>
      <template v-if="editor.tool === 'fluid'">
        <div class="seg">
          <button :class="{ on: !fluidState.faucetMode && !fluidState.fillMode }" title="Mientras se mantiene pulsado, cae agua y se reparte" @click="fluidState.faucetMode = false; fluidState.fillMode = false">Verter</button>
          <button :class="{ on: fluidState.faucetMode }" title="Un clic pone una fuente continua (o la quita)" @click="fluidState.faucetMode = true; fluidState.fillMode = false">Grifo</button>
          <button :class="{ on: fluidState.fillMode }" title="Un clic llena de agua, de una vez, todo lo conectado hasta esa altura (como una cuenca)" @click="fluidState.fillMode = true; fluidState.faucetMode = false">Llenar</button>
        </div>
        <span v-if="fluidState.fillMode && fluidState.last" class="hint">{{ fluidState.last }}</span>
        <span v-if="fluidState.faucets.length" class="hint">{{ fluidState.faucets.length }} grifo(s)</span>
        <button v-if="fluidState.running" @click="settleNow">Fijar ({{ fluidState.cells }})</button>
      </template>
      <span v-if="editor.mode === 'voxel3d'" class="hint">· botón derecho gira · botón del medio mueve · rueda acerca</span>
      <label v-if="editor.mirrorX" class="mirror">espejo x = <input type="number" v-model.number="editor.mirrorAxis" /></label>
    </div>
    <div class="row">
      <div class="pill tools">
        <button v-for="[t, icon, name, k, short] in TOOLS" :key="t" class="tool ghost" :class="{ on: editor.tool === t }" :title="`${name} (${k})`" @click="editor.tool = t">
          <PxIcon :name="icon" /><span>{{ short }}</span>
        </button>
        <span class="vsep" />
        <button class="tool ghost" :class="{ on: editor.mirrorX }" title="Espejo X (M)" @click="editor.mirrorX = !editor.mirrorX"><PxIcon name="mirror" /><span>Espejo</span></button>
      </div>
      <div class="pill colors" @click.stop>
        <button
          v-for="(c, ti) in model.palette.ramps[editor.ramp]?.colors ?? []" :key="ti" class="dot" :class="{ on: ti === editor.tone }"
          :style="{ background: c }" :title="`${model.palette.ramps[editor.ramp]?.name} · tono ${ti}`" @click="editor.tone = ti"
        />
        <button class="ghost more" :class="{ on: ui.paletteOpen }" title="Paleta completa" @click="ui.paletteOpen = !ui.paletteOpen">
          {{ model.palette.ramps[editor.ramp]?.name ?? 'paleta' }} ▴
        </button>
      </div>
    </div>
  </div>
  <aside v-if="ui.paletteOpen" v-draggable="'paleta'" class="float palette card" @click.stop><PalettePanel /></aside>

  <!-- Abajo a la izquierda: dónde estás -->
  <div class="float status">
    <span v-if="ui.cursor">x {{ ui.cursor[0] }} · y {{ ui.cursor[1] }} · z {{ ui.cursor[2] }}</span>
    <span v-else>z {{ editor.z }}</span>
    <span>{{ model.size }} vóxeles</span>
    <span>{{ ui.renderMs }} ms</span>
    <button class="ghost backend" :disabled="!ui.gpuAvailable" :title="ui.gpuAvailable ? 'Con qué se renderiza (los dos dan los mismos píxeles). Clic: cambiar' : 'Sin WebGL2: se renderiza en la CPU'"
      @click="ui.backend = ui.backend === 'gpu' ? 'cpu' : 'gpu'">{{ ui.backend === 'gpu' ? 'GPU' : 'CPU' }}</button>
  </div>

  <!-- Nuevo / Tamaño del lienzo -->
  <CanvasSizeDialog v-if="ui.dialog" :key="ui.dialog" :mode="ui.dialog" />

  <!-- Importar de pxl -->
  <div v-if="pxl" class="modal" @click.self="pxl = null">
    <div class="card dialog">
      <h2>Importar de pxl</h2>
      <p class="hint">{{ pxl.name }}</p>
      <p v-if="pxl.error" class="err">{{ pxl.error }}</p>
      <template v-else>
        <div v-if="pxl.stacks.length" class="group">
          <label>Capas por altura</label>
          <button v-for="st in pxl.stacks" :key="st" class="primary" @click="pxlStack(st)"><PxIcon name="layers" />Modelo desde {{ st }}_zNN</button>
        </div>
        <div class="group">
          <label>Un sprite</label>
          <select v-model="pxl.sprite"><option v-for="sp in pxl.sprites" :key="sp" :value="sp">{{ sp }}</option></select>
          <div class="seg">
            <button :class="{ on: pxl.plane === 'front' }" @click="pxl.plane = 'front'">De frente</button>
            <button :class="{ on: pxl.plane === 'top' }" @click="pxl.plane = 'top'">Desde arriba (z {{ editor.z }})</button>
          </div>
          <div class="actions">
            <button :disabled="!pxl.sprite" @click="pxlAsNew(true)">Modelo nuevo</button>
            <button :disabled="!pxl.sprite" @click="pxlIntoCurrent">Añadir al actual</button>
            <button @click="pxlAsNew(false)">Solo la paleta</button>
          </div>
        </div>
      </template>
      <div class="actions end"><button class="ghost" @click="pxl = null">Cancelar</button></div>
    </div>
  </div>
</template>

<style scoped>
.stage { position: fixed; inset: 0; background: var(--stage);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 24px 24px; }
.float { position: fixed; z-index: 2; }
.top-left { top: 16px; left: 16px; padding-left: 16px; z-index: 5; }
.logo { color: var(--accent-2); font-weight: 700; letter-spacing: .3px; }
.name { color: var(--muted); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 6px 0 4px; border-left: 1px solid var(--line); margin-left: 6px; padding-left: 10px; }
.top-center { top: 16px; left: 50%; transform: translateX(-50%); }
.seg.big button { min-height: 32px; padding: 0 16px; gap: 8px; }
.top-right { top: 16px; right: 16px; display: flex; gap: 8px; align-items: flex-start; z-index: 5; }
.menu { position: absolute; top: calc(100% + 8px); left: 0; display: flex; flex-direction: column; gap: 2px; padding: 8px; min-width: 240px; }
.menu.right { left: auto; right: 0; }
.menu.edicion { left: 150px; }
.kbd { margin-left: auto; color: var(--faint); font-size: 11px; padding-left: 16px; }
.menu button, .menu .btn { justify-content: flex-start; border-radius: 10px; }
.menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 2px; width: auto; }
.png-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 6px 4px 14px; }
.png-label { display: inline-flex; align-items: center; gap: 8px; }
.png-row .seg button { min-height: 26px; padding: 0 8px; }
.left { top: 76px; left: 16px; width: 224px; padding: 14px; max-height: calc(100vh - 210px); display: flex; }
.right { top: 76px; right: 16px; width: 360px; padding: 16px; max-height: calc(100vh - 210px); overflow-y: auto; }
.folded { max-height: none; }
/* Las ventanas se arrastran por la cabecera; mientras se mueven, por encima de todo */
aside :deep(header) { cursor: grab; user-select: none; }
aside.dragging { z-index: 6; box-shadow: 0 18px 50px rgba(0, 0, 0, .6); }
/* Al apartarse de un menú (y al volver), con suavidad; mientras se arrastra, al momento */
aside.repels { transition: translate .22s cubic-bezier(.2, .8, .2, 1); }
aside.repels.dragging { transition: none; }
aside.dragging :deep(header) { cursor: grabbing; }
.bottom { bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; }
.bottom .row { display: flex; gap: 8px; align-items: stretch; }
.options { padding: 4px 6px 4px 16px; gap: 10px; box-shadow: none; background: color-mix(in srgb, var(--panel) 88%, transparent); }
.options select, .options input { min-height: 28px; padding: 3px 8px; }
.mirror input { width: 60px; margin-left: 4px; }
.tools { padding: 6px; gap: 2px; }
.tool { flex-direction: column; gap: 4px; min-width: 62px; height: 56px; min-height: 0; padding: 6px 6px 4px; border-radius: 16px; }
.tool span { font-size: 11px; color: var(--muted); }
.tool.on span { color: #fff; }
.vsep { width: 1px; align-self: stretch; margin: 8px 4px; background: var(--line); }
.colors { padding: 6px 6px 6px 12px; gap: 8px; }
.dot { width: 30px; height: 30px; min-height: 0; padding: 0; border-radius: 50%; border: 2px solid transparent; box-shadow: 0 0 0 1px rgba(0, 0, 0, .35) inset; }
.dot.on { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); }
.more { min-height: 44px; border-radius: 14px; color: var(--muted); }
.palette { z-index: 4; bottom: 150px; left: 50%; transform: translateX(-10%); width: 400px; padding: 16px; }
.status { left: 16px; bottom: 16px; display: flex; align-items: center; gap: 14px; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
.backend { min-height: 22px; padding: 0 8px; font-size: 11px; color: var(--muted); border-radius: 8px; }
.modal { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: rgba(8, 7, 12, .6); backdrop-filter: blur(4px); }
.dialog { width: 460px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.dialog h2 { font-size: 16px; }
.dialog p { margin: 0; }
.group { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 14px; background: var(--panel-2); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.actions.end { justify-content: flex-end; }
.err { color: #ec6a7e; white-space: pre-wrap; }
</style>
