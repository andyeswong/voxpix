# API de mundos para agentes

Un agente construye un mundo entero de vóxeles desde una **receta**: datos JSON, sin escribir código. La misma receta
da siempre el mismo mundo. Hay dos formas de usarla:

- **En el navegador**, con vista en vivo: `window.voxpixWorld` en la demo de escenario (`escena.html`). La persona ve
  cómo el agente construye.
- **Sin navegador**, desde la CLI: `voxpix world receta.json salida.png`.

Todo va en ejes del modelo del mundo: x hacia el este, y hacia el norte, z hacia arriba. Un vóxel es un píxel del juego.
La receta está en `src/world/recipe.ts`. Quien escriba código puede usar directamente `buildRecipe(receta)` o
`buildWorldState` con un `WorldLook` (ver `docs/motor.md`).

## Un ejemplo mínimo

`scripts/mundos/toxico.json`, el cyberpunk de muestra con un lago de agua tóxica que brilla y humo:

```json
{
  "theme": "cyberpunk",
  "seed": 3,
  "ramps": { "water": { "colors": ["#0a2a10", "#145a20", "#22a03a", "#4ee060", "#b0ffb8"], "emissive": true } },
  "effects": [{ "preset": "humo", "x": 140, "y": 335, "z": 4 }]
}
```

Desde un clon limpio (`git clone`, `bun install --frozen-lockfile`), en la raíz del repo:

```sh
bun run voxpix world scripts/mundos/toxico.json toxico.png --at 140,330 --scale 2 --info toxico.json
```

Sale `toxico.png` (768 x 432): el lago verde brillando en medio de la vista. `toxico.json` trae la información del
mundo; su `hash` es la huella, la misma en cualquier máquina: `281c7658`.

## La receta

```json
{
  "theme": "cyberpunk",
  "seed": 3,
  "ramps": { "water": { "colors": ["#0a2a10", "#145a20", "#22a03a", "#4ee060", "#b0ffb8"], "emissive": true } },
  "pillar": "round",
  "foliage": [{ "type": "grass", "density": 0.3 }],
  "stamps": [{ "model": { "format": "voxpix", "...": "..." }, "x": 150, "y": 345 }],
  "lights": [{ "kind": "lamp", "x": 120, "y": 120, "z": 20 }],
  "effects": [{ "preset": "humo", "x": 100, "y": 100, "z": 5 }]
}
```

| Campo | Qué es |
|---|---|
| `seed` | la semilla del mapa |
| `generator` | las reglas del generador (`GeneratorSpec`: tamaño, suelos, fachada, agua, columnas, muebles). Con `theme`, el del tema |
| `shape` | la forma de la sala (ver "Formas de sala"). Sin ella, el rectángulo entero |
| `size` | el tamaño de la sala en losetas, `[cols, rows]` (manda sobre el del generador) |
| `rooms` | varias salas unidas en un mapa (ver "Salas con puertas"): `[{ gx, gy, shape?, seed? }]` |
| `theme` | un tema de MUESTRA (`medieval`, `cyberpunk`, `oficina`): completa generador, colores, fuente, luz ambiente y piezas (puertas, ventanas, escritorios). Lo que pongas encima, manda |
| `ramps` | los colores de cada papel: `floor`, `wall`, `cap`, `column`, `water`, `wood`, `metal`, `flame`, `neonPink`, `neonCyan`, `screen`, `cloth`, `warmGlass`, `darkGlass`, `grass`. Cada uno, una lista de colores o `{ colors, emissive, material }`. El agua emisiva brilla sola |
| `fountain` | el pilón con agua y fuego |
| `wallHeight` | el alto de todas las paredes, de 2 a 40 (16 por defecto). Todas miden lo mismo: la norte con su fachada, las de los lados, la del sur y las de una sala con forma |
| `pillar` | `"round"` (por defecto), `"none"` o un modelo de vóxeles, que se estampa centrado en cada loseta de columna |
| `prop` | `"block"` (por defecto), `"none"` o un modelo, que se estampa centrado en la huella de cada mueble |
| `foliage` | vegetación: `[{ type, density, ramp, heads, on }]`. Tipos: `grass`, `flowers`, `reeds`, `lilies`, `bush`. Las rampas van por nombre; si falta una de las de vegetación, se añade |
| `stamps` | modelos sueltos: `[{ model, x, y, z, yaw }]`. Sin `z`, se apoya en el suelo. `yaw`, de 90 en 90 |
| `lights` | luces fijas (horneadas): `[{ kind, x, y, z, radius, intensity, color }]` |
| `effects` | emisores de partículas: `[{ preset, x, y, z }]` |
| `ambient` | la luz ambiente para pintarlo, `[r, g, b]` |

Los modelos son el JSON de voxpix: el de "Guardar" del editor, o `voxpix.save()`. Así un agente hace una mampara o una
taza en el editor (`window.voxpix`) y la pone en el mundo con la receta. Sus rampas se suman a la paleta del mundo
(como mucho 64 en total).

## Formas de sala

`shape` cambia la forma de lo que queda dentro de las paredes. Las paredes siguen el contorno, con una loseta de grueso
como las de fuera, y lo que queda fuera de la sala es el vacío: ni suelo ni pared. Todo el suelo queda conectado: si una
zona queda suelta, se cierra. El agua, las columnas, los muebles, la salida y los materiales caen siempre dentro. Las
columnas dejan dos losetas libres hasta cualquier pared, para no tapar un pasillo. La fachada norte solo está donde da a
la sala.

| `kind` | Opciones |
|---|---|
| `L` | `corner`: la esquina que se quita (`ne` por defecto, `nw`, `se`, `sw`); `size`: la fracción de cada lado que se quita (0,45) |
| `T` | `bar`: dónde va la barra (`north` por defecto, o `south`); `barDepth`: su fondo (0,4); `stem`: el ancho del tallo (0,3) |
| `corridors` | `rooms`: cuántas salas (5); `width`: el ancho de los pasillos en losetas (3) |
| `maze` | `cell`: losetas por celda (4: pasillos de 3 y paredes de 1); `loops`: la fracción de paredes que se abren de más para que haya vueltas (0,1) |
| `plan` | `rows`: el plano, una cadena por fila de `cols` caracteres (`#` pared, lo demás suelo); el borde y la fachada son pared siempre |

```json
{ "theme": "medieval", "seed": 7, "shape": { "kind": "maze", "loops": 0.2 } }
```

## Salas con puertas

Para un mapa de varias salas, cada sala (un bloque) trae cuatro huecos de puerta, uno en el centro de cada lado, de 3
losetas de ancho. Cada hueco tiene un pasillo corto hasta el suelo de la sala, aunque la forma lo tape. Nacen cerrados:
la pared del borde sigue ahí, y se ven como un nicho. Una puerta solo se abre si hay otra sala pegada en ese lado.

El motor genera los bloques; la disposición la decide quien pide el mapa (el juego). En la receta, `rooms` dice dónde va
cada bloque en una rejilla: `gx` crece hacia el este y `gy` hacia el sur. Todas las salas miden lo mismo (`size`). Lo
que no cubre ninguna sala es el vacío. La fachada decorada es la de las salas de la fila de arriba, y la salida, la de
la primera sala.

```json
{ "theme": "medieval", "seed": 5, "size": [24, 18], "rooms": [
  { "gx": 0, "gy": 0, "shape": { "kind": "maze" } },
  { "gx": 1, "gy": 0, "shape": { "kind": "T", "bar": "south" } },
  { "gx": 1, "gy": 1, "shape": { "kind": "L", "corner": "nw" } },
  { "gx": 2, "gy": 1, "shape": { "kind": "corridors", "rooms": 3 } }
] }
```

`info()` trae las puertas (`doors`: lado, losetas, abierta o no, de qué sala) y dónde empieza cada sala (`blocks`).

En código: `generateLayout({ ...spec, doors: {} }, semilla)` da una sala con sus huecos; `openDoors(sala, ['e', 's'])`
abre los de esos lados, y `stitchRooms([{ layout, gx, gy }, ...])` une las salas y abre las puertas entre vecinas.

## En el navegador: `window.voxpixWorld`

`voxpixWorld.help()` devuelve la guía en texto.

| Función | Qué hace |
|---|---|
| `build(receta)` | construye el mundo (promesa con `info()`) |
| `update(cambios)` | la receta de ahora con esos campos cambiados |
| `seed(n)` | la misma receta con otra semilla |
| `stamp(modelo, x, y, z?, yaw?)` | añade un modelo al mundo |
| `foliage(tipo, opciones?)` | añade vegetación |
| `themes()` | vuelve a la demo con su tema |
| `light({ kind, x, y, z, ... })`, `removeLight(id)` | una luz dinámica, en vivo |
| `effect(preset, x, y, z)`, `removeEffect(id)`, `burst(preset, x, y, z, n?)` | partículas, en vivo |
| `weather('nada' \| 'lluvia' \| 'nieve')`, `lights(on)` | el tiempo; luces sí o no |
| `goto(x, y)` | lleva a MAIA, y con ella la cámara |
| `mode('2d' \| 'voxel' \| 'explore')`, `camera({ yaw, elevation, zoom })` | la vista |
| `png({ scale })` | lo que se ve ahora: `{ width, height, base64 }` |
| `info()` | tamaño, salida, columnas, muebles, fuente, fachada, luces, agua, rampas y huella |
| `recipe()` | la receta de ahora: guárdala y vuelve a pasarla a `build` |
| `groundAt(x, y)`, `solidAt(x, y, z)`, `waterAt(x, y)`, `hash()` | consultas |
| `roles()`, `presets()` | los papeles de `ramps`; los efectos, vegetaciones, luces y temas que hay |

Las funciones de construir reconstruyen el mundo entero (1 o 2 segundos). Las de en vivo no reconstruyen nada. Los
errores son excepciones que dicen qué hacer, por ejemplo: «no hay efecto "fuego"; hay: chispas, humo, ...».

Con Playwright o CDP:

```js
await page.goto('http://localhost:5190/escena.html');
await page.waitForFunction(() => window.voxpixWorld);
const info = await page.evaluate(() => window.voxpixWorld.build({ theme: 'oficina', seed: 2 }));
const shot = await page.evaluate(() => window.voxpixWorld.png({ scale: 2 }));   // { base64 }
```

## Sin navegador: la CLI

```sh
bun run voxpix world receta.json mundo.png [--at x,y] [--size 384x216] [--ticks 30] [--scale 2] [--whole] [--lights no] [--info info.json]
```

Pinta en la CPU la vista centrada en `--at` (por defecto, la salida) tras `--ticks` pasos del mundo, o el mundo entero
con `--whole`. Escribe en la salida estándar, o en `--info`, lo mismo que `info()`. Con `-` en lugar del PNG, solo la
información.
