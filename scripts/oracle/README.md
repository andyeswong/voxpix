# Oráculo: el cuadro de la GPU contra el de la CPU

`app/oraculo.html` (código: `app/src/oraculo/main.ts`, la lista `SCENARIOS`) construye 97 escenas del mundo, cada una
con su semilla, sus ticks y sus pisotones fijos. Entre otras:
- salida en medieval, oficina y cyberpunk; el lago con pisotones, con y sin luces; con niebla por altura;
- una columna rota, rehorneada DESPUÉS de un primer cuadro de la GPU (prueba lo que se sube al rehornear);
- entidades con sombra y una luz dinámica; multitudes de 60 y 200; efectos y destellos; vegetación; vidrio;
- bajo tejado (cielo y cueva); siluetas tapadas (xray); resalte; fondo transparente; un mundo alto con agua;
- el corte al componer (16 escenas, "corte al componer"): un anillo de paredes alrededor de MAIA y la caja moviéndose
  (la GPU dibuja antes con ella a un lado), bajo tejado, con antorcha fija, con entidades y luz dinámica, con
  `section` y con `SectionPainter`. Esas escenas dicen además cuántos píxeles de la capa hay en la vista (`secPx`,
  `secBorder`) y cuántos de los distintos caen dentro de ella (`secDiffer`).
- Muchas, en los 4 giros de la vista.

`?solo=texto` corre solo las escenas con ese texto en el nombre (`oraculo.html?solo=corte%20al%20componer`).

Cada estado se compone dos veces: por la CPU (`frame2DParts` + `shadeLayers` + `applyLayers`, la referencia) y por
la GPU (`GpuCompositor.read`). La comparación se hace píxel a píxel en cuatro salidas:
- el color antes de la luz;
- la capa multiply;
- la capa add;
- el cuadro final.

El resultado queda en `window.__oracle`: `pass`, `results` (una fila por escena) y `shots` (por escena, las PNG `cpu`,
`gpu`, `diff` y `colorDiff`, como data URL).

    PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\oracle.ps1' -Url 'http://<host>:5190/oraculo.html' -Out 'C:\...\oracle.json' [-Gpu] < /dev/null

Sin `-Gpu`, Edge usa SwiftShader (WebGL2 por software). Sirve para comprobar que el resultado es correcto, no para medir rendimiento.

**La referencia es con `-Gpu`.** Las pasadas que valen (97/97 el 2026-11-16) y las imágenes con las que se compara byte
a byte de una versión a otra son con la GPU de la máquina. Sin la bandera, con SwiftShader, una escena falla de forma estable:
"medieval fuente resaltada, giro 1", 29 píxeles en `mulOff2`, un grupo de ~25 (x 234-242, y 105-119) donde la GPU da
solo la luz ambiente y la CPU una luz. Con `-Gpu` esa escena pasa (13 píxeles a 1 nivel). No es un fallo nuevo del
motor: si sale eso sin `-Gpu`, es el instrumento. Comprobado el 2026-11-15: el mismo código da 79/79 con `-Gpu` y 78/79
sin ella, con perfil de Edge limpio y la misma versión de Edge.

## Byte a byte de una versión a otra

Un cambio que añade algo que se puede apagar (una capa, un modo) no puede mover nada apagado. Se corre el oráculo con
`-Gpu` antes y después y se comparan las `shots` de las escenas comunes, sin abrir imágenes (el fragmento de Python está
en `docs/runbooks/medir-antes-de-decidir.md`). Así se comprobó el corte al componer (b8e499d, 71a5a65): las 81 escenas
de antes, iguales byte a byte en CPU y GPU.

## Tolerancia, y por qué

Un escenario pasa si se cumplen las tres:
1. **Como mucho el 0,5 % de los píxeles** tiene el cuadro final distinto en algún canal.
2. **Ningún píxel difiere en más de ±2** en el color antes de la luz.
3. **Ningún píxel difiere en más de UN nivel de luz.** Son 8 niveles por canal en multiply y 16 en add.

Por qué no se pide igualdad exacta:
- La CPU calcula en doble precisión y la GPU en float32.
- Cuando un valor cae justo en el umbral de un nivel (la trama Bayer y los cortes de `quantize`), o en el redondeo
  de un byte (el agua mezcla colores con pesos), la GPU puede caer al otro lado.
- Eso da diferencias de 1 en un byte o de un nivel, sueltas. Pedir 0 haría el oráculo frágil sin ganar nada visible.

Por qué el 0,5 %: en una vista de 384x216 son ~400 píxeles sueltos. Un fallo de verdad en el compositor nunca cabe
ahí:
- un paso que no se hace (al principio, el agua no salía): ~26 %;
- una textura mal enlazada: ~18 %.

Por qué ningún píxel a más de un nivel: un error de lógica (una sombra que la GPU pone y la CPU no, una entidad tapada
de más) da saltos de 2 o más niveles, aunque sea en un solo píxel.

Dos casos que el oráculo encontró en un solo píxel y que se arreglaron en la raíz, no subiendo la tolerancia:
- La `y` del mundo de cada píxel, reconstruida en float32 desde la profundidad, se equivocaba en milésimas. En el
  borde de un vóxel, eso movía el rayo de sombra al vóxel de al lado. Ahora la calcula la CPU en doble precisión y se
  sube como textura.
- Un rayo de sombra que pasa justo por el borde de un vóxel (con entradas enteras es frecuente) caía en un lado en
  doble precisión y en el otro en float32. Ahora las dos rutas desempatan igual (`TIE` en `frame2d.ts`).

## Resultado (NARUTO, 2026-10-24, con 7 escenas; el de hoy, arriba)

| GPU | Escenarios que pasan | Píxeles que difieren | Diferencia máxima | Píxeles a más de un nivel |
|---|---|---|---|---|
| GPU de la Alienware | 7 de 7 | 0,04-0,16 % | 1 | 0 |
| SwiftShader | 7 de 7 | 0-0,04 % | 1 | 0 |

## Pérdida del contexto

`ctxloss.ps1 -Url 'http://<host>:5190/escena.html?tema=medieval&seed=7' -Dir 'C:\...' -Gpu` pierde el contexto a
los 6 s y lo recupera 2 s después. Guarda `ctx0/1/2.png`. Resultado: mientras no hay contexto pinta la CPU (la misma
imagen, HUD `(cpu)`); al volver, la GPU lo sube todo y el HUD dice `(gpu)`.

## Multitudes (2026-10-24)

Dos escenarios más: 60 y 200 MAIAs con cuadros del walk y giros distintos, solapadas, más de 8 con sombra y una luz
dinámica. Las dos rutas siguen las mismas reglas:
- primero todas las sombras de contacto;
- en cada píxel gana la entidad más cercana, comparada por la misma clave float32 que el z-buffer;
- sombra de verdad solo para las 8 más cercanas al centro;
- el rayo de la luz propia sale desplazado igual en las dos (`RAY_NUDGE`).

Resultado: pasan los 9 escenarios en la GPU de la Alienware (máx. 0,16 %, diferencia 1) y en SwiftShader (máx. 0,04 %).
