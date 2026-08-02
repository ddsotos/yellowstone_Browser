param(
  [int]$Port = 9293
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $Root ".tools\online-server-$Port"
$PidFile = Join-Path $RunDir "server.pid"
$StatusFile = Join-Path $RunDir "status.json"

$pidValue = $null
if (Test-Path -LiteralPath $PidFile) {
  $pidValue = [int](Get-Content -LiteralPath $PidFile -Raw)
}
$processAlive = $false
if ($pidValue) {
  $processAlive = [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}
$health = $null
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/online/health" -TimeoutSec 1
} catch {
  $health = $null
}
if ($health -and $health.pid) {
  $pidValue = [int]$health.pid
  $processAlive = [bool](Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

[pscustomobject]@{
  pid = $pidValue
  processAlive = $processAlive
  healthOk = [bool]$health
  health = $health
  statusFile = $StatusFile
  recordedStatus = if (Test-Path -LiteralPath $StatusFile) {
    Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
  } else {
    $null
  }
} | ConvertTo-Json -Depth 6
