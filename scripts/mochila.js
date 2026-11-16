// Una mochila de cuero, hecha solo con el editor (window.voxpix): para un icono (la mochila del inventario), en un
// cubo de 8 x 8 x 8 de un set (x e y de -4 a 3, z de 0 a 7; el frente mira a -y), así su icono sale con iconSheet
// como el de un bloque. No es para ponerla en el mundo. Determinista.
//   MOCHILA_RAMPS: la rampa que añade (va AL FINAL de la paleta de un set que ya tenga las suyas). Usa además la
//   rampa 'hierro' del set al que se añade (o la de MOCHILA_BASE si se corre sola), para la hebilla.
//   mochilaBlocks(vp, add): pinta y añade la mochila en el set abierto, con id 'mochila'.
// Cuero marrón medio (rojizo, para no confundirse con tablas), la solapa más oscura que cae por delante, la hebilla
// clara, dos correas oscuras por delante bajo la solapa con un bolsillo claro entre ellas, y el asa arriba.
// Corrido solo (en la página del editor), crea un set "mochila" y devuelve su .voxset.json.
const MOCHILA_BASE = [
  { name: 'hierro', colors: ['#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
];
const MOCHILA_RAMPS = [
  { name: 'cuero', colors: ['#3a1a0c', '#5a2c14', '#7a3e1c', '#9a5226', '#b86a34'] },
];
function mochilaBlocks(vp, add) {
  const v = [];
  const put = (x, y, z, m) => { const i = v.findIndex((p) => p[0] === x && p[1] === y && p[2] === z); if (i >= 0) v.splice(i, 1); v.push([x, y, z, m]); };
  // El cuerpo: 6 de ancho (x -3..2), 4 de hondo (y -2..1), hasta z 5, con las esquinas de arriba redondeadas
  for (let z = 0; z <= 5; z++) for (let y = -2; y <= 1; y++) for (let x = -3; x <= 2; x++) {
    if (z === 5 && (x === -3 || x === 2) && (y === -2 || y === 1)) continue;
    const seam = z === 0 || x === -3 || x === 2;                            // costura del fondo y de los lados
    put(x, y, z, `cuero:${seam ? 2 : (x + z) % 3 === 0 ? 4 : 3}`);
  }
  // La tapa de arriba, abombada
  for (let y = -1; y <= 1; y++) for (let x = -2; x <= 1; x++) put(x, y, 6, 'cuero:3');
  // La solapa, más oscura: por encima de la tapa y cayendo por delante (y -3) hasta z 3
  for (let x = -3; x <= 2; x++) {
    put(x, -2, 6, 'cuero:2');
    for (let z = 3; z <= 6; z++) put(x, -3, z, `cuero:${z === 3 ? 1 : 2}`);
  }
  // La hebilla, clara, en el borde de la solapa
  put(-1, -4, 3, 'hierro:3'); put(0, -4, 3, 'hierro:3'); put(-1, -4, 4, 'hierro:2'); put(0, -4, 4, 'hierro:3');
  // Las correas por delante, de la hebilla para abajo, y el bolsillo entre ellas
  for (let z = 0; z <= 2; z++) { put(-2, -3, z, 'cuero:1'); put(1, -3, z, 'cuero:1'); }
  for (let z = 0; z <= 1; z++) for (let x = -1; x <= 0; x++) put(x, -3, z, `cuero:${z === 1 ? 4 : 3}`);
  // El asa, arriba: un arco de cuero oscuro
  put(-1, 0, 7, 'cuero:1'); put(0, 0, 7, 'cuero:1'); put(-2, 0, 7, 'cuero:0'); put(1, 0, 7, 'cuero:0');
  vp.voxels(v);
  add('mochila');
}
(typeof window !== 'undefined' && window.__mochilaSolo !== false) ? ((vp) => {
  vp.newModel('mochila', 8, 8, 8);
  vp.palette([...MOCHILA_BASE, ...MOCHILA_RAMPS]);
  vp.newSet('mochila', 8);
  mochilaBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
  return vp.saveSet();
})(window.voxpix) : null
