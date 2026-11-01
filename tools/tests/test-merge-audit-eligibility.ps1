[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $RepoRoot 'scripts/merge-audit-eligibility.psm1') -Force

function Assert-Eligibility {
  param(
    [Parameter(Mandatory = $true)][object]$Actual,
    [Parameter(Mandatory = $true)][string]$State,
    [Parameter(Mandatory = $true)][string]$Reason,
    [bool]$AuditExecuted = $false,
    [Nullable[int]]$PrNumber = $null
  )
  if ([string]$Actual.state -ne $State) { throw "expected state=$State got $($Actual.state)" }
  if ([string]$Actual.reason -ne $Reason) { throw "expected reason=$Reason got $($Actual.reason)" }
  if ([bool]$Actual.auditExecuted -ne $AuditExecuted) { throw "expected auditExecuted=$AuditExecuted" }
  if ($null -ne $PrNumber -and [int]$Actual.prNumber -ne $PrNumber) { throw 'unexpected prNumber' }
}

$head = 'a' * 40
$other = 'b' * 40
$repo = 'gthgomez/Babel'
$emptyPrs = @()
function New-Pr {
  param([int]$Number = 474, [string]$State = 'open', [bool]$Draft = $false, [string]$Head = $head, [string]$BaseRef = 'main', [string]$Repo = $repo)
  return [pscustomobject]@{
    number = $Number
    state = $State
    draft = $Draft
    base = @{ ref = $BaseRef; sha = ('c' * 40) }
    head = @{ sha = $Head; repo = @{ full_name = $Repo } }
  }
}

Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests $emptyPrs -HeadSha $head -Repository $repo) -State NOT_APPLICABLE -Reason 'no_exact_open_main_pull_request'
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr -Draft $true) -HeadSha $head -Repository $repo) -State NOT_APPLICABLE -Reason 'pr_is_draft' -PrNumber 474
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr) -HeadSha $head -Repository $repo) -State ELIGIBLE -Reason 'exact_head_open_main_candidate' -PrNumber 474
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr; New-Pr -Number 475) -HeadSha $head -Repository $repo) -State UNKNOWN -Reason 'ambiguous_exact_head_association'
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr -Head $other) -HeadSha $head -Repository $repo) -State SUPERSEDED -Reason 'pr_head_advanced_past_release_gate' -PrNumber 474
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr -BaseRef 'integration/foo') -HeadSha $head -Repository $repo) -State NOT_APPLICABLE -Reason 'no_exact_open_main_pull_request'
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr -Repo 'other/repo') -HeadSha $head -Repository $repo) -State NOT_APPLICABLE -Reason 'no_exact_open_main_pull_request'
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @(New-Pr -State 'closed') -HeadSha $head -Repository $repo) -State NOT_APPLICABLE -Reason 'no_exact_open_main_pull_request'
$advanced = New-Pr
$advanced.head.sha = $other
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests @($advanced) -HeadSha $head -Repository $repo) -State SUPERSEDED -Reason 'pr_head_advanced_past_release_gate' -PrNumber 474
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests $emptyPrs -HeadSha 'short' -Repository $repo) -State UNKNOWN -Reason 'release_gate_head_malformed'
Assert-Eligibility -Actual (Resolve-MergeAuditReleaseGateAssociation -PullRequests $emptyPrs -HeadSha $head -Repository $repo -ApiError 'denied') -State UNKNOWN -Reason 'association_read_failed'

if (Test-MergeAuditShouldRun -Applicability (New-MergeAuditApplicability -State ELIGIBLE -Reason 'x')) { } else { throw 'eligible must run audit' }
if (Test-MergeAuditShouldRun -Applicability (New-MergeAuditApplicability -State NOT_APPLICABLE -Reason 'pr_is_draft')) { throw 'draft must not run audit' }
if (Test-MergeAuditShouldRun -Applicability (New-MergeAuditApplicability -State SUPERSEDED -Reason 'pr_head_advanced_past_release_gate')) { throw 'superseded must not run audit' }
if (-not (Test-MergeAuditTransportFailure -Applicability (New-MergeAuditApplicability -State UNKNOWN -Reason 'ambiguous_exact_head_association'))) { throw 'unknown must fail transport' }
if (Test-MergeAuditTransportFailure -Applicability (New-MergeAuditApplicability -State NOT_APPLICABLE -Reason 'pr_is_draft')) { throw 'not applicable is not transport failure' }

Write-Output 'MERGE_AUDIT_ELIGIBILITY_TEST_PASS'
