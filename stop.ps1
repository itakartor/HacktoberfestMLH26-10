# Ferma tutto: server Node (porta 3000) + Ollama.  Uso:  .\stop.ps1   oppure  .\stop.ps1 -KeepOllama
param([switch]$KeepOllama, [int]$Port = 3000)

$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  foreach ($procId in ($conns.OwningProcess | Sort-Object -Unique)) {
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    Write-Host "Fermo server ($($p.ProcessName), PID $procId) sulla porta $Port"
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "Nessun server in ascolto sulla porta $Port"
}

if (-not $KeepOllama) {
  $ollama = Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue
  if ($ollama) {
    Write-Host 'Fermo Ollama (libera la memoria della GPU)'
    $ollama | Stop-Process -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host 'Ollama non in esecuzione'
  }
}
Write-Host 'Fatto.'
