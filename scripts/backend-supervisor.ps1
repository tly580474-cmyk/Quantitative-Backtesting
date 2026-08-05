# 后端监督进程：循环启动 tsx src/app.ts
# - 退出码 75：管理台请求快捷重启，等待 1 秒后重启
# - 退出码 0：正常退出，终止监督
# - 其他退出码：异常崩溃，带退避重启（避免崩溃循环）
#
# 设置环境变量 QUANT_BACKEND_SUPERVISED=true，后端据此启用 /api/admin/restart 接口。
# 日志输出到 stdout/stderr，由调用方决定重定向：
#   - 开发模式 (start-dev.ps1)：可见窗口，直接显示
#   - 后台模式 (start-services.ps1)：隐藏窗口，重定向到 logs\backend.log

$ErrorActionPreference = 'Stop'

# 定位 server 目录（脚本位于仓库根/scripts/，server 在仓库根/server/）
$serverRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'server'
if (-not (Test-Path -LiteralPath $serverRoot)) {
    throw "Server directory not found: $serverRoot"
}
Set-Location $serverRoot

# 通知后端处于被监督模式（启用 /api/admin/restart 接口）
$env:QUANT_BACKEND_SUPERVISED = 'true'

# 选择启动方式：优先用本地 tsx，回退到 npm run start
$tsxCmd = Join-Path $serverRoot 'node_modules\.bin\tsx.cmd'
$useNpm = -not (Test-Path -LiteralPath $tsxCmd)
if ($useNpm) {
    Write-Host '[Supervisor] tsx not found, falling back to npm run start' -ForegroundColor Yellow
}

# 崩溃保护：60 秒滑动窗口内最多允许 5 次异常崩溃，超出则停止监督
$crashWindowSeconds = 60
$maxConsecutiveCrashes = 5
$crashTimes = @()

function Invoke-Backend {
    if ($useNpm) {
        & npm.cmd run start
    } else {
        & $tsxCmd 'src/app.ts'
    }
    return $LASTEXITCODE
}

while ($true) {
    $startTime = Get-Date
    $startIso = $startTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$startIso] [Supervisor] Starting backend..." -ForegroundColor Cyan

    $exitCode = Invoke-Backend

    $endTime = Get-Date
    $duration = ($endTime - $startTime).TotalSeconds
    $endIso = $endTime.ToString('yyyy-MM-dd HH:mm:ss')
    Write-Host "[$endIso] [Supervisor] Backend exited (code $exitCode, duration $([math]::Round($duration, 1))s)" -ForegroundColor Cyan

    if ($exitCode -eq 0) {
        Write-Host '[Supervisor] Normal exit. Supervisor stopped.' -ForegroundColor Green
        break
    }

    if ($exitCode -eq 75) {
        Write-Host '[Supervisor] Restart requested by admin console. Restarting in 1s...' -ForegroundColor Yellow
        Start-Sleep -Seconds 1
        continue
    }

    # 异常崩溃：维护滑动窗口内的崩溃次数
    $now = Get-Date
    $windowStart = $now.AddSeconds(-$crashWindowSeconds)
    $crashTimes = @($crashTimes | Where-Object { $_ -gt $windowStart })
    $crashTimes += $now

    if ($crashTimes.Count -ge $maxConsecutiveCrashes) {
        Write-Host "[Supervisor] Too many crashes ($($crashTimes.Count) within ${crashWindowSeconds}s). Stopping supervisor to avoid crash loop." -ForegroundColor Red
        exit 1
    }

    $waitSeconds = 3
    Write-Host "[Supervisor] Backend crashed (exit $exitCode). Restarting in ${waitSeconds}s..." -ForegroundColor Yellow
    Start-Sleep -Seconds $waitSeconds
}
