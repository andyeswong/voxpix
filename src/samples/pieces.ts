// Constructores de pieza de MUESTRA (los de la demo y las pruebas): leen los nombres que pone el generador de los temas
// de muestra (src/samples/themes.ts) y los dibujan en vóxeles. Son contenido: un juego hace los suyos con el mismo
// contrato (WorldLook de src/world/build.ts) y sus propios nombres.
import { material } from '../core';
import { M, worldNoise, type FloorBuilder, type FacadeBuilder, type FixtureBuilder, type PropBuilder } from '../world/build';

// Losas: parches gastados de 4x4, grietas, hierba o paja entre las losas, una franja de neón y rejillas de metal
export const sampleFloor: FloorBuilder = ({ kind, cx, cy, lx, ly, tone, noise: n, seed }) => {
  if (kind.includes('gastado') && worldNoise(cx * 4 + (lx >> 2), cy * 4 + (ly >> 2), 7, seed) > 0.6) tone += 1;
  if (kind.includes('grieta') && Math.abs(lx - ly) < 1 && lx > 3 && lx < 13) tone = 0;
  let v = material(M.floor, Math.max(0, Math.min(4, tone)));
  if ((kind.includes('hierba') || kind.includes('paja')) && n > 0.7) v = material(kind.includes('paja') ? M.wood : M.grass, n > 0.9 ? 3 : 2);
  if (kind.includes('neon') && ly === 8 && lx > 2 && lx < 14) v = material(kind.includes('rosa') ? M.neonPink : M.neonCyan, 3);
  if (kind.includes('rejilla') && (lx % 3 === 0 || ly % 3 === 0)) v = material(M.metal, 1);
  return v;
};

// Las alturas de las piezas están pensadas para una pared de 32 y se escalan a la de verdad (16 por defecto)
const scaler = (height: number) => (z: number) => Math.max(1, Math.min(height - 2, Math.round((z * height) / 32)));

// Fachada: puertas de madera, ventanas (cálidas, oscuras o de neón) y troneras, estandartes y carteleras, rótulos de neón
export const sampleFacade: FacadeBuilder = ({ model, piece, cx, x0, faceY, height, seed, carve }) => {
  const z = scaler(height);
  if (piece.includes('puerta')) {
    carve(3, 12, 1, z(22), (lx) => material(M.wood, lx === 3 || lx === 12 ? 1 : lx === 8 ? 1 : 2));
  } else if (piece.includes('ventana') || piece.includes('tronera')) {
    const warm = piece.includes('calida') || piece.includes('arco') && worldNoise(cx, 0, 0, seed) > 0.5;
    const neon = piece.includes('cian') ? M.neonCyan : piece.includes('rosa') ? M.neonPink : null;
    const narrow = piece.includes('tronera');
    carve(narrow ? 7 : 4, narrow ? 8 : 11, z(12), z(24), (lx, zz) => material(neon ?? (warm ? M.warmGlass : M.darkGlass), (lx + zz) % 5 === 0 ? 3 : 2));
  } else if (piece.includes('estandarte') || piece.includes('grafica') || piece.includes('cartelera')) {
    const top = z(27), fringe = z(22);
    for (let lx = 4; lx <= 11; lx++) for (let zz = z(8); zz <= top; zz++)
      model.set(x0 + lx, faceY - 1, zz, material(piece.includes('cartelera') ? M.wood : M.cloth, lx === 4 || lx === 11 ? 1 : zz > fringe ? 3 : 2));
  } else if (piece.includes('neon')) {
    const ramp = piece.includes('cian') ? M.neonCyan : M.neonPink;
    const hi = z(20), lo = Math.min(hi - 1, z(18));
    for (let lx = 2; lx <= 13; lx++) model.set(x0 + lx, faceY - 1, hi, material(ramp, 4));
    for (let lx = 2; lx <= 13; lx++) model.set(x0 + lx, faceY - 1, lo, material(ramp, 3));
  }
};

// Antorchas, apliques y braseros de pared: un soporte de metal con su llama (o la pantalla del aplique) y su luz.
// Las demás fuentes (neón), solo la luz delante de la pared
export const sampleFixture: FixtureBuilder = ({ model, source: s, x, faceY, height, lights }) => {
  const y = faceY - 1;
  // El soporte (2), el brazo (1) y la llama (2): 5 vóxeles que acaban 1 por debajo de la tapa en una pared de 16 o
  // menos, y a la altura de siempre (z 16..20) en una de 32
  const b = Math.min(16, Math.max(1, height - 7));
  if (s.kind === 'torch' || s.kind === 'lamp' || s.kind === 'brazier') {
    model.set(x, y, b, material(M.metal, 2)); model.set(x, y, b + 1, material(M.metal, 3));
    model.set(x, y - 1, b + 2, material(M.metal, 2));
    const flame = s.kind === 'lamp' ? M.warmGlass : M.flame;
    model.set(x, y - 1, b + 3, material(flame, 3)); model.set(x, y - 1, b + 4, material(flame, 4));
    model.set(x - 1, y - 1, b + 3, material(flame, 2)); model.set(x + 1, y - 1, b + 3, material(flame, 2));
    lights.push({ id: s.id, kind: s.kind, x: x + 0.5, y: y - 5, z: b + 4.5 });
  } else {
    lights.push({ id: s.id, kind: s.kind, x: x + 0.5, y: y - 3, z: b + 3.5 });
  }
};

// Escritorios: tablero de madera sobre patas y un monitor al fondo, con la pantalla mirando al sur (y su luz)
export const sampleProp: PropBuilder = ({ model, prop: p, x0, x1, yS, yN, lights }) => {
  for (let x = x0 + 1; x <= x1 - 1; x++) for (let y = yS + 1; y <= yN - 1; y++) {
    model.set(x, y, 11, material(M.wood, 3));
    model.set(x, y, 10, material(M.wood, 2));
  }
  for (const [lx, ly] of [[x0 + 2, yS + 2], [x1 - 2, yS + 2], [x0 + 2, yN - 2], [x1 - 2, yN - 2]] as const)
    for (let z = 0; z < 10; z++) model.set(lx, ly, z, material(M.wood, 1));
  const mx = Math.round((x0 + x1) / 2);
  for (let x = mx - 6; x <= mx + 6; x++) for (let z = 12; z <= 21; z++) {
    model.set(x, yN - 3, z, material(M.metal, 1));
    if (z > 12 && z < 21 && Math.abs(x - mx) < 6) model.set(x, yN - 4, z, material(M.screen, z > 18 ? 3 : 2));
  }
  if (p.anim.includes('escritorio')) lights.push({ id: `prop-${p.x}-${p.y}`, kind: 'screen', x: mx + 0.5, y: yN - 7, z: 17 });
};

// Todas juntas, para un WorldLook: { palette, ...SAMPLE_PIECES }
export const SAMPLE_PIECES = { floor: sampleFloor, facade: sampleFacade, fixture: sampleFixture, prop: sampleProp } as const;
