<# .SYNOPSIS
Local CI simulation — runs build, typecheck, and tests inside a Linux Docker
container so results match GitHub Actions before you push.

.DESCRIPTION
Pulls node:22-alpine (cached after first run), mounts the repo, and executes:
  1. npm ci
  2. npm run build
  3. npm test (with optional --update-snapshots)

Produces structured JSON output for the ci-dry-run skill to interpret.

.PARAMETER Quick
Build + typecheck only; skip tests.

.PARAMETER Snapshots
Run tests with --update-snapshots to regenerate for Linux target.

.PARAMETER KeepContainer
Do not remove the container after the run (for debugging).

.EXAMPLE
pwsh tools/ci-dry-run.ps1
# Full CI simulation: build + test.

.EXAMPLE
pwsh tools/ci-dry-run.ps1 -Quick
# Build and typecheck only.

.EXAMPLE
pwsh tools/ci-dry-run.ps1 -Snapshots
# Run tests and auto-update snapshots for Linux parity.
#>
[CmdletBinding()]
param(
    [switch]$Quick,
    [switch]$Snapshots,
    [switch]$KeepContainer
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
$Root = (Resolve-Path (Join-Path $scriptDir "..")).Path

# ── Docker prerequisite ─────────────────────────────────────────────────────
$dockerCheck = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Docker is not running or not installed. Start Docker Desktop and retry."
    Write-Host "  Install: https://docs.docker.com/desktop/setup/install/windows-install/"
    exit 2
}

# ── Image check ─────────────────────────────────────────────────────────────
$image = "node:22-alpine"
Write-Host "Checking Docker image $image..." -ForegroundColor Cyan
$imageCheck = docker images -q $image 2>&1
if (-not $imageCheck) {
    Write-Host "Pulling $image (one-time, ~50 MB)..." -ForegroundColor Yellow
    docker pull $image
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to pull Docker image $image"
        exit 2
    }
}

# ── Build script ────────────────────────────────────────────────────────────
$scriptBlock = @'
set -e
cd /workspace/babel-cli

echo "=== INSTALL ==="
npm ci

echo "=== BUILD ==="
npm run build

if [ "$QUICK_MODE" != "true" ]; then
  echo "=== TEST ==="
  if [ "$UPDATE_SNAPSHOTS" = "true" ]; then
    npm test -- --update-snapshots 2>&1
  else
    npm test 2>&1
  fi
fi

echo "=== PASS ==="
'@

$scriptPath = Join-Path $env:TEMP "babel-ci-dry-run.sh"
$scriptBlock | Set-Content -Path $scriptPath -Encoding UTF8 -NoNewline

$envFlags = @()
if ($Quick) { $envFlags += "-e"; $envFlags += "QUICK_MODE=true" }
if ($Snapshots) { $envFlags += "-e"; $envFlags += "UPDATE_SNAPSHOTS=true" }

$containerName = "babel-ci-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

Write-Host "`nRunning CI simulation in Docker..." -ForegroundColor Cyan
Write-Host "  Mode: $(
    if ($Quick) { "Quick (build only)" }
    elseif ($Snapshots) { "Snapshots (tests with --update-snapshots)" }
    else { "Full (build + test)" }
)" -ForegroundColor Cyan

# Convert Windows path to something Docker can mount
$mountPath = $Root -replace '\\', '/'
$mountPath = "/$($mountPath.Substring(0, 1).ToLowerInvariant())$($mountPath.Substring(2))"

$dockerArgs = @(
    "run", "--rm",
    "--name", $containerName,
    "-v", "${mountPath}:/workspace",
    "-v", "$($scriptPath -replace '\\', '/'):/tmp/babel-ci-run.sh",
    "-w", "/workspace"
) + $envFlags + @(
    $image,
    "sh", "/tmp/babel-ci-run.sh"
)

$start = Get-Date
$output = & docker @dockerArgs 2>&1
$exitCode = $LASTEXITCODE
$elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)

# Clean up temp script
Remove-Item $scriptPath -Force -ErrorAction SilentlyContinue

# ── Output interpretation ───────────────────────────────────────────────────
if ($exitCode -eq 0 -and $output -match "=== PASS ===") {
    $status = "GREEN"
    $summary = if ($Quick) {
        "Build and typecheck passed (${elapsed}s)"
    } elseif ($Snapshots) {
        "Tests passed, snapshots updated for Linux target (${elapsed}s)"
    } else {
        "Build, typecheck, and tests all passed (${elapsed}s)"
    }
} elseif ($Snapshots -and $exitCode -ne 0 -and $output -match "snapshots? (written|updated|changed)") {
    $status = "YELLOW"
    $summary = "Tests completed, snapshots auto-updated (${elapsed}s). Review snapshot diff before committing."
} else {
    $status = "RED"
    $summary = "CI simulation FAILED (${elapsed}s). See output above for errors."
}

$result = [PSCustomObject]@{
    Status    = $status
    Summary   = $summary
    Elapsed   = "${elapsed}s"
    ExitCode  = $exitCode
    Timestamp = (Get-Date -Format "o")
    Output    = if ($output) { ($output -join "`n") } else { "" }
}

# ── Display ─────────────────────────────────────────────────────────────────
Write-Host ""
$color = @{ GREEN = "Green"; YELLOW = "Yellow"; RED = "Red" }[$status]
Write-Host "━━━ CI Dry-Run: $status ━━━" -ForegroundColor $color
Write-Host "  $summary" -ForegroundColor $color

if ($status -eq "YELLOW") {
    Write-Host "`nNext steps:" -ForegroundColor Yellow
    Write-Host "  1. Review: git diff babel-cli/src/**/__snapshots__/" -ForegroundColor Yellow
    Write-Host "  2. If expected: git add ... && git commit -m 'test: regenerate snapshots for CI parity'" -ForegroundColor Yellow
    Write-Host "  3. If surprising: investigate the diff before pushing" -ForegroundColor Yellow
}

if ($status -eq "RED") {
    Write-Host "`nFix the errors above before pushing. Re-run to confirm." -ForegroundColor Red
}

# Return structured result on stdout for consumption
$result | ConvertTo-Json -Depth 3

exit $exitCode
