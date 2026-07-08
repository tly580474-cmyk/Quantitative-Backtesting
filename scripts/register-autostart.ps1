$ErrorActionPreference = 'Stop'
$taskName = 'QuantBacktest'

# Remove old startup folder shortcut if present
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'QuantBacktest.lnk'
if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force }

# Remove existing task if any
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

$scriptPath = Join-Path $PSScriptRoot 'start-silent.ps1'
$workDir = Split-Path -Parent $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -AtLogon -RandomDelay (New-TimeSpan -Seconds 30)
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Trigger $trigger -Action $action -Settings $settings -Principal $principal -Description 'Quant Backtest silent launcher'

Write-Host 'OK: Scheduled task "QuantBacktest" registered (logon trigger + ~30s delay)'
