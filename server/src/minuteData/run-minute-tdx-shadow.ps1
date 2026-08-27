$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$env:PYTHONUTF8 = '1'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logRoot = Join-Path $serverRoot '.logs\minute-data'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot 'tdx-shadow.log'
$progressPath = Join-Path $logRoot 'tdx-shadow-progress.json'
$env:MINUTE_UPDATE_PROGRESS_FILE = $progressPath

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
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting TDX TCP minute shadow run." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8

if (-not (Resolve-MinuteFeatureFlag 'MINUTE_TDX_TCP_SHADOW_ENABLED' $true)) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skipped: MINUTE_TDX_TCP_SHADOW_ENABLED is false." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  exit 0
}

$previousErrorActionPreference = $ErrorActionPreference
try {
  $ErrorActionPreference = 'Continue'
  & $npm run schedule:trading-day:check 2>&1 |
    Tee-Object -Variable guardOutput |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  $guardExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
if ($guardExitCode -ne 0) { exit $guardExitCode }
$decisionLine = $guardOutput |
  Where-Object { $_ -is [string] -and $_.Trim().StartsWith('{') } |
  Select-Object -Last 1
if (-not $decisionLine) { throw 'Trading-day guard did not return a JSON decision' }
$decision = $decisionLine | ConvertFrom-Json
if (-not [bool]$decision.shouldRun) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skipped TDX TCP shadow run: non-trading day." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  exit 0
}

try {
  $ErrorActionPreference = 'Continue'
  & $npm run minute:tdx-online:shadow 2>&1 |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  $exitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousErrorActionPreference
}
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Finished TDX TCP minute shadow run with exit code $exitCode." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
exit $exitCode
