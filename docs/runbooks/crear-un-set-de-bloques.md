# Crear un set de bloques

Un set de bloques es un `.voxset.json`: varios modelos de N x N x N con id que comparten una paleta. El motor lo lee
con `BlockSet` y lo pone en el mundo con `BlockGrid`. Se hace con un script del editor (`window.voxpix`), así se
puede regenerar byte a byte. Ejemplos: `scripts/bloques-medievales.js` (12 bloques) y `scripts/flores.js` (3 flores).

## 1. Las rampas

Cada rampa es `{ name, colors, emissive?, material? }`, con los colores de oscuro a claro (hasta 16 tonos, hasta 64
rampas). Lo que hace el bloque sale de los materiales de sus rampas (`MATERIALS`, `src/core/materials.ts`):

| `material` | Bloquea el paso | Luz | Para |
|---|---|---|---|
| sin nada (`solido`) | sí | la tapa | piedra, tablas |
| `atravesable` | no | la tapa | escalera, hueso, objetos sueltos |
| `follaje` | no | pasa | hierba, flores, hojas |
| `arbusto` | sí | pasa | hojas que no se cruzan |
| `vidrio` | sí | pasa | ventanas |
| `escala` | no | pasa | se trepa (`moveBodyLevels`) |

`metal`, `madera`, `tela` y `tierra` solo cambian la densidad (y `metal`, `reflect`). `emissive: true` hace que la
rampa brille sola. `vp.materials()` da la lista completa con sus propiedades.

```js
const FLORES_RAMPS = [
  { name: 'petalo_rojo', colors: ['#5a1018', '#9a1c24', '#d02c30', '#f05a50'], material: 'follaje' },
  // ...
  { name: 'tallo', colors: ['#1e3a14', '#2e5a1e', '#46802c', '#62a03c'], material: 'follaje' },
];
// Emisiva y que se cruza (la brasa del horno encendido)
{ name: 'llama', colors: ['#7a2a08', '#c85010', '#f08a20', '#ffc850', '#fff0b0'], emissive: true, material: 'atravesable' }
```

## 2. Pintar y añadir los bloques

El orden de llamadas de los dos scripts:

```js
vp.newModel('flores', 8, 8, 8);     // modelo vacío: palette() no deja quitar rampas que el modelo abierto usa
vp.palette(FLORES_RAMPS);
vp.newSet('flores', 8);             // el lienzo pasa a ser de 8 x 8 x 8
const add = (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; };
vp.voxels([[0, 0, 0, 'tallo:1'], /* ... */]);
add('flor_roja');
// ... un bloque detrás de otro
return vp.saveSet();                // el .voxset.json, comprobado por BlockSet.fromJSON
```

- El lienzo del bloque va de -N/2 a N/2-1 en x e y, y de 0 a N-1 en z. En el archivo se guarda de 0 a N-1 (x e y,
  +4 con N = 8). Un vóxel fuera es un error que dice cuál.
- El material de un vóxel es `"rampa:tono"`.
- `addBlock(id, props?)` guarda el lienzo como bloque nuevo **y se queda en él**. Por eso `add` llama a
  `vp.block(null)`: deja el lienzo vacío para el siguiente. Sin eso, el bloque siguiente se pinta encima del anterior.
- `block(id | número)` vuelve a abrir uno; `saveBlock(props?)` lo guarda; `removeBlock(id)` lo quita; `blocks()`
  los lista con sus propiedades.

## 3. Las propiedades (`BlockProps`)

- `solid`, `light` (`'blocks'` o `'passes'`) y `emissive` salen de las rampas:
  - `solid`: alguna rampa bloquea;
  - `light: 'passes'`: todas dejan pasar algo de luz;
  - `emissive`: alguna rampa es emisiva.

  Si se escriben en `props` y no coinciden, `BlockSet.add` da un error. Se cambian con el material, no con `props`.
- Lo que no sale de las rampas va en `props`:
  - `emits`: la luz fija que pone al colocarse, `{ kind, radius?, intensity?, color?, at? }` (`at` en vóxeles del
    bloque sin girar; por defecto, el centro de arriba);
  - `covered`: el id del bloque en que se convierte con uno sólido encima (hierba -> tierra). Se comprueba al
    exportar: tiene que existir en el set;
  - `density`: si no, la media de sus vóxeles.

```js
vp.addBlock('antorcha', { emits: { kind: 'torch' } });     // el ejemplo de docs/api-agentes.md
```

Los dos ejemplos no ponen `props`: todo sale de sus rampas. La luz del horno encendido la decide el juego.

## 4. Variantes

Una variante es otro bloque con otro id, pintado con la misma función:

- `horno` / `horno_encendido` y `cofre` / `cofre_abierto` en `bloques-medievales.js` (`furnace(lit)`, `chest(open)`);
  el juego cambia uno por otro con `BlockGrid.set`.
- La variante tapada va en `covered`: `BlockGrid.set` la pone sola si hay un sólido encima.
- El giro no es una variante: la escalera va pegada a la cara +y y el juego la pone girada (`set(..., yaw)`).

## 5. Añadir los bloques a otro set

Cada script exporta sus rampas (`FLORES_RAMPS`, `MEDIEVAL_RAMPS`) y una función `floresBlocks(vp, add)` /
`medievalBlocks(vp, add)` que pinta y añade sus bloques en el set abierto. Las rampas nuevas van **al final** de la
paleta: así ningún índice existente se mueve.

1. Antes de pegar el script, `window.__floresSolo = false` (o `__medievalSolo`): solo define, no crea su set.
2. Abrir el set de destino y añadir las rampas detrás de las suyas:

```js
vp.loadSet(f);                                   // f: el .voxset.json de destino
vp.block(null);
vp.palette([...f.palette.ramps, ...FLORES_RAMPS], f.palette.outline);
floresBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
const merged = vp.saveSet();
```

`medievalBlocks` usa además `piedra`, `carbon`, `palo` y `llama`: tienen que estar ya en el set de destino (corrido
solo, las pone `MEDIEVAL_BASE`).

## 6. La hoja de iconos

`vp.iconSheet({ yaw?, elevation?, outline?, outlineColor?, cell?, scale?, columns? })` da una promesa de
`{ name, base64, index, width, height, hash }`: un icono por bloque, mismo ángulo y escala. Por dentro es `setIcons`
(`app/src/blockSet.ts`), que llama a `iconSheet` de `src/core/icons.ts`.

- `index.icons[id]` es `{ x, y, w, h, hash }`; `hash` es la huella FNV-1a de su celda y la de la hoja, la de todos los
  píxeles. Mismo set y mismas opciones, misma huella.
- Un icono suelto: `vp.icon(...)` en el editor, o `modelIcon(modelo, opciones)` en el núcleo.
- En una prueba, sin navegador:

```ts
const set = BlockSet.fromJSON(file as unknown as VoxsetFile);
const sheet = iconSheet(set.ids().map((id) => ({ id, model: set.get(set.index(id)).model })), { cell: 16, outline: 'both', outlineColor: '#07070a' });
```

Para que un bloque se lea a 16 px: [diseno-para-16-px.md](diseno-para-16-px.md).

## 7. La prueba

La prueba carga el `.voxset.json` y comprueba lo que promete el set: ids en orden, qué es sólido, qué brilla, y
que todo cabe en el cubo. Ejemplos: `test/flores.test.ts` (sin sólidos, `light: 'passes'`, de pie en z = 0) y
`test/bloques-medievales.test.ts` (sólidos, el horno encendido emisivo, la escalera en la fila y = 7).

    bunx vitest run test/bloques-medievales.test.ts test/flores.test.ts

## 8. Regenerar el `.voxset.json`

Como dice `models/README.md`:

1. `bun run dev` y abrir http://localhost:5190. Recargar la página antes de cada script (declaran constantes).
2. Pegar el script en la consola, o evaluarlo por CDP con `awaitPromise: true` y `returnByValue: true`.
3. `copy(JSON.stringify($_))`: sin salto de línea al final.
4. Escribirlo encima de `models/<set>/<set>.voxset.json` y `git diff --exit-code models/<set>/`: sin cambios.

Si cambia a propósito, se vuelve a correr la prueba. Un set nuevo se añade a las tablas de `models/README.md`.

## 9. En el motor

```ts
const set = BlockSet.fromJSON(file);           // comprueba el archivo (propiedades, covered)
const grid = new BlockGrid(state, set);        // las rampas del set, en la paleta del mundo (en cualquier orden)
grid.set(bx, by, bz, set.index('flor_roja'));  // 0 lo quita; aplica covered y emits
```

`set.index(id)` da el tipo (desde 1; 0 es aire) y `set.get(tipo)` su `{ id, model, props }`. Lo demás
(`fill`, `topAt`, `pickBlock`): `docs/motor.md`, Bloques.
