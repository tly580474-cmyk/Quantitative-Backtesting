param(
    [ValidateSet('start')]
    [string]$Mode = 'start'
)

$ErrorActionPreference = 'Stop'
$serverRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'server'
$env:QUANT_BACKEND_SUPERVISED = 'true'

Push-Location $serverRoot
try {
    while ($true) {
        & npm.cmd run $Mode
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) { exit 0 }
        # npm.cmd normalizes child exit codes on Windows. A short delay also
        # prevents a persistent startup failure from becoming a tight loop.
        Start-Sleep -Seconds 2
    }
} finally {
    Pop-Location
}
