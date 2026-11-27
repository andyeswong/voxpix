# Documentación de VoxPix

| Documento | Para qué |
|---|---|
| [El editor](editor.md) | Usar la app: capas y 3D, herramientas y atajos, paleta, luces, agua, animación con clips, sets de bloques con su hoja de iconos, vista previa y exportar. |
| [API para agentes](api-agentes.md) | `window.voxpix`: hacer modelos sin ratón desde la consola, Playwright o CDP. |
| [API de mundos](api-mundos.md) | Un mundo entero de vóxeles desde una receta en JSON, sin escribir código. |
| [IA: hecho por agentes, para agentes](ia.md) | Cómo se hizo VoxPix con agentes de IA y cómo debe trabajar un agente con él. |
| [El render](render.md) | Cámara, paleta por rampas, sombreado, contorno, luz por cara y el formato `.voxpix.json`. |
| [El motor del mundo](motor.md) | Usar VoxPix como motor de un juego: mundo, entidades, luces, agua, horneado, compositor y runtime; mundos de bloques que se pican en partida, terreno por semilla, caminos (también por niveles), cielo, corte de vista, ciclo del día y guardar en bytes; la ventana viva (un mundo que se genera al andar), la capa de sección, el clima y la interfaz para agentes. |
| [El horno en un worker](horno-worker.md) | `BakeWorker`: pintar el rehorneado de la ventana viva (recuadros y cielo) en un worker, qué se queda en el hilo principal y cómo migrar un worker propio. |
| [Línea de comandos](linea-de-comandos.md) | Renderizar, exportar e importar pxl y sacar GIFs desde la terminal. |
| [Pruebas](pruebas.md) | Las pruebas, los oráculos de CPU contra GPU y las medidas de rendimiento. |
| [Cambios](cambios.md) | Lo que ha entrado, por bloques: lo último, el oleaje de las plantas de agua y la vista del agente en color; antes, la ventana viva, el horno en un worker, la capa de sección, la interfaz para agentes y el clima; antes, mundos de bloques, picar en partida, caminos por niveles, cielo, corte de vista. Con costes y tolerancias. |
