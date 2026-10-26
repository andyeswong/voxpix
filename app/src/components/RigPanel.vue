<script setup lang="ts">
import { ref, computed } from 'vue';
import { anim, setRig, generateFromRig } from '../anim';
import { model } from '../store';
import type { RigSpec, RigPartSpec, RigFrame, PartMove } from '../../../src/anim/rig';

// El rig por partes (src/anim/rig.ts, RigSpec), sin código: cada parte son unos vóxeles (una caja y, si se quiere,
// solo ciertas rampas) con su cadera (pivote) y su pie; cada cuadro dice cuánto se mueve cada parte (dx, dy, dz) y
// cuánto adelanta el pie (stride, doblando desde la cadera). "Generar" rehace los cuadros 1..n desde el cuadro 0.
const b = computed(() => model.value.bounds() ?? { minX: -4, maxX: 4, minY: -4, maxY: 4, minZ: 0, maxZ: 8 });
const spec = ref<RigSpec>(anim.rig ? JSON.parse(JSON.stringify(anim.rig)) : { frameMs: 100, parts: [], frames: [{ moves: {} }, { moves: {} }] });
const err = ref('');
const msg = ref('');

function addPart(): void {
  const bb = b.value, n = spec.value.parts.length;
  spec.value.parts.push({ name: `parte${n + 1}`, boxes: [[bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, Math.floor((bb.minZ + bb.maxZ) / 2)]], pivotZ: Math.floor((bb.minZ + bb.maxZ) / 2), footZ: bb.minZ });
}
function removePart(i: number): void { spec.value.parts.splice(i, 1); }
function rampOn(p: RigPartSpec, r: number): boolean { return !!p.ramps?.includes(r); }
function toggleRamp(p: RigPartSpec, r: number): void {
  const s = new Set(p.ramps ?? []);
  if (s.has(r)) s.delete(r); else s.add(r);
  if (s.size) p.ramps = [...s].sort((a, c) => a - c); else delete p.ramps;
}
function addFrameRow(): void { spec.value.frames.push({ moves: {} }); }
function removeFrameRow(i: number): void { spec.value.frames.splice(i, 1); }
function move(f: RigFrame, part: string): PartMove { return (f.moves[part] ??= {}); }
function setMove(f: RigFrame, part: string, k: keyof PartMove, v: string): void {
  const m = move(f, part), n = Number(v);
  if (!v || !Number.isFinite(n) || n === 0) delete m[k]; else m[k] = Math.round(n);
}

function apply(): void {
  try { err.value = ''; setRig(spec.value); msg.value = 'Rig guardado'; } catch (e) { err.value = (e as Error).message; }
}
function generate(): void {
  try { err.value = ''; const n = generateFromRig(spec.value); msg.value = `${n} cuadros generados desde el cuadro 0`; } catch (e) { err.value = (e as Error).message; }
}
function clearRig(): void { setRig(null); msg.value = 'Sin rig'; }
const KEYS: Array<keyof PartMove> = ['dx', 'dy', 'dz', 'stride'];
</script>

<template>
  <div class="rig">
    <div class="head"><strong>Rig por partes</strong><button class="ghost" @click="anim.panel = false">✕</button></div>
    <p class="hint">Cada parte: una caja de vóxeles (x0 y0 z0 – x1 y1 z1) y, si quieres, solo unas rampas. Pivote: la z que no se mueve al dar el paso (la cadera); pie: la que más (stride adelanta el pie hacia el frente, -y).</p>
    <div v-for="(p, i) in spec.parts" :key="i" class="part">
      <div class="line">
        <input v-model="p.name" class="name" />
        <button class="ghost" @click="removePart(i)">quitar</button>
      </div>
      <div class="line">
        caja <input v-for="k in 6" :key="k" v-model.number="p.boxes![0]![k - 1]" type="number" class="n" />
      </div>
      <div class="line">
        pivote <input v-model.number="p.pivotZ" type="number" class="n" /> pie <input v-model.number="p.footZ" type="number" class="n" />
      </div>
      <div class="line ramps">
        rampas
        <button v-for="(r, ri) in model.palette.ramps" :key="ri" class="ramp" :class="{ on: rampOn(p, ri) }" :style="{ background: r.colors[Math.min(2, r.colors.length - 1)] }" :title="r.name" @click="toggleRamp(p, ri)" />
        <span class="hint">{{ p.ramps?.length ? '' : '(todas)' }}</span>
      </div>
    </div>
    <button class="ghost" @click="addPart">+ Parte</button>

    <div class="line">duración <input v-model.number="spec.frameMs" type="number" class="n" min="10" step="10" /> ms por cuadro</div>
    <table v-if="spec.parts.length">
      <tr><th>cuadro</th><th v-for="p in spec.parts" :key="p.name">{{ p.name }}<br /><span class="hint">dx dy dz paso</span></th><th /></tr>
      <tr v-for="(f, fi) in spec.frames" :key="fi">
        <td>{{ fi + 1 }}</td>
        <td v-for="p in spec.parts" :key="p.name">
          <input v-for="k in KEYS" :key="k" type="number" class="m" :value="f.moves[p.name]?.[k] ?? ''" @change="setMove(f, p.name, k, ($event.target as HTMLInputElement).value)" />
        </td>
        <td><button class="ghost" @click="removeFrameRow(fi)">✕</button></td>
      </tr>
    </table>
    <button class="ghost" @click="addFrameRow">+ Cuadro del rig</button>
    <div class="line actions">
      <button class="primary" @click="generate">Generar cuadros</button>
      <button class="ghost" @click="apply">Guardar rig</button>
      <button class="ghost" @click="clearRig">Quitar rig</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
    <p v-else-if="msg" class="hint">{{ msg }}</p>
  </div>
</template>

<style scoped>
.rig { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.head { display: flex; justify-content: space-between; align-items: center; }
.part { border: 1px solid var(--line-2, #2f2e3b); border-radius: 8px; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.line { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.name { width: 110px; }
.n { width: 46px; }
.m { width: 34px; }
.ramp { width: 16px; height: 16px; padding: 0; border-radius: 4px; opacity: 0.45; }
.ramp.on { opacity: 1; outline: 2px solid #fff; }
.hint { color: var(--faint, #8e8ca6); }
.err { color: #ec6a7e; }
table { border-collapse: collapse; }
td, th { padding: 2px 4px; text-align: center; vertical-align: top; }
</style>
