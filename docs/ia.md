# IA: hecho por agentes, para agentes

VoxPix es un proyecto AI-driven en los dos sentidos.

## Hecho por agentes de IA

El código, los modelos de ejemplo, las pruebas y esta documentación los escribieron agentes de IA: sesiones de
Claude Code que trabajan como un equipo, cada una con su papel, y que se coordinan en un tablero compartido. Una
persona, Andrés Wong, dirige el proyecto: decide qué se hace, prueba lo que sale y aprueba el arte.

- **NARUTO:** el editor, el render (CPU y GPU), la luz, el agua, el estado del mundo, el compositor y el arte en
  vóxeles.
- **FERN:** el runtime (el tick determinista, la colisión y el bucle de pasos fijos), el presupuesto por cuadro y un
  juego hecho con el motor que lo puso a prueba. El juego vive aparte, en
  [brotato-oficina](https://github.com/andyeswong/brotato-oficina).
- **MAIA:** líder y jueza: fija los criterios de aceptación (rendimiento, estilo) y da por bueno el trabajo.
- **EO:** la infraestructura y el hosting de las pruebas.

Cómo se trabaja para que el resultado sea fiable y no solo plausible:

- **Un oráculo para cada atajo.** El render de la CPU es la referencia. Todo lo que se acelera en la GPU se compara
  con él píxel a píxel (`app/oraculo.html`, `app/oraculo-render.html`), con tolerancias escritas y justificadas.
- **Determinismo.** El mismo modelo con las mismas opciones da los mismos bytes, y el mundo avanza en ticks fijos,
  sin reloj ni `Math.random`. Así se puede probar todo y comparar entre máquinas.
- **Medir antes de cambiar.** Primero se mide dónde se va el tiempo y luego se arregla; los números quedan en los
  commits y en `scripts/perf/README.md`.
- **Un humano ve el arte.** Un sprite se da por bueno cuando lo ve Andrés aplicado de verdad, no por una métrica.
- **Revisión cruzada.** Un agente revisa el estilo del trabajo de otro antes de que llegue a Andrés.

## Para que lo usen agentes

VoxPix está pensado para que un agente lo maneje tan bien como una persona:

- **Sin ratón.** [`window.voxpix`](api-agentes.md) hace todo lo que hacen las herramientas: pintar, cajas,
  rellenos, agua, luces, paleta, lienzo, vista y PNG. Con ella, un paisaje de 128 x 128 sale en 0,08 s de
  ediciones; con clics de ratón simulados costaba minutos.
- **Formatos de texto.** `.voxpix.json` (modelo, paleta y luces) y `.px.js` (arte de pxl como código) se leen,
  se escriben y se comparan como cualquier código.
- **Salidas comprobables.** El render es determinista y de paleta cerrada: un agente puede verificar lo que hizo
  midiendo los píxeles, sin depender de cómo se vea.
- **Errores que explican.** Cada fallo de la API dice qué esperaba y qué hay («no hay rampa "x"; las rampas son:
  ...»).
- **Línea de comandos** para trabajar sin navegador: [render, pxl y GIFs](linea-de-comandos.md).

### Consejos para un agente

1. Empieza con `voxpix.info()`: el lienzo, las rampas y las luces.
2. Si el modelo es grande, escríbelo como código: genera las celdas y pásalas en un solo `voxels([...])`, o usa
   `box` y `fill`. Pintar celda a celda con clics es lento y frágil.
3. Junta los pasos con `batch` para que un deshacer los quite enteros.
4. Pon el agua con `water` cuando el terreno ya esté hecho, porque llena lo que encuentra vacío.
5. Comprueba lo que hiciste con `png()`. Míralo o mide sus píxeles antes de dar el trabajo por terminado.
6. Si trabajas a la vista de una persona, usa `tool(nombre)` para que vea qué estás haciendo.
