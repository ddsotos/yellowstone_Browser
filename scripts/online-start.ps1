param(
  [int]$Port = 9293,
  [string]$DataDir = "",
  [int]$WaitSeconds = 8
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunDir = Join-Path $Root ".tools\online-server-$Port"
$Stdout = Join-Path $RunDir "stdout.log"
$Stderr = Join-Path $RunDir "stderr.log"
$PidFile = Join-Path $RunDir "server.pid"
$StatusFile = Join-Path $RunDir "status.json"

New-Item -ItemType Directory -Path $RunDir -Force | Out-Null

function Write-Status($State, $Message = "", $PidValue = $null) {
  [pscustomobject]@{
    state = $State
    message = $Message
    pid = $PidValue
    port = $Port
    url = "http://localhost:$Port/?online=1"
    healthUrl = "http://127.0.0.1:$Port/api/online/health"
    stdout = $Stdout
    stderr = $Stderr
    updatedAt = (Get-Date).ToString("o")
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatusFile -Encoding UTF8
}

function Get-Health {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/online/health" -TimeoutSec 1
  } catch {
    return $null
  }
}

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
$netstatListenerPid = $null
if (-not $existing) {
  $netstatLine = netstat -ano | Select-String "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$" | Select-Object -First 1
  if ($netstatLine -and $netstatLine.Matches[0].Groups[1].Value) {
    $netstatListenerPid = [int]$netstatLine.Matches[0].Groups[1].Value
    $existing = [pscustomobject]@{ OwningProcess = $netstatListenerPid }
  }
}
$existingHealth = if ($existing) { Get-Health } else { $null }
if ($existing -and $existingHealth) {
  $existingPid = [int]$existingHealth.pid
  $existingPid | Set-Content -LiteralPath $PidFile -Encoding ASCII
  Write-Status "running" "already running; health check passed" $existingPid
  Get-Content -LiteralPath $StatusFile
  exit 0
}
if ($existing) {
  $ownerPid = if ($netstatListenerPid) { $netstatListenerPid } else { $existing.OwningProcess | Select-Object -First 1 }
  Write-Status "failed" "port $Port is already in use by process $ownerPid, but it is not a healthy Yellowstone server" $ownerPid
  Get-Content -LiteralPath $StatusFile
  exit 1
}

$pathValue = [Environment]::GetEnvironmentVariable("Path", "Process")
if ([string]::IsNullOrEmpty($pathValue)) {
  $pathValue = [Environment]::GetEnvironmentVariable("PATH", "Process")
}
[Environment]::SetEnvironmentVariable("PATH", $null, "Process")
[Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")

Remove-Item -LiteralPath $Stdout, $Stderr -ErrorAction SilentlyContinue
$env:ONLINE_PORT = "$Port"
if ($DataDir) {
  $env:ONLINE_DATA_DIR = $DataDir
} else {
  Remove-Item Env:\ONLINE_DATA_DIR -ErrorAction SilentlyContinue
}

Write-Status "starting" "detached process requested; waiting for health check" $null
$launchDataDir = if ($DataDir) { $DataDir } else { "-" }
$launchJson = & "C:\Program Files\nodejs\node.exe" "$Root\scripts\online-launch.mjs" "$Port" "$launchDataDir" "$Stdout" "$Stderr" "$Root"
if ($LASTEXITCODE -ne 0) {
  Write-Status "failed" "detached launcher exited with code $LASTEXITCODE" $null
  Get-Content -LiteralPath $StatusFile
  exit 1
}
$launchResult = $launchJson | ConvertFrom-Json
$launcherPid = [int]$launchResult.pid
Write-Status "starting" "server pid $launcherPid; waiting for health check" $launcherPid

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  $health = Get-Health
  if ($health) {
    $serverPid = [int]$health.pid
    $serverPid | Set-Content -LiteralPath $PidFile -Encoding ASCII
    Write-Status "running" "health check passed" $serverPid
    Get-Content -LiteralPath $StatusFile
    exit 0
  }
  if (-not (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)) {
    Write-Status "failed" "server exited before health check passed" $launcherPid
    Get-Content -LiteralPath $StatusFile
    exit 1
  }
  Start-Sleep -Milliseconds 500
}

Write-Status "failed" "health check timed out after $WaitSeconds seconds; use online-status.cmd to recheck" $launcherPid
Get-Content -LiteralPath $StatusFile
exit 1
