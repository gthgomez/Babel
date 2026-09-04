[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][string]$BaseSha,
  [Parameter(Mandatory = $true)][string]$HeadSha,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

# Trusted-base transport step. PR comment bodies are untrusted data: this
# script only stages marked JSON documents for the base-rooted merge gate,
# which authenticates signatures and exact repository bindings. It never
# decides authority. Full pagination is mandatory: the valid document may sit
# on any comment page.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($BaseSha -notmatch '^[0-9a-fA-F]{40}$' -or $HeadSha -notmatch '^[0-9a-fA-F]{40}$') {
  throw 'Evidence transport requires exact base and head SHAs.'
}

$gh = (Get-Command gh -ErrorAction Stop).Source
$comments = @()
$page = 1
while ($true) {
  $raw = @(& $gh api "repos/$Repository/issues/$PR/comments?per_page=100&page=$page" 2>&1 | ForEach-Object { [string]$_ })
  if ($LASTEXITCODE -ne 0) { throw "Unable to read PR evidence comments: $($raw -join ' ')" }
  $pageComments = ($raw -join "`n") | ConvertFrom-Json
  $comments += @($pageComments)
  if (@($pageComments).Count -lt 100) { break }
  $page++
}

$kinds = @(
  @{ Name = 'receipt'; Marker = '<!-- babel-independent-review-receipt-v2 -->'; File = 'receipt.json' },
  @{ Name = 'challenge-ledger'; Marker = '<!-- babel-independent-review-challenge-ledger-v1 -->'; File = 'ledger.json' },
  @{ Name = 'autonomous-review'; Marker = '<!-- babel-autonomous-review-evidence-v1 -->'; File = 'ai-review.json' },
  @{ Name = 'trust-root-upgrade'; Marker = '<!-- babel-trust-root-upgrade-authorization-v1 -->'; File = 'trust-upgrade.json' }
)

New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null

function Test-DocumentBound {
  param([object]$Document, [string]$RequiredBase, [string]$RequiredHead)
  if ($null -eq $Document) { return $false }
  if ($null -ne $Document.PSObject.Properties['base_sha'] -and $null -ne $Document.PSObject.Properties['head_sha']) {
    return [string]::Equals([string]$Document.base_sha, $RequiredBase, [StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals([string]$Document.head_sha, $RequiredHead, [StringComparison]::OrdinalIgnoreCase)
  }
  if ($null -ne $Document.PSObject.Properties['challenges']) {
    foreach ($challenge in @($Document.challenges)) {
      if ([string]::Equals([string]$challenge.base_sha, $RequiredBase, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$challenge.head_sha, $RequiredHead, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    }
  }
  return $false
}

foreach ($kind in $kinds) {
  $distinct = @{}
  $boundCount = 0
  foreach ($comment in $comments) {
    $body = [string]$comment.body
    $markerIndex = $body.IndexOf($kind.Marker, [StringComparison]::Ordinal)
    if ($markerIndex -lt 0) { continue }
    $jsonText = $body.Substring($markerIndex + $kind.Marker.Length).Trim()
    if ($jsonText.StartsWith('```', [StringComparison]::Ordinal)) {
      $jsonText = ($jsonText -replace '^```(?:json)?\s*', '' -replace '\s*```\s*$', '').Trim()
    }
    try { $value = $jsonText | ConvertFrom-Json } catch { continue }
    if (-not (Test-DocumentBound -Document $value -RequiredBase $BaseSha -RequiredHead $HeadSha)) { continue }
    $boundCount++
    # Distinctness is decided on the exact transported JSON text: whitespace
    # differences are treated as distinct documents and fail closed downstream.
    $distinct[$jsonText] = $true
  }

  $target = Join-Path $EvidenceDirectory $kind.File
  if ($distinct.Count -eq 1) {
    Set-Content -LiteralPath $target -Value (@($distinct.Keys)[0]) -Encoding utf8NoBOM
  } else {
    [ordered]@{
      transport_error = if ($distinct.Count -eq 0) { "$($kind.Name)_handoff_missing" } else { "$($kind.Name)_handoff_ambiguous" }
      repository = $Repository
      pr_number = $PR
      base_sha = $BaseSha
      head_sha = $HeadSha
      bound_documents_observed = $boundCount
      distinct_documents_observed = $distinct.Count
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $target -Encoding utf8NoBOM
  }
}

Write-Output "EVIDENCE_TRANSPORT_STAGED pr=$PR base=$BaseSha head=$HeadSha comments=$(@($comments).Count)"
