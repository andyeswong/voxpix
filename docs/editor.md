# El editor

`npm run dev` y abre http://localhost:5190. La app arranca con la escena de muestra: un rincón medieval de 32 x 32
vóxeles con sus luces.

![El editor en 3D](img/editor-3d.png)

## La pantalla

- **Arriba a la izquierda:** el menú *Archivo* (nuevo, escena de muestra, abrir, guardar, importar de pxl) y el menú
  *Edición* (deshacer, rehacer, tamaño del lienzo).
- **Arriba en el centro:** cómo se edita, por *Capas* o en *3D* (Tab cambia de uno a otro).
- **Arriba a la derecha:** deshacer, rehacer y *Exportar*.
- **Izquierda:** las capas (cada altura z, con su miniatura y cuántos vóxeles tiene).
- **Derecha:** la vista previa, con su giro, elevación, contorno e iluminación, y los 8 ángulos debajo.
- **Abajo:** las herramientas, sus opciones y los tonos de la rampa elegida (▴ abre la paleta completa).
- **Abajo a la izquierda:** la celda bajo el ratón, cuántos vóxeles hay, lo que tardó el render y si se pinta en la
  GPU o en la CPU (un clic cambia de una a otra).

Las ventanas flotantes se arrastran por su cabecera y se apartan solas de los menús. Un doble clic en la cabecera
las devuelve a su sitio.

## Coordenadas

x va hacia el este, y hacia el norte y z hacia arriba. El pivote (los pies del modelo, la celda 0, 0, 0) está en el
centro del lienzo, y la capa 0 es el suelo. *Edición > Tamaño del lienzo* cambia el ancho, el fondo y las capas
(hasta 256). Si algo queda fuera, se puede recortar o conservar.

## Por capas y en 3D

- **Capas:** se pinta la capa z vista desde arriba, con el norte arriba y la capa de debajo en fantasma. La rueda o
  W/S cambian de capa. Clic izquierdo usa la herramienta; clic derecho borra.
- **3D:** se pinta sobre el modelo. El lápiz pone un vóxel en la cara que tocas, y las demás herramientas actúan
  sobre el vóxel que señalas. El botón derecho gira, el del medio mueve la vista y la rueda acerca. Un doble clic
  con el del medio la centra.

## Herramientas

| Herramienta | Tecla | Qué hace |
|---|---|---|
| Lápiz | B | Pinta con el material elegido. |
| Borrar | E | Quita vóxeles. |
| Repintar | P | Cambia el material de lo que ya hay. |
| Gotero | I | Copia el material de un vóxel. |
| Caja | R | En capas, arrastra un rectángulo (con el botón derecho, lo vacía). En 3D, una caja entre dos huecos, con las alturas entre los dos. |
| Cubo | G | Rellena la mancha contigua de la capa (o la vacía con el botón derecho). |
| Luz | L | Pone una fuente de luz en la celda, o la quita si ya hay una. El tipo se elige en sus opciones: antorcha, lámpara, brasero, neón rosa, neón cian o pantalla. |
| Fluido | F | Agua. *Verter*: cae mientras mantienes pulsado y se reparte. *Grifo*: un clic deja una fuente continua. *Llenar*: llena de una vez, hasta esa altura, todo lo conectado, como una cuenca. *Fijar* lo deja como vóxeles. |
| Espejo | M | Pinta también lo simétrico respecto al eje x que indiques. |

Ctrl+Z deshace y Ctrl+Y (o Ctrl+Mayús+Z) rehace. Cada trazo, caja, relleno o vertido es un solo paso.

## Paleta

El color no se elige suelto: se elige una **rampa** (un material, del oscuro al claro) y su tono base. El render
mueve el tono dentro de la rampa según la luz, así que la imagen solo tiene colores de la paleta. Ver
[El render](render.md).

## Vista previa e iluminación

La vista previa es el mismo render que se exporta. El encuadre es el de los sprites (64x48 con el pivote en 32,42)
si el modelo cabe; si no, uno que lo contiene en cualquier giro. Se mira igual que en 3D: botón derecho para girar,
el del medio para mover y la rueda para acercar.

Con *Iluminación*, las fuentes de luz del modelo alumbran cada cara de vóxel, con sombras de los propios vóxeles y
parpadeo, y *Ambiente* oscurece el resto. Poner una luz la enciende sola.

## Exportar

- **pxl: N ángulos:** un `.px.js` con un sprite por ángulo y una hoja. Se construye con
  `node vendor/pxl/bin/pxl.js build`.
- **pxl: capas:** el modelo como un sprite por altura (`<nombre>_zNN`). Se vuelve a importar igual.
- **Modelo (.voxpix.json):** el modelo con su paleta y sus luces.
- **PNG:** la vista o la hoja de ángulos, a x1, x2, x4 o x8, con fondo transparente. Con la iluminación encendida,
  sale iluminado.

## Importar de pxl

*Archivo > Importar de pxl* lee un `.px.js` con dos opciones:
- una pila de capas `<prefijo>_zNN` como modelo (así se pueden escribir modelos enteros como código);
- un sprite como plano de vóxeles, de frente o como una capa, para un modelo nuevo o para el actual.

Las directivas `// voxpix: outline #rrggbb` y `// voxpix: emissive <teclas de rampa>` del `.px.js` fijan el color
del contorno y las rampas que brillan solas.

## Render en la GPU

Con WebGL2, el render y la luz se calculan en la GPU (`src/view/gpu/voxrender.ts`) y dan los mismos píxeles que la
CPU. En un paisaje de 128 x 128, el render pasa de ~400 ms a ~5 ms. `?ruta=cpu` fuerza la CPU.
