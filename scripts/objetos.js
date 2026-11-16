// Example of the editor API (window.voxpix): makes models/objetos/objetos.voxset.json.
// How to regenerate it: models/README.md.
// Objetos de mano de un mundo medieval, hechos solo con el editor (window.voxpix): picos y espadas de madera, piedra y
// hierro, un palo y lingotes de hierro y oro. Cada uno en un cubo de 8 x 8 x 8 de un set (x e y de -4 a 3, z de 0 a
// 7), así su icono sale con iconSheet como el de un bloque. De pie, con el mango hacia abajo y el agarre en
// OBJETOS_GRIP[id] (coordenadas del lienzo): para llevarlo en la mano, se suman sus vóxeles menos el agarre a la
// posición de la mano en cada cuadro. Los lingotes van tumbados (se llevan en la mochila, no en la mano).
// Corrido solo (en la página del editor), crea el set "objetos" y devuelve su .voxset.json.
const OBJETOS_RAMPS = [
  { name: 'palo', colors: ['#3a2614', '#5a3c20', '#7a5430'], material: 'atravesable' },
  { name: 'tabla', colors: ['#4a3018', '#6a4626', '#8c6036', '#ad7c48', '#c89a62'], material: 'atravesable' },
  { name: 'piedra', colors: ['#2a2b32', '#3e4049', '#565a64', '#727784', '#949aa6'], material: 'atravesable' },
  { name: 'hierro', colors: ['#3a4048', '#565e68', '#76808c', '#9aa4b0'], material: 'atravesable' },
  { name: 'oro', colors: ['#7a5a10', '#b88a18', '#e8b830', '#f8e070'], material: 'atravesable' },
];
const OBJETOS_GRIP = {
  palo: [0, 0, 1],
  pico_madera: [0, 0, 1], pico_piedra: [0, 0, 1], pico_hierro: [0, 0, 1],
  espada_madera: [0, 0, 0], espada_piedra: [0, 0, 0], espada_hierro: [0, 0, 0],
  lingote_hierro: [0, 0, 0], lingote_oro: [0, 0, 0],
};
function objetosBlocks(vp, add) {
  // Palo: un mango de 7
  vp.voxels([0, 1, 2, 3, 4, 5, 6].map((z) => [0, 0, z, `palo:${z % 3 === 0 ? 1 : 2}`]));
  add('palo');
  // Pico: el mango y la cabeza atravesada arriba, con las puntas hacia abajo
  const pick = (ramp, hi) => {
    vp.voxels([
      ...[0, 1, 2, 3, 4, 5].map((z) => [0, 0, z, `palo:${z % 3 === 0 ? 1 : 2}`]),
      ...[-2, -1, 0, 1, 2].map((x) => [x, 0, 6, `${ramp}:${x === 0 ? hi : hi - 1}`]),
      [-1, 0, 7, `${ramp}:${hi}`], [0, 0, 7, `${ramp}:${hi}`], [1, 0, 7, `${ramp}:${hi}`],
      [-3, 0, 5, `${ramp}:${hi - 1}`], [3, 0, 5, `${ramp}:${hi - 1}`],
    ]);
  };
  pick('tabla', 3); add('pico_madera');
  pick('piedra', 3); add('pico_piedra');
  pick('hierro', 3); add('pico_hierro');
  // Espada: puño y pomo, la guarda atravesada y la hoja hasta arriba, con el filo más claro
  const sword = (ramp, hi) => {
    vp.voxels([
      [0, 0, 0, 'palo:1'], [0, 0, 1, 'palo:2'],
      ...[-2, -1, 0, 1, 2].map((x) => [x, 0, 2, x === 0 ? 'palo:1' : `${ramp}:${hi - 2}`]),
      ...[3, 4, 5, 6].map((z) => [0, 0, z, `${ramp}:${hi - 1}`]),
      [0, 0, 7, `${ramp}:${hi}`],
      ...[3, 4, 5].map((z) => [1, 0, z, `${ramp}:${hi}`]),
    ]);
  };
  sword('tabla', 4); add('espada_madera');
  sword('piedra', 4); add('espada_piedra');
  sword('hierro', 3); add('espada_hierro');
  // Lingote: tumbado, más estrecho arriba y la cara de arriba más clara
  const ingot = (ramp) => {
    const v = [];
    for (let y = -1; y <= 1; y++) for (let x = -3; x <= 2; x++) v.push([x, y, 0, `${ramp}:1`]);
    for (let y = -1; y <= 0; y++) for (let x = -2; x <= 1; x++) v.push([x, y, 1, `${ramp}:${y === -1 ? 2 : 3}`]);
    vp.voxels(v);
  };
  ingot('hierro'); add('lingote_hierro');
  ingot('oro'); add('lingote_oro');
}
(typeof window !== 'undefined' && window.__objetosSolo !== false) ? ((vp) => {
  vp.newModel('objetos', 8, 8, 8);
  vp.palette(OBJETOS_RAMPS);
  vp.newSet('objetos', 8);
  objetosBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
  return vp.saveSet();
})(window.voxpix) : null
