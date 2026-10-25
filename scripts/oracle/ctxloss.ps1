# Pierde y recupera el contexto WebGL de la escena (WEBGL_lose_context) y guarda una captura antes, durante y después.
# Durante debe pintar la CPU (HUD "(cpu)"), sin pantalla negra; después, otra vez la GPU.
param([string]$Url, [string]$Dir, [switch]$Gpu, [string]$Extra = "")
$ErrorActionPreference = "Stop"
$port = 9444
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = Join-Path $env:TEMP "voxpix-perf"   # un perfil de Edge aparte, en el temporal del usuario
$gpuArgs = if ($Gpu) { @("--enable-gpu","--ignore-gpu-blocklist") } else { @("--disable-gpu") }
$extraArgs = if ($Extra) { $Extra -split " " } else { @() }
$p = Start-Process -FilePath $edge -ArgumentList (@("--headless=new") + $gpuArgs + $extraArgs + @("--remote-debugging-port=$port","--user-data-dir=$prof","--window-size=1152,648","about:blank")) -PassThru
Start-Sleep -Seconds 3
$t = ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/json").Content | ConvertFrom-Json) | Where-Object { $_.type -eq "page" } | Select-Object -First 1
$ws = New-Object System.Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$t.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$script:id = 0
function Send($method, $params) {
  $script:id++
  $msg = @{ id = $script:id; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $b = [Text.Encoding]::UTF8.GetBytes($msg)
  $ws.SendAsync([ArraySegment[byte]]$b, "Text", $true, [Threading.CancellationToken]::None).Wait()
  $buf = New-Object byte[] 4194304
  while ($true) {
    $sb = New-Object Text.StringBuilder
    do { $r = $ws.ReceiveAsync([ArraySegment[byte]]$buf, [Threading.CancellationToken]::None).Result; [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count)) } until ($r.EndOfMessage)
    $j = $sb.ToString() | ConvertFrom-Json
    if ($j.id -eq $script:id) { return $j }
  }
}

function Eval($e) { (Send "Runtime.evaluate" @{ expression = $e; returnByValue = $true }).result.result.value }
function Shot($f) { $img = Send "Page.captureScreenshot" @{ format = "png" }; [IO.File]::WriteAllBytes("$Dir\$f", [Convert]::FromBase64String($img.result.data)) }
[void](Send "Runtime.enable" @{})
[void](Send "Page.navigate" @{ url = $Url })
Start-Sleep -Seconds 6
Shot "ctx0.png"
"antes: " + (Eval "document.getElementById('hud').textContent.split('\n')[1]")
[void](Eval "window.__lc = document.getElementById('view').getContext('webgl2').getExtension('WEBGL_lose_context'); window.__lc.loseContext(); 1")
Start-Sleep -Seconds 2
Shot "ctx1.png"
"perdido: " + (Eval "document.getElementById('hud').textContent.split('\n')[1] + ' canvases=' + document.querySelectorAll('canvas').length")
[void](Eval "window.__lc.restoreContext(); 1")
Start-Sleep -Seconds 2
Shot "ctx2.png"
"vuelto: " + (Eval "document.getElementById('hud').textContent.split('\n')[1] + ' canvases=' + document.querySelectorAll('canvas').length")
try { $ws.Abort() } catch {}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*ss-naruto-perf*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
