param(
  [string]$TaskName = 'QuantBacktest-FundFlowUpdate',
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
$At = Resolve-ScheduleTime $At 'FUND_FLOW_UPDATE_TIME' '16:20'
$RetryAt = Resolve-ScheduleTime $RetryAt 'FUND_FLOW_RETRY_TIME' '17:20'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$runner = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'run-fund-flow-update.ps1')).Path
$argument = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $argument -WorkingDirectory $serverRoot
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At $At
  New-ScheduledTaskTrigger -Daily -At $RetryAt
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -WakeToRun `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings `
  -Description 'Persist daily A-share main, super-large, large, medium, and small order fund flows.' -Force | Out-Null
Write-Output "Scheduled task '$TaskName' registered at $At and $RetryAt; working directory: $serverRoot"
