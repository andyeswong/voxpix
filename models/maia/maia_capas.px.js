// MAIA v2 en vóxeles, capa por capa, para VoxPix (NARUTO, 2026-10-24).
//
// No se redibuja a MAIA: se le da volumen a su arte APROBADO (arte/aseprite-maia/v2_moonlighter, frente
// maia.png y espalda maia_espalda.png, 19x32). Cada capa z es un corte horizontal visto desde arriba
// (norte arriba = la espalda; abajo = el frente; pivote en el centro, columna 9 = x 0):
//   - el ancho de cada tramo sale de la fila del frente a esa altura;
//   - el fondo, de una tabla por parte del cuerpo (cabeza ~17 como la de Will, torso 9, piernas 5) con
//     forma de elipse, para que de lado sea redondo;
//   - la mitad delantera se pinta con el frente y la trasera con la espalda.
// El frente y la espalda salen fieles por construcción; el perfil y los giros salen del volumen.
//
// Importar en VoxPix: botón "pxl" -> "Capas maia_zNN", o  voxpix import-pxl maia_capas.px.js --stack maia maia.json

pal({
  1: "#1c1838", 2: "#2a2450", 3: "#3a3163", 4: "#55457e", 5: "#7a68aa",                     // pelo
  t: "#a2627f", N: "#c7889f", S: "#e2a9b4", s: "#f3cdc8", W: "#fde8e1",                     // piel
  k: "#241a44", J: "#2a1f4e", M: "#36296e", m: "#463690", Z: "#4c3a92", T: "#5a45a8", z: "#6a54bc", y: "#8c78d8",   // abrigo
  q: "#7d7296", U: "#b3a8c8", u: "#d9d0e6", A: "#6a4cc4", a: "#b47cff",                     // camisa y acento
  o: "#2a0f26", w: "#fff5ff", v: "#7a5bd6", V: "#a98cf0",                                   // ojos
  L: "#2e2440", l: "#4a3e62", K: "#2b1220", r: "#4a2433",                                   // piernas y botas
})
ramps("12345", "tNSsW", "kJMmZTzy", "qUu", "Ll", "Kr", "vV")

// Arte aprobado, fila 0 = coronilla, fila 31 = suela
const FRONT = [
  "......444333.......",   // 0
  "....4455544333.....",   // 1
  "...445555543333....",   // 2
  "..44555554433333...",   // 3
  "..445555444333332..",   // 4
  ".44455444333333222.",   // 5
  ".44434433333333222.",   // 6
  ".43334333333332222.",   // 7
  "4334433343333222222",   // 8
  "4334433343333222222",   // 9
  "4333433333332222222",   // 10
  "433S33SS333SS22S222",   // 11
  "433tSwooSsSsoowt222",   // 12
  "433tswooSssSoows222",   // 13
  "4332ssvVssssvVs2222",   // 14
  "3332tssssssssss2222",   // 15
  "332MakSssssssSaM222",   // 16
  ".3zMMkkkttttkkkMz2.",   // 17
  "..zzTTMkqqqqkMTTz..",   // 18
  ".JzyTTTukUUkuTTTyzJ",   // 19
  ".JzykTTuAuuAuTTkyzJ",   // 20
  ".zyzMmTTuaauTTmkzyz",   // 21
  ".zyzMmTTuAAuTTmMzyz",   // 22
  ".zzZMmTTuuuuTTmMZzz",   // 23
  ".JZklMmTuuuuTmMMkZJ",   // 24
  ".SkkllMmUUUUmMllkkS",   // 25
  ".SSS.llMLLLLMll.SSS",   // 26
  "..SS.llLllLlLll.SS.",   // 27
  ".....KLLK..KLLK....",   // 28
  ".....KKKK..KKKK....",   // 29
  "......rr....rr.....",   // 30
  "......KK....KK.....",   // 31
]
const BACK = [
  "......344332.......",   // 0
  "....4455443433.....",   // 1
  "...445554442332....",   // 2
  "..44555544343322...",   // 3
  "..44555443233222...",   // 4
  ".44554544333222222.",   // 5
  ".45544544333323222.",   // 6
  ".44445444333223222.",   // 7
  "4444444433433223222",   // 8
  "4444443433422223222",   // 9
  "4444333334333222221",   // 10
  "4444443334223222322",   // 11
  "4443343343322322322",   // 12
  "4433433333222322231",   // 13
  "4433433332222222221",   // 14
  "3222221121122222221",   // 15
  "2222211211122222221",   // 16
  "...yMMM22MMMMM3....",   // 17
  "..yyzzzzTTTTmmMJJ..",   // 18
  ".yzZzzzTTTTTmmMzZJ.",   // 19
  ".yzZzzTTTmmTTMMzZJ.",   // 20
  ".zyZTTTTmmTmmmmZzk.",   // 21
  ".yzzzzzTTmTTTmMzZJ.",   // 22
  ".yzZzTTzTTTmmMMzZJ.",   // 23
  ".kkkTTmTTmmmmMMkkJ.",   // 24
  ".ssS.TmmTmmmMMqSSS.",   // 25
  "..SS.qkmmmMMkqqSS..",   // 26
  ".....LLkkkkkLLL....",   // 27
  ".....LlLL..LlLL....",   // 28
  ".....LlLL..LlLL....",   // 29
  "......rr....rr.....",   // 30
  "......KK....KK.....",   // 31
]

const W = 19, H = 19, MID = 9, ROWS = 32

// Medio fondo (en vóxeles) de un tramo de la fila `row` de `len` píxeles de ancho
function halfDepth(row, len) {
  if (row <= 16) return Math.min(row >= 15 ? 7 : 8, Math.round(len * 0.44))   // cabeza: casi tan honda como ancha
  if (len <= 3) return 1                                                       // manos sueltas
  if (row <= 26) return 4                                                      // torso (y brazos pegados)
  return 2                                                                     // piernas y botas
}
// Melena: en las filas de la cara, los mechones de los lados nacen a media profundidad (detrás de la mejilla),
// no en la cara. De frente se ven igual (no hay nada delante de ellos) y de perfil asoma la cara delante del pelo.
const isHair = (ch) => ch >= "1" && ch <= "5"
const FACE_ROWS = [10, 16]   // de la frente a la mandíbula
const SIDE_HAIR_FROM = -1    // y donde empiezan los mechones de los lados

// Lateral de la cara (lo que solo se ve de perfil o en tres cuartos): piel por fila
const SIDE_SKIN = { 10: "S", 11: "S", 12: "s", 13: "s", 14: "s", 15: "S", 16: "t" }

// Color de un vóxel. El más delantero lleva el frente y el más trasero la espalda (así esas dos vistas quedan
// como el arte aprobado). Los del medio solo se ven de lado: pelo y ropa toman el tono de su columna del
// frente (sin costura entre frente y espalda), y el lateral de la cara, piel por fila.
function colorAt(row, x, yy, d) {
  const f = FRONT[row][x], b = BACK[row][W - 1 - x]
  if (yy <= -d) return f
  // Atrás manda la espalda, salvo en los lados del pelo: de perfil se verían más oscuros que el resto (costura)
  if (yy >= d && b !== "." && !(isHair(b) && Math.abs(x - MID) >= 6)) return b
  const faceSide = row >= FACE_ROWS[0] && row <= FACE_ROWS[1] && yy < SIDE_HAIR_FROM && !isHair(f)
  if (faceSide && SIDE_SKIN[row]) return SIDE_SKIN[row]
  return f
}

// Las botas van un vóxel hacia delante (la puntera)
const forward = (row) => (row >= 30 ? 1 : 0)

// Tramos opacos de una fila: [inicio, fin] inclusive
function runs(row) {
  const out = []
  let s = -1
  for (let x = 0; x <= W; x++) {
    const on = x < W && row[x] !== "."
    if (on && s < 0) s = x
    if (!on && s >= 0) { out.push([s, x - 1]); s = -1 }
  }
  return out
}

for (let row = 0; row < ROWS; row++) {
  const z = ROWS - 1 - row
  sprite(`maia_z${String(z).padStart(2, "0")}`, { w: W, h: H }, (c) => {
    const f = FRONT[row], b = BACK[row]
    for (const [s, e] of runs(f)) {
      const center = (s + e) / 2, rx = (e - s) / 2 + 0.5, ry = halfDepth(row, e - s + 1)
      for (let x = s; x <= e; x++) {
        const u = (x - center) / rx
        const d = Math.max(0, Math.round(ry * Math.sqrt(Math.max(0, 1 - u * u))))
        const sideLock = row >= FACE_ROWS[0] && row <= FACE_ROWS[1] && isHair(f[x]) && Math.abs(x - MID) >= 6
        for (let y = sideLock ? Math.max(-d, SIDE_HAIR_FROM) : -d; y <= d; y++) {
          const yy = y - forward(row)                       // y < 0 = hacia la cámara (frente)
          c.px(x, MID - yy, colorAt(row, x, y, d))
        }
      }
    }
  })
}
