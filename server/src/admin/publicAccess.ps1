param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('status', 'enable', 'disable')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
$taskNames = @('ssh-frp-tunnel-stock', 'frpc-stock-clical')

function Get-PublicAccessStatus {
  $tasks = foreach ($name in $taskNames) {
    try {
      $task = Get-ScheduledTask -TaskName $name -ErrorAction Stop
      [pscustomobject]@{
        name = $name
        found = $true
        enabled = $task.State -ne 'Disabled'
        running = $task.State -eq 'Running'
        state = [string]$task.State
      }
    } catch {
      [pscustomobject]@{ name = $name; found = $false; enabled = $false; running = $false; state = 'Missing' }
    }
  }
  $available = @($tasks | Where-Object found).Count -eq $taskNames.Count
  [pscustomobject]@{
    available = $available
    enabled = $available -and @($tasks | Where-Object { -not $_.enabled }).Count -eq 0
    running = $available -and @($tasks | Where-Object { -not $_.running }).Count -eq 0
    domain = 'https://stock.clical.xin'
    tasks = @($tasks)
    message = if ($available) { $null } else { 'Public access tasks are not fully installed' }
  }
}

if ($Action -eq 'enable') {
  foreach ($name in $taskNames) { Enable-ScheduledTask -TaskName $name | Out-Null }
  Start-ScheduledTask -TaskName 'ssh-frp-tunnel-stock'
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'frpc-stock-clical'
  Start-Sleep -Seconds 2
}

if ($Action -eq 'disable') {
  foreach ($name in @('frpc-stock-clical', 'ssh-frp-tunnel-stock')) {
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  $managed = Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'frpc.exe' -and $_.ExecutablePath -eq 'C:\frp\frpc.exe') -or
    ($_.Name -eq 'ssh.exe' -and $_.CommandLine -like '*127.0.0.1:17000:127.0.0.1:7000*') -or
    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*C:\frp\ssh-tunnel.ps1*') -or
    ($_.Name -eq 'wscript.exe' -and ($_.CommandLine -like '*C:\frp\ssh-tunnel-hidden.vbs*' -or $_.CommandLine -like '*C:\frp\frpc-hidden.vbs*'))
  }
  foreach ($process in $managed) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($name in $taskNames) { Disable-ScheduledTask -TaskName $name | Out-Null }
}

Get-PublicAccessStatus | ConvertTo-Json -Depth 4 -Compress
