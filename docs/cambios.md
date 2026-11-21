# Cambios

## Notas de versión de trozos-z (de ae36cb1 a cc1dc6f)

Lo que llega a master con trozos-z, por tema: una línea por commit, con sus números. Las medidas son sin freno salvo que
se diga; "a 6x" es en Edge con la CPU frenada 6 veces. El detalle de cada tema está más abajo y en
[motor.md](motor.md).

### La cola con plazo y las máscaras de lo expuesto
- `cf66d5b`: las luces cerca del jugador van con el presupuesto cercano. Una antorcha nueva alumbra en 4 cuadros a 6x
  en vez de 9, y las luces de un corte acaban en 24-29 cuadros en vez de 39-44.
- `7ac463c`: esa prioridad, solo para lo que cambia el mundo, no para lo que toca un corte de vista. En una noche con
  antorchas, los cuadros de más de 25 ms a 6x bajan de 8-34 a 6-7 por tirada.
- `d6070c5`: lo expuesto se guarda por losa, y las franjas lo preparan dentro de su plazo. La llamada de recuadro del
  corte con contorno pasa de p50 8,6 / p95 15,5 / máx 29 a 6 / 12 / ~21 ms a 6x.
- `16071a8`: el horneado inicial recorre sin máscaras: ~1.500-2.000 ms a 6x en vez de ~2.650.
- `42213ab`: las máscaras las prepara después un trabajo de la cola (`exposure`), detrás de todo.
- `946eb39`: si preparar las máscaras no acaba, falla con un error en vez de colgarse.
- `7bd497e`: un trabajo saltado 4 cuadros seguidos por no caber va el primero de su fase; ya no se queda sin correr.
- `ca195d7`: la fase normal se lleva lo que sobra del presupuesto cercano.
- `64a46ba`: con un tope (`spare`, por defecto `ms`). Preparar lo expuesto tarda 80 cuadros en el banco en vez de 160,
  sin los 28-43 cuadros de más de 25 ms de la noche que daba el sobrante entero.
- `b9fb522`: docs, por qué el trabajo de las máscaras corría con ~1,8 ms por cuadro en un juego.

### Cortar la vista, moverse por niveles, iconos y contexto de la GPU
- `db2f9a6`: el corte de vista admite varias cajas, cada una con su `zTop` (el corte de casa de muñecas).
- `875e154`: `moveBodyLevels` recuerda el suelo de cada columna y el último apoyo en cada llamada: ~3,3 → ~2,6 µs.
- `e363680`: `iconSheet` / `modelIcon` con `outlineColor`, el contorno fijo del mundo.
- `aed3adc`: al recuperar el contexto de WebGL se repite lo precalentado: 64 sprites en el atlas en vez de 41.

### Girar la cámara (preparar un giro)
- `8984cf6`: la copia girada va por losas (`copyRotatedSlabs`): de 0,7-1,1 s a 14-27 ms en 384 x 384 x 96. El
  horneado por pasos va por baldosas cortadas por el plazo: de 0,9-1,3 s a 0,41-0,64 s. Arregla un fallo de
  `StaticVoxels.write` (seguía escribiendo en la paleta vieja tras `repack`).
- `9c77103`: las baldosas se estiman por sus caras al aire y el cielo por sus píxeles con algo. Con llamadas de
  0,5 ms, el p95 pasa de 0,95-1,02 a 0,57-0,69 ms, y la más larga, de 2,8-15,9 a 1,9-3,1 ms. Los picos de 20-46 ms no
  eran el recolector: eran tandas del cielo.
- `90c0d45`: `bench-giro` da también el ruido de la máquina (un cálculo fijo de la misma mediana), para juzgar contra
  él.
- `7d8e2d6`: `render()` ya no crea memoria por cada cara; mismo resultado byte a byte. El horneado de una vez pasa de
  0,32-0,6 a 0,2-0,42 s, y frente al ruido pasan 8 de 12 corridas en vez de 1 de 6.
- `e620a70`: docs, la puerta relativa al ruido se juzga sin la primera corrida del proceso.

### El cuadro: niebla, fondo transparente y la GPU
- `8b490bb`: niebla por altura (`Frame2DOptions.fog`), en la CPU y en la GPU, con la mezcla en pasos de 1/256. Cuesta
  ~1,2 ms a 6x en la CPU y no se nota en la GPU.
- `c1f1e40`: `background: 'transparent'`, alfa 0 donde no hay nada, para pintar el cielo detrás del lienzo. El oráculo
  compara también el alfa.
- `9db614f`: las subidas parciales de los pesos de luz eran inválidas en Chromium (faltaba `UNPACK_IMAGE_HEIGHT`) y la
  GPU se quedaba con la luz vieja tras picar junto a una luz. Además, una entidad con un modelo sin vóxeles ya no rompe
  el cuadro. El oráculo falla con cualquier error de WebGL.
- `49967d5`: la escena del oráculo con la entidad de modelo vacío, junto al jugador y dando sombra.

### Mapa por semilla y agua en un mundo alto
- `3839b11`: `generateMap` genera relieve, estratos, lagos con orilla, vetas, cuevas y lo sembrado; además
  `applyMap`, `mapColumn` y `mapHash`. En 384 x 384 x 96, generarlo cuesta ~1-2,5 ms y escribirlo, ~0,21 s.
- `cc1dc6f`: el agua por columnas en un mundo alto:
  - `wallAbove`;
  - un tramo de alturas que se ensancha a las cuencas, en la CPU y en la GPU;
  - `waterTop` en `Int16Array`;
  - `follow`, que sigue lo picado y lo puesto;
  - el corte, que esconde el agua de encima;
  - `mapWater`.

  Las escenas de agua de antes, iguales. A 6x, el paso del agua cuesta p50 0,6 / p95 ~4,5 ms con pisotones, y la GPU,
  +0,3-0,5 ms por cuadro.

### Ejemplos hechos solo con el editor
- `977f717`: un minero enano: 6 x 6 x 14, clips quieto, andar y atacar.
- `be1a8f3`: su variante B, con casco de hierro de una capa (6 x 6 x 13).
- `dcc2f42`: tres flores como bloques que se cruzan y dejan pasar la luz (material `follaje`).
- `8a0d3d7`: bloques medievales: menas, adoquín, tablas, arena, mesa, horno apagado y encendido, cofre cerrado y
  abierto, escalera y hueso.
- `1e2db37`: un error de tipos de su prueba.
- `d62d24b`: objetos de mano (picos, espadas, palo y lingotes), con su agarre.
- `05b8f17`: restaura `test/objetos.test.ts`, que `d62d24b` había sobrescrito; la prueba nueva va en
  `test/objetos-mano.test.ts`.
- Después de cc1dc6f: `cba1d2b` una mochila de cuero para un icono de inventario, y `31fa8c0` rehecha para leerse a
  16 px (bloques de color grandes, sin salientes).
- Todos los ejemplos, documentados en [models/README.md](../models/README.md): qué es cada uno, qué enseña de la API,
  su tamaño, el script o el fichero de capas que lo genera y la orden para regenerarlo y comprobar que sale igual byte a
  byte (comprobado el 2026-11-16: todos salen idénticos). Cada script de ejemplo lo dice en su cabecera. El paisaje
  (`models/paisaje/medieval_capas.px.js`) no se importaba desde que `import-pxl` trae el global `vox`: declaraba su
  propio `vox`; ahora se llama `cells`, y vuelve a dar sus 102.776 vóxeles.

Al final: 531 pruebas y 79 escenas del oráculo (CPU = GPU), todas en verde.

## Mundos de bloques, picar en partida y caminos por niveles

Desde `ff1bd2d` ("moveBody path without boxed doubles"). Es lo que hace falta para un juego de bloques en la vista
2.5D: un mundo grande que se pica y se construye mientras se juega, sin parar el cuadro. Todo es genérico y está en
[motor.md](motor.md) (o en [editor.md](editor.md) y [api-agentes.md](api-agentes.md) para el editor). Las medidas son
sin navegador ni freno de CPU salvo que se diga; en el navegador con la CPU frenada a 6x, todo sube varias veces, y la
medida que vale para un juego es la suya.

### Vóxeles por losas y rehorneado por caja

- `StaticVoxels` guarda trozos de 16 x 16 partidos en losas de 16 de alto: vacías, de un solo valor, de 1 byte (con su
  paleta de hasta 256 valores) o de 2 bytes. Un terreno de bloques de 384 x 384 x 96 ocupa ~6 MB.
  Ver [Los vóxeles del mundo](motor.md#los-vóxeles-del-mundo-memoria-y-cambios).
- Cada cambio guarda su caja (`changedBox`), y `rebakeChangedJobs` rehace solo esa caja y las luces que la alcanzan. El
  resultado es el mismo, byte a byte, que hornear el mundo entero.
- Picar un bloque en 384 x 384 x 96 con 30 antorchas: total p50 ~7-9 ms y p95 ~9-12 ms, repartido por la cola. Ver
  [Rehornear lo que cambió](motor.md#rehornear-lo-que-cambió).

### Luces fijas en partida

- `LightList.addFixed` / `removeFixed`: luces que se hornean al ponerlas (una antorcha colocada) y se deshornean al
  quitarlas. Ver [Luces](motor.md#luces).
- La GPU elige qué luces sube según lo que se ve.
- Las luces rehacen por pasos solo los píxeles que cambiaron y los que miran a la luz a través de lo cambiado (la
  sombra de cada caja en pantalla). Los pesos nuevos se publican de una vez al acabar.

### La cola con plazo (`FrameBudget`)

- Hay un presupuesto aparte para lo cercano (`near`): el bloque picado se ve en el cuadro siguiente.
- La cola aprende lo que cuesta cada clase de llamada (recuadro, luz, cielo, corte), con la primera llamada de cada
  trabajo aparte, y no empieza una llamada que no cabe.
- Recorrer lo que se ve: `forEachExposed` ya no da los vóxeles enterrados de las losas a medio llenar, y guarda por
  losa qué vóxeles tienen cara al aire. En el corte de casa de muñecas con contorno, la llamada de recuadro baja de
  p50 8,6 / p95 15,5 / máx 29 a 6 / 12 / ~21 ms a 6x. El máximo sigue por encima de 8. No es el recolector de basura
  (traza de V8 en Edge: 7 de 312 llamadas lentas tienen una pausa dentro, y ninguna bajaría de 8 sin ella): es
  cálculo. Tolerancia conocida. El horneado inicial recorre sin máscaras: hacerlas para todo el mundo de una vez le
  subía el render de ~1.530 a ~2.650 ms a 6x en un juego (medido por FERN); sin ellas, en Edge a 6x, ~1.500-2.000.
  Las máscaras las prepara después un trabajo de la cola, detrás de todo (lo devuelve la primera
  `rebakeChangedJobs`): sin él, las franjas de los primeros cortes las hacían dentro de su plazo.
- Las luces cerca del jugador que cambian por el mundo también van con el presupuesto cercano (una antorcha recién
  puesta alumbra en menos de la mitad de cuadros), sin adelantarse a sus recuadros. Las que solo toca un corte de
  vista, no: si no, en una noche con antorchas cada corte les cedía el cercano (en el juego, 8-34 cuadros de más de
  25 ms por tirada contra 6-7).
- Lo que sobra del presupuesto cercano, si no queda nada cercano, se lo lleva lo demás hasta `spare` (por defecto,
  `ms`). Preparar lo expuesto tras el horneado acababa a los 20-25 s en un juego, después de los primeros cortes; con el
  sobrante entero acababa antes del primer corte, pero los cuadros de más de 25 ms en la noche pasaban de 8-10 a 28-43
  (lo que sobra era el margen del juego para sus picos). Con el tope: en el banco, 80 cuadros en vez de 160. En ese
  juego el trabajo corría solo en la fase normal, pero con ~1,8 ms por cuadro y no 3: el juego llama a
  `budget.run(ticksMs)` y los ticks del cuadro se descuentan de esa fase (`spentMs`). El sobrante no se descuenta, así
  que con el tope lleva ~4,8 ms.
- Un trabajo que no cabe y lleva 4 cuadros seguidos saltado va el primero de su fase: antes podía quedarse sin correr
  nunca si delante siempre corría algo antes.
- Lo probado con un reloj de mentira desde el primer cuadro: ningún `run()` pasa de `near.ms + ms`, y el resultado es
  el mismo que sin plazo.
- Las luces respetan su plazo: sombras por caja, un reloj cada 4 píxeles y tablas de tamaño fijo, sin `Map` ni `Set`
  que crezcan.
- Medido en un juego de bloques en el navegador (un túnel; caja de corte de 32 x 32 movida a saltos de 16; 8 eventos x
  3 tiradas, sin antorchas y con 2):

  | | A 1x | A 6x |
  |---|---|---|
  | Cuadros de más de 16,8 ms | - | ninguno |
  | Lo cortado aparece | p50 4, máx 6-7 cuadros | ~20 cuadros |
  | Acaba (luces y cielo), sin antorchas / con 2 | 8 / 24 cuadros | 27-35 / 69-76 |
  | Llamadas de luz | - | ~400 por tirada, máx 6,4 ms |
- Ver [Editar el mundo en partida](motor.md#editar-el-mundo-en-partida).

### Editar, bloques y el editor

- `stampModel` / `clearBox`: poner un modelo o vaciar una caja en partida.
- `BlockSet` / `BlockGrid` / `pickBlock`: un set de bloques de N x N x N con sus propiedades:
  - si es sólido;
  - si deja pasar la luz;
  - la luz que pone;
  - la variante tapada.

  El set se guarda como `.voxset.json`, y el mundo se escribe por bloques. Ver [Bloques](motor.md#bloques).
- En el editor, el panel "Bloques" pinta y guarda cada bloque del set, y `window.voxpix` lo hace sin ratón (`newSet`,
  `addBlock`, `saveSet`...).
- `iconSheet` / `modelIcon`: la hoja de iconos del set con su índice y la huella de cada icono. Con `outlineColor`, el contorno de un
  color fijo, como el del mundo (`bakeWorld`), para que iconos y mundo casen; sin él, la misma hoja de antes. Ver
  [Sets de bloques](editor.md#sets-de-bloques).

### Terreno por semilla

`generateTerrain` genera el terreno a partir de una `TerrainSpec`, que lleva:
- la superficie con ruido;
- las capas por profundidad;
- las vetas;
- lo que se planta encima.

Es determinista por semilla. Un mundo de 48 x 48 x 12 bloques se genera en ~0,25 s. El ruido (`fbm`, `fbmN`,
`valueNoise`) se exporta. Ver [Terreno por semilla](motor.md#terreno-por-semilla).

### Caminos

- `PathField`: un suelo por celda, con un BFS hacia atrás compartido por todos los que van a la misma meta. Ver
  [Caminos](motor.md#caminos).
- `LevelPathField`: varios suelos por celda (túneles, pisos), con caída limitada (`maxDrop`) y sin atravesar techos.
  - Guarda los pasos entre nodos vecinos y solo los borra donde cambia el mundo. Una búsqueda en un mundo de bloques
    de 384 x 384 x 96 cuesta ~0,3-0,4 ms.
  - Con `budget`, la búsqueda se reparte entre ticks por nodos (`advance()`), nunca por reloj: la simulación da lo
    mismo en cualquier máquina.
  - `lag` dice cuántos ticks va con retraso.
  - Un cuerpo más ancho que media celda se prueba también corrido dentro de la celda.
  - Ver [Caminos por niveles](motor.md#caminos-por-niveles).

### Moverse por niveles

`moveBodyLevels`: un cuerpo con alto que anda bajo techos, cae por huecos y salta. Dentro de una llamada, lo que
da el suelo de cada columna y el último apoyo se guardan, con los mismos resultados. En `bun scripts/bench-niveles.ts`
(20 cuerpos de radio 3 persiguiendo, 1800 ticks, mundo de bloques, sin freno) una llamada pasa de ~3,3 a ~2,6 µs de
media, y el apoyo se calcula 5 veces por llamada en vez de 6. Ver [Moverse por niveles](motor.md#moverse-por-niveles).

### El ciclo del día

`DayCycle`: la luz ambiente (y el fondo) por claves a lo largo del día, por ticks. Ver
[El ciclo del día](motor.md#el-ciclo-del-día).

### El cielo

Con `bakeWorld(..., { sky: true })` y `Frame2DOptions.cave`, lo que está bajo techo se oscurece hacia la luz de cueva.
CPU y GPU usan la misma tabla. Las entidades toman el cielo del píxel de sus pies. Ver
[El cielo: oscuro bajo techo](motor.md#el-cielo-oscuro-bajo-techo).

### Cortar la vista

`WorldView` con `{ cut: true }` y `setCut` / `cutJob` esconde lo que queda por encima de una altura dentro de una caja
(el jugador en un túnel). El horneado con corte es igual, byte a byte, que hornear sin esos vóxeles, en los 4 giros.
Puede llevar varias cajas, cada una con su `zTop` (`setCut([...])`): con la mitad del lado de la cámara hasta los
pies, el corte de casa de muñecas que deja ver al jugador en un túnel de un bloque de ancho. Ver
[Cortar la vista](motor.md#cortar-la-vista).

### Guardar y cargar

`encodeSnapshot` / `decodeSnapshot` pasan la instantánea a bytes y la restauran. La ida y vuelta es exacta.
- Un terreno de 384 x 384 x 96 ocupa ~600 KB.
- Respecto a una base, ocupa unos 3 KB por bloque picado.

Ver [Guardar y cargar](motor.md#guardar-y-cargar).

### Animaciones con nombre

Un `.voxpix.json` (versión 3) puede traer varios clips con nombre (quieto, andar, atacar). Se definen en la fila de
clips del editor y en el juego se leen con `clipsFromFile`, `clipFrameAt` y `clipDone`. Ver
[Animaciones con nombre](motor.md#animaciones-con-nombre).

### Preparar un giro

- La copia girada de los vóxeles va por losas (`StaticVoxels.copyRotatedSlabs`), sin pasar por `set`. En un mundo de
  384 x 384 x 96 con 9,6 M de vóxeles llenos baja de 0,7-1,1 s a 14-27 ms, y en `prepareViewJob` su unidad es una losa.
- El horneado por pasos (`bakeWorldJob`) va por baldosas que se cortan por el plazo de cada llamada, con las máscaras
  de lo expuesto. Lo que cuesta cada columna se estima por sus caras al aire, y cada fila del cielo por sus píxeles
  con algo. Baja de 0,9-1,3 s a 0,41-0,63 s, y deja hechas las máscaras que antes hacía después el trabajo `exposure`
  (~120 ms). Con llamadas de 0,5 ms (3 ms a 6x), el p95 es 0,57-0,69 ms y la más larga, 1,9-3,1 ms.
- `render()` ya no crea memoria por cada cara: mismas cuentas, mismo resultado byte a byte. El horneado de una vez
  baja de 0,32-0,6 a 0,2-0,42 s en ese mundo. Frente al ruido de la máquina (la puerta relativa), pasan 8 de 12
  corridas en vez de 1 de 6.
- `prepareViewJob` en el giro 0 con corte (`{ cut: true }`) también copia por partes. Antes hacía la copia entera en
  la etapa `view`, de una vez.
- Arreglado en `StaticVoxels`: una losa que pasaba de 256 valores distintos reescribiendo vóxeles podía quedarse con
  valores equivocados. Después de rehacer su paleta, seguía escribiendo en la paleta vieja.
- Ver [Girar la cámara](motor.md#girar-la-cámara).

### Ejemplo: un minero enano

`models/enano/enano.voxpix.json` está hecho solo con el editor: `scripts/enano.js`, corrido en la página del editor
con `window.voxpix`. Lleva:
- barba, casco con faro y un pico a la espalda;
- los clips `quieto`, `andar` y `atacar`;
- una caja de 6 x 6 x 14 vóxeles en todos los cuadros: con bloques de 8, baja por un pozo de 1 x 1 bloques.

`test/enano.test.ts` lo carga con `clipsFromFile` y comprueba los clips, la caja y que ningún cuadro va vacío.

### Agua en un mundo alto

`WaterLayer` acepta `{ wallAbove }`, ya no tiene pared fija a z 8 y su tramo de alturas (`zRange`) se ensancha a las
cuencas, en la CPU y en la GPU. `waterTop` puede ser `Int16Array`. Además:
- `follow(watch)` rehace el fondo de lo picado o puesto;
- con el corte de la vista, el agua de encima de lo cortado no se dibuja;
- `mapWater` saca el agua de un mapa por semilla.

Sin las opciones nuevas, el agua es la de siempre (las escenas de antes del oráculo dan lo mismo). A 6x, en 384 x 384
x 96, el paso del agua cuesta 0,6 ms de p50 y ~4,5 ms de p95 con pisotones, y la GPU, ~0,3-0,5 ms por cuadro. Ver
[Agua en un mundo alto](motor.md#agua-en-un-mundo-alto).

### Mapa por semilla

`generateMap` (`src/world/mapgen.ts`) genera un mapa entero por semilla, en celdas y con materiales que pone quien
llama:
- colinas por ruido;
- estratos;
- lagos bajo el nivel del mar con orilla;
- vetas;
- cuevas por gusanos;
- lo sembrado (árboles, flores).

Da las celdas, las columnas por tramos y la lista de lo sembrado. `applyMap` lo escribe en un `BlockGrid`, y
`mapHash` es su huella. Generar cuesta ~1-2 ms, y escribirlo en un mundo de 384 x 384 x 96, ~0,2 s. Ver
[Mapa por semilla](motor.md#mapa-por-semilla).

### Fondo transparente

`Frame2DOptions.background = 'transparent'`: alfa 0 donde no hay nada, en la CPU y en la GPU, para que el juego pinte
su cielo detrás del lienzo. Lo de encima sale opaco y sin halo, y sin la opción todo queda igual. Ver
[Fondo transparente](motor.md#fondo-transparente).

### Arreglos del compositor de la GPU

- Los pesos de una luz rehecha en parte se suben solo por su recuadro sucio (`texSubImage3D` con `UNPACK_SKIP_*`). Sin
  `UNPACK_IMAGE_HEIGHT`, que a 0 vale el alto de la subida, un recuadro que no empezaba en la primera fila de la zona
  era una subida inválida en Chromium (`GL_INVALID_OPERATION: invalid unpack params combination`). No subía nada, y la
  GPU seguía con los pesos viejos de esa luz. Comprobado en Edge con una página de prueba, y en el oráculo con un picado
  junto a cada luz: antes, error 1282 y 40 píxeles con la luz a más de un nivel; ahora, nada.
- Una entidad con un modelo sin vóxeles rompía el cuadro de la GPU (`syncOcc` con tamaño `-Infinity`). Ahora no se
  pinta ni da sombra, y se avisa una vez.
- El oráculo da por fallado un escenario que deje errores de WebGL.

### Niebla por altura

`Frame2DOptions.fog` funde hacia un color lo que se ve por debajo de una altura de foco: así se nota la altura en la
vista oblicua. Va en la CPU y en la GPU, sin hornear nada, con el foco cambiando en cada cuadro. Cuesta ~1,2 ms a 6x
en la CPU y no se nota en la GPU. Sin la opción, el cuadro es el de siempre, byte a byte. Ver
[Niebla por altura](motor.md#niebla-por-altura) y `app/niebla.html`.

### Contexto de la GPU perdido y recuperado

En un teléfono, el navegador quita el contexto WebGL al mandar la pestaña atrás. Al recuperarlo, el compositor resubía
el horneado pero los sprites precalentados se perdían y se volvían a pintar uno a uno en mitad de la partida. Ahora
recuerda cada `prewarm` y lo repite con el horneado y las opciones del último cuadro. En `app/multitud.html` con 20
entidades: justo después de recuperar el contexto, 64 sprites en el atlas (antes, 41, y 56 dos segundos después).

### Tolerancias conocidas

- **Oráculo CPU contra GPU en las escenas de cielo:** 49 y 7 píxeles de 82.944 difieren en ±1 en el color del agua.
  Es el mismo valor redondeado distinto al pasar a byte. Ver [El cielo](motor.md#el-cielo-oscuro-bajo-techo).
- **Luces:** quedan 0-2 llamadas de luz por tirada de más de 1 ms sin freno, y son pausas del recolector de basura.
- **Recortar la vista a 6x:**
  - la llamada más larga de la cola es una franja de recuadro (~4,5-5 ms a 6x, hasta ~2,5 ms sin freno), que no se
    puede partir sin pintar por rayo;
  - con el presupuesto cercano de 8 ms cabe una por cuadro, así que lo cortado tarda ~13-20 cuadros en aparecer a 6x;
    a 1x, una franja son ~0,75 ms.
- Lo probado y descartado para abaratar los rehorneados, con sus números, está en
  [Probado y descartado](motor.md#probado-y-descartado).
