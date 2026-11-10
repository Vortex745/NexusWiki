$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$PSNativeCommandUseErrorActionPreference = $false

$SkillRoot = $PSScriptRoot
$RepoRoot = (Resolve-Path (Join-Path $SkillRoot "..\..\..")).Path
$ModelDir = Join-Path $SkillRoot "model"
$Probe = Join-Path $SkillRoot "probe\retire_inflight_probe.ts"
$JarSha = "936A262061C914694DFD669A543BE24573C45D5AA0FF20A8B96B23D01E050E88"
$JarUrls = @(
  "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
  "https://repo1.maven.org/maven2/org/tlaplus/tla2tools/1.7.4/tla2tools-1.7.4.jar"
)

function Resolve-TlaJar {
  $candidates = @()
  if ($env:TLA2TOOLS) { $candidates += $env:TLA2TOOLS }
  $cache = Join-Path $env:LOCALAPPDATA "nexuswiki-verify\tla2tools-1.7.4.jar"
  $candidates += $cache
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path) {
      $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
      if ($hash -ieq $JarSha) { return $path }
      throw "TLA+ jar hash mismatch at $path. Expected $JarSha, found $hash"
    }
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cache) | Out-Null
  $downloaded = $false
  foreach ($url in $JarUrls) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $cache
      $downloaded = $true
      break
    } catch {
      Write-Host "TLA+ jar download failed from $url"
    }
  }
  if (-not $downloaded) { throw "Could not download tla2tools 1.7.4" }
  $hash = (Get-FileHash -LiteralPath $cache -Algorithm SHA256).Hash
  if ($hash -ine $JarSha) { throw "Downloaded TLA+ jar hash mismatch" }
  return $cache
}

function Invoke-Tlc {
  param([string]$Config, [string]$Name)
  $log = Join-Path $env:TEMP "ingestion-retirement-$Name.log"
  $meta = Join-Path $env:TEMP "ingestion-retirement-$Name-states"
  $tlcArgs = @("-XX:+UseParallelGC", "-cp", $script:Jar, "tlc2.TLC", "-config", $Config, "-cleanup", "-metadir", $meta)
  $tlcArgs += "IngestionRetirement.tla"
  Push-Location $ModelDir
  try {
    & java @tlcArgs *> $log
    return @{ Exit = $LASTEXITCODE; Log = $log; Text = Get-Content -LiteralPath $log -Raw }
  } finally {
    Pop-Location
  }
}

$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch "^v24\.") {
  throw "Use Node 24 for the installed better-sqlite3 binding. Found $nodeVersion"
}
$script:Jar = Resolve-TlaJar
$guards = Invoke-Tlc -Config "guards.cfg" -Name "repair"
if ($guards.Exit -ne 0 -or $guards.Text -match "Error:") {
  Write-Host "FAIL repaired model. Trace $($guards.Log)"
  Write-Host $guards.Text
  exit 1
}
$counts = [regex]::Match($guards.Text, "[\d,]+ states generated, [\d,]+ distinct states found, 0 states left on queue\.").Value
if (-not $counts) { throw "TLC did not report exhaustive model completion" }
Write-Host "PASS repaired model. $counts"

$baselineTemplate = Get-Content -LiteralPath (Join-Path $ModelDir "findings.cfg") -Raw
$expected = @("NoCompleteAfterRetire", "NoActivateAfterRetire", "NoWriteAfterCleanup", "CleanupDoesNotOvertakeWrite")
foreach ($invariant in $expected) {
  $config = Join-Path $env:TEMP "ingestion-retirement-negative-$invariant.cfg"
  $negativeConfig = [regex]::Replace($baselineTemplate, "(?s)INVARIANTS.*", "INVARIANT $invariant")
  [System.IO.File]::WriteAllText($config, $negativeConfig, (New-Object System.Text.UTF8Encoding($false)))
  $baseline = Invoke-Tlc -Config $config -Name "negative-$invariant"
  if ($baseline.Exit -eq 0 -or $baseline.Text -notmatch "Error: Invariant $invariant is violated\." -or $baseline.Text -match "unexpected exception") {
    Write-Host "FAIL model negative control for $invariant. Trace $($baseline.Log)"
    exit 1
  }
  Write-Host "PASS model negative control rejects baseline for $invariant. Trace $($baseline.Log)"
}
Write-Host "Repair trace $($guards.Log)"

Push-Location $RepoRoot
try {
  $probeLog = Join-Path $env:TEMP "ingestion-retirement-code-probe.log"
  & node --import tsx --import ./scripts/test-env.ts $Probe *> $probeLog
  $probeExit = $LASTEXITCODE
} finally {
  Pop-Location
}
$probeText = Get-Content -LiteralPath $probeLog -Raw
Write-Host $probeText
$reported = @([regex]::Matches($probeText, '(?m)^\{"scenario":"([^"]+)","verdict":"pass"') |
  ForEach-Object { $_.Groups[1].Value })
$scenarios = @("control", "pending", "before-stages", "inside-write", "before-completion", "transient", "direct-activation")
$missingScenarios = @($scenarios | Where-Object { $_ -notin $reported })
if ($probeExit -ne 0 -or $reported.Count -ne $scenarios.Count -or $missingScenarios.Count -gt 0) {
  Write-Host "FAIL real-code retirement repair probe. Trace $probeLog"
  exit 1
}
Write-Host "PASS seven real-code scenarios. Exit zero means the retirement repair holds."
exit 0
