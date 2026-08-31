[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][string]$BaseSha,
  [Parameter(Mandatory = $true)][string]$HeadSha,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$LedgerOutputPath
)

# This is a trusted-base transport step. The comment body is untrusted data:
# it is only staged for the base-rooted verifier, which authenticates the
# receipt signature, supervisor challenge, and exact repository bindings.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($BaseSha -notmatch '^[0-9a-fA-F]{40}$' -or $HeadSha -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Receipt transport requires exact base and head SHAs.'
}

$gh = (Get-Command gh -ErrorAction Stop).Source
$raw = @(& $gh api "repos/$Repository/issues/$PR/comments?per_page=100" 2>&1 | ForEach-Object { [string]$_ })
if ($LASTEXITCODE -ne 0) { throw "Unable to read PR review handoff comments." }

$comments = $raw -join "`n" | ConvertFrom-Json
function Get-MarkedJson {
  param([object[]]$Items, [string]$Marker, [string]$RequiredBase, [string]$RequiredHead)
  $found = @()
  foreach ($item in $Items) {
    $body = [string]$item.body
    $markerIndex = $body.IndexOf($Marker, [StringComparison]::Ordinal)
    if ($markerIndex -lt 0) { continue }
    $jsonText = $body.Substring($markerIndex + $Marker.Length).Trim()
    if ($jsonText.StartsWith('```', [StringComparison]::Ordinal)) {
      $jsonText = ($jsonText -replace '^```(?:json)?\s*', '' -replace '\s*```\s*$', '').Trim()
    }
    try { $value = $jsonText | ConvertFrom-Json } catch { continue }
    $bound = if ($null -ne $value.PSObject.Properties['base_sha']) {
      [string]::Equals([string]$value.base_sha, $RequiredBase, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$value.head_sha, $RequiredHead, [StringComparison]::OrdinalIgnoreCase)
    } else {
      @($value.challenges | Where-Object {
          [string]::Equals([string]$_.base_sha, $RequiredBase, [StringComparison]::OrdinalIgnoreCase) -and
            [string]::Equals([string]$_.head_sha, $RequiredHead, [StringComparison]::OrdinalIgnoreCase)
        }).Count -gt 0
    }
    if ($bound) {
      $found += $value
    }
  }
  return @($found)
}

$outputDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OutputPath))
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$ledgerDirectory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($LedgerOutputPath))
New-Item -ItemType Directory -Path $ledgerDirectory -Force | Out-Null
$receipts = Get-MarkedJson -Items @($comments) -Marker '<!-- babel-independent-review-receipt-v2 -->' -RequiredBase $BaseSha -RequiredHead $HeadSha
$ledgers = Get-MarkedJson -Items @($comments) -Marker '<!-- babel-independent-review-challenge-ledger-v1 -->' -RequiredBase $BaseSha -RequiredHead $HeadSha
if ($receipts.Count -eq 1) {
  $receipts[0] | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
} else {
  # Preserve a deterministic, verifier-visible failure instead of choosing
  # between multiple receipts or silently treating transport as successful.
  [ordered]@{
    transport_error = if ($receipts.Count -eq 0) { 'receipt_handoff_missing' } else { 'receipt_handoff_ambiguous' }
    repository = $Repository
    pr_number = $PR
    base_sha = $BaseSha
    head_sha = $HeadSha
  } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $OutputPath -Encoding utf8NoBOM
}
if ($ledgers.Count -eq 1) {
  $ledgers[0] | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $LedgerOutputPath -Encoding utf8NoBOM
} else {
  [ordered]@{
    transport_error = if ($ledgers.Count -eq 0) { 'challenge_ledger_handoff_missing' } else { 'challenge_ledger_handoff_ambiguous' }
    repository = $Repository
    pr_number = $PR
    base_sha = $BaseSha
    head_sha = $HeadSha
  } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $LedgerOutputPath -Encoding utf8NoBOM
}
