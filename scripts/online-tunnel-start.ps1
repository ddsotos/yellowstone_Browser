param(
  [int]$Port = 9293,
  [int]$WaitSeconds = 25
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $Root ".tools\online-tunnel-$Port"
$StatusFile = Join-Path $RunDir "status.json"
$ContainerName = "yellowstone-online-tunnel-$Port"
$LocalHealthUrl = "http://127.0.0.1:$Port/api/online/health"

New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

function Write-TunnelStatus($State, $Message = "", $PublicUrl = $null, $ContainerId = $null) {
  [pscustomobject]@{
    state = $State
    message = $Message
    port = $Port
    containerName = $ContainerName
    containerId = $ContainerId
    localUrl = "http://localhost:$Port/?online=1"
    publicUrl = $PublicUrl
    shareUrl = if ($PublicUrl) { "$PublicUrl/?online=1" } else { $null }
    statusFile = $StatusFile
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatusFile -Encoding UTF8
}

function Get-TunnelLogs {
  return @(cmd.exe /c "docker logs $ContainerName 2>&1")
}

try {
  Invoke-RestMethod -Uri $LocalHealthUrl -TimeoutSec 2 | Out-Null
} catch {
  Write-TunnelStatus "failed" "local online server is not healthy at $LocalHealthUrl"
  Get-Content -LiteralPath $StatusFile
  exit 1
}

$existing = docker ps --filter "name=^/$ContainerName$" --format "{{.ID}}" 2>$null | Select-Object -First 1
if ($existing) {
  $logs = Get-TunnelLogs
  $urlMatch = $logs | Select-String -Pattern "https://[a-zA-Z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
  $publicUrl = if ($urlMatch) { $urlMatch.Matches[0].Value } else { $null }
  Write-TunnelStatus "running" "tunnel already running" $publicUrl $existing
  Get-Content -LiteralPath $StatusFile
  exit 0
}

$old = docker ps -a --filter "name=^/$ContainerName$" --format "{{.ID}}" 2>$null | Select-Object -First 1
if ($old) {
  docker rm -f $ContainerName | Out-Null
}

Write-TunnelStatus "starting" "starting cloudflared docker tunnel"
$containerId = docker run -d --name $ContainerName cloudflare/cloudflared:latest tunnel --no-autoupdate --url "http://host.docker.internal:$Port"
if ($LASTEXITCODE -ne 0 -or -not $containerId) {
  Write-TunnelStatus "failed" "docker run failed"
  Get-Content -LiteralPath $StatusFile
  exit 1
}

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  $running = docker ps --filter "name=^/$ContainerName$" --format "{{.ID}}" | Select-Object -First 1
  if (-not $running) {
    $logs = Get-TunnelLogs
    Write-TunnelStatus "failed" ("tunnel container exited: " + (($logs | Select-Object -Last 8) -join " ")) $null $containerId
    Get-Content -LiteralPath $StatusFile
    exit 1
  }
  $logs = Get-TunnelLogs
  $urlMatch = $logs | Select-String -Pattern "https://[a-zA-Z0-9-]+\.trycloudflare\.com" | Select-Object -First 1
  if ($urlMatch) {
    $publicUrl = $urlMatch.Matches[0].Value
    Write-TunnelStatus "running" "quick tunnel ready" $publicUrl $containerId
    Get-Content -LiteralPath $StatusFile
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

Write-TunnelStatus "starting" "tunnel is still starting; use online-tunnel-status.cmd to recheck" $null $containerId
Get-Content -LiteralPath $StatusFile
exit 2
