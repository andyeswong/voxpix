# API para agentes: `window.voxpix`

La app expone en `window.voxpix` lo mismo que hacen sus herramientas, sin ratón (`app/src/api.ts`). Cualquier cosa
que controle un navegador puede construir modelos con ella: la consola, Playwright, Puppeteer o CDP. Mientras tanto,
el resultado se ve en la app, como si lo hiciera una persona.

`voxpix.help()` devuelve la guía en texto. Las reglas:

- Cada llamada que cambia el modelo es un paso de deshacer. `voxpix.batch(fn)` junta varias en uno.
- Los errores son excepciones con un mensaje que dice qué hacer, por ejemplo: «no hay rampa "x"; las rampas son:
  hierba, tierra...».
- Todo es síncrono, salvo `png()`, que devuelve una promesa.

## Coordenadas y materiales

- **Coordenadas:** enteras. x va hacia el este, y hacia el norte y z hacia arriba (z >= 0). El pivote (0, 0, 0)
  está en el centro del lienzo; en un lienzo de 128, x e y van de -64 a 63.
- **Material:**
  - un número (rampa*16 + tono + 1);
  - `"nombre"`: la rampa con ese nombre, en su tono del medio, como mucho el 2 (en una rampa de 4 tonos, el 1);
  - `"nombre:tono"`;
  - `[rampa, tono]`;
  - `null`: vacío (borra).

## Funciones

### Modelo y lienzo

| Función | Devuelve | Qué hace |
|---|---|---|
| `info()` | objeto | Nombre, vóxeles, lienzo, rampas, luces, tipos de luz, la vista y si se renderiza en la GPU o en la CPU. |
| `newModel(name, w, d, h)` | `info()` | Un modelo vacío con la paleta actual y un lienzo de w x d x h. Quita las luces. |
| `palette([{ name, colors, emissive?, material?, props? }], outline?)` | rampas | Cambia la paleta: rampas de 1 a 16 colores `#rrggbb`, de oscuro a claro. `emissive` hace que la rampa brille sola. `material` es uno de los de `materials()` y `props` ajusta sus propiedades (ver Materiales). No se deshace, y falla si el modelo usa una rampa o un tono que la nueva paleta no tiene, o si el material o una propiedad no existen. |
| `materials()` | lista | Los materiales con todas sus propiedades. |
| `ramp(name, '#rrggbb', { tones?, hueShift? })` | índice | Una rampa nueva generada desde un color: de 2 a 16 tonos (por defecto 5), con las sombras girando hacia el frío y las luces hacia el cálido (`hueShift` en grados, por defecto 22). Se deshace. |
| `setTone(rampa, tono, '#rrggbb')` | - | Cambia un color de la paleta; lo pintado con él cambia también. `rampa` es el índice o el nombre. |
| `palettes()` | lista | Las paletas de la comunidad que trae: `id`, nombre, autor y cuántos colores. |
| `loadPalette(id \| ['#rrggbb', ...], 'añadir' \| 'reemplazar')` | rampas | Una paleta (por su `id`, o colores sueltos), agrupada en rampas. `añadir` las pone detrás; `reemplazar` cambia la paleta entera y lo pintado pasa al color más parecido. |
| `removeUnusedRamps()` | cuántas | Quita las rampas que ningún vóxel usa. |
| `canvas(w, d, h, crop?)` | lienzo | Cambia el tamaño del lienzo. Con `crop`, borra lo que queda fuera. |
| `load(json)` | `info()` | Abre un `.voxpix.json`, como objeto o como texto. |
| `save()` | objeto | El `.voxpix.json` del modelo, con sus luces. |
| `importPxl(source, prefijo?)` | `info()` | Un `.px.js`: su pila de capas `<prefijo>_zNN` como modelo nuevo, con la paleta del archivo. |

### Pintar

| Función | Devuelve | Qué hace |
|---|---|---|
| `get(x, y, z)` | `{ramp, tone, name, value}` o `null` | Qué hay en una celda. |
| `set(x, y, z, material)` | - | Un vóxel. |
| `voxels([[x, y, z, material], ...])` | cuántos | Muchos vóxeles en un solo paso (un terreno entero, una copa de árbol...). |
| `box(x0, y0, z0, x1, y1, z1, material)` | celdas | La caja entre dos esquinas, ambas incluidas. Con `null`, la vacía. |
| `fill(x, y, z, material)` | celdas | El cubo: la mancha contigua (4 vecinos) de la capa z que empieza en (x, y), con el mismo valor, pasa a `material`. |
| `water(x, y, z, material?)` | `{cells, spill}` | Agua hasta la altura z desde esa celda vacía: todas las celdas vacías conectadas que no pasan de esa altura, como se llenaría una cuenca. Los bordes del lienzo hacen de pared; `spill` dice que el agua llegó a ellos. Por defecto usa la rampa `agua` o `water`. |
| `foliage(x0, y0, x1, y1, {type, density?, seed?, ramp?, heads?, on?})` | `{plants, voxels, ramps}` | Vegetación sobre la superficie del rectángulo, en un paso de deshacer. `type`: `grass` (matas de 1-2), `flowers` (tallo y cabeza), `bush` (manchas de radio 2-3, no se atraviesan), `reeds` (juncos donde el agua cubre 1-2, pegados a la orilla) o `lilies` (nenúfares a ras del agua). Hierba, flores y arbustos crecen sobre la rampa `hierba` (o las de `on`), y la hierba es más densa junto al agua. Con la misma `seed`, lo mismo. Si faltan sus rampas (`hierba-alta`, `flor-*`, `junco`, `nenufar`, `arbusto`), las añade. |
| `batch(fn)` | lo que devuelva `fn` | Lo que haga `fn`, en un solo paso de deshacer. |
| `undo()`, `redo()` | si había | Deshacen y rehacen. |

El espejo de la interfaz (M) también se aplica a `set`, `voxels`, `box` y `fill`, pero no al agua.

### Luces

| Función | Devuelve | Qué hace |
|---|---|---|
| `light(x, y, z, kind?)` | id | Una fuente de luz en la celda. Si ya hay una, le cambia el tipo. `kind`: `torch` (por defecto), `lamp`, `brazier`, `neon-pink`, `neon-cyan`, `lantern` o `screen`. |
| `removeLight(id)` o `removeLight(x, y, z)` | si había | La quita. |
| `lights()` | lista | Las fuentes, con su id, tipo y celda. |

### Ver y exportar

| Función | Devuelve | Qué hace |
|---|---|---|
| `view({ yaw, elevation, outline, lit, ambient })` | la vista | La vista previa, que también es lo que sale en el PNG. `outline`: `outer`, `both` o `none`. `lit` enciende la iluminación; `ambient` va de 0,1 a 1. |
| `png({ sheet?, scale? })` | promesa de `{name, base64}` | El PNG de la vista, o la hoja de 8 ángulos con `sheet: true`, con fondo transparente, un encuadre que contiene el modelo entero y luz si `lit`. |
| `firstPerson({ x, y, z, yaw?, pitch?, fov?, width?, height?, scale? })` | promesa de `{name, base64}` | El PNG en primera persona desde ese ojo, con fondo transparente: para previsualizar el modelo por dentro. `x, y, z`: el ojo, en vóxeles (los mismos ejes que el modelo; z = 0 es el suelo). `yaw`: en GRADOS, 0 mira al norte (+y), 90 al este (+x), 180 al sur, 270 al oeste. `pitch`: en grados, positivo hacia arriba, de -89 a 89. `fov`: campo de visión horizontal en grados (70). `width, height`: la resolución del render (320 x 180); `scale`: ampliación entera sin suavizar. Con la iluminación encendida (`view({ lit: true })`), alumbran las fuentes del modelo. |
| `explore(open?, { height?, fov? })` | `{open, height, fov}` | Abre (o cierra) la vista Explorar. `height`: la altura del personaje invisible en vóxeles, de 1 a 64 (el ojo va al 90 % de esa altura); `fov` en grados. |
| `tool(name)` | - | Cambia la herramienta de la interfaz, para que quien mire vea qué haces: `pen`, `erase`, `paint`, `pick`, `box`, `fill`, `light` o `fluid`. |

## Materiales

Cada rampa es un material: un juego de propiedades que el motor lee por separado (la luz, el agua, el paso). Sin
`material` ni `props`, una rampa es sólida.

| Propiedad | Qué hace | Sólido |
|---|---|---|
| `light` | cuánta luz deja pasar cada vóxel (0 = opaco) | 0 |
| `backlit` | luz que recibe una cara iluminada por detrás | 0 |
| `bed` | en el juego, el agua lo cuenta como fondo y pared | `true` |
| `blocks` | en el juego, bloquea el paso (jugador, entidades, disparos) | `true` |
| `emissive` | brilla solo | `false` |
| `reflect` | **NO IMPLEMENTADO**: reservado para los reflejos (metal, agua). Hoy no lo pinta ningún render: no lo uses esperando reflejos | 0 |

| Material | Para qué | Propiedades |
|---|---|---|
| `solido` | lo de siempre | las del sólido |
| `follaje` | hierba, flores, hojas | `light` 0,5, `backlit` 0,25, `bed` y `blocks` no |
| `arbusto` | follaje que no se atraviesa | como el follaje, con `blocks` |
| `vidrio` | translúcido: ventanas, mamparas | `light` 0,85 (pasa la luz; se ve como un bloque de su color, no a través) |
| `metal` | metal | `reflect` 0,6 (reservado) |

```js
vp.palette([...vp.info().ramps, { name: 'cristal-azul', colors: ['#24465a', '#3f7a96', '#7ab8d6'], material: 'vidrio', props: { light: 0.6 } }]);
```

## Un ejemplo corto

```js
const vp = window.voxpix;
vp.newModel('torre', 32, 32, 24);
vp.palette([
  { name: 'hierba', colors: ['#2d4a2a', '#3f6b33', '#5a8a3c', '#7fae4f'] },
  { name: 'piedra', colors: ['#2e2f38', '#4a4c58', '#6c6f7c', '#9a9dab'] },
  { name: 'agua', colors: ['#16324d', '#1f4f78', '#2f74a6', '#5fa8d6'] },
]);
vp.batch(() => {
  vp.box(-16, -16, 0, 15, 15, 1, 'hierba:2');      // el suelo
  vp.box(-12, -12, 1, -6, -6, 1, null);             // un hoyo para un estanque
  vp.box(2, 2, 2, 7, 7, 14, 'piedra');              // una torre
  vp.box(3, 3, 2, 6, 6, 13, null);                  // hueca
});
vp.water(-9, -9, 1);                                // el estanque
vp.light(4, 1, 6, 'torch');                         // una antorcha en la puerta
vp.view({ yaw: -30, elevation: 35, lit: true, ambient: 0.35 });
const { name, base64 } = await vp.png({ scale: 4 });
```

`scripts/api/paisaje-medieval.js` es un ejemplo completo: un paisaje de 128 x 128 con terreno, río, lago, castillo,
casas, puente, 40 árboles y 11 luces. Las ediciones tardan 0,08 s y el PNG iluminado 0,3 s.

## Desde fuera del navegador

Con Playwright:

```js
await page.goto('http://localhost:5190/');
await page.waitForFunction(() => window.voxpix);
const info = await page.evaluate(() => window.voxpix.info());
await page.evaluate(() => window.voxpix.box(-4, -4, 0, 3, 3, 3, 'piedra'));
const png = await page.evaluate(() => window.voxpix.png({ scale: 4 }));   // { name, base64 }
```

Con CDP a pelo es igual: `Runtime.evaluate` con `awaitPromise: true` y `returnByValue: true`.
