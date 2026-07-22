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

$tracked = @(& git -C $RepoRoot ls-files)
if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed; canonical independence requires a Git worktree.' }
foreach ($relativePath in $tracked) {
  $relative = $relativePath.Replace('\', '/')
  if (Test-IsExcluded $relative) { continue }
  if (-not (@($config.scan_extensions) -contains [IO.Path]::GetExtension($relative).ToLowerInvariant())) { continue }
  $full = Join-Path $RepoRoot $relative
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
  $lineNumber = 0
  foreach ($line in Get-Content -LiteralPath $full) {
    $lineNumber++
    foreach ($rule in @($config.rules)) {
      if ([string]$line -match [string]$rule.pattern -and -not (Test-IsTemporarilyExcepted ([string]$rule.id) $relative ([string]$line))) {
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
