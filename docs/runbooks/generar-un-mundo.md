# Generar un mundo por semilla

Cómo sacar un mundo de bloques de una semilla: relieve, estratos, agua, vetas, cuevas y lo sembrado. Hay tres
generadores, de menos a más:

| Función | Archivo | Para qué |
|---|---|---|
| `generateTerrain(spec, grid)` | `src/world/terrain.ts` | solo superficie, con nombres de bloque; escribe directo en un `BlockGrid`. Sin agua ni cuevas |
| `generateMap(spec)` + `applyMap(map, grid)` | `src/world/mapgen.ts` | un mapa entero de tamaño fijo, en celdas, con agua, orilla y cuevas |
| `generateRegion(spec, region)` + `applyRegion(r, grid, at)` | `src/world/regiongen.ts` | el mismo mapa por cajas, en cualquier sitio y orden: un mundo sin bordes |

Los tres usan el ruido de `src/worldgen/noise.ts` (`fbmN`, `lattice`) y el azar con semilla de `src/sim/rng.ts`
(`createRng`). Ninguno usa reloj ni `Math.random`.

## El spec: `MapSpec`

`generateMap` y `generateRegion` comparten `MapSpec`. Los materiales son números que pone quien llama: con un
`BlockGrid`, `set.index(id)`. 0 es aire.

```ts
const T = (id: string) => set.index(id);
const spec: MapSpec = {
  seed: 7, width: 32, depth: 32, height: 12,                          // celdas: x, y, z
  surface: { base: 6, amplitude: 3, scale: 7 },                       // octaves: 3 por defecto
  strata: [{ material: T('hierba'), depth: 1 }, { material: T('tierra'), depth: 2 }, { material: T('piedra') }],
  seaLevel: 6, water: T('agua'), shore: { material: T('arena'), width: 1, depth: 1 },
  veins: [{ material: T('mena'), in: [T('piedra'), T('tierra')], z: [1, 4], density: 0.05, size: [2, 4] }],
  caves: { count: 3, z: [1, 5], length: [10, 18], radius: [1, 1.6] },
  scatter: [
    { on: [T('hierba')], density: 0.05, spacing: 3, structure: [[0, 0, 1, T('tronco')], [0, 0, 2, T('tronco')], [0, 0, 3, T('hojas')]] },
    { on: [T('hierba')], density: 0.4, structure: [[0, 0, 1, T('flor')]] },
  ],
};
```

Es, recortado, el `SPEC` de `test/mapgen.test.ts`.

- `surface`: la altura de cada columna, `base ± amplitude` con ruido de `scale` celdas.
- `strata` (en `generateTerrain`, `layers`): de arriba abajo, material y grosor. El último, sin `depth`, llega hasta
  abajo.
- `seaLevel` + `water`: las columnas por debajo se llenan de agua hasta `seaLevel`. Sin `water`, no hay agua.
- `shore`: el lecho de los lagos y la tierra a `width` columnas del agua, que no sube más de 1 sobre el nivel, pasan a
  `material` en sus `depth` celdas de arriba.
- `veins`: manchas de `size` celdas que crecen por vecinos dentro de los materiales `in` y la franja `z`. `density` es
  la parte aproximada de esas celdas que acaba en veta.
- `caves`: `count` gusanos entre las z `z`, de `length` celdas, que vacían esferas de `radius`. No tocan la capa de
  abajo ni las columnas con agua.
- `scatter`: la siembra. Sobre las columnas cuyo material de arriba está en `on`, fuera del agua, con probabilidad
  `density` y a `spacing` columnas o más, la estructura `[dx, dy, dz, material]` relativa a la celda de arriba
  (`dz = 1`, la de encima). Solo si cabe entera y va sobre aire.

## Un mapa entero: `generateMap`

```ts
import { generateMap, applyMap, mapColumn, mapWater, mapHash } from '../src/world/mapgen';
const map = generateMap(spec);       // puro: no toca ningún mundo
applyMap(map, grid);                 // o applyMap(map, grid, { skip: [T('agua')] }) si el agua va en un WaterLayer
```

- `map.cells`: el material de cada celda, índice `(z * depth + y) * width + x`.
- `map.heights`: por columna, la celda más alta que no es aire ni agua (-1 si nada).
- `map.sown`: `{ rule, x, y, z }`, con la estructura en `map.structures[rule]`. No está en `cells`.
- `mapColumn(map, x, y)`: los tramos `[z0, z1, material]` de una columna.
- `applyMap` escribe los tramos con `grid.fill` y lo sembrado con `grid.set` (variantes tapadas y luces).
- `mapWater(map, size, water)`: `{ wet, waterTop }` por columna de vóxeles, para un `WaterLayer`.

## Un mundo por regiones: `generateRegion`

```ts
import { generateRegion, applyRegion, regionHash, type RegionSpec } from '../src/world/regiongen';
const r = generateRegion(spec, { x0, y0, z0, width: 16, depth: 16, height: 24 });   // en celdas, x0 e y0 pueden ser negativos
applyRegion(r, grid, [gx, gy, gz]);   // o grid.stampRegion(r, [gx, gy, gz]): lo mismo, por trozo de vóxeles
```

- `RegionSpec` es `MapSpec` con `bottom?`: por debajo, aire. Sin `bottom`, el último estrato sigue sin fin.
- `width` y `depth` del spec ya no limitan nada: solo dan la densidad de las cuevas.
- `r.sown`: lo sembrado cuya celda de arriba está en la región. `r.touching`: lo que escribe alguna celda de la región,
  aunque nazca fuera. `applyRegion` escribe `touching` recortado a la región.
- Constantes: `CAVE_CELL = 32` (macrocelda de las cuevas, en columnas) y `VEIN_REACH = 3`.
- El mismo spec en `generateMap` y en `generateRegion` no da lo mismo: vetas, cuevas y siembra cambian de dibujo, con
  la misma densidad.

## La regla de oro: el orden

Del comentario de cabecera de `regiongen.ts`: lo que sale en una región **no depende de qué otras regiones se
generaron antes ni de en qué orden**. Todo sale de la semilla y de la posición. Así:
- las vetas arrancan por un hash de su celda (`hash3`) y crecen con un azar sembrado por esa celda, a `VEIN_REACH` o
  menos;
- las cuevas salen por macrocelda, cada una con su azar por hash; una región recorre las vecinas que pueden llegar;
- en la siembra, un candidato gana si su prioridad (otro hash) es la mayor entre los que choca; empate, el de menor
  y, luego x;
- `generateRegion` trabaja en una caja con margen alrededor de la región para decidir lo de su borde.

Dentro de un spec, el orden sí cuenta, y es fijo:
1. relieve y estratos, 2. agua y orilla, 3. vetas, 4. cuevas, 5. siembra.
- Las vetas van "en orden fijo y cada una con su azar" (`mapgen.ts`): la semilla de cada una sale de su índice, y cada
  una ve lo que dejaron las anteriores.
- Las reglas de siembra van en orden: una no puede pisar lo sembrado por las anteriores.
- Por eso una veta o una regla nueva va **al final** de su lista. Moverla de sitio cambia las que la siguen, y la
  huella.

Si una pieza deja de ser local (un azar en serie, siembra sin margen, cuevas sin las macroceldas vecinas), falla la
prueba de 192 x 192.

## Solo superficie: `generateTerrain`

```ts
import { generateTerrain, type TerrainSpec } from '../src/world/terrain';
const { heights } = generateTerrain({
  seed: 7,
  surface: { base: 6, amplitude: 3, scale: 9, octaves: 3 },
  layers: [{ block: 'hierba', depth: 1 }, { block: 'tierra', depth: 2 }, { block: 'piedra' }],
  veins: [{ block: 'carbon', in: 'piedra', chance: 0.08, size: [1, 3], bz: [0, 5] }],
  scatter: [{ on: 'hierba', density: 0.02, spacing: 4, structure: [[0, 0, 1, 'tronco'], [0, 0, 2, 'hojas']] }],
}, grid);
```

Trabaja con nombres de bloque (un nombre que no está en el set es un error que lo nombra) y escribe en la rejilla. Las
vetas usan `chance` y `bz`, no `density` y `z`.

## Las pruebas: la huella

La huella es FNV-1a de 32 bits. `mapHash(map)` cuenta el tamaño, las celdas y lo sembrado; `regionHash(r)`, la caja,
las celdas, las alturas y lo sembrado.

- `test/mapgen.test.ts`: la misma semilla da la misma huella y la fijada (`PINNED = '1901d0a1'`); otra semilla, otra.
  Además, cada regla y que `applyMap` deja la rejilla igual que el mapa.
- `test/mundo-regiones.test.ts`: un mundo de 192 x 192 entero y en trozos de 16 x 16 en orden aleatorio da las mismas
  celdas, alturas y siembra; también cortado en z y lejos del origen (en negativo); `applyRegion` trozo a trozo deja
  la misma rejilla; y la huella fijada de una región de 64 x 64: `'6ea96928'`.
- `test/trozo-rapido.test.ts`: `stampRegion` y `stampRegionJob` dejan lo mismo que `applyRegion`.
- `test/terreno.test.ts`: `generateTerrain` (misma semilla, mismo mundo; capas, vetas, árboles). No confundir con
  `test/terrain.test.ts`, que es el agua por piezas.

    bunx vitest run test/mapgen.test.ts test/mundo-regiones.test.ts test/trozo-rapido.test.ts test/terreno.test.ts

Si cambia una huella, no se actualiza sin más: se mira qué cambió en el mundo y se cambia a mano.

## Medir: el banco

`scripts/bench-mapa.ts` genera y escribe un mapa de 48 x 48 x 12 bloques de 8 (384 x 384 x 96 vóxeles) con vetas de
carbón, hierro y oro, cuevas, árboles y flores, por semilla:

    bun scripts/bench-mapa.ts 1
    semilla 1: generar 4.8 ms · escribir en el mundo 241 ms (8.21 M vóxeles) · 15691 celdas llenas, 36 de agua, 141 sembradas · huella 14d521f6

Sin argumento corre las semillas 1, 2 y 3. La huella tiene que salir igual en cualquier máquina; los tiempos, no.
Generar es barato; lo que cuesta es escribir los vóxeles.

No hay banco para `generateRegion`. Los tiempos de `docs/motor.md` ("Mundo por regiones") no salen de ningún script del
repo.

## Paso a paso

1. Escribir el `MapSpec` con los índices del set (`set.index`).
2. Mapa fijo: `generateMap` + `applyMap`. Mundo sin bordes: `generateRegion` por trozo + `applyRegion` o
   `grid.stampRegion`.
3. Una veta o regla de siembra nueva, al final de su lista.
4. Fijar la huella del spec en una prueba (`mapHash` o `regionHash`), como `test/mapgen.test.ts`.
5. Si es por regiones, comprobar entero contra trozos en orden aleatorio, como `test/mundo-regiones.test.ts`.
6. Medir con `bun scripts/bench-mapa.ts` y anotar la huella.
