import { Model, material, box, ellipsoid, cylinder, type Palette } from '../core';

// Modelos de prueba del render: una esfera, una columna y una caja, con rampas de 5 tonos.
export const TEST_PALETTE: Palette = {
  ramps: [
    { name: 'violeta', colors: ['#1c1838', '#2a2450', '#3a3163', '#55457e', '#7a68aa'] },
    { name: 'piedra', colors: ['#2a2622', '#423b33', '#5e5447', '#7e735f', '#a3977c'] },
    { name: 'madera', colors: ['#2e1c14', '#4a2e1c', '#6e4628', '#946436', '#b88850'] },
    { name: 'agua', colors: ['#0e1a2e', '#16304a', '#1f4a66', '#2f6a86', '#5a9ab4'] },
  ],
};

export function sampleScene(): Model {
  const m = new Model(TEST_PALETTE, 'muestra');
  ellipsoid(m, -9, 0, 6, 5.5, 5.5, 5.5, material(0, 2));       // esfera violeta
  cylinder(m, 3, 0, 0, 14, 3.2, 3.2, material(1, 2));           // columna de piedra
  box(m, 1, -3, 15, 5, 3, 16, material(1, 3));                  // capitel
  box(m, 9, -4, 0, 16, 3, 5, material(2, 2));                   // caja de madera
  return m;
}
