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

  Write-Host '==> Instalando dependencias' -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw 'npm install falhou.' }

  Write-Host '==> Gerando plugin minimalista' -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'build falhou.' }

  Write-Host '==> Instalando no Ulanzi Studio' -ForegroundColor Cyan
  New-Item $Plugins -ItemType Directory -Force | Out-Null
  Remove-Item $Target -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item $Source $Target -Recurse -Force

  Write-Host '==> Liberando porta 3333 na rede privada' -ForegroundColor Cyan
  try {
    & netsh advfirewall firewall add rule name='Shindex Mobile 3333' dir=in action=allow protocol=TCP localport=3333 profile=private | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host 'Regra de firewall aplicada.' -ForegroundColor Green }
    else { Write-Warning 'Nao foi possivel alterar o firewall automaticamente. Execute o comando indicado abaixo como Administrador.' }
  } catch { Write-Warning 'Nao foi possivel alterar o firewall automaticamente.' }

  Write-Host ''
  Write-Host 'INSTALADO.' -ForegroundColor Green
  Write-Host "Plugin: $Target"
  Write-Host ''
  Write-Host 'Feche COMPLETAMENTE o Ulanzi Studio, inclusive o icone da bandeja, e abra novamente.' -ForegroundColor Yellow
  Write-Host 'Depois procure por Codex Limits e arraste as 5 acoes para as teclas.'
  Write-Host ''
  Write-Host 'PAINEL NO CELULAR' -ForegroundColor Cyan
  Write-Host 'Depois que o Ulanzi Studio abrir, rode:' -ForegroundColor Gray
  Write-Host 'Get-Content "$env:TEMP\jey-codex-d200h.log" -Tail 100 | Select-String "mobile url"' -ForegroundColor White
  Write-Host 'Abra a URL exibida no Safari do iPhone.' -ForegroundColor Gray
} finally {
  Pop-Location
}
