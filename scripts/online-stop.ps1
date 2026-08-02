param(
  [int]$Port = 9293,
  [int]$WaitSeconds = 3
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $Root ".tools\online-server-$Port"
$PidFile = Join-Path $RunDir "server.pid"
$StatusFile = Join-Path $RunDir "status.json"

New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

$stopped = $false
$pidValue = $null
if (Test-Path -LiteralPath $PidFile) {
  $pidValue = [int](Get-Content -LiteralPath $PidFile -Raw)
}
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/online/health" -TimeoutSec 1
  if ($health.pid) { $pidValue = [int]$health.pid }
} catch {
  $health = $null
}
if ($pidValue) {
  $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $pidValue -Force
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    while ((Get-Date) -lt $deadline) {
      if (-not (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)) {
        break
      }
      Start-Sleep -Milliseconds 200
    }
    $stopped = $true
  }
}

[pscustomobject]@{
  state = "stopped"
  stopped = $stopped
  port = $Port
  updatedAt = (Get-Date).ToString("o")
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatusFile -Encoding UTF8

Get-Content -LiteralPath $StatusFile
