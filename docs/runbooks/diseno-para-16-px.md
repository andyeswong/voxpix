# Diseñar un modelo para un icono de 16 px

Lo aprendido con la mochila (`scripts/mochila.js`, `models/mochila/`). Hicieron falta tres versiones: cba1d2b, 31fa8c0
y 8097fc1. Vale para cualquier objeto que se vea sobre todo como icono: barra, mochila o tienda.

## Lo que hace el icono con el modelo

El icono de la barra es `iconSheet` (o `modelIcon` para uno suelto) con estas opciones:
- `cell: 16`;
- `outline: 'both'`;
- un `outlineColor` fijo (en la barra, el color más oscuro del set);
- la vista por defecto: giro -30°, elevación 35°.

Un bloque de 8 vóxeles queda a unos 1-1,5 px por vóxel. A ese tamaño:

- **La cara de arriba se come la forma.** En un cubo, la tapa clara y las diagonales de los lados hacen un bulto. La
  mochila v2 (4 de fondo) aún se leía como un saco. La v3 es una **losa de 2 de fondo**: la tapa casi no sale y manda
  el frente, que es lo que se dibuja.
- **Los salientes oscurecen lo de debajo.** La solapa de la v1 sobresalía: la oclusión (AO) bajó un tono todo lo de
  debajo y la mochila se volvió un marrón uniforme. Todo va en el plano del frente, enrasado.
- **El render no pinta el tono que pones.** `toneFor` (`src/core/render.ts`) da:
  - tono = asignado + nivel de luz (-1, 0 o +1, con la normal suavizada) - 1 si hay oclusión;
  - en este ángulo, el frente baja 1 tono y la tapa sube 1;
  - un vóxel de arista enseña dos caras con el mismo tono asignado y dos tonos en pantalla.

  Se pinta para lo que se ve. La mochila pinta su cuerpo en el tono 5 para que se vea en el 4, y la tapa de la solapa
  en el 0 para que se vea como el frente de la solapa en el 1. Si a la rampa le faltan tonos, se añaden al final:
  ningún índice se mueve.
- **2 x 2 vóxeles no son 2 x 2 píxeles.** En la vista inclinada un detalle de 2 vóxeles cae entre píxeles y se
  emborrona. La hebilla tiene 4 vóxeles de ancho para dejar un 2 x 2 de píxeles enteros.
- **El contorno interior solo sale con un salto de profundidad.** Dos zonas del frente en el mismo plano no se
  separan con una raya: se separan por **contraste de luminancia**.
- **Todo el ancho del cubo.** Una silueta de 9 x 11 px en una celda de 16 se ve chica al lado de los bloques llenos.

## Reglas

1. Usar todo el ancho del cubo (8 vóxeles) y casi todo el alto.
2. Losa de 2 de fondo para algo plano (mochila, cartel, libro), y nada que sobresalga del frente.
3. Pocas zonas de color, grandes, en el plano del frente:
   - entre una zona y la de al lado, una **diferencia de luminancia del 40 % o más** (la solapa, a 55, contra un
     cuerpo a 120 o más);
   - dos marrones a menos del 15 % se funden.
4. Los detalles de 4 vóxeles o más, para que dejen un 2 x 2 de píxeles.
5. Elegir los tonos para lo que se ve en cada cara, no para lo que se asigna.
6. La media RGB del icono, lejos de las de los iconos que se parecen en la misma barra. La mochila (142, 86, 50) se
   comparó con la mesa y el cofre.

## Medirlo sin verlo

Los agentes de la Alienware no pueden abrir imágenes, así que el icono se mide sobre sus píxeles. Antes de entregar:

- **Silueta:** el recuadro de los píxeles opacos.
- **Interior:** lo opaco que no es contorno. Qué fracción es de cada zona, por umbrales de luminancia
  (0,299 R + 0,587 G + 0,114 B).
- **Filas de banda:** por cada fila, si la mayoría de su interior es oscura. Una banda, como la solapa, son filas
  seguidas.
- **El detalle:** buscar un 2 x 2 de píxeles por encima de un umbral (la hebilla, a 190 o más).
- **Medias RGB** del icono y de sus vecinos de barra.
- **La rejilla de letras:** cada color distinto, una letra; la fila de 16 letras se lee como un dibujo. Sirve para
  describirlo y para que el juez pida cambios por filas.

La mochila v3, medida así:
- silueta 10 x 12;
- el 80 % del interior es cuero claro (luminancia 120 o más) o solapa (45 a 56);
- la banda oscura son las filas 3-6;
- un 2 x 2 de hebilla de luminancia 190 o más;
- huella a65fb30c, la misma en la barra del set entero (se comprobó).

La comprobación visual la hacen MAIA o Andrés, sobre la PNG a x4 y sobre fondo claro y oscuro.

## Dejar los criterios en una prueba

Los criterios que se acuerden con el juez se escriben como prueba sobre el icono, no sobre los vóxeles. Así, si
alguien toca el modelo o el render, la prueba dice si el icono se sigue leyendo. Ejemplo: `test/mochila-icono.test.ts`.

```ts
const icon = modelIcon(set.get(set.index('mochila')).model, { cell: 16, outline: 'both', outlineColor: '#07070a' });
// silueta, fracción de zonas, filas de banda seguidas arriba, un 2 x 2 de hebilla, y la huella
expect(icon.hash).toBe('a65fb30c');
```

La huella va al final. Si cambia, no se actualiza sin más: se vuelven a medir los criterios y se cambia a mano.
`test/mochila.test.ts` comprueba la otra mitad, lo que promete el modelo: la losa, la solapa, la hebilla y el asa.

    bunx vitest run test/mochila-icono.test.ts test/mochila.test.ts

## Paso a paso

1. Escribir el modelo como script del editor (`scripts/<objeto>.js`, como `scripts/mochila.js`). Las rampas van al
   final de la paleta del set.
2. Sacar el icono con las opciones de la barra: `modelIcon` en una prueba, o la hoja del editor.
3. Medirlo con lo de arriba, ajustar los tonos para lo que se ve y repetir.
4. Pasar al juez las medidas, la rejilla de letras y la PNG a x4.
5. Escribir los criterios aceptados en una prueba, con la huella.
6. Regenerar el `.voxset.json` byte a byte (`models/README.md`).
