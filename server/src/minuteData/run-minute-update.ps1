$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$env:PYTHONUTF8 = '1'
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
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Native tools legitimately use non-zero exit codes to signal a retryable
    # dependency. Do not let PowerShell turn stderr into a terminating error.
    $ErrorActionPreference = 'Continue'
    & $npm run $ScriptName 2>&1 | Out-File -LiteralPath $logPath -Append -Encoding utf8
    $commandExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return $commandExitCode
}

function Test-MinuteUpdateAllowed {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Checking CN trading day before automatic update." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $guardOutput = @(& $npm run schedule:trading-day:check 2>&1)
    $guardExitCode = $LASTEXITCODE
    $guardOutput | Out-File -LiteralPath $logPath -Append -Encoding utf8
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($guardExitCode -ne 0) {
    throw "Trading-day guard failed with exit code $guardExitCode"
  }
  $decisionLine = $guardOutput |
    Where-Object { $_ -is [string] -and $_.Trim().StartsWith('{') } |
    Select-Object -Last 1
  if (-not $decisionLine) {
    throw 'Trading-day guard did not return a JSON decision'
  }
  $decision = $decisionLine | ConvertFrom-Json
  return [bool]$decision.shouldRun
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

function Resolve-MinuteFeatureFlag {
  param([string]$Key, [bool]$Fallback)
  $fromProcess = [Environment]::GetEnvironmentVariable($Key)
  if ($fromProcess) {
    return $fromProcess.Trim().ToLowerInvariant() -in @('1', 'true', 'yes', 'on')
  }
  $envPath = Join-Path $serverRoot '.env'
  if (Test-Path -LiteralPath $envPath) {
    $line = Get-Content -LiteralPath $envPath |
      Where-Object { $_ -match "^$Key=" } |
      Select-Object -Last 1
    if ($line) {
      $value = $line.Substring($Key.Length + 1).Trim().Trim('"').Trim("'")
      return $value.ToLowerInvariant() -in @('1', 'true', 'yes', 'on')
    }
  }
  return $Fallback
}

Set-Location -LiteralPath $serverRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting automatic minute update." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
if (-not (Test-MinuteUpdateAllowed)) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skipped automatic minute update: non-trading day." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  Write-MinuteProgress -Status 'completed' -Phase 'skipped-non-trading-day' -Message 'Skipped because the configured market is closed.'
  exit 0
}
Write-MinuteProgress -Status 'running' -Phase 'starting' -Message 'Background scheduled task started.'

$dependencyWaitMinutes = 30
$configuredDependencyWait = [Environment]::GetEnvironmentVariable('MINUTE_REFERENCE_WAIT_MINUTES')
if ($configuredDependencyWait -and [int]::TryParse($configuredDependencyWait, [ref]$dependencyWaitMinutes)) {
  $dependencyWaitMinutes = [Math]::Max(0, $dependencyWaitMinutes)
}
$dependencyDeadline = (Get-Date).AddMinutes($dependencyWaitMinutes)
$dependencyTimedOut = $false
$tdxTcpEnabled = Resolve-MinuteFeatureFlag 'MINUTE_TDX_TCP_ENABLED' $true
$primaryScript = if ($tdxTcpEnabled) { 'minute:tdx-online:update' } else { 'minute:online:update' }
do {
  $exitCode = Invoke-MinuteUpdateCommand -ScriptName $primaryScript
  if ($exitCode -ne 3) { break }
  if ((Get-Date) -ge $dependencyDeadline) {
    Write-MinuteProgress `
      -Status 'failed' `
      -Phase 'dependency-timeout' `
      -Message "Final daily bars were not ready after waiting $dependencyWaitMinutes minutes."
    $dependencyTimedOut = $true
    $exitCode = 1
    break
  }
  Write-MinuteProgress `
    -Status 'pending' `
    -Phase 'waiting-daily-reference' `
    -Message 'Waiting for the final daily-bar update before publishing the minute lake.'
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Final daily bars are not ready; retrying in 60 seconds." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  Start-Sleep -Seconds 60
} while ($true)

if ($exitCode -ne 0 -and -not $dependencyTimedOut -and $tdxTcpEnabled) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] TDX TCP update failed with $exitCode; trying Sina online fallback." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  Write-MinuteProgress -Status 'running' -Phase 'sina-fallback' -Message 'TDX TCP update failed; running the Sina online fallback.'
  $exitCode = Invoke-MinuteUpdateCommand -ScriptName 'minute:online:update'
}

if ($exitCode -ne 0 -and -not $dependencyTimedOut) {
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

if ($exitCode -eq 0) {
  Write-MinuteProgress `
    -Status 'completed' `
    -Phase 'completed' `
    -Message 'Minute data update completed.'
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Finished automatic minute update with exit code $exitCode." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
exit $exitCode
