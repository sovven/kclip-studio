$root = Split-Path -Parent $PSScriptRoot
$port = 5291
$url = "http://localhost:$port"

function Test-Up {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Close() }
}

if (-not (Test-Up)) {
  $log = Join-Path $root 'jobs\server.log'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "node server.mjs > `"$log`" 2>&1" -WorkingDirectory $root -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Up) { $ok = $true; break }
  }
  if (-not $ok) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("KCLIP Studio did not start. See:`n$log", 'KCLIP Studio') | Out-Null
    exit 1
  }
}

Start-Process $url
