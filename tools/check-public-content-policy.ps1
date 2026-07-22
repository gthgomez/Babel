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
if ([string]::IsNullOrWhiteSpace($PolicyPath)) {
  $PolicyPath = Join-Path $RepoRoot 'tools/security/public-content-policy.json'
}
if (-not (Test-Path -LiteralPath $PolicyPath -PathType Leaf)) {
  throw "Public content policy not found: $PolicyPath"
}
try {
  $policy = Get-Content -Raw -LiteralPath $PolicyPath | ConvertFrom-Json
} catch {
  throw "Public content policy is malformed: $PolicyPath"
}

function Convert-ToRelativePath {
  param([string]$Path)
  $rootWithSeparator = $RepoRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  $rootUri = [Uri]$rootWithSeparator
  $pathUri = [Uri]$Path
  return [Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace('\', '/')
}

function Test-IsExcluded {
  param([string]$RelativePath)
  $normalized = $RelativePath.Replace('\', '/').TrimStart('/')
  if (@($policy.excluded_paths) -contains $normalized) { return $true }
  foreach ($prefix in @($policy.excluded_path_prefixes)) {
    if ($normalized.StartsWith([string]$prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Get-TrackedActiveFiles {
  $paths = @(& git -C $RepoRoot ls-files)
  if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed; the content policy requires a Git worktree.' }
  foreach ($relative in $paths) {
    $normalized = $relative.Replace('\', '/')
    if (Test-IsExcluded $normalized) { continue }
    $extension = [IO.Path]::GetExtension($normalized).ToLowerInvariant()
    if (-not (@($policy.active_extensions) -contains $extension)) { continue }
    $fullPath = Join-Path $RepoRoot $normalized
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
      [pscustomobject]@{ Relative = $normalized; Full = $fullPath; Extension = $extension }
    }
  }
}

$findings = [Collections.Generic.List[object]]::new()
function Add-Finding {
  param([string]$Id, [string]$Category, [string]$Path, [int]$Line)
  $findings.Add([pscustomobject]@{ id = $Id; category = $Category; path = $Path; line = $Line })
}

$validTemporaryExceptions = [Collections.Generic.List[object]]::new()
foreach ($entry in @($policy.temporary_exceptions)) {
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
  else { Add-Finding -Id 'PCFG001' -Category 'invalid-temporary-exception' -Path 'tools/security/public-content-policy.json' -Line 0 }
}
function Test-IsTemporarilyExcepted {
  param([string]$RuleId, [string]$Path, [string]$Line)
  foreach ($entry in $validTemporaryExceptions) {
    if ([string]$entry.rule_id -eq $RuleId -and $Path -like [string]$entry.path -and $Line -match [string]$entry.pattern) { return $true }
  }
  return $false
}

$titles = @{}
foreach ($file in @(Get-TrackedActiveFiles)) {
  $lines = @(Get-Content -LiteralPath $file.Full -ErrorAction Stop)
  $hasTitle = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $line = [string]$lines[$index]
    $lineNumber = $index + 1
    foreach ($rule in @($policy.rules)) {
      if ($line -match [string]$rule.pattern -and -not (Test-IsTemporarilyExcepted -RuleId ([string]$rule.id) -Path $file.Relative -Line $line)) {
        Add-Finding -Id ([string]$rule.id) -Category ([string]$rule.category) -Path $file.Relative -Line $lineNumber
      }
    }

    if (@($policy.claim_extensions) -contains $file.Extension -and $line -match [string]$policy.absolute_claim.pattern) {
      $allowed = $false
      foreach ($entry in @($policy.absolute_claim.allowlist)) {
        if ([string]::IsNullOrWhiteSpace([string]$entry.rationale) -or [string]::IsNullOrWhiteSpace([string]$entry.evidence)) { continue }
        if ($file.Relative -like [string]$entry.path -and $line -match [string]$entry.pattern) { $allowed = $true; break }
      }
      if (-not $allowed) {
        Add-Finding -Id ([string]$policy.absolute_claim.id) -Category ([string]$policy.absolute_claim.category) -Path $file.Relative -Line $lineNumber
      }
    }

    if ($file.Extension -eq '.md') {
      if (-not $hasTitle -and $line -match '^#\s+(.+?)\s*$') {
        $titleKey = $Matches[1].Trim().ToLowerInvariant() -replace '\s+', ' '
        if (-not $titles.ContainsKey($titleKey)) { $titles[$titleKey] = [Collections.Generic.List[object]]::new() }
        $titles[$titleKey].Add([pscustomobject]@{ Path = $file.Relative; Line = $lineNumber })
        $hasTitle = $true
      }
      foreach ($match in [regex]::Matches($line, '!?(?<!\\)\[[^\]]*\]\(([^)]+)\)')) {
        $target = $match.Groups[1].Value.Trim()
        if ($target.StartsWith('<') -and $target.Contains('>')) { $target = $target.Substring(1, $target.IndexOf('>') - 1) }
        else { $target = ($target -split '\s+"', 2)[0] }
        if (-not $target -or $target -match '^(?i)(https?://|mailto:|tel:|#|data:)') { continue }
        $target = ($target -split '#', 2)[0]
        $target = ($target -split '\?', 2)[0]
        if (-not $target) { continue }
        try { $target = [Uri]::UnescapeDataString($target) } catch { }
        $candidate = Join-Path (Split-Path -Parent $file.Full) $target
        if (-not (Test-Path -LiteralPath $candidate)) {
          Add-Finding -Id ([string]$policy.markdown_link.id) -Category ([string]$policy.markdown_link.category) -Path $file.Relative -Line $lineNumber
        }
      }
    }
  }
}

foreach ($entry in $titles.GetEnumerator()) {
  if ($entry.Value.Count -gt 1) {
    foreach ($location in $entry.Value) {
      Add-Finding -Id ([string]$policy.duplicate_title.id) -Category ([string]$policy.duplicate_title.category) -Path $location.Path -Line $location.Line
    }
  }
}

$ordered = @($findings | Sort-Object path, line, id -Unique)
$result = [ordered]@{ status = $(if ($ordered.Count -eq 0) { 'pass' } else { 'fail' }); findings = $ordered }
if ($OutputFormat -eq 'json') {
  $result | ConvertTo-Json -Depth 8
} elseif ($ordered.Count -eq 0) {
  Write-Host 'Public content policy passed.' -ForegroundColor Green
} else {
  Write-Host 'Public content policy findings:' -ForegroundColor Yellow
  $ordered | ForEach-Object { Write-Host ("{0} [{1}] {2}:{3}" -f $_.id, $_.category, $_.path, $_.line) }
}
if ($ordered.Count -gt 0) { exit 1 }
exit 0
