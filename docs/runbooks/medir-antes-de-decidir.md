# Medir antes de decidir

Cómo mide este equipo un cambio de rendimiento antes de quedárselo: primero un banco en Bun, después el navegador con
la CPU frenada, y el oráculo para saber que la GPU sigue dando lo mismo que la CPU. Al final, el caso de hoy: el corte
de frente.

## 1. El banco en Bun

Sin navegador ni freno. Es una señal de desarrollo: rápida, repetible, para comparar dos versiones del mismo código.

    export PATH=$HOME/.bun/bin:$PATH
    bun scripts/bench-<nombre>.ts

| Banco | Qué mide (de su cabecera) |
|---|---|
| `bench-caida.ts` | rehornear un piso que se monta desde el cielo (`VoxelFall.rebuild`), por tick, con commit `landing` o `end` |
| `bench-caminos.ts` | `LevelPathField` en 384 x 384 x 96: construir, buscar al cambiar la meta, `dir` y buscar tras picar |
| `bench-corte.ts` | el corte de vista (`WorldView.cutJob`) con la cola: poner, mover a saltos de 16 y quitar una caja |
| `bench-cuerpos.ts` | mover N cuerpos (`moveBody`) como una oleada, con huella de dónde acaban; se corre con `npx tsx` (V8, como el navegador: con bun la huella sale otra) |
| `bench-giro.ts` | preparar un giro de la cámara (`prepareViewJob`): copia girada y horneado, con llamadas de 2 ms, y el ruido de la máquina |
| `bench-mapa.ts` | un mapa por semilla de 384 x 384 x 96: `generateMap` y `applyMap` por separado |
| `bench-niveles.ts` | `moveBodyLevels`: 20 cuerpos persiguiendo un punto 1800 ticks; µs por llamada y huella |
| `bench-objetos.ts` | un objeto que se mueve: despertarlo y dormirlo (con su rehorneado), empujarlo, y su coste en `groundAt` |
| `bench-picar.ts` | picar bloques de 8 en un terreno con antorchas: memoria, horneado entero y rehorneado de cada golpe |
| `bench-rebake.ts` | la parte síncrona de `rebakeChangedJobs` con cambios repartidos en muchos trozos |
| `bench-seccion.ts` | el corte al componer (`sectionLayer`); con `ANDAR=1`, `SectionPainter` andando por el túnel |

Cada cabecera dice sus variables (`DOS=`, `MUNDO=`, `CONTORNO=`, `ANT=`, `NEAR=`, `VER=1`...). Leerla antes de correrlo.

### Cómo se emula 6x en Bun

La CPU frenada a 6x en el navegador sube todo unas 6,7 veces. `bench-corte.ts` lo emula así:

```ts
const K = 6.7;
const q = new FrameBudget(3 / K, undefined, { ms: Number(process.env.NEAR ?? 8) / K, below: 64 });
```

- Los presupuestos se dividen por 6,7: la cola reparte el trabajo como lo haría a 6x.
- Lo que se informa se multiplica por 6,7: los ms salen "como a 6x".
- `bench-seccion.ts` hace lo mismo (`K = 6.7`). Con `ESCALA=1`, todo a 1x.

No sustituye al navegador: no hay GPU, ni recolector del navegador, ni reloj redondeado.

## 2. El navegador con la CPU frenada

`scripts/perf/perf.ps1` abre Edge sin ventana, frena la CPU por CDP (`Emulation.setCPUThrottlingRate`) y guarda los
intervalos entre cuadros. `perf-stats.py` los resume. Copiado de `scripts/perf/README.md`:

    PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\perf.ps1' -Url 'http://<host>:5190/escena.html?tema=medieval&seed=7' \
        -Throttle 6 -WarmMs 22000 -SampleMs 8000 -Out 'C:\...\perf.json' < /dev/null
    python3 scripts/perf/perf-stats.py /mnt/c/.../perf.json

- Criterio: p95 ≤ 16,8 ms a 6x. Perdido: un cuadro de más de 18 ms.
- `-Gpu`: Edge con la GPU de la máquina. Sin él, `--disable-gpu` (ruta CPU). El freno de CDP no frena la GPU, así que
  con `-Gpu` la medida es optimista, y Edge sin ventana no se ata a 60 Hz: el p95 es una cota. La aceptación es en el Flip.
- `-Shot C:\...\x.png` guarda una captura para saber qué se midió (no abrirla aquí: que la mire MAIA o Andrés).
- Antes de medir, reiniciar vite en una llamada aparte: `pkill -f "[v]ite app"`. Con 6x, esperar al menos 20 s.

`app/seccion.html?medir=4,16,24,48&n=360` mide sin esperar al reloj: andar sin corte y con cada ancho. Deja en
`window.__seccion`, por ancho, `appear`, `holes`, `over25`, y `p50`, `p95`, `max` y `mean` del cuadro, la cola, la
capa, la subida y el cuadro de la GPU; `walking` es lo mismo solo con todo pintado, y `walking.rest` el cuadro sin la
cola. `perf.ps1` solo recoge `window.__frames` y el HUD; `window.__seccion` lo recoge `scripts/perf/seccion.ps1`:

    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\seccion.ps1' -Gpu -Rate 6 \
        -Url 'http://<host>:5197/seccion.html?medir=4,16,24&n=360' -Out 'C:\...\seccion.png' < /dev/null
    # primera línea: "resultado: {json}"; con ?mundo=768, el mundo el doble de ancho (para 48 bloques)

### Reglas de los bancos del navegador (lo que costó una noche de medidas, 2026-11-16/17)

- **Edge arranca y espera 150 s antes de medir** (MAIA). Edge sin ventana deja de mandar un cuadro durante ~70 ms una
  vez, a los ~2 minutos de arrancar, haga lo que haga la página: en la traza de V8 el hilo principal del render está
  vacío en el hueco. Salía como "el cuadro de 345 / 68 / 72 ms" a los 113-116 s de cada tirada. No se descartan datos a
  posteriori: se espera antes. `viva.ps1 -Calentar 150` (por defecto).
- **Con `?hz=60`.** Edge sin ventana no tiene vsync y va a ~180 cuadros por segundo: la cola (~6 ms por cuadro)
  avanza tres veces más por segundo que en el juego. Así se escondió que la ventana viva se quedaba atrás en la página
  del juego.
- **Desde un worktree congelado, con vite reiniciado tras cada checkout** (`pkill -f "[v]ite app ..."` en una llamada
  aparte), y un banco corto de humo (15-20 s) antes del largo. Tres bancos seguidos midieron módulos viejos (huecos del
  65-74 % que desaparecieron al reiniciar vite) y otros se colgaron. `grep "page reload"` en el log de vite antes de
  dar un número por bueno.
- **Un Edge que se quede vivo tras un timeout ocupa el puerto**: matarlo (`Get-CimInstance Win32_Process` con su perfil)
  antes del siguiente.
- **Un error en un cuadro cierra el banco** con el error en `window.__viva` (si no, el que mide espera hasta su tope).
- **Lo que no es de nuestro JS se ve por fases**: `viva.html` deja los 8 peores intervalos con lo de cada fase del
  cuadro y lo que queda "fuera" (el navegador, el recolector, la GPU). Si "fuera" es casi todo, mirar la traza de V8
  (`gctrace-viva.ps1`) antes de culpar al código.

## 3. El oráculo: la GPU contra la CPU

`app/oraculo.html` (código: `app/src/oraculo/main.ts`) compone cada escena por la CPU (`frame2DParts` + `shadeLayers` +
`applyLayers`, la referencia) y por la GPU (`GpuCompositor.read`), y compara píxel a píxel.

- Escenas: 81 hasta el corte al componer, 97 hoy (las 16 nuevas: "corte al componer", en 4 giros).
- Tolerancia (`TOL_SHARE = 0.005`): como mucho el 0,5 % de píxeles distintos en el cuadro final, ninguno a más de ±2 en el
  color antes de la luz, ninguno a más de un nivel de luz, y el alfa igual. Un error de WebGL (`glErrors`) es fallo. El
  porqué, en `scripts/oracle/README.md`.
- `?solo=texto`: solo las escenas con ese texto en el nombre (`?solo=corte`).
- Resultado en `window.__oracle`: `pass`, `results` y `shots`, por escena las PNG `cpu`, `gpu`, `diff` y `colorDiff`.

    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\oracle.ps1' -Url 'http://<host>:5190/oraculo.html' -Out 'C:\...\oracle.json' [-Gpu] < /dev/null

**Siempre con `-Gpu`.** Es la referencia: las pasadas que valen y las imágenes que se comparan de una versión a otra.

**Byte a byte con la capa apagada.** Un cambio que añade una opción (una capa, un modo) no puede mover nada cuando está
apagada. Se guarda `oracle.json` antes y después del cambio y se comparan las `shots` de las escenas comunes, sin abrir
ninguna imagen:

```sh
python3 - antes.json despues.json <<'EOF'
import json, sys
a, b = (json.load(open(p, encoding="utf-8"))["shots"] for p in sys.argv[1:3])
comunes = [n for n in a if n in b]
distintas = [n for n in comunes if (a[n]["cpu"], a[n]["gpu"]) != (b[n]["cpu"], b[n]["gpu"])]
print(f"{len(comunes) - len(distintas)} de {len(comunes)} escenas iguales byte a byte")
for n in distintas: print("distinta:", n)
EOF
```

Así se escribe en el commit: "Without a layer, the 81 earlier scenes are byte-identical" (b8e499d).

### SwiftShader

Sin `-Gpu`, `oracle.ps1` arranca Edge con SwiftShader (WebGL2 por software). Según `scripts/oracle/README.md`:

- sirve para comprobar que el resultado es correcto, no para medir rendimiento;
- una escena falla de forma estable con SwiftShader ("medieval fuente resaltada, giro 1", 29 píxeles en `mulOff2`) y pasa
  con `-Gpu`. Si sale eso sin `-Gpu`, es el instrumento, no el motor.

`scripts/perf/README.md` no habla de SwiftShader: sin `-Gpu`, `perf.ps1` usa `--disable-gpu` y mide la ruta CPU.

## 4. Cómo dar un número

- **p50, p95 y máx.** La mediana sola esconde los tirones; el máximo solo, el ruido. Los tres.
- **Sin freno y a 6x, dicho.** "5,5 ms sin freno (~37 a 6x)". Si el 6x es emulado (×6,7 en Bun), decirlo.
- **Dos tiradas.** Dar el rango: "p95 5-6 ms", "3-6 cuadros". Una tirada sola no se compara.
- **Contra la referencia, medida igual.** Cuadros de más de 25 ms con el cambio contra la misma escena sin él (sin
  corte, o la rama main): "3-6 vs 5". El trabajo de la cola se juzga así; el resto del cuadro, por su mediana.
- **De dónde sale.** Máquina, navegador, GPU o no, commit, comando.
- **Si una puerta no se cumple, decirlo con esas palabras.** "the +1 ms gate is not met yet" (b8e499d). No se redondea
  ni se esconde en una tabla.
- **Lo descartado, también.** Con su número, en "Probado y descartado" de docs/motor.md: que nadie lo repita a ciegas.

## 5. Caso: el corte de frente

Un juego (2026-11-16) pidió ver al jugador en un túnel con la cámara oblicua: quitar lo que tapa por delante, una
caja de 32 x 224 desde los pies. En `bench-corte.ts` es `DOS=3`.

**Rehornear no cupo.** El corte de vista (`WorldView.setCut` / `cutJob`, a5ad5e6, 209ea66, db2f9a6) quita vóxeles de
la copia de la vista y `rebakeChangedJobs` rehornea lo destapado.

- 3286396 bajó lo que recorre cada evento de 560k a 256k vóxeles, y "aparece" a 6x de p50 72 a 67 cuadros, máx 144 a 121.
- 67 cuadros son más de un segundo a 60 Hz para ver por dónde se anda.
- No baja más con la cola: la unidad que no se parte es una franja de recuadro, ~4,5-5 ms a 6x, y en el cercano de 8 ms
  cabe una por cuadro (docs/motor.md, "Cortar la vista"). Estrechar la franja ya se probó y no ayuda ("Probado y
  descartado").

Repetido hoy en la Alienware (dos veces, 2 tiradas y 16 eventos cada una):

    DOS=3 MUNDO=bloques CONTORNO=both bun scripts/bench-corte.ts 2
    # aparece p50 79, máx 133 cuadros; budget.run máx p95 20.0 ms (a 6x)
    # aparece p50 76, máx 133 cuadros; budget.run máx p95 19.7 ms (a 6x)

**La capa al componer, sí.** Lo de detrás nunca se horneó; se pinta aparte y se compone encima (docs/motor.md, "Corte al
componer"):

1. 4625cf7, `sectionLayer` en CPU: rehacerla cada cuadro cuesta 5,5 ms sin freno (32 vóxeles) y 58 ms (todo el ancho).
   Igual, byte a byte, que hornear el mundo cortado (`test/corte-componer.test.ts`). Aún no sirve: cada cuadro.
2. 0a4f9b0, `SectionPainter` por franjas: aparece en 9/33/47/77 cuadros a 6x para 4/16/24/48 bloques, sin huecos; pero
   un paso p95 ~9,5 ms y componer p95 ~9 ms al saltar de franja.
3. 01e0061, componer incremental: p95 0,5-0,9 ms a 1x, 5-6 ms a 6x, casi igual en todos los anchos.
4. b8e499d, en la GPU: sin huecos, cuadros de más de 25 ms 3-6 vs 5, pero la media del cuadro +4-5 ms. **La puerta de
   +1 ms no se cumplía**, y así se dijo.
5. 71a5a65, anillo y luz al pintar: mediana del cuadro sin la cola 3,2-3,7 ms vs 3,2-3,3 sin corte (+0,4 como mucho);
   cuadros de más de 25 ms 3-6 vs 5; subir, media 0,4-0,5 ms (era 1). Oráculo 97/97, las 81 de antes byte a byte.

Resultado: con 4 bloques de ancho (los mismos 32 vóxeles), lo cortado aparece en 9 cuadros a 6x en vez de 67.

Repetirlo en Bun (hoy, Alienware):

    bun scripts/bench-seccion.ts 32                 # capa p50 5.84 ms (6x 39.1); cuadro CPU 10.8 con capa, 6.4 sin
    ANDAR=1 bun scripts/bench-seccion.ts 32         # aparece en el cuadro 9, huecos 0; componer p95 8.4-9.1 (a 6x)
    ANDAR=1 ESCALA=1 bun scripts/bench-seccion.ts 32   # aparece en 4, huecos 0; componer p95 0.79 ms

Hoy, componer a 6x emulado da p95 8,4-9,1 ms en tres tiradas, por encima de los 5-6 ms de 01e0061 en docs/motor.md; a
1x (0,79) sí cuadra con 0,5-0,9. Antes de usar esa cifra, medirla en el navegador.

Y la prueba que lo fija:

    bunx vitest run test/corte-componer.test.ts test/corte.test.ts
