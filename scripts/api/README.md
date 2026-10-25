# Ejemplos de la API para agentes

La referencia de `window.voxpix` está en [docs/api-agentes.md](../../docs/api-agentes.md).

`paisaje-medieval.js` hace el paisaje medieval de 128 x 128 (terreno, río, lago, castillo, casas, puente, 40 árboles
y 11 luces) solo con la API, y devuelve un registro de cuánto tardó cada fase y el PNG iluminado en base64. Se pega
en la consola de la app o se evalúa por CDP o Playwright con `awaitPromise`.

Desde WSL, con el Edge de Windows sin ventana, con `browse.ps1`, un script de CDP que no está en el repo:

    PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
    $PS -NoProfile -ExecutionPolicy Bypass -File 'C:\...\browse.ps1' -Url 'http://<host>:5190/index.html' \
        -ExprFile 'C:\...\paisaje-medieval.js' -OutFile 'C:\...\salida.json' -Gpu < /dev/null
