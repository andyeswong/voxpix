// Un minero enano medieval, hecho solo con el editor (window.voxpix): se corre en la página del editor (consola o CDP)
// y devuelve el .voxpix.json (versión 3) con sus clips quieto, andar y atacar. Determinista.
// Caja en TODOS los cuadros de todos los clips: x -3..2, y -3..2, z 0..13 (6 x 6 x 14). Frente hacia -y, pies en z = 0.
// La paleta es la de la minera de un juego de bloques (8 rampas, el faro emisivo): el mismo formato para cambiar un
// fichero por otro.
(() => {
  const vp = window.voxpix;
  vp.newModel('enano', 12, 12, 16);
  vp.palette([
    { name: 'piel', colors: ['#7a4a34', '#a8684a', '#d08e68', '#ecb48c'] },
    { name: 'pelo', colors: ['#2a1810', '#43281a', '#5e3a24'] },
    { name: 'camisa', colors: ['#1e3a5a', '#2c5482', '#3f70a8', '#5a90c8'] },
    { name: 'pantalon', colors: ['#3a2e22', '#54432f', '#6e5a40'] },
    { name: 'botas', colors: ['#1c1410', '#2e221a', '#423226'] },
    { name: 'casco', colors: ['#7a5a10', '#b88a18', '#e8b830', '#f8d868'] },
    { name: 'faro', colors: ['#c8a040', '#ffe890', '#fffad0'], emissive: true },
    { name: 'ojos', colors: ['#101018', '#20202c'] },
  ]);
  const V = new Map();
  const put = (x, y, z, m) => V.set(`${x},${y},${z}`, [x, y, z, m]);
  const box = (x0, y0, z0, x1, y1, z1, m) => { for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(x, y, z, typeof m === 'function' ? m(x, y, z) : m); };
  // Piernas cortas: botas (z 0-1, la puntera más clara) y calzas (z 2-3)
  for (const [x0, x1] of [[-2, -1], [0, 1]]) {
    box(x0, -1, 0, x1, 0, 1, (x, y) => (y === -1 ? 'botas:2' : 'botas:1'));
    box(x0, -1, 2, x1, 0, 3, 'pantalon:1');
  }
  // Cinturón con hebilla, y la túnica (más clara de frente)
  box(-2, -1, 4, 1, 1, 4, 'botas:2');
  put(-1, -1, 4, 'casco:2'); put(0, -1, 4, 'casco:2');
  box(-2, -1, 5, 1, 1, 8, (x, y) => (y === -1 ? 'camisa:2' : 'camisa:1'));
  // Brazos (manga) y manos
  for (const x of [-3, 2]) { box(x, 0, 5, x, 0, 8, 'camisa:1'); put(x, 0, 4, 'piel:2'); }
  // Cabeza, pelo detrás
  box(-2, -1, 9, 1, 1, 12, 'piel:2');
  box(-2, 1, 9, 1, 1, 11, 'pelo:1');
  // Ojos bajo el ala, nariz delante
  put(-1, -1, 11, 'ojos:0'); put(0, -1, 11, 'ojos:0');
  put(-1, -2, 10, 'piel:3'); put(0, -2, 10, 'piel:3');
  // La barba: delante del pecho (y -2) de z 6 a 9, a los lados de la nariz, en las mejillas, y la punta en z 5
  box(-2, -2, 6, 1, -2, 9, (x, y, z) => ((x + z) % 3 === 0 ? 'pelo:2' : 'pelo:1'));
  put(-2, -2, 10, 'pelo:1'); put(1, -2, 10, 'pelo:1');
  put(-2, -1, 10, 'pelo:1'); put(1, -1, 10, 'pelo:1'); put(-2, -1, 9, 'pelo:1'); put(1, -1, 9, 'pelo:1');
  put(-1, -2, 5, 'pelo:1'); put(0, -2, 5, 'pelo:1');
  // El casco: el ala (z 12, una vuelta más ancha que la cabeza) y la cúpula (z 13), con el faro delante
  box(-3, -2, 12, 2, 2, 12, (x, y) => (x === -3 || x === 2 || y === -2 || y === 2 ? 'casco:1' : 'casco:2'));
  box(-2, -1, 13, 1, 1, 13, 'casco:3');
  put(-1, -2, 13, 'faro:1'); put(0, -2, 13, 'faro:2');
  // El pico a la espalda (y 2): el mango en diagonal y la cabeza de hierro arriba
  for (let k = 0; k <= 8; k++) put(-2 + Math.round((k * 3) / 8), 2, 3 + k, 'pantalon:2');
  for (const [x, z] of [[-2, 10], [-1, 11], [0, 11], [2, 11], [2, 10]]) put(x, 2, z, 'botas:2');
  put(1, 2, 12, 'botas:1');
  vp.voxels([...V.values()]);
  vp.frameMs(100);

  // Las partes: piernas (botas y calzas, por delante del pico), brazos (manga y mano)
  const R = { piel: 0, pelo: 1, camisa: 2, pantalon: 3, botas: 4 };
  const legs = [
    { name: 'L', boxes: [[-2, -3, 0, -1, 0, 3]], ramps: [R.botas, R.pantalon], pivotZ: 3, footZ: 0 },
    { name: 'R', boxes: [[0, -3, 0, 1, 0, 3]], ramps: [R.botas, R.pantalon], pivotZ: 3, footZ: 0 },
  ];
  const arms = [
    { name: 'brazoL', boxes: [[-3, -3, 4, -3, 1, 8]], ramps: [R.camisa, R.piel] },
    { name: 'brazoR', boxes: [[2, -3, 4, 2, 1, 8]], ramps: [R.camisa, R.piel] },
  ];
  const clip = (name, loop, rig) => {
    vp.clip(vp.clips()[0].name);
    vp.newClip(name, { loop });
    vp.rig(rig);
    vp.generateFromRig();
    vp.frame(0); vp.frameMs(100);
  };
  // quieto: el cuadro de reposo y los brazos un poco abajo (respira)
  vp.renameClip(vp.clips()[0].name, 'quieto');
  vp.loop(true);
  vp.rig({ frameMs: 400, parts: arms, frames: [{ moves: { brazoL: { dz: -1 }, brazoR: { dz: -1 } } }] });
  vp.generateFromRig();
  vp.frame(0); vp.frameMs(100);
  // andar: zancada, paso, la otra zancada, paso; los brazos al revés que las piernas. Sin subir el cuerpo (no pasa de 14)
  clip('andar', true, { frameMs: 110, parts: [...legs, ...arms], frames: [
    { moves: { L: { stride: 1 }, R: { stride: -1 }, brazoL: { dy: 1 }, brazoR: { dy: -1 } } },
    { moves: { R: { dz: 1 } } },
    { moves: { L: { stride: -1 }, R: { stride: 1 }, brazoL: { dy: -1 }, brazoR: { dy: 1 } } },
    { moves: { L: { dz: 1 } } },
  ] });
  // atacar: el brazo derecho sube y baja por delante (el golpe del pico), el cuerpo se inclina adelante
  clip('atacar', false, { frameMs: 90, parts: arms, frames: [
    { moves: { brazoR: { dz: 3, dy: 1 } } },
    { moves: { brazoR: { dz: 1, dy: -2 }, body: { dy: -1 } } },
    { moves: { brazoR: { dz: -1, dy: -3 }, body: { dy: -1 } } },
  ] });
  vp.clip('quieto');
  return vp.save();
})()
