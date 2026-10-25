# Medida en navegador con la CPU frenada

Lo que se mide: el intervalo entre cuadros (`requestAnimationFrame`) de la escena en un navegador real, con la CPU
frenada por CDP (`Emulation.setCPUThrottlingRate`). Criterio de MAIA:
p95 ≤ 16,8 ms a 6x. Un cuadro "perdido" es el que pasa de 18 ms (a 60 Hz el intervalo nunca baja de 16,7).

En Windows (Edge), desde WSL:

    PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\perf.ps1' -Url 'http://<host>:5190/escena.html?tema=medieval&seed=7' \
        -Throttle 6 -WarmMs 22000 -SampleMs 8000 -Out 'C:\...\perf.json' < /dev/null
    python3 scripts/perf/perf-stats.py /mnt/c/.../perf.json

`< /dev/null` hace falta: si no, PowerShell se come la entrada de un bucle de shell. Con la CPU a 6x el horneado tarda
~6 s: espera al menos 20 s antes de medir.

Primera medida (NARUTO, 2026-10-24, commit c96186a, Edge sin ventana en la Alienware): a 1x p95 16,8 y 0 % perdidos;
a 6x, cuadro de 43-77 ms y p95 de 67-133 ms en los tres temas (100 % perdidos). No cumple el criterio.

Validación del arnés (condición de MAIA, 2026-10-24): un juego 2D de referencia que sí cumplía, medido igual, da a 6x
p95 16,7-16,8 ms y 0-0,2 % perdidos en los tres temas. El arnés distingue: lo que no cumple es la escena.

Opciones: `-Shot C:\...\x.png` guarda una captura al final de la muestra (para comprobar qué se midió); `-Gpu` arranca
Edge con la GPU en vez de `--disable-gpu` (para la ruta WebGL2). Ojo: el freno de CDP frena la CPU, no la GPU, así
que con `-Gpu` la medida sale optimista; la aceptación final es en el Flip.

## Ruta GPU (WebGL2), 2026-10-24

Con `-Gpu`, la escena compone el cuadro en la GPU (src/view/gpu). El HUD dice `(gpu)` o `(cpu)`.

**Ojo:** con la GPU real, Edge sin ventana no se ata a 60 Hz. A 1x da intervalos de 4,2 ms (~240 Hz). Por eso el p95
es una cota, no la cifra de aceptación, y el freno de CDP no frena la GPU. La aceptación es en el Flip.

| Escenario, 6x | p95 | Perdidos (>18 ms) | CPU por cuadro (HUD) |
|---|---|---|---|
| medieval, salida | 12,6 ms | 0,3 % | 5,4 ms |
| oficina, salida | 12,7 ms | 0,5 % | 5,4 ms |
| cyberpunk, salida | 12,6 ms | 0,1 % | 5,3 ms |
| medieval, columna rota | 12,6 ms | 0,2 % | 4,6 ms |
| medieval, lago con pisotones | 16,7 ms | 0,9 % | 3,7 ms |

Antes, con el cuadro en CPU: 43-77 ms por cuadro y p95 de 67-133 ms.

## Multitud (app/multitud.html), 2026-10-24

N MAIAs andando en círculo con su walk, pintadas por el compositor (`?n=200`, `?ruta=cpu`, `?tema=`, `?sombras=0`).
Las entidades son quads instanciados con un atlas de sprites; la luz de cada una va en el shader. Sombra de verdad
solo para las 8 más cercanas al centro; de contacto, todas. Edge con GPU (`-Gpu`).

| Caso | p95 | Perdidos | CPU del compositor | Mover N + step del mundo |
|---|---|---|---|---|
| 200, 1x | 4,3 ms | 0 % | 0,3 ms | 0,3 ms |
| 200, 6x | 12,6 ms | 0,2 % | 3,8 ms | 2,4 ms |
| 100, 6x | 12,5 ms | 0,1 % | 2,8 ms | 2,2 ms |
| 200 por CPU, 1x (fallback) | 92 ms | 100 % | 78 ms | — |

Sigue valiendo el aviso de arriba: el freno no frena la GPU, la aceptación es en el Flip. Por CPU no caben 200.
