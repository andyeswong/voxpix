import { Model, material, box, type Palette } from '../core';

// La escena de muestra de VoxPix (la que abre la app): un rincón medieval de 32 x 32 vóxeles. Colinas de hierba con
// tierra y roca debajo, un río con su puente de madera, un estanque, una torre de piedra con almenas y puerta, una
// casa con tejado a dos aguas, un camino de tierra, árboles y unas luces (antorchas y un farol) para verlo de noche.
// Determinista: la misma escena cada vez. Ejes: x este, y norte, z arriba; el pivote (0, 0, 0) en el centro.

export const MEDIEVAL_PALETTE: Palette = {
  ramps: [
    { name: 'hierba', colors: ['#2d4a2a', '#3f6b33', '#5a8a3c', '#7fae4f'] },
    { name: 'tierra', colors: ['#3b2a1e', '#5a3e28', '#7a5636', '#9c7146'] },
    { name: 'piedra', colors: ['#2e2f38', '#4a4c58', '#6c6f7c', '#9a9dab'] },
    { name: 'madera', colors: ['#2b1b12', '#4a2f1d', '#6e4729', '#94643a'] },
    { name: 'agua', colors: ['#16324d', '#1f4f78', '#2f74a6', '#5fa8d6'] },
    { name: 'hojas', colors: ['#1f3a22', '#2f5a2f', '#46803c', '#6aa64f'] },
    { name: 'tejado', colors: ['#4a1c1c', '#6e2a24', '#93402f', '#b85a3c'] },
    { name: 'arena', colors: ['#6b5a3a', '#8c7650', '#ad9466', '#cdb581'] },
  ],
};

// Una fuente de luz de la escena, en una celda (los tipos son los de src/lighting: torch, lamp, brazier...)
export interface SceneLight { id: string; kind: 'torch' | 'lamp' | 'brazier'; x: number; y: number; z: number }

const [HIERBA, TIERRA, PIEDRA, MADERA, AGUA, HOJAS, TEJADO, ARENA] = [0, 1, 2, 3, 4, 5, 6, 7];
const HALF = 16;

export function medievalScene(): { model: Model; lights: SceneLight[] } {
  const m = new Model(structuredClone(MEDIEVAL_PALETTE), 'medieval');
  const put = (x: number, y: number, z: number, v: number) => { if (x >= -HALF && x < HALF && y >= -HALF && y < HALF && z >= 0) m.set(x, y, z, v); };

  // ---- terreno: colinas suaves, más alto al noroeste (donde va la torre); el río y el estanque, excavados
  const riverX = (y: number) => 6 + 2.5 * Math.sin(y / 5);
  const pond = { x: -9, y: -9, r: 3.6 };
  const tower = { x: -9, y: 8 };
  const ground = (x: number, y: number) => Math.round(Math.max(2, 3 + 0.9 * Math.sin(x / 4.5) * Math.cos(y / 5) + 0.7 * Math.sin((x + y) / 6)
    + Math.max(0, 3 - Math.hypot(x - tower.x, y - tower.y) / 2.5)));
  const heights = new Map<string, number>();
  const hAt = (x: number, y: number) => heights.get(`${x},${y}`) ?? 0;
  for (let y = -HALF; y < HALF; y++) for (let x = -HALF; x < HALF; x++) {
    let h = ground(x, y);
    const dr = Math.abs(x - riverX(y)), dp = Math.hypot(x - pond.x, y - pond.y);
    const wet = dr < 1.6 || dp < pond.r;
    if (wet) h = 1; else if (dr < 2.6 || dp < pond.r + 1) h = Math.min(h, 2);
    heights.set(`${x},${y}`, h);
    const shore = dr < 3.2 || dp < pond.r + 1.6;
    for (let z = 0; z <= h; z++) {
      const top = z === h;
      put(x, y, z, z < h - 2 ? material(PIEDRA, 1) : !top ? material(TIERRA, z === h - 1 ? 2 : 1)
        : shore ? material(ARENA, h <= 2 ? 1 : 2) : material(HIERBA, h >= 5 ? 3 : h >= 4 ? 2 : 1));
    }
    if (wet) put(x, y, 2, material(AGUA, 2));                       // el agua, hasta la altura 2
  }

  // ---- camino de tierra de la puerta de la torre al puente
  const bridgeY = -1, bx = Math.round(riverX(bridgeY));
  for (let t = 0; t <= 1; t += 0.02) {
    const x = Math.round(tower.x + (bx - 3 - tower.x) * t), y = Math.round(tower.y - 4 - (tower.y - 4 - bridgeY) * t + Math.sin(t * 5));
    for (const [dx, dy] of [[0, 0], [1, 0]] as const) { const h = hAt(x + dx, y + dy); if (h > 2) put(x + dx, y + dy, h, material(TIERRA, (x + y) % 2 ? 2 : 3)); }
  }

  // ---- torre de piedra de 6 x 6, hueca, con almenas, puerta al sur y una ventana
  const base = hAt(tower.x, tower.y), top = base + 9;
  box(m, tower.x - 3, tower.y - 3, 1, tower.x + 2, tower.y + 2, top, material(PIEDRA, 2));
  box(m, tower.x - 2, tower.y - 2, base + 1, tower.x + 1, tower.y + 1, top - 1, 0);
  for (let x = tower.x - 3; x <= tower.x + 2; x++) for (let y = tower.y - 3; y <= tower.y + 2; y++) {
    const edge = x === tower.x - 3 || x === tower.x + 2 || y === tower.y - 3 || y === tower.y + 2;
    if (edge && (x + y) % 2 === 0) put(x, y, top + 1, material(PIEDRA, 3));
  }
  box(m, tower.x - 1, tower.y - 3, base + 1, tower.x, tower.y - 3, base + 3, 0);                 // puerta
  box(m, tower.x - 1, tower.y - 3, base + 6, tower.x, tower.y - 3, base + 7, material(PIEDRA, 0)); // ventana

  // ---- casa de madera con tejado rojo a dos aguas
  const house = { x: -1, y: -6 };
  const g = Math.max(hAt(house.x, house.y), 3);
  box(m, house.x - 3, house.y - 2, 1, house.x + 3, house.y + 2, g + 3, material(MADERA, 2));
  box(m, house.x - 2, house.y - 1, g + 1, house.x + 2, house.y + 1, g + 3, 0);
  for (let x = house.x - 3; x <= house.x + 3; x++) for (let y = house.y - 3; y <= house.y + 3; y++) {
    const roof = g + 4 + Math.min(y - (house.y - 3), house.y + 3 - y);
    if (roof <= g + 6) put(x, y, roof, material(TEJADO, (x + y) % 2 ? 2 : 1));
  }
  box(m, house.x, house.y - 2, g + 1, house.x, house.y - 2, g + 2, material(MADERA, 0));          // puerta

  // ---- puente de madera sobre el río, con barandillas
  box(m, bx - 3, bridgeY - 1, 3, bx + 3, bridgeY + 1, 3, material(MADERA, 3));
  box(m, bx - 3, bridgeY - 1, 4, bx + 3, bridgeY - 1, 4, material(MADERA, 1));
  box(m, bx - 3, bridgeY + 1, 4, bx + 3, bridgeY + 1, 4, material(MADERA, 1));

  // ---- árboles: tronco y copa redonda
  for (const [x, y, th, r] of [[-13, -2, 3, 2.2], [-4, 13, 3, 2.4], [2, 9, 2, 2], [12, 11, 3, 2.4], [12, -6, 2, 2.2], [-14, 13, 2, 1.8], [-5, -13, 2, 2], [13, -14, 3, 2.2]] as const) {
    const h = hAt(x, y);
    box(m, x, y, h + 1, x, y, h + th, material(MADERA, 1));
    for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) for (let dz = -2; dz <= 3; dz++) {
      if (dx * dx + dy * dy + (dz * 1.3) ** 2 > r * r) continue;
      put(x + dx, y + dy, h + th + 2 + dz, material(HOJAS, dz > 0 ? 3 : dz > -1 ? 2 : 1));
    }
  }

  const lights: SceneLight[] = [
    { id: 'antorcha-torre', kind: 'torch', x: tower.x - 2, y: tower.y - 4, z: base + 4 },
    { id: 'brasero-torre', kind: 'brazier', x: tower.x, y: tower.y, z: top + 1 },
    { id: 'farol-casa', kind: 'lamp', x: house.x + 1, y: house.y - 3, z: g + 2 },
    { id: 'antorcha-puente', kind: 'torch', x: bx - 4, y: bridgeY - 2, z: 5 },
  ];
  return { model: m, lights };
}
