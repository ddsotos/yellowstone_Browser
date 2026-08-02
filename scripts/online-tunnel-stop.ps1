param(
  [int]$Port = 9293
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $Root ".tools\online-tunnel-$Port"
$StatusFile = Join-Path $RunDir "status.json"
$ContainerName = "yellowstone-online-tunnel-$Port"

New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

$containerId = docker ps -a --filter "name=^/$ContainerName$" --format "{{.ID}}" 2>$null | Select-Object -First 1
$stopped = $false
if ($containerId) {
  docker rm -f $ContainerName | Out-Null
  $stopped = $true
}

[pscustomobject]@{
  state = "stopped"
  stopped = $stopped
  port = $Port
  containerName = $ContainerName
  updatedAt = (Get-Date).ToString("o")
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatusFile -Encoding UTF8

Get-Content -LiteralPath $StatusFile
