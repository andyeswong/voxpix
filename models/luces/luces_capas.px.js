// La luz que lleva MAIA, una por mundo (FERN, 2026-10-25). Solo de aspecto: siempre equipada, fuera de la tienda y
// sin efecto en la simulación (MAIA). La luz en sí la pone el núcleo de NARUTO (luces que siguen a una entidad y
// focos de cono); esto es el objeto que se ve en la mano.
//   oficina    linterna: tubo de metal pizarra con la lente cian; foco hacia el frente
//   medieval   antorcha: palo de madera con la llama ámbar arriba; luz puntual
//   cyberpunk  linterna de neón: tubo de cromo con un aro rosa y la lente cian; foco hacia el frente
// El agarre (la mano) en el origen; la linterna apunta al frente (y negativo) y la antorcha sube en z.
// Importar: voxpix import-pxl luces_capas.px.js --stack linterna linterna.json (y antorcha, linterna-neon)

pal({
  D: "#1c1a2e", d: "#2b2a44", m: "#45475f", l: "#6e7591", h: "#a7afc6",       // metal pizarra
  c: "#1e7fa8", C: "#3ae0ff", i: "#c8f8ff",                                    // lente cian (luz propia)
  k: "#2a1810", w: "#6a4224", W: "#9a6a3a",                                    // madera
  a: "#a83a12", A: "#f08a30", U: "#ffd27a", F: "#fff6d8",                      // llama (luz propia)
  K: "#0e0c16", M: "#2e2c44", L: "#4a4868",                                    // cromo negro
  p: "#7a1f6a", P: "#ff3cc8",                                                  // aro de neón (luz propia)
})
ramps("Ddmlh", "cCi", "kwW", "aAUF", "KML", "pP")
// voxpix: outline #12101c
// voxpix: emissive cCi aAUF pP

const STACKS = {
  // Linterna: tubo de 3x3 a lo largo de y, de y = 1 (detrás de la mano) a y = -7 (la lente)
  linterna: (x, y, z) => {
    if (Math.abs(x) > 1 || z < 0 || z > 2 || y > 1 || y < -7) return null
    const edge = Math.abs(x) === 1 && (z === 0 || z === 2)
    if (edge) return null                                                   // esquinas fuera: tubo redondeado
    if (y === -7) return x === 0 && z === 1 ? "i" : "C"                      // la lente
    if (y === -6) return "h"                                                // el aro de la boca
    if (y === -2 && z === 2 && x === 0) return "C"                          // el botón
    return z === 2 ? "l" : z === 0 ? "D" : "m"
  },
  // Antorcha: palo de 1x1 de z 0 a 6 y la llama de z 7 a 10, ancha abajo y en punta arriba
  antorcha: (x, y, z) => {
    const r = Math.max(Math.abs(x), Math.abs(y))
    if (r === 0 && z >= 0 && z <= 5) return z >= 4 ? "W" : "w"
    if (z === 6 && r <= 1) return r === 0 ? "k" : "w"                       // el cuenco que sujeta la llama
    if (z === 7 && r <= 1) return r === 0 ? "U" : "A"
    if (z === 8 && r <= 1 && !(Math.abs(x) === 1 && Math.abs(y) === 1)) return r === 0 ? "F" : "A"
    if (z === 9 && r === 0) return "U"
    if (z === 10 && x === 0 && y === 1) return "a"                          // la punta, que se inclina hacia atrás
    return null
  },
  // Linterna de neón: como la de la oficina, de cromo y con un aro rosa de neón
  "linterna-neon": (x, y, z) => {
    if (Math.abs(x) > 1 || z < 0 || z > 2 || y > 1 || y < -7) return null
    const edge = Math.abs(x) === 1 && (z === 0 || z === 2)
    if (edge) return null
    if (y === -7) return x === 0 && z === 1 ? "i" : "C"
    if (y === -6 || y === -3) return "P"                                    // dos aros de neón
    return z === 2 ? "L" : z === 0 ? "K" : "M"
  },
}

for (const [id, voxel] of Object.entries(STACKS)) {
  for (let z = 0; z <= 10; z++) {
    sprite(`${id}_z${String(z).padStart(2, "0")}`, { w: 9, h: 13 }, (c) => {
      for (let y = -8; y <= 4; y++) for (let x = -4; x <= 4; x++) {
        const k = voxel(x, y, z)
        if (k) c.px(x + 4, 4 - y, k)
      }
    })
  }
}
