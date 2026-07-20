param(
  [string]$TaskName = 'QuantBacktest-MinuteUpdate',
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
$At = Resolve-ScheduleTime $At 'MINUTE_DATA_UPDATE_TIME' '16:30'
$RetryAt = Resolve-ScheduleTime $RetryAt 'MINUTE_DATA_RETRY_TIME' '17:30'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-minute-update.ps1')).Path
$argument = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument $argument `
  -WorkingDirectory $serverRoot
$triggers = @(
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
  -Description 'Automatically fetch, validate, and publish the A-share 1-minute Parquet lake after market close.' `
  -Force | Out-Null

Write-Output "Scheduled task '$TaskName' registered at $At and $RetryAt; working directory: $serverRoot"
