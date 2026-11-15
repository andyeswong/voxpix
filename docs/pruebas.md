# Pruebas

    bun run test           # Vitest: todas (no `bun test`, que es otro programa)
    bun run typecheck      # tsc sin emitir (vue-tsc --noEmit -p . para incluir los .vue)

Las pruebas cubren:
- el render: determinismo, pivote fijo, paleta cerrada y contorno;
- el deshacer por diferencias;
- el ida y vuelta con pxl;
- el modelo y el mundo: entidades, luces, sombras, tinte y topes de caché;
- el agua, el generador de escenarios, el runtime y la colisión;
- el determinismo del mundo tick a tick.

Una prueba con arte real se salta salvo que `VOXPIX_REAL_PXL` apunte a un `.px.js`.

## Oráculos: la GPU contra la CPU

La GPU tiene que dar lo mismo que la CPU, que es la referencia. Dos páginas lo comprueban en un navegador de verdad:

- **`app/oraculo-render.html`:** el render y la luz del editor. Compara 6 modelos con 10 juegos de opciones (giros,
  elevaciones, contorno interior, oblicua plana, zoom del editor) y la luz por píxel. Devuelve el resultado en
  `window.__oracle`.
- **`app/oraculo.html`:** el cuadro del mundo. Compara 79 escenarios, entre ellos:
  - la salida en los tres temas;
  - el lago con pisotones, también con niebla por altura;
  - agua en un mundo de bloques alto, en los 4 giros, con corte y picando la orilla;
  - una columna rota rehorneada, y un picado junto a cada luz después de un cuadro (los pesos se suben por recuadro);
  - una entidad con un modelo sin vóxeles;
  - multitudes de 60 y 200;
  - antorchas con y sin tope de luces, y una linterna;
  - destellos de golpe;
  - giros libres por encima del tope del atlas.

  También compara el alfa del cuadro final (cuatro escenarios con fondo transparente). Con `?solo=texto`, solo los
  escenarios con ese texto en el nombre. Un error de WebGL que deje un escenario
  (`getError`: una subida inválida no sube nada y no salta por sí sola) lo da por fallado (`glErrors`). Las tolerancias, y por qué, están en
  `scripts/oracle/README.md`.

`scripts/oracle/oracle.ps1` las abre en Edge sin ventana (con la GPU de la máquina o con SwiftShader) y guarda el
resultado. `scripts/oracle/ctxloss.ps1` prueba qué pasa cuando la GPU pierde el contexto. En `app/multitud.html?precalentar=1`, `window.__compositor.atlasStats()` dice cuántos sprites hay en el atlas: tras recuperar el contexto, los mismos que antes de perderlo (64: 8 cuadros de andar x 8 rumbos), no solo los que se van viendo.

## Rendimiento

`scripts/perf/perf.ps1` mide el intervalo entre cuadros con la CPU frenada por CDP, y `perf-stats.py` lo resume. El
criterio es un p95 de 16,8 ms o menos a 6x. Las medidas y su historia están en `scripts/perf/README.md`.

`app/multitud.html` es la prueba de carga del compositor:
- `?n=200` pone 200 entidades;
- `?antorchas=10` y `?linterna=1` añaden luces que se mueven con ellas;
- `?luces=N` pone un tope de luces por entidad;
- `?precalentar=2` sube los sprites y pinta un primer cuadro tapado antes de empezar;
- `?ruta=cpu` fuerza la CPU.
