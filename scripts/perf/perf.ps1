param([string]$Url, [int]$Throttle = 6, [int]$WarmMs = 9000, [int]$SampleMs = 8000, [string]$Out, [string]$Shot = "", [switch]$Gpu, [string]$Extra = "", [string]$Size = "1152,648")
$ErrorActionPreference = "Stop"
$port = 9444
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$prof = Join-Path $env:TEMP "voxpix-perf"   # un perfil de Edge aparte, en el temporal del usuario
$gpuArgs = if ($Gpu) { @("--enable-gpu","--ignore-gpu-blocklist") } else { @("--disable-gpu") }
$extraArgs = if ($Extra) { $Extra -split " " } else { @() }
$p = Start-Process -FilePath $edge -ArgumentList (@("--headless=new") + $gpuArgs + $extraArgs + @("--remote-debugging-port=$port","--user-data-dir=$prof","--window-size=$Size","about:blank")) -PassThru
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
[void](Send "Emulation.setCPUThrottlingRate" @{ rate = $Throttle })
[void](Send "Page.navigate" @{ url = $Url })
Start-Sleep -Milliseconds $WarmMs
$collector = "window.__frames=[];(function(){let last=performance.now();const f=t=>{window.__frames.push(t-last);last=t;requestAnimationFrame(f)};requestAnimationFrame(f)})();1"
[void](Send "Runtime.evaluate" @{ expression = $collector })
Start-Sleep -Milliseconds $SampleMs
$res = Send "Runtime.evaluate" @{ expression = "JSON.stringify({frames: window.__frames.slice(1), hud: document.getElementById('hud')?.textContent || ''})"; returnByValue = $true }
[IO.File]::WriteAllText($Out, $res.result.result.value)
if ($Shot) { $img = Send "Page.captureScreenshot" @{ format = "png" }; [IO.File]::WriteAllBytes($Shot, [Convert]::FromBase64String($img.result.data)) }
try { $ws.Abort() } catch {}
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*ss-naruto-perf*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
"ok"
