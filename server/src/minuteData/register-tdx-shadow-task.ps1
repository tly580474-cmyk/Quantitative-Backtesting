param(
  [string]$TaskName = 'QuantBacktest-MinuteTdxShadow',
  [string]$At = '16:00'
)

$ErrorActionPreference = 'Stop'
$serverRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-minute-tdx-shadow.ps1')).Path
$argument = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument $argument `
  -WorkingDirectory $serverRoot
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Shadow-validation of the TDX TCP A-share 1-minute provider; does not publish the minute lake.' `
  -Force | Out-Null

Write-Output "Scheduled shadow task '$TaskName' registered at $At; working directory: $serverRoot"
