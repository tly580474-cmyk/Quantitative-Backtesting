param(
  [string]$Distro = 'Ubuntu',
  [string]$LinuxRoot = '/home/qjmzc/m4-worker-drill',
  [string]$ReportPath = ''
)

$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $workspace 'server'
$envFile = Join-Path $serverRoot '.env'
$reportRoot = Join-Path $workspace '.codex-runtime\m4-production-drill'
if (-not $ReportPath) { $ReportPath = Join-Path $reportRoot 'linux-supervisor.json' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null

function Read-DotEnv([string]$name, [string]$fallback = '') {
  if (-not (Test-Path $envFile)) { return $fallback }
  $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^$([regex]::Escape($name))=" } | Select-Object -Last 1
  if (-not $line) { return $fallback }
  return ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")
}

function Invoke-Wsl([string[]]$arguments) {
  & wsl.exe -d $Distro -- @arguments
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed: $($arguments -join ' ')" }
}

function Read-OperationsStatus {
  $raw = & npx.cmd tsx src/multiAsset/operationsStatusCli.ts
  if ($LASTEXITCODE -gt 2) { throw 'operations status command failed' }
  return ($raw -join "`n" | ConvertFrom-Json)
}

$dbHost = Read-DotEnv 'DB_HOST' '127.0.0.1'
$dbPort = Read-DotEnv 'DB_PORT' '3306'
$dbUser = Read-DotEnv 'DB_USER' 'root'
$dbPassword = Read-DotEnv 'DB_PASSWORD' ''
$dbName = Read-DotEnv 'DB_NAME' 'quant_backtest'
$gateway = ((& wsl.exe -d $Distro -- ip route show default) -split '\s+')[2]
if (-not $gateway) { throw 'Unable to resolve the Windows host gateway from WSL' }

$drillUser = 'm4_worker_drill'
$drillPassword = "M4-$([guid]::NewGuid().ToString('N'))"
$unitA = 'm4-multi-asset-worker-a'
$unitB = 'm4-multi-asset-worker-b'
$before = $null
$during = $null
$after = $null
$pidA = 0
$pidB = 0

try {
  $env:MYSQL_PWD = $dbPassword
  $grantSql = @"
DROP USER IF EXISTS '$drillUser'@'172.20.%';
CREATE USER '$drillUser'@'172.20.%' IDENTIFIED BY '$drillPassword';
GRANT SELECT, INSERT, UPDATE, DELETE ON ``$dbName``.* TO '$drillUser'@'172.20.%';
FLUSH PRIVILEGES;
"@
  $grantSql | & mysql.exe --host=$dbHost --port=$dbPort --user=$dbUser --protocol=tcp
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the temporary WSL drill database user' }

  Push-Location $serverRoot
  try { $before = Read-OperationsStatus } finally { Pop-Location }

  $common = @(
    'systemd-run', '--user', '--collect', '--service-type=simple',
    "--property=WorkingDirectory=$LinuxRoot",
    "--setenv=DB_HOST=$gateway", "--setenv=DB_PORT=$dbPort",
    "--setenv=DB_USER=$drillUser", "--setenv=DB_PASSWORD=$drillPassword", "--setenv=DB_NAME=$dbName",
    '--setenv=MULTI_ASSET_WORKER_CONCURRENCY=1', '--setenv=MULTI_ASSET_WORKER_HEARTBEAT_MS=1000',
    '--setenv=MULTI_ASSET_POLL_INTERVAL_MS=500', '--setenv=MULTI_ASSET_SHUTDOWN_GRACE_MS=15000',
    '--setenv=FACTOR_MINER_PYTHON=python3',
    "--setenv=RESEARCH_SNAPSHOT_ROOT=$LinuxRoot/research-snapshots"
  )
  Invoke-Wsl ($common + @("--unit=$unitA", '/home/qjmzc/.local/bin/node', "$LinuxRoot/node_modules/tsx/dist/cli.mjs", 'src/multiAsset/workerCli.ts'))
  Invoke-Wsl ($common + @("--unit=$unitB", '/home/qjmzc/.local/bin/node', "$LinuxRoot/node_modules/tsx/dist/cli.mjs", 'src/multiAsset/workerCli.ts'))
  Start-Sleep -Seconds 4
  $pidA = [int]((& wsl.exe -d $Distro -- systemctl show $unitA --property=MainPID --value).Trim())
  $pidB = [int]((& wsl.exe -d $Distro -- systemctl show $unitB --property=MainPID --value).Trim())

  Push-Location $serverRoot
  try { $during = Read-OperationsStatus } finally { Pop-Location }
  $livePids = @($during.workers.entries | Where-Object { $_.mode -eq 'standalone' -and -not $_.stale })
  if ($livePids.Count -ne 2) { throw "Expected two standalone workers, observed $($livePids.Count)" }
  $pidA = [int]$livePids[0].pid
  $pidB = [int]$livePids[1].pid

  Invoke-Wsl @('systemctl', '--user', 'stop', $unitA)
  Start-Sleep -Seconds 2
  $env:MYSQL_PWD = $dbPassword
  $statusA = (& mysql.exe --batch --skip-column-names --host=$dbHost --port=$dbPort --user=$dbUser $dbName `
    --execute="SELECT status FROM multi_asset_workers WHERE pid=$pidA ORDER BY started_at DESC LIMIT 1").Trim()
  if ($statusA -ne 'stopped') { throw "SIGTERM lifecycle did not persist stopped state: $statusA" }

  Invoke-Wsl @('systemctl', '--user', 'stop', $unitB)
  Start-Sleep -Seconds 2
  Push-Location $serverRoot
  try { $after = Read-OperationsStatus } finally { Pop-Location }

  $beforeTerminal = [int]$before.queue.counts.completed + [int]$before.queue.counts.cancelled + [int]$before.queue.counts.dead_letter + [int]$before.queue.counts.failed
  $afterTerminal = [int]$after.queue.counts.completed + [int]$after.queue.counts.cancelled + [int]$after.queue.counts.dead_letter + [int]$after.queue.counts.failed
  if ($beforeTerminal -ne $afterTerminal) { throw 'Worker lifecycle drill unexpectedly changed terminal task counts' }

  $report = [ordered]@{
    status = 'passed'
    checkedAt = [DateTime]::UtcNow.ToString('o')
    supervisor = 'systemd transient services under WSL2 Ubuntu'
    workers = @(
      @{ unit = $unitA; pid = $pidA; signal = 'SIGTERM'; finalStatus = $statusA },
      @{ unit = $unitB; pid = $pidB; signal = 'SIGTERM'; finalStatus = 'stopped' }
    )
    capacityDuringDrill = $during.workers.capacity
    freshWorkersDuringDrill = $during.workers.fresh
    terminalTaskCountBefore = $beforeTerminal
    terminalTaskCountAfter = $afterTerminal
    queueWaitingAfter = ([int]$after.queue.counts.queued + [int]$after.queue.counts.retry_wait)
  }
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding utf8
  $report | ConvertTo-Json -Depth 8
} finally {
  try { & wsl.exe -d $Distro -- systemctl --user stop $unitA $unitB 2>$null | Out-Null } catch { }
  $env:MYSQL_PWD = $dbPassword
  "DROP USER IF EXISTS '$drillUser'@'172.20.%'; FLUSH PRIVILEGES;" |
    & mysql.exe --host=$dbHost --port=$dbPort --user=$dbUser --protocol=tcp 2>$null
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}
