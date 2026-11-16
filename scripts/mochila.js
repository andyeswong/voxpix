// Example of the editor API (window.voxpix): makes models/mochila/mochila.voxset.json.
// How to regenerate it: models/README.md.
// Una mochila de cuero, hecha solo con el editor (window.voxpix): para un icono (la mochila del inventario), en un
// cubo de 8 x 8 x 8 de un set (x e y de -4 a 3, z de 0 a 7; el frente mira a -y), así su icono sale con iconSheet
// como el de un bloque. No es para ponerla en el mundo. Determinista.
//   MOCHILA_RAMPS: las rampas que añade, cuero y hebilla (van AL FINAL de la paleta de un set que ya tenga las suyas:
//   detrás de la última, para no mover ningún índice).
//   mochilaBlocks(vp, add): pinta y añade la mochila en el set abierto, con id 'mochila'.
// Hecha para que su icono oblicuo de 16 px parezca un dibujo plano: una losa de 2 de hondo (la cara de arriba casi no
// sale), el cuerpo de cuero claro rojizo, la solapa oscura en las 3 filas de arriba, la hebilla clara centrada debajo
// y el asa oscura encima, en el plano del frente. Medido sobre el icono de 16 px: 80 % de su interior es cuero claro
// (luminancia >= 120) o solapa (<= 55), la banda oscura son 4 filas seguidas arriba y la hebilla un 2 x 2 >= 190.
// El render baja o sube un tono cada cara según la luz: los tonos de aquí están puestos para lo que se ve.
// Corrido solo (en la página del editor), crea un set "mochila" y devuelve su .voxset.json.
const MOCHILA_RAMPS = [
  { name: 'cuero', colors: ['#3a1a0c', '#582a12', '#7a3e1c', '#9a5226', '#b86a34', '#d08446', '#e49c5c'] },
  { name: 'hebilla', colors: ['#8a8478', '#c8c2b4', '#ece8dc'] },
];
function mochilaBlocks(vp, add) {
  // Pensada para que su icono (la vista oblicua de iconSheet, a 16 px) parezca un dibujo plano: una losa delgada, así
  // la cara de arriba casi no sale y manda el frente; bloques de color grandes y nada que sobresalga
  const v = new Map();
  const put = (x, y, z, m) => v.set(`${x},${y},${z}`, [x, y, z, m]);
  // El cuerpo: todo el ancho (x -4..3), 2 de hondo (y -1..0) y 7 de alto (z 0..6), de cuero claro
  // (el render baja un tono la cara de delante: se pinta en el 5 para que se vea en el 4, luminancia >= 120)
  for (let z = 0; z <= 6; z++) for (let y = -1; y <= 0; y++) for (let x = -4; x <= 3; x++) put(x, y, z, 'cuero:5');
  // La solapa, oscura: las 3 filas de arriba del frente, con el borde de abajo recto
  for (let z = 4; z <= 6; z++) for (let x = -4; x <= 3; x++) put(x, -1, z, 'cuero:1');
  // y por encima (la cara de arriba, que el render sube un tono: en el 0 para que se vea como la solapa)
  for (let x = -4; x <= 3; x++) put(x, 0, 6, 'cuero:0');
  // La hebilla, clara, centrada justo debajo de la solapa
  // (4 de ancho: en la vista oblicua, 2 x 2 vóxeles no caen en 2 x 2 píxeles enteros)
  for (let x = -2; x <= 1; x++) for (const z of [2, 3]) put(x, -1, z, 'hebilla:2');
  // El asa, oscura, en la fila de arriba (z 7): 4 vóxeles centrados en el plano del frente
  for (let x = -2; x <= 1; x++) put(x, -1, 7, 'cuero:0');
  vp.voxels([...v.values()]);
  add('mochila');
}
(typeof window !== 'undefined' && window.__mochilaSolo !== false) ? ((vp) => {
  vp.newModel('mochila', 8, 8, 8);
  vp.palette(MOCHILA_RAMPS);
  vp.newSet('mochila', 8);
  mochilaBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
  return vp.saveSet();
})(window.voxpix) : null
