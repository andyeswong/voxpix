// La niebla por altura (Frame2DOptions.fog), para verla y medirla (NARUTO). Un terreno de bancales de 4 vóxeles con
// torres y zanjas de un bloque, y MAIA andando por encima. Los deslizadores cambian focusZ, start, full, la fuerza y
// el color; "seguir" pone focusZ en la cabeza de MAIA en cada cuadro (el foco que se mueve).
//   ?ruta=cpu: compone la CPU   ?medir=1: mide el pase de niebla (CPU y GPU) y lo deja en window.__niebla
//   ?foco=40&start=4&full=20&fuerza=0.7: valores de partida
import { Model, material, type ModelFile } from '@core/index';
import { fbm } from '../../../src/worldgen/noise';
import { StaticVoxels, WorldState } from '../../../src/world/state';
import { bakeWorld } from '../../../src/world/bake';
import { frame2DParts, shadeLayers, applyFog, frame2D, type Frame2DOptions, type HeightFog } from '../../../src/world/frame2d';
import { applyLayers } from '../../../src/lighting/shade';
import { createCompositor } from '../../../src/view/compositor';
import { GpuCompositor } from '../../../src/view/gpu/compositor';
import { walkFrames, WALK_FRAME_MS } from '../../../src/anim/walk';
import maiaFile from '../../../models/maia/maia.json';

const VW = 384, VH = 216, W = 192, D = 160, TOPZ = 63, BLOCK = 4;
const q = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;
canvas.width = VW; canvas.height = VH;
const s = Math.max(1, Math.floor(Math.min(innerWidth / VW, innerHeight / VH)));
canvas.style.width = `${VW * s}px`; canvas.style.height = `${VH * s}px`;
const compositor = createCompositor(canvas, { prefer: q.get('ruta') === 'cpu' ? 'cpu' : 'gpu' });

// El terreno: bancales de un bloque según el ruido, una rejilla de torres (+1 bloque) y zanjas (-1 bloque)
const PAL = { ramps: [
  { name: 'tierra', colors: ['#2a1e1a', '#4a3428', '#6b4c36', '#8c6a4a'] },
  { name: 'hierba', colors: ['#1d3a22', '#2f5a2e', '#4a7f3a', '#78a84c'] },
  { name: 'piedra', colors: ['#2a2a34', '#4a4a58', '#70707e', '#9a9aa8'] },
] };
const solid = new StaticVoxels(PAL, W, D, 0, TOPZ);
const heightAt = (x: number, y: number): number => {
  const bx = Math.floor(x / BLOCK), by = Math.floor(y / BLOCK);
  let h = 3 + Math.floor(fbm(bx / 9, by / 9, 11) * 6);
  if (bx % 6 === 2 && by % 6 === 2) h += 1;                     // torre de un bloque
  if (bx % 6 === 4 && by % 5 === 1) h -= 1;                     // zanja de un bloque
  if (bx % 12 === 8 && by % 9 === 5) h += 3;                    // torre alta
  return h * BLOCK;
};
for (let y = 0; y < D; y++) for (let x = 0; x < W; x++) {
  const top = heightAt(x, y);
  const stone = Math.floor(x / BLOCK) % 6 === 2 && Math.floor(y / BLOCK) % 6 === 2 || Math.floor(x / BLOCK) % 12 === 8 && Math.floor(y / BLOCK) % 9 === 5;
  for (let z = 0; z < top; z++) solid.set(x, y, z, stone ? material(2, 1 + ((z >> 2) & 1)) : z === top - 1 ? material(1, 2) : material(0, 1 + ((z >> 2) & 1)));
}
const state = new WorldState(solid, [], null);
const baked = bakeWorld({ model: solid, lights: [], width: W, depth: D }, { topZ: TOPZ, incline: 0.5, outline: 'both' });

const maia = Model.fromJSON(maiaFile as unknown as ModelFile);
const walk = walkFrames(maia);
const cx = W / 2, cy = D / 2;
const id = state.entities.add({ model: walk[0]!, x: cx, y: cy, z: heightAt(cx, cy) });
const MAIA_H = 14;

const feet = baked.cam.project(cx, cy, 24);
const vx = Math.max(0, Math.min(baked.width - VW, Math.floor(feet[0]) - VW / 2));
const vy = Math.max(0, Math.min(baked.height - VH, Math.floor(feet[1]) - VH / 2));

// Los controles
const el = (k: string) => document.getElementById(k) as HTMLInputElement;
const init: Record<string, string> = { focus: q.get('foco') ?? '40', start: q.get('start') ?? '4', full: q.get('full') ?? '20', strength: q.get('fuerza') ?? '0.7' };
for (const k of Object.keys(init)) el(k).value = init[k]!;
el('color').value = q.get('color') ?? '#1c2038';
el('follow').checked = q.get('seguir') !== '0';
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function fogNow(maiaZ: number): HeightFog {
  if (el('follow').checked) el('focus').value = String(Math.round(maiaZ + MAIA_H));
  for (const k of ['focus', 'start', 'full', 'strength']) (document.getElementById(`${k}-v`) as HTMLOutputElement).value = el(k).value;
  return { focusZ: Number(el('focus').value), start: Number(el('start').value), full: Number(el('full').value), color: hex(el('color').value), strength: Number(el('strength').value) };
}
const opts = (t: number, fog: HeightFog | null): Frame2DOptions => ({ vx, vy, vw: VW, vh: VH, time: t, lights: true, ambient: [1, 0.97, 0.92], fog });

// La medida: el pase de niebla solo (CPU: applyFog sobre el cuadro ya con luz) y el cuadro de la GPU con y sin niebla
// (read espera a la GPU: la diferencia de medianas es lo que cuesta el pase). Cuadros sueltos, después de calentar
const pct = (a: number[], p: number) => { const v = [...a].sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(p * v.length))]!; };
function measure(): unknown {
  const fog: HeightFog = { focusZ: 40, start: 4, full: 20, color: [28, 32, 56], strength: 0.7 };
  const o = opts(0, fog);
  const parts = frame2DParts(state, baked, o);
  const lit = applyLayers(parts.view, shadeLayers(parts.total!, o, baked));
  const N = Number(q.get('n') ?? 120);
  const fogMs: number[] = [], cpuOn: number[] = [], cpuOff: number[] = [];
  for (let i = 0; i < N + 10; i++) {
    const c = lit.slice();
    const t0 = performance.now();
    applyFog(c, parts.depth, baked, o);
    if (i >= 10) fogMs.push(performance.now() - t0);
  }
  for (let i = 0; i < 30; i++) {
    let t0 = performance.now(); frame2D(state, baked, { ...o, fog: null }); const off = performance.now() - t0;
    t0 = performance.now(); frame2D(state, baked, o); const on = performance.now() - t0;
    if (i >= 3) { cpuOff.push(off); cpuOn.push(on); }
  }
  let gpu: unknown = null;
  const gc = GpuCompositor.create(document.createElement('canvas'));
  if (gc) {
    const on: number[] = [], off: number[] = [];
    for (let i = 0; i < N + 10; i++) {
      let t0 = performance.now(); gc.read(state, baked, { ...o, fog: null }); const a = performance.now() - t0;
      t0 = performance.now(); gc.read(state, baked, o); const b = performance.now() - t0;
      if (i >= 10) { off.push(a); on.push(b); }
    }
    gpu = { offP50: pct(off, 0.5), onP50: pct(on, 0.5), offP95: pct(off, 0.95), onP95: pct(on, 0.95) };
  }
  return { size: [VW, VH], fogP50: pct(fogMs, 0.5), fogP95: pct(fogMs, 0.95), fogMax: Math.max(...fogMs), cpuFrameOffP50: pct(cpuOff, 0.5), cpuFrameOnP50: pct(cpuOn, 0.5), gpu };
}
if (q.get('medir') === '1') (window as unknown as { __niebla: unknown }).__niebla = measure();

let acc = 0, n = 0, avg = 0;
function loop(now: number): void {
  const t = now / 1000;
  // MAIA da vueltas: sube y baja por los bancales y las torres
  const a = t * 0.35, x = Math.round(cx + Math.cos(a) * 44), y = Math.round(cy + Math.sin(a) * 30);
  const dir = Math.atan2(Math.cos(a), -Math.sin(a) * 1.4);
  const facing = ((Math.round((90 - (dir * 180) / Math.PI) / 45) * 45) % 360 + 360) % 360;
  const z = heightAt(x, y);
  state.entities.move(id, x, y, z, facing);
  state.entities.setModel(id, walk[Math.floor(now / WALK_FRAME_MS) % 8]!);
  state.step();
  const fog = fogNow(z);
  const t0 = performance.now();
  compositor.frame(state, baked, opts(t, fog));
  acc += performance.now() - t0;
  if (++n === 30) { avg = acc / n; acc = 0; n = 0; }
  hud.textContent = `niebla por altura · ruta ${compositor.kind} · cuadro ${avg.toFixed(2)} ms\nfocusZ ${fog.focusZ} (pies de MAIA ${z}) · start ${fog.start} · full ${fog.full} · fuerza ${fog.strength}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
