# Cambios

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
- `prepareViewJob` en el giro 0 con corte (`{ cut: true }`) también copia por partes. Antes hacía la copia entera en
  la etapa `view`, de una vez.
- Arreglado en `StaticVoxels`: una losa que pasaba de 256 valores distintos reescribiendo vóxeles podía quedarse con
  valores equivocados. Después de rehacer su paleta, seguía escribiendo en la paleta vieja.
- Ver [Girar la cámara](motor.md#girar-la-cámara).

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
