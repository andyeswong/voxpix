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

Una rampa puede ser **follaje** (`"kind": "foliage"`: hierba, flores, hojas). Se ve igual que un sólido, pero:
- las luces lo atraviesan: cada vóxel de follaje deja pasar `FOLIAGE_T` (0,5) de la luz;
- sus caras reciben algo de luz por detrás (`FOLIAGE_BACKLIT`, 0,25);
- la sombra del sol sale moteada: cada celda deja pasar el sol por entre 1 y 4 hojas, según un hash entero de su
  posición, así la CPU y la GPU dan la misma sombra;
- en el mundo del juego, el agua no lo cuenta como fondo y se atraviesa andando (salvo con `"blocks": true`, los
  arbustos).

Un modelo sin rampas de follaje da exactamente la misma imagen que antes de que existiera (`test/vegetacion-mundo.test.ts`).

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
