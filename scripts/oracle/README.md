# Oráculo: el cuadro de la GPU contra el de la CPU

`app/oraculo.html` construye siete estados del mundo, cada uno con su semilla, sus ticks y sus pisotones fijos:
- salida en medieval, oficina y cyberpunk;
- el lago con pisotones, con y sin luces;
- una columna rota, rehorneada DESPUÉS de un primer cuadro de la GPU (prueba lo que se sube al rehornear);
- cuatro entidades con sombra, giradas, y una luz dinámica.

Cada estado se compone dos veces: por la CPU (`frame2DParts` + `shadeLayers` + `applyLayers`, la referencia) y por
la GPU (`GpuCompositor.read`). La comparación se hace píxel a píxel en cuatro salidas:
- el color antes de la luz;
- la capa multiply;
- la capa add;
- el cuadro final.

El resultado queda en `window.__oracle` (`pass`, una fila por escenario y las imágenes CPU, GPU y diferencias en PNG).

    PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\oracle.ps1' -Url 'http://<host>:5190/oraculo.html' -Out 'C:\...\oracle.json' [-Gpu] < /dev/null

Sin `-Gpu`, Edge usa SwiftShader (WebGL2 por software). Sirve para comprobar que el resultado es correcto, no para medir rendimiento.

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

## Resultado (NARUTO, 2026-10-24)

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
