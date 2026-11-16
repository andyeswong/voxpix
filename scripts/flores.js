// Example of the editor API (window.voxpix): makes models/flores/flores.voxset.json.
// How to regenerate it: models/README.md.
// Tres flores como bloques de un set (roja, amarilla y blanca), hechas solo con el editor (window.voxpix). Cada una,
// pequeña y de pie sobre z = 0 dentro de su cubo de 8 x 8 x 8 (x e y de -4 a 3). Con rampas de material
// 'follaje' (el de hierba, flores y hojas) y sin brillo: se cruzan y dejan pasar la luz (props solid false, light
// 'passes'; se aplastan si el juego usa crushAt). El icono de cada una sale de su
// bloque (iconSheet).
//   FLORES_RAMPS: las rampas que hacen falta (van AL FINAL de la paleta de un set que ya tenga las suyas, para no mover
//   sus índices). floresBlocks(vp, add): pinta y añade los tres bloques en el set abierto.
// Corrido solo (en la página del editor), crea un set "flores" con estas rampas y devuelve su .voxset.json.
const FLORES_RAMPS = [
  { name: 'petalo_rojo', colors: ['#5a1018', '#9a1c24', '#d02c30', '#f05a50'], material: 'follaje' },
  { name: 'petalo_amarillo', colors: ['#8a6a10', '#c8a018', '#f0d030', '#fff08a'], material: 'follaje' },
  { name: 'petalo_blanco', colors: ['#9aa0aa', '#c8ccd4', '#e8eaf0', '#ffffff'], material: 'follaje' },
  { name: 'tallo', colors: ['#1e3a14', '#2e5a1e', '#46802c', '#62a03c'], material: 'follaje' },
];
function floresBlocks(vp, add) {
  // El tallo (de z 0 a top) y una o dos hojas que salen de él en diagonal hacia arriba
  const stem = (top, leaves) => {
    const v = [];
    for (let z = 0; z <= top; z++) v.push([0, 0, z, `tallo:${z === 0 ? 1 : 2}`]);
    for (const [dx, dy, z] of leaves) { v.push([dx, dy, z, 'tallo:3']); v.push([2 * dx, 2 * dy, z + 1, 'tallo:2']); }
    return v;
  };
  // Roja: un tulipán. Copa de 3 x 3 en z 5, sus bordes suben en z 6 y el fondo de la copa más oscuro
  vp.voxels([
    ...stem(4, [[1, 0, 1], [-1, 0, 2]]),
    ...[-1, 0, 1].flatMap((y) => [-1, 0, 1].map((x) => [x, y, 5, x === 0 && y === 0 ? 'petalo_rojo:0' : 'petalo_rojo:2'])),
    ...[-1, 0, 1].flatMap((y) => [-1, 0, 1].filter((x) => x !== 0 || y !== 0).map((x) => [x, y, 6, (x + y) % 2 ? 'petalo_rojo:3' : 'petalo_rojo:1'])),
  ]);
  add('flor_roja');
  // Amarilla: plana y abierta, pétalos en cruz de 2 y en diagonal, con el centro oscuro
  vp.voxels([
    ...stem(3, [[0, 1, 1]]),
    [0, 0, 4, 'petalo_amarillo:0'],
    ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => [x, y, 4, 'petalo_amarillo:2']),
    ...[[2, 0], [-2, 0], [0, 2], [0, -2]].map(([x, y]) => [x, y, 4, 'petalo_amarillo:3']),
    ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, y]) => [x, y, 4, 'petalo_amarillo:1']),
  ]);
  add('flor_amarilla');
  // Blanca: una margarita más alta, pétalos blancos en cruz de 2 y diagonales, y el botón amarillo que sobresale
  vp.voxels([
    ...stem(4, [[-1, 0, 1], [0, -1, 2]]),
    [0, 0, 5, 'petalo_amarillo:2'], [0, 0, 6, 'petalo_amarillo:3'],
    ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, y]) => [x, y, 5, 'petalo_blanco:3']),
    ...[[2, 0], [-2, 0], [0, 2], [0, -2]].map(([x, y]) => [x, y, 5, 'petalo_blanco:2']),
    ...[[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([x, y]) => [x, y, 5, 'petalo_blanco:1']),
  ]);
  add('flor_blanca');
}
(typeof window !== 'undefined' && window.__floresSolo !== false) ? ((vp) => {
  vp.newModel('flores', 8, 8, 8);
  vp.palette(FLORES_RAMPS);
  vp.newSet('flores', 8);
  floresBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
  return vp.saveSet();
})(window.voxpix) : null
