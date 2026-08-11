$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logRoot = Join-Path $serverRoot '.logs\fund-flow'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot 'daily-update.log'
$archivePath = Join-Path $logRoot 'daily-update.previous.log'

if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 20MB) {
  Move-Item -LiteralPath $logPath -Destination $archivePath -Force
}

Set-Location -LiteralPath $serverRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Checking trading day before fund-flow update." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
$guardOutput = @(& $npm run schedule:trading-day:check 2>&1)
$guardExitCode = $LASTEXITCODE
$guardOutput | Out-File -LiteralPath $logPath -Append -Encoding utf8
if ($guardExitCode -ne 0) { exit $guardExitCode }
$decisionLine = $guardOutput | Where-Object { $_ -is [string] -and $_.Trim().StartsWith('{') } | Select-Object -Last 1
if (-not $decisionLine) { throw 'Trading-day guard did not return a JSON decision' }
$decision = $decisionLine | ConvertFrom-Json
if (-not [bool]$decision.shouldRun) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skipped: non-trading day." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  exit 0
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting AKShare daily fund-flow update." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
& $npm run fund-flow:update 2>&1 | Out-File -LiteralPath $logPath -Append -Encoding utf8
exit $LASTEXITCODE
