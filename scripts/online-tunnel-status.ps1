param(
  [int]$Port = 9293
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $Root ".tools\online-tunnel-$Port"
$StatusFile = Join-Path $RunDir "status.json"
$ContainerName = "yellowstone-online-tunnel-$Port"

function Get-TunnelLogs {
  return @(cmd.exe /c "docker logs $ContainerName 2>&1")
}

$containerId = docker ps --filter "name=^/$ContainerName$" --format "{{.ID}}" 2>$null | Select-Object -First 1
$logs = if ($containerId) { Get-TunnelLogs } else { @() }
$urlMatch = $logs | Select-String -Pattern "https://[a-zA-Z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
$publicUrl = if ($urlMatch) { $urlMatch.Matches[0].Value } else { $null }

[pscustomobject]@{
  state = if ($containerId -and $publicUrl) { "running" } elseif ($containerId) { "starting" } else { "stopped" }
  port = $Port
  containerName = $ContainerName
  containerId = $containerId
  publicUrl = $publicUrl
  shareUrl = if ($publicUrl) { "$publicUrl/?online=1" } else { $null }
  statusFile = $StatusFile
  recordedStatus = if (Test-Path -LiteralPath $StatusFile) {
    Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json
  } else {
    $null
  }
  logTail = @($logs | Select-Object -Last 12)
  updatedAt = (Get-Date).ToString("o")
} | ConvertTo-Json -Depth 6
