# El render

`render(model, options)` (`src/core/render.ts`) convierte un modelo de vóxeles en pixel art. Es determinista: el
mismo modelo con las mismas opciones da los mismos bytes. La GPU (`src/view/gpu/voxrender.ts`) da los mismos
píxeles; lo comprueba `app/oraculo-render.html`.

## El modelo

Un modelo es disperso: solo guarda los vóxeles llenos, con coordenadas enteras de -1023 a 1023 en cada eje.
x va hacia el este, y hacia el norte (lejos de la cámara en la vista frontal) y z hacia arriba. El pivote, los pies
del modelo, está en el origen.

## La paleta: rampas

Una paleta es una lista de **rampas** (hasta 64). Cada rampa es un material con sus tonos, de oscuro a claro (de 1
a 16), y puede ser emisiva (brilla sola: no la oscurece la luz del mundo). `src/core/color.ts` genera rampas desde un
color (`rampFromColor`, con giro de tono en OKLCH) y agrupa una lista de colores suelta en rampas (`groupIntoRamps`).

```json
{ "ramps": [ { "name": "piedra", "colors": ["#2e2f38", "#4a4c58", "#6c6f7c", "#9a9dab"] },
             { "name": "neón", "colors": ["#ff4fd8", "#ffb3f0"], "emissive": true } ],
  "outline": "#0d0c12" }
```

### Materiales

Cada rampa es un **material**: un juego de propiedades que el motor lee por separado (`src/core/materials.ts`). Nadie
pregunta "¿es follaje?": la luz pregunta cuánta luz deja pasar, el agua si es fondo y la colisión si bloquea. Un
material nuevo es una fila de datos en `MATERIALS`, no código nuevo en cada render.

| Propiedad | Qué hace | Sólido |
|---|---|---|
| `light` | cuánta luz deja pasar cada vóxel (0 = opaco) | 0 |
| `backlit` | luz que recibe una cara iluminada por detrás | 0 |
| `bed` | el agua lo cuenta como fondo y pared | sí |
| `blocks` | bloquea el paso (jugador, entidades, disparos) | sí |
| `emissive` | brilla solo | no |
| `reflect` | cuánto refleja (reservado: aún no lo pinta ningún render) | 0 |

| Material | Propiedades |
|---|---|
| `solido` | las del sólido (lo que es una rampa sin material) |
| `follaje` | `light` 0,5, `backlit` 0,25, ni fondo ni bloquea: hierba, flores, hojas |
| `arbusto` | como el follaje, pero bloquea el paso |
| `vidrio` | `light` 0,85: pasa la luz; es fondo para el agua y bloquea el paso |
| `metal` | `reflect` 0,6 (cuando haya reflejos) |

```json
{ "name": "vidrio", "colors": ["#24465a", "#3f7a96", "#7ab8d6"], "material": "vidrio" }
{ "name": "cristal-azul", "colors": ["..."], "material": "vidrio", "props": { "light": 0.6 } }
```

- Las luces cruzan lo que deja pasar luz multiplicando su `light`, en la CPU y en la GPU.
- La sombra del sol (sí o no) va en enteros para que la CPU y la GPU den lo mismo: cada vóxel gasta
  `round(-log2(light) * 4)` unidades del rayo y la celda queda en sombra al gastar un umbral de 4 a 16 que sale de un
  hash de su posición. Bajo una copa sale moteada.
- Las rampas viejas con `"kind": "foliage"` (y `"blocks": true`) son `follaje` (y `arbusto`).
- Una paleta sin materiales especiales da exactamente la misma imagen que antes de que existieran
  (`test/vegetacion-mundo.test.ts`, con las huellas del motor anterior).

Un vóxel guarda su material como un número: `rampa * 16 + tono + 1` (0 es vacío). La luz del render no multiplica
colores: **mueve el tono dentro de la rampa**. Por eso la imagen solo tiene colores de la paleta, y
`assertClosedPalette` lo comprueba.

## La cámara

- **Ortográfica** (por defecto): el modelo gira `yaw` grados sobre el eje vertical, alrededor del pivote, y la
  cámara mira hacia el norte, inclinada `elevation` grados. Un vóxel es un píxel.
- **Oblicua** (`oblique: { y, z }`), la del pixel art 3/4 de un juego: cada vóxel hacia el norte sube `y` píxeles y
  cada vóxel de altura sube `z`, sin acortar.
- `ppu` (píxeles por vóxel) amplía la imagen, como el zoom del editor.
- El pivote cae siempre en el mismo píxel (`originX`, `originY`): el personaje no salta al girar ni entre cuadros.

## El sombreado

- La luz tiene una dirección fija en la **pantalla** (arriba a la izquierda), así que al girar el modelo no gira con
  él. La sombra proyectada va en la misma dirección.
- La normal de cada cara se suaviza con el aire de alrededor (`smooth`, 0 = facetado).
- La oclusión ambiental (`ao`) baja un tono en los rincones.
- `thresholds` decide cuándo una cara sube un tono o baja uno.
- `flat: true` no mueve el tono: es para arte con el sombreado ya pintado.

## El contorno

`outline: 'outer'` pinta un borde alrededor de la silueta; `'both'` también marca los saltos de profundidad dentro;
`'none'` no pinta ninguno. El color es `outlineColor`, el `outline` de la paleta o el tono más oscuro de la rampa
vecina.

## La luz por cara (fuentes de luz)

`lightField3D(model, img, camera, lights, ambient)` (`src/core/light3d.ts`) calcula la luz de cada píxel de un
render hecho con `pick: true` (que guarda qué vóxel y qué cara se ve en cada píxel):

- cada fuente es una luz de punto en el espacio del modelo, con radio, color e intensidad, o un foco con cono;
- llega a cada cara según la distancia, `(1 - d/r)^2 * intensidad`, y su ángulo con la cara;
- se corta con un rayo por la rejilla de vóxeles (sombras de los propios vóxeles);
- donde no hay vóxel, alumbra el suelo (z = 0).

El resultado pasa por las capas MULTIPLY/ADD de `src/lighting/shade.ts`, cuantizadas como pixel art. Es lo que hacen
la vista previa con *Iluminación*, el PNG iluminado y `scripts/gif-rotacion.ts --luz`.

## El formato `.voxpix.json`

```json
{
  "format": "voxpix", "version": 1, "name": "torre",
  "palette": { "ramps": [ ... ] },
  "voxels": [[x, y, z, material], ...],
  "lights": [{ "id": "luz-1", "kind": "torch", "x": 4, "y": 1, "z": 6 }]
}
```

Los vóxeles van ordenados por coordenada: el mismo modelo da siempre el mismo texto. `lights` es opcional. Su
`kind` es uno de `src/lighting/lights.ts`: `torch`, `lamp`, `brazier`, `neon-pink`, `neon-cyan`, `lantern` o
`screen`.
