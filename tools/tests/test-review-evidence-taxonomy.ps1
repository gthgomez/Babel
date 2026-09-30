#!/usr/bin/env pwsh
# Focused regression suite for the independent-review transport taxonomy.
#
# The gate distinguishes why the latest owner handoff does not certify the
# requested base/head:
#   - no owner marker comment for this PR     -> independent_review_handoff_not_published
#   - owner marker for a different base/head   -> independent_review_stale_for_head
#   - malformed latest owner marker            -> host_review_handoff_malformed
# It also checks the disposition mapping and the human-readable summary helper.
#
# These are classification/message changes only: every non-null transport_error
# must still produce a failing disposition, and a binding marker must still win.
#
# The functions under test live in agent-pr-gate-common.psm1, which dot-sources
# agent-review-evidence.ps1. Select-AgentHostReviewBundle is exported and
# resolves Get-AgentPropertyValue inside the module scope, so importing the
# module is sufficient. A tiny local property reader is used to read returned
# PSCustomObjects without tripping StrictMode.

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\..\scripts\agent-pr-gate-common.psm1') -Force

function Assert-Taxonomy {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

# Local shim: the module intentionally does not export Get-AgentPropertyValue.
function Get-TaxonomyProperty {
  param([AllowNull()][object]$Object, [Parameter(Mandatory = $true)][string]$Name)
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

$markerV3 = '<!-- babel-controller-independent-review-v3 -->'

function New-OwnerMarkerComment {
  param(
    [Parameter(Mandatory = $true)][int]$Id,
    [string]$Repository = 'gthgomez/Babel',
    [int]$PR = 152,
    [string]$BaseSha = ('b' * 40),
    [string]$HeadSha = ('a' * 40),
    [string]$Marker = '<!-- babel-controller-independent-review-v3 -->',
    [string]$Body = '',
    [string]$UserType = 'User',
    [string]$UserId = '91163862',
    [string]$IssueUrl = ''
  )
  if ([string]::IsNullOrEmpty($Body)) {
    $handoff = [pscustomobject][ordered]@{
      schema_version = 3; kind = 'host_review_handoff_v3'
      repository = $Repository; pr_number = $PR; base_sha = $BaseSha; head_sha = $HeadSha
      candidate_digest = ('c' * 64); diff_numstat_digest = ('d' * 64)
      task_id = 'task-152'; task_hash = ('e' * 64); controller_run_id = 'run-152'; reviews = @()
    }
    $Body = $Marker + "`n" + ($handoff | ConvertTo-Json -Depth 20)
  }
  $url = if ([string]::IsNullOrEmpty($IssueUrl)) { "https://api.github.com/repos/$Repository/issues/$PR" } else { $IssueUrl }
  return [pscustomobject][ordered]@{
    id = $Id
    user = [pscustomobject][ordered]@{ id = $UserId; type = $UserType }
    body = $Body
    issue_url = $url
  }
}

$repo = 'gthgomez/Babel'
$pr = 152
$base = 'b' * 40
$head = 'a' * 40
$otherHead = 'f' * 40

try {
  # --- Selection taxonomy ----------------------------------------------------
  $selected = Select-AgentHostReviewBundle -Comments @(New-OwnerMarkerComment -Id 10 -Body 'a plain owner comment without a marker') -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'independent_review_handoff_not_published') "no marker must report handoff_not_published (got '$((Get-TaxonomyProperty $selected 'transport_error'))')"

  $selected = Select-AgentHostReviewBundle -Comments @() -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'independent_review_handoff_not_published') 'no comments must report handoff_not_published'

  $staleHead = New-OwnerMarkerComment -Id 20 -HeadSha $otherHead
  $selected = Select-AgentHostReviewBundle -Comments @($staleHead) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'independent_review_stale_for_head') "same PR but different head must report stale_for_head (got '$((Get-TaxonomyProperty $selected 'transport_error'))')"

  $staleBase = New-OwnerMarkerComment -Id 21 -BaseSha ('9' * 40)
  $selected = Select-AgentHostReviewBundle -Comments @($staleBase) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'independent_review_stale_for_head') 'same PR but different base must report stale_for_head'

  $otherPr = New-OwnerMarkerComment -Id 22 -PR 999 -IssueUrl 'https://api.github.com/repos/gthgomez/Babel/issues/999'
  $selected = Select-AgentHostReviewBundle -Comments @($otherPr) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'independent_review_handoff_not_published') 'marker for another PR must be not_published, not stale'

  $otherRepo = New-OwnerMarkerComment -Id 23 -Repository 'someone/fork' -IssueUrl 'https://api.github.com/repos/someone/fork/issues/152'
  $selected = Select-AgentHostReviewBundle -Comments @($otherRepo) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'independent_review_handoff_not_published') 'marker for another repository must be not_published, not stale'

  $malformedLatest = New-OwnerMarkerComment -Id 30 -Body ($markerV3 + "`n{ not valid json")
  $selected = Select-AgentHostReviewBundle -Comments @($malformedLatest) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'host_review_handoff_malformed') "malformed latest owner marker must report handoff_malformed (got '$((Get-TaxonomyProperty $selected 'transport_error'))')"

  $incomplete = New-OwnerMarkerComment -Id 31 -Body ($markerV3 + "`n" + (@{ schema_version = 3 } | ConvertTo-Json))
  $selected = Select-AgentHostReviewBundle -Comments @($incomplete) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'host_review_handoff_malformed') 'owner marker missing bound fields must report handoff_malformed'

  # --- Binding marker still wins --------------------------------------------
  $binding = New-OwnerMarkerComment -Id 40
  $selected = Select-AgentHostReviewBundle -Comments @($binding) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'kind') -eq 'github_host_review_bundle_v3') 'an exactly binding marker must still return a bundle'
  Assert-Taxonomy ($null -eq (Get-TaxonomyProperty $selected 'transport_error')) 'a binding bundle must not carry a transport_error'

  # A newer stale marker must not displace an older exact-head marker: the gate
  # keeps accepting the comment that actually binds the reviewed head.
  $newerStale = New-OwnerMarkerComment -Id 60 -HeadSha $otherHead
  $olderBinding = New-OwnerMarkerComment -Id 50
  $selected = Select-AgentHostReviewBundle -Comments @($olderBinding, $newerStale) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'kind') -eq 'github_host_review_bundle_v3') 'an older exact-head marker must still win over a newer stale marker'

  # A malformed latest marker still blocks reuse of an older approval.
  $newerMalformed = New-OwnerMarkerComment -Id 80 -Body ($markerV3 + "`n{ not valid json")
  $selected = Select-AgentHostReviewBundle -Comments @($olderBinding, $newerMalformed) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'transport_error') -eq 'host_review_handoff_malformed') 'a malformed latest marker must still block reuse of an older approval'

  # Other authors cannot poison the owner round, so a non-owner marker is ignored.
  $foreignAuthor = New-OwnerMarkerComment -Id 70 -UserId '12345' -HeadSha $otherHead
  $selected = Select-AgentHostReviewBundle -Comments @($foreignAuthor, $binding) -Repository $repo -PR $pr -BaseSha $base -HeadSha $head -PublisherId '91163862'
  Assert-Taxonomy ((Get-TaxonomyProperty $selected 'kind') -eq 'github_host_review_bundle_v3') 'a non-owner marker must not affect owner selection'

  # --- Transport-error disposition mapping ----------------------------------
  Assert-Taxonomy ((Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ transport_error = 'independent_review_stale_for_head' })) -eq 'autonomous_review_evidence_stale_for_head') 'stale transport must map to a distinct failure disposition'
  Assert-Taxonomy ((Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ transport_error = 'independent_review_handoff_not_published' })) -eq 'autonomous_review_evidence_handoff_not_published') 'not-published transport must map to a distinct failure disposition'
  Assert-Taxonomy ((Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ transport_error = 'independent_ai_review_handoff_missing' })) -eq 'autonomous_review_evidence_missing') 'legacy missing transport must keep its old disposition'
  Assert-Taxonomy ((Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ transport_error = 'host_review_handoff_malformed' })) -eq 'autonomous_review_evidence_missing') 'legacy malformed transport must keep its old disposition'
  Assert-Taxonomy ((Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ transport_error = 'autonomous_review_evidence_handoff_ambiguous' })) -eq 'autonomous_review_evidence_ambiguous') 'legacy ambiguous transport must keep its old disposition'
  Assert-Taxonomy ((Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ transport_error = 'unknown_future_error' })) -eq 'autonomous_review_evidence_missing') 'unknown transport errors must still fail closed through the default disposition'
  Assert-Taxonomy ($null -eq (Get-AgentEvidenceTransportError -Document ([pscustomobject]@{ other = 'value' }))) 'a document without a transport_error must not be a failure'

  # --- Human-readable summary ------------------------------------------------
  $summary = Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $false -RequiredChecksGreen $true -RequiredCheckCount 5 -EvidenceErrors @('autonomous_review_evidence_stale_for_head')
  Assert-Taxonomy ($summary -like 'Implementation CI is green. Waiting for exact-head final independent certification.*') 'summary must state CI is green and certification is pending'
  Assert-Taxonomy ($summary -match 'different base/head') 'summary must name the specific stale reason'

  $summary = Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $false -RequiredChecksGreen $true -RequiredCheckCount 5 -EvidenceErrors @('autonomous_review_evidence_handoff_not_published')
  Assert-Taxonomy ($summary -match 'no owner review handoff has been published') 'summary must name the not-published reason'

  $summary = Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $false -RequiredChecksGreen $true -RequiredCheckCount 5 -EvidenceErrors @('autonomous_review_evidence_missing')
  Assert-Taxonomy ($summary -match 'missing') 'summary must name the missing reason'

  Assert-Taxonomy ($null -eq (Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $true -RequiredChecksGreen $true -RequiredCheckCount 5 -EvidenceErrors @())) 'no summary is needed when independent review is satisfied'
  Assert-Taxonomy ($null -eq (Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $false -RequiredChecksGreen $false -RequiredCheckCount 5 -EvidenceErrors @('autonomous_review_evidence_missing'))) 'no summary is written while required peer checks are not green'
  Assert-Taxonomy ($null -eq (Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $false -RequiredChecksGreen $true -RequiredCheckCount 0 -EvidenceErrors @('autonomous_review_evidence_missing'))) 'no summary is written when no required checks are known'

  $summary = Get-AgentIndependentReviewSummary -IndependentReviewSatisfied $false -RequiredChecksGreen $true -RequiredCheckCount 5 -EvidenceErrors @('some_unmapped_error')
  Assert-Taxonomy ($summary -like 'Implementation CI is green. Waiting for exact-head final independent certification.*') 'summary must still be written for an unmapped reason'

  # --- Gate wiring (advisory summary must not change the merge decision) -----
  $gateSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../../scripts/agent-pr-gate.ps1')
  Assert-Taxonomy ($gateSource -match 'Get-AgentIndependentReviewSummary') 'gate must compute the independent-review summary'
  Assert-Taxonomy ($gateSource -match 'GITHUB_STEP_SUMMARY') 'gate must append the summary to the GitHub step summary'
  Assert-Taxonomy ($gateSource -match 'summary = \$independentReviewSummary') 'gate JSON result must carry the summary field'
  Assert-Taxonomy ($gateSource -match 'mergeReady = \$mergeReady') 'merge readiness must stay independent of the advisory summary'

  Write-Output 'review-evidence-taxonomy: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
