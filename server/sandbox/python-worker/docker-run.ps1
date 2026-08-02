<#
.SYNOPSIS
    M5 任意 Python 隔离沙箱 — Docker Desktop (WSL2) 运行器
.DESCRIPTION
    Windows 环境下 docker-run.sh 的等效实现。使用 Docker Desktop 的 WSL2 后端
    运行 Linux 沙箱容器，提供网络/文件系统/进程隔离。

    环境变量（与 config.ts 保持一致）:
      EXPERIMENT_ARBITRARY_PYTHON_ENABLED   默认 false
      EXPERIMENT_SANDBOX_MAX_SECONDS        默认 15
      EXPERIMENT_SANDBOX_MAX_MEMORY_MB      默认 256
      EXPERIMENT_SANDBOX_MAX_OUTPUT_BYTES   默认 1048576
      M5_SANDBOX_IMAGE_TAG                  默认 quant-sandbox:dev
#>

$ErrorActionPreference = 'Stop'

if ($env:EXPERIMENT_ARBITRARY_PYTHON_ENABLED -ne 'true') {
    Write-Error 'ARBITRARY_PYTHON_DISABLED' -ErrorAction Stop
    exit 78
}

$image = if ($env:M5_SANDBOX_IMAGE_TAG) { $env:M5_SANDBOX_IMAGE_TAG } else { 'quant-sandbox:dev' }
$maxSeconds = if ($env:EXPERIMENT_SANDBOX_MAX_SECONDS) { $env:EXPERIMENT_SANDBOX_MAX_SECONDS } else { '15' }
$maxMemoryMB = if ($env:EXPERIMENT_SANDBOX_MAX_MEMORY_MB) { $env:EXPERIMENT_SANDBOX_MAX_MEMORY_MB } else { '256' }
$maxOutputBytes = if ($env:EXPERIMENT_SANDBOX_MAX_OUTPUT_BYTES) { $env:EXPERIMENT_SANDBOX_MAX_OUTPUT_BYTES } else { '1048576' }

$dockerArgs = @(
    'run', '--rm', '-i',
    '--network=none',
    '--read-only',
    "--user=65532:65532",
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    "--pids-limit=16",
    "--memory=${maxMemoryMB}m",
    '--cpus=1',
    "--stop-timeout=1",
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m',
    "-e", "SANDBOX_MAX_OUTPUT_BYTES=${maxOutputBytes}",
    $image
)

try {
    & docker $dockerArgs 2>&1
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 78) {
        Write-Error "SANDBOX_CONTAINER_FAILED: exit code $LASTEXITCODE" -ErrorAction Continue
    }
    exit $LASTEXITCODE
} catch {
    Write-Error "SANDBOX_CONTAINER_FAILED: $_" -ErrorAction Continue
    exit 1
}