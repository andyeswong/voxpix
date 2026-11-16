// Una mochila de cuero, hecha solo con el editor (window.voxpix): para un icono (la mochila del inventario), en un
// cubo de 8 x 8 x 8 de un set (x e y de -4 a 3, z de 0 a 7; el frente mira a -y), así su icono sale con iconSheet
// como el de un bloque. No es para ponerla en el mundo. Determinista.
//   MOCHILA_RAMPS: las rampas que añade, cuero y hebilla (van AL FINAL de la paleta de un set que ya tenga las suyas:
//   detrás de la última, para no mover ningún índice).
//   mochilaBlocks(vp, add): pinta y añade la mochila en el set abierto, con id 'mochila'.
// Hecha para leerse a 16 px, con bloques de color grandes: el cuerpo de cuero claro rojizo (para no confundirse con
// tablas), de esquinas rectas; la solapa oscura, una banda ancha que cae por delante; la hebilla clara bajo ella; y el
// asa oscura arriba.
// Corrido solo (en la página del editor), crea un set "mochila" y devuelve su .voxset.json.
const MOCHILA_RAMPS = [
  { name: 'cuero', colors: ['#3a1a0c', '#5a2c14', '#7a3e1c', '#9a5226', '#b86a34'] },
  { name: 'hebilla', colors: ['#8a8478', '#c8c2b4', '#ece8dc'] },
];
function mochilaBlocks(vp, add) {
  // Pensada para leerse en un icono de 16 px: bloques de color grandes, sin detalle fino ni salientes (un saliente
  // oscurece lo de debajo)
  const v = new Map();
  const put = (x, y, z, m) => v.set(`${x},${y},${z}`, [x, y, z, m]);
  // El cuerpo: todo el ancho (x -4..3), 4 de hondo (y -3..0) y hasta z 6, de esquinas rectas, de cuero claro
  for (let z = 0; z <= 6; z++) for (let y = -3; y <= 0; y++) for (let x = -4; x <= 3; x++) put(x, y, z, `cuero:${y === -3 ? 4 : 3}`);
  // La solapa, oscura: el borde delantero de arriba y 4 filas por delante, de lado a lado
  for (let x = -4; x <= 3; x++) {
    put(x, -3, 6, 'cuero:1'); put(x, -2, 6, 'cuero:1');
    for (let z = 3; z <= 6; z++) put(x, -3, z, 'cuero:1');
  }
  // La hebilla, clara, centrada justo debajo de la solapa
  for (const [x, z] of [[-1, 1], [0, 1], [-1, 2], [0, 2]]) put(x, -3, z, 'hebilla:2');
  // El asa, oscura, arriba en el borde de atrás: asoma por encima de la silueta
  for (let x = -3; x <= 3; x++) put(x, 0, 7, 'cuero:0');
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
