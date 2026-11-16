# Crear objetos de mano y su icono

Un objeto de mano (un pico, una espada, un lingote) se ve en dos sitios: en la mano del personaje y en la barra. Se
guarda como bloque de un set: así el modelo de la mano y el icono de la barra salen del mismo archivo. Ejemplo:
`scripts/objetos.js`, que escribe `models/objetos/objetos.voxset.json` (9 objetos).

## 1. Un cubo de 8 x 8 x 8 por objeto

- Cada objeto es un bloque de un set de lado 8: en el lienzo, x e y de -4 a 3 y z de 0 a 7.
- **De pie**, con el mango hacia abajo (z bajo) y lo que pesa arriba. El pico lleva la cabeza en z 5-7; la espada, la
  hoja de z 3 a 7.
- Plano en y = 0: los picos y las espadas tienen un solo vóxel de fondo.
- Lo que no se lleva en la mano va tumbado: los lingotes (se llevan en la mochila).
- Sus rampas son `atravesable`: el objeto no es sólido (`solid: false`), por si cae al mundo.

```js
const OBJETOS_RAMPS = [
  { name: 'palo', colors: ['#3a2614', '#5a3c20', '#7a5430'], material: 'atravesable' },
  // tabla, piedra, hierro, oro: los mismos colores que las rampas del set medieval
];
```

Se pinta y se añade como cualquier bloque ([crear-un-set-de-bloques.md](crear-un-set-de-bloques.md)):

```js
vp.newModel('objetos', 8, 8, 8);
vp.palette(OBJETOS_RAMPS);
vp.newSet('objetos', 8);
objetosBlocks(vp, (id, props) => { const n = vp.addBlock(id, props); vp.block(null); return n; });
return vp.saveSet();
```

Las variantes de material (madera, piedra, hierro) son la misma función con otra rampa: `pick(ramp, hi)`,
`sword(ramp, hi)`, `ingot(ramp)`. `hi` es el tono más claro: el filo, la punta.

## 2. El agarre: `OBJETOS_GRIP`

`OBJETOS_GRIP[id]` es el vóxel por el que la mano coge el objeto, en coordenadas **del lienzo**:

```js
const OBJETOS_GRIP = {
  palo: [0, 0, 1],
  pico_madera: [0, 0, 1], pico_piedra: [0, 0, 1], pico_hierro: [0, 0, 1],
  espada_madera: [0, 0, 0], espada_piedra: [0, 0, 0], espada_hierro: [0, 0, 0],
  lingote_hierro: [0, 0, 0], lingote_oro: [0, 0, 0],
};
```

- El agarre es un vóxel del mango: el pico se coge por z 1, la espada por el pomo (z 0).
- En el `.voxset.json` los vóxeles van de 0 a 7: x e y llevan **+4**. El agarre del pico, `[0, 0, 1]` en el lienzo,
  es `[4, 4, 1]` en el archivo.
- Un objeto nuevo necesita su entrada en `OBJETOS_GRIP` y en el `GRIP` de la prueba.

## 3. Llevarlo en la mano

El motor no tiene una función para esto: lo hace el juego. En cada cuadro, cada vóxel del objeto va a la posición
de la mano más (vóxel - agarre):

```ts
const set = BlockSet.fromJSON(file as unknown as VoxsetFile);
const item = set.get(set.index('pico_hierro')).model;
const [gx, gy, gz] = OBJETOS_GRIP.pico_hierro;           // del lienzo
const grip = [gx + 4, gy + 4, gz];                        // del archivo
// hand: la posición de la mano en este cuadro
for (const [x, y, z, v] of item.entries()) put(hand.x + x - grip[0], hand.y + y - grip[1], hand.z + z - grip[2], v);
```

- `put` es del juego (dibujar o estampar el vóxel). `v` es un material de la paleta del set: si el mundo tiene otra
  paleta, sus rampas tienen que estar en ella, y `rampMap(paletaDelSet, paletaDelMundo)` (`src/world/edit.ts`) da la
  rampa del mundo de cada rampa del set.
- Así el mango queda siempre en la mano, aunque la mano se mueva de un cuadro a otro del clip.

## 4. El icono de la barra

El icono es el de un bloque. La barra usa estas opciones de `iconSheet` (`src/core/icons.ts`):

- `cell: 16`;
- `outline: 'both'`;
- un `outlineColor` fijo: el color más oscuro del set de la barra (`#07070a`, `carbon:0` del set medieval), el mismo
  para todos los iconos, para que casen;
- la vista por defecto: giro -30°, elevación 35°.

En el editor, con el set abierto:

```js
const sheet = await vp.iconSheet({ cell: 16, outline: 'both', outlineColor: '#07070a' });
// sheet.base64: la PNG; sheet.index.icons[id]: { x, y, w, h, hash }; sheet.hash: la huella de la hoja
```

En una prueba o en el juego, sin navegador:

```ts
const sheet = iconSheet(set.ids().map((id) => ({ id, model: set.get(set.index(id)).model })), { cell: 16, outline: 'both', outlineColor: '#07070a' });
const one = modelIcon(set.get(set.index('pico_hierro')).model, { cell: 16, outline: 'both', outlineColor: '#07070a' });
```

- Si un icono no cabe en la celda, `iconSheet` da un error con el tamaño que hace falta.
- Con estas opciones, los 9 objetos caben en celdas de 16 (hoja de 48 x 48, huella `818ef9e7`, medido el
  2026-11-16). Ninguna prueba fija todavía esa huella.

Para que se lea a 16 px (todo el ancho, losas, contraste de luminancia, tonos para lo que se ve) y para medirlo sin
ver la imagen: [diseno-para-16-px.md](diseno-para-16-px.md). Su ejemplo de prueba de icono es
`test/mochila-icono.test.ts`.

## 5. La prueba

`test/objetos-mano.test.ts` carga `models/objetos/objetos.voxset.json` y comprueba:

- los ids, en el orden de `GRIP`;
- que ningún objeto es sólido;
- que todo cabe en el cubo (de 0 a 7);
- que el agarre (+4 en x e y) es uno de los vóxeles del objeto.

```
bunx vitest run test/objetos-mano.test.ts
```

Con la prueba del icono de la mochila, para comprobar la parte del icono:

```
bunx vitest run test/objetos-mano.test.ts test/mochila-icono.test.ts
```

## 6. Paso a paso

1. Pintar el objeto de pie en su cubo, en `objetosBlocks` (o en un script nuevo como `scripts/objetos.js`), con
   rampas `atravesable` al final de la paleta.
2. Poner su agarre en `OBJETOS_GRIP` y en el `GRIP` de `test/objetos-mano.test.ts`.
3. Sacar el icono con las opciones de la barra y medirlo ([diseno-para-16-px.md](diseno-para-16-px.md)).
4. Regenerar el `.voxset.json` byte a byte (`models/README.md`) y correr la prueba.
5. En el juego, sumar los vóxeles menos el agarre a la mano en cada cuadro.
