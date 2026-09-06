#!/usr/bin/env pwsh
# Agent PR evidence — build, gate-validate, and transport AUTONOMOUS-tier
# review evidence for a Babel pull request.
#
# Eliminates the per-PR ritual of hand-building autonomous_review_evidence_v1
# JSON: this script derives every binding from live inputs, validates the
# document with the merge gate's own module (scripts/agent-pr-gate-common.psm1
# — the same validator and numstat-digest function CI runs), posts it as the
# marker-delimited PR comment the base-rooted evidence transport expects, and
# optionally retriggers the gate (close + reopen) so a fresh
# pull_request_target run re-materializes evidence at execution time.
#
# The tool never weakens the gate: it refuses to transport evidence with a
# verdict other than APPROVE, refuses non-empty blocking findings, refuses a
# reviewer that matches the builder identity, and fails closed before posting
# if the gate-identical validation reports any error.
#
# Usage:
#   pwsh scripts/agent-pr-evidence.ps1 -PR 147 -ReviewerId <id> `
#     -Scope @('Full diff <base>...<head> ...') [-Findings @('...')] `
#     [-Retrigger] [-WhatIfOnly]
#
# Offline/test mode: pass -BaseSha/-HeadSha/-Repository and -WhatIfOnly to
# build and validate without any gh call (writes the exact comment body to
# -OutFile when given).

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
  $url = (& git -C $RepoRoot remote get-url origin 2>$null)
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace([string]$url)) {
    throw 'Unable to resolve repository: pass -Repository or configure the origin remote.'
  }
  $text = [string]$url -replace '\.git$', ''
  if ($text -match 'github\.com[/:](.+/.+)$') { return $Matches[1] }
  throw "Unrecognized origin remote format: $text"
}

function Get-AgentEvidenceRefs {
  if ($BaseSha -and $HeadSha) {
    return [pscustomobject]@{ base = $BaseSha; head = $HeadSha }
  }
  $json = (& gh pr view $PR -R $ResolvedRepository --json baseRefOid,headRefOid,isDraft) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'gh pr view failed; cannot resolve PR base/head.' }
  $pr = $json | ConvertFrom-Json
  if (-not $BaseSha) { $script:resolvedBase = [string]$pr.baseRefOid } else { $script:resolvedBase = $BaseSha }
  if (-not $HeadSha) { $script:resolvedHead = [string]$pr.headRefOid } else { $script:resolvedHead = $HeadSha }
  return [pscustomobject]@{ base = $script:resolvedBase; head = $script:resolvedHead; isDraft = [bool]$pr.isDraft }
}

# --- Preconditions that must hold before anything is transported ------------

$preErrors = @()
if (@($BlockingFindings).Count -gt 0) {
  $preErrors += 'blocking_findings_must_be_empty — repair findings, re-review, then post evidence'
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
if ($refs.PSObject.Properties['isDraft'] -and $refs.isDraft -and -not $WhatIfOnly) {
  Write-AgentEvidenceFail -Errors @('pr_is_draft — mark ready before transporting evidence (NO_DRAFT gate)')
}

# --- Gate-identical digest + validation (imports the gate module) ----------

$gateModulePath = Join-Path $PSScriptRoot 'agent-pr-gate-common.psm1'
Import-Module $gateModulePath -Force -DisableNameChecking

$numstatResult = & git -C $RepoRoot diff --numstat "$($refs.base)...$($refs.head)"
if ($LASTEXITCODE -ne 0) {
  Write-AgentEvidenceFail -Errors @('autonomous_review_numstat_unavailable — fetch the SHAs into this checkout or point -RepoRoot at one that has them')
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

# --- Transport (skipped under -WhatIfOnly) ---------------------------------

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

# One distinct bound document per base/head is transportable; more fails the
# transport closed as *_handoff_ambiguous. Keep the same-head case idempotent:
# identical body -> skip; different body -> replace in place (with -Replace)
# or refuse.
$commentsJson = (& gh pr view $PR -R $ResolvedRepository --json comments) -join "`n"
$comments = ($commentsJson | ConvertFrom-Json).comments
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
    $bound += [pscustomobject]@{ id = [string]$comment.id; body = $text; json = $jsonText }
  }
}

if ($bound.Count -eq 1) {
  $normalizedExisting = ([pscustomobject](($bound[0].json | ConvertFrom-Json) ) | ConvertTo-Json -Depth 10 -Compress)
  $normalizedNew = ([pscustomobject]$evidence | ConvertTo-Json -Depth 10 -Compress)
  if ($normalizedExisting -eq $normalizedNew) {
    Write-Output ([pscustomobject][ordered]@{
      ok = $true; posted = $false; idempotent_skip = $true
      comment_id = $bound[0].id
      repository = $ResolvedRepository; pr = $PR
      base = $refs.base; head = $refs.head
      diff_numstat_digest = $expectedDigest; errors = @()
    } | ConvertTo-Json -Depth 6)
    exit 0
  }
  Write-AgentEvidenceFail -Errors @(
    "existing_bound_evidence_differs_for_same_head (comment $($bound[0].id)) — review the change; re-run with -Replace to edit that comment in place"
  )
}
if ($bound.Count -gt 1) {
  Write-AgentEvidenceFail -Errors @(
    'multiple_distinct_bound_evidence_comments_exist — the transport would fail closed as ambiguous; consolidate manually before posting'
  )
}

$tmp = New-TemporaryFile
try {
  Set-Content -LiteralPath $tmp -Value $body -NoNewline -Encoding utf8NoBOM
  (& gh pr comment $PR -R $ResolvedRepository --body-file $tmp) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gh pr comment failed.' }
} finally {
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}

$retriggered = $false
if ($Retrigger) {
  (& gh pr close $PR -R $ResolvedRepository) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gh pr close failed during retrigger.' }
  (& gh pr reopen $PR -R $ResolvedRepository) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'gh pr reopen failed during retrigger; REOPEN THE PR MANUALLY — it is currently closed.' }
  $retriggered = $true
}

Write-Output ([pscustomobject][ordered]@{
  ok = $true; posted = $true; retriggered = $retriggered
  repository = $ResolvedRepository; pr = $PR
  base = $refs.base; head = $refs.head
  diff_numstat_digest = $expectedDigest; errors = @()
} | ConvertTo-Json -Depth 6)
