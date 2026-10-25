<script setup lang="ts">
import { computed } from 'vue';
import sheetUrl from '../assets/ui/icons.png';
import sheet from '../assets/ui/icons.json';

// Icono de la hoja que genera pxl (app/icons/icons.px.js -> `npm run icons`), a escala entera y sin suavizar
const props = withDefaults(defineProps<{ name: string; scale?: number }>(), { scale: 2 });
type Frame = { frame: { x: number; y: number; w: number; h: number } };
const frames = (sheet as { frames: Record<string, Frame>; meta: { size: { w: number; h: number } } }).frames;
const size = (sheet as { meta: { size: { w: number; h: number } } }).meta.size;

const style = computed(() => {
  const f = frames[`ic_${props.name}`]?.frame;
  if (!f) return { display: 'none' };
  const s = props.scale;
  return {
    width: `${f.w * s}px`, height: `${f.h * s}px`,
    backgroundImage: `url(${sheetUrl})`,
    backgroundPosition: `-${f.x * s}px -${f.y * s}px`,
    backgroundSize: `${size.w * s}px ${size.h * s}px`,
  };
});
</script>

<template>
  <span class="px-icon" :style="style" aria-hidden="true" />
</template>

<style scoped>
.px-icon { display: inline-block; image-rendering: pixelated; flex: none; }
</style>
