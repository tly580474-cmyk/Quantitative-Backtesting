[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$script:Results = [System.Collections.Generic.List[object]]::new()
$skillRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repoRoot = (Resolve-Path (Join-Path $skillRoot '..\..\..')).Path
$serverRoot = Join-Path $repoRoot 'server'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("local-duckdb-research-" + [guid]::NewGuid().ToString('N'))

function Add-Result {
  param([string]$Rule, [bool]$Passed, [string]$Evidence)
  $script:Results.Add([pscustomobject]@{ Rule = $Rule; Passed = $Passed; Evidence = $Evidence })
  if (-not $Passed) { throw "[$Rule] $Evidence" }
}

function Invoke-Cli {
  param([string[]]$CliArgs)
  Push-Location $serverRoot
  try {
    $priorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = (& npm.cmd run duckdb -- @CliArgs 2>&1 | Out-String)
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
  } finally {
    $ErrorActionPreference = $priorPreference
    Pop-Location
  }
}

function Invoke-Vitest {
  param([string[]]$Files)
  Push-Location $serverRoot
  try {
    $priorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $output = (& npx.cmd vitest run @Files 2>&1 | Out-String)
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
  } finally {
    $ErrorActionPreference = $priorPreference
    Pop-Location
  }
}

New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  $help = Invoke-Cli @('help')
  $status = Invoke-Cli @('status', '--format', 'json')
  $views = Invoke-Cli @('views', '--format', 'json')
  $schema = Invoke-Cli @('schema', '--view', 'bars', '--format', 'json')
  Add-Result 'R1' ($help.ExitCode -eq 0 -and $status.ExitCode -eq 0 -and $views.ExitCode -eq 0 -and $schema.ExitCode -eq 0) 'help/status/views/schema all completed successfully.'

  $recipes = Invoke-Cli @('recipes')
  $pipeline = Invoke-Cli @('pipeline', '--file', './examples/duckdb/pipelines/factor-study.json', '--dry-run')
  $batch = Invoke-Cli @('batch', '--file', './examples/duckdb/batches/export-symbols.json', '--out-dir', $tempRoot, '--dry-run')
  Add-Result 'R2' ($recipes.ExitCode -eq 0 -and $pipeline.ExitCode -eq 0 -and $batch.ExitCode -eq 0 -and $help.Output -match 'minute') 'Mode routing is exposed, and recipe/pipeline/batch dry-runs succeed.'

  $parameterized = Invoke-Cli @('query', '--no-snapshot-view', '--format', 'json', '--sql', 'SELECT $symbol AS symbol, $n + 1 AS value', '--param', 'symbol=002155', '--param', 'n=1')
  $multiStatement = Invoke-Cli @('query', '--no-snapshot-view', '--format', 'json', '--sql', 'CREATE TEMP TABLE t AS SELECT 7 AS value; SELECT value FROM t;')
  $badOrder = Invoke-Cli @('--sql', 'SELECT 1')
  Add-Result 'R3' ($parameterized.ExitCode -eq 0 -and $parameterized.Output -match '002155' -and $multiStatement.ExitCode -eq 0 -and $multiStatement.Output -match '7' -and $badOrder.ExitCode -ne 0) 'Named parameters preserve a zero-padded symbol, multi-statement state is shared, and missing subcommands are rejected.'

  $atomic = Invoke-Cli @('query', '--no-snapshot-view', '--transaction', '--sql', 'CREATE TEMP TABLE tx AS SELECT 1 AS value; SELECT value FROM tx;')
  Add-Result 'R4' ($pipeline.Output -match 'dry-run' -and $batch.Output -match 'dry-run' -and $atomic.ExitCode -eq 0) 'Dry-run plans are observable and transactional multi-statement SQL succeeds.'

  $financialTests = Invoke-Vitest @('src/research/returnBasis.test.ts', 'src/research/duckdbRecipes.test.ts')
  $referenceSchemas = @('adjustment_factors', 'index_constituents', 'dividend_events', 'sw_industry_memberships') | ForEach-Object { Invoke-Cli @('schema', '--view', $_, '--format', 'json') }
  Add-Result 'R5' ($financialTests.ExitCode -eq 0 -and ($referenceSchemas | Where-Object ExitCode -ne 0).Count -eq 0) 'Adjustment semantics/recipes pass unit tests, and all domain views expose current schemas.'

  $minuteTests = Invoke-Vitest @('src/research/duckdbMinuteQuery.test.ts')
  $minutePlan = Invoke-Cli @('minute', '--symbol', '002155', '--start', '2026-07-15', '--end', '2026-07-15', '--interval', '5m', '--dry-run')
  Add-Result 'R6' ($minuteTests.ExitCode -eq 0 -and $minutePlan.ExitCode -eq 0) 'Minute query generation passes unit tests and a catalog-backed 5m plan succeeds.'

  $guardTests = Invoke-Vitest @('src/research/researchQueryGuard.test.ts')
  $blockedGlob = Invoke-Cli @('query', '--no-snapshot-view', '--sql', "SELECT * FROM read_parquet('D:/definitely-unmanaged/*.parquet') LIMIT 1")
  Add-Result 'R7' ($guardTests.ExitCode -eq 0 -and $blockedGlob.ExitCode -ne 0 -and $blockedGlob.Output -match 'allow-unmanaged-parquet-glob') 'The unmanaged Parquet glob guard passes unit tests and blocks an unapproved raw glob.'

  $resourceTests = Invoke-Vitest @('src/research/researchScanEstimate.test.ts', 'src/research/duckdbExport.test.ts')
  Add-Result 'R8' ($resourceTests.ExitCode -eq 0 -and $help.Output -match 'max-output-files' -and $help.Output -match 'max-memory') 'Scan estimation/export tests pass and resource/output bounds are exposed by the CLI.'

  $outputTests = Invoke-Vitest @('src/research/researchOutput.test.ts', 'src/research/researchArtifactManifest.test.ts')
  $outFile = Join-Path $tempRoot 'result.csv'
  $firstExport = Invoke-Cli @('query', '--no-snapshot-view', '--sql', 'SELECT 1 AS value', '--out', $outFile)
  $secondExport = Invoke-Cli @('query', '--no-snapshot-view', '--sql', 'SELECT 2 AS value', '--out', $outFile)
  $outputs = @(Get-ChildItem -LiteralPath $tempRoot -Filter 'result*.csv')
  $partials = @(Get-ChildItem -LiteralPath $tempRoot -Filter '*.partial')
  Add-Result 'R9' ($outputTests.ExitCode -eq 0 -and $firstExport.ExitCode -eq 0 -and $secondExport.ExitCode -eq 0 -and $outputs.Count -eq 2 -and $partials.Count -eq 0) 'Atomic output/manifest tests pass; a second export preserves the first and leaves no partial file.'

  $csvPath = Join-Path $tempRoot 'source.csv'
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($csvPath, "value,label`n1,first`n", $utf8NoBom)
  $duckPath = Join-Path $tempRoot 'persistence.duckdb'
  $duckSqlPath = $duckPath.Replace('\', '/')
  $csvSqlPath = $csvPath.Replace('\', '/')
  $readerSql = "read_csv('$csvSqlPath', header=true, delim=',', columns={'value':'INTEGER','label':'VARCHAR'})"
  $created = Invoke-Cli @('query', '--no-snapshot-view', '--db', $duckSqlPath, '--sql', "CREATE TABLE frozen AS SELECT * FROM $readerSql; CREATE VIEW live AS SELECT * FROM $readerSql; SELECT 1;")
  [System.IO.File]::WriteAllText($csvPath, "value,label`n2,second`n", $utf8NoBom)
  $persisted = Invoke-Cli @('query', '--no-snapshot-view', '--db', $duckSqlPath, '--format', 'json', '--sql', 'SELECT (SELECT value FROM frozen) AS frozen, (SELECT value FROM live) AS live;')
  $persistencePassed = $created.ExitCode -eq 0 -and $persisted.ExitCode -eq 0 -and $persisted.Output -match '"frozen":\s*1' -and $persisted.Output -match '"live":\s*2'
  $persistenceEvidence = if ($persistencePassed) {
    'A materialized table remains frozen while a persisted view reads the changed source.'
  } else {
    "createExit=$($created.ExitCode); createOutput=$($created.Output.Trim()); queryExit=$($persisted.ExitCode); queryOutput=$($persisted.Output.Trim())"
  }
  Add-Result 'R10' $persistencePassed $persistenceEvidence
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    $resolvedTemp = (Resolve-Path -LiteralPath $tempRoot).Path
    $resolvedBase = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
    if ($resolvedTemp.StartsWith($resolvedBase, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedTemp -Leaf).StartsWith('local-duckdb-research-')) {
      Remove-Item -LiteralPath $resolvedTemp -Recurse -Force
    }
  }
}

$script:Results | Format-Table -AutoSize
Write-Output ("Validated {0}/{0} rules." -f $script:Results.Count)
