# El motor del mundo

Debajo del editor hay un motor de mundo 2.5D sobre el que se puede hacer un juego. El mundo es **un solo modelo de
vóxeles**: lo estático, el agua, las entidades, las luces y las gotas. Dos renderizadores lo leen igual:
- el **modo 2D**: horneado más composición por cuadro, por GPU o por CPU;
- el **modo vóxel**: la vista 3D.

`app/escena.html` es la demo completa; `app/multitud.html` es la más corta. El
[juego de ejemplo](https://github.com/andyeswong/brotato-oficina) lo usa como dependencia.

## Usarlo desde otro proyecto

VoxPix no tiene paquete en npm. Se instala desde GitHub fijado a un commit, y se usa su TypeScript directamente:

    bun add github:andyeswong/voxpix#<commit>

En `vite.config`, `vitest.config` y `tsconfig`, un alias `@voxpix` -> `node_modules/voxpix/src`. Si usas el puente
con pxl (`src/pxl`), también `pxl-core` -> `node_modules/voxpix/vendor/pxl/src/core/index.ts`.

## Un mundo en pantalla

```ts
import { generateLayout } from '@voxpix/worldgen';
import { Model, type ModelFile } from '@voxpix/core';
import { buildWorldState, worldPalette } from '@voxpix/world/build';
import { THEMES } from '@voxpix/samples/themes';
import { bakeWorld } from '@voxpix/world/bake';
import { createCompositor } from '@voxpix/view/compositor';
import { walkFrames, WALK_FRAME_MS } from '@voxpix/anim/walk';
import maiaFile from 'voxpix/models/maia/maia.json';

const VW = 384, VH = 216;
const canvas = document.querySelector('canvas')!;
canvas.width = VW; canvas.height = VH;
const compositor = createCompositor(canvas);                 // GPU (WebGL2) si hay; si no, CPU

// Un escenario por semilla, construido en vóxeles y horneado una vez. El generador (spec) y el aspecto (look) son
// tuyos: aquí, los de la muestra medieval de src/samples/themes.ts
const { spec, look, ambient } = THEMES.medieval;
const layout = generateLayout(spec, 7);
const { world, state } = buildWorldState(layout, look);
const baked = bakeWorld(world, { topZ: 40, incline: 0.5 });

// Una entidad que anda, y una antorcha que va con ella
const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));   // maiaFile: models/maia/maia.json
const x = layout.spawn.x, y = world.depth - 1 - layout.spawn.y;
const id = state.entities.add({ model: walk[0]!, x, y, z: 1, facing: 0, castsShadow: 'always' });
state.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: id, offset: [6, -4, 14] } });

// Lo que va a salir, subido antes del primer cuadro
const opts = { vx: 0, vy: 0, vw: VW, vh: VH, time: 0, lights: true, ambient };
compositor.prewarm(baked, opts, walk.map((model) => ({ model, casts: true })));

function loop(now: number): void {
  state.entities.setModel(id, walk[Math.floor(now / WALK_FRAME_MS) % walk.length]!);
  state.step();                                              // 1/60 s del mundo: agua, gotas, luces que siguen
  const feet = baked.cam.project(x + 0.5, y, 1);
  const vx = Math.max(0, Math.min(baked.width - VW, Math.floor(feet[0]) - VW / 2));
  const vy = Math.max(0, Math.min(baked.height - VH, Math.floor(feet[1]) - VH / 2));
  compositor.frame(state, baked, { ...opts, vx, vy, time: now / 1000 });
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

## Las piezas

| Módulo | Qué hay |
|---|---|
| `worldgen`, `terrain` | (`src/terrain`: el autotile de las teselas; el terreno de bloques por semilla es `world/terrain`.) Mapas por semilla en teselas (salas, paredes, columnas, agua, fuente), con las reglas que le pases (`GeneratorSpec`). `spec.shape` da la forma de la sala: L, T, salas con pasillos, laberinto o un plano en texto. Con `spec.doors`, la sala trae sus huecos de puerta, y `stitchRooms` une varias en un mapa abriendo las puertas entre vecinas (ver `docs/api-mundos.md`). |
| `world/build` | `buildWorldState(layout, look, { decorate })`: el escenario en vóxeles, con sus luces fijas, el agua y el estado inicial. El aspecto (`WorldLook`) lo da quien construye; ver "El aspecto del mundo". |
| `samples` | Contenido de MUESTRA para la demo y las pruebas: tres temas (`oficina`, `medieval`, `cyberpunk`, en `samples/themes`), escenas y paletas. El motor no lo importa: cópialo o haz el tuyo. |
| `world/state` | `WorldState`, la única fuente de verdad: lo estático, el registro de modelos, las entidades, las luces, el agua, las gotas, los efectos y su huella (`hash`, `snapshot`, `restore`). |
| `world/bake` | `bakeWorld`: lo estático pintado una vez, con la luz de las fuentes fijas. `rebakeChangedJobs` rehornea solo la caja de lo que cambió (ver "Rehornear lo que cambió"). Ojo: `baked.rgba` es la imagen SIN luz; la luz horneada está en `baked.lights[].weight` (un peso por píxel de su zona) y se suma al componer cada cuadro. Para comprobar un cambio de luz, mira los pesos o el cuadro compuesto, no `rgba`. |
| `view/compositor` | `createCompositor(canvas)`: compone cada cuadro (escenario, entidades con su luz por cara y sus sombras, agua, gotas). GPU con WebGL2 o CPU de reserva con el mismo resultado. Si la GPU pierde el contexto, sigue la CPU; al recuperarlo, resube el horneado y vuelve a precalentar lo que se le pasó a `prewarm` (con el horneado y las opciones del último cuadro). |
| `world/frame3d` | El modo vóxel: el mismo estado visto en 3D. |
| `runtime/runtime`, `runtime/body` | El tick determinista (entrada -> cuerpos con colisión -> eventos -> mundo), `FixedLoop` para pasar de tiempo real a ticks fijos y `Runtime`, un personaje controlable con su luz de mano. |
| `view/budget` | `FrameBudget`: el trabajo de la vista que no cabe en un cuadro (rehornear trozos) se reparte entre cuadros, con un presupuesto aparte para lo cercano (`near`). Ver "Editar el mundo en partida". |
| `world/edit` | `stampModel` / `clearBox`: poner un modelo o vaciar una caja en partida (y `turnCell`, `rampMap`). Ver "Editar el mundo en partida". |
| `world/blocks` | `BlockSet`, `BlockGrid`, `pickBlock` y el `.voxset.json`: un mundo de bloques. Ver "Bloques". |
| `agent/agent` | `AgentHost` e `installAgent`: leer el mundo de bloques como texto y dar órdenes con resultado, para agentes. Ver "Interfaz para agentes". |
| `world/terrain` | `generateTerrain`: el terreno de bloques por semilla. Ver "Terreno por semilla". |
| `world/paths`, `world/levelpaths` | `PathField` y `LevelPathField`: caminos hacia una meta, por la superficie o por niveles. Ver "Caminos" y "Caminos por niveles". |
| `runtime/levels` | `moveBodyLevels`: cuerpos con alto que andan bajo techos, caen y saltan. Ver "Moverse por niveles". |
| `world/save` | `encodeSnapshot` / `decodeSnapshot`: la partida en bytes. Ver "Guardar y cargar". |
| `lighting/daycycle` | `DayCycle`: la luz ambiente a lo largo del día. Ver "El ciclo del día". |
| `core/icons` | `iconSheet`, `modelIcon` y `fnv32`: hojas de iconos de modelos con su huella. Ver docs/editor.md, "Sets de bloques". |
| `anim/walk`, `anim/rig` | Los cuadros de andar de un personaje (`walkFrames`) y la animación genérica por partes de cuerpos de varias patas (`rigFrames`). |
| `fluid` | El fluido en volumen del editor (verter y grifos). |

## Los vóxeles del mundo: memoria y cambios

`StaticVoxels` guarda el mundo en trozos de 16 x 16 columnas, cada uno con toda la altura (`zMin..zMax`). El trozo
es la unidad de las versiones (`changedSince`), de `watchChanges` y del rehorneado. Por dentro, cada trozo se parte
en **losas** de 16 x 16 x 16 (`SLAB`), y cada losa ocupa solo lo que necesita:

- nada, si es toda aire o toda del mismo valor (la roca maciza de un terreno);
- 1 byte por vóxel, con su propia paleta, mientras tenga como mucho 256 valores distintos;
- 2 bytes por vóxel si tiene más.

`get`, `set`, `entries` (en su orden de siempre: trozo, z, y, x) y `exportChunks` (la columna entera de cada trozo,
así que la instantánea y la huella no cambian) son los de antes. Un mundo de 768 x 768 x 192 lleno hasta la mitad
ocupa ~57 MB con capas de dos materiales cada 8 de alto, y menos con roca de un solo valor (`byteLength` lo dice).

- `exposedEntries(región)`: como `entries`, pero sin los vóxeles enterrados (los que tienen sus 6 vecinos llenos y
  no enseñan ninguna cara), en el mismo orden. `forEachExposed(fn, región)` es lo mismo sin generador, y la región
  puede limitar también la altura (`z0..z1`). El render (`render`, y el horneado con él) la usa si la fuente la tiene
  (`VoxelSource.forEachExposed`, opcional): los mismos píxeles, recorriendo mucho menos.
  - Antes solo se saltaban losas enteras llenas, y de una losa a medio llenar (la superficie, un túnel, el borde de un
    corte) se daban todos sus vóxeles. En una franja del rehorneado con un corte hondo eran 20.000-30.000 para ~2.000
    caras.
  - `forEachExposed` guarda por losa qué vóxeles tienen alguna cara al aire (una máscara por fila de 16), hecha fila a
    fila al pedirla. Vale mientras no cambien el trozo ni sus 4 vecinos (su versión) ni se importe el mundo. Cuesta
    768 bytes por losa recorrida (~2,6 MB en un mundo de 384 x 384 x 96 entero).
  - `forEachExposed(fn, región, false)` recorre sin hacer ni mirar las máscaras (lo de antes: un superconjunto, los
    mismos píxeles). Lo usa el horneado inicial (`bakeWorld` y `bakeWorldJob`), que recorre todo el mundo una vez: hacer
    las máscaras de todas las losas le subía el render un ~70 % en un navegador frenado a 6x. A cambio, el horneado
    deja apuntado que falta preparar lo expuesto (`baked.exposurePending`), y la primera `rebakeChangedJobs` devuelve,
    una vez, un trabajo `exposure:...` sin prioridad (detrás de todo, como el cielo) que lo prepara trozo a trozo, de
    dentro hacia fuera desde su `near`. No rehace lo que ya hizo una franja. Quien nunca llama a `rebakeChangedJobs`
    tampoco corta, así que no le hace falta. Sin él, la primera franja que pasa por cada trozo tras un corte hacía sus
    máscaras dentro de su plazo (en un juego de noche con cortes, de 6/9/4 a 7/12/13 cuadros de más de 25 ms por tirada
    a 6x). Cuesta lo que costaban en el horneado (~1 s a 6x en ese juego), a 3 ms por cuadro: unos 300 cuadros a 6x.
    `bakeWorld(..., { warmExposure: false })` no lo encola.
  - `warmExposed(región, filas)` deja hechas hasta tantas filas, para preparar con plazo lo que se va a recorrer: el
    rehorneado lo hace antes de cada franja y, si no le da tiempo, sigue en el cuadro siguiente.
- `viewWrites`: mientras está a `true`, `set` escribe como vista (lo hace el corte de vista): cuenta como cambio para el
  rehorneado, pero no como cambio del mundo (`worldChangedSince(trozo, versión)`).
- `changedBox(trozo, versión)`: la caja (x, y, z, extremos incluidos) de lo que cambió en ese trozo después de la
  versión, o `null`. Puede ser más grande que lo cambiado, nunca más pequeña. `cut()` cierra los tramos abiertos:
  quien acaba de leer las cajas (el horneado lo hace solo) corta, y lo que cambie después tiene su caja aparte.

## Rehornear lo que cambió

`rebakeChangedJobs(baked, luces)` rehace solo **la caja de lo cambiado** de cada trozo: los píxeles por los que pasa
esa caja (con 1 vóxel de margen, que es lo que cambian la oclusión y las caras vecinas; 3 si el horneado lleva
normal suavizada), no el trozo con toda su altura. Quitar o poner vóxeles solo cambia lo que se ve a través de
ellos, así que el resultado es el mismo, byte a byte, que hornear el mundo entero (hay pruebas, también con
contorno). Las sombras de las luces fijas leen los vóxeles directamente: `baked.occ` ya no se usa y va vacío.
Debajo está `rebakeJobs(baked, trozos, luces, cajas?)`, para quien lleve sus propios trozos cambiados (sin cajas,
cada trozo entero).

- Las luces fijas que alcanzan lo cambiado no se rehacen enteras: sobre sus mismos pesos (en un objeto nuevo, para que
  la GPU sepa que cambiaron) se recalculan solo los píxeles donde cambió el vóxel o la cara que se ve, los de vóxeles
  dentro de la caja, y los que miran a la luz por un segmento que cruza la caja (su sombra puede haber cambiado); estos
  se buscan solo en el recuadro de pantalla de la sombra de la caja vista desde la luz. Si la luz es otra (otro sitio,
  intensidad, color, radio), se rehace entera.
- El render salta los vóxeles cuyo cubo cae entero fuera de la imagen sin mirar sus caras: una franja estrecha de un
  mundo grande recorre muchos así.

Medido en un portátil con GPU dedicada, sin navegador ni freno de CPU, con `bun scripts/bench-picar.ts <lado> <alto>
<antorchas>` (terreno de bloques de 8 a media altura, antorchas fijas en la cuarta parte central, se pica un bloque
de arriba junto a una):

| Mundo | Vóxeles | Horneado entero | Picar un bloque: total p50 / p95 | Paso más largo |
|---|---|---|---|---|
| 384 x 384 x 96, 30 antorchas | 6 MB | ~0,7 s | ~7-9 / ~9-12 ms | ~1,5 ms |
| 768 x 768 x 192, 30 antorchas | 23 MB | ~2,0 s | ~6 / ~11 ms | ~3 ms |

Los pasos los reparte la cola (`FrameBudget`) entre cuadros. Con el navegador y la CPU frenada, todo sube varias veces:
la medida que vale para un juego es la suya.

### El margen de las franjas, solo con contorno

Cada franja de un recuadro se renderiza con 1 píxel de margen por cada lado (y se recorta) solo si el horneado lleva
contorno (`outline`), que es lo único que mira a los píxeles vecinos; sin contorno, sin margen (hay prueba de que da lo
mismo byte a byte que con el margen forzado, `RECT_TUNING.halo = 'always'`). Ayuda al PASO, no al total. Medido sin
freno (`bun scripts/bench-picar.ts 384 96 30`, cada llamada con plazo de 0,45 ms, dos tiradas de cada):

| | Llamada más larga (p95) | Recuadro (p95 por llamada) | Total por golpe (p95) |
|---|---|---|---|
| Margen siempre | 1,9-2,0 ms | 1,1-1,2 ms | 7,9-8,0 ms |
| Margen solo con contorno | 1,3-1,5 ms | 1,0 ms | 7,5-7,6 ms |

El total es trabajo real: unas 26 tareas por golpe (recuadro ~2,7 ms y luces ~1,9 ms sin freno; 30-50 ms con la CPU
frenada a 6x en los peores golpes).

### Probado y descartado

Para que nadie lo repita a ciegas (medido en `bun scripts/bench-picar.ts`, sin freno):

- **Cortar la franja del recuadro donde el rayo de cada fila entra en losas macizas** (lo de detrás no se ve): recorta
  de ~184 a ~100 filas de y por franja, pero las losas llenas empiezan muy por debajo de la superficie y el banco sale
  peor (p95 8,9 contra 7,4 ms; paso 1,6 contra 1,1).
- **Estrechar la franja según el plazo** (de 1 a 4 columnas, con lo que cuesta una columna, global o por recuadro):
  cada franja tiene un coste casi todo fijo (recorrer su región), así que más franjas cuestan más en total (de ~4,5 a
  ~5,5-6,5 ms por golpe) y la llamada más larga no baja; en un corte hondo una franja de 1 columna cuesta casi lo
  mismo que una de 4 (~1,7 ms). Repetido con las máscaras de lo expuesto, en el corte de casa de muñecas con contorno:
  con franjas de 2 y de 1 columna el p95 de la llamada baja de 11,2 a 9,4 y 8,5 ms (a 6x), pero el máximo sigue en
  ~19-23 y lo cortado tarda en aparecer el doble y el triple (73 y 110 cuadros contra 49).
- **Correr las máscaras de lo expuesto con el mundo al correrse la ventana viva** (como las losas, por pasos en los
  búferes de atrás de `StaticVoxels.shiftJob`, en vez de darlas todas por caducadas): funciona (la columna de trozos a
  2 de cada borde no rehace ninguna fila, y lo expuesto es igual que en un mundo nuevo ahí), pero no gana nada medible
  porque las máscaras son poco del coste y lo que entra las necesita nuevas igual. En Bun, con el mundo de FERN en 9 x
  11: picar junto al objetivo justo tras correrse, 4,8-6,9 ms con y 4,9-7,0 sin; un corte de casa de muñecas hondo de
  81 x 81 justo tras correrse, 50-104 ms con y 53-105 sin; el rehorneado de cada corrimiento (`bench-viva.ts`), igual.
  No entró (2026-11-17, la noche antes de una entrega, y tocando `shift`); el parche, con su test, en
  `~/claude-sessions/voxpix-mascaras-corridas.patch` del nodo alienware.
- **Invalidar lo expuesto vóxel a vóxel** (al cambiar uno, borrar solo sus filas y las de sus vecinos), en vez de por
  la versión del trozo y sus vecinos: menos filas que rehacer, pero `set` cuesta un 30 % más y el corte, que escribe
  miles de vóxeles, va más lento (aparece en 62-71 cuadros contra 47-49).
- **Rayo por píxel en vez de pintar caras** en el recuadro: más rápido en teoría, pero tiene que dar los mismos píxeles
  que el render, empates de aristas incluidos. Días de trabajo y riesgo; no hecho.
- **Luces que se pasaban del plazo en el relevo**: las sombras de las cajas se preparan una por paso, los píxeles de la
  zona miran el reloj cada 4, los pesos por cara van en una tabla de tamaño fijo reutilizada (un Map o un Set que crece
  se rehace entero al pasar de 16384 y eso eran ~2 ms) y los pesos pendientes en arrays de su tamaño. En
  `bench-corte.ts` con `ANT=2`: llamadas de luz de más de 1 ms sin freno de 7-9 por tirada (máx 15-22 ms a 6x) a 0-2,
  y esas son pausas del recolector (la misma celda, repetida, cuesta 0,1-0,2 ms a 6x).
- **Partir la franja (o que la tonalidad de las caras se guarde entre franjas)**: en el corte de un túnel, una franja
  de 4 x 19 píxeles recorre ~5.800 vóxeles expuestos, ~5.200 caen en la imagen y se rasterizan (lo tapado también se
  pinta), y solo ~600 caras necesitan su tono. Con TODOS los tonos ya guardados, la franja sigue costando ~0,9 ms
  (contra ~1,0-1,15): el coste es pintar lo tapado, no el tono. Bajarlo es el rayo por píxel (abajo).
- **Caminos por niveles incrementales desde la meta anterior** (cuando la meta se mueve una celda): el BFS es hacia
  atrás desde la meta, así que moverla cambia distancias en todo el campo; hacerlo exacto no sale barato. En su lugar,
  la búsqueda repartida por tandas (`budget`, `advance`).
- **Descartar una antorcha porque hay una columna llena entre ella y lo cambiado**: no encontré una forma barata y
  exacta de saber que nada de su sombra pasa por otro lado.

## Editar el mundo en partida

Picar, poner, construir: cambiar el escenario mientras se juega, y que se vea en uno o dos cuadros.

```ts
import { stampModel, clearBox } from '@voxpix/world/edit';
import { rebakeChangedJobs } from '@voxpix/world/bake';
import { FrameBudget } from '@voxpix/view/budget';

const budget = new FrameBudget(3);                     // ms por cuadro para el trabajo de la vista
// Quitar lo que haya en una caja y poner un modelo (de 8 x 8 x 8, una pieza, lo que sea) con su origen en (x, y, z)
const quitado = clearBox(state, { x0, y0, z0, x1, y1, z1 });   // la caja de lo que estaba lleno, o null
const puesto = stampModel(state, modelo, x, y, z, 90);         // girado; la caja de lo que cambió, o null
// Una antorcha que se queda: luz fija (se hornea), no dinámica
const luz = state.lights.addFixed({ kind: 'torch', x: x + 4, y: y + 4, z: z + 10 });
// Cada cuadro: lo que haya cambiado, con lo más cercano al jugador primero
for (const j of rebakeChangedJobs(baked, state.lights, { near: { x: px, y: py } })) budget.push(j);
budget.run();
```

- `stampModel(state, modelo, x, y, z, giro?)` pone los vóxeles llenos del modelo (lo vacío no toca nada: para
  sustituir, `clearBox` antes). El giro es 0, 90, 180 o 270 alrededor del origen del modelo (90 lleva lo que miraba al
  sur a mirar al este). Las rampas del modelo tienen que estar en la paleta del mundo (la misma rampa: nombre y
  colores), en cualquier posición: se traducen solas, y si falta una, el error dice cuál. Por eso los modelos que se
  van a poner en partida comparten rampas con el mundo desde que se construye.
- `clearBox(state, caja)` vacía la caja (extremos incluidos).
- Las dos escriben por `StaticVoxels.set`: `watchChanges` da sus cajas `'voxels'`, y `rebakeChangedJobs` rehace solo
  lo que cambió (ver "Rehornear lo que cambió"). Devuelven la caja de lo que cambió de verdad: poner lo que ya hay
  da `null` y no rehornea nada.
- Presupuesto aparte para lo cercano: `new FrameBudget(3, undefined, { ms: 8, below: 64 })`. Los trabajos con
  `priority` menor que `below` (con `near`, los recuadros a menos de 64 px del jugador en pantalla) se hacen antes y
  pueden llevarse hasta 8 ms del cuadro; los demás siguen con sus 3. Las luces que cambian por el mundo (una nueva, o
  un bloque picado o puesto a su alcance) llevan la misma prioridad que los recuadros (la distancia de la luz en
  pantalla): una antorcha puesta junto al jugador va con el presupuesto cercano. Las que solo toca de rebote un corte
  de vista van detrás: un corte bajo unas antorchas no le quita el cercano a sus propios recuadros (en un juego de
  noche con 10 antorchas y cortes bajo las copas, de 8-34 a 6-7 cuadros de más de 25 ms por tirada a 6x).
  No se adelantan a lo que tiene que aparecer: un trabajo de luz espera, sin gastar nada, a que se publiquen sus
  recuadros. El cielo va detrás de todo (desde `LIGHT_PRIORITY`, 10000), y las luces también con
  `rebakeChangedJobs(..., { near, nearLights: false })`, como antes.
  En `bench-corte.ts`: una antorcha nueva junto al jugador alumbra en 4 cuadros a 6x en vez de 9 (`ANTORCHA=1`); en un
  corte con dos antorchas en el túnel (`ANT=2`), lo cortado aparece igual (p50 16-17 cuadros a 6x) y las luces acaban
  en 24-29 cuadros en vez de 39-44.
  `budget.ms` y `budget.near` se pueden cambiar entre cuadros.
- La cola aprende lo que cuesta cada clase de llamada (la key hasta `:` o `#`: `rect`, `light`, `sky`, `view-cut`...):
  el p95 de sus últimas 32 llamadas, en `budget.expected(key)`. La primera llamada de cada trabajo (la que lo prepara:
  la cara de un recuadro nuevo) lleva su propia estimación, aparte de la de las siguientes (`expected(key, true)`):
  si no, la de las primeras, más cara, no dejaría meter franjas de las siguientes que sí caben. En cada fase (la cercana y la de lo demás), la primera
  llamada va siempre (si no, nada avanzaría); las demás solo empiezan si cabe lo que suele costar su clase, y si no,
  la cola prueba con el siguiente trabajo (otra clase puede caber). Una clase que no ha corrido nunca no tiene
  estimación: solo empieza como primera llamada de su fase (la primera de cada clase puede esperar un cuadro; a cambio,
  ninguna empieza sin sitio). Las llamadas que no gastan nada medible (esperar a otro trabajo) no cuentan ni para la
  estimación ni como la primera llamada de la fase. Lo cercano que no acabó no vuelve a correr en la fase de lo demás
  del mismo cuadro: antes se llevaba otra unidad entera de ese presupuesto.
- Lo que sobra del cercano, si no queda nada cercano en la cola, se lo lleva la fase de lo demás hasta `spare` ms
  (cuarto argumento de `FrameBudget`; por defecto, `ms`: lo demás como mucho se duplica; 0, nada), con las mismas
  reglas. Así lo de detrás (el cielo, las luces lejanas, preparar lo expuesto) avanza cuando no hay nada urgente. Si
  queda algo cercano (no cupo), lo que sobra es suyo. Con tope porque lo que sobra del cercano no es tiempo libre: es el
  margen que el juego dejó para la varianza del cuadro (un pico de la simulación). En un juego a 6x:
  - con el sobrante entero, preparar lo expuesto acababa antes del primer corte (cuadro 154-176 en vez de 362), pero
    los cuadros de más de 25 ms en una noche con cortes pasaban de 8-10 a 28-43 por tirada;
  - en el banco (mundo de bloques de 384 x 384 x 96, nada más en la cola), preparar lo expuesto tarda 160 cuadros con
    `spare` 0, 80 con el defecto y 43 con el sobrante entero.
- Lo que no cabe se salta, pero no para siempre. Un trabajo que lleva 4 cuadros seguidos saltado por no caber va el
  primero de su fase en el siguiente (la primera llamada es la que puede no caber). Sin eso podía quedarse bloqueado:
  una clase cuya llamada cuesta más que el cercano entero (la primera franja de un recuadro de corte) solo corre como
  primera de su fase, y si delante corre siempre algo antes, no corre nunca. Ese algo puede ser una luz cercana que
  espera a su recuadro y que el reloj del navegador, redondeado a 0,1 ms, mide como trabajo. Hay prueba con esa espera
  delante.
- El contrato, probado con un reloj de mentira desde el primer cuadro (`test/view/budget.test.ts`): si ninguna unidad
  de trabajo es más larga que el presupuesto de su fase, ningún `run()` pasa de `near.ms + ms`, y cada trabajo acaba
  igual que sin plazo.
- La cola es una, y las keys las pone quien encola: un trabajo nuevo con la misma key SUSTITUYE al que hay en la cola.
  Las de `rebakeChangedJobs` (`rect:...`, `light:N`, `sky:...`, `view-cut`, `exposure:N`) no dicen de qué vista son.
  Con varias vistas en la misma cola (varios giros preparándose o al día), hay que distinguirlas, p. ej. con un sufijo
  por giro (`light:3@q1`); si no, el trabajo de un giro pisa al de otro. `prepareViewJob` ya lleva el giro en la suya
  (`view:q`), y su horneado, `bake:q`.
- `rebakeChangedJobs(baked, luces, { near })`: con `near` (x, y del mundo), cada trabajo lleva `priority` (su distancia
  en pantalla) y `FrameBudget` hace antes los de prioridad más baja, aunque haya trabajo viejo en la cola. Los
  trabajos sin prioridad van detrás, en su orden.
- El agua no se entera de estos cambios (como de `crushAt`): para un mundo con agua que se pica, hay que contarlo.

## Bloques

Para un mundo de construir y picar: el escenario hecho de bloques de N x N x N vóxeles, cada uno un modelo pequeño.

```ts
import { BlockSet, BlockGrid, pickBlock } from '@voxpix/world/blocks';
import setFile from './bloques.voxset.json';            // hecho con el editor (docs/api-agentes.md, Sets de bloques)

const set = BlockSet.fromJSON(setFile);
// El mundo con las rampas del set en su paleta (en cualquier orden, con otras más si se quiere)
const solid = new StaticVoxels({ ramps: [...set.palette.ramps] }, 48 * set.size, 48 * set.size, 0, 12 * set.size - 1);
const state = new WorldState(solid, [], null);
const grid = new BlockGrid(state, set);                 // 48 x 48 x 12 bloques desde el vóxel (0, 0, 0)
grid.fill([0, 0, 0], [47, 47, 4], set.index('piedra')); // para generar, antes de hornear
// En partida: devuelven la caja de vóxeles que cambió; el rehorneado es el de siempre
grid.set(bx, by, bz, set.index('antorcha'));
grid.set(bx, by, bz, 0);                                // picar
const hit = pickBlock(grid, view, baked, sx, sy);       // { cell: [bx, by, bz], face: [dx, dy, dz] } bajo el puntero
const hit2 = pickBlock(grid, view, baked, sx, sy, layer); // con corte al componer: la capa con que se pinta el cuadro
```

- Con corte al componer (la capa de `sectionFor` o `SectionPainter.layer()`), `pickBlock` lee la capa donde ella pinta
  el píxel: lo que la caja quita no se pica y lo que destapa (el suelo de una zanja junto al personaje, un túnel bajo
  tierra), sí. Sin la capa lee solo la imagen horneada, y ahí un bloque de hondo tapa dos celdas de suelo detrás de la
  pared de delante: ningún píxel las apunta (`test/pick-seccion.test.ts`).

- `.voxset.json`: `{ format: 'voxpix-set', version: 1, name, size, palette, blocks: [{ id, voxels, props? }] }`. Los
  vóxeles de cada bloque van de 0 a N-1 en cada eje, con los valores de la paleta del set.
- Las propiedades (`BlockProps`): `solid` (bloquea el paso), `light` (`'blocks'` o `'passes'`) y `emissive` salen de
  los materiales de sus rampas (docs/render.md, Materiales), que son los que de verdad usan la colisión, la luz y el
  render; si se escriben, tienen que coincidir (si no, error). `density` es la media de sus vóxeles, o la que se diga.
  `emits` es la luz fija que pone al colocarse (`addFixed`; `at` es dónde, en vóxeles del bloque sin girar) y quita al
  quitarse. Un bloque puesto girado (`set(..., giro)`) gira su luz con sus vóxeles (`turnPoint`, el punto como
  `turnCell` la celda): una luz en una cara sale de esa cara girada. Sin girar, o con la luz en el centro, todo queda
  igual, byte a byte (`test/luz-girada.test.ts`, contra 28f1e22; `bun scripts/huella-luz.ts <raíz>` da esa huella). `covered` es el bloque en que se convierte cuando tiene uno sólido encima (la hierba tapada, tierra).
  Lo demás (cuánto cuesta picarlo, qué suelta, recetas) es del juego, no del set.
- `BlockGrid`: la rejilla (`cols`, `rows`, `layers`) es la fuente de verdad y los vóxeles su dibujo. `get`, `set(bx,
  by, bz, tipo, giro?)` (0 quita; aplica `covered` y `emits`), `fill(b0, b1, tipo)` (para generar), `props`,
  `cellOf(x, y, z)` (vóxel a bloque), `box(bx, by, bz)` (bloque a vóxeles) y `topAt(bx, by)` (el sólido más alto de la
  columna, o -1). Las rampas del set tienen que estar en la paleta del mundo (el error dice cuál falta).
- La rejilla se añade al mundo como una parte del estado (`WorldState.addPart`): entra en `snapshot`, `restore` y
  `hash`. Un mundo sin partes da la huella de siempre. `addPart` sirve para cualquier otro estado que añada un juego
  (`exportState`, `importState`, `hashInto`).

## Interfaz para agentes

`src/agent/agent.ts`: un agente (pruebas de juego, reproducir un fallo, un arnés de medida) lee el mundo de bloques
como texto y da órdenes que contestan qué pasó, sin coordenadas de pantalla ni ratón. El motor pone lo que sabe (la
rejilla, lo que se ve, el alcance, los ticks); las órdenes y sus reglas (picar, poner, qué suelta, la dureza) las
registra el juego. Todo lo que devuelve es JSON.

```ts
import { AgentHost, installAgent } from '@voxpix/agent/agent';

const agent = new AgentHost({
  state, grid,
  look: () => ({ view, baked, section: painter.layer() }),   // lo de este cuadro (la misma capa con que se compone)
  player: () => runtime.player, playerEntity: runtime.entityId,
  marks: () => enemigos.map((e) => ({ ch: 'e', x: e.x, y: e.y, z: e.z, name: e.tipo })),
  sim: runtime,                                              // lo que avanza step(n)
});
agent.register('picar', (a, h) => h.check(a.cell, { reach: 24, visible: true }) ?? picar(a.cell), 'picar {cell}');
installAgent(window, agent);                                 // window.voxpixAgent, solo si se pide
```

- `describe({ at?, radius?, below?, above?, visible? })`: capas por z (de arriba abajo) alrededor de un punto (por
  defecto el jugador), una letra por celda; las filas de norte a sur y las columnas de oeste a este. Las letras salen de
  los ids del `BlockSet` (la primera libre del id, o `letters` fijas); `.` aire, espacio fuera de la rejilla, `@` el
  jugador, `*` las entidades, y las marcas del juego. Con vista, en minúscula lo que no se ve desde la cámara. Lleva la
  leyenda, las marcas con su posición exacta y un `text` listo para leer.
- `visibleCells(rect?)`: por celda, qué caras se ven y cuántos píxeles. Sale de `pickVoxel` en cada píxel, lo mismo que
  `pickBlock` (con la capa de sección): lo que el agente ve es lo que el jugador puede picar (`test/agente.test.ts` lo
  compara celda a celda, con y sin sección).
- `probe(sx, sy)`: el vóxel, la celda, la cara y el bloque que se pintan en un píxel de la imagen horneada.
- `reach(cell, r)`: la distancia del jugador a la caja de la celda. `check(cell, { reach, visible })`: las
  comprobaciones de siempre antes de una orden (dentro de la rejilla, al alcance, visible); null si pasa, si no el
  resultado que hay que devolver ("fuera de alcance (30.2 > 24)", "no visible").
- `register(name, fn, help)` / `act(name, args)` / `list()`: las órdenes del juego. `act` siempre contesta
  `{ ok, msg, ... }`: una orden que no existe, que lanza un error o que no devuelve eso, también.
- `step(n, input?)`: n ticks de la simulación con la misma entrada, sin reloj (la misma partida que n `step` a mano).
- Lo que no hace (aún): andar a un sitio (sería con `LevelPathField`) y decir qué entidad hay bajo un píxel.

## Terreno por semilla

Un terreno de bloques (superficie, capas, vetas y lo que se planta encima) descrito como datos, sobre una `BlockGrid`
y antes de hornear. Determinista: la misma semilla da el mismo terreno en cualquier máquina. Solo superficie (sin
cuevas).

```ts
import { generateTerrain } from '@voxpix/world/terrain';

const { heights } = generateTerrain({
  seed: 7,
  surface: { base: 6, amplitude: 3, scale: 9, octaves: 3 },        // altura en bloques: base +- amplitude
  layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],   // la última, hasta abajo
  veins: [{ block: 'carbon', in: 'piedra', chance: 0.08, size: [1, 3], bz: [0, 5] }],
  scatter: [{ on: 'hierba', density: 0.02, spacing: 4,              // un árbol: tronco de 3 y copa
    structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'tronco'], [0, 0, 3, 'tronco'], [0, 0, 4, 'hojas'], [1, 0, 4, 'hojas'], [-1, 0, 4, 'hojas']] }],
}, grid);
```

- `surface`: la altura de cada columna (el bz de su bloque de arriba) con ruido de `scale` bloques y `octaves` octavas,
  entre 0 y la última capa de la rejilla. `heights` la da por columna (`by * cols + bx`).
- `layers`: de arriba abajo, cada una con su bloque y su grosor en bloques; la última llega hasta abajo.
- `veins`: en los bloques `in` dentro de la franja `bz`, cada uno empieza una veta con probabilidad `chance`, que crece
  por vecinos hasta `size` bloques.
- `scatter`: estructuras (listas de bloques `[dx, dy, dz, bloque]` relativas al de arriba de la columna) sobre las
  columnas que acaban en `on`, con probabilidad `density` y separadas `spacing` bloques. Solo se planta si cabe y va
  sobre aire; se pone con `grid.set`, así que aplica las variantes tapadas (la hierba bajo un tronco, tierra) y la luz
  que emitan.
- El ruido es de `src/worldgen/noise.ts` (`valueNoise`, `fbm`, `fbmN`, `lattice`), exportado para quien quiera más.
- En un portátil, sin freno: un terreno de 48 x 48 x 12 bloques de 8 se genera en ~0,25 s y se hornea en ~0,3 s.

## Mapa por semilla

`src/world/mapgen.ts` genera un mapa entero por semilla, en celdas (bloques). No toca ningún mundo y no sabe qué es
cada material: son números que pone quien llama (con un `BlockGrid`, los índices de su set; 0 es aire). Hace:
- relieve por ruido;
- estratos por profundidad;
- lagos bajo el nivel del mar, con orilla;
- vetas;
- cuevas;
- lo que se siembra encima.

```ts
import { generateMap, applyMap, mapColumn, mapHash } from '@voxpix/world/mapgen';
const T = (id: string) => set.index(id);
const map = generateMap({
  seed: 1, width: 48, depth: 48, height: 12,
  surface: { base: 6, amplitude: 2.5, scale: 9 },                     // colinas: fbm
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
  seaLevel: 5, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 },
  veins: [{ material: T('mena'), in: [T('piedra')], z: [1, 4], density: 0.03, size: [2, 4] }],
  caves: { count: 10, z: [1, 5], length: [20, 40], radius: [1, 1.7] },
  scatter: [{ on: [T('hierba')], density: 0.05, structure: [[0, 0, 1, T('flor')]] }],
});
applyMap(map, grid);                                                   // o leer map.cells / mapColumn(map, x, y) / map.sown
```

- Salida:
  - `cells`, el material de cada celda;
  - `heights`, por columna, la celda más alta que no es aire ni agua;
  - `mapColumn(map, x, y)`, los tramos `[z0, z1, material]` de una columna;
  - `sown`, la lista de lo sembrado (`{ rule, x, y, z }`, con la estructura en `structures[rule]`), que no está en
    `cells`: lo escribe quien lo use.

  `applyMap` lo escribe todo en un `BlockGrid`: los tramos con `grid.fill` y lo sembrado con `grid.set`, que aplica
  las variantes tapadas y la luz que emitan.
- En orden:
  1. El relieve, con `fbmN` y la misma fórmula que `generateTerrain`.
  2. Los estratos, de arriba abajo.
  3. El agua hasta `seaLevel` en las columnas cuya superficie queda por debajo.
  4. La orilla: el lecho de los lagos, y la tierra a `width` columnas del agua que no sube más de 1 sobre el nivel.
  5. Las vetas: manchas de `size` celdas que crecen por vecinos dentro de los materiales `in` y de la franja `z`;
     `density` es la parte aproximada de esas celdas que acaba siendo veta.
  6. Las cuevas: gusanos que giran poco a poco y vacían esferas, sin tocar la capa 0 ni las columnas con agua.
  7. Lo sembrado: sobre su materia, fuera del agua, con su probabilidad y su distancia, solo si cabe sobre aire y no
     pisa lo ya sembrado.
- Determinista: la misma semilla y el mismo spec dan las mismas celdas y la misma lista en cualquier máquina (azar
  propio con semilla, sin reloj). `mapHash(map)` es su huella. `test/mapgen.test.ts` fija la de un spec, comprueba cada
  regla y que `applyMap` deja la rejilla igual que el mapa.
- `bun scripts/bench-mapa.ts`, sin freno, en un mundo de 384 x 384 x 96 vóxeles (48 x 48 x 12 bloques de 8):
  - generar, 1-2,5 ms (10 ms la primera vez, que incluye el arranque);
  - escribirlo en el mundo, 207-227 ms (~8 M vóxeles);
  - hornearlo, lo de siempre (ver Girar la cámara).
- `generateTerrain` sigue igual: trabaja con nombres de bloque y escribe directamente en la rejilla, sin agua ni
  cuevas.

## Mundo por regiones

El mapa por semilla generado por cajas de cualquier tamaño, en cualquier sitio y en cualquier orden
(`src/world/regiongen.ts`). Regla de oro: lo que sale en una región no depende de qué otras regiones se generaron antes
ni de en qué orden. Todo sale de la semilla y de la posición, así que un mundo sin bordes se genera a trozos según se
recorre, y el mismo sitio sale siempre igual.

```ts
import { generateRegion, applyRegion, regionHash } from '@voxpix/world/regiongen';
const r = generateRegion(spec, { x0, y0, z0, width: 16, depth: 16, height: 24 });   // celdas (bloques)
r.cells; r.heights; r.sown;              // lo sembrado cuya celda de arriba está en la región
r.touching;                              // lo sembrado que escribe alguna celda de la región (aunque nazca fuera)
applyRegion(r, grid, [gx, gy, gz]);      // la región en (gx, gy, gz) de un BlockGrid, con lo que la toca, recortado
```

El `spec` es el de `generateMap` (`MapSpec`), con `bottom` opcional. Cambia donde dependía del mapa entero o del orden:
- Relieve, estratos, agua y orilla: por columna, del ruido global, como en `generateMap`. El agua llena toda columna
  por debajo del nivel del mar.
- Vetas: cada celda de su materia empieza una mancha según un hash de la celda. La mancha crece con un azar sembrado
  por esa celda y no se aleja más de 3 celdas de ella (`VEIN_REACH`). Se calculan contra los estratos, y se aplican en
  orden de veta.
- Cuevas: gusanos por macrocelda de 32 x 32 columnas (`CAVE_CELL`). Cada macrocelda tiene los suyos por hash: de media,
  `caves.count` por cada `width` x `depth` columnas del spec, la densidad del mapa de siempre. Para una región se
  recorren los de las macroceldas que pueden llegar a ella (longitud y radio de su spec).
- Lo sembrado: el candidato sale por hash de la columna, como en `generateMap`. Se siembra si su prioridad (otro hash)
  es la mayor entre los candidatos válidos de su regla con los que choca: a menos de `spacing`, o que se pisan. Las
  reglas van en orden: una no puede pisar lo sembrado por las anteriores.
- Una estructura se siembra si cabe en el rango de z del mundo (de `bottom`, o de 0, a `height - 1`), no en la región:
  en x e y no hay borde.
- `bottom` (opcional): por debajo, aire (un abismo). Sin `bottom`, el último estrato sigue hacia abajo sin fin. Las
  cuevas no tocan la capa de abajo (`bottom`, o z = 0).
- `width` y `depth` del spec ya no limitan nada: solo dan la densidad de las cuevas.
- `generateMap` sigue igual (su huella fijada no cambia). `generateRegion` del mismo spec no da lo mismo: vetas,
  cuevas y siembra cambian de dibujo, con la misma densidad.

Pruebas (`test/mundo-regiones.test.ts`):
- Un mundo de 192 x 192 generado entero y en trozos de 16 x 16 en orden aleatorio da las mismas celdas, alturas y
  lista sembrada.
- Lo mismo cortado en z y lejos del origen, también en negativo.
- La huella fijada de una región de 64 x 64.

Si una pieza deja de ser local (vetas con un azar en serie, siembra sin margen, cuevas sin las macroceldas vecinas),
la prueba de 192 x 192 falla.

Escribir una región en la rejilla: `applyRegion` va vóxel a vóxel por `set` (un trozo de 16 x 16 bloques de 8 y 24 de
alto: 40 ms). `grid.stampRegion(r, at, opts)` deja lo mismo de una vez por trozo de vóxeles: compone cada losa con
índices de 1 byte desde las plantillas de sus bloques y la instala entera (`StaticVoxels.writeChunkPrepared`, o
`writeChunkSlabs` con valores). Sube una versión por trozo, avisa con la caja del trozo y deja las mismas alturas.
Lo sembrado sigue con `set` (variantes tapadas y luces).
- Vale si la región cubre trozos de vóxeles enteros con toda la altura de la rejilla; si no, hace `applyRegion`.
- `grid.stampRegionJob(r, at, opts)` es lo mismo por pasos para `FrameBudget`: las celdas, cada trozo de vóxeles y
  cada estructura sembrada.
- En Bun sin freno, por trozo de 16 x 16 x 24 bloques (`bun scripts/bench-region.ts`, dos tiradas, 2026-11-16):
  p50 4,9-5,8 ms y p95 8,7 ms; `applyRegion`, p50 43-52 ms. Cada paso, p50 0,03 ms y p99 0,2 ms.
- `test/trozo-rapido.test.ts`: los mismos vóxeles, alturas, celdas y luces que `applyRegion`, también por pasos y
  escribiendo encima de lo que había; los avisos de cambio son la caja de cada trozo; si no está alineada, hace
  `applyRegion`.

Coste, en Bun sin freno, con vetas, cuevas, árboles y flores (el spec de `test/mundo-regiones.test.ts`;
`bun scripts/bench-region.ts [trozos 36]`, dos tiradas, 2026-11-16):
- un trozo de 16 x 16 x 24: p50 1,7-2,3 ms y p95 3,5-4,1 ms. Paga sobre todo el margen de la siembra: unas 11
  columnas a cada lado para los árboles y las flores;
- una región de 96 x 96: 13,5-18 ms; `generateMap` del mismo tamaño, 4,9-13,8 ms (varía mucho entre llamadas).

## La ventana viva, 1: los vóxeles de la ventana

Un mundo sin bordes se tiene en memoria a trozos: una ventana de nx x ny trozos alrededor del objetivo
(`src/world/window.ts`). Sus vóxeles van en un `StaticVoxels` (`store`) con la esquina de la ventana en (0, 0). Moverla
es `StaticVoxels.shift(dcx, dcy)`: las losas, las paletas, las versiones y las máscaras de lo expuesto se corren en su
sitio por referencia (`copyWithin`, sin copiar ningún vóxel), y las alturas y la rejilla de pisar con una copia. Los
trozos de vóxeles que entran quedan vacíos, con versión nueva y su caja entera cambiada (para rehornearlos); los del borde
nuevo pierden sus máscaras (su vecino de fuera ahora es aire). `get`, `set` y lo demás no cambian. El juego sigue en
coordenadas del mundo (también negativas); la ventana resta su esquina.

```ts
import { WindowVoxels } from '@voxpix/world/window';
const win = new WindowVoxels(palette, 8, 13, 128, 0, 191);        // 8 x 13 trozos de 128 vóxeles (16 bloques de 8)
const grid = new BlockGrid(new WorldState(win.store, [], null), blocks);
const { entered, left } = win.moveTo(tx0, ty0);                  // corre el store; los que entran, del centro hacia fuera
for (const [tx, ty] of entered) {
  const [cx, cy] = win.slotCell(tx, ty, 8);
  grid.stampRegion(generateRegion(spec, { x0: tx * 16, y0: ty * 16, z0: 0, width: 16, depth: 16, height: 24 }), [cx, cy, 0]);
  win.markLoaded(tx, ty);
}
win.get(x, y, z);                                                // coordenadas del mundo; fuera, o sin escribir, aire
```

- El trozo es múltiplo de `CHUNK` (y el store, de ancho y fondo múltiplos de `CHUNK`).
- Un trozo que todavía no se escribió no es del mundo: `get` da aire y `set` falla (`holds`, `has`).
- Coste (`bun scripts/bench-ventana.ts`, Bun sin freno, 2026-11-16): una ventana de 8 x 13 trozos (1024 x 1664 x 192,
  213 MB de vóxeles); correrla un trozo, p50 1,1 ms, p95 2,1 ms (una vez por trozo que se cruza).
- Pruebas: `test/ventana-shift.test.ts` (correrse y escribir lo que entra da lo mismo que la ventana hecha de nuevo:
  vóxeles, alturas, suelo de pisar y lo expuesto, con las máscaras hechas antes de correrla) y
  `test/ventana-voxeles.test.ts` (la ventana moviéndose, también en negativo, contra el mundo fijo generado de una vez).
- La imagen horneada se corre con ella: `shiftBaked(b, dcx, dcy)` (`bake.ts`) llama a `shift` y corre la imagen
  (-dcx·CHUNK columnas, +a·dcy·CHUNK filas), resta a la profundidad dcy·CHUNK·fwd[1] y a las claves de vóxel (`pick`,
  lineales) la del corrimiento, borra lo que se ve de vóxeles que salieron (al correr en y siguen dentro de la imagen) y
  su contorno, y pone cada luz fija en su sitio nuevo con su zona recortada otra vez y sus pesos (la que gana píxeles por
  el borde se hornea de nuevo). Lo que entra y el borde nuevo quedan cambiados: `rebakeChanged` con las luces corridas
  los rehace. Las copias (la GPU) recargan la imagen entera. `test/ventana-horneado.test.ts`: correr (también dos veces
  en sentidos contrarios) y rehornear = hornear de nuevo ahí, en imagen, cara, vóxel, cielo, profundidad (a 1e-3) y
  pesos de las luces, con antorchas a los dos lados del borde.
- Las claves de vóxel (`key`) cubren -2048..2047 por eje (`KEY_OFF`, `KEY_SPAN`; antes -1024..1023, que no llegaba a
  una ventana de 13 trozos de 128).
- Por pasos: `shiftBakedJob(b, dcx, dcy, { band })` hace la imagen nueva en otro búfer (se turnan) por bandas de filas,
  como trabajo de la cola, mientras se sigue componiendo y rehorneando la vieja. Antes de cambiar vuelve a copiar lo
  rehorneado mientras tanto, y el cambio (vóxeles, búferes y luces, de golpe) espera a que no quede rehorneado a medias.
  Cruzar otro borde antes de acabar: `job.merge(dcx, dcy)` suma el corrimiento y empieza la copia otra vez (desde la
  imagen de ahora, que sigue siendo la vieja). `shiftBaked` es el mismo trabajo de una vez.
- Tras el cambio, la GPU corre sus texturas dentro de sí (`b.lastShift`): color, cara y cielo con `blitFramebuffer`,
  profundidad e y del mundo con un paso que les resta lo suyo, y sube solo lo publicado con el corrimiento (lo borrado);
  si no estaba al día justo antes, lo vuelve a subir todo.
- Oráculo: "ventana corrida" (la imagen corrida un trozo, CPU = GPU) y "ventana corrida y vuelta" (vuelve al sitio y la
  vista es byte a byte la de antes, en CPU y en GPU), en dos giros, con antorchas a los dos lados del borde; la GPU se
  corre dentro de sí una vez y dos (`gpuShifts`).
- El cambio va en dos cuadros: primero los vóxeles (`shift`; mientras, lo que escribe en la imagen espera:
  `b.shiftHold`), luego la imagen y las luces. `shift` no mueve las máscaras de lo expuesto (las da por caducadas: se
  rehacen donde se rehornea) y solo recorre el borde.
- Coste en la ventana de 8 x 13 (imagen 1026 x 1036):
  - Bun sin freno (`bench-ventana`): de una vez, p50 9,7 ms; por pasos con bandas de 32 filas, 34 pasos de p50 0,5 ms;
    `shift` de los vóxeles, p50 0,4 ms.
  - Los vóxeles también van en dos búferes: `StaticVoxels.shiftJob(dcx, dcy)` prepara las referencias de las losas, las
    alturas y las cajas de lo cambiado por filas de trozos (con las bandas de la imagen), y `commit` vuelve a copiar lo
    que cambió mientras tanto, cambia los búferes y corre lo pequeño en su sitio; la rejilla de pisar queda sucia (se
    rehace al pedirla). La GPU guarda las texturas de antes como repuesto y, la primera vez, las crea de una en una
    mientras se prepara (`b.shifting`).
  - `compositor.upload(b)` calienta el camino del corrimiento en la GPU (un corrimiento de cero que deja las texturas de
    repuesto hechas).
  - Edge con GPU a 6x (`app/ventana.html?medir=1`, cola del juego, un trozo cada 192 cuadros), dos tiradas: la copia,
    19-24 cuadros; el cuadro de los vóxeles, 6-12 ms (`commit` 2,7-4,9); el del cambio de imagen, 2,6-4,6 ms, salvo el
    primero, 15-17 ms (aún sin explicar: ni las texturas ni el primer uso del camino, ya calentados); el resto, p50
    2,3-2,4 ms, p95 3,8-4,8.
- Aún no: `LiveWindow` y el banco de andar.

## La ventana viva, 3: LiveWindow

`src/world/live.ts` junta todo lo anterior: una ventana de nx x ny trozos de un mundo por regiones alrededor de un
objetivo, que se corre por la cola cuando el objetivo se acerca a un borde.

```ts
import { LiveWindow } from '@voxpix/world/live';
const win = new LiveWindow({
  blocks, spec, nx: 9, ny: 11, chunk: 16, center: startTrozo, margin: { x: 4, n: 6, s: 4 },
  bake: { incline: 0.5, sky: true, outline: 'both' },
  fill(t, ctx) { /* opcional: el juego escribe el trozo (lo generado y lo guardado) y devuelve un trabajo de la cola */ },
  onUnload(t, ctx) { /* el trozo t sale: guardar sus diferencias (ctx.cell, ctx.read) y quitar sus entidades */ },
  onLoad(t, ctx) { /* sin fill: poner lo guardado (ctx.setCell, ctx.write), antes de hornearlo */ },
  onShift({ cells, voxels }) { /* lo que estaba en la x local pasa a x - voxels[0] (en celdas, - cells[0]) */ },
});
// cada cuadro
win.update(objetivoX, objetivoY, budget);       // coordenadas del mundo; mete el trabajo en la FrameBudget
compositor.frame(win.state, win.baked, opts);
```

- El arranque (el constructor) escribe y hornea toda la ventana de una vez (detrás de una pantalla de carga); después,
  todo por la cola.
- `margin`: trozos entre el del objetivo y el borde; al quedar menos, se corre un trozo. Por lado (`{ x, n, s }`): en
  la vista oblicua lo visible llega más lejos al norte (lo alto de allí sube a la imagen) que al sur. Para una vista de
  384 x 216 con 96 de alto y 2 trozos más allá de lo visible: 4 a los lados, 6 al norte y 4 al sur, ventana de 9 x 11.
- Al correrse: `onUnload` de los que salen (aún en la rejilla), `shiftBakedJob` (imagen y vóxeles por pasos), y en el
  cambio, de una vez, la rejilla de bloques (`BlockGrid.shift`: celdas, giros; las luces de los bloques que salen se
  quitan), las entidades y las luces del `state`, lo que se mueve por su cuenta con posiciones del `state`
  (`WorldState.shiftDynamic`: las gotas, la posición continua de lo que flota y las partículas y emisores de los efectos),
  lo enganchado (`attach`: caminos, el agua) y `onShift`. Después, por cada trozo que entra (del centro hacia
  fuera), `fill` del juego o lo de siempre (`generateRegion`, `stampRegionJob`, `onLoad`), y `rebakeChangedJobs`.
- El contexto de cada trozo (`TrozoCtx`) va en coordenadas del MUNDO: `read`/`write` (vóxeles), `cell`/`setCell`
  (celdas, con el giro en grados), y `grid` con `at` (la celda local de la esquina del trozo).
- `toLocal` / `toWorld`, `trozoOf`, `isLoaded`, `busy`, `ctx(t)`.
- `test/ventana-viva.test.ts`: un objetivo que anda y vuelve, con lo picado puesto por `onLoad`; y con `fill` (celdas
  guardadas con giro) y `onShift`. Lo horneado y la rejilla quedan como en una ventana hecha de nuevo ahí, y una
  entidad sigue en su sitio del mundo.
- Giros (`quarters: [0, 1, 2, 3]`): cada giro tiene su vista (`WorldView`, con su copia girada) y su horneado, y
  todos se tienen al día. Al correrse, cada uno prepara su imagen en sus ejes (`dirToView`) con `shiftBakedJob` en modo
  `manual` (el que se ve, primero) y el cambio es de todos a la vez (`canCommit` en todos y, si pueden, `commit`). Lo que
  entra se rehornea en todos; lo que pica el juego, en el giro de ahora lo rehornea él (como siempre) y en los demás
  `update`. `turn(q)` cambia sin esperar: `win.view` y `win.baked` pasan a ser los de q (hay que volver a subirlo a la
  GPU). Las copias giradas se ponen al día por losas (`StaticVoxels.copyRotatedChunk`).
- Girar con fundido (`turnTo(q)`, sin `quarters`): solo vive el giro de ahora. Los cuatro al día cuestan ~5 s de CPU
  por trozo cruzado; uno, ~0,7 s. Al pedir otro giro, su vista se hace por pasos y el juego tapa la espera con un fundido
  mientras `win.turning.phase === 'core'`:
  1. Lo visible primero, con `viewport: [ancho, alto]` (los píxeles que enseña la cámara, centrada en el objetivo).
     Se copian girados los trozos de vóxeles que caen en ese recuadro, más uno alrededor (lo que miran la oclusión y el
     cielo). Su horneado se hace con `rebakeJobs(..., clip)` sobre una imagen vacía: solo los píxeles del recuadro, con
     16 de margen. Va con prioridad 0 (el presupuesto cercano).
  2. El cambio: `win.view` y `win.baked` pasan a ser los del giro nuevo (hay que subirlo entero a la GPU) y el de antes
     se suelta.
  3. `phase === 'rest'`: se copia lo demás y se marca como cambiado (`StaticVoxels.touch`). Lo rehace la cola de
     siempre, como un trozo que entra.

  Mientras se gira, no empieza ningún corrimiento. Uno ya empezado no hace esperar al giro: es su cambio el que espera
  a que acabe el giro (núcleo y copia de lo demás), y en el cambio de giro pasa a la vista nueva. Sin el giro 0, los vóxeles del mundo se corren aparte
  (`StaticVoxels.shiftJob`), en el mismo cuadro que los giros. Pedir otro giro durante el fundido cambia el destino:
  `turnTo((win.turnTarget + 1) % 4)` dos veces seguidas es medio giro, y volver al de ahora lo cancela.

  Sin freno, en la ventana de 9 x 11 con el recuadro de 384 x 216, el núcleo cuesta 300-350 ms de CPU (unos 30 de
  copia, el resto recuadro y cielo). Lo demás, unos 3,5 s por la cola normal (`bun scripts/bench-viva.ts 1 0` con
  `GIRAR=1`). En el navegador: `viva.html?girar=6` (Q cada 6 s; `presu=ms`, el presupuesto cercano durante el fundido).
- Caminos: `PathField` y `LevelPathField` se enganchan con `win.attach(campo)` y se corren en el cambio (sus celdas,
  pasos guardados y distancias; lo que entra, sin suelo hasta que se escribe su trozo). `LevelPathField` no copia sus
  rejillas al correrse: son un anillo, se corre su origen y se limpia solo la franja que entra (copiar eran ~30 MB por
  cambio en una ventana de 11 x 13 trozos, 15-17 ms a 6x en un juego, y el primero además la memoria nueva, más de
  100 ms); a cambio, cada nodo buscado cuesta un 5-10 % más. Con `budget`, el borde del lado que sale (las celdas
  cuyo cuerpo llegaba a lo que salió) no se rehace en el cambio: va a lo pendiente y lo rehace `advance` con su tanda (en
  un juego eran ~30 ms de ese cuadro a 6x). Ese borde, y el margen de lo que cambió, salen de lo que el cuerpo de una
  celda sobresale de ella (desplazado y con su radio): con un radio grande (6 con celdas de 4) eran más que radius + 1,
  y el borde se quedaba corto. Y lo que entra se limpia sin vaciar sus pasos guardados (`moves`, ~128 bytes por celda con 4
  niveles): solo se miran entre nodos con suelo, y lo que entra queda sin suelo hasta que `redo` lo rehace al escribirse,
  vaciando entonces sus pasos y los de sus vecinas. Además, en el cambio la ventana
  corre lo apuntado y sin tomar de todos los `watchChanges` (`ChangeWatch.shift`), así que también vale para los del
  juego. Con una ventana grande, una meta que se mueve costaría una búsqueda de todo el campo cada vez que cambia de
  celda: `reach` (40 pasos por defecto) para la búsqueda a esa distancia de la meta, y más lejos no hay camino (`dir`
  da null). `findPath` sigue sin tope.
- Cortes de casa de muñecas: `view: { cut: true }` da a las vistas de la ventana su copia para `setCut` / `cutJob` (en
  `win.view`). En el cambio, `WorldView.shift` corre el corte (desde qué z está escondida cada columna, las cajas, que
  quedan recortadas a la ventana, y lo pendiente, que sigue el `cutJob` que esté en la cola), antes de `onShift`. Con el
  giro 0 copiado, los vóxeles del mundo se corren aparte. La capa de sección (`SectionPainter`) ya se rehace sola al
  correrse (lo pintado está en las coordenadas de antes); tras `turnTo` el horneado es otro y hace falta un pintor nuevo.
- Carga del principio por la cola: `preload: 'queue'` (la ventana vacía, los trozos del centro hacia fuera con prioridad
  0 y su rehorneado cercano) y `win.ready(x, y, anillo)` para quitar la pantalla de carga.
- Aún no: el agua por ventana.

## Caminos por niveles

`PathField` tiene un suelo por celda (el de arriba). Para bichos que entren en túneles, cuevas o pisos,
`LevelPathField` (`src/world/levelpaths.ts`) guarda varios por celda (los que tienen hueco para el cuerpo, de arriba
abajo, hasta `levels`) y busca entre ellos:

```ts
import { LevelPathField } from '@voxpix/world/levelpaths';

const field = new LevelPathField(state, { cell: 4, radius: 2, height: 16, step: 8, maxDrop: 24 });
const d = field.dir({ x, y, z }, { x: px, y: py, z: pz }, 6);   // con la z: elige el suelo más cercano a ella
const ruta = field.path(desde, hasta);                           // los centros de las celdas, con su suelo
field.floorsAt({ x, y });                                        // los suelos de una celda, para depurar
```

- Se pasa a una celda vecina subiendo como mucho `step` y bajando como mucho `maxDrop`, y el cuerpo pasa a la altura
  mayor de los dos suelos: cae por un pozo, no atraviesa el techo de un túnel, y no sube por un pozo si `step` no
  llega. Lo demás, como `PathField`: BFS hacia atrás compartido por todos los que van a la misma meta, rehecho por
  `watchChanges` solo en las celdas tocadas.
- Va con `moveBodyLevels` (mismos `step` y alto).
- Un suelo cuenta si el cuerpo (de `radius` y `height`) cabe de pie sobre él. Primero se prueba centrado en la celda;
  un cuerpo más ancho que media celda sobresale de ella y entonces se prueba también corrido dentro de lo que
  sobresale, para que lo que sobra quede de un lado. Sin eso, la celda junto a una pared o a la cara de un escalón no
  tenía nunca suelo con `radius` >= `cell` / 2, y no se subía ni un escalón (hay prueba: escalón de un bloque con radius
  1, 2 y 3). Un cuerpo que cabe centrado (radius 1 con celdas de 4) no se corre: el campo es el de siempre. Con radius
  3 construir cuesta más (en el banco de bloques, `MUNDO=bloques RADIO=3`: ~36 ms, contra ~27 sin probar el cuerpo
  corrido; con radius 1, ~11-16, sin cambio); buscar, lo mismo.
- Guarda lo que da cada paso entre dos nodos vecinos (si se pasa o no) y solo lo borra donde cambia el mundo (las
  celdas tocadas y sus vecinas: un paso mira las dos celdas y, en diagonal, las dos de lado). Una búsqueda nueva con el
  mundo igual no vuelve a mirar columnas; el resultado es el mismo que con un campo nuevo (hay prueba, también con un
  cambio que solo toca el paso que llega a una celda desde su vecina).
- Búsqueda repartida, para no buscar entera en el tick en que cambia la meta:

  ```ts
  const field = new LevelPathField(state, { ...opciones, budget: 2000 });   // nodos por advance()
  // En cada tick de la simulación
  field.advance();                                // sigue la búsqueda pendiente, 2000 nodos como mucho
  const d = field.dir(desde, meta);               // pide la meta y contesta con la última búsqueda acabada
  ```

  Va por nodos, no por reloj: la simulación tiene que dar lo mismo en cualquier máquina. Mientras busca, `dir` y
  `path` contestan con la última acabada (la primera vez, `null`). Si piden otra meta a media búsqueda, se acaba la que
  está en marcha y después se busca la última pedida (si se empezara de cero cada vez, una meta que se mueve deprisa no
  se acabaría nunca). Un cambio del mundo a media búsqueda la tira y se rehace. Con cualquier tanda, las distancias son
  las mismas que buscando de una vez (hay prueba con tandas de 1, 7 y 100 nodos). Sin `budget`, como siempre.
  `field.lag` dice cuántos `advance()` seguidos lleva la respuesta sin ser la de la última meta pedida (0: al día): si
  la meta cambia más deprisa de lo que da la tanda, crece; es el número para elegir la tanda.
- Coste (`bun scripts/bench-caminos.ts`: terreno de bloques de 384 x 384 x 96 con un túnel; celdas de 4, radio 1, alto
  14, step 8, maxDrop 64; 96 x 96 x 4 nodos; sin freno): construir ~10 ms; una búsqueda entera ~0,4 ms (p95 ~0,5; antes
  de guardar los pasos y saltar los niveles vacíos, ~1,0-1,2 y p95 ~1,7); tras picar, lo mismo. Repartida en tandas
  de 2000 nodos: cada `advance()` p95 ~0,1 ms, máximo ~0,2. En un mundo con más relieve, más suelos por celda y
  más diagonales que mirar, cuesta varias veces eso; la proporción se mantiene.

## Moverse por niveles

`moveBody` apoya los pies en lo más alto de cada columna: no puede estar debajo de nada. Para túneles, cuevas e
interiores con techo, `moveBodyLevels` (`src/runtime/levels.ts`) mueve un cuerpo con alto que anda por debajo de los
techos, cae por los huecos y salta. Es aparte: `moveBody` no cambia.

```ts
import { moveBodyLevels, LEVEL_RULES, type LevelBody } from '@voxpix/runtime/levels';

const jugador: LevelBody = { x, y, z, r: 3, height: 24, vz: 0 };
// Cada tick: lo que anda en x e y, y si salta
const m = moveBodyLevels(state, jugador, dx, dy, saltar, { ...LEVEL_RULES, step: 2, jump: 1.6 });
if (m.landed > 40) { /* una caída de más de 40 vóxeles: lo que el juego quiera */ }
```

- El cuerpo es un cilindro de radio `r` y alto `height` con los pies en `z`. Anda subiendo escalones de hasta `step`;
  donde el suelo queda más abajo, sigue a su altura y cae con `gravity` (vóxeles por tick²) hasta `maxFall`; con
  `jump` y en el suelo, salta con esa velocidad. Un techo corta el salto, y no se mete donde no cabe entero.
- Devuelve `blocked` (algo frenó el paso), `grounded` (está apoyado) y `landed` (lo que cayó, si acaba de aterrizar).
- `footBelow(state, x, y, z)`: el suelo más alto de la columna con la cara de arriba en `z` o por debajo (la cara de
  arriba del primer vóxel que bloquea bajando), o `NO_FOOT`.
- Lo que bloquea es lo de siempre (los materiales: `blocks`), y lo que no se sube (`climb: false`) no es suelo. El borde
  del mundo es pared. Los objetos despiertos no cuentan todavía.
- Determinista: sin reloj ni azar. Por cuerpo y tick, ~1 µs al aire libre (sin freno; 200 cuerpos, ~0,2 ms); debajo
  de techos, algo más.
- Dentro de una llamada guarda lo que da el suelo de cada columna (los subpasos pisan casi las mismas) y el último
  apoyo (el del final suele repetir el del vertical): los mismos resultados, ~20 % menos por llamada
  (`bun scripts/bench-niveles.ts`: 20 cuerpos de radio 3, ~3,3 -> ~2,6 µs en el mundo de bloques).
- Trepar: los vóxeles de un material con `ladder` (el material `escala`: se cruza, deja pasar algo de luz y se trepa)
  se suben y se bajan. Mientras el cuerpo toca uno (su huella, el radio y medio vóxel más, entre los pies y la cabeza),
  el último argumento, `up`, lo mueve en z: 1 sube, -1 baja y 0 lo deja donde está, a `ladderSpeed` vóxeles por tick
  (por defecto `LADDER_SPEED`, 0,5), sin gravedad y sin caída que contar. Sube lo que deje el techo y baja hasta el
  suelo. Para salir por arriba se anda hacia el suelo de arriba: el escalón lo sube encima. El motor no sabe qué es
  una escalera: quien lo usa marca el material. Devuelve `climbing` (trepa en este tick). Sin vóxeles que se trepan,
  todo es como antes (`test/escalas.test.ts`). Mirar si el cuerpo toca escala recorre su huella entre pies y cabeza
  (radio 3 y 14 de alto: ~500 lecturas del sólido por llamada) aunque no haya ninguna: un cuerpo que no trepa (los que
  van por un campo de caminos, que no sabe de escalas) lleva `ladderSpeed: 0` y se ahorra la búsqueda; para él las
  escalas solo se cruzan.

```ts
const m = moveBodyLevels(state, jugador, dx, dy, saltar, reglas, arriba ? 1 : abajo ? -1 : 0);
```

## Caminos

Para que algo que anda (un enemigo, un animal) vaya hacia un sitio rodeando lo que no se puede pasar, sobre el suelo
de las columnas del mundo, con escalones y caídas.

```ts
import { PathField, findPath } from '@voxpix/world/paths';

const field = new PathField(state, { cell: 4, radius: 2, step: 8, maxDrop: 16 });
// Cada tick, por cada uno que persigue a (px, py): hacia dónde moverse (unitario), o null si ya llegó o no hay camino
const d = field.dir({ x: e.x, y: e.y }, { x: px, y: py }, 6);
const ruta = field.path(desde, hasta);                 // los centros de las celdas, con su suelo en z
findPath(state, desde, hasta, { step: 8 });           // un camino suelto, sin guardar el campo
field.at({ x, y });                                    // { floor, dist } de una celda, para dibujar o depurar
field.close();                                        // al tirarlo: deja de oír los cambios del mundo (LevelPathField, igual)
```

- La rejilla es de celdas de `cell` vóxeles. El suelo de una celda es el de su centro (`state.footing`: lo más alto
  que se pisa, con los objetos despiertos); cabe un cuerpo de radio `radius` si todas las columnas a esa distancia se
  pisan y ninguna sobresale más de `step`.
- De una celda se pasa a sus 8 vecinas (en diagonal, solo si también se puede por las dos de lado) subiendo como mucho
  `step` y bajando como mucho `maxDrop` (sin límite por defecto).
- Las distancias a la meta salen de un BFS hacia atrás desde la celda de la meta (y las que tengan el centro a `near`
  o menos). Se guardan: muchos cuerpos hacia la misma meta comparten una búsqueda, que se rehace al cambiar la meta o
  el mundo. Los cambios del mundo llegan por `watchChanges` y rehacen solo las celdas tocadas.
- `dir` lleva a un cuerpo encajado en una celda sin camino hacia la vecina con camino más cercana (a 2 o menos).
- Solo superficie: una celda tiene un suelo, el de arriba; no ve túneles ni cuevas.
- En un terreno de 384 x 384 con celdas de 4: construir el campo ~6 ms, una búsqueda ~2 ms, ponerse al día tras picar
  un bloque ~1 ms (sin freno).
- Lo que decide cuándo perseguir, cuándo rendirse o a quién es del juego.

## Entidades

```ts
const id = state.entities.add({ model, x, y, z, facing: 90, castsShadow: true });
state.entities.move(id, x, y, z, facing);   // facing en grados: 0 = sur (hacia la cámara), 90 = este
state.entities.setModel(id, otroModelo);     // otro cuadro de la animación
state.entities.setTint(id, [1, 1, 1]);       // destello de golpe: color plano con luz propia; null lo quita
state.entities.remove(id);
```

- Una entidad cuyo modelo no tiene vóxeles (un cuadro de animación vacío, un modelo aún sin cargar) no se pinta, no da
  sombra ni sombra de contacto, y la consola lo avisa una vez por modelo. Antes, en la GPU, su caja vacía rompía el
  cuadro (`RangeError: Invalid typed array length: -Infinity` en `syncOcc`).
- `facing` puede ser negativo o pasar de una vuelta: el cuerpo que da sombra va girado a su cuarto de vuelta más
  cercano. Un valor que no es un número cuenta como 0.

- `castsShadow`: `true` compite por las sombras de verdad (como mucho 8 por cuadro, las más cercanas al centro de la
  vista); `'always'` la reserva siempre (el personaje).
- Las rampas `emissive` del modelo brillan solas.
- Los materiales del escenario (docs/render.md, Materiales) mandan en el mundo: la luz horneada atraviesa lo que deja
  pasar luz (follaje, vidrio) y las caras con `backlit` reciben luz por detrás, también de las luces dinámicas.
  `groundAt`, `solidAt` y `raycast` atraviesan lo que no bloquea (la hierba; no los arbustos ni el vidrio), y el agua
  se apoya en `floorAt`, el suelo sin lo que no es fondo (el follaje). `standable` no deja pisar una columna cuyo
  vóxel de arriba no se sube (`climb: false`, los arbustos): es como una pared a cualquier altura, y su cúpula ya no
  sirve de escalera. `planFoliage` (src/core) coloca
  vegetación en cualquier cosa con `palette` y `get`, también en un `StaticVoxels`.
- El sprite de cada modelo y giro se guarda (con tope: los menos usados se sueltan). Conviene girar en los 8 rumbos
  (`HEADINGS` de `world/frame2d`) y precalentar con `compositor.prewarm` lo que vaya a salir, para que el primer
  cuadro no pague el render.

## Animaciones con nombre

Un `.voxpix.json` hecho con el editor puede traer varios clips (quieto, andar, atacar, morir). En un juego:

```ts
import { clipsFromFile, clipFrameAt, clipDone } from '@voxpix/core';
import bichoFile from './bicho.voxpix.json';

const clips = new Map(clipsFromFile(bichoFile).map((c) => [c.name, c]));
// Cada cuadro de la entidad: el clip que toque y el tiempo desde que empezó (en ticks de la simulación, si debe ser
// determinista)
const c = clips.get(estado)!;
state.entities.setModel(id, c.frames[clipFrameAt(c, ms)]!.model);
if (clipDone(c, ms)) { /* un clip que no se repite (atacar, morir) acabó: el siguiente */ }
```

- `clipFrameAt(clip, ms)`: el cuadro a los `ms` de empezar; si el clip se repite, da la vuelta; si no, se queda en el
  último. `clipDone(clip, ms)`: si un clip que no se repite ya acabó.
- Las versiones 1 y 2 del archivo se leen como un clip `anim` que se repite.
- Conviene precalentar (`compositor.prewarm`) los cuadros de todos los clips que vayan a salir. Se puede hacer de
  golpe (una lista) o poco a poco, unos sprites por cuadro detrás de una pantalla de carga: cada llamada cuesta lo suyo
  (dibujar y subir sus sprites, unos 2 ms por sprite a 6x), no lo de todo lo que ya hay. Los cuerpos de cada modelo
  (para el rayo de su luz y para su sombra) van en dos atlas 3D en la GPU que suben solo lo nuevo y se rehacen enteros
  solo al quedarse pequeños (el doble de ancho). Antes se rehacían y se subían enteros con cada modelo nuevo: con 120
  modelos con sombra ya subidos, una llamada de 2 sprites costaba 82-86 ms a 6x (la peor 137); ahora, 3,9 (la peor
  8,5-10). `app/multitud.html?medir=prewarm&extra=120` lo mide; `GpuCompositor.atlas3DStats()` dice cuántas veces se
  rehizo cada atlas y cuántos cuerpos se subieron sueltos.

## Luces

```ts
state.lights.add({ kind: 'lamp', x, y, z });                                    // de punto, dinámica
state.lights.add({ kind: 'lantern', x, y, z, dir: [0, -1, -0.3], cone: 40 });   // un foco
state.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: id, offset: [6, -4, 14] } });   // va con una entidad
```

- Los tipos y sus valores por defecto (radio, color, intensidad, parpadeo) están en `src/lighting/lights.ts`. Se
  pueden ajustar con `intensity`, `radius` y `color`.
- Las luces del escenario son fijas y se hornean; las que se añaden con `add` en partida son dinámicas (se calculan
  en cada cuadro, pueden moverse y seguir a una entidad).
- Una luz fija puesta en partida (una antorcha que se coloca y se queda): `state.lights.addFixed({ kind, x, y, z })`
  da su id, y `state.lights.removeFixed(id)` la quita. `rebakeChangedJobs(baked, luces)` compara las fijas de la lista
  con las horneadas: hornea entera la que falta (un trabajo, aunque no haya cambiado ningún vóxel; si se pide cada
  cuadro, no se repite) y deshornea al momento la que ya no está. Por eso hay que pasarle siempre TODAS las luces (las
  de la vista, si la cámara gira). Una fija cuesta al ponerse y nada después; una dinámica, cada cuadro.
- La GPU suma como mucho 32 luces por cuadro y 32 fijas horneadas: las que alcanzan la vista y, si son más, las más
  cercanas a su centro (las demás no se ven). La CPU las suma todas; las dos dan lo mismo mientras en la vista haya
  32 o menos. Cada fija guarda su capa en la GPU mientras siga en la vista, y de una luz rehecha en parte solo se sube
  el recuadro que cambió.
- `owner` es la entidad que lleva la luz: su cuerpo no le hace sombra.
- `Frame2DOptions.entityLightCap` limita cuántas luces alumbran a cada entidad, para máquinas modestas.

## El aspecto del mundo

El motor no sabe de temas. `buildWorldState(layout, look)` construye con lo que diga el `WorldLook`:

```ts
const look: WorldLook = {
  // Las rampas en el orden de M (suelo, pared, tapa, columna, agua, madera, metal...). Las que no digas, por defecto
  palette: worldPalette({
    floor: ['#22262e', '#323844', '#464e5e', '#5e687c', '#76829a'],
    water: { colors: ['#0a2a10', '#145a20', '#22a03a', '#4ee060', '#b0ffb8'], emissive: true },   // brilla solo
  }),
  fountain: false,               // el pilón con agua y fuego; por defecto no
  wallHeight: 16,                // el alto de TODAS las paredes (por defecto 16)
  pillar: miMampara,             // quien construye cada columna del mapa; por defecto roundPillar; null, ninguna
};
```

- **El líquido** es la rampa `agua` de la paleta del mundo: su color (de 2 a 5 tonos o más, del hondo a la espuma) y,
  si la rampa es emisiva (`emissive: true` o un material emisivo), la superficie brilla sola, sin que la luz del mundo
  la oscurezca. CPU y GPU dan lo mismo. Las luces que quieras sobre el líquido las pones tú, como cualquier `WorldLight`.
- **Las columnas**: el mapa marca dónde van (`layout.pillar`); `pillar(site)` las construye. `site` trae la loseta en
  ejes del modelo (`x0..x1`, `y0..y1`, de TILE x TILE), su centro (`cx`, `cy`), el `model` y un `noise(x, y, z)`
  determinista. La colisión es la de los vóxeles que pongas: lo que no ocupes, se puede cruzar.
- **Las demás piezas del mapa**, con el mismo patrón. El motor no lee los nombres que pone el generador: se los pasa
  a quien construye. Sin constructor, hace lo más sencillo:

  | Campo del look | Se llama con | Por defecto |
  |---|---|---|
  | `floor(site)` | cada losa seca: `kind` (de `layout.floor`), `lx`, `ly`, `tone`, `noise`; devuelve el vóxel | `plainFloor`: la losa con su tono |
  | `facade(site)` | cada tramo de la fachada norte: `piece`, `x0`, `faceY` y `carve()` para tallar huecos | nada: la pared lisa |
  | `fixture(site)` | cada fuente de luz de la fachada: `source`, `x`, `faceY` y `lights` para poner la suya | `lightOnlyFixture`: solo la luz |
  | `prop(site)` | cada mueble (`layout.props`): `prop`, su huella `x0..x1`, `yS..yN` y `lights` | `blockProp`: un bloque de madera; `null`, ninguno |

  Los de la muestra (puertas, ventanas, antorchas, escritorios) están en `src/samples/pieces.ts` (`SAMPLE_PIECES`).
- **Sin código**: todo esto también se describe como datos en una receta (`src/world/recipe.ts`), que es lo que usan
  los agentes con `window.voxpixWorld` y `voxpix world`. Ver `docs/api-mundos.md`.
- **Lo demás** (vegetación, cables, adornos) va en `decorate(world)`, antes de crear el agua y el estado. Para algo que
  se cruce y no deje pasar la luz (cables, alfombras), una rampa con `material: 'atravesable'`.

## El cielo: oscuro bajo techo

Con `bakeWorld(mundo, { ..., sky: true })` el horneado guarda, por píxel, cuánto cielo ve la cara que se ve ahí: de 0
a `SKY_RAYS` (5) rayos que salen hacia arriba y llegan (el vertical, y 4 en diagonal de `SKY_REACH` = 8 vóxeles que,
si no chocan, miran arriba desde donde acaban). Al componer, `Frame2DOptions.cave` es la luz ambiente sin cielo:

```ts
const baked = bakeWorld(view.bakeable(), { topZ, incline, sky: true });
compositor.frame(rs, baked, { ...opciones, ambient: day.ambient(tick), cave: [0.08, 0.07, 0.12] });
```

- Cada píxel del escenario recibe de `cave` (sin cielo: cuevas, túneles, bajo techo) a `ambient` (todo el cielo), en
  6 niveles (`skyAmbient`: la tabla, en float32, que usan la CPU y la GPU). Las luces se suman encima: una antorcha
  en una cueva se nota mucho más. Las entidades toman el nivel del píxel de sus pies (`entitySky`): un bicho bajo
  techo se oscurece como el suelo que pisa, con la misma tabla en la CPU y en la GPU; al aire libre, como siempre.
- Lo que cambia el cielo de un píxel está a 8 columnas como mucho: al picar, poner o cortar la vista, se rehace por
  caja como las luces fijas (un trabajo `sky:` en la cola, que se publica de una vez). Igual, byte a byte, que hornear
  de cero (hay pruebas, también con el corte de vista en los 4 giros).
- Sin `sky` en el horneado o sin `cave` al componer, todo es como antes (las huellas de siempre).
- Tolerancia conocida en el oráculo (`medieval bajo tejado (cielo y cueva)`, RTX 4090 con ANGLE): 49 píxeles de
  82.944 en el giro 0 y 7 en el giro 1 difieren en ±1 en un canal. No es el cielo ni la luz: multiply y add son
  idénticos en la CPU y en la GPU. Es el color del agua de `WaterLayer.draw`, el mismo valor en las dos rutas,
  redondeado distinto al pasarlo a byte:
  - en la superficie (tono 3 que refleja el suelo al 38 %) el verde vale 99,54: la CPU da 100 y la GPU 99;
  - en el fondo visto a través del agua, 110 × 0,85 = 93,5 justo: la CPU da 94 y la GPU 93.

  La causa es la mezcla con pesos del agua y una conversión de float a byte en la GPU con menos precisión que la de
  la CPU. Es una inferencia: una conversión con unos 12 bits cuadra con los tres canales y los dos casos, pero no
  está leída en documentación del fabricante. El oráculo la tolera por diseño (`scripts/oracle/README.md`): ±1 suelto
  en un byte, muy por debajo del 0,5 % de píxeles.
- Coste: en un terreno de 384 x 384 x 96, el horneado entero pasa de ~0,51 a ~0,58 s y cada bloque picado añade un
  trabajo de ~0,2-0,5 ms (sin freno).

## El ciclo del día

La luz ambiente (y, si se quiere, el fondo) a lo largo del día, por claves. La hora sale del tick de la simulación:
la misma en cualquier máquina y en una partida repetida.

```ts
import { DayCycle } from '@voxpix/lighting';

const day = new DayCycle({
  ticksPerDay: 36000,                                   // 10 minutos a 60 ticks por segundo
  start: 0.3,                                           // la hora en el tick 0 (0 = medianoche, 0,5 = mediodía)
  keys: [
    { at: 0,    ambient: [0.06, 0.08, 0.18], background: [8, 10, 28] },
    { at: 0.25, ambient: [0.55, 0.45, 0.4] },
    { at: 0.5,  ambient: [1, 1, 1],          background: [120, 170, 230] },
    { at: 0.75, ambient: [0.6, 0.4, 0.35] },
  ],
});
// Cada cuadro
compositor.frame(rs, baked, { ...opciones, ambient: day.ambient(state.tick), background: day.background(state.tick) ?? undefined });
if (day.isNight(state.tick)) { /* lo que el juego haga de noche */ }
```

- Entre claves interpola suave (coseno; `smooth: false`, recto), y de la última a la primera da la vuelta a
  medianoche. `background` solo cuenta en las claves que lo dicen.
- `phase(tick)` es la hora (0..1), `day(tick)` el número de día e `isNight(tick, umbral)` si la luz ambiente media
  baja del umbral (0,25).
- La luz ambiente se aplica en cada cuadro, sin rehornear: cambiarla no cuesta nada. Las antorchas y demás luces se
  suman encima, así que de noche se ven más.
- Lo que pasa de noche (qué sale, qué se enciende) es del juego.

### Fondo transparente

`Frame2DOptions.background = 'transparent'` deja el cuadro con alfa 0 (y color 0) donde no hay nada, en la CPU y en
la GPU. Así el juego puede pintar detrás del lienzo lo que quiera: un degradado, una noche estrellada. El motor no
pinta cielo.

```ts
compositor.frame(rs, baked, { ...opciones, background: 'transparent' });   // y detrás del <canvas>, el cielo del juego
```

- Lo que se pinta encima del vacío sale opaco: entidades, agua, efectos, gotas, el resalte y la silueta. Ningún píxel
  queda a medias, así que el contorno no hace halo. En la GPU, el contexto ya se crea con `premultipliedAlpha: false`.
- `null` no es transparente: es el fondo por defecto, porque `DayCycle.background` da `null` en las claves sin fondo.
- Sin la opción, el cuadro es el de siempre byte a byte.
- El oráculo compara también el alfa del cuadro final, en 4 escenas con fondo transparente (dos giros, efectos y la
  silueta tras una pared). `test/fondo-transparente.test.ts` lo prueba en la CPU, también con una entidad y chispas
  sobre el vacío.

## Agua y eventos

El agua es un fluido por columnas con ondas, reflejos y gotas. Dentro del tick se le habla con eventos:

```ts
state.events.disturb(x, y, fuerza);         // pisar o golpear: ondas; con fuerza, salta el borde
state.events.pour(x, y, cantidad);          // añadir agua
state.events.splash(x, y, z, gotas, fuerza);
state.waterAt(x, y);                        // { depth, surface } o null
state.groundAt(x, y); state.solidAt(x, y, z);
```

### Agua en un mundo alto

El agua de arriba se pensó para salas bajas. En un mundo de bloques alto (suelo a z 40-60) se usa con estas piezas:

```ts
import { generateMap, applyMap, mapWater } from '@voxpix/world/mapgen';
applyMap(map, grid, { skip: [T('agua')] });                         // el terreno sin el agua (la dibuja la capa)
const world = { model: s, lights: [], width: s.width, depth: s.depth, ...mapWater(map, 8, T('agua')) };
const water = new WaterLayer(world, { wallAbove: Infinity });       // sin pared por altura: el relieve la contiene
const state = new WorldState(s, lights, water, { seed });
water.follow(state.watchChanges());                                 // picar o poner junto al agua la cambia
```

- `wallAbove`: una celda cuyo fondo pasa de esa altura es pared. Por defecto es 8, lo de una sala baja, y todo sigue
  igual. Con `Infinity`, el agua solo la contiene el relieve.
- `asleep`: la capa nace dormida (sin los ~30 ticks caros del principio). Para agua que nace en reposo; ver Coste.
- `zRange`: las alturas en que puede haber superficie de agua. Es la de siempre (-16..32), ensanchada a las cuencas del
  mundo. La usan la CPU (`waterRows`) y la GPU (el uniforme `uWZ`; antes eran constantes del shader).
- `waterTop` puede ser `Int16Array` (antes `Int8Array`, hasta 127).
- `follow(watch)`: en cada `step`, el agua rehace el fondo y la pared de las celdas que tocan los vóxeles cambiados
  (`syncGround`):
  - en una celda con agua, la superficie se queda donde estaba: picar bajo el agua la hace más honda y un bloque puesto
    la desplaza. Una celda seca no tiene superficie que conservar: picarla no crea agua (antes el hoyo nacía lleno hasta
    el suelo de antes, con agua de la nada); lo llena lo que le llegue de sus vecinas;
  - una celda que queda por debajo del agua de una vecina de cuenca pasa a ser cuenca y no se empapa, y desde ella,
    como el agua, las vecinas sin pared con el fondo por debajo de ese nivel, y las suyas: un canal picado desde un
    lago y la fosa en que acaba (aunque se picara antes, en seco). Todas las cajas de un paso se rehacen juntas (una
    zanja que cruza trozos llega en varias). Antes solo pasaba a cuenca la primera celda del canal: el resto y la
    fosa se empapaban sin parar, el lago se vaciaba por ellas y nunca se dormía;
  - `groundVersion` sube cada vez que cambian el fondo, las paredes o las cuencas (también al cargar): la GPU los vuelve
    a subir entonces. Antes solo los subía con el primer cuadro, y tras picar dibujaba fondo viejo con profundidad nueva.

  Sin `follow`, como siempre: el agua no se entera.
- Guardar y cargar: la instantánea del agua lleva también las cuencas (`basin`, con las ganadas jugando). Al cargar
  (`restore`), la profundidad, los flujos y las celdas despiertas guardadas son la verdad: no se tocan ni se despierta
  nada más. Con `follow`, el fondo y las paredes se rehacen de los vóxeles restaurados y lo pendiente de `syncGround`
  se descarta (si no, en un mundo recién generado con la orilla sin picar, conservar la superficie metería agua de más
  donde se picó). Una instantánea de antes, sin `basin`, carga con las cuencas del mundo de partida. Ver Guardar y
  cargar.
- Con el corte de la vista (`WorldView` con `{ cut: true }`), el agua va por la rejilla de la vista también en el giro 0.
  La de una celda cuya superficie pasa de lo cortado en su columna no se dibuja, en la CPU y en la GPU, igual que lo
  cortado.
- `mapWater(map, size, agua)` da `wet` y `waterTop` por columna de vóxeles a partir de un mapa por semilla (ver Mapa por
  semilla).
- Pruebas:
  - `test/agua-alta.test.ts`: con la pared de siempre no hay agua y con `Infinity` sí, y se dibuja (también en una
    vista que solo coge sus filas); un hoyo se llena y un pilar desplaza el agua; la vista ve el fondo nuevo; el corte
    esconde lo de encima.
  - `test/agua-guardada.test.ts`: se pica la orilla, corre el agua, se guarda y se carga en un mundo recién
    generado: la misma huella en cada tick, también picando después. Calentar (`warmUp`) no cambia lo que viene
    después. Una instantánea sin `basin` carga.
  - El oráculo: 8 escenas de agua en un mundo alto (los 4 giros, con corte, picando la orilla y picándola después de
    un primer cuadro de la GPU en los giros 0 y 1), y las de agua de
    antes, iguales.
- Coste: `app/agua.html?medir=1`, Edge con una RTX 4090. Mundo de 384 x 384 x 96 hecho con `generateMap`, 6.544 celdas
  con agua de 36.864, la vista sobre el lago:

  | | Sin freno | CPU a 6x |
  |---|---|---|
  | Paso del agua por tick (`step`), p50 / p95 / máx | 0,1 / 0,5 / 0,6 ms | 0,6 / 4,3-4,6 / 5,1-5,8 ms |
  | Ídem en reposo, antes / ahora (p50) | | 0,6 / < 0,1 ms |
  | Cuadro de la GPU leído, sin / con agua, p50 | 0,5 / 0,6 ms | 2,2-2,4 / 2,7 ms |
  | Cuadro de la GPU leído, sin / con agua, p95 | 0,9 / 0,9 ms | 3,6-4,9 / 6,4-7,4 ms |
  | Cuadro de la CPU (detalle bajo), sin / con agua, p50 | 3,6 / 4,8 ms | 28 / 40-41 ms |

  El paso del agua es barato con el agua quieta y sube tras un pisotón, cuando la rejilla se despierta: un pisotón
  cada 30 ticks da el p95 de ~4,5 ms a 6x. En la GPU, el agua cuesta ~0,3-0,5 ms por cuadro a 6x (p50).

  En reposo (nada despierto), el paso no recorre la rejilla: el simulador lleva las celdas despiertas en una lista
  (`ShallowWater.visited`: las que recorrió el último paso) y el empapado, las mojadas fuera de cuenca
  (`WaterLayer.soakVisited`). Antes recorría las 36.864 celdas dos veces por tick: 0,6 ms a 6x sin nada que hacer;
  ahora, por debajo de 0,1 ms (lo que mide el reloj del navegador frenado). Con todo despierto cuesta lo mismo que
  antes, y la simulación es la misma (`test/agua-reposo.test.ts`, con huellas fijadas con el código de antes).

  En anillo (para la ventana viva): `ShallowWater.shift(dx, dy)` corre la rejilla en celdas sin copiar nada. La celda
  (x, y) está en el índice físico `at(x, y)` (y `xy(i)` lo deshace); el origen corre y solo se limpia la franja que
  entra, que queda seca, quieta y de pared hasta que se cargue. Sin correrse, `at(x, y)` es `y * w + x`, como siempre.
  `exportState` e `importState` van en el orden de la rejilla, corrida o no. Es lo mismo, byte a byte, que una
  simulación que se corre copiando (`test/agua-anillo.test.ts`), también a través de la costura del anillo.

  `WaterLayer` se corre con la ventana viva si se crea con `{ movable: true }`: es un `Attached` de `LiveWindow`
  (`win.attach(water)`), y `shift(dx, dy)` (en vóxeles, múltiplos de la celda) corre su rejilla en anillo. Lo que entra
  queda seco, de pared y sin cuenca hasta que se cargue. Todo lo que indexa la rejilla (el fondo tras picar y su cuenca,
  las gotas, el empapado, `waterAt`, `firstPersonWater`, la instantánea, `WorldState.waterColumns`) va por el anillo. Una
  capa movable se dibuja siempre por su vista (`WaterView`, en orden, también en el giro 0): `WaterLayer.draw` directo,
  corrida, es un error. Lo comprueba `test/agua-capa-anillo.test.ts` contra una capa que se corre copiando, con el
  mundo de vóxeles corrido igual.

  Al correrse no se copia ni se sube nada entero: la vista (`WorldView.shift`, que `LiveWindow` llama antes que a los
  `Attached`) corre su copia del agua con ella, y la capa apunta solo la franja que entra; lo que cambió antes del
  corrimiento sale corrido con él. La vista copia lo que cambió por baldosas de 8 x 8 celdas (`changedTiles`, con la
  versión de cada baldosa; se corren con la rejilla): con agua despierta en varios sitios de una ventana grande, la caja
  de `changesSince` los cubría a todos y lo de en medio (en el banco de 11 x 13 trozos, el p95 de lo copiado por cuadro
  era casi la rejilla entera). Una vista que no se corrió con la capa la copia entera una vez
  (`shiftCount`). La GPU guarda el fondo, las paredes y las cuencas en una textura: con `staticSince(v)` de la vista
  (el corrimiento total y la caja que cambió desde la versión v) la corre dentro de la GPU y sube solo esa caja (lo que
  carga un trozo, lo picado); entera solo la primera vez o si el registro no llega tan atrás (64 cambios). La franja sin
  cargar es pared seca en la capa, en la vista y en la GPU: no se sube nada de ella hasta que se carga. La profundidad,
  igual: `depthSince(v)` de la vista da la caja que cambió, y la GPU sube solo eso de lo que se ve, más lo que entra en
  la vista al moverse la cámara (`waterDepthRects`); entera, lo que se ve, tras un corrimiento. Antes subía en cada
  cuadro toda la profundidad visible (~0,3 ms por cuadro a 6x en el banco de 11 x 13).

  El foco (una ventana grande, donde casi todo está lejos): `water.setFocus(x, y, r)` (vóxeles; cada cuadro, con el
  personaje) simula solo el recuadro de celdas a r o menos; `setFocus(null)`, todo. Dentro, el paso es el de siempre con
  el borde del foco como pared: ni entra ni sale agua por él (lo mismo, byte a byte, que sin foco con lo de fuera hecho
  pared). Fuera queda congelado: lo despierto sigue despierto con sus flujos, no se empapa, no pierde ni gana agua, y al
  entrar en el foco sigue donde estaba (un lago congelado K ticks y suelto evoluciona igual que sin congelar). Con todo
  dentro del foco (también lo que despierta un pisotón), la misma huella que sin foco. Los eventos (pisotones, gotas)
  tocan el agua donde caigan, dentro o fuera. Las despiertas de fuera no se recorren en cada paso: salen de la lista a
  cubos por baldosa de 8 x 8 celdas y vuelven al entrar su baldosa en el foco (o al correrse la rejilla, o al volver a
  una instantánea); con una ventana de 11 x 13 trozos, el paso en calma bajó de 0,045 a 0,004 ms (p50, sin freno), que
  se iba casi todo en recorrer ~5.800 despiertas congeladas. Lo prueba `test/agua-foco.test.ts`.

  Cargar y guardar por trozos (la ventana viva): la capa nace sin cargar (`{ movable: true, unloaded: true }`, toda
  pared seca; el mundo puede traer `wet` y `waterTop` vacíos), se pone con `win.setWater(water)` (en el state,
  enganchada para correrse, y las vistas la toman) y cada trozo se carga al escribirse. En una ventana generada, el agua
  no se escribe en la rejilla (`LiveWindowOptions.skip: [agua]`; un `prepareTrozo` del juego se salta lo mismo en su
  copia) y `regionWater(ctx.region, agua, N, ctx.at)` da su superficie:

  ```ts
  const win = new LiveWindow({ ..., skip: [set.index('agua')],
    onLoad(t, ctx) {   // los vóxeles del trozo ya escritos (con lo suyo, lo picado), antes de hornearlo
      const [x0, y0] = [ctx.at[0] * N, ctx.at[1] * N], x1 = x0 + T - 1, y1 = y0 + T - 1;
      const saved = guardado.get(key(t)) ?? null;                         // lo de save, si salió antes
      return water.loadJob(x0, y0, x1, y1, { saved, surface: saved ? null : regionWater(ctx.region!, agua, N, ctx.at) });
    },
    onUnload(t, ctx) { guardado.set(key(t), water.save(x0, y0, x1, y1)); },   // null: nada que guardar
  });
  const water = new WaterLayer({ model: win.store, lights: [], width: win.store.width, depth: win.store.depth,
    wet: new Uint8Array(0), waterTop: new Int16Array(0), fountain: null }, { movable: true, unloaded: true, wallAbove: Infinity });
  win.setWater(water);   // y los trozos del constructor, que llegaron a onLoad antes que la capa: se apuntan allí y se
                         // cargan aquí (como test/agua-ventana.test.ts)
  ```

  - `load` rehace el fondo y las paredes desde los vóxeles; el agua sale de lo guardado o, la primera vez, de `surface`
    (la superficie de cada columna, o null), igual que el agua de partida del constructor: cargar todos los trozos da
    lo mismo que construir la capa de una vez. Lo cargado nace quieto, sin flujos; el borde del recuadro (de los dos
    lados) se despierta, para que el agua de aquí y la de al lado se igualen si no lo están. Ensancha `zRange`, apunta
    el cambio para la vista y sube `groundVersion`.
  - `loadJob(..., rows = 32)` es lo mismo por pasos: `rows` filas de celdas por llamada, por unidades y no por reloj (el
    agua es de la simulación y no lee el reloj). Si `onLoad` lo devuelve, la ventana lo corre dentro del trabajo del
    trozo antes de darlo por escrito (lo que falta es pared seca mientras tanto; la ventana no se corre con una carga a
    medias). Así cargar el agua de un trozo no cae entero en un cuadro. Quien lo corra por su cuenta, hasta que dé true.
  - `save` guarda la profundidad y la cuenca de cada celda (no los flujos: vuelve quieta); null si no hay agua ni
    cuenca. Lo que se empapaba se sigue empapando al volver.
  - Con `water.follow(state.watchChanges())` (el agua sigue lo que pica y pone el juego), lo que escribe la ventana al
    cargar un trozo no cuenta: llega como `cause: 'load'` (`StaticVoxels.loadWrites`, que la ventana pone mientras escribe
    un trozo, también en `fill` y `onLoad`) y `follow` lo salta, porque `load` ya pone su fondo y su agua. Si no, cada
    trozo cargado pasaba entero por `syncGround` y despertaba miles de celdas en un mundo quieto. Los demás oyentes
    reciben esas cajas como siempre (con su `cause`).
  - `takeWaterVoxels(s, x0, y0, x1, y1, esAgua)`: para un mundo de vóxeles sueltos con agua pintada (que se pintaría
    opaca y taparía lo que hay dentro), quita esos vóxeles y da la superficie de cada columna. En una rejilla de bloques
    no: quitaría los vóxeles y la celda seguiría siendo agua (`skip` y `regionWater` en su lugar). Mira cada columna desde arriba
    y para en el primer vóxel que no es agua: el agua de una cueva bajo tierra se queda como vóxeles.
  - El trozo se escribe con lo suyo (lo picado) antes de `load`: el fondo de lo guardado tiene que ser el de sus vóxeles.
    El agua se carga lo último del trozo: en `onLoad`, después de escribir lo del juego (la ventana corre el `loadJob` que
    devuelve después de `onLoad`, y lee los vóxeles al correr); con `fill`, como último paso de su trabajo. Lo que se
    escriba en el trozo después, mientras la ventana lo carga, llega también como `'load'` y `follow` lo salta: el agua
    no se enteraría.
  - Lo comprueban `test/agua-cargar.test.ts` y, con la ventana de verdad andando de ida y vuelta (también con
    `prepareTrozo`), `test/agua-ventana.test.ts`: el agua queda como en una ventana hecha de nuevo ahí, sin agua en la
    rejilla ni en los vóxeles, y lo que sale moviéndose vuelve como salió.

  La vista girada o con corte (`WaterView`) copiaba cada cuadro la rejilla entera del agua (fondo, pared, cuenca y
  profundidad). Ahora copia solo lo que cambió: `WaterLayer.changesSince(seq)` da la caja de celdas que cambiaron
  desde la copia anterior (un registro de una caja por tick, de los últimos 256; si se queda atrás, la copia entera),
  y el corte apunta las columnas que reescribe. Con el agua quieta, nada (`visited` 0). En Bun, `frame()` de una vista
  girada en reposo pasa de 169 µs a 0,6 µs. Lo copiado es siempre lo mismo que la copia entera
  (`test/agua-vista.test.ts`). Quien escriba `sim.depth` a mano, que use `pour` o `disturb`: así queda apuntado.

  Una celda de pared que se despierta (`wake` no mira si es pared: un pisotón, unas gotas o `syncGround` junto a una
  pared) se duerme como una celda quieta. Antes se quedaba despierta para siempre: seguía en la lista de lo que se
  calcula y marcaba su trozo cada tick. El agua no cambia (profundidad, flujos y gotas iguales); cambian las
  despiertas y los sellos de los trozos, y con ellos la huella de los mundos con paredes. La del mundo alto, casi sin
  paredes, no cambia.

  Una celda dormida no manda agua (solo las despiertas la mandan), así que si su vecina despierta queda más baja que
  ella (un canal que se vacía junto a un lago quieto), se despierta al acabar el paso (más de 0,02 de diferencia:
  menos no la mantendría despierta). Antes el nivel se quedaba en escalón para siempre: el lago a un nivel y el canal
  a otro, y las celdas de entre medias despiertas.

  Lo caro son los primeros ticks de una capa recién hecha: nace con todo lo mojado despierto y tarda unos 30 ticks en
  dormirse. A 6x, con el JIT ya caliente: el primer tick 15,6-15,9 ms y unos 25 por encima de 5 ms (`?medir=1`,
  `first` y `firstFollow`). Con el JIT frío, más. `state.warmUp()` calienta el JIT pero no duerme el agua.
  `new WaterLayer(world, { asleep: true })` nace dormida: el primer tick no cuesta nada (máximo 0,3-0,5 ms a 6x en esos
  ticks, `firstAsleep`). Solo vale para agua que nace en reposo: ninguna celda mojada puede echar agua a una vecina
  (la superficie plana en cada lago, como la de `mapWater`) y no hay fuente. Si no, la capa lo comprueba al nacer,
  ignora la opción con un aviso (`console.warn`) y nace despierta, como siempre; `bornAsleep` dice qué pasó. Con el
  agua en reposo termina igual que la que nace despierta y se duerme (`test/agua-reposo.test.ts`). Cambia la huella
  (las despiertas están en ella); por defecto, como siempre.

## Corte al componer (capa de sección)

Ver de perfil lo que hay detrás de un objetivo (una galería bajo tierra, como en un juego de perfil) sin rehornear
(`src/world/section.ts`). Una caja de la imagen horneada se trata como aire al componer:
- columnas [x0, x1] x [y0, y1], de zMin hacia arriba;
- y1 es la fila del objetivo; y0, la del lado de la cámara.

Lo de detrás nunca se horneó (lo tapaba lo de delante), así que se pinta al momento, con el mismo render que el
horneado:
- el suelo que queda dentro de la caja;
- `depth` filas detrás de y1 (32 por defecto: en esta proyección el rayo baja 0,5 por cada vóxel hacia el fondo).

```ts
import { sectionAround } from '@voxpix/world/section';
const section = sectionAround(view.camera, body.x, body.y, body.z, 32);      // 32 vóxeles de ancho; en los 4 giros
compositor.frame(state, baked, { ...opts, section });                         // (por ahora, la CPU: frame2D)
```

- Se sustituyen los píxeles cuya primera superficie horneada está en la caja (se sabe por el `pick` horneado). Con
  ellos se repinta también su borde: los píxeles horneados que los tocan, con su mismo vóxel, para que el contorno y
  el tono de la costura sean los del corte.
- En la sección no hay luz horneada. Lleva su ambiente con el cielo de cueva del mundo cortado, y las luces fijas le
  llegan como las dinámicas, sin sombras. El borde guarda su luz horneada.
- La capa se guarda por horneado, caja y número de serie de lo publicado: un rehorneado la rehace.
- Contra el corte horneado (el mismo mundo con la caja quitada, horneado entero), en los 4 giros y con contorno `both`
  (`test/corte-componer.test.ts`):
  - sin luces fijas, el cuadro es igual byte a byte, también con una luz dinámica y con todo el ancho de la vista;
  - con cielo de cueva, la capa es igual; fuera difieren unos píxeles horneados junto al corte, que con el corte
    ganan cielo (menos de 80, como mucho 12 niveles);
  - con una luz fija, la capa difiere solo en la sombra de esa luz.
  - Sin sección, el cuadro de siempre: oráculo 81/81, byte a byte.
- Coste, en Bun sin freno, en el túnel de `scripts/bench-seccion.ts`, rehaciendo la capa en cada cuadro (la caja
  sigue al objetivo):

  | Ancho | Píxeles sustituidos | Capa (sin freno) | Capa (a 6x) |
  |---|---|---|---|
  | 32 vóxeles (4 bloques) | 4.736 | 5,5 ms | ~37 ms |
  | 384 vóxeles (todo el ancho de la vista) | 56.288 | 58 ms | ~390 ms |

  De eso, el render es el 65 % y el cielo de cueva el 25 %.
- Para seguir a un objetivo que anda, `SectionPainter` no la rehace en cada cuadro:
  - la caja se mueve por franjas de 8 columnas (`STRIP`);
  - las columnas se pintan de 4 en 4 (`UNIT`) con la caja "ancha" (todas cortadas), como trabajo de la cola con
    plazo: primero las de la caja, luego 4 franjas por delante en la dirección en que anda (`ahead`) y 1 por detrás;
  - al componer, lo de la composición anterior se desplaza (una copia por fila) y de las unidades solo se copia lo
    nuevo y lo que estaba junto a los bordes de antes. En los bordes de ahora se rehacen el borde y el contorno de la
    costura, y el cielo de 9 columnas, que la cola ya adelantó para la caja siguiente. Dos búferes se turnan: la capa
    devuelta vale hasta dos composiciones después;
  - una unidad caduca si se rehornea algo a 9 columnas de ella, y todas si cambian la fila del objetivo o sus pies;
  - un paso de pintado no se corta: dentro del trabajo, el siguiente solo empieza si cabe lo que costó el último, y
    entre trabajos manda la FrameBudget.
  - La capa compuesta es la misma que la de la caja entera (`test/corte-componer.test.ts`).

  ```ts
  const painter = new SectionPainter(baked, { ahead: 4 });
  // cada cuadro
  painter.set(sectionAround(view.camera, body.x, body.y, body.z, 32), dirX);    // dirX: -1, 0 o 1 en x de la vista
  const job = painter.job(); if (job) budget.push(job);
  compositor.frame(state, baked, { ...opts, sectionLayer: painter.layer() });
  ```

  En el túnel de `scripts/bench-seccion.ts` con `ANDAR=1` (`ESCALA=1` para 1x), andando a 5 bloques/s con una
  FrameBudget y 4 franjas por delante, no hay ningún cuadro con hueco en ningún ancho. Componer cuesta 0 salvo en el
  cuadro en que la caja salta una franja (uno de cada 12), casi igual en todos los anchos: en el navegador (Edge, CPU
  a 6x, `app/seccion.html`), p95 ~8 ms en ese cuadro; en Bun, p95 8,4-9,1 ms a 6x emulado (×6,7) y 0,8 ms a 1x.

  | Aparece en (cuadros) | 4 bloques | 16 | 24 | 48 |
  |---|---|---|---|---|
  | 1x, 4 ms de cola | 4 | 12 | 17 | 25 |
  | 1x, 6 ms | | | 11 | 19 |
  | 1x, 8 ms | | | 8 | 13 |
  | 6x, 4 ms | 9 | 33 | 47 | 77 |

  Unidades de pintado de 8 columnas en vez de 4: aparece antes (a 6x, 4/16/21/34), pero cada paso cuesta ~14 ms a 6x.
  De 2 columnas: 19/67/101/190.
  Cada paso tiene un coste fijo (~1 ms sin freno) y la unidad pequeña no compensa. En el cuadro en que la caja salta
  de franja (toca componer) y con la caja ya pintada, el trabajo de la cola no pinta lo de delante: no se suma a la
  composición.
- En la GPU (`src/view/gpu`) la capa solo se compone. `Frame2DOptions.section` o `sectionLayer` igual que en la CPU:
  - dos texturas, porque la escena ya usa 14 de las 16 unidades y la 15 es la de subir: el color; y la profundidad,
    la y del mundo, la cara con su código de luz por detrás y máscara + 16 × cielo;
  - las texturas son un anillo en x: la columna x de la imagen va en la x mod su ancho. Una capa de `SectionPainter`
    dice qué columnas cambiaron desde la anterior (`base`, `dirty`) y solo se suben esas, con la y del mundo y la luz
    por detrás que trae la capa;
  - en un píxel sustituido no hay luz horneada: su cielo con el corte, y las luces fijas como las dinámicas (sin
    sombras); el borde guarda la suya con el ambiente de su cielo con el corte; las luces dinámicas y las sombras de
    las entidades van con la geometría de la capa.
  - El oráculo (`app/oraculo.html`, "corte al componer"): un anillo de paredes alrededor de MAIA, la caja moviéndose
    (la GPU dibuja antes con ella 16 y 8 vóxeles a un lado), bajo tejado (el cielo), con una antorcha fija y con
    entidades y una luz dinámica, con `section` y con `SectionPainter`, en los 4 giros: 16 de 16, con 1500-3300
    píxeles sustituidos en la vista; dentro de la capa, 1 píxel distinto (a 3) en una escena y 0 en las demás. Sin
    capa, las 81 escenas de antes salen iguales byte a byte.
- `app/seccion.html` lo mide en el navegador: el túnel de `scripts/tunel.ts` (de bloques, con dos antorchas), MAIA
  andando a 5 bloques/s con la cola de la vista y la sección por franjas (`?ancho=4`; `?medir=4,16,24,48` deja la
  medida en `window.__seccion`).

  Edge con GPU y la CPU a 6x (dos tiradas, 360 cuadros), andando con todo pintado. Pintar por delante es trabajo de
  la cola y se juzga como el rehorneado (cuadros de más de 25 ms); la puerta de +1 ms es la mediana del cuadro sin la
  cola (componer, subir y el cuadro de la GPU):

  | Ancho | Aparece (cuadros) | Huecos | Cuadros > 25 ms | Mediana sin la cola | Media: cola / componer / subir |
  |---|---|---|---|---|---|
  | sin corte | | | 5 | 3,2-3,3 ms | |
  | 4 bloques | 9 | 0 | 4-5 | 3,7 | 2,8 / 1,2 / 0,5 ms |
  | 16 | 33 | 0 | 6 | 3,3-3,4 | 2,4-2,5 / 1,2 / 0,5 |
  | 24 | 47 | 0 | 6 | 3,2 | 2,1-2,2 / 1,1 / 0,4 |
  | 48 (`?mundo=768`) | 77 | 0 | 3 | 3,6 | 2,9 / 1,3 / 0,4 |

  Componer y subir solo cuestan en el cuadro en que la caja salta de franja (p95 de componer ~8 ms a 6x). Con unidades
  de 8 columnas aparece antes, pero hay 6-11 cuadros de más de 25 ms.
- Lo que cambió tras medirlo en el juego (FERN: con pasos de ~11 ms a 6x, 162-460 cuadros de más de 25 ms contra 22-23):
  - cada unidad se pinta por bandas de `BAND` = 48 filas de la imagen (`sectionLayer` con `rows`: una fila de margen y
    solo lo que puede caer en ellas): un paso, ~0,4 ms sin freno (~3 ms a 6x); unidas, lo mismo que la unidad entera;
  - el trabajo puede no dar ningún paso si el siguiente no cabe (lo que suelen costar: el tercero mayor de los últimos
    8; al no caber se olvida el más viejo, y vuelve a probar a los pocos cuadros). Con la caja sin acabar o menos de
    `AHEAD_MIN` = 3 franjas pintadas por delante va con priority 0; si no, sin prioridad (solo con lo que sobre). A las
    30 llamadas sin sitio, un paso de la caja igualmente;
  - el orden: la caja, el cielo de los bordes de la caja siguiente, lo de delante. La caja tiene siempre el mismo ancho
    (en franjas), así lo adelantado vale;
  - la capa no depende del serial de la imagen (un rehorneado lejos no la recompone) y los arreglos de los bordes se
    deshacen desde lo guardado;
  - lo sustituido sin nada detrás, bajo tierra (su cielo horneado no es el abierto), lleva `SECTION_FILL`
    (`SectionCut.fill`; `null`, transparente);
  - el agua dentro de la caja, desde `zMin`, no se dibuja (`SectionLayer.box`; CPU y GPU).

  Edge con GPU, `app/seccion.html` con la cola del juego (3 ms y 8 de lo cercano), dos tiradas:

  | | Sin corte | 4 bloques | 16 | 24 |
  |---|---|---|---|---|
  | Cuadros > 25 ms, toda la tirada (6x) | 4-5 | 0-1 | 2-3 | 3-7 |
  | Aparece a 6x (cuadros) | | 32-41 | 66-74 | 99-106 |
  | Aparece a 1x (cuadros) | | 3 | 5 | 7 |
  | Llamada a la cola más larga (6x) | | 11-19 ms | 10-18 | 13-24 |
  | Componer al saltar, p95 (6x) | | 6-7 ms | 5-6 | 5-6 |

  Huecos después de aparecer: 0-4 por tirada a 6x, 0 a 1x. Oráculo: 101/101 (4 escenas nuevas con el lago); las 81
  de antes, iguales byte a byte.
- La composición es un anillo: la columna de imagen gx está en gx mod `ring` de los arrays (`secIdx` da el índice), y al
  mover la caja solo se escriben las columnas nuevas y las de los bordes. La capa devuelta vale hasta la composición
  siguiente. La y del mundo (`wy`) y la luz por detrás (`back`) de cada píxel se calculan al pintar la unidad, no al
  subir.

## Cámara con objetivo

La ventana de la vista (`vx`, `vy` de `Frame2DOptions`) sigue a un punto, normalmente un cuerpo, con zona muerta y
suavizado (`src/view/follow.ts`). Es de la vista: no toca el mundo ni la huella, y avanza con el tiempo real del cuadro.

```ts
import { FollowCamera, targetPixel } from '@voxpix/view/follow';
const cam = new FollowCamera({ viewW: 384, viewH: 216, deadZone: [24, 16], speed: 6, bounds: baked });
cam.snap(...targetPixel(view.camera, baked, body.x, body.y, body.z));     // al empezar, tras un salto o al girar
// cada cuadro
cam.follow(...targetPixel(view.camera, baked, body.x, body.y, body.z), dt);
compositor.frame(state, baked, { ...opts, vx: cam.vx, vy: cam.vy });
```

- `deadZone`: ancho y alto en píxeles de un rectángulo en el centro de la ventana. Mientras el objetivo está dentro, la
  cámara no se mueve; al salir, va a por él hasta dejarlo en su borde. Por defecto 0 x 0: siempre centrado.
- `speed`: por segundo. Cada cuadro recorre la parte `1 - e^(-speed * dt)` de lo que le falta, así que sigue igual a
  30 que a 144 cuadros por segundo. Con 6, el 90 % en unos 0,38 s. `Infinity`: de golpe.
- `bounds` (opcional, un `Baked` vale): la ventana no sale de la imagen; si la imagen es más pequeña, se centra.
- Los parámetros son campos que se pueden cambiar en marcha (`cam.deadZone`, `cam.speed`, `cam.viewW`...).
- Los 4 giros: `targetPixel(view.camera, baked, x, y, z)` pasa el punto del mundo a la vista girada y lo proyecta con
  la cámara de su horneado. Da coordenadas continuas, y el píxel es su `floor`. Sin girar vale `null` como cámara. Al
  cambiar de giro hay otra imagen: `snap` con el objetivo en ella.
- Pruebas: `test/camara-objetivo.test.ts` (zona muerta, suavizado igual a 30 y a 144 cuadros por segundo, límites, y
  en los 4 giros el píxel del objetivo cae en un pilar rojo).

## Girar la cámara

La cámara oblicua gira en cuartos de vuelta con `WorldView` (`src/world/view.ts`). La simulación no se entera: la
vista le da al render un estado ya girado (vóxeles, entidades, luces, agua y gotas) y el render no cambia.

```ts
const view = new WorldView(state, 1);                 // 0 sur (lo de siempre), 1 este, 2 norte, 3 oeste
const baked = bakeWorld(view.bakeable(), { topZ: 40, incline: 0.5 });
// cada cuadro
const rs = view.frame();                              // pone la vista al día con el mundo
for (const j of rebakeChangedJobs(baked, rs.lights)) budget.push(j);
compositor.frame(rs, baked, opciones);
// puntero y toques: coordenadas del MUNDO
view.voxelAt(baked, sx, sy); view.pointAt(baked, sx, sy);
```

- `view.camera` (`ViewCamera`) es lo único que sabe pasar del mundo a la vista y al revés: celdas, puntos,
  direcciones y giros.
- Cada giro es un horneado y, salvo el 0, una copia girada de los vóxeles. En un mundo de 640 x 480 con 40 de alto,
  un giro tarda ~0,7-1 s en hornearse y ocupa ~19 MB de horneado más ~32 MB de vóxeles girados (los 4 guardados,
  ~170 MB).
- Para no congelar la vista, `prepareViewJob(state, q, opciones)` prepara un giro como un trabajo que se reanuda
  (`ViewJob`): se mete en la cola con presupuesto (`FrameBudget`) y `result()` da `{ view, baked }` al acabar. Debajo
  está `bakeWorldJob`, el horneado entero por pasos, igual byte a byte que `bakeWorld`.
- La copia girada va por losas (`StaticVoxels.copyRotatedSlabs`). Cada losa de 16 x 16 x 16 se copia de una vez:
  - sus datos, con los índices girados dentro de cada capa de 16 x 16 y la misma paleta;
  - la de un solo valor, ese valor.

  Al acabar las losas de un trozo, se calculan sus alturas, su versión y su caja de cambios. No pasa por `set`: ni
  versiones ni avisos por vóxel. El contenido es el mismo que copiando vóxel a vóxel (hay prueba: vóxeles, alturas,
  instantánea, lo expuesto y el horneado, en los 4 giros). El reloj y las versiones no: cuentan trozos, no vóxeles.
  Hace falta que ancho y fondo sean múltiplos de 16 (`StaticVoxels.slabCopyable`); si no, se copia vóxel a vóxel como
  antes. En `prepareViewJob`, la unidad de la etapa `copy` es una losa.
- El horneado por pasos va por baldosas de 16 filas de pantalla. Cada baldosa lleva las columnas que caben en lo que
  queda del plazo de la llamada (una como mínimo). Lo que cuesta cada columna son sus caras al aire en la banda.
  - Se cuentan con las máscaras de lo expuesto, por grupos de 16 columnas. Preparar un grupo es una unidad aparte: sus
    máscaras, hasta el plazo, y contar.
  - Con eso y lo medido en la banda (ms por cara) se corta cada baldosa.
  - El cielo se corta igual, por los píxeles con algo de cada fila; la luz, por lo medido de esa luz.
  - No empieza otra unidad en la misma llamada si quedan menos de 0,25 ms.

  Antes eran franjas de toda la altura sin mirar el plazo:
  - con pasos de 2 ms cabían 1-2 columnas;
  - cada franja renderizaba además una columna de margen a cada lado (el contorno);
  - costaba 2-3 veces el horneado de una vez;
  - una columna no se podía partir.
- Medido con `bun scripts/bench-giro.ts`, sin freno: un mundo de bloques de 384 x 384 x 96 con 9,6 M de vóxeles
  llenos (subsuelo de piedra con vetas, árboles y un túnel), con corte de vista, cielo y contorno, giros 1 y 2, 2-3
  tiradas. Con `PLAZO=0.5` se dan llamadas de 0,5 ms (lo que son 3 ms a 6x):

  | | Antes | Baldosas, por volumen | Baldosas, por caras al aire |
  |---|---|---|---|
  | Copia girada, por partes | 0,7-1,1 s en ~300-360 llamadas (máx 4-6 ms) | 14-27 ms | 12-27 ms (máx 0,5-1,3 ms con plazo de 0,5) |
  | Horneado por pasos de 2 ms | 0,9-1,3 s | 0,41-0,64 s | 0,41-0,63 s |
  | Horneado de una vez (referencia) | 0,32-0,6 s | igual | igual |
  | Preparar las máscaras después (trabajo `exposure`) | ~120 ms (lo que cuesta hacerlas) | 1-5 ms | 1-5 ms |
  | Llamadas del horneado con plazo de 0,5 ms: p50 / p95 / p99 | - | 0,45-0,51 / 0,95-1,02 / 1,4-1,7 ms | 0,37-0,40 / 0,57-0,69 / 0,80-1,13 ms |
  | Llamada más larga del horneado con plazo de 0,5 ms | - | 2,8-15,9 ms | 1,9-3,1 ms |
  | Llamadas del horneado con plazo de 2 ms: p50 / p95 / p99 | - | 2,0-2,2 / 3,3-4,3 / 4,0-7,3 ms | 1,9 / 2,2-2,5 / 2,6-3,2 ms |

  El banco da también el ruido de la máquina con cada giro: un cálculo puro, sin memoria ni motor, calibrado a la
  mediana de las llamadas y repetido las mismas veces. Lo que se pase ese cálculo se lo pasa cualquier trabajo del
  mismo tamaño. En el portátil de las medidas (WSL, 24 hilos), con plazo de 0,5 ms, 3 tiradas de los giros 1 y 2:

  | | Llamadas del horneado | Cálculo fijo de la misma mediana |
  |---|---|---|
  | p50 | 0,38-0,40 ms | 0,34-0,39 ms |
  | p95 | 0,56-0,72 ms | 0,42-0,50 ms |
  | p99 | 0,89-1,30 ms | 0,60-0,82 ms |
  | Máximo | 1,5-5,1 ms | 1,2-2,1 ms |

  La puerta que vale es relativa al ruido, en la misma corrida y con plazo de 0,5 ms: p95 del horneado <= p95 del
  ruido + 0,1 ms, y p99 <= p99 del ruido + 0,2 ms. `render()` creaba memoria por cada cara: las esquinas con
  `map(project)`, las normales en arrays y `decode` como objeto. Ahora hace las mismas cuentas en el mismo orden con
  `camera.projectTo` y variables sueltas, y el resultado es el mismo byte a byte. También quitó una caché de tonos que
  no acertaba nunca, porque cada cara se pinta una vez por render. Con eso:

  | | Antes | Después |
  |---|---|---|
  | Exceso sobre el ruido, p95 | +0,08 a +0,20 ms | 0,00 a +0,21 ms |
  | Exceso sobre el ruido, p99 | +0,19 a +0,43 ms | -0,21 a +0,42 ms |
  | Corridas que pasan la puerta | 1 de 6 | 8 de 12 |
  | Horneado de una vez (giros 1 y 2) | 0,32-0,6 s | 0,2-0,42 s |
  | Horneado por pasos de 2 ms | 0,41-0,63 s | 0,35-0,56 s |

  Las que no pasan son sobre todo las primeras de cada proceso. El ruido mismo varía entre corridas: su p95 va de 0,33
  a 0,57 ms. La puerta se juzga sin la primera corrida del proceso; pasa la mayoría de las veces, y el resto es ruido
  del sistema. La deuda queda cerrada.

  Una puerta absoluta por debajo del ruido (p. ej. máximo <= 0,6 ms con plazo de 0,5) no la pasa ni el cálculo fijo.
  Lo que es del motor es la diferencia con el ruido: ~0,15 ms en p95 y 0,3-0,5 ms en p99. La misma baldosa repetida
  30 veces da mediana 0,2-0,4 ms y su peor vez 1,3-2,5 ms. Esos picos no salen de la estimación ni del recolector
  (siguen con una recolección forzada antes de cada vez) ni del JIT (no compila nada durante la llamada).

  Con la estimación por volumen había además 1-2 llamadas de 20-46 ms por giro. No eran el recolector: siguen igual
  con el recolector entero forzado entre llamadas (`GC=1` en el banco), y el montón no cambia durante la llamada.
  Eran tandas del cielo: las filas se contaban a secas, y la medida de las de arriba (casi vacías) se quedaba diez
  veces corta en las de abajo. Contando los píxeles con algo de cada fila, desaparecen.
- `app/giro.html` mide las dos formas en cada máquina (`?modo=cache`: los otros 3 en segundo plano; sin modo: hornear
  al girar, con un cuadro de transición antes).
- Las paredes que dependen del lado de la cámara son contenido: el juego las decide con un vestido.
  `new WorldView(state, q, { dress })` (o `prepareViewJob(state, q, opciones, { dress })`) llama a
  `dress(view, null)` antes de hornear, y `dress(view, trozos)` cada vez que el mundo cambia donde hay vestido. El
  vestido cambia `view.static`, que es la copia de la vista (también en el giro 0: el mundo no se toca). Con
  `view.hideLight` esconde luces, que entonces ni se hornean ni se pintan.
- Fuera de alcance: el giro continuo y otras proyecciones. Serían otra `ViewCamera`, sin tocar el render.
- El oráculo CPU contra GPU (`app/oraculo.html`) prueba los 4 giros y un mundo de lados impares.

## Cortar la vista

Con la cámara oblicua, lo de arriba tapa lo de abajo: un túnel, una cueva o una casa con tejado no se ven. Una vista
con copia de los vóxeles puede CORTAR: esconder lo que queda por encima de una altura dentro de una caja, sin tocar el
mundo de la simulación.

```ts
const view = new WorldView(state, giro, { cut: true });   // la vista lleva su copia también en el giro 0
const baked = bakeWorld(view.bakeable(), opciones);
// Al bajar a un túnel: lo de z >= zTop en esa caja (ejes del mundo, columnas incluidas) deja de verse
view.setCut({ x0, y0, x1, y1, zTop });
// Como siempre, cada cuadro: rebakeChangedJobs rehace lo que el corte cambió (y las luces que le afectan)
for (const j of rebakeChangedJobs(baked, view.frame().lights, { near })) budget.push(j);
view.setCut(null);                                          // al salir
```

- El corte vive en la copia de la vista: picar o poner en el mundo dentro de la caja se copia a la vista sin deshacerlo.
  Las luces no se tocan: una antorcha en la zona cortada sigue alumbrando lo que queda (para esconderla,
  `view.hideLight`).
- El resultado es el mismo, byte a byte, que hornear un mundo al que le faltan esos vóxeles (hay prueba en los 4
  giros, con una luz fija dentro de la zona cortada).
- Mover la caja solo reescribe las columnas que entran y salen; cambiar `zTop`, todas las de la caja.
- Varias cajas, cada una con su `zTop`: `view.setCut([caja1, caja2])` (y lo mismo en `cutJob`; `currentCut` da lo
  pedido, caja o lista). Una columna que está en dos cajas se corta desde el `zTop` más bajo. Al cambiar la lista solo
  se repasan las cajas que entran, salen o cambian; una que se queda igual, no. Sirve para un corte de casa de muñecas
  en un túnel estrecho: con la cámara oblicua lo que tapa al jugador es la pared del lado de la cámara, que llega hasta
  justo encima de su cabeza (por debajo del techo). La caja de siempre con `zTop` en el techo, más la mitad del lado
  de la cámara con `zTop` a la altura de los pies, quita la pared de delante y deja la de detrás. Hay prueba, byte a
  byte contra hornear sin esos vóxeles, en los 4 giros, y `cutJob` a trozos acaba igual que `setCut`.
  En `bench-corte.ts` con `DOS=1` (32 x 32 hasta el techo y 16 x 32 hasta los pies), frente a una caja, a 6x: ~18 %
  más llamadas de recuadro, "aparece" p50 de 13 a 17 cuadros (el máximo, igual, ~20) y el cuadro más largo igual.
  Con la caja de los pies de un juego (24 de ancho y 64 hacia la cámara: `DOS=2`), contorno interior (`CONTORNO=both`),
  el mundo de bloques (`MUNDO=bloques`) y 2 antorchas en el túnel, a 6x, la llamada de recuadro queda en p50 ~6, p95
  ~12 y máximo ~20-22 ms (antes de guardar lo expuesto por losa: 8,6, 15,5 y 29). La llamada más larga sigue por
  encima de lo que cabe en el cercano (8): su coste no baja al estrechar la franja (ver "Probado y descartado"). No es
  el recolector de basura. En Edge, con una traza de V8, de 1.803 llamadas de recuadro 312 pasan de 8 ms (a 6x), solo
  7 tienen una pausa del recolector dentro y ninguna bajaría de 8 sin ella. Es cálculo: pintar todo lo expuesto de una
  franja alta (las caras que se ven y las que quedan tapadas) y, tras un cambio grande, las filas de lo expuesto que
  hay que rehacer. Queda como tolerancia conocida: con este corte, p95 ~11-12 y máximo ~20-30 ms a 6x.
- `view.setCut(corte)` lo aplica de una vez (y devuelve cuántas columnas reescribió; `view.currentCut` es el corte pedido). Para no parar el cuadro, `view.cutJob(corte)` da un trabajo de la cola
  (`FrameBudget`, prioridad 0: va con el presupuesto cercano) que reescribe columnas hasta el plazo; lo que va
  cambiando lo recoge `rebakeChangedJobs` cada cuadro. Si llega otro corte antes de acabar, sigue desde donde está y
  acaba igual que `setCut` (hay prueba).
- El coste depende de cuánto se quita, no solo de la caja: lo que se destapa se rehornea, y la sombra de lo quitado
  cambia para todas las luces cercanas. Medido sin freno (terreno de bloques de 384 x 384 x 96 con 30 antorchas y cielo,
  `FrameBudget(3, ..., { ms: 8, below: 64 })` con los presupuestos divididos por 6,7, que es lo que sube todo con la CPU
  frenada a 6x), con un corte hondo (de 12 vóxeles sobre el suelo, quitando hasta 60 por columna):

  | Caja | Poner: aparece / acaba | Mover 16: aparece / acaba | Quitar: aparece / acaba | Cuadro más largo |
  |---|---|---|---|---|
  | 32 x 32 | ~35 / ~135 cuadros | ~25 / ~75 | ~20 / ~70 | ~3-6 ms (~20-38 a 6x) |

  ("Aparece": el corte y sus recuadros hechos; "acaba": también las luces y el cielo.) Esta tabla es de cuando entró el
  corte, con la cola de entonces, que dejaba pasarse del plazo: de ahí los cuadros de 20-38 ms. Con la cola de ahora,
  que no empieza lo que no cabe, ver `bench-corte.ts` abajo. La unidad que no se puede
  partir es una franja del recuadro, y en un corte hondo cuesta ~1,7-2,5 ms sin freno. Para un juego: caja pequeña,
  movida a saltos, y `zTop` lo más alto que se pueda (justo por encima de la cabeza del jugador).
- `bun scripts/bench-corte.ts` mide el corte de un túnel (caja de 32 x 32 a saltos de 16, `zTop` en el techo del
  túnel, quitando hasta ~50 vóxeles por columna) con esa cola: la llamada a `budget.run` más larga de cada evento (como
  a 6x; incluye los 3 ms de lo demás, así que el techo es 11) y los cuadros hasta aparecer (nada cercano en la cola
  después de recoger los cambios) y acabar. `NEAR=12` cambia el presupuesto cercano; `VER=1` saca cada evento y las
  estimaciones de la cola. Con 24 eventos, a 6x:

  | Cola | Aparece p50 / máx | `budget.run` máx |
  |---|---|---|
  | Cercano 8, una estimación por clase | 15-19 / 21-22 cuadros | 15,7-19,2 ms |
  | Cercano 8, primera llamada aparte | 13 / 21-22 | 14,5-15,7 |
  | Cercano 12 | 7 / 10-12 | 15,7-16,4 |

  Con cercano 8, "aparece" no baja de ~13: una franja de recuadro cuesta ~4,5-5 ms a 6x y en 8 ms cabe una (sobran
  ~3, que no dan para otra); ~18 franjas por evento son ~18 cuadros, se estime como se estime. A 1x una franja son
  ~0,75 ms y caben de sobra. Lo que queda por encima de 11 ms es UNA franja: la primera llamada del cuadro, que va
  siempre.

## La silueta de lo que queda detrás

Todas las paredes miden lo mismo, así que una pared que está entre la cámara y un personaje (la del sur, en la vista de
siempre) lo tapa. `Frame2DOptions.xray = { color: [r, g, b] }` (0..255) pinta, donde una entidad queda detrás del
escenario, su silueta de ese color en damero y con luz propia. CPU y GPU dan lo mismo; la trama va por píxel de la
imagen horneada, así que no tiembla al mover la cámara. Sin el campo, nada cambia.

## Niebla por altura

En la vista oblicua, una torre de un bloque y una zanja de un bloque se dibujan igual: no hay pista de la altura.
`Frame2DOptions.fog` funde hacia un color lo que se ve por debajo de una altura de foco (la de lo que sigue la cámara):

```ts
compositor.frame(rs, baked, { ...opciones, fog: { focusZ: jugador.z + 14, start: 4, full: 20, color: [28, 32, 56], strength: 0.7 } });
```

- La z de cada píxel es la del punto que se ve en él (escenario, entidad o agua). Sale de su profundidad y su fila,
  como `worldPointAt`. No se hornea nada ni se guarda nada por cuadro, así que `focusZ` puede cambiar en cada cuadro y
  picar un bloque no invalida nada. Las gotas y los efectos toman la z de lo que tienen detrás.
- Un píxel con z >= `focusZ - start` queda igual. Entre `focusZ - start` y `focusZ - full`, la mezcla sube en línea
  hasta `strength`; más abajo, `strength`. Lo que está por encima del foco nunca se toca: un `start` negativo cuenta
  como 0, y un `full` menor que `start`, como `start` (un escalón). El fondo, sin nada, no se toca.
- La mezcla va en pasos de 1/256. Así el color mezclado es exacto en float32, y la CPU y la GPU dan el mismo byte
  también en los empates. Sin los pasos, un suelo a z entera con un foco entero caía justo en .5 en miles de píxeles,
  y el error de la z en float32 lo mandaba a un lado o al otro.
- Va después de la luz: el color de la niebla no se alumbra. Sin el campo, con `null` o con `strength` 0, el cuadro es
  el de siempre, byte a byte.
- El oráculo (`app/oraculo.html`) la prueba en el lago con pisotones en los 4 giros, sin luces, y con una multitud
  de 60. Los ±1 que quedan son los del agua de siempre (ver [El cielo](#el-cielo-oscuro-bajo-techo)): las mismas
  escenas sin niebla dan 16-44 píxeles, y con niebla, 14-28.
- Para verla: `app/niebla.html`, con deslizadores para `focusZ`, `start`, `full`, la fuerza y el color.
  - "seguir" pone el foco en la cabeza de una entidad que sube y baja por bancales, torres y zanjas.
  - Con `?medir=1`, mide el pase y deja el resultado en `window.__niebla`.
- Coste en 384 x 216, en Edge con una RTX 4090 (`app/niebla.html?medir=1`, 120 cuadros):

  | | Sin freno | CPU a 6x |
  |---|---|---|
  | Pase de niebla en la CPU (`applyFog` sobre el cuadro ya hecho), p50 / p95 / máx | 0,2 / 0,3-0,4 / 0,5 ms | 1,2 / 1,9-2,2 / 2,8-3,7 ms |
  | Cuadro entero en la CPU, sin / con niebla (p50) | 4,4 / 4,5-4,6 ms | 34,6-34,8 / 36,0-36,5 ms |
  | Cuadro de la GPU leído (`read`), sin / con niebla (p50) | 0,6 / 0,6 ms | 2,4-2,6 / 2,4-2,7 ms |

  En la GPU es una lectura de textura y unas cuentas más en el pase final que ya existía: no se distingue del ruido de
  la medida. En la CPU, el pase cuesta ~1,2 ms a 6x. El cuadro entero en la CPU ya pasa de 16,7 ms a 6x sin
  niebla (la CPU es la ruta de reserva), y la niebla le suma un 3-5 %. Cabe sin partirlo por filas.

## Resaltar un objeto del escenario

Para señalar algo que es parte del escenario horneado (la fuente, un adorno) sin rehornear:

```ts
compositor.frame(rs, baked, { ...opciones, highlight: { box: view.viewBox([x0, y0, z0, x1, y1, z1]), color: [255, 214, 102], width: 2 } });
```

- `box`: la caja del objeto, en celdas del mundo (con `view.viewBox` pasa a los ejes de la vista girada). Que empiece
  por encima del suelo: si incluye el suelo, el aro rodea también el suelo.
- Se pinta un aro de `width` píxeles (1 a 4) con `color` y luz propia, solo por FUERA de la silueta (el interior de
  un pilón no lleva aro). Las entidades que pasan por delante lo tapan.
- La máscara se calcula una vez por horneado y caja (y otra vez si se rehornea): por cuadro solo se pinta. El pulso
  lo pone quien llama, cambiando `color`; `highlight: null` lo apaga.
- La CPU y la GPU dan lo mismo (el oráculo del juego lo prueba con la fuente en los 4 giros).

## Lo que flota

`state.floaters` (`src/world/floaters.ts`) mueve cosas que flotan en el agua: nenúfares, hojas, maderas. Cada
flotante es una entidad (se pinta en la CPU, en la GPU, con luz y en los 4 giros) que sube y baja con la superficie, la
arrastra la corriente y la apartan los pisotones (`events.disturb`). Se frena sola y no sale del agua.

```ts
state.floaters.add(modelo, x, y, yaw);        // sobre el agua que haya ahí; da su id ('flota-N')
world.floaters = [{ x, y, model, yaw }];      // o al construir (en decorate): buildWorldState los pone
const plan = planFoliage(m, ..., { type: 'lilies', waterDepth: worldWaterDepth(world) });
// con agua fluida, plan.floats trae los nenúfares (x, y, forma) para lilyPadModels(rampa)[forma]
```

- No bloquean nada (ni la colisión, ni los disparos, ni dan sombra de verdad) y no gastan el azar del mundo: la
  partida es la misma con y sin ellos. Sus ids (`flota-N`) no tocan la secuencia numérica de las entidades.
- Entran en la instantánea y en la huella del mundo (un mundo sin flotantes da la huella de siempre).
- Las entidades se iluminan como sólidas: los materiales (follaje, vidrio) son del escenario.

## Efectos y partículas

`src/core/effects.ts` tiene un sistema de partículas general (`FxSystem`): puntos de 1 o 2 píxeles con velocidad,
vida y una rampa de color, que salen de **emisores descritos con datos** (`EmitterSpec`, sin código): forma (punto,
caja, disco), ritmo (`rate` por segundo) o ráfaga (`burst`), vida, rapidez, dirección y apertura del cono, gravedad
(negativa sube), frenado, viento, vaivén, colores a lo largo de la vida, tamaño, luz propia y qué hacen al chocar con
los vóxeles que bloquean (`collide`: atravesar, pararse, rebotar o morir).

Efectos ya hechos (`FX_PRESETS`): `chispas`, `humo`, `polvo`, `brasas`, `lluvia`, `nieve`, `hojas`, `burbujas`.
`streak` da una estela vertical de N píxeles (la lluvia lleva 3).

En la demo de escenario: brasas en antorchas y braseros (humo en los braseros), polvo al pisar, **E** chispas delante
de MAIA, **N** el tiempo (nada, lluvia, nieve; cyberpunk empieza con lluvia) y **F** apaga los efectos. `?efectos=no`
y `?tiempo=lluvia|nieve|nada` en la URL. En el editor son la herramienta **Efecto** y la API `effect`, `burst`
(`docs/api-agentes.md`). Falta pintarlos en el modo vóxel y en la primera persona de la demo de escenario.

El mundo tiene dos sistemas:

```ts
// VISUALES: con su propio azar (semilla del mundo), fuera de la instantánea y de la huella
const id = state.fx.add('humo', x, y, z);        // un emisor encendido; da su id
state.fx.move(id, x, y, z); state.fx.setOn(id, false); state.fx.remove(id);
state.fx.burst('chispas', x, y, z);              // una ráfaga suelta (un golpe, una muerte); o burst(spec, x, y, z, n)
state.effectsOn = false;                         // apagarlos (ni avanzan ni se pintan): la partida no cambia
// DE SIMULACIÓN: con el azar del mundo, en la instantánea y (si alguna vez se usaron) en la huella
state.simFx.add({ life: [1, 2], speed: [4, 8], colors: ['#ffffff'] }, x, y, z);
```

- Las gotas del agua (`state.drops`) son la primera partícula de simulación y no cambian: dan las mismas huellas
  que antes (hay prueba).
- **Topes** (`new WorldState(..., { fx: { maxAlive, maxLights } })`, por defecto 2000 y 8 por sistema): al llegar a
  `maxAlive` las nuevas no nacen, y el azar se gasta igual (lo que sale después no cambia). Solo alumbran las
  `maxLights` primeras partículas con luz, en el orden del sistema. Nada depende del reloj.
- Se pintan después del agua y antes de las gotas, con la misma prueba de profundidad y sin escribir profundidad (en
  un píxel gana la última). Las que llevan luz se ven con luz propia y alumbran como luces dinámicas (una linterna sin
  parpadeo que se apaga al morir la partícula). En la CPU, la GPU (`FRAG_FX`, dos pasadas: color y luz) y los 4 giros;
  el oráculo del juego lo compara (`medieval efectos, giro N`, `cyberpunk efectos`, `multitud de 200 con chispas`).
- Fuera del mundo, `new FxSystem(fxRandom(semilla))` sirve igual: `step(dt, solido)` y `packed` (x, y, z, r, g, b,
  tamaño, emisiva por punto).
- Antes de usarlas en una oleada, el coste se mide en el Flip con el caso de juego (200 enemigos con chispas al
  morir): la puerta sigue siendo p95 ≤ 16,8 ms.

## Explorar un mundo en primera persona

`renderFirstPerson` (`src/core/explore.ts`) acepta un `StaticVoxels` con su caja (`bounds`) y el agua del simulador
como superficie (`water: state.water.firstPersonWater(palette)`, con la rampa del agua de la paleta). La GPU lo hace
igual (`GpuVoxelRenderer.firstPerson`, con el agua subida como textura en cada cuadro), y el oráculo del render lo
compara en un mundo medieval mirando un lago. En la demo de escenario, **X** entra en primera persona desde donde
está MAIA (`?explorar=1&altura=12` arranca así), con las luces del mundo y su parpadeo; **+/-** cambia la altura.
Las entidades (MAIA, los flotantes) todavía no salen en la primera persona. En la Alienware, a 384x216 sobre un
mundo de 640x480 con luces: ~30 ms por cuadro (escena ~16, luz ~11, capas ~3).

Pendiente si Explorar llega a un juego: quitar las dos esperas de leer de la GPU (la escena y la luz se leen con
readPixels, que espera a que termine; habría que componer en la GPU y pintar directamente), y que salgan las
entidades en primera persona.

## Guardar y cargar

Una instantánea del mundo (`state.snapshot()`: vóxeles, agua, gotas, entidades, luces, el azar, las partes como una
rejilla de bloques...) a bytes y de vuelta, para guardar una partida.

```ts
import { encodeSnapshot, decodeSnapshot } from '@voxpix/world/save';

// Al empezar una partida en un mundo generado por semilla, la instantánea de partida (no hace falta guardarla:
// se rehace con la semilla)
const base = state.snapshot();
// Guardar: solo lo que cambió respecto a la base
const bytes = encodeSnapshot(state.snapshot(), base);
// Cargar: rehacer el mundo con la misma semilla y ponerle la partida encima
state.restore(decodeSnapshot(bytes, state.snapshot()));
```

- El archivo: una cabecera con versión, el esqueleto de la instantánea en JSON y sus arrays en binario
  (little-endian). La ida y vuelta es exacta: la huella (`state.hash()`) es la misma, y los mismos datos dan siempre
  los mismos bytes.
- Los vóxeles van por losas de 16 x 16 x 16, cada losa distinta una sola vez (un mundo de bloques repite mucho: toda
  piedra, todo aire) y comprimidas por tramos. Un terreno de bloques de 384 x 384 x 96 (unos 6 MB en memoria) ocupa
  ~600 KB entero.
- Con base: lo igual que en la base no se guarda y lo parecido va como diferencia (unos 3 KB por bloque picado). Si
  así ocupara más que entero, va entero. Para cargar hace falta la misma base (si no, error).
- El agua: profundidad, flujos, celdas despiertas y cuencas (`basin`). `restore` deja el agua tal como se guardó: con
  `follow`, rehace su fondo de los vóxeles restaurados sin tocar la profundidad (ver Agua en un mundo alto). Se guarda
  entre ticks (lo picado dentro de un tick lo recoge el `step` de ese tick). Las cuencas entran en la huella solo si se
  ganó alguna jugando: un mundo sin ellas da la huella de siempre.

## Determinismo

`state.step()` avanza 1/60 s fijos, sin reloj ni `Math.random`: el azar es un generador con semilla dentro del
estado. Con la misma semilla y la misma entrada, el mundo da la misma huella (`state.hash()`) tick a tick, en
cualquier máquina. La vista (cámara, parpadeo, presupuesto por cuadro) usa el reloj; la simulación no lo lee nunca.

## Rendimiento

En un portátil con GPU dedicada, el cuadro del modo 2D cuesta unos 0,2 ms de CPU con unas pocas entidades. Con 200
entidades, 10 antorchas y una linterna, a 6x de freno de CPU, da un p95 de ~16,7 ms. Las medidas y cómo repetirlas
están en `scripts/perf/README.md`.
