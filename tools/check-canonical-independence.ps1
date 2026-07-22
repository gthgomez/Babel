[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$PolicyPath = '',
  [ValidateSet('human', 'json')]
  [string]$OutputFormat = 'human'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($PolicyPath)) { $PolicyPath = Join-Path $RepoRoot 'tools/security/public-content-policy.json' }
if (-not (Test-Path -LiteralPath $PolicyPath -PathType Leaf)) { throw "Canonical independence policy not found: $PolicyPath" }
try { $policy = Get-Content -Raw -LiteralPath $PolicyPath | ConvertFrom-Json } catch { throw "Canonical independence policy is malformed: $PolicyPath" }
$config = $policy.canonical_independence
$commonModule = Join-Path $RepoRoot 'tools/security/tracked-scan-common.ps1'
if (-not (Test-Path -LiteralPath $commonModule -PathType Leaf)) { throw "Tracked scan module not found: $commonModule" }
. $commonModule

$findings = [Collections.Generic.List[object]]::new()
function Add-Finding([string]$Id, [string]$Category, [string]$Path, [int]$Line) {
  $findings.Add([pscustomobject]@{ id = $Id; category = $Category; path = $Path; line = $Line })
}
$validTemporaryExceptions = [Collections.Generic.List[object]]::new()
foreach ($entry in @($config.temporary_exceptions)) {
  $requiredMetadata = @('id', 'rule_id', 'path', 'pattern', 'rationale', 'evidence', 'expires', 'replacement_pr')
  $isValid = $true
  foreach ($name in $requiredMetadata) {
    if (-not ($entry.PSObject.Properties.Name -contains $name) -or [string]::IsNullOrWhiteSpace([string]$entry.$name)) { $isValid = $false }
  }
  $expiry = [datetime]::MinValue
  if ($isValid) {
    if (-not [datetime]::TryParseExact([string]$entry.expires, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$expiry)) { $isValid = $false }
    elseif ($expiry.Date -lt [datetime]::UtcNow.Date) { $isValid = $false }
  }
  if ($isValid) { $validTemporaryExceptions.Add($entry) }
  else { Add-Finding 'CCFG001' 'invalid-temporary-exception' 'tools/security/public-content-policy.json' 0 }
}
function Test-IsTemporarilyExcepted([string]$RuleId, [string]$Path, [string]$Line) {
  foreach ($entry in $validTemporaryExceptions) {
    if ([string]$entry.rule_id -eq $RuleId -and $Path -like [string]$entry.path -and $Line -match [string]$entry.pattern) { return $true }
  }
  return $false
}
$validFixtureExceptions = [Collections.Generic.List[object]]::new()
foreach ($entry in @($config.fixture_exceptions)) {
  if (-not [string]::IsNullOrWhiteSpace([string]$entry.id) -and -not [string]::IsNullOrWhiteSpace([string]$entry.rule_id) -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.path) -and -not [string]::IsNullOrWhiteSpace([string]$entry.pattern) -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.rationale)) { $validFixtureExceptions.Add($entry) }
  else { Add-Finding 'CCFG002' 'invalid-fixture-exception' 'tools/security/public-content-policy.json' 0 }
}
$validBinaryAllowlist = [Collections.Generic.List[object]]::new()
foreach ($entry in @($config.binary_asset_allowlist)) {
  if (($entry.PSObject.Properties.Name -contains 'path') -and ($entry.PSObject.Properties.Name -contains 'sha256') -and
      ($entry.PSObject.Properties.Name -contains 'rationale') -and -not [string]::IsNullOrWhiteSpace([string]$entry.path) -and [string]$entry.sha256 -match '^[0-9a-fA-F]{64}$' -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.rationale)) { $validBinaryAllowlist.Add($entry) }
  else { Add-Finding 'CCFG003' 'invalid-binary-asset-allowlist' 'tools/security/public-content-policy.json' 0 }
}
function Test-IsExcluded([string]$Path) {
  $normalized = $Path.Replace('\', '/')
  if (@($config.excluded_paths) -contains $normalized) { return $true }
  foreach ($prefix in @($config.excluded_path_prefixes)) {
    if ($normalized.StartsWith([string]$prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

foreach ($required in @($config.required_startup_files)) {
  if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot ([string]$required)) -PathType Leaf)) {
    Add-Finding 'CANON000' 'missing-mandatory-startup-reference' ([string]$required) 0
  }
}

$inventory = Get-TrackedScanInventory -RepoRoot $RepoRoot -BinaryAllowlist @($validBinaryAllowlist)
foreach ($issue in @($inventory.issues)) { Add-Finding 'CANON004' ("unscannable-tracked-file:{0}" -f $issue.reason) $issue.path 0 }
foreach ($record in @($inventory.records)) {
  $relative = $record.path
  if (Test-IsExcluded $relative) { continue }
  $lineNumber = 0
  foreach ($line in @($record.lines)) {
    $lineNumber++
    foreach ($rule in @($config.rules)) {
      $excepted = (Test-IsTemporarilyExcepted ([string]$rule.id) $relative ([string]$line)) -or
        (Test-PolicyException -Exceptions @($validFixtureExceptions) -RuleId ([string]$rule.id) -Path $relative -Line ([string]$line))
      if ([string]$line -match [string]$rule.pattern -and -not $excepted) {
        Add-Finding ([string]$rule.id) ([string]$rule.category) $relative $lineNumber
      }
    }
  }
}

$ordered = @($findings | Sort-Object path, line, id -Unique)
$result = [ordered]@{ status = $(if ($ordered.Count -eq 0) { 'pass' } else { 'fail' }); findings = $ordered }
if ($OutputFormat -eq 'json') { $result | ConvertTo-Json -Depth 8 }
elseif ($ordered.Count -eq 0) { Write-Host 'Canonical independence check passed.' -ForegroundColor Green }
else {
  Write-Host 'Canonical independence findings:' -ForegroundColor Yellow
  $ordered | ForEach-Object { Write-Host ("{0} [{1}] {2}:{3}" -f $_.id, $_.category, $_.path, $_.line) }
}
if ($ordered.Count -gt 0) { exit 1 }
exit 0
