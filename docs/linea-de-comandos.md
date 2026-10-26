# Línea de comandos

Para trabajar sin navegador (`src/cli/main.ts`). `sample` es la escena de muestra.

## Renderizar

    bun run voxpix render <modelo.json|sample> salida.png [--yaw 0] [--elev 30] [--scale 8] [--turn 8]
        [--size WxH] [--origin x,y] [--outline outer|both|none] [--bg #8a92a6]

- Sin `--size`, el encuadre se ajusta al modelo: 64x48 si cabe; si no, uno que lo contiene en cualquier giro.
- `--turn N` saca una tira con N ángulos.
- Comprueba que la imagen solo use colores de la paleta.

## Un mundo desde una receta

    bun run voxpix world <receta.json> <salida.png|-> [--at x,y] [--size 384x216] [--ticks 30] [--scale 1]
        [--whole] [--lights no] [--info info.json]

- La receta es un mundo en JSON (generador, semilla, colores, columnas, vegetación, modelos, luces, efectos). Con
  `"theme"`, se completa con un tema de muestra. Ver [api-mundos.md](api-mundos.md).
- Pinta en la CPU la vista centrada en `--at` (por defecto, la salida) tras `--ticks` pasos; `--whole`, el mundo entero.
- Escribe la información del mundo (tamaño, columnas, muebles, luces, rampas, huella) en la salida o en `--info`.

## pxl

[pxl](https://github.com/crsolver/claude-pxl) escribe arte de píxeles como código (`.px.js`); va en `vendor/pxl`.

    bun run voxpix export-pxl <modelo.json|sample> salida.px.js [--turn 8] [--name nombre]
    node vendor/pxl/bin/pxl.js build salida.px.js            # PNG por ángulo, hoja y JSON

    bun run voxpix export-pxl modelo.json salida.px.js --stack prefijo     # una capa por altura
    bun run voxpix import-pxl arte.px.js --stack prefijo modelo.json [--outline #rrggbb]
    bun run voxpix import-pxl arte.px.js <sprite|-> modelo.json [--plane front|top] [--z n]

- `import-pxl --stack` construye el modelo con las capas `<prefijo>_zNN`, vistas desde arriba y con el norte arriba.
  Así se puede escribir un modelo entero como código; `models/paisaje/medieval_capas.px.js` es un ejemplo de
  128 x 128.
- Con un sprite, lo pone como un plano de vóxeles, de frente o tumbado en la capa `--z`. Con `-`, solo trae la
  paleta.
- Directivas del `.px.js`: `// voxpix: outline #rrggbb` (el color del contorno) y
  `// voxpix: emissive <teclas de rampa>` (rampas que brillan solas).

## GIF de una vuelta

    bunx tsx --tsconfig tsconfig.runtime.json scripts/gif-rotacion.ts <modelo.voxpix.json|sample> salida.gif \
        [--cuadros 36] [--escala 3] [--elev 35] [--ms 80] [--luz] [--ambiente 0.35] [--contorno outer|both|none]

Con `--luz` lo ilumina con las fuentes del modelo, como la vista previa con *Iluminación*.

## Otros scripts

En `scripts/` hay herramientas de medida: el coste del horneado, del cuadro, del rehorneado y del agua
(`bake-world.ts`, `world-frame-cost.ts`, `rebake-cost.ts`, `water-cost.ts`...). También está `maia-walk.ts`, que
genera los cuadros de andar de MAIA en `models/maia/walk/`. Se corren con
`bunx tsx --tsconfig tsconfig.runtime.json scripts/<nombre>.ts`.
