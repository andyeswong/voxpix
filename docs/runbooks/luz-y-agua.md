# Luz y agua: qué se hornea, qué se paga cada cuadro

Cómo poner luces fijas y dinámicas, cómo rehornear lo que cambia sin parar el cuadro, el cielo de cueva y la capa del
agua. Y lo que cuesta cada cosa, con la fuente de cada cifra. Código: `src/world/state.ts`, `src/world/lightutil.ts`,
`src/world/bake.ts`, `src/view/budget.ts`, `src/world/water.ts`, `src/fluid/shallow.ts`.

## Fija o dinámica

Una luz es un `WorldLight` (`src/world/build.ts`): `kind`, `x, y, z` en vóxeles del modelo, y opcionales `intensity`,
`radius`, `color`, `dir` + `cone` (foco), `owner` y `follow`. El campo que decide es `baked`:

- `baked: true` (fija): se hornea una vez en `baked.lights[].weight`, un peso por píxel de su zona (`rect`). Al
  componer solo se suma. Cuesta al ponerse y nada después.
- `baked: false` (dinámica): se calcula en cada cuadro, en su radio. Puede moverse y seguir a una entidad.
- Los focos (`dir`) son siempre dinámicos.

`resolveLight(l, time)` (`src/world/lightutil.ts`) da la luz resuelta: el preset de su `kind` (`SOURCE_PRESETS`) con
sus ajustes, y la intensidad con el parpadeo de ese instante (`intensity`; sin parpadeo, `base`). La usan el horneado,
las entidades, el agua y el modo vóxel: la misma luz se ve igual en todas partes.

En `LightList` (`state.lights`):

```ts
state.lights.add({ kind: 'lamp', x, y, z });                       // dinámica: baked false
state.lights.add({ kind: 'torch', x: 0, y: 0, z: 0, follow: { entity: id, offset: [6, -4, 14] } });
const fija = state.lights.addFixed({ kind: 'torch', x, y, z });   // fija: baked true, sin follow ni owner
state.lights.removeFixed(fija);                                   // la deshornea el rehorneado siguiente
```

- `addFixed` lanza si ya hay una luz con ese id. `removeFixed` lanza si la luz es dinámica (esa se quita con `remove`).
- `move` lanza con una fija: las fijas no se mueven. Para mover una antorcha, quitarla y poner otra.
- La GPU suma como mucho 32 dinámicas y 32 fijas por cuadro: las que alcanzan la vista, las más cercanas al centro
  primero. La CPU las suma todas (docs/motor.md, "Luces").
- `baked.rgba` es la imagen SIN luz. Para comprobar una luz, mirar `baked.lights[].weight` o el cuadro compuesto.

## Hornear y rehornear

1. Hornear una vez: `bakeWorld(world, { topZ, incline, outline, sky })`. Hornea las fijas (salta las `baked === false`)
   y deja `exposurePending`: el primer `rebakeChangedJobs` devuelve un trabajo `exposure:N` que prepara las máscaras de
   lo expuesto detrás de todo.
2. Cada cuadro, lo que cambió, por trabajos de la cola:

   ```ts
   const budget = new FrameBudget(3, undefined, { ms: 8, below: 64 });
   for (const j of rebakeChangedJobs(baked, state.lights, { near: { x: px, y: py } })) budget.push(j);
   budget.run();
   ```

   Pasarle siempre TODAS las luces (con la cámara girada, `view.frame().lights`): compara las fijas de la lista con
   las horneadas. La que falta se hornea entera (un trabajo, aunque no haya cambiado ningún vóxel); la que ya no está
   se deshornea al momento.
3. `rebakeChanged(baked, luces)` hace lo mismo de una vez, sin cola. Sirve en pruebas y en scripts; en partida para el
   cuadro.

Lo que hace por dentro (`src/world/bake.ts`):

- Rehace solo la caja de lo cambiado de cada trozo, con 1 vóxel de margen (3 con normal suavizada). Igual, byte a byte,
  que hornear entero (`test/rebake.test.ts`).
- Cada recuadro acabado se publica de golpe en `baked.published`: `serial` sube y se guarda el recuadro en `rects`
  (los últimos 32, `PUBLISHED_KEEP`). Quien guarda copia (la GPU, la capa de sección) sube solo lo publicado después de
  su último `serial`; si se queda atrás, lo recarga todo.
- Luces: si la luz es la misma, sus pesos se rehacen sobre los de antes, en un objeto nuevo (`BakedLight.base` y
  `dirty`: la GPU sube solo ese recuadro). Se rehacen los píxeles que cambiaron de vóxel o de cara y los que filtra
  `touchedBy` (interna): vóxeles dentro de lo cambiado o que miran a la luz por un segmento que cruza la caja. Si la luz
  cambió (sitio, intensidad, color, radio), se rehace entera.
- Un trabajo de luz espera a que se publiquen sus recuadros sin gastar nada.

## El cielo de cueva

```ts
const baked = bakeWorld(view.bakeable(), { topZ, incline, sky: true });
compositor.frame(rs, baked, { ...opts, ambient: day.ambient(tick), cave: [0.08, 0.07, 0.12] });
```

- `baked.sky` guarda por píxel de 0 a `SKY_RAYS` (5) rayos que llegan arriba, de `SKY_REACH` (8) vóxeles en diagonal.
- Al componer, cada píxel va de `cave` (sin cielo) a `ambient` en 6 niveles (`skyAmbient`, la misma tabla en CPU y GPU).
- Lo que cambia el cielo de un píxel está a 8 columnas como mucho: al picar o cortar se rehace por caja, un trabajo
  `sky:` que va detrás de todo (`LIGHT_PRIORITY`, 10000).
- Sin `sky` al hornear o sin `cave` al componer, las huellas de siempre.

## La cola de la vista: FrameBudget

`new FrameBudget(ms, now?, near?, spare?)` (`src/view/budget.ts`). Una vez por cuadro, `budget.run()`.

- Un `ViewJob` es `{ key, run(deadline), priority? }`. `run` trabaja hasta el plazo y devuelve `true` si acabó.
- Misma `key`, sustituye al de la cola. Con varias vistas en la misma cola, poner sufijo por giro (`light:3@q1`).
- `near: { ms: 8, below: 64 }`: los trabajos con `priority < 64` tienen 8 ms aparte, antes que lo demás.
- `expected(key)` es el p95 de las últimas 32 llamadas de esa clase (lo de antes de `:` o `#`). Una llamada solo empieza
  si cabe lo que suele costar su clase; la primera de cada fase va siempre.
- `spare`: lo que lo demás puede tomar del cercano que sobra (por defecto, `ms`).
- El contrato está en `test/view/budget.test.ts`: si ninguna unidad pasa del presupuesto de su fase, ningún `run()` pasa
  de `near.ms + ms`.

## El agua: WaterLayer

```ts
const water = new WaterLayer(world, { wallAbove: Infinity, asleep: true });   // mundo alto, agua que nace quieta
const state = new WorldState(s, lights, water, { seed });
water.follow(state.watchChanges());                                           // picar junto al agua la cambia
```

- Rejilla de celdas de `WATER_CELL` vóxeles; el simulador es `water.sim`, un `ShallowWater` (`src/fluid/shallow.ts`).
- `basin` (1 = cuenca; si no, suelo seco que se empapa). `groundVersion` sube al cambiar fondo, paredes o cuencas: la
  GPU vuelve a subirlos entonces.
- Reposo y listas: `ShallowWater` lleva un contador `awake` por celda y solo calcula las despiertas, en lista
  (`activeCells()`; `visited` son las del último paso). El empapado lleva su propia lista de mojadas fuera de cuenca
  (`soakVisited`). Con el agua quieta, `step` no recorre la rejilla.
- `asleep: true`: la capa nace dormida. Solo vale si el agua nace en reposo y no hay fuente; si no, avisa con
  `console.warn`, nace despierta y `bornAsleep` queda a `false`.
- `syncGround(cajas)`: lo llama `step` con lo que da `follow`. Rehace fondo, paredes y cuencas de las celdas tocadas.
- `changesSince(seq)`: la caja de celdas cambiadas desde una copia. `WaterView` (`src/world/view.ts`, la vista girada o
  con corte) copia solo eso.
- Eventos en el tick: `state.events.disturb`, `pour`, `splash`. Quien escriba `sim.depth` a mano, que use `pour`.

## Lo que cuesta

| Qué | Cifra | Fuente |
|---|---|---|
| Luz fija | al ponerse; nada después | docs/motor.md, "Luces" |
| Luz dinámica | cada cuadro | docs/motor.md, "Luces" |
| Horneado entero, 384 x 384 x 96, 30 antorchas | ~0,7 s (motor.md); 0,45-0,46 s hoy | docs/motor.md, "Rehornear lo que cambió"; `bench-picar`, abajo |
| Picar un bloque ahí, total p50 / p95 | ~7-9 / ~9-12 ms (motor.md); 4,6-4,7 / 6,7-7,7 ms hoy | ídem |
| Llamada más larga al picar (p95) | 1,1-1,2 ms hoy, sin freno | `bench-picar`, abajo |
| Cielo: horneado entero | de ~0,51 a ~0,58 s | docs/motor.md, "El cielo" |
| Cielo: por bloque picado | un trabajo de ~0,2-0,5 ms sin freno | docs/motor.md, "El cielo" |
| Una franja de recuadro en un corte hondo | ~1,7-2,5 ms sin freno; ~4,5-5 ms a 6x | docs/motor.md, "Cortar la vista" |
| Paso del agua por tick, p50 / p95 / máx | 0,1 / 0,5 / 0,6 ms sin freno; 0,6 / 4,3-4,6 / 5,1-5,8 ms a 6x | docs/motor.md, "Agua en un mundo alto" |
| Paso del agua en reposo (p50, 6x) | de 0,6 a < 0,1 ms | ídem |
| Agua en el cuadro de la GPU (p50, 6x) | ~0,3-0,5 ms | ídem |
| Primeros ticks de una capa despierta, 6x | primer tick 15,6-15,9 ms; ~25 ticks por encima de 5 ms | ídem |
| Ídem con `asleep: true` | máximo 0,3-0,5 ms | ídem |
| `frame()` de `WaterView` girada en reposo (Bun) | de 169 µs a 0,6 µs | ídem |

Las cifras de motor.md son de un portátil con GPU dedicada; las de "hoy", de la Alienware el 2026-11-16, sin freno:

    export PATH=$HOME/.bun/bin:$PATH
    bun scripts/bench-picar.ts 384 96 30            # dos tiradas: p50 4.6 y 4.7, p95 6.7 y 7.7 ms
    CIELO=1 bun scripts/bench-picar.ts 384 96 30    # horneado 0.49 s; picar p50 5.2, p95 6.7 ms

Para decidir entre fija y dinámica: si no se mueve, fija. Una fija nueva hace un trabajo de horneado entero; cien
dinámicas cuestan cada cuadro. Con la CPU frenada todo sube varias veces: la medida que vale es la del navegador (ver
[medir-antes-de-decidir.md](medir-antes-de-decidir.md)).

## Las pruebas

    bunx vitest run test/rebake.test.ts test/cielo.test.ts test/luz-cercana.test.ts test/entities-lights.test.ts \
        test/agua-reposo.test.ts test/agua-vista.test.ts test/agua-alta.test.ts test/view/budget.test.ts test/relevo.test.ts

- `test/luz-cercana.test.ts`: una antorcha puesta con `addFixed` junto al jugador va con prioridad cercana, la lejana
  detrás, y acaban como hornear de cero.
- `test/relevo.test.ts`: cambios que llegan antes de que acaben los trabajos de luz; una luz quitada no vuelve.
- `test/agua-reposo.test.ts`: el reposo con huellas fijadas con el código de antes; `asleep`.
- `test/agua-vista.test.ts`: lo que copia `WaterView` es lo mismo que la copia entera.

Comprobado el 2026-11-16: 9 archivos, 66 pruebas, pasan en 1,9 s.

`scripts/water-cost.ts` y `scripts/rebake-cost.ts` no corren: importan `src/content/themes`, que ya no existe (ahora es
`src/samples/themes`). Para el agua, la medida es `app/agua.html?medir=1` en el navegador.
