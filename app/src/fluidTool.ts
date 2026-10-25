// Herramienta "Fluido" de VoxPix: mientras se mantiene pulsado se vierte agua en una celda; el autómata de
// volumen (src/fluid/voxel.ts) la hace caer, repartirse y nivelarse contra los vóxeles del modelo, en vivo. El
// agua se ve como vóxeles del material elegido y, cuando se calma, se fija en un solo paso de deshacer.
import { reactive } from 'vue';
import { key, unkey } from '@core/index';
import { VoxelFluid } from '../../src/fluid/voxel';
import { model, history, touch, currentMaterial } from './store';
import { fillWater } from './edit';

const WET = 0.35;           // masa a partir de la cual la celda se dibuja como agua
const POUR = 0.7;           // agua por paso mientras se vierte
const MARGIN = 14;          // la rejilla del fluido cubre el modelo y esto alrededor

// Grifos: fuentes continuas que siguen vertiendo hasta que se quitan (con el modo grifo activo, un clic pone o quita)
// Con el modo llenar, un clic llena de agua hasta esa altura todo lo conectado, de una vez (edit.ts, fillWater)
export const fluidState = reactive({ running: false, pouring: false, cells: 0, faucetMode: false, fillMode: false, faucets: [] as Array<[number, number, number]>, last: '' });

let sim: VoxelFluid | null = null;
let source: [number, number, number] | null = null;
let value = 0;
let still = 0;
let since = 0;              // pasos desde que se dejó de verter
let timer = 0;
const water = new Set<number>();               // vóxeles que hoy son agua del fluido
const before = new Map<number, number>();      // valor original de cada vóxel tocado (para el deshacer)

function makeSim(x: number, y: number, z: number): VoxelFluid {
  const b = model.value.bounds();
  const minX = Math.min(b?.minX ?? x, x) - MARGIN, maxX = Math.max(b?.maxX ?? x, x) + MARGIN;
  const minY = Math.min(b?.minY ?? y, y) - MARGIN, maxY = Math.max(b?.maxY ?? y, y) + MARGIN;
  const maxZ = Math.max(b?.maxZ ?? z, z) + 4;
  const f = new VoxelFluid(minX, minY, 0, maxX - minX + 1, maxY - minY + 1, maxZ + 1);
  // Lo sólido: los vóxeles del modelo (el suelo de la rejilla, z = 0, también si no hay nada: el agua no cae al vacío)
  for (const [vx, vy, vz] of model.value.entries()) { const i = f.index(vx, vy, vz); if (i >= 0) f.solid[i] = 1; }
  return f;
}

function set(x: number, y: number, z: number, v: number): void {
  const k = key(x, y, z);
  if (!before.has(k)) before.set(k, model.value.get(x, y, z));
  model.value.set(x, y, z, v);
}

// Pasa el estado del fluido al modelo: celdas mojadas -> vóxeles de agua; las que se secaron, vacías.
// Devuelve cuántos vóxeles cambiaron.
function sync(): number {
  if (!sim) return 0;
  let changed = 0;
  const seen = new Set<number>();
  for (const [x, y, z] of sim.wet(WET)) {
    const k = key(x, y, z);
    seen.add(k);
    if (!water.has(k)) { set(x, y, z, value); water.add(k); changed++; }
  }
  for (const k of [...water]) if (!seen.has(k)) { const [x, y, z] = unkey(k); set(x, y, z, 0); water.delete(k); changed++; }
  fluidState.cells = water.size;
  return changed;
}

function tick(): void {
  if (!sim) return;
  if (source) sim.add(source[0], source[1], source[2], POUR);
  for (const [fx, fy, fz] of fluidState.faucets) sim.add(fx, fy, fz, POUR * 0.6);
  for (let i = 0; i < 3; i++) sim.step();
  const changed = sync();
  touch();
  // Se fija cuando ya no cambia ningún vóxel durante un rato (el autómata sigue moviendo masas diminutas en las
  // capas finas, que no se ven), y como mucho 10 s después de dejar de verter
  const flowing = !!source || fluidState.faucets.length > 0;
  since = flowing ? 0 : since + 1;
  still = !flowing && changed === 0 ? still + 1 : 0;
  if (still > 20 || since > 300) settle();
}

// Fija el agua: el cambio entero (desde el primer vertido) entra como un paso del historial
function settle(): void {
  clearInterval(timer);
  timer = 0;
  if (sim) {
    const changes = [...before].map(([k, v0]) => { const [x, y, z] = unkey(k); return [x, y, z, v0, model.value.get(x, y, z)] as const; });
    for (const [x, y, z, v0] of changes) model.value.set(x, y, z, v0);
    history.value.begin();
    for (const [x, y, z, , v1] of changes) history.value.set(x, y, z, v1);
    history.value.commit();
  }
  sim = null; source = null; water.clear(); before.clear(); still = 0; since = 0;
  fluidState.running = false; fluidState.pouring = false; fluidState.cells = 0;
  touch();
}

// Pone o quita un grifo en una celda
export function toggleFaucet(x: number, y: number, z: number): void {
  if (z < 0) return;
  const i = fluidState.faucets.findIndex(([a, b, c]) => a === x && b === y && c === z);
  if (i >= 0) { fluidState.faucets.splice(i, 1); return; }
  if (!sim) { sim = makeSim(x, y, z); value = currentMaterial(); }
  const j = sim.index(x, y, z);
  if (j < 0 || sim.solid[j]) return;
  fluidState.faucets.push([x, y, z]);
  fluidState.running = true;
  if (!timer) timer = window.setInterval(tick, 33);
}

export function startPour(x: number, y: number, z: number): void {
  if (z < 0) return;
  if (fluidState.fillMode) {
    const r = fillWater(x, y, z, currentMaterial());
    fluidState.last = r.cells ? `${r.cells} celdas de agua${r.spill ? ' · llega al borde del lienzo' : ''}` : 'ahí no cabe agua (celda llena)';
    return;
  }
  if (fluidState.faucetMode) { toggleFaucet(x, y, z); return; }
  if (!sim) { sim = makeSim(x, y, z); value = currentMaterial(); }
  const i = sim.index(x, y, z);
  if (i < 0 || sim.solid[i]) return;
  source = [x, y, z];
  fluidState.running = true; fluidState.pouring = true;
  if (!timer) timer = window.setInterval(tick, 33);
}

export function stopPour(): void {
  source = null;
  fluidState.pouring = false;
}

export function settleNow(): void {
  fluidState.faucets.splice(0);
  if (sim) settle();
}
