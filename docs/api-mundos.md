# API de mundos para agentes

Un agente construye un mundo entero de vóxeles desde una **receta**: datos JSON, sin escribir código. La misma receta
da siempre el mismo mundo. Hay dos formas de usarla:

- **En el navegador**, con vista en vivo: `window.voxpixWorld` en la demo de escenario (`escena.html`). La persona ve
  cómo el agente construye.
- **Sin navegador**, desde la CLI: `voxpix world receta.json salida.png`.

Todo va en ejes del modelo del mundo: x hacia el este, y hacia el norte, z hacia arriba. Un vóxel es un píxel del juego.
La receta está en `src/world/recipe.ts`. Quien escriba código puede usar directamente `buildRecipe(receta)` o
`buildWorldState` con un `WorldLook` (ver `docs/motor.md`).

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
| `theme` | un tema de MUESTRA (`medieval`, `cyberpunk`, `oficina`): completa generador, colores, fuente, luz ambiente y piezas (puertas, ventanas, escritorios). Lo que pongas encima, manda |
| `ramps` | los colores de cada papel: `floor`, `wall`, `cap`, `column`, `water`, `wood`, `metal`, `flame`, `neonPink`, `neonCyan`, `screen`, `cloth`, `warmGlass`, `darkGlass`, `grass`. Cada uno, una lista de colores o `{ colors, emissive, material }`. El agua emisiva brilla sola |
| `fountain` | el pilón con agua y fuego |
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
npm run voxpix -- world receta.json mundo.png [--at x,y] [--size 384x216] [--ticks 30] [--scale 2] [--whole] [--lights no] [--info info.json]
```

Pinta en la CPU la vista centrada en `--at` (por defecto, la salida) tras `--ticks` pasos del mundo, o el mundo entero
con `--whole`. Escribe en la salida estándar, o en `--info`, lo mismo que `info()`. Con `-` en lugar del PNG, solo la
información.
