$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logRoot = Join-Path $serverRoot '.logs\minute-data'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot 'minute-update.log'
$archivePath = Join-Path $logRoot 'minute-update.previous.log'
$progressPath = Join-Path $logRoot 'progress.json'
$env:MINUTE_UPDATE_PROGRESS_FILE = $progressPath

if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 20MB) {
  Move-Item -LiteralPath $logPath -Destination $archivePath -Force
}

function Invoke-MinuteUpdateCommand {
  param([string]$ScriptName)

  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Running npm script: $ScriptName" |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  & $npm run $ScriptName 2>&1 | Out-File -LiteralPath $logPath -Append -Encoding utf8
  return $LASTEXITCODE
}

function Write-MinuteProgress {
  param([string]$Status, [string]$Phase, [string]$Message)
  $now = (Get-Date).ToUniversalTime().ToString('o')
  $payload = [ordered]@{
    status = $Status
    phase = $Phase
    completed = 0
    total = 0
    failed = 0
    startedAt = $now
    updatedAt = $now
    finishedAt = if ($Status -in @('completed', 'failed')) { $now } else { $null }
    message = $Message
  }
  $temporary = "$progressPath.tmp"
  $payload | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $progressPath -Force
}

Set-Location -LiteralPath $serverRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting automatic minute update." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
Write-MinuteProgress -Status 'running' -Phase 'starting' -Message 'Background scheduled task started.'

$exitCode = Invoke-MinuteUpdateCommand -ScriptName 'minute:online:update'
if ($exitCode -ne 0) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Online update failed with $exitCode; trying local TDX fallback." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  Write-MinuteProgress -Status 'running' -Phase 'local-fallback' -Message 'Online update failed; running the local TDX fallback.'
  $exitCode = Invoke-MinuteUpdateCommand -ScriptName 'minute:tdx:import'
  if ($exitCode -eq 0) {
    Write-MinuteProgress -Status 'completed' -Phase 'fallback-completed' -Message 'Local TDX fallback completed.'
  } else {
    Write-MinuteProgress -Status 'failed' -Phase 'failed' -Message "Online and local fallback updates failed with exit code $exitCode."
  }
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Finished automatic minute update with exit code $exitCode." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
exit $exitCode
