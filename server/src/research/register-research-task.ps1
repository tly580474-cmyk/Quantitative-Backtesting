param(
  [string]$TaskName = 'QuantBacktest-ResearchSnapshot',
  [string]$MorningRetryAt = '',
  [string]$At = '',
  [string]$RetryAt = ''
)

$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
function Resolve-ScheduleTime {
  param([string]$Value, [string]$Key, [string]$Fallback)
  if ($Value) { return $Value }
  $fromProcess = [Environment]::GetEnvironmentVariable($Key)
  if ($fromProcess) { return $fromProcess }
  $envPath = Join-Path $serverRoot '.env'
  if (Test-Path -LiteralPath $envPath) {
    $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
    if ($line) { return ($line.Substring($Key.Length + 1)).Trim().Trim('"').Trim("'") }
  }
  return $Fallback
}
$MorningRetryAt = Resolve-ScheduleTime $MorningRetryAt 'RESEARCH_SNAPSHOT_MORNING_RETRY_TIME' '08:30'
$At = Resolve-ScheduleTime $At 'RESEARCH_SNAPSHOT_UPDATE_TIME' '18:00'
$RetryAt = Resolve-ScheduleTime $RetryAt 'RESEARCH_SNAPSHOT_RETRY_TIME' '18:30'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-research-update.ps1')).Path
$argument = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument $argument `
  -WorkingDirectory $serverRoot
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At $MorningRetryAt
  New-ScheduledTaskTrigger -Daily -At $At
  New-ScheduledTaskTrigger -Daily -At $RetryAt
)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $triggers `
  -Settings $settings `
  -Description 'Build, validate, and atomically publish the DuckDB research snapshot after market close.' `
  -Force | Out-Null

Write-Output "Scheduled task '$TaskName' registered at $MorningRetryAt, $At and $RetryAt; working directory: $serverRoot"
