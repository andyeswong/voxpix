// Example of the editor API (window.voxpix): makes models/corazones/corazones.voxset.json.
// How to regenerate it: models/README.md.
// Corazones de vida (para la barra de vida de un juego), hechos solo con el editor (window.voxpix): lleno, medio y
// vacío. Cada uno en un cubo de 8 x 8 x 8 de un set (x e y de -4 a 3, z de 0 a 7; el frente mira a -y), así su icono
// sale con iconSheet como el de un bloque. No son para ponerlos en el mundo. Deterministas.
//   CORAZONES_RAMPS: las rampas que añaden, 'corazon' (rojo) y 'hueco' (el oscuro de dentro del vacío); van AL FINAL de
//   la paleta de un set que ya tenga las suyas.
//   corazonesBlocks(vp, add): pinta y añade 'corazon_lleno', 'corazon_medio' y 'corazon_vacio' en el set abierto.
// Hechos como la mochila v3 (docs/runbooks/diseno-para-16-px.md): una losa de 2 de hondo (la cara de arriba casi no
// sale), la silueta de corazón de 6 x 5 en el plano del frente, nada que sobresalga. 6 de ancho para que con el
// contorno quepa en 8 px. Para la barra de vida se miran de frente: iconSheet con { yaw: 0, elevation: 20, cell: 8 }
// (y scale: 2 para 16 px); con el ángulo de la barra de objetos (yaw -30) el corazón sale torcido y no cabe en 8. El lleno es rojo con un brillo
// arriba a la izquierda; el medio, rojo a la izquierda y el hueco oscuro a la derecha; el vacío, todo hueco (el contorno
// del set lo dibuja). El render baja un tono el frente y sube uno la cara de arriba: los tonos están puestos para lo que
// se ve.
// Corrido solo (en la página del editor), crea un set "corazones" y devuelve su .voxset.json.
const CORAZONES_RAMPS = [
  { name: 'corazon', colors: ['#3c0610', '#6e0c18', '#a0141e', '#d02028', '#f04a4a', '#ff9a8a', '#ffe0d8'] },
  { name: 'hueco', colors: ['#120c14', '#22161e', '#34222a'] },
];
// La silueta (de arriba abajo, z 5..1): x de -3 a 2
const CORAZON_FILAS = ['##..##', '######', '######', '.####.', '..##..'];
function corazonesBlocks(vp, add) {
  const heart = (paint) => {
    const v = [];
    CORAZON_FILAS.forEach((row, k) => {
      const z = 5 - k;
      for (let i = 0; i < 6; i++) {
        if (row[i] !== '#') continue;
        const x = i - 3;
        for (const y of [-1, 0]) { const m = paint(x, y, z); if (m) v.push([x, y, z, m]); }
      }
    });
    vp.voxels(v);
  };
  // Rojo: el frente en el 4 (se ve en el 3), la tapa en el 2 (se ve en el 3), y el brillo arriba a la izquierda (el
  // lóbulo izquierdo y lo de debajo)
  const red = (x, y, z) => {
    if (y === -1 && ((z === 5 && x <= -2) || (z === 4 && x <= -2))) return 'corazon:6';
    return y === -1 ? 'corazon:4' : 'corazon:2';
  };
  const hollow = (x, y) => (y === -1 ? 'hueco:1' : 'hueco:0');
  heart(red);
  add('corazon_lleno');
  heart((x, y, z) => (x < 0 ? red(x, y, z) : hollow(x, y)));
  add('corazon_medio');
  heart(hollow);
  add('corazon_vacio');
}
(typeof window !== 'undefined' && window.__corazonesSolo !== false) ? ((vp) => {
  vp.newModel('corazones', 8, 8, 8);
  vp.palette(CORAZONES_RAMPS);
  vp.newSet('corazones', 8);
  corazonesBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
  return vp.saveSet();
})(window.voxpix) : null
