// Bloques de un mundo medieval, hechos solo con el editor (window.voxpix): menas de hierro y oro, adoquín, tablas,
// arena, mesa de trabajo, horno (apagado y encendido), cofre (cerrado y abierto), escalera y hueso. Cubos de 8 x 8 x 8
// (x e y de -4 a 3, z de 0 a 7; el frente mira a -y). Deterministas.
//   MEDIEVAL_RAMPS: las rampas que añaden (van AL FINAL de la paleta de un set que ya tenga las suyas). Usan además las
//   rampas 'piedra', 'carbon', 'palo' y 'llama' del set al que se añaden (o las de MEDIEVAL_BASE si se corre solo).
//   medievalBlocks(vp, add): pinta y añade los bloques en el set abierto.
//   - La escalera va pegada a la cara +y (norte) de su celda: el juego la pone girada (BlockGrid.set con yaw) hacia la
//     cara del bloque sólido en que se apoya. No es sólida (rampa 'palo', atravesable).
//   - El horno encendido lleva brasa emisiva en la boca; la luz que ponga (emits) la decide el juego.
//   - El hueso es pequeño y no es sólido (rampa 'hueso', atravesable): es algo que se recoge.
// Corrido solo (en la página del editor), crea un set "medieval" y devuelve su .voxset.json.
const MEDIEVAL_BASE = [
  { name: 'piedra', colors: ['#2a2b32', '#3e4049', '#565a64', '#727784', '#949aa6'] },
  { name: 'carbon', colors: ['#07070a', '#121216', '#1e1e26', '#3a3a48'] },
  { name: 'palo', colors: ['#3a2614', '#5a3c20', '#7a5430'], material: 'atravesable' },
  { name: 'llama', colors: ['#7a2a08', '#c85010', '#f08a20', '#ffc850', '#fff0b0'], emissive: true, material: 'atravesable' },
];
const MEDIEVAL_RAMPS = [
  { name: 'oxido', colors: ['#5a2a14', '#8a4220', '#b8602e', '#d88a50'] },
  { name: 'oro', colors: ['#7a5a10', '#b88a18', '#e8b830', '#f8e070'] },
  { name: 'arena', colors: ['#a08a5a', '#c0a872', '#d8c290', '#ece0b0'] },
  { name: 'tabla', colors: ['#4a3018', '#6a4626', '#8c6036', '#ad7c48', '#c89a62'] },
  { name: 'hierro', colors: ['#3a4048', '#565e68', '#76808c', '#9aa4b0'] },
  { name: 'hueso', colors: ['#8a8070', '#b8ae9a', '#ddd4c0', '#f4eee0'], material: 'atravesable' },
];
function medievalBlocks(vp, add) {
  const N = 8, LO = -4, HI = 3;
  const h = (x, y, z, s) => { let v = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1013904223) | 0; v = Math.imul(v ^ (v >>> 13), 1274126177); return ((v ^ (v >>> 16)) >>> 0) / 4294967296; };
  const tone = (x, y, z, s, lo, hi) => lo + Math.floor(h(x, y, z, s) * (hi - lo + 1));
  const cube = (paint) => { const v = []; for (let z = 0; z < N; z++) for (let y = LO; y <= HI; y++) for (let x = LO; x <= HI; x++) { const m = paint(x, y, z); if (m !== null) v.push([x, y, z, m]); } vp.voxels(v); };
  const stone = (x, y, z) => `piedra:${h(x, y, z, 4) < 0.08 ? 0 : tone(x, y, z, 5, 1, 3)}`;
  // Menas: manchas de 1-2 vóxeles alrededor de unos puntos, en la piedra
  const ore = (ramp, seeds, s, bright) => cube((x, y, z) => {
    for (const [cx, cy, cz] of seeds) {
      const d = Math.abs(x - cx) + Math.abs(y - cy) + Math.abs(z - cz);
      if (d <= 1 && h(x, y, z, s) < (d === 0 ? 1 : 0.6)) return `${ramp}:${h(x, y, z, s + 1) < bright ? 3 : tone(x, y, z, s + 2, 1, 2)}`;
    }
    return stone(x, y, z);
  });
  ore('oxido', [[-3, -3, 1], [1, -4, 5], [3, 1, 2], [-2, 3, 6], [0, 0, 7], [-4, 1, 3], [2, -2, 0]], 20, 0.15);
  add('mena_hierro');
  ore('oro', [[-2, -4, 2], [2, 3, 5], [3, -1, 6], [-4, 2, 1], [0, 1, 7]], 30, 0.4);
  add('mena_oro');
  // Adoquín: piedras de 4 x 4 en dos capas de 4 de alto, la de arriba corrida 2, con juntas de mortero oscuro
  const cobble = (x, y, z) => {
    const L = z >> 2, ox = (x + 4 + L * 2) & 3, oy = (y + 4 + L * 2) & 3;
    if ((z & 3) === 3 || ox === 3 || oy === 3) return 'piedra:0';
    const id = ((x + 4 + L * 2) >> 2) * 7 + ((y + 4 + L * 2) >> 2) * 3 + L;
    return `piedra:${1 + (id % 3)}`;
  };
  cube(cobble);
  add('adoquin');
  // Tablas: tablones a lo largo de x de 2 de alto, con la junta oscura abajo y clavos en los extremos
  const plank = (x, y, z) => {
    if ((z & 1) === 0) return (x === LO || x === HI) && y === LO ? 'tabla:0' : 'tabla:1';
    return `tabla:${2 + (((z >> 1) * 5 + (x > 0 ? 1 : 0)) % 3)}`;
  };
  cube(plank);
  add('tablas');
  cube((x, y, z) => `arena:${h(x, y, z, 40) < 0.1 ? 0 : tone(x, y, z, 41, 1, 3)}`);
  add('arena');
  // Mesa de trabajo: tablas con patas oscuras en las esquinas, la tapa con una rejilla de 3 x 3 y un martillo en el frente
  cube((x, y, z) => {
    const corner = (x === LO || x === HI) && (y === LO || y === HI);
    if (z === 7) {
      if (x === LO || x === HI || y === LO || y === HI) return 'tabla:1';
      return (x + 4) % 2 === 0 && (y + 4) % 2 === 0 ? 'tabla:4' : 'tabla:2';
    }
    if (corner) return 'tabla:0';
    if (y === LO && z >= 2 && z <= 5) {
      if (x === 0 && z <= 4) return 'palo:2';                                   // el mango
      if (z === 5 && x >= -1 && x <= 1) return 'hierro:2';                      // la cabeza
      return 'tabla:1';
    }
    return plank(x, y, z);
  });
  add('mesa');
  // Horno: de adoquín, con la boca en el frente (x -2..1, z 1..3, 2 de hondo) y el fondo oscuro; encendido, con brasa
  const furnace = (lit) => cube((x, y, z) => {
    const mouth = x >= -2 && x <= 1 && z >= 1 && z <= 3;
    if (mouth && y <= -3) {
      if (!lit) return null;
      if (z === 1) return `llama:${2 + ((x + y) & 1)}`;                         // la brasa en el suelo de la boca
      return y === -3 && z === 2 && (x === -1 || x === 0) ? 'llama:4' : null;
    }
    if (mouth && y === -2) return lit ? 'llama:1' : 'carbon:1';                 // el fondo
    if (y === LO && z === 4 && x >= -2 && x <= 1) return 'hierro:1';            // el dintel
    return cobble(x, y, z);
  });
  furnace(false);
  add('horno');
  furnace(true);
  add('horno_encendido');
  // Cofre: 6 x 6, tablas, con flejes de hierro, el borde de la tapa y la cerradura de oro; abierto, la tapa de pie atrás
  const chest = (open) => cube((x, y, z) => {
    if (x < -3 || x > 2 || y < -3 || y > 2) return y === -4 && x >= -1 && x <= 0 && (z === 3 || z === 4) && !open ? 'oro:2' : null;
    const band = x === -3 || x === 2;
    if (z <= 3) {
      if (open && z >= 1 && x > -3 && x < 2 && y > -3 && y < 2) return z === 1 ? 'tabla:0' : null;   // por dentro
      if (z === 3) return 'hierro:1';
      return band ? 'hierro:2' : `tabla:${2 + ((y + 4) & 1)}`;
    }
    if (!open) return z <= 5 ? (band ? 'hierro:2' : z === 5 ? 'tabla:3' : 'tabla:2') : null;
    if (y === 2 && z <= 7) return band ? 'hierro:2' : 'tabla:2';                // la tapa abierta, de pie
    return null;
  });
  chest(false);
  add('cofre');
  chest(true);
  add('cofre_abierto');
  // Escalera: dos largueros y peldaños cada 2, pegada a la cara +y
  cube((x, y, z) => {
    if (y !== HI) return null;
    if (x === -3 || x === 2) return `palo:${z === 7 ? 2 : 1}`;
    return z % 2 === 1 && x > -3 && x < 2 ? 'palo:2' : null;
  });
  add('escalera');
  // Hueso: tumbado en el suelo, con sus dos cabezas
  vp.voxels([
    ...[-2, -1, 0, 1].map((x) => [x, 0, 0, 'hueso:2']),
    [-3, -1, 0, 'hueso:3'], [-3, 1, 0, 'hueso:3'], [-3, 0, 0, 'hueso:1'], [-3, 0, 1, 'hueso:2'],
    [2, -1, 0, 'hueso:3'], [2, 1, 0, 'hueso:3'], [2, 0, 0, 'hueso:1'], [2, 0, 1, 'hueso:2'],
  ]);
  add('hueso');
}
(typeof window !== 'undefined' && window.__medievalSolo !== false) ? ((vp) => {
  vp.newModel('medieval', 8, 8, 8);
  vp.palette([...MEDIEVAL_BASE, ...MEDIEVAL_RAMPS]);
  vp.newSet('medieval', 8);
  medievalBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
  return vp.saveSet();
})(window.voxpix) : null
