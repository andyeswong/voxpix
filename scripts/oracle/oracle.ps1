# Abre la página del oráculo en Edge sin ventana, espera a window.__oracle y lo guarda en JSON.
# -Gpu: con la GPU de la máquina (si no, Edge usa SwiftShader, la GPU por software, que también da WebGL2).
param([string]$Url, [string]$Out, [int]$TimeoutS = 300, [switch]$Gpu)
$ErrorActionPreference = "Stop"
$port = 9445
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = Join-Path $env:TEMP "voxpix-oracle"   # un perfil de Edge aparte, en el temporal del usuario
$gpuArgs = if ($Gpu) { @("--enable-gpu","--ignore-gpu-blocklist") } else { @("--use-angle=swiftshader","--enable-unsafe-swiftshader") }
$p = Start-Process -FilePath $edge -ArgumentList (@("--headless=new") + $gpuArgs + @("--remote-debugging-port=$port","--user-data-dir=$prof","--window-size=800,600","about:blank")) -PassThru
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
[void](Send "Page.navigate" @{ url = $Url })
$deadline = (Get-Date).AddSeconds($TimeoutS)
$val = $null
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  $res = Send "Runtime.evaluate" @{ expression = "window.__oracle ? JSON.stringify(window.__oracle) : ''"; returnByValue = $true }
  $val = $res.result.result.value
  if ($val) { break }
}
if (-not $val) {
  $txt = Send "Runtime.evaluate" @{ expression = "document.getElementById('out')?.textContent || ''"; returnByValue = $true }
  $val = (@{ error = "timeout"; text = $txt.result.result.value } | ConvertTo-Json -Compress)
}
[IO.File]::WriteAllText($Out, $val)
try { $ws.Abort() } catch {}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*ss-naruto-oracle*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"ok"
