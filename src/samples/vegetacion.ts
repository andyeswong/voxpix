// Muestra de vegetación (NARUTO): un prado con un árbol de copa de follaje, hierba, flores y un arbusto, para las
// pruebas de la luz (sombra moteada, contraluz) y los oráculos CPU contra GPU.
import { Model, material, box, type Palette } from '../core';

export const VEG_PALETTE: Palette = {
  ramps: [
    { name: 'tierra', colors: ['#2a1d1b', '#4a3226', '#6b4a32', '#8d6a45'] },
    { name: 'hierba', colors: ['#1d3a26', '#2f5a2e', '#4a7d36', '#78a447'] },
    { name: 'tronco', colors: ['#2b1b15', '#4b2f22', '#6e4630'] },
    { name: 'hojas', colors: ['#14301f', '#1f4a2a', '#2f6b32', '#4f8f3c', '#86b84e'], kind: 'foliage' },
    { name: 'hierba-alta', colors: ['#24452a', '#3b6a33', '#5c923f', '#8fbf55'], kind: 'foliage' },
    { name: 'flor-roja', colors: ['#5a1424', '#a32638', '#e0504a'], kind: 'foliage' },
    { name: 'arbusto', colors: ['#183522', '#28532d', '#3f7535', '#6a9a45'], kind: 'foliage', blocks: true },
  ],
};

// Hash determinista de una celda (para colocar sin Math.random)
const hash = (x: number, y: number, s: number) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function vegetationScene(): Model {
  const m = new Model(structuredClone(VEG_PALETTE), 'vegetacion');
  const N = 40;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m.set(x, y, 0, material(1, 1 + Math.floor(hash(x, y, 1) * 2)));
  // El árbol: tronco sólido y una copa de follaje con huecos
  box(m, 14, 20, 1, 15, 21, 7, material(2, 1));
  for (let z = 6; z <= 13; z++) for (let y = 13; y <= 28; y++) for (let x = 7; x <= 22; x++) {
    const d = Math.hypot((x - 14.5) / 7, (y - 20.5) / 7, (z - 9.5) / 4);
    if (d > 1 || hash(x * 7 + z, y, 2) < 0.18) continue;
    m.set(x, y, z, material(3, Math.min(4, 1 + Math.floor((z - 6) / 2.5))));
  }
  // Hierba alta y flores por el prado
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const r = hash(x, y, 3);
    if (r < 0.14) { m.set(x, y, 1, material(4, 1 + Math.floor(hash(x, y, 4) * 2))); if (r < 0.05) m.set(x, y, 2, material(4, 2)); }
    else if (r < 0.17) { m.set(x, y, 1, material(4, 1)); m.set(x, y, 2, material(5, 2)); }
  }
  // Un arbusto que no se atraviesa
  for (let z = 1; z <= 3; z++) for (let y = 4; y <= 9; y++) for (let x = 28; x <= 34; x++) if (Math.hypot((x - 31) / 3.2, (y - 6.5) / 2.8, (z - 1) / 2.6) <= 1) m.set(x, y, z, material(6, z === 3 ? 2 : 1));
  return m;
}
