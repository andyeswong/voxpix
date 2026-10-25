// La decoración de la demo (NARUTO): lo que dice cada tema con los materiales del motor.
//   - medieval: vegetación (hierba, flores, arbustos, juncos y nenúfares con planFoliage) y árboles con copa de follaje;
//   - oficina y cyberpunk: cubículos de vidrio con una luz dentro (la luz sale por el vidrio y no por la piedra).
// Va en buildWorldState({ decorate }), antes del agua y del estado. Determinista por semilla.
import { material, planFoliage, FOLIAGE_RAMPS, type Ramp } from '@core/index';
import { worldWaterDepth, type World, type WorldTheme } from '../../../src/world/build';

// Hash de una celda en [0, 1)
const rnd = (x: number, y: number, s: number) => {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s + 101, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
};

// Sitios libres (un rectángulo de suelo llano, sin agua) repartidos por el mapa, los más cercanos a `near` primero
function freeSpots(w: World, sw: number, sd: number, count: number, near: { x: number; y: number }, seed: number): Array<[number, number]> {
  const m = w.model, out: Array<[number, number]> = [];
  const cands: Array<[number, number, number]> = [];
  for (let y = 8; y < w.depth - sd - 8; y += 6) for (let x = 8; x < w.width - sw - 8; x += 6) {
    const d = Math.hypot(x + sw / 2 - near.x, y + sd / 2 - near.y);
    if (d < 30 + Math.max(sw, sd)) continue;                                // que no caiga encima de MAIA
    const f = w.fountain;
    if (f && Math.hypot(x + sw / 2 - f.x, y + sd / 2 - f.y) < f.radius + Math.max(sw, sd) + 6) continue;   // ni encima de la fuente
    cands.push([d + rnd(x, y, seed) * 40, x, y]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  for (const [, x0, y0] of cands) {
    if (out.length >= count) break;
    if (out.some(([x, y]) => Math.abs(x - x0) < sw + 28 && Math.abs(y - y0) < sd + 28)) continue;   // separados
    const g = m.walkAt(x0, y0);
    let ok = g <= 3;
    for (let y = y0 - 1; y <= y0 + sd && ok; y++) for (let x = x0 - 1; x <= x0 + sw && ok; x++) ok = m.walkAt(x, y) === g && !w.wet[y * w.width + x];
    if (ok) out.push([x0, y0]);
  }
  return out;
}

const addRamps = (w: World, ramps: Ramp[]): number => {
  const m = w.model, first = m.palette.ramps.length;
  m.palette = { ...m.palette, ramps: [...m.palette.ramps, ...ramps] };      // una paleta NUEVA: así se recalculan los materiales
  return first;
};

function vegetation(w: World, spawn: { x: number; y: number }, seed: number): void {
  const m = w.model;
  const names = ['hierba-alta', 'flor-roja', 'flor-amarilla', 'flor-blanca', 'flor-lila', 'arbusto', 'junco', 'nenufar'];
  const r0 = addRamps(w, [...names.map((n) => structuredClone(FOLIAGE_RAMPS[n]!)), { name: 'hojas', colors: ['#14301f', '#1f4a2a', '#2f6b32', '#4f8f3c', '#86b84e'], material: 'follaje' }, { name: 'tronco', colors: ['#2b1b15', '#4b2f22', '#6e4630'] }]);
  const ri = (n: string) => r0 + names.indexOf(n);
  const hojas = r0 + names.length, tronco = hojas + 1;
  // Árboles: tronco y copa de follaje con huecos (la luz de las antorchas pasa entre las hojas)
  for (const [x0, y0] of freeSpots(w, 24, 24, 8, spawn, seed)) {
    const tx = x0 + 11, ty = y0 + 11, g = m.walkAt(tx, ty), h = 10 + Math.floor(rnd(tx, ty, seed) * 4);
    for (let z = g; z < g + h; z++) for (let y = ty - 1; y <= ty + 1; y++) for (let x = tx - 1; x <= tx + 1; x++) if (z < g + h - 2 || (x === tx && y === ty)) m.set(x, y, z, material(tronco, x === tx - 1 ? 0 : 1));
    const R = 10 + rnd(ty, tx, seed) * 2, cz = g + h + 3, V = 6;
    for (let z = cz - V; z <= cz + V; z++) for (let y = ty - 13; y <= ty + 13; y++) for (let x = tx - 13; x <= tx + 13; x++) {
      const d = Math.hypot((x - tx) / R, (y - ty) / R, (z - cz) / V);
      if (d > 1 || rnd(x * 3 + z, y, seed + 7) < 0.14 || m.get(x, y, z)) continue;
      m.set(x, y, z, material(hojas, Math.min(4, Math.max(0, Math.round((z - cz + V) / 3)))));
    }
  }
  // Lo de suelo y agua, con planFoliage (crece sobre la rampa hierba; el agua del juego es un fluido aparte)
  const all = [0, 0, m.width - 1, m.depth - 1] as const, base = { zMin: m.zMin, seed };
  const put = (p: { voxels: Array<[number, number, number, number]> }) => { for (const [x, y, z, v] of p.voxels) m.set(x, y, z, v); };
  put(planFoliage(m, ...all, m.zMax, { ...base, type: 'bush', ramp: ri('arbusto'), density: 0.004 }));
  put(planFoliage(m, ...all, m.zMax, { ...base, type: 'grass', ramp: ri('hierba-alta'), density: 0.45 }));
  put(planFoliage(m, ...all, m.zMax, { ...base, type: 'flowers', ramp: ri('hierba-alta'), heads: ['flor-roja', 'flor-amarilla', 'flor-blanca', 'flor-lila'].map(ri), density: 0.08 }));
  const waterDepth = worldWaterDepth(w);
  put(planFoliage(m, ...all, m.zMax, { ...base, type: 'reeds', ramp: ri('junco'), waterDepth }));
  put(planFoliage(m, ...all, m.zMax, { ...base, type: 'lilies', ramp: ri('nenufar'), waterDepth, density: 0.008 }));
}

function glass(w: World, theme: WorldTheme, spawn: { x: number; y: number }, seed: number): void {
  const m = w.model;
  const neon = theme === 'cyberpunk';
  const r0 = addRamps(w, neon
    ? [{ name: 'vidrio-rosa', colors: ['#3d1838', '#7a2f6e', '#c463b0'], material: 'vidrio' }, { name: 'vidrio-cian', colors: ['#123a44', '#1f6e80', '#4fc2d6'], material: 'vidrio' }, { name: 'marco', colors: ['#141420', '#262636', '#3c3c52'] }]
    : [{ name: 'vidrio', colors: ['#24465a', '#3f7a96', '#7ab8d6'], material: 'vidrio' }, { name: 'vidrio-mate', colors: ['#3a4650', '#62747f', '#9fb2bd'], material: 'vidrio', props: { light: 0.6 } }, { name: 'marco', colors: ['#2a2d36', '#454a57', '#6b7180'] }]);
  const marco = r0 + 2;
  // Salas de vidrio de 36 x 22 partidas en dos, con marcos cada 6, una puerta al sur en cada mitad y una luz en cada una
  const SW = 36, SD = 22, H = 14;
  freeSpots(w, SW, SD, 4, spawn, seed).forEach(([x0, y0], k) => {
    const g = m.walkAt(x0, y0), pane = r0 + (k % 2), mid = x0 + SW / 2;
    for (let y = y0; y < y0 + SD; y++) for (let x = x0; x < x0 + SW; x++) {
      const wall = x === x0 || x === x0 + SW - 1 || y === y0 || y === y0 + SD - 1 || x === mid;
      if (!wall) continue;
      if (y === y0 && (Math.abs(x - (x0 + 9)) <= 2 || Math.abs(x - (x0 + 27)) <= 2)) continue;   // las puertas, hacia la cámara
      const post = (x - x0) % 6 === 0 && (y === y0 || y === y0 + SD - 1) || (y - y0) % 6 === 0 && (x === x0 || x === x0 + SW - 1 || x === mid);
      for (let z = g; z < g + H; z++) m.set(x, y, z, material(post || z === g + H - 1 || z === g ? marco : pane, post ? 1 : z === g ? 0 : 1));
    }
    for (const lx of [x0 + 9, x0 + 27]) w.lights.push({ id: `sala-${k}-${lx - x0}`, kind: neon ? ((k + lx) % 2 ? 'neon-cyan' : 'neon-pink') : 'lamp', x: lx + 0.5, y: y0 + SD / 2 + 0.5, z: g + 9 });
  });
}

export function decorate(w: World, theme: WorldTheme, spawn: { x: number; y: number }, seed: number): void {
  if (theme === 'medieval') vegetation(w, spawn, seed);
  else glass(w, theme, spawn, seed);
}
