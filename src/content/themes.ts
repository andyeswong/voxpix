// Los temas de escenario (oficina, medieval, cyberpunk): reglas del generador, paletas y agua de cada uno.
import type { WaterPalette } from '../terrain/waterTiles';
import type { GeneratorSpec } from '../worldgen/spec';

// Un tema = datos: qué hojas usa, cómo se genera el mapa y cómo se ve. En el juego esto vive en el contenido
// de cada nivel; el motor (worldgen, terrain, lighting) solo ve los datos.
export type ThemeId = 'medieval' | 'cyberpunk' | 'oficina';
type Palettes = { puddle: WaterPalette; lake: WaterPalette; ocean: WaterPalette };

export interface Theme {
  id: ThemeId;
  name: string;
  files: { nivel: string; muros: string };   // en demo/public/img
  material: string;                          // animación del material suelto
  ambient: readonly [number, number, number];
  spec: GeneratorSpec;
  water?: Palettes;                          // sin esto, los colores de agua por defecto
  pillar: { top: readonly [number, number, number]; topDim: readonly [number, number, number]; lit: readonly [number, number, number]; mid: readonly [number, number, number]; dark: readonly [number, number, number]; joint: readonly [number, number, number] };
}

const MEDIEVAL: Theme = {
  id: 'medieval', name: 'Medieval',
  files: { nivel: 'medieval_nivel', muros: 'medieval_muros' },
  material: 'moneda',
  ambient: [0.4, 0.46, 0.64],
  spec: {
    cols: 40, rows: 30,
    floors: [{ anim: 'piso', weight: 12 }, { anim: 'piso-gastado', weight: 3 }, { anim: 'piso-grieta', weight: 2 }, { anim: 'piso-hierba', weight: 2 }, { anim: 'piso-paja', weight: 1.5 }],
    caps: ['muro-almena', 'muro-tapa'],
    facade: {
      fill: [{ anim: 'muro-liso', weight: 4 }, { anim: 'muro-ventana-arco', weight: 3 }, { anim: 'muro-ventana-oscura', weight: 2 }, { anim: 'muro-tronera', weight: 2 }, { anim: 'muro-hiedra', weight: 1.5 }],
      neutral: 'muro-liso', door: 'muro-puerta', flank: 'muro-antorcha', banner: 'muro-estandarte', crest: 'muro-escudo',
      emits: { 'muro-antorcha': 'torch' },
    },
    water: { ocean: true, lake: true, puddles: 5 },
    pillars: 8, materials: 10,
  },
  pillar: { top: [158, 146, 124], topDim: [138, 126, 106], lit: [124, 113, 96], mid: [98, 89, 75], dark: [64, 57, 48], joint: [48, 42, 35] },
};

const CYBERPUNK: Theme = {
  id: 'cyberpunk', name: 'Cyberpunk',
  files: { nivel: 'cyber_nivel', muros: 'cyber_muros' },
  material: 'chip-suelto',
  ambient: [0.42, 0.46, 0.66],
  spec: {
    cols: 40, rows: 30,
    floors: [{ anim: 'piso', weight: 12 }, { anim: 'piso-gastado', weight: 3 }, { anim: 'piso-raspon', weight: 2 }, { anim: 'piso-rejilla', weight: 1 }, { anim: 'piso-neon-rosa', weight: 0.4 }, { anim: 'piso-neon-cian', weight: 0.4 }],
    caps: ['muro-tapa', 'muro-tapa-aviso'],
    facade: {
      fill: [{ anim: 'muro-liso', weight: 3 }, { anim: 'muro-ventana', weight: 5 }, { anim: 'muro-ventana-calida', weight: 2 }, { anim: 'muro-ventana-cian', weight: 1.2 }, { anim: 'muro-ventana-rosa', weight: 1.2 }, { anim: 'muro-rejilla', weight: 1.4 }, { anim: 'muro-tuberia', weight: 1.1 }, { anim: 'muro-neon-rosa', weight: 1.4 }, { anim: 'muro-neon-cian', weight: 1.4 }],
      neutral: 'muro-liso', door: 'muro-puerta',
      emits: { 'muro-neon-rosa': 'neon-pink', 'muro-neon-cian': 'neon-cyan' },
    },
    water: { ocean: false, lake: true, puddles: 6 },
    pillars: 6, materials: 8,
  },
  // Agua de ciudad de noche: aceitosa, con el reflejo del neón (rosa en los charcos, cian en el lago)
  water: {
    puddle: { edge: '#2a2250', foam: '#b070d0', body: ['#34508a', '#34508a', '#2c4478', '#2c4478'], ripple: ['#f080d8', '#f080d8', '#d868c0', '#d868c0'], alpha: { edge: 0.6, foam: 0.6, body: 0.55, ripple: 0.8 } },
    lake: { edge: '#0a1020', foam: '#40b0c8', body: ['#1a4a5a', '#143c4c', '#0e2e3c', '#0a222e'], ripple: ['#2a8a9a', '#237888', '#1c6676', '#165464'] },
    ocean: { edge: '#060a18', foam: '#c648b8', body: ['#2a1050', '#220c44', '#1a0838', '#12062c'], ripple: ['#a02ea0', '#8a2890', '#742280', '#5e1c6c'] },
  },
  pillar: { top: [118, 128, 156], topDim: [96, 104, 128], lit: [82, 92, 120], mid: [58, 66, 92], dark: [34, 38, 56], joint: [22, 24, 38] },
};

const OFICINA: Theme = {
  id: 'oficina', name: 'Oficina',
  files: { nivel: 'oficina_nivel', muros: 'oficina_muros' },
  material: 'clip-suelto',
  ambient: [0.7, 0.72, 0.8],
  spec: {
    cols: 40, rows: 30,
    floors: [{ anim: 'piso', weight: 12 }, { anim: 'piso-gastado', weight: 3 }, { anim: 'piso-raspon', weight: 2 }, { anim: 'piso-mancha', weight: 0.8 }, { anim: 'piso-papel', weight: 0.6 }],
    caps: ['muro-tapa', 'muro-tapa-rejilla'],
    facade: {
      fill: [{ anim: 'muro-liso', weight: 4 }, { anim: 'muro-ventana', weight: 3 }, { anim: 'muro-ventana-noche', weight: 1.5 }, { anim: 'muro-ventana-persiana', weight: 2 }, { anim: 'muro-cartelera', weight: 1.2 }, { anim: 'muro-extintor', weight: 0.8 }],
      neutral: 'muro-liso', door: 'muro-puerta', flank: 'muro-aplique', banner: 'muro-grafica', crest: 'muro-reloj',
      emits: { 'muro-aplique': 'lamp' },
    },
    // Goteras: solo charcos
    water: { ocean: false, lake: false, puddles: 4 },
    pillars: 3, materials: 10,
    // Escritorios con ordenador: casi todos pegados a una pared (como en una oficina y sin comerse el espacio de pelear)
    props: [
      { anim: 'escritorio-pc', w: 2, h: 1, count: 3, emits: 'screen', edge: true },
      { anim: 'escritorio-laptop', w: 2, h: 1, count: 2, emits: 'screen', edge: true },
      { anim: 'escritorio-pc', w: 2, h: 1, count: 1, emits: 'screen' },
    ],
  },
  pillar: { top: [150, 148, 144], topDim: [126, 124, 120], lit: [110, 108, 106], mid: [84, 82, 82], dark: [52, 50, 52], joint: [38, 36, 38] },
};

export const THEMES: Record<ThemeId, Theme> = { medieval: MEDIEVAL, cyberpunk: CYBERPUNK, oficina: OFICINA };
export const THEME_IDS = Object.keys(THEMES) as ThemeId[];
