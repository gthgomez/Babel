#!/usr/bin/env pwsh
# Agent PR evidence - build, gate-validate, and transport AUTONOMOUS-tier
# review evidence for a Babel pull request.
#
# Eliminates the per-PR ritual of hand-building autonomous_review_evidence_v1
# JSON: this script derives every binding from live inputs, validates the
# document with the merge gate's own module (scripts/agent-pr-gate-common.psm1
# - the same validator and numstat-digest function CI runs), posts it as the
# marker-delimited PR comment the base-rooted evidence transport expects, and
# optionally retriggers the gate (close + reopen) so a fresh
# pull_request_target run re-materializes evidence at execution time.
#
# The tool never weakens the gate: it refuses to transport evidence with a
# verdict other than APPROVE, refuses non-empty blocking findings, refuses a
# reviewer that matches the builder identity, and fails closed before posting
# if the gate-identical validation reports any error.
#
# Same-head re-runs are idempotent: if the only existing bound comment carries
# an equivalent document (all fields equal except reviewed_at, which stamps
# the build time), the tool skips. If the document differs, the tool refuses
# by default; -Replace edits that one bound comment in place, which keeps the
# transport unambiguous (never two distinct bound documents for one head).
#
# Usage:
#   pwsh scripts/agent-pr-evidence.ps1 -PR 147 -ReviewerId <id> `
#     -Scope @('Full diff <base>...<head> ...') [-Findings @('...')] `
#     [-Retrigger] [-WhatIfOnly] [-Replace]
#
# Offline/test mode: -WhatIfOnly with explicit -BaseSha/-HeadSha/-Repository
# performs no gh call at all and writes the exact comment body to -OutFile.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$ReviewerId,
  [string]$Repository = '',
  [string]$ReviewerClass = 'isolated_readonly_ai_reviewer',
  [string]$ReviewMode = 'diff_audit',
  [ValidateSet('APPROVE')][string]$Verdict = 'APPROVE',
  [Parameter(Mandatory = $true)][string[]]$Scope,
  [string[]]$Findings = @(),
  [string[]]$BlockingFindings = @(),
  [string]$BuilderId = 'codex-implementation',
  [string]$BaseSha = '',
  [string]$HeadSha = '',
  [string]$RepoRoot = (Get-Location).Path,
  [switch]$Retrigger,
  [switch]$Replace,
  [switch]$WhatIfOnly,
  [string]$OutFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Marker = '<!-- babel-autonomous-review-evidence-v1 -->'

function Write-AgentEvidenceFail {
  param([string[]]$Errors)
  Write-Output ([pscustomobject][ordered]@{
    ok = $false; posted = $false; errors = @($Errors)
  } | ConvertTo-Json -Depth 6)
  exit 1
}

function Get-AgentEvidenceRepository {
  param([string]$Requested)
  if ($Requested) { return $Requested }
  $url = & git -C $RepoRoot remote get-url origin 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$url)) {
    throw 'Unable to resolve repository: pass -Repository or configure the origin remote.'
  }
  $text = [string]$url -replace '\.git$', ''
  if ($text -match 'github\.com[/:](.+/.+)$') { return $Matches[1] }
  throw "Unrecognized origin remote format: $text"
}

# Resolves base/head/isDraft. In live mode one gh call fills any missing SHA
# and enforces the draft check; in WhatIfOnly mode with both SHAs supplied no
# gh call happens at all (hermetic path).
function Get-AgentEvidenceRefs {
  $needMeta = (-not $BaseSha) -or (-not $HeadSha) -or (-not $WhatIfOnly)
  if (-not $needMeta) {
    return [pscustomobject]@{ base = $BaseSha; head = $HeadSha; isDraft = $false }
  }
  $json = (& gh pr view $PR -R $ResolvedRepository --json baseRefOid,headRefOid,isDraft) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'gh pr view failed; cannot resolve PR base/head/draft state.' }
  $meta = $json | ConvertFrom-Json
  $resolvedBase = if ($BaseSha) { $BaseSha } else { [string]$meta.baseRefOid }
  $resolvedHead = if ($HeadSha) { $HeadSha } else { [string]$meta.headRefOid }
  return [pscustomobject]@{ base = $resolvedBase; head = $resolvedHead; isDraft = [bool]$meta.isDraft }
}

# --- Preconditions that must hold before anything is transported ------------

$preErrors = @()
if (@($BlockingFindings).Count -gt 0) {
  $preErrors += 'blocking_findings_must_be_empty - repair findings, re-review, then post evidence'
}
if (@($Scope | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -eq 0) {
  $preErrors += 'scope_must_contain_at_least_one_nonempty_entry'
}
if ([string]::Equals($ReviewerId, $BuilderId, [StringComparison]::OrdinalIgnoreCase)) {
  $preErrors += 'reviewer_must_differ_from_builder_identity'
}
if ($preErrors.Count -gt 0) { Write-AgentEvidenceFail -Errors $preErrors }

$ResolvedRepository = Get-AgentEvidenceRepository -Requested $Repository
$refs = Get-AgentEvidenceRefs
if (-not ($refs.base -match '^[0-9a-fA-F]{40}$') -or -not ($refs.head -match '^[0-9a-fA-F]{40}$')) {
  Write-AgentEvidenceFail -Errors @('base_or_head_sha_unavailable_or_malformed')
}
if ($refs.isDraft) {
  Write-AgentEvidenceFail -Errors @('pr_is_draft - mark ready before transporting evidence (NO_DRAFT gate)')
}

# --- Gate-identical digest + validation (imports the gate module) ----------

$gateModulePath = Join-Path $PSScriptRoot 'agent-pr-gate-common.psm1'
Import-Module $gateModulePath -Force -DisableNameChecking

$numstatResult = & git -C $RepoRoot diff --numstat "$($refs.base)...$($refs.head)"
if ($LASTEXITCODE -ne 0) {
  Write-AgentEvidenceFail -Errors @('autonomous_review_numstat_unavailable - fetch the SHAs into this checkout or point -RepoRoot at one that has them')
}
if (@($numstatResult).Count -eq 0) {
  Write-AgentEvidenceFail -Errors @('diff_is_empty_between_base_and_head - nothing to attach review evidence to')
}
$expectedDigest = Get-AgentNumstatDigest -NumstatLines @($numstatResult)

$evidence = [ordered]@{
  schema_version      = '1'
  kind                = 'autonomous_review_evidence_v1'
  repository          = $ResolvedRepository
  pr_number           = $PR
  base_sha            = $refs.base
  head_sha            = $refs.head
  reviewer_id         = $ReviewerId
  reviewer_class      = $ReviewerClass
  review_mode         = $ReviewMode
  reviewed_at         = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  scope               = [string[]]@($Scope)
  findings            = [string[]]@($Findings)
  blocking_findings   = [string[]]@()
  verdict             = $Verdict
  builder_id          = $BuilderId
  diff_numstat_digest = $expectedDigest
}

$validation = Test-AgentAutonomousReviewEvidence `
  -Evidence ([pscustomobject]$evidence) `
  -Repository $ResolvedRepository -PR $PR `
  -BaseSha $refs.base -HeadSha $refs.head `
  -BuilderIdentity $BuilderId -ExpectedNumstatDigest $expectedDigest
if (-not $validation.valid) {
  Write-AgentEvidenceFail -Errors @($validation.errors)
}

$body = $Marker + "`n" + (($evidence | ConvertTo-Json -Depth 10) -replace "`r`n", "`n") + "`n"
if ($OutFile) {
  Set-Content -LiteralPath $OutFile -Value $body -NoNewline -Encoding utf8NoBOM
}

if ($WhatIfOnly) {
  Write-Output ([pscustomobject][ordered]@{
    ok = $true; posted = $false; what_if = $true
    repository = $ResolvedRepository; pr = $PR
    base = $refs.base; head = $refs.head
    diff_numstat_digest = $expectedDigest
    errors = @()
  } | ConvertTo-Json -Depth 6)
  exit 0
}

# --- Transport --------------------------------------------------------------
# One distinct bound document per base/head is transportable; more fails the
# transport closed as *_handoff_ambiguous downstream. reviewed_at is excluded
# from the equivalence check: it stamps the build time, so a genuine re-run of
# the same review compares equal and skips.

$commentsJson = & gh pr view $PR -R $ResolvedRepository --json comments
if ($LASTEXITCODE -ne 0) { throw 'gh pr view (comments) failed; transport state unknown - refusing to post.' }
$comments = (($commentsJson -join "`n") | ConvertFrom-Json).comments

$bound = @()
foreach ($comment in $comments) {
  $text = [string]$comment.body
  $markerIndex = $text.IndexOf($Marker, [StringComparison]::Ordinal)
  if ($markerIndex -lt 0) { continue }
  $jsonText = $text.Substring($markerIndex + $Marker.Length).Trim()
  if ($jsonText.StartsWith('```')) {
    $jsonText = ($jsonText -replace '^```(?:json)?\s*', '' -replace '\s*```\s*$', '').Trim()
  }
  try { $doc = $jsonText | ConvertFrom-Json } catch { continue }
  if ([string]$doc.base_sha -eq $refs.base -and [string]$doc.head_sha -eq $refs.head) {
    $restCommentId = if ([string]$comment.url -match 'issuecomment-(\d+)') { $Matches[1] } else { '' }
    $bound += [pscustomobject]@{ id = $restCommentId; body = $text; doc = $doc }
  }
}

function Test-AgentEvidenceEquivalent {
  param($ExistingDoc, [System.Collections.Specialized.OrderedDictionary]$NewEvidence)
  $left = $ExistingDoc.PSObject.Properties | ForEach-Object { $_ }
  $leftNames = @($left | ForEach-Object { $_.Name } | Where-Object { $_ -ne 'reviewed_at' })
  $rightNames = @($NewEvidence.Keys | Where-Object { $_ -ne 'reviewed_at' })
  if (($leftNames | Sort-Object) -join "`n" -ne (($rightNames | Sort-Object) -join "`n")) { return $false }
  foreach ($name in $leftNames) {
    $leftValue = ($left | Where-Object { $_.Name -eq $name }).Value
    $rightValue = $NewEvidence[$name]
    if ((ConvertTo-Json $leftValue -Depth 10 -Compress) -ne (ConvertTo-Json $rightValue -Depth 10 -Compress)) { return $false }
  }
  return $true
}

function Invoke-AgentEvidenceRetrigger {
  & gh pr close $PR -R $ResolvedRepository | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gh pr close failed during retrigger.' }
  & gh pr reopen $PR -R $ResolvedRepository | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gh pr reopen failed during retrigger; REOPEN THE PR MANUALLY - it is currently closed.' }
  return $true
}

if ($bound.Count -eq 1) {
  if (Test-AgentEvidenceEquivalent -ExistingDoc $bound[0].doc -NewEvidence $evidence) {
    $retriggered = if ($Retrigger) { Invoke-AgentEvidenceRetrigger } else { $false }
    Write-Output ([pscustomobject][ordered]@{
      ok = $true; posted = $false; idempotent_skip = $true; retriggered = $retriggered
      comment_id = $bound[0].id
      repository = $ResolvedRepository; pr = $PR
      base = $refs.base; head = $refs.head
      diff_numstat_digest = $expectedDigest; errors = @()
    } | ConvertTo-Json -Depth 6)
    exit 0
  }
  if ($Replace) {
    if ([string]::IsNullOrWhiteSpace($bound[0].id)) {
      Write-AgentEvidenceFail -Errors @('existing_bound_evidence_comment_id_unavailable_for_replace')
    }
    & gh api "repos/$ResolvedRepository/issues/comments/$($bound[0].id)" -X PATCH -f "body=$body" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'gh api comment PATCH failed.' }
    $retriggered = if ($Retrigger) { Invoke-AgentEvidenceRetrigger } else { $false }
    Write-Output ([pscustomobject][ordered]@{
      ok = $true; posted = $true; replaced = $true; retriggered = $retriggered; comment_id = $bound[0].id
      repository = $ResolvedRepository; pr = $PR
      base = $refs.base; head = $refs.head
      diff_numstat_digest = $expectedDigest; errors = @()
    } | ConvertTo-Json -Depth 6)
    exit 0
  }
  Write-AgentEvidenceFail -Errors @(
    "existing_bound_evidence_differs_for_same_head (comment $($bound[0].id)) - review the difference; re-run with -Replace to edit that single bound comment in place"
  )
}
if ($bound.Count -gt 1) {
  Write-AgentEvidenceFail -Errors @(
    'multiple_distinct_bound_evidence_comments_exist - the transport would fail closed as ambiguous; consolidate manually before posting'
  )
}

$tmp = New-TemporaryFile
try {
  Set-Content -LiteralPath $tmp -Value $body -NoNewline -Encoding utf8NoBOM
  $commentUrl = (& gh pr comment $PR -R $ResolvedRepository --body-file $tmp)
  if ($LASTEXITCODE -ne 0) { throw 'gh pr comment failed.' }
} finally {
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}
$commentId = if ([string]$commentUrl -match 'issuecomment-(\d+)') { $Matches[1] } else { '' }

$retriggered = if ($Retrigger) { Invoke-AgentEvidenceRetrigger } else { $false }

Write-Output ([pscustomobject][ordered]@{
  ok = $true; posted = $true; retriggered = $retriggered
  comment_id = $commentId
  repository = $ResolvedRepository; pr = $PR
  base = $refs.base; head = $refs.head
  diff_numstat_digest = $expectedDigest; errors = @()
} | ConvertTo-Json -Depth 6)
