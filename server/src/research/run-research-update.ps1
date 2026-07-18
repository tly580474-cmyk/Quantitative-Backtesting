$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logRoot = Join-Path $serverRoot '.logs\research-snapshot'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot 'research-update.log'
$archivePath = Join-Path $logRoot 'research-update.previous.log'

if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 20MB) {
  Move-Item -LiteralPath $logPath -Destination $archivePath -Force
}

function Invoke-ResearchCommand {
  param(
    [string]$ScriptName,
    [string[]]$ScriptArgs = @()
  )

  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Running npm script: $ScriptName" |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell wraps native stderr as ErrorRecord objects. External tools
    # commonly write warnings/progress there, so their process exit code is authoritative.
    $ErrorActionPreference = 'Continue'
    & $npm run $ScriptName @ScriptArgs 2>&1 |
      Out-File -LiteralPath $logPath -Append -Encoding utf8
    $commandExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($commandExitCode -ne 0) {
    throw "npm script '$ScriptName' failed with exit code $commandExitCode"
  }
}

function Test-ResearchUpdateAllowed {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Checking CN trading day before automatic update." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $guardOutput = @(& $npm run snapshot:schedule:check 2>&1)
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

Set-Location -LiteralPath $serverRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting automatic research snapshot update." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8

try {
  if (-not (Test-ResearchUpdateAllowed)) {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Skipped automatic research snapshot update: non-trading day." |
      Out-File -LiteralPath $logPath -Append -Encoding utf8
    exit 0
  }
  Invoke-ResearchCommand -ScriptName 'index:update'
  Invoke-ResearchCommand -ScriptName 'index:constituents:update'
  Invoke-ResearchCommand -ScriptName 'sw-industry:update'
  Invoke-ResearchCommand -ScriptName 'dividend:current:update'
  Invoke-ResearchCommand -ScriptName 'dividend:update'
  Invoke-ResearchCommand -ScriptName 'snapshot:build'
  Invoke-ResearchCommand -ScriptName 'snapshot:verify'
  Invoke-ResearchCommand -ScriptName 'snapshot:prune' -ScriptArgs @('--', '--apply')
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Finished automatic research snapshot update with exit code 0." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  exit 0
} catch {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Research snapshot update failed: $($_.Exception.Message)" |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  exit 1
}
