# License: Apache-2.0
<#
.SYNOPSIS
Release preparation for Babel (docs/guides/RELEASE.md "Release Process", item 1).

.DESCRIPTION
Implements the release-preparation half of the documented release policy:

  1. Runs the full public release validation gates (tools/validate-public-release.ps1 -Strict).
  2. Bumps the version in babel-cli/package.json and babel-desktop/package.json
     (and optionally prompt_catalog.yaml with -CatalogVersion).
  3. Folds the CHANGELOG.md [Unreleased] section into [x.y.z] - <date> when present.
  4. Leaves tagging MANUAL: prints the exact annotated-tag and push commands.
     Tags are annotated per policy and protected by the repository ruleset;
     this script never creates or pushes them.

The version bump and CHANGELOG edit are left as uncommitted working-tree
changes for human review; nothing is committed or pushed automatically.

.PARAMETER Version
Target version in the form vX.Y.Z or X.Y.Z (pre-release labels not supported
by this script; see RELEASE.md for the tag format).

.PARAMETER Root
Repository root. Defaults to the directory containing this script's parent.

.PARAMETER CatalogVersion
Optional new integer version for prompt_catalog.yaml (bump only when the
catalog schema/content changes with this release).

.PARAMETER SkipValidation
Skip tools/validate-public-release.ps1. Intended only for dry inspection of
the bump logic; a real release run must never skip validation.

.EXAMPLE
pwsh tools/release.ps1 -Version v0.1.1
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$Root = '',
  [int]$CatalogVersion = -1,
  [switch]$SkipValidation
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
} else {
  $Root = (Resolve-Path $Root).Path
}

$Version = $Version.TrimStart('v')
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "Version must be X.Y.Z (got '$Version'). Pre-release labels are not supported by this script; see docs/guides/RELEASE.md."
}

function Read-JsonVersion([string]$Path) {
  $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  return [string]$json.version
}

$cliPkg = Join-Path $Root 'babel-cli/package.json'
$desktopPkg = Join-Path $Root 'babel-desktop/package.json'
$catalog = Join-Path $Root 'prompt_catalog.yaml'
$changelog = Join-Path $Root 'CHANGELOG.md'

foreach ($path in @($cliPkg, $desktopPkg, $catalog, $changelog)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Required file missing: $path" }
}

# --- 1. Release validation gates -------------------------------------------
if (-not $SkipValidation) {
  if ([string]::IsNullOrWhiteSpace($env:BABEL_PRIVATE_SCRUB_POLICY_PATH)) {
    throw @"
BABEL_PRIVATE_SCRUB_POLICY_PATH is not set. The maintainer pre-merge rule
(AGENTS.md) requires the supplemental scrub policy for validate-public-release
-Strict. Set it to the approved supplemental policy path and re-run, or run
with -SkipValidation only to inspect the version bump logic (never for a real
release).
"@
  }
  $validator = Join-Path $Root 'tools/validate-public-release.ps1'
  & $validator -Root $Root -Strict -SupplementalPolicyPath $env:BABEL_PRIVATE_SCRUB_POLICY_PATH -RequireSupplementalPolicy
  if ($LASTEXITCODE -ne 0) { throw "Public release validation failed; aborting release preparation." }
}

# --- 2. Version bumps --------------------------------------------------------
$currentCli = Read-JsonVersion $cliPkg
$currentDesktop = Read-JsonVersion $desktopPkg
if ($currentCli -eq $Version -and $currentDesktop -eq $Version) {
  Write-Host "Both packages already at $Version; nothing to bump."
} else {
  Write-Host "Version bump: babel-cli $currentCli -> $Version; babel-desktop $currentDesktop -> $Version"
}

foreach ($pair in @(@($cliPkg, $currentCli), @($desktopPkg, $currentDesktop))) {
  $path = $pair[0]; $current = $pair[1]
  if ($current -eq $Version) { continue }
  $text = Get-Content -LiteralPath $path -Raw
  # Replace only the top-level "version" field (first occurrence, line-level).
  # Braced group refs: "$1" + a version starting with a digit would otherwise
  # parse as group $1<digit> (e.g. $10).
  $updated = $text -replace "(?m)^(\s*""version""\s*:\s*"")$([regex]::Escape($current))("")", "`${1}$Version`${2}"
  if ($updated -eq $text) { throw "Failed to bump version in $path (current version string not found)." }
  Set-Content -LiteralPath $path -Value $updated -NoNewline
  # JSON sanity check.
  $null = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

if ($CatalogVersion -ge 0) {
  $catalogText = Get-Content -LiteralPath $catalog -Raw
  $updatedCatalog = $catalogText -replace '(?m)^version: \d+', "version: $CatalogVersion"
  if ($updatedCatalog -eq $catalogText) { throw "Failed to bump prompt_catalog.yaml version field." }
  Set-Content -LiteralPath $catalog -Value $updatedCatalog -NoNewline
  Write-Host "prompt_catalog.yaml version -> $CatalogVersion"
}

# --- 3. CHANGELOG fold --------------------------------------------------------
$today = (Get-Date).ToString('yyyy-MM-dd')
$changelogText = Get-Content -LiteralPath $changelog -Raw
$pattern = '(?m)^## (\[)?Unreleased(\])?\r?\n'
if ($changelogText -match $pattern) {
  $updatedChangelog = $changelogText -replace $pattern, "## [$Version] - $today`n`n"
  Set-Content -LiteralPath $changelog -Value $updatedChangelog -NoNewline
  Write-Host "CHANGELOG.md: [Unreleased] folded into [$Version] - $today"
} else {
  Write-Host "CHANGELOG.md has no [Unreleased] section; left untouched (release notes are authored on the GitHub Release)."
}

# --- 4. Manual tagging instructions (policy: tagging stays manual) ------------
$sha = (& git -C $Root rev-parse HEAD).Trim()
Write-Host ""
Write-Host "Release preparation complete. Review the working-tree changes, then commit:"
Write-Host "  git add babel-cli/package.json babel-desktop/package.json $(if ($CatalogVersion -ge 0) { 'prompt_catalog.yaml ' })CHANGELOG.md"
Write-Host "  git commit -m `"chore(release): v$Version`""
Write-Host ""
Write-Host "Then tag (annotated only, per docs/guides/RELEASE.md) and push:"
Write-Host "  git tag -a v$Version -m `"Babel v$Version`" $sha"
Write-Host "  git push origin v$Version"
Write-Host ""
Write-Host "The v* tag push triggers .github/workflows/release.yml, which builds the"
Write-Host "Windows portable bundle and opens a DRAFT GitHub Release for owner review."
