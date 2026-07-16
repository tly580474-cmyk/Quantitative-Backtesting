param(
  [string]$TaskName = 'QuantBacktest-MinuteUpdate',
  [string]$At = '16:30',
  [string]$RetryAt = '17:30'
)

$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-minute-update.ps1')).Path
$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
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
