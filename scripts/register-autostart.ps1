# Registers (or re-registers) the Quant Backtest autostart scheduled task.
# Task name: QuantBacktest-AutoStart
# Trigger: at user logon
# Action:   powershell.exe -File scripts\start-services.ps1 (hidden, no profile)
#
# This script is idempotent: re-running it cleans up ALL legacy tasks and
# shortcuts first, then registers a fresh task.

$ErrorActionPreference = 'Stop'

$taskName = 'QuantBacktest-AutoStart'
$scriptPath = Join-Path $PSScriptRoot 'start-services.ps1'

if (-not (Test-Path $scriptPath)) {
    throw "start-services.ps1 not found at: $scriptPath"
}

# ---------- 1. Clean up ALL legacy autostart registrations ----------
$legacyTasks = @(
    'QuantBacktestServer',     # original register-startup.ps1
    'QuantBacktest',           # earlier register-autostart.ps1
    'QuantBacktest-AutoStart'  # own previous registration (re-register case)
)
foreach ($legacy in $legacyTasks) {
    $t = Get-ScheduledTask -TaskName $legacy -ErrorAction SilentlyContinue
    if ($t) {
        Unregister-ScheduledTask -TaskName $legacy -Confirm:$false
        Write-Host "Removed existing task: $legacy"
    }
}

# Legacy Startup folder shortcut (used by even older versions)
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'QuantBacktest.lnk'
if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "Removed legacy startup shortcut: $shortcutPath"
}

# ---------- 2. Register the new task ----------
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew
    # NOTE: -ExecutionTimeLimit intentionally omitted => default = unlimited,
    # so the spawned backend/frontend/admin processes keep running after logon.
    # NOTE: No -RestartCount / -RestartInterval: the launcher itself is fire-and-forget.
$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Quant Backtest autostart: backend (3001) + frontend (5558) + admin (5559) on user logon (vite dev mode)' | Out-Null

Write-Host ''
Write-Host "OK: Scheduled task '$taskName' registered."
Write-Host "    Trigger: at logon of $env:USERNAME"
Write-Host "    Launcher: $scriptPath"
Write-Host ''
Write-Host 'Test now:      Start-ScheduledTask -TaskName ''QuantBacktest-AutoStart'''
Write-Host 'Uninstall:     Unregister-ScheduledTask -TaskName ''QuantBacktest-AutoStart'' -Confirm:$false'
