# El horno en un worker

Estado: escrito (`src/world/horno.ts`, `src/world/horno-worker.ts`; pruebas en `test/horno.test.ts`). Los recuadros del
rehorneado y su cielo van al worker; las luces, todavía no (abajo).

## Por qué

Pintar los recuadros es ~95 % de la cola del hilo principal andando. En viva, a 1x durante 5 min, con worker la cola baja
de ~266 a ~42 ms/s; lo que queda en el principal por recuadro es ~0,1 ms (recibir y publicar). Antes de `BakeWorker` el
motor no traía worker: viva tenía el suyo (`app/src/viva/hornero.ts`), y quien usaba el motor tenía que escribir el
propio.

Un worker escrito fuera del motor solo se entera de los cambios sustituyendo en la instancia métodos del source (`touch`,
`shift`, `shiftJob`). Eso tiene dos problemas: cualquier cambio del motor en esos métodos lo rompe sin aviso, y tapa las
sondas que miden esos métodos. Además, si al girar vuelve a empezar, el espejo se rehace entero.

## API (src/world/horno.ts)

```ts
// Hilo principal
const horno = new BakeWorker(new Worker(new URL('voxpix/src/world/horno-worker.ts', import.meta.url), { type: 'module' }),
  { near?: (rect, baked) => boolean, perFrame?: number, brake?: number, keep?: number });
horno.attach(win);   // una vez: se engancha a la LiveWindow, no al horneado
horno.frame();       // cada cuadro, solo con perFrame: entrega hasta perFrame recuadros llegados
horno.detach();      // quita el remote de la ventana y deja de oír sus corrimientos
horno.stats;         // pedidos, recibidos, saltados, trozos mandados, ms de mandar, ms del worker, espejos
```

- La ventana pone el `remote` en el horneado del giro que se ve y lo mueve al girar (`LiveWindow.setRemote`, también en
  el cambio de `turnTo`). Quien la usa no engancha cada horneado.
- Los corrimientos llegan por `LiveWindow.attach` (`shiftSources`): cada fuente viva con lo que se corrió en trozos de
  vóxeles, en sus ejes.
- Nada se envuelve. Al pedir un recuadro se mandan antes los trozos que lee (`readChunks`) cuya versión
  (`StaticVoxels.versions`) el espejo no tiene: los trozos que entran y las ediciones llegan solos. Mandar un trozo
  (`exportChunkPrepared`) cuesta ~0,015 ms; un trozo que no cabe en esa forma hace que ese recuadro se pinte aquí.
- `near(rect, baked)`: lo que se pinta aquí y no fuera (lo cercano). Se pregunta en cada pedido, así que puede cambiar
  en cada cuadro.

## Un espejo por fuente: girar no rehace nada

El worker guarda un espejo por cada fuente que pinta: la copia de vóxeles de cada giro (`WorldView.static`) y un horneado
sin pintar con las mismas opciones. No gira él los vóxeles del giro 0: con corte, la vista esconde vóxeles en su copia, y
el mundo girado no es lo que se ve.

Girar no rehace nada. Los espejos de los giros que siguen vivos se quedan; el de un giro soltado se tira en el corrimiento
siguiente, o al pasar de `keep`. Lo pedido antes de un corrimiento de su espejo se salta (el principal ya lo descartó).

## Qué se queda en el hilo principal

- **Lo cercano** (`near`): lo de prioridad 0. Llega antes pintado aquí que ida y vuelta.

El núcleo del giro con fundido (`turnTo`) sí va fuera, y con prioridad (`urgent`: en el worker pasa delante de lo que ya
esperaba). Pintado aquí iba repartido en el presupuesto cercano (8 ms por cuadro): ~650 ms de CPU tardaban ~1,8 s de
reloj hasta el cambio, y el primer recuadro del worker llegaba después de eso y de copiar lo demás (2-3 s de la tecla).
Sus trabajos piden a la vez (el que espera al worker no para a los de detrás), y si el giro se deja antes del cambio, lo
pedido se cancela.
- **La sección (el corte)**: depende de la caja de corte y del objetivo, que cambian cada cuadro; se queda aquí como hoy.
- **Publicar** lo que llega (`publishRect` con su máscara): ~0,1 ms por recuadro.
- **El corrimiento** de la imagen (`shiftBakedJob`): ~20 ms por corrimiento, troceado en pasos. Sigue aquí.
- **Las luces**, de momento: el trabajo `light` sigue aquí. El cielo (`sky`) ya va fuera (`46a37b9`): `BakeWorker`
  manda antes los trozos que leen sus rayos (`skyReadChunks`) y el worker lo calcula en su espejo con `skyFromPick`, el
  mismo cálculo que aquí. Antes de eso, con worker, el cielo era ~2/3 de lo que quedaba en el principal.

Un recuadro que llega se comprueba con la misma regla que uno pintado aquí (núcleo cambiado, o un trozo que lee cambiado
con algo publicado encima). Si no vale, se vuelve a pedir fuera con lo de ahora, hasta `REMOTE_RETRIES` (2) veces, y
después se pinta aquí. Andando, el trozo de al lado se escribe mientras el recuadro está fuera: pintarlo aquí devolvía al
principal ~23 % de los recuadros.

## Límites conocidos

- **Escribir los trozos que entran** sigue en el hilo principal: generarlos y estamparlos (`fill`, o la generación de la
  ventana). El worker de viva (`?worker=1`) además los genera fuera (`prepareTrozo`); el del motor no. En viva, a 1x
  durante 5 min, eso son ~7 s de 300 en el principal con `?worker=2` contra ~0,1 con `?worker=1`. A un juego que escribe
  sus trozos con `fill` (con sus diferencias guardadas) no le cambia nada.
- **Las luces**: el paso siguiente (el cielo ya va fuera).

## Migración de un juego que ya tiene su propio worker

Unas líneas de la página, sin reescribirla:

1. Su clase del lado principal pasa a ser `new BakeWorker(worker, { brake, perFrame, near })`, con su criterio de lo que
   se pinta aquí como `near`; su worker, `src/world/horno-worker.ts`.
2. `horno.attach(win)`, una vez tras crear la ventana. Desaparece el enganche al horneado nuevo en cada cuadro.
3. `horno.frame()` se queda donde está (con `perFrame`).
4. Los avisos de edición que mandaba a mano dejan de hacer falta: salen de las versiones de los trozos. Todo lo que
   pasa por `set`, `BlockGrid.set` o el estampado por losas sube la versión.
5. Su worker se borra cuando el del motor pase la medida. Hasta entonces, un parámetro de la página elige uno u otro,
   para medir los dos intercalados.

Viva lo usa con `?worker=2`; `?worker=1` es el suyo de antes, que además genera los trozos fuera.

## Pruebas que lo dan por bueno

En el motor (`test/horno.test.ts`), con un worker en el mismo hilo que clona los mensajes y se queda atrás; y el de verdad
en el navegador de viva:

1. **Igual que local.** La imagen, byte a byte igual a hornear todo aquí, tras:
   - andar con corrimientos;
   - giros (`turn` y `turnTo`), con el espejo sin reiniciar;
   - picar y poner mientras hay recuadros en el worker;
   - el vecino que cambia mientras su recuadro está fuera (lo de f9341d4).
2. **Sin envolver.** La ventana, sus fuentes y sus horneados no ganan propiedades propias (salvo `remote` y
   `remoteStats`), y `shift`, `shiftJob`, `touch` y `set` siguen en el prototipo.
3. **Girar no rehace el espejo.** Girar 0 → 1 → 0: un espejo por fuente y ninguno tirado. Con `turnTo`, el espejo del
   giro nuevo se crea antes del cambio: su núcleo se pide fuera, todo a la vez y urgente (también sus cielos), lo urgente
   pasa delante en el worker, y un núcleo dejado a medias cancela lo pedido y suelta su remote.
4. **Lo saltado se cuenta, y nada se manda dos veces.** Pedidos = recibidos + saltados, y ningún trozo se manda dos veces
   con la misma versión.
5. **Mutaciones**: sin corrimiento en el espejo, versiones mandadas sin correr, sin mandar ediciones, sin saltar, el
   espejo rehecho al girar, el remote sin pasar al girar, y (en `test/remoto.test.ts`) la llegada sin comprobar los
   trozos que lee y sin volver a pedir. Cada una hace fallar alguna prueba.
6. **Viva y el juego** intercalados, su worker contra el del motor: la cola en el principal, los huecos y los cuadros de
   más de 25 ms.
