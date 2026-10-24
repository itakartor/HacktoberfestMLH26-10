# Avvia tutto: Ollama (Gemma) + server Node.  Uso:  .\start.ps1   (oppure doppio clic su start.cmd)
Set-Location $PSScriptRoot

# 1. Ollama: lo avvia solo se non sta gia' girando sulla porta 11434
$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
try {
  Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 2 | Out-Null
  Write-Host '[1/3] Ollama in esecuzione'
} catch {
  if (-not (Test-Path $ollama)) { Write-Host 'Ollama non installato: esegui prima .\setup.ps1'; exit 1 }
  Write-Host '[1/3] Avvio Ollama...'
  $env:OLLAMA_KEEP_ALIVE = '30m'
  Start-Process $ollama -ArgumentList 'serve' -WindowStyle Hidden
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep 1
    try { Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 2 | Out-Null; break } catch {}
  }
}

# 2. Dipendenze Node (solo la prima volta)
if (-not (Test-Path node_modules)) { Write-Host '[2/3] npm install...'; npm install } else { Write-Host '[2/3] Dipendenze OK' }

# 3. Server Node (database PostgreSQL/pgvector embedded incluso). Ctrl+C per fermare.
Write-Host '[3/3] Avvio server -> http://localhost:3000'
Start-Job { Start-Sleep 4; Start-Process 'http://localhost:3000' } | Out-Null
npm start
