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
| `worldgen`, `terrain` | Mapas por semilla en teselas (salas, paredes, columnas, agua, fuente), con las reglas que le pases (`GeneratorSpec`). `spec.shape` da la forma de la sala: L, T, salas con pasillos, laberinto o un plano en texto. Con `spec.doors`, la sala trae sus huecos de puerta, y `stitchRooms` une varias en un mapa abriendo las puertas entre vecinas (ver `docs/api-mundos.md`). |
| `world/build` | `buildWorldState(layout, look, { decorate })`: el escenario en vóxeles, con sus luces fijas, el agua y el estado inicial. El aspecto (`WorldLook`) lo da quien construye; ver "El aspecto del mundo". |
| `samples` | Contenido de MUESTRA para la demo y las pruebas: tres temas (`oficina`, `medieval`, `cyberpunk`, en `samples/themes`), escenas y paletas. El motor no lo importa: cópialo o haz el tuyo. |
| `world/state` | `WorldState`, la única fuente de verdad: lo estático, el registro de modelos, las entidades, las luces, el agua, las gotas, los efectos y su huella (`hash`, `snapshot`, `restore`). |
| `world/bake` | `bakeWorld`: lo estático pintado una vez, con la luz de las fuentes fijas. `rebakeChangedJobs` rehornea solo la caja de lo que cambió (ver "Rehornear lo que cambió"). Ojo: `baked.rgba` es la imagen SIN luz; la luz horneada está en `baked.lights[].weight` (un peso por píxel de su zona) y se suma al componer cada cuadro. Para comprobar un cambio de luz, mira los pesos o el cuadro compuesto, no `rgba`. |
| `view/compositor` | `createCompositor(canvas)`: compone cada cuadro (escenario, entidades con su luz por cara y sus sombras, agua, gotas). GPU con WebGL2 o CPU de reserva con el mismo resultado. Si la GPU pierde el contexto, sigue la CPU. |
| `world/frame3d` | El modo vóxel: el mismo estado visto en 3D. |
| `runtime/runtime`, `runtime/body` | El tick determinista (entrada -> cuerpos con colisión -> eventos -> mundo), `FixedLoop` para pasar de tiempo real a ticks fijos y `Runtime`, un personaje controlable con su luz de mano. |
| `view/budget` | `FrameBudget`: el trabajo de la vista que no cabe en un cuadro (rehornear trozos) se reparte entre cuadros. |
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
  no enseñan ninguna cara). Se saltan losas enteras; lo que da es un superconjunto de lo que tiene alguna cara al
  aire, en el mismo orden. `forEachExposed(fn, región)` es lo mismo sin generador, y la región puede limitar también
  la altura (`z0..z1`). El render (`render`, y el horneado con él) la usa si la fuente la tiene
  (`VoxelSource.forEachExposed`, opcional): los mismos píxeles, recorriendo mucho menos.
- `changedBox(trozo, versión)`: la caja (x, y, z, extremos incluidos) de lo que cambió en ese trozo después de la
  versión, o `null`. Puede ser más grande que lo cambiado, nunca más pequeña. `cut()` cierra los tramos abiertos:
  quien acaba de leer las cajas (el horneado lo hace solo) corta, y lo que cambie después tiene su caja aparte.

## Rehornear lo que cambió

`rebakeChangedJobs(baked, luces)` rehace solo **la caja de lo cambiado** de cada trozo: los píxeles por los que pasa
esa caja (con 1 vóxel de margen, que es lo que cambian la oclusión y las caras vecinas; 3 si el horneado lleva
normal suavizada), no el trozo con toda su altura. Quitar o poner vóxeles solo cambia lo que se ve a través de
ellos, así que el resultado es el mismo, byte a byte, que hornear el mundo entero (hay pruebas, también con
contorno). Las sombras de las luces fijas leen los vóxeles directamente: `baked.occ` ya no se usa y va vacío.

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
  mismo que una de 4 (~1,7 ms).
- **Rayo por píxel en vez de pintar caras** en el recuadro: más rápido en teoría, pero tiene que dar los mismos píxeles
  que el render, empates de aristas incluidos. Días de trabajo y riesgo; no hecho.
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
  pueden llevarse hasta 8 ms del cuadro; los demás siguen con sus 3. Las luces de un rehorneado con `near` llevan
  prioridad desde `LIGHT_PRIORITY` (10000): van detrás de los recuadros y nunca cuentan como cercanas. Así el bloque
  picado se ve en el cuadro siguiente y las luces se asientan en los de después, sin subir el presupuesto de todo.
  `budget.ms` y `budget.near` se pueden cambiar entre cuadros.
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
```

- `.voxset.json`: `{ format: 'voxpix-set', version: 1, name, size, palette, blocks: [{ id, voxels, props? }] }`. Los
  vóxeles de cada bloque van de 0 a N-1 en cada eje, con los valores de la paleta del set.
- Las propiedades (`BlockProps`): `solid` (bloquea el paso), `light` (`'blocks'` o `'passes'`) y `emissive` salen de
  los materiales de sus rampas (docs/render.md, Materiales), que son los que de verdad usan la colisión, la luz y el
  render; si se escriben, tienen que coincidir (si no, error). `density` es la media de sus vóxeles, o la que se diga.
  `emits` es la luz fija que pone al colocarse (`addFixed`; `at` es dónde, en vóxeles del bloque) y quita al
  quitarse. `covered` es el bloque en que se convierte cuando tiene uno sólido encima (la hierba tapada, tierra).
  Lo demás (cuánto cuesta picarlo, qué suelta, recetas) es del juego, no del set.
- `BlockGrid`: la rejilla (`cols`, `rows`, `layers`) es la fuente de verdad y los vóxeles su dibujo. `get`, `set(bx,
  by, bz, tipo, giro?)` (0 quita; aplica `covered` y `emits`), `fill(b0, b1, tipo)` (para generar), `props`,
  `cellOf(x, y, z)` (vóxel a bloque), `box(bx, by, bz)` (bloque a vóxeles) y `topAt(bx, by)` (el sólido más alto de la
  columna, o -1). Las rampas del set tienen que estar en la paleta del mundo (el error dice cuál falta).
- La rejilla se añade al mundo como una parte del estado (`WorldState.addPart`): entra en `snapshot`, `restore` y
  `hash`. Un mundo sin partes da la huella de siempre. `addPart` sirve para cualquier otro estado que añada un juego
  (`exportState`, `importState`, `hashInto`).

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
- Coste (terreno de bloques de 384 x 384 con un túnel, celdas de 4, sin freno): construir ~17 ms, una búsqueda
  ~3,4 ms, ponerse al día tras picar ~1,4 ms (el de superficie: ~5, ~1,7 y ~0,8).

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
field.close();                                        // al tirarlo: deja de oír los cambios del mundo
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
- Conviene precalentar (`compositor.prewarm`) los cuadros de todos los clips que vayan a salir.

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

## Agua y eventos

El agua es un fluido por columnas con ondas, reflejos y gotas. Dentro del tick se le habla con eventos:

```ts
state.events.disturb(x, y, fuerza);         // pisar o golpear: ondas; con fuerza, salta el borde
state.events.pour(x, y, cantidad);          // añadir agua
state.events.splash(x, y, z, gotas, fuerza);
state.waterAt(x, y);                        // { depth, surface } o null
state.groundAt(x, y); state.solidAt(x, y, z);
```

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
- Cada giro es un horneado y, salvo el 0, una copia girada de los vóxeles. En un mundo de 640 x 480, un giro tarda
  ~0,7-1 s en hornearse y ocupa ~19 MB de horneado más ~32 MB de vóxeles girados (los 4 guardados, ~170 MB).
- Para no congelar la vista, `prepareViewJob(state, q, opciones)` prepara un giro como un trabajo que se reanuda
  (`ViewJob`): se mete en la cola con presupuesto (`FrameBudget`) y `result()` da `{ view, baked }` al acabar. Debajo
  está `bakeWorldJob`, el horneado entero por pasos, igual byte a byte que `bakeWorld`.
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
- `view.setCut(corte)` lo aplica de una vez. Para no parar el cuadro, `view.cutJob(corte)` da un trabajo de la cola
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

  ("Aparece": el corte y sus recuadros hechos; "acaba": también las luces y el cielo.) La unidad que no se puede
  partir es una franja del recuadro, y en un corte hondo cuesta ~1,7-2,5 ms sin freno. Para un juego: caja pequeña,
  movida a saltos, y `zTop` lo más alto que se pueda (justo por encima de la cabeza del jugador).

## La silueta de lo que queda detrás

Todas las paredes miden lo mismo, así que una pared que está entre la cámara y un personaje (la del sur, en la vista de
siempre) lo tapa. `Frame2DOptions.xray = { color: [r, g, b] }` (0..255) pinta, donde una entidad queda detrás del
escenario, su silueta de ese color en damero y con luz propia. CPU y GPU dan lo mismo; la trama va por píxel de la
imagen horneada, así que no tiembla al mover la cámara. Sin el campo, nada cambia.

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

## Determinismo

`state.step()` avanza 1/60 s fijos, sin reloj ni `Math.random`: el azar es un generador con semilla dentro del
estado. Con la misma semilla y la misma entrada, el mundo da la misma huella (`state.hash()`) tick a tick, en
cualquier máquina. La vista (cámara, parpadeo, presupuesto por cuadro) usa el reloj; la simulación no lo lee nunca.

## Rendimiento

En un portátil con GPU dedicada, el cuadro del modo 2D cuesta unos 0,2 ms de CPU con unas pocas entidades. Con 200
entidades, 10 antorchas y una linterna, a 6x de freno de CPU, da un p95 de ~16,7 ms. Las medidas y cómo repetirlas
están en `scripts/perf/README.md`.
