# El horno en un worker (diseño, sin código aún)

Estado: propuesta (2026-11-19). Nada de esto está escrito todavía. Antes, una medida en un juego que ya pinta en un
worker: si la cola sigue creciendo andando con su worker, el techo está en otro sitio y esto tiene que resolverlo también.

## Por qué

Pintar los recuadros es ~95 % de la cola del hilo principal andando. En viva, a 1x durante 5 min, con worker la cola baja
de ~266 a ~42 ms/s; lo que queda en el principal por recuadro es ~0,1 ms (recibir y publicar). Hoy el motor no trae
worker: viva tiene el suyo (`app/src/viva/hornero.ts`), y quien usa el motor tiene que escribir el propio.

Un worker escrito fuera del motor solo se entera de los cambios sustituyendo en la instancia métodos del source (`touch`,
`shift`, `shiftJob`). Eso tiene dos problemas: cualquier cambio del motor en esos métodos lo rompe sin aviso, y tapa las
sondas que miden esos métodos. Además, si al girar vuelve a empezar, el espejo se rehace entero.

## API (src/world/horno.ts, más un worker de entrada en el motor)

```ts
// Hilo principal
const horno = new BakeWorker(() => new Worker(new URL('@voxpix/world/horno-worker', import.meta.url), { type: 'module' }),
  { brake?: number, perFrame?: number, near?: (rect) => boolean });
horno.attach(win);   // una vez: se engancha a la LiveWindow, no al horneado
horno.frame();       // cada cuadro: entrega hasta perFrame resultados y manda los cambios pendientes
horno.detach();      // suelta todo: el remote de las vistas y el worker
horno.stats;         // pedidos, recibidos, saltados, caducados, ms del worker
```

- `attach(win)` usa solo eventos públicos de la ventana. Ninguno envuelve métodos:
  - `win.events.on('load', (t, chunks))`: un trozo escrito. Lleva los trozos de vóxeles ya preparados
    (`exportChunkPrepared`), o `prepareTrozo` si lo genera el worker.
  - `win.events.on('shift', { cells, voxels })`: lo mismo que `onShift`, emitido por la ventana en el commit.
  - `win.events.on('epoch', n)`: la tanda de rehorneado nueva (`rebakeEpoch`).
  - `win.events.on('view', q)`: cambió el giro que se ve (`turn` / `turnTo`).
  - Las ediciones (picar, poner) no necesitan evento. En cada `frame`, el principal pregunta
    `store.changedSince(enviado)` y manda esos trozos. Es la misma fuente de verdad que el rehorneado, y no hay nada
    que envolver.
- `remote` lo pone la ventana en el horneado del giro que se ve, y lo quita al soltarlo. Es una opción de la ventana,
  `remote: horno.remote`; quien la usa ya no engancha cada horneado.
- `near(rect)`: lo que se pinta aquí y no fuera (lo cercano). Por defecto, lo de prioridad 0 (el núcleo del giro y lo
  que toca la sección).

## El espejo sobrevive al giro

El worker guarda los vóxeles de la ventana sin girar (el `store` del giro 0): trozos, corrimiento y ediciones. Eso no
depende del giro. Por cada giro guarda aparte su copia girada (`copyRotatedChunk`, por trozos y a demanda, solo de lo
que piden sus recuadros) y su horneado vacío (`bakeWorldJob` sin pintar).

Al girar, el principal manda `view q`. El worker crea la copia girada de ese giro si no la tiene, y no rehace el espejo.
Los pedidos del giro anterior se saltan, por tanda.

## Qué se queda en el hilo principal

- **Lo cercano** (`near`): el núcleo del giro con fundido y lo de prioridad 0. Llega antes pintado aquí que ida y vuelta.
- **La sección (el corte)**: depende de la caja de corte y del objetivo, que cambian cada cuadro; se queda aquí como hoy.
- **Publicar** lo que llega (`publishRect` con su máscara): ~0,1 ms por recuadro.
- **El corrimiento** de la imagen (`shiftBakedJob`): ~20 ms por corrimiento, troceado en pasos. Sigue aquí.
- **El cielo y las luces**, de momento. Son el siguiente paso: el trabajo `sky` y el `light` pedidos fuera como el
  `rect`. Con worker, el cielo es ~2/3 de lo que queda en el principal.

Un recuadro que llega se comprueba con la misma regla que uno pintado aquí (f9341d4: núcleo, o trozos que lee con algo
publicado encima). Si no vale, se pinta aquí.

## Migración de un juego que ya tiene su propio worker

Unas líneas de la página, sin reescribirla:

1. Su clase del lado principal pasa a ser `new BakeWorker(factory, { brake, perFrame, near })`, con su criterio de lo que
   se pinta aquí como `near`.
2. `horno.attach(win)`, una vez tras crear la ventana. Desaparece el enganche al horneado nuevo en cada cuadro.
3. `horno.frame()` se queda donde está.
4. Los avisos de edición que mandaba a mano dejan de hacer falta: salen de `changedSince`. Si escribe fuera del store
   algo que se hornea (agua, entidades), se añade como evento.
5. Su worker se borra cuando el del motor pase la medida. Hasta entonces, un parámetro de la página elige uno u otro,
   para medir los dos intercalados.

El de viva (`app/src/viva/hornero.ts`) pasa a usar lo mismo.

## Pruebas que lo dan por bueno

En el motor, con un worker de mentira en el mismo hilo (`MessageChannel` o una cola síncrona) y otro real en el
navegador de viva:

1. **Igual que local.** La imagen, byte a byte igual a hornear todo aquí, tras:
   - andar con corrimientos;
   - giros (`turn` y `turnTo`), con el espejo sin reiniciar;
   - picar y poner mientras hay recuadros en el worker;
   - el vecino que cambia mientras su recuadro está fuera (lo de f9341d4).
2. **Sin envolver.** Contar las propiedades propias de `win.store`, `win.baked` y de cada vista antes y después de
   `attach`: tienen que salir iguales. Y 0 llamadas a métodos sustituidos: se comprueba que
   `Object.getOwnPropertyDescriptor(store, 'shift'|'shiftJob'|'touch')` sigue sin existir.
3. **El espejo sobrevive al giro.** Girar 0 → 1 → 0 manda 0 `init` (cuenta de mensajes), y lo pintado tras volver es igual.
4. **Lo saltado se cuenta.** Lo pedido en una tanda vieja se salta en el worker, y el principal no lo publica.
5. **Mutaciones**: sin el evento de corrimiento, sin las ediciones por `changedSince`, el espejo reiniciado en el giro, y
   la llegada sin comprobar los trozos que lee. Cada una tiene que hacer fallar alguna prueba.
6. **Viva y el juego** intercalados, su worker contra el del motor: la cola en el principal, los huecos y los cuadros de
   más de 25 ms.
