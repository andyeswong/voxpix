# Crear un personaje con clips

Lo aprendido con el minero enano (`scripts/enano.js`, `models/enano/`, `test/enano.test.ts`). Commits 977f717 (el
enano) y be1a8f3 (la variante B). Vale para cualquier cuerpo pequeño que un juego carga con sus animaciones.

## Qué sale

Un `.voxpix.json` de versión 3 (`src/core/anim.ts`): el modelo quieto y una lista de clips con nombre, cada uno con
sus cuadros, si se repite y su rig.

    { format: 'voxpix', version: 3, name, palette, voxels: <cuadro 0 del primer clip>,
      clips: [{ name, loop, frames: [{ ms, voxels }, ...], rig? }, ...] }

El enano lleva tres clips:

| Clip | `loop` | Cuadros | `frameMs` del rig | Qué hace |
|---|---|---|---|---|
| `quieto` | `true` | 2 | 400 | los brazos bajan 1 (respira) |
| `andar` | `true` | 5 | 110 | zancada, paso, la otra zancada, paso; brazos al revés que las piernas |
| `atacar` | `false` | 4 | 90 | el brazo derecho sube y baja por delante, el cuerpo se inclina |

Un juego lo lee con `clipsFromFile(file)` y elige el cuadro con `clipFrameAt(clip, ms)`. `clipDone(clip, ms)` dice si
un clip sin `loop` ha acabado (para volver de `atacar` a `quieto`).

El enano no tiene clip de morir. La API lo prevé: `vp.newClip('morir', { loop: false })` y `vp.loop(false)` lo dejan
en su último cuadro. No hay ejemplo en el repo.

## 1. Las capas: el modelo quieto

El script corre en la página del editor con `window.voxpix` (`docs/api-agentes.md`). Ejes: x este, y norte (el frente
mira a -y), z arriba, los pies en z = 0.

1. `vp.newModel('enano', 12, 12, 16)` y `vp.palette([...])` con una rampa por zona: `piel`, `pelo`, `camisa`,
   `pantalon`, `botas`, `casco`, `faro` (`emissive: true`, la lámpara del casco), `ojos`.
2. Los vóxeles se juntan en un `Map` con dos ayudas, `put(x, y, z, 'rampa:tono')` y `box(x0, y0, z0, x1, y1, z1, m)`,
   donde `m` puede ser una función de `(x, y, z)`.
3. De abajo arriba, una franja de z por zona:
   - botas z 0-1 (la puntera, de frente, un tono más clara) y calzas z 2-3;
   - cinturón z 4 con hebilla dorada; túnica z 5-8, más clara de frente;
   - brazos en x -3 y 2, z 5-8, con la mano en z 4;
   - cabeza z 9-12, pelo detrás, ojos en z 11, nariz saliente en y -2;
   - barba delante del pecho (y -2, z 5-10);
   - casco: ala en z 12 (una vuelta más ancha), cúpula en z 13, faro delante;
   - pico a la espalda (y 2): mango en diagonal y cabeza de hierro.
4. `vp.voxels([...V.values()])` y `vp.frameMs(100)` para el cuadro 0.

## 2. El rig

El rig se guarda en el archivo (`RigSpec`, `src/anim/rig.ts`) y lo aplica `rigFromSpec` + `rigFrames`:

- `parts`: `{ name, boxes?, ramps?, pivotZ?, footZ? }`. Un vóxel es de la parte si cae en alguna caja
  `[x0, y0, z0, x1, y1, z1]` (incluidas; `null` es abierto) y su rampa está en `ramps`. Si cae en dos, gana la
  primera. Lo que no es de ninguna es `body`.
- `frames`: `{ moves: { parte: { dx?, dy?, dz?, stride? } }, airborne? }`. `moves.body` mueve el resto.
- `stride`: cuánto adelanta (-y) la punta (`footZ`) mientras `pivotZ` se queda. Es la zancada.

Las partes del enano:

```js
const R = { piel: 0, pelo: 1, camisa: 2, pantalon: 3, botas: 4 };   // índices de rampa
const legs = [
  { name: 'L', boxes: [[-2, -3, 0, -1, 0, 3]], ramps: [R.botas, R.pantalon], pivotZ: 3, footZ: 0 },
  { name: 'R', boxes: [[0, -3, 0, 1, 0, 3]], ramps: [R.botas, R.pantalon], pivotZ: 3, footZ: 0 },
];
const arms = [
  { name: 'brazoL', boxes: [[-3, -3, 4, -3, 1, 8]], ramps: [R.camisa, R.piel] },
  { name: 'brazoR', boxes: [[2, -3, 4, 2, 1, 8]], ramps: [R.camisa, R.piel] },
];
```

- Las cajas de las piernas acaban en y 0: el mango del pico (y 2, rampa `pantalon`) no se mueve con ellas.
- Las rampas van por índice. Por eso la rampa nueva de una variante va al final de la paleta.

## 3. Los clips

```js
vp.renameClip(vp.clips()[0].name, 'quieto');
vp.loop(true);
vp.rig({ frameMs: 400, parts: arms, frames: [{ moves: { brazoL: { dz: -1 }, brazoR: { dz: -1 } } }] });
vp.generateFromRig();
vp.frame(0); vp.frameMs(100);
```

- `generateFromRig()` sustituye los cuadros 1..n por los del rig. El cuadro 0, la pose de reposo, se queda. Los cuadros
  generados toman `frameMs` del rig; el 0 se vuelve a fijar con `vp.frameMs(100)`.
- Para cada clip nuevo, el script vuelve antes al primero (`vp.clip(vp.clips()[0].name)`): `newClip` copia la pose
  del cuadro 0 del clip abierto.
- `andar` usa `stride` en las piernas y `dy` en los brazos; los cuadros de paso suben un pie con `dz: 1`. No sube el
  cuerpo: la caja no pasa de 14.
- `atacar` mueve `brazoR` con `dz` y `dy`, y `body: { dy: -1 }` en los dos últimos cuadros.
- Al final, `vp.clip('quieto')` y `return vp.save()`.

## 4. Variantes A y B

`window.__enanoVariante = 'B'` antes del script; sin ella, A.
- A: casco dorado de dos capas (ala z 12, cúpula z 13). Caja 6 x 6 x 14.
- B: casco de hierro de una capa (z 12) con una banda dorada estrecha delante y el faro en el ala. Caja 6 x 6 x 13.
- B añade la rampa `hierro` al final de la paleta: las 8 de antes conservan su índice, y el mismo rig sirve.

## Lo que se lee en un cuerpo bajo

El enano mide 14 vóxeles (13 en B). No hay en el código una regla para otros altos; esto es lo que hace el enano:
- Una zona por franja de z y una rampa por zona. Las partes del rig se eligen luego por caja y rampa.
- Lo que tiene que verse de frente sale del plano: la nariz y la barba en y -2, el faro en la fila de delante.
- Un punto de luz: el faro es la única rampa emisiva.
- De frente, un tono más claro (túnica `camisa:2` contra `camisa:1`, puntera `botas:2`).
- Ojos de 1 vóxel bajo el ala, con su propia rampa oscura (`ojos`).
- La caja manda: todos los cuadros de todos los clips caben en 6 x 6 x 14. Con bloques de 8, un cuerpo de radio 3
  baja por un pozo de 1 x 1 bloques. Por eso `andar` no sube el cuerpo.

MAIA es el otro ejemplo, de 19 x 17 x 32: hecha por capas en `models/maia/maia_capas.px.js` y con su walk en código
(`walkFrames` en `src/anim/walk.ts`, 8 cuadros de `WALK_FRAME_MS` = 100 ms). Es un ciclo aprobado a mano con la
cascada del pelo; para un cuerpo nuevo se usa el rig.

## La prueba

`test/enano.test.ts` carga los dos archivos como un juego (`clipsFromFile`) y comprueba, por variante:
- los clips: `[['quieto', true, 2], ['andar', true, 5], ['atacar', false, 4]]`;
- ningún cuadro con 100 vóxeles o menos;
- la caja de todos los cuadros de todos los clips: `[6, 6, 14]` en A y `[6, 6, 13]` en B;
- los pies en z = 0.

    bunx vitest run test/enano.test.ts

El motor del rig y de los clips tiene sus propias pruebas: `test/rig.test.ts` (el pivote se queda en los pies),
`test/clips.test.ts` (versión 3, leer las 1 y 2, `clipFrameAt`, `clipDone`) y `test/walk.test.ts` (el walk de MAIA).

    bunx vitest run test/rig.test.ts test/clips.test.ts test/walk.test.ts

## Regenerarlo byte a byte

Como en `models/README.md`:
1. `bun run dev` y abrir el editor (http://localhost:5190). Recargar la página antes de cada corrida: el script declara
   constantes.
2. Para B, `window.__enanoVariante = 'B'` antes. Para A, sin definir.
3. Correr `scripts/enano.js` en la página (consola, o CDP con `awaitPromise: true` y `returnByValue: true`).
4. El archivo es `JSON.stringify(resultado)`, sin salto de línea al final. En la consola,
   `copy(JSON.stringify($_))`.
5. Escribirlo sobre `models/enano/enano.voxpix.json` (A) o `models/enano/enano-b.voxpix.json` (B) y
   `git diff --exit-code models/enano/`. No debe salir nada.

## Paso a paso

1. Escribir el modelo como script del editor (`scripts/<personaje>.js`), una rampa por zona.
2. Definir las partes por caja y rampa, con `pivotZ` y `footZ` en las piernas.
3. Un clip por animación: `newClip(name, { loop })` desde el cuadro 0 del primero, `rig(spec)`, `generateFromRig()`.
4. Medir la caja de todos los cuadros: es lo que el juego va a necesitar de hueco.
5. Escribir la prueba con los clips, los cuadros, la caja y los pies, como `test/enano.test.ts`.
6. Guardar el archivo en `models/<personaje>/`, añadirlo a `models/README.md` y comprobar que se regenera byte a byte.
