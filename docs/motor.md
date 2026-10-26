# El motor del mundo

Debajo del editor hay un motor de mundo 2.5D sobre el que se puede hacer un juego. El mundo es **un solo modelo de
vóxeles**: lo estático, el agua, las entidades, las luces y las gotas. Dos renderizadores lo leen igual:
- el **modo 2D**: horneado más composición por cuadro, por GPU o por CPU;
- el **modo vóxel**: la vista 3D.

`app/escena.html` es la demo completa; `app/multitud.html` es la más corta. El
[juego de ejemplo](https://github.com/andyeswong/brotato-oficina) lo usa como dependencia.

## Usarlo desde otro proyecto

VoxPix no tiene paquete en npm. Se instala desde GitHub fijado a un commit, y se usa su TypeScript directamente:

    npm install github:andyeswong/voxpix#<commit>

En `vite.config`, `vitest.config` y `tsconfig`, un alias `@voxpix` -> `node_modules/voxpix/src`. Si usas el puente
con pxl (`src/pxl`), también `pxl-core` -> `node_modules/voxpix/vendor/pxl/src/core/index.ts`.

## Un mundo en pantalla

```ts
import { generateLayout } from '@voxpix/worldgen';
import { THEMES } from '@voxpix/content/themes';
import { Model, type ModelFile } from '@voxpix/core';
import { buildWorldState } from '@voxpix/world/build';
import { bakeWorld } from '@voxpix/world/bake';
import { createCompositor } from '@voxpix/view/compositor';
import { walkFrames, WALK_FRAME_MS } from '@voxpix/anim/walk';
import maiaFile from 'voxpix/models/maia/maia.json';

const VW = 384, VH = 216;
const canvas = document.querySelector('canvas')!;
canvas.width = VW; canvas.height = VH;
const compositor = createCompositor(canvas);                 // GPU (WebGL2) si hay; si no, CPU

// Un escenario por semilla, construido en vóxeles y horneado una vez
const theme = 'medieval';
const layout = generateLayout(THEMES[theme].spec, 7);
const { world, state } = buildWorldState(layout, theme);
const baked = bakeWorld(world, { topZ: 40, incline: 0.5 });

// Una entidad que anda, y una antorcha que va con ella
const walk = walkFrames(Model.fromJSON(maiaFile as unknown as ModelFile));   // maiaFile: models/maia/maia.json
const x = layout.spawn.x, y = world.depth - 1 - layout.spawn.y;
const id = state.entities.add({ model: walk[0]!, x, y, z: 1, facing: 0, castsShadow: 'always' });
state.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: id, offset: [6, -4, 14] } });

// Lo que va a salir, subido antes del primer cuadro
const opts = { vx: 0, vy: 0, vw: VW, vh: VH, time: 0, lights: true, ambient: THEMES[theme].ambient };
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
| `worldgen`, `content/themes`, `terrain` | Mapas por semilla en teselas (salas, paredes, columnas, agua, fuente) y tres temas: `oficina`, `medieval` y `cyberpunk`, con sus paletas y su luz ambiente. |
| `world/build` | `buildWorldState(layout, tema)`: el escenario en vóxeles, con sus luces fijas, el agua y el estado inicial. |
| `world/state` | `WorldState`, la única fuente de verdad: lo estático, el registro de modelos, las entidades, las luces, el agua, las gotas y su huella (`hash`, `snapshot`, `restore`). |
| `world/bake` | `bakeWorld`: lo estático pintado una vez, con la luz de las fuentes fijas. `rebakeChangedJobs` rehornea solo lo que cambió. Ojo: `baked.rgba` es la imagen SIN luz; la luz horneada está en `baked.lights[].weight` (un peso por píxel de su zona) y se suma al componer cada cuadro. Para comprobar un cambio de luz, mira los pesos o el cuadro compuesto, no `rgba`. |
| `view/compositor` | `createCompositor(canvas)`: compone cada cuadro (escenario, entidades con su luz por cara y sus sombras, agua, gotas). GPU con WebGL2 o CPU de reserva con el mismo resultado. Si la GPU pierde el contexto, sigue la CPU. |
| `world/frame3d` | El modo vóxel: el mismo estado visto en 3D. |
| `runtime/runtime`, `runtime/body` | El tick determinista (entrada -> cuerpos con colisión -> eventos -> mundo), `FixedLoop` para pasar de tiempo real a ticks fijos y `Runtime`, un personaje controlable con su luz de mano. |
| `view/budget` | `FrameBudget`: el trabajo de la vista que no cabe en un cuadro (rehornear trozos) se reparte entre cuadros. |
| `anim/walk`, `anim/rig` | Los cuadros de andar de un personaje (`walkFrames`) y la animación genérica por partes de cuerpos de varias patas (`rigFrames`). |
| `fluid` | El fluido en volumen del editor (verter y grifos). |

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
  se apoya en `floorAt`, el suelo sin lo que no es fondo (el follaje). `planFoliage` (src/core) coloca
  vegetación en cualquier cosa con `palette` y `get`, también en un `StaticVoxels`.
- El sprite de cada modelo y giro se guarda (con tope: los menos usados se sueltan). Conviene girar en los 8 rumbos
  (`HEADINGS` de `world/frame2d`) y precalentar con `compositor.prewarm` lo que vaya a salir, para que el primer
  cuadro no pague el render.

## Luces

```ts
state.lights.add({ kind: 'lamp', x, y, z });                                    // de punto, dinámica
state.lights.add({ kind: 'lantern', x, y, z, dir: [0, -1, -0.3], cone: 40 });   // un foco
state.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: id, offset: [6, -4, 14] } });   // va con una entidad
```

- Los tipos y sus valores por defecto (radio, color, intensidad, parpadeo) están en `src/lighting/lights.ts`. Se
  pueden ajustar con `intensity`, `radius` y `color`.
- Las luces del escenario son fijas y se hornean; las que se añaden en partida son dinámicas.
- `owner` es la entidad que lleva la luz: su cuerpo no le hace sombra.
- `Frame2DOptions.entityLightCap` limita cuántas luces alumbran a cada entidad, para máquinas modestas.

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

## Explorar un mundo en primera persona

`renderFirstPerson` (`src/core/explore.ts`) acepta un `StaticVoxels` con su caja (`bounds`) y el agua del simulador
como superficie (`water: state.water.firstPersonWater(palette)`, con la rampa del agua de la paleta). La GPU lo hace
igual (`GpuVoxelRenderer.firstPerson`, con el agua subida como textura en cada cuadro), y el oráculo del render lo
compara en un mundo medieval mirando un lago. En la demo de escenario, **X** entra en primera persona desde donde
está MAIA (`?explorar=1&altura=12` arranca así), con las luces del mundo y su parpadeo; **+/-** cambia la altura.
Las entidades (MAIA, los flotantes) todavía no salen en la primera persona. En la Alienware, a 384x216 sobre un
mundo de 640x480 con luces: ~30 ms por cuadro (escena ~16, luz ~11, capas ~3).

## Determinismo

`state.step()` avanza 1/60 s fijos, sin reloj ni `Math.random`: el azar es un generador con semilla dentro del
estado. Con la misma semilla y la misma entrada, el mundo da la misma huella (`state.hash()`) tick a tick, en
cualquier máquina. La vista (cámara, parpadeo, presupuesto por cuadro) usa el reloj; la simulación no lo lee nunca.

## Rendimiento

En un portátil con GPU dedicada, el cuadro del modo 2D cuesta unos 0,2 ms de CPU con unas pocas entidades. Con 200
entidades, 10 antorchas y una linterna, a 6x de freno de CPU, da un p95 de ~16,7 ms. Las medidas y cómo repetirlas
están en `scripts/perf/README.md`.
