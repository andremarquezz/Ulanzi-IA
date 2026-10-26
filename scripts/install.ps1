param([switch]$UseExistingBuild)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Name = 'com.ulanzi.ulanzistudio.jeycodex.ulanziPlugin'
$Source = Join-Path $Root "dist\$Name"
$Plugins = Join-Path $env:APPDATA 'Ulanzi\UlanziDeck\Plugins'
$Target = Join-Path $Plugins $Name

Push-Location $Root
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22+ nao encontrado.'
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm nao encontrado.'
  }
  if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw 'Codex CLI nao encontrado no PATH.'
  }

  if (-not $UseExistingBuild) {
    Write-Host '==> Instalando dependencias' -ForegroundColor Cyan
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'npm install falhou.' }

    Write-Host '==> Gerando plugin' -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'build falhou.' }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Source 'plugin\goal-worker.js'))) {
    throw 'Build incompleto. Execute npm run build antes de instalar.'
  }

  Write-Host '==> Instalando no Ulanzi Studio' -ForegroundColor Cyan
  New-Item $Plugins -ItemType Directory -Force | Out-Null
  New-Item $Target -ItemType Directory -Force | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
  }

  Write-Host ''
  Write-Host 'INSTALADO.' -ForegroundColor Green
  Write-Host "Plugin: $Target"
  Write-Host ''
  Write-Host 'Feche COMPLETAMENTE o Ulanzi Studio, inclusive o icone da bandeja, e abra novamente.' -ForegroundColor Yellow
  Write-Host 'Procure Codex Limits. Adicione PAINEL GOALS, EXECUTAR / PAUSAR e TROCA AUTOMATICA as teclas.'
  Write-Host 'O painel Goals funciona localmente e nao exige configuracao de firewall.'
  Write-Host ''
  Write-Host 'PAINEL NO CELULAR' -ForegroundColor Cyan
  Write-Host 'Depois que o Ulanzi Studio abrir, arraste ABRIR NO CELULAR para uma tecla e pressione uma vez.' -ForegroundColor Gray
  Write-Host 'A URL será copiada automaticamente para o clipboard do Windows.' -ForegroundColor Gray
  Write-Host 'Para ver a URL novamente:' -ForegroundColor Gray
  Write-Host 'Get-Content "$env:TEMP\jey-codex-d200h.log" -Tail 100 | Select-String "open on phone"' -ForegroundColor White
  Write-Host 'Pressione a tecla novamente para parar o servidor mobile.' -ForegroundColor Gray
} finally {
  Pop-Location
}
