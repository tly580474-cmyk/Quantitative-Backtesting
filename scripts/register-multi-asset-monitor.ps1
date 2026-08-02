param(
  [string]$TaskName = 'QuantBacktest-MultiAsset-Monitor',
  [int]$IntervalMinutes = 5
)

$ErrorActionPreference = 'Stop'
if ($IntervalMinutes -lt 1) { throw 'IntervalMinutes must be at least 1' }
$workspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$serverRoot = Join-Path $workspaceRoot 'server'
$cmd = (Get-Command cmd.exe -ErrorAction Stop).Source
$launcher = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-multi-asset-monitor.cmd')).Path
$action = New-ScheduledTaskAction `
  -Execute $cmd `
  -Argument "/d /c `"`"$launcher`"`"" `
  -WorkingDirectory $serverRoot
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At ((Get-Date).AddMinutes(1)) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes ([Math]::Max(2, $IntervalMinutes)))

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description 'Collect multi-asset queue/worker health; exit 0 healthy, 1 warning, 2 critical, and deliver configured webhook alerts.' `
  -Force | Out-Null

Write-Output "Scheduled task '$TaskName' registered every $IntervalMinutes minute(s); working directory: $serverRoot"
