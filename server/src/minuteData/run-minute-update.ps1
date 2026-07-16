$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$logRoot = Join-Path $serverRoot '.logs\minute-data'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
$logPath = Join-Path $logRoot 'minute-update.log'
$archivePath = Join-Path $logRoot 'minute-update.previous.log'

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

Set-Location -LiteralPath $serverRoot
"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Starting automatic minute update." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8

$exitCode = Invoke-MinuteUpdateCommand -ScriptName 'minute:online:update'
if ($exitCode -ne 0) {
  "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Online update failed with $exitCode; trying local TDX fallback." |
    Out-File -LiteralPath $logPath -Append -Encoding utf8
  $exitCode = Invoke-MinuteUpdateCommand -ScriptName 'minute:tdx:import'
}

"[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Finished automatic minute update with exit code $exitCode." |
  Out-File -LiteralPath $logPath -Append -Encoding utf8
exit $exitCode
