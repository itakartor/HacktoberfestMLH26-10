# Setup completo su Windows: .\setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Installo Node.js LTS...'
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
}

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) { $ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe' }
if (-not (Test-Path $ollama)) {
  Write-Host 'Installo Ollama...'
  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
}

try { Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 2 | Out-Null }
catch { Write-Host 'Avvio Ollama...'; Start-Process $ollama -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 3 }

# I download possono interrompersi per errori di rete: riprova.
foreach ($model in @('embeddinggemma', 'gemma4:e4b-it-qat')) {
  for ($i = 1; $i -le 4; $i++) {
    & $ollama pull $model
    if ($LASTEXITCODE -eq 0) { break }
    Write-Host "Download di $model fallito (tentativo $i), riprovo..."
    Start-Sleep 5
  }
}

npm install

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host 'Creato .env: inserisci ELEVENLABS_API_KEY per usare il microfono.'
}

npm run check
Write-Host "`nAvvia con: npm start  ->  http://localhost:3000"
