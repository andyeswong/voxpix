# Abre app/seccion.html con ?medir= en Edge sin ventana (CPU frenada a -Rate), recoge window.__seccion y guarda una captura.
param([string]$Url, [string]$Out, [switch]$Gpu, [int]$Rate = 6, [string]$Extra = "")
$ErrorActionPreference = "Stop"
$port = 9461
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = Join-Path $env:TEMP "voxpix-seccion"   # un perfil de Edge aparte, en el temporal del usuario
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
function Eval($e) { (Send "Runtime.evaluate" @{ expression = $e; returnByValue = $true }).result.result.value }
[void](Send "Runtime.enable" @{})
if ($Rate -gt 1) { [void](Send "Emulation.setCPUThrottlingRate" @{ rate = $Rate }) }
[void](Send "Page.navigate" @{ url = $Url })
$t0 = Get-Date
$v = ""
while (((Get-Date) - $t0).TotalSeconds -lt 560) { Start-Sleep -Seconds 2; $v = Eval "window.__seccion ? JSON.stringify(window.__seccion) : ''"; if ($v) { break } }
Start-Sleep -Seconds 3
$hud = Eval "document.getElementById('hud').textContent"
"resultado: $v"
"hud: $hud"
$shot = Send "Page.captureScreenshot" @{ format = "png" }
[IO.File]::WriteAllBytes($Out, [Convert]::FromBase64String($shot.result.data))
$ws.Dispose()
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
