[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$PolicyPath = '',
  [ValidateSet('human', 'json')]
  [string]$OutputFormat = 'human',
  [switch]$WarningsAsErrors
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
$commonModule = Join-Path $RepoRoot 'tools/security/tracked-scan-common.psm1'
if (-not (Test-Path -LiteralPath $commonModule -PathType Leaf)) { throw "Tracked scan module not found: $commonModule" }
Import-Module -Name $commonModule -Force

function Get-PCONT007Classification {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line,
    [Parameter(Mandatory = $true)]$Policy
  )
  $certaintySpans = @([regex]::Matches($Line, [string]$Policy.absolute_claim.pattern))
  if ($certaintySpans.Count -eq 0) {
    return [pscustomobject]@{ classification = 'none'; spans = @(); unqualified_spans = @() }
  }

  $qualifiedSpans = @()
  foreach ($pattern in @($Policy.absolute_claim.qualified_patterns)) {
    if ([string]::IsNullOrWhiteSpace([string]$pattern)) { continue }
    $qualifiedSpans += @([regex]::Matches($Line, [string]$pattern))
  }
  $isAmbiguous = $false
  foreach ($pattern in @($Policy.absolute_claim.ambiguous_context_patterns)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$pattern) -and $Line -match [string]$pattern) {
      $isAmbiguous = $true
      break
    }
  }

  $spans = @()
  $unqualifiedSpans = @()
  foreach ($span in $certaintySpans) {
    $spanEnd = $span.Index + $span.Length
    $qualified = $false
    foreach ($qualifiedSpan in $qualifiedSpans) {
      $qualifiedEnd = $qualifiedSpan.Index + $qualifiedSpan.Length
      if ($span.Index -ge $qualifiedSpan.Index -and $spanEnd -le $qualifiedEnd) {
        $qualified = $true
        break
      }
    }
    $spanClassification = if ($qualified) { 'qualified_limitation' } elseif ($isAmbiguous) { 'ambiguous_certainty_claim' } else { 'clear_unsupported_claim' }
    $detail = [pscustomobject]@{
      text = $span.Value
      index = $span.Index
      length = $span.Length
      classification = $spanClassification
      qualified = $qualified
    }
    $spans += $detail
    if (-not $qualified) { $unqualifiedSpans += $detail }
  }
  $classification = if ($unqualifiedSpans.Count -eq 0) { 'qualified_limitation' } elseif (@($unqualifiedSpans | Where-Object classification -eq 'clear_unsupported_claim').Count -gt 0) { 'clear_unsupported_claim' } else { 'ambiguous_certainty_claim' }
  return [pscustomobject]@{ classification = $classification; spans = $spans; unqualified_spans = $unqualifiedSpans }
}

function Test-PCONT007SpanAllowlisted {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line,
    [Parameter(Mandatory = $true)]$Span,
    [Parameter(Mandatory = $true)]$Policy
  )
  foreach ($entry in @($Policy.absolute_claim.allowlist)) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.rationale) -or [string]::IsNullOrWhiteSpace([string]$entry.evidence)) { continue }
    if ($Path -notlike [string]$entry.path) { continue }
    foreach ($allowSpan in @([regex]::Matches($Line, [string]$entry.pattern))) {
      $allowEnd = $allowSpan.Index + $allowSpan.Length
      $spanEnd = $Span.Index + $Span.Length
      if ($Span.Index -ge $allowSpan.Index -and $spanEnd -le $allowEnd) { return $true }
    }
  }
  return $false
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
  foreach ($record in @($inventory.records)) {
    [pscustomobject]@{ Relative = $record.path; Full = $record.full_path; Extension = $record.extension; Lines = $record.lines }
  }
}

$findings = @()
$warnings = @()
$pc007Diagnostics = @{}
function Add-Finding {
  param([string]$Id, [string]$Category, [string]$Path, [int]$Line, [string]$Severity = 'error')
  $entry = [pscustomobject]@{ id = $Id; category = $Category; path = $Path; line = $Line; severity = $Severity }
  if ($WarningsAsErrors -or $Severity -eq 'error') {
    $script:findings += $entry
  } else {
    $script:warnings += $entry
  }
}
$validBinaryAllowlist = @()
foreach ($entry in @($policy.binary_asset_allowlist)) {
  if (($entry.PSObject.Properties.Name -contains 'path') -and ($entry.PSObject.Properties.Name -contains 'sha256') -and
      ($entry.PSObject.Properties.Name -contains 'rationale') -and -not [string]::IsNullOrWhiteSpace([string]$entry.path) -and [string]$entry.sha256 -match '^[0-9a-fA-F]{64}$' -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.rationale)) { $validBinaryAllowlist += $entry }
  else { Add-Finding -Id 'PCFG003' -Category 'invalid-binary-asset-allowlist' -Path 'tools/security/public-content-policy.json' -Line 0 }
}
$validGeneratedAllowlist = @()
foreach ($entry in @($policy.generated_artifact_allowlist)) {
  if (@('path','producer','sanitization','regeneration','rationale' | Where-Object { $entry.PSObject.Properties.Name -notcontains $_ }).Count -eq 0 -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.path) -and -not [string]::IsNullOrWhiteSpace([string]$entry.producer) -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.sanitization) -and -not [string]::IsNullOrWhiteSpace([string]$entry.regeneration) -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.rationale)) { $validGeneratedAllowlist += $entry }
  else { Add-Finding -Id 'PCFG004' -Category 'invalid-generated-artifact-allowlist' -Path 'tools/security/public-content-policy.json' -Line 0 }
}
$inventory = Get-TrackedScanInventory -RepoRoot $RepoRoot -BinaryAllowlist @($validBinaryAllowlist)
foreach ($issue in @($inventory.issues)) { Add-Finding -Id 'PCONT010' -Category ("unscannable-tracked-file:{0}" -f $issue.reason) -Path $issue.path -Line 0 }
foreach ($record in @($inventory.records)) {
  $normalizedPath = ([string]$record.path).Replace('\', '/').TrimStart('/')
  $forbiddenExact = @($policy.forbidden_public_paths) -contains $normalizedPath
  $forbiddenPrefix = $false
  foreach ($prefix in @($policy.forbidden_public_path_prefixes)) {
    if ($normalizedPath.StartsWith([string]$prefix, [StringComparison]::OrdinalIgnoreCase)) { $forbiddenPrefix = $true; break }
  }
  if ($forbiddenExact -or $forbiddenPrefix) {
    Add-Finding -Id 'PCONT013' -Category 'forbidden-public-document-path' -Path $record.path -Line 0
  }
}
foreach ($record in @($inventory.records)) {
  foreach ($pattern in @($policy.forbidden_generated_path_patterns)) {
    if ($record.path -match [string]$pattern) {
      $allowed = @($validGeneratedAllowlist | Where-Object {
        $_.path -eq $record.path -and -not [string]::IsNullOrWhiteSpace([string]$_.producer) -and
        -not [string]::IsNullOrWhiteSpace([string]$_.sanitization) -and -not [string]::IsNullOrWhiteSpace([string]$_.regeneration) -and
        -not [string]::IsNullOrWhiteSpace([string]$_.rationale)
      }).Count -gt 0
      if (-not $allowed) { Add-Finding -Id 'PCONT011' -Category 'forbidden-or-undeclared-generated-artifact' -Path $record.path -Line 0 }
      break
    }
  }
}

$validTemporaryExceptions = @()
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
  if ($isValid) { $validTemporaryExceptions += $entry }
  else { Add-Finding -Id 'PCFG001' -Category 'invalid-temporary-exception' -Path 'tools/security/public-content-policy.json' -Line 0 }
}
function Test-IsTemporarilyExcepted {
  param([string]$RuleId, [string]$Path, [string]$Line)
  foreach ($entry in $validTemporaryExceptions) {
    if ([string]$entry.rule_id -eq $RuleId -and $Path -like [string]$entry.path -and $Line -match [string]$entry.pattern) { return $true }
  }
  return $false
}
$validFixtureExceptions = @()
foreach ($entry in @($policy.fixture_exceptions)) {
  if (-not [string]::IsNullOrWhiteSpace([string]$entry.id) -and -not [string]::IsNullOrWhiteSpace([string]$entry.rule_id) -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.path) -and -not [string]::IsNullOrWhiteSpace([string]$entry.pattern) -and
      -not [string]::IsNullOrWhiteSpace([string]$entry.rationale)) { $validFixtureExceptions += $entry }
  else { Add-Finding -Id 'PCFG002' -Category 'invalid-fixture-exception' -Path 'tools/security/public-content-policy.json' -Line 0 }
}

$titles = @{}
foreach ($file in @(Get-TrackedActiveFiles)) {
  $lines = @($file.Lines)
  $isHistorical = Test-IsExcluded $file.Relative
  $hasTitle = $false
  for ($index = 0; $index -lt $lines.Count; $index++) {
    $line = [string]$lines[$index]
    $lineNumber = $index + 1
    foreach ($rule in @($policy.rules)) {
      $severity = if ($rule.PSObject.Properties.Name -contains 'severity' -and [string]$rule.severity -eq 'warning') { 'warning' } else { 'error' }
      $excepted = (Test-IsTemporarilyExcepted -RuleId ([string]$rule.id) -Path $file.Relative -Line $line) -or
        (Test-PolicyException -Exceptions @($validFixtureExceptions) -RuleId ([string]$rule.id) -Path $file.Relative -Line $line)
      if (-not $isHistorical -and $line -match [string]$rule.pattern -and -not $excepted) {
        Add-Finding -Id ([string]$rule.id) -Category ([string]$rule.category) -Path $file.Relative -Line $lineNumber -Severity $severity
      }
    }

    if (-not $isHistorical -and @($policy.claim_extensions) -contains $file.Extension) {
      $pc007 = Get-PCONT007Classification -Line $line -Policy $policy
      $unallowedSpans = @($pc007.unqualified_spans | Where-Object { -not (Test-PCONT007SpanAllowlisted -Path $file.Relative -Line $line -Span $_ -Policy $policy) })
      if ($unallowedSpans.Count -gt 0) {
        $pc007Diagnostics["{0}:{1}" -f $file.Relative, $lineNumber] = [pscustomobject]@{
          classification = if (@($unallowedSpans | Where-Object classification -eq 'clear_unsupported_claim').Count -gt 0) { 'clear_unsupported_claim' } else { 'ambiguous_certainty_claim' }
          matched = @($unallowedSpans | ForEach-Object { $_.text })
        }
        Add-Finding -Id ([string]$policy.absolute_claim.id) -Category ([string]$policy.absolute_claim.category) -Path $file.Relative -Line $lineNumber
      }
    }

    if (-not $isHistorical -and $file.Extension -eq '.md') {
      if (-not $hasTitle -and $line -match '^#\s+(.+?)\s*$') {
        $titleKey = $Matches[1].Trim().ToLowerInvariant() -replace '\s+', ' '
        if (-not $titles.ContainsKey($titleKey)) { $titles[$titleKey] = @() }
        $titles[$titleKey] = @($titles[$titleKey]) + @([pscustomobject]@{ Path = $file.Relative; Line = $lineNumber })
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

$errors = @($findings | Sort-Object path, line, id -Unique)
$warnOrdered = @($warnings | Sort-Object path, line, id -Unique)
$allOrdered = @($errors + $warnOrdered | Sort-Object severity, path, line, id)
$resultStatus = if ($errors.Count -eq 0 -and $warnOrdered.Count -eq 0) { 'pass' } elseif ($errors.Count -eq 0) { 'warn' } else { 'fail' }
$result = [ordered]@{ status = $resultStatus; findings = $allOrdered }
if ($OutputFormat -eq 'json') {
  $result | ConvertTo-Json -Depth 8
} else {
  if ($errors.Count -gt 0) {
    Write-Host 'Public content policy errors:' -ForegroundColor Red
    $errors | ForEach-Object {
      $detail = if ($_.id -eq 'PCONT007') { $pc007Diagnostics["{0}:{1}" -f $_.path, $_.line] } else { $null }
      if ($detail) {
        Write-Host ("  {0} [{1}] {2}:{3} ({4}; matched: {5})" -f $_.id, $_.category, $_.path, $_.line, $detail.classification, ($detail.matched -join ', '))
        Write-Host '    Rewrite with evidence-scoped language; qualified limitations such as "does not establish" are permitted.'
      } else {
        Write-Host ("  {0} [{1}] {2}:{3}" -f $_.id, $_.category, $_.path, $_.line)
      }
    }
  }
  if ($warnOrdered.Count -gt 0) {
    Write-Host 'Public content policy warnings:' -ForegroundColor Yellow
    $warnOrdered | ForEach-Object { Write-Host ("  {0} [{1}] {2}:{3}" -f $_.id, $_.category, $_.path, $_.line) }
  }
  if ($errors.Count -eq 0 -and $warnOrdered.Count -eq 0) {
    Write-Host 'Public content policy passed.' -ForegroundColor Green
  }
}
if ($errors.Count -gt 0) { exit 1 }
exit 0
