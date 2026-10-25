# API para agentes: `window.voxpix`

VoxPix expone en `window.voxpix` lo mismo que hacen sus herramientas, sin ratón (`app/src/api.ts`). Un agente que
controla el navegador (CDP, Playwright, la consola) llama a esas funciones y ve el resultado en la app, igual que
una persona.

`voxpix.help()` devuelve la lista de funciones. Las reglas:

- Cada llamada que cambia el modelo es un paso de deshacer. `voxpix.batch(fn)` junta varias en un solo paso.
- Los errores salen como excepciones con un mensaje claro: «no hay rampa "x"; las rampas son: ...».

## Coordenadas y materiales

**Coordenadas:**
- x va hacia el este, y hacia el norte, z hacia arriba (z >= 0).
- El pivote (0, 0, 0) está en el centro del lienzo.
- En un lienzo de 128, x e y van de -64 a 63.

**Materiales**, en cualquiera de estas formas:
- un número (rampa*16 + tono + 1);
- `"nombre"`: la rampa con ese nombre, en tono 2 (o el del medio);
- `"nombre:tono"`;
- `[rampa, tono]`;
- `null` para dejar la celda vacía (borrar).

## Lo que hay

| Función | Qué hace |
|---|---|
| `newModel(name, w, d, h)`, `canvas(w, d, h, crop?)`, `palette([...])` | Crean el modelo, cambian el lienzo y cambian la paleta. |
| `set`, `voxels([[x, y, z, mat], ...])`, `box(x0, y0, z0, x1, y1, z1, mat)` | Pintan un vóxel, una lista o una caja (`null` la vacía). |
| `fill(x, y, z, mat)` | Es el Cubo: rellena la mancha contigua de la capa z. |
| `water(x, y, z, mat?)` | Llena de agua de una vez, hasta la altura z, todo lo conectado. Devuelve `{cells, spill}`; `spill` indica que el agua llegó al borde del lienzo. |
| `light(x, y, z, kind)`, `removeLight`, `lights()` | Ponen, quitan y listan las fuentes de luz. |
| `view({yaw, elevation, outline, lit, ambient})` | Ajusta la vista previa, que es también lo que sale en el PNG. |
| `png({sheet?, scale?})` | Devuelve el PNG en base64. Usa un encuadre que contiene el modelo entero y sale iluminado si `lit`. |
| `save()`, `load(json)`, `importPxl(source, prefijo?)` | Guardan y abren modelos; `importPxl` lee capas de pxl. |
| `info()`, `get(x, y, z)`, `undo()`, `redo()`, `tool(name)` | Consultan el modelo, deshacen y rehacen, y cambian la herramienta. |

## Ejemplo

`paisaje-medieval.js` hace el paisaje medieval de 128x128 (terreno, río, lago, castillo, casas, puente, 40 árboles
y 11 luces) solo con la API. Las ediciones tardan 0,08 s y el PNG iluminado 0,3 s.

Para evaluarlo desde WSL con el Edge de Windows:

    PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\browse.ps1' -Url 'http://<host>:5190/index.html' \
        -ExprFile 'C:\...\paisaje-medieval.js' -OutFile 'C:\...\salida.json' -Gpu < /dev/null

## Render en la GPU

La app pinta en la GPU (`src/view/gpu/voxrender.ts`) cuando hay WebGL2. La barra de estado dice GPU o CPU, y un clic
cambia de una a otra; `?ruta=cpu` fuerza la CPU.

Las dos rutas dan los mismos píxeles. `app/oraculo-render.html` lo comprueba con 5 modelos, 10 juegos de opciones de
render y la luz por píxel. El último resultado:
- 0 píxeles de color distintos;
- como mucho 1 píxel de vóxel distinto en 10.000;
- la luz con una diferencia máxima de 4·10⁻⁶.

En el paisaje, el render baja de ~400 ms a ~5 ms, y la luz con 11 fuentes de 2,7 s a pocos ms.
