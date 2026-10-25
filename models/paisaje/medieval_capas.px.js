// Paisaje medieval de 128 x 128 para VoxPix, capa por capa (NARUTO, 2026-10-25). Lo genera este mismo código:
// colinas de hierba con tierra y roca debajo, un río serpenteante y un lago excavados (vacíos: el agua se echa en la
// app con la herramienta Fluido), arena en las orillas, un camino de tierra, un castillo en la colina (torre del
// homenaje, muralla y puerta), casas con tejado rojo, un puente de madera y árboles.
// Importar en VoxPix: Archivo > Importar de pxl > "Modelo desde paisaje_zNN".

pal({
  1: "#2d4a2a", 2: "#3f6b33", 3: "#5a8a3c", 4: "#7fae4f",           // hierba
  5: "#3b2a1e", 6: "#5a3e28", 7: "#7a5636", 8: "#9c7146",           // tierra
  a: "#2e2f38", b: "#4a4c58", c: "#6c6f7c", d: "#9a9dab",           // piedra
  e: "#2b1b12", f: "#4a2f1d", g: "#6e4729", h: "#94643a",           // madera
  i: "#16324d", j: "#1f4f78", k: "#2f74a6", l: "#5fa8d6",           // agua
  m: "#1f3a22", n: "#2f5a2f", o: "#46803c", p: "#6aa64f",           // hojas
  q: "#4a1c1c", r: "#6e2a24", s: "#93402f", t: "#b85a3c",           // tejado
  u: "#6b5a3a", v: "#8c7650", w: "#ad9466", x: "#cdb581",           // arena
})
ramps("1234", "5678", "abcd", "efgh", "ijkl", "mnop", "qrst", "uvwx")

const N = 128, H = 30, HALF = N / 2

// Azar con semilla (mulberry32): el mismo paisaje cada vez
let seed = 1977
function rnd() { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

// Ejes del modelo: x de -64 a 63 (este), y de -64 a 63 (norte); la imagen de cada capa tiene el norte arriba
const vox = new Map()            // "x,y,z" -> tecla
const put = (x, y, z, k) => { if (x >= -HALF && x < HALF && y >= -HALF && y < HALF && z >= 0 && z < H) vox.set(x + "," + y + "," + z, k) }
const get = (x, y, z) => vox.get(x + "," + y + "," + z)

// ---- terreno: colinas suaves, más alto al noroeste (donde va el castillo)
const riverX = (y) => 18 + 14 * Math.sin(y / 17) + 5 * Math.sin(y / 7.3)
const lake = { x: -30, y: -34, r: 13 }
function ground(x, y) {
  let h = 5 + 2.2 * Math.sin(x / 13) * Math.cos(y / 11) + 1.6 * Math.sin((x + y) / 9) + 0.8 * Math.cos(x / 5.1 - y / 6.7)
  const cd = Math.hypot(x + 34, y - 30)                           // colina del castillo
  h += Math.max(0, 7 - cd / 3.2)
  return Math.round(Math.max(2, h))
}
const heights = []
for (let y = -HALF; y < HALF; y++) for (let x = -HALF; x < HALF; x++) {
  let h = ground(x, y)
  const dr = Math.abs(x - riverX(y))                             // cauce: hasta z 1, con taludes
  if (dr < 3.5) h = Math.min(h, 1); else if (dr < 5.5) h = Math.min(h, 2)
  const dl = Math.hypot(x - lake.x, y - lake.y)                  // lago
  if (dl < lake.r) h = Math.min(h, 1); else if (dl < lake.r + 2) h = Math.min(h, 2)
  heights[(y + HALF) * N + x + HALF] = h
  const shore = dr < 7.5 || dl < lake.r + 4
  for (let z = 0; z <= h; z++) {
    const top = z === h
    let k
    if (z < h - 3) k = "b"                                       // roca
    else if (!top) k = z === h - 1 ? "7" : "6"                   // tierra
    else if (shore) k = h <= 2 ? "v" : "w"                       // arena
    else k = h >= 9 ? "4" : h >= 6 ? "3" : "2"                   // hierba, más clara arriba
    put(x, y, z, k)
  }
}
const hAt = (x, y) => heights[(Math.round(y) + HALF) * N + Math.round(x) + HALF] ?? 0

// ---- camino de tierra: de la puerta del castillo al puente
for (let t = 0; t <= 1; t += 0.004) {
  const x = Math.round(-34 + (riverX(8) - 4 + 34) * t), y = Math.round(18 - 10 * t + 3 * Math.sin(t * 6))
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const h = hAt(x + dx, y + dy); if (h > 2) put(x + dx, y + dy, h, (dx + dy) % 2 ? "7" : "8") }
}

// ---- castillo en la colina: muralla de 30 x 30 (6 de alto, almenas), torre del homenaje de 10 x 10 (16 de alto)
const cx = -34, cy = 30, base = hAt(cx, cy)
for (let x = cx - 15; x <= cx + 15; x++) for (let y = cy - 15; y <= cy + 15; y++) {
  const edge = x <= cx - 14 || x >= cx + 14 || y <= cy - 14 || y >= cy + 14
  if (!edge) continue
  const gate = y <= cy - 14 && Math.abs(x - cx) <= 2           // puerta al sur
  const g0 = hAt(x, y)
  for (let z = g0 + 1; z <= base + 6; z++) if (!(gate && z <= base + 4)) put(x, y, z, z % 2 ? "c" : "b")
  if ((x + y) % 2 === 0) put(x, y, base + 7, "d")                // almenas
}
for (let x = cx - 5; x <= cx + 4; x++) for (let y = cy - 5; y <= cy + 4; y++) {
  const wall = x === cx - 5 || x === cx + 4 || y === cy - 5 || y === cy + 4
  for (let z = base + 1; z <= base + 16; z++) if (wall || z === base + 16) put(x, y, z, (x + y + z) % 5 ? "c" : "b")
  if (wall && (x + y) % 2 === 0) put(x, y, base + 17, "d")
}
for (let z = base + 9; z <= base + 11; z++) { put(cx - 1, cy - 5, z, "a"); put(cx, cy - 5, z, "a") }   // ventana

// ---- casas: base de madera y tejado rojo a dos aguas
function house(hx, hy) {
  const g = Math.max(hAt(hx, hy), 3)
  for (let x = hx - 4; x <= hx + 4; x++) for (let y = hy - 3; y <= hy + 3; y++) {
    for (let z = hAt(x, y) + 1; z <= g + 4; z++) if (x === hx - 4 || x === hx + 4 || y === hy - 3 || y === hy + 3) put(x, y, z, (x + z) % 3 ? "g" : "f")
    const roof = g + 5 + Math.min(y - (hy - 4), hy + 4 - y)       // a dos aguas, con la cumbrera de este a oeste
    if (roof <= g + 8) put(x, y, roof, (y + x) % 2 ? "s" : "r")
  }
  put(hx, hy - 3, g + 1, "e"); put(hx, hy - 3, g + 2, "e")         // puerta
}
for (const [x, y] of [[-6, 8], [4, -4], [-12, -10], [44, 22], [48, 0]]) house(x, y)

// ---- puente de madera sobre el río
const by = 8, bx = Math.round(riverX(by))
for (let x = bx - 7; x <= bx + 7; x++) for (let y = by - 2; y <= by + 2; y++) put(x, y, 3, Math.abs(y - by) === 2 ? "f" : "h")

// ---- árboles: tronco y copa redonda
let trees = 0
while (trees < 40) {
  const x = Math.round(rnd() * 120 - 60), y = Math.round(rnd() * 120 - 60)
  if (Math.abs(x - riverX(y)) < 9 || Math.hypot(x - lake.x, y - lake.y) < lake.r + 5 || Math.hypot(x - cx, y - cy) < 22) continue
  if ([[-6, 8], [4, -4], [-12, -10], [44, 22], [48, 0]].some(([a, b]) => Math.hypot(x - a, y - b) < 9)) continue
  const g = hAt(x, y), th = 3 + Math.floor(rnd() * 3), r = 2.5 + rnd() * 1.5
  for (let z = g + 1; z <= g + th; z++) put(x, y, z, "f")
  for (let dx = -4; dx <= 4; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -3; dz <= 4; dz++) {
    if (dx * dx + dy * dy + (dz * 1.3) ** 2 > r * r) continue
    put(x + dx, y + dy, g + th + 2 + dz, dz > 1 ? "p" : dz > -1 ? "o" : "n")
  }
  trees++
}

// ---- una capa por altura: paisaje_z00 ... paisaje_zNN
for (let z = 0; z < H; z++) {
  sprite(`paisaje_z${String(z).padStart(2, "0")}`, { w: N, h: N }, (cv) => {
    for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
      const k = get(px - HALF, HALF - 1 - py, z)
      if (k) cv.px(px, py, k)
    }
  })
}
