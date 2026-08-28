[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot '..\..\scripts\agent-pr-gate-common.psm1'
Import-Module $module -Force

function Assert-AgentGateTest {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function New-AgentGateObservation {
  param(
    [string]$Name = 'security', [string]$Head = ('a' * 40), [string]$Status = 'completed', [string]$Conclusion = 'success',
    [string]$Event = 'pull_request', [string]$WorkflowName = 'Public Release Gate', [string]$WorkflowId = 'workflow-1',
    [string]$RunId = '100', [string]$RunAttempt = '1', [string]$RunIdForCheck = '', [string]$Started = '2026-08-28T10:00:00Z',
    [string]$Completed = '2026-08-28T10:01:00Z', [string]$Authority = ''
  )
  $id = if ([string]::IsNullOrWhiteSpace($RunIdForCheck)) { $RunId } else { $RunIdForCheck }
  return [pscustomobject]@{
    name = $Name; head_sha = $Head; status = $Status; conclusion = $Conclusion; event = $Event
    workflow_name = $WorkflowName; workflow_id = $WorkflowId; workflow_run_id = $RunId; workflow_run_attempt = $RunAttempt
    check_suite_id = "suite-$RunId"; check_run_id = "check-$id"; started_at = $Started; completed_at = $Completed; authority = $Authority
  }
}

$head = 'a' * 40
$otherHead = 'b' * 40
$policyArgs = @{ TargetSha = $head; AuthorityEvent = 'pull_request'; AuthorityWorkflowName = 'Public Release Gate' }

try {
  $success = New-AgentGateObservation
  $skippedTarget = New-AgentGateObservation -Event 'pull_request_target' -WorkflowName 'Public Release Gate' -Conclusion 'skipped' -Authority 'non_authoritative' -RunId '200'
  $case1 = Resolve-AgentRequiredCheck -Observations @($skippedTarget, $success) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case1.status -eq 'PASS') 'same-head success must beat non-authoritative skipped twin'

  $cancelledTarget = New-AgentGateObservation -Event 'pull_request_target' -WorkflowName 'Public Release Gate' -Conclusion 'cancelled' -Authority 'non_authoritative' -RunId '201'
  $case2 = Resolve-AgentRequiredCheck -Observations @($cancelledTarget, $success) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case2.status -eq 'PASS') 'same-head success must beat non-authoritative cancelled twin'

  $oldSuccess = New-AgentGateObservation -RunId '300' -Started '2026-08-28T10:00:00Z' -Completed '2026-08-28T10:01:00Z'
  $newFailure = New-AgentGateObservation -RunId '301' -Conclusion 'failure' -Started '2026-08-28T10:02:00Z' -Completed '2026-08-28T10:03:00Z'
  $case3 = Resolve-AgentRequiredCheck -Observations @($oldSuccess, $newFailure) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case3.status -eq 'FAIL') 'latest authoritative failure must override older success'

  $oldFailure = New-AgentGateObservation -RunId '400' -Conclusion 'failure' -Started '2026-08-28T10:00:00Z' -Completed '2026-08-28T10:01:00Z'
  $newSuccess = New-AgentGateObservation -RunId '401' -Started '2026-08-28T10:02:00Z' -Completed '2026-08-28T10:03:00Z'
  $case4 = Resolve-AgentRequiredCheck -Observations @($oldFailure, $newSuccess) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case4.status -eq 'PASS') 'latest authoritative success must supersede older failure'

  $wrongSha = New-AgentGateObservation -Head $otherHead -RunId '500'
  $case5 = Resolve-AgentRequiredCheck -Observations @($wrongSha) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case5.status -eq 'FAIL') 'success on an old SHA must never certify the current head'

  $pending = New-AgentGateObservation -Status 'in_progress' -Conclusion '' -RunId '600'
  $case6 = Resolve-AgentRequiredCheck -Observations @($pending) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case6.status -eq 'BLOCKED') 'pending current-head check must block'

  $skipped = New-AgentGateObservation -Conclusion 'skipped' -RunId '700'
  $case7 = Resolve-AgentRequiredCheck -Observations @($skipped) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case7.status -eq 'FAIL') 'only skipped authoritative result must not be green'

  $unknownWorkflow = New-AgentGateObservation -WorkflowName 'Unknown Workflow' -RunId '800'
  $case8 = Resolve-AgentRequiredCheck -Observations @($unknownWorkflow) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case8.status -eq 'AMBIGUOUS') 'unknown workflow authority must fail closed'

  $permutations = @(
    @($oldSuccess, $newFailure), @($newFailure, $oldSuccess), @($oldFailure, $newSuccess), @($newSuccess, $oldFailure)
  )
  $verdicts = @($permutations | ForEach-Object { (Resolve-AgentRequiredCheck -Observations $_ -RequiredName 'security' @policyArgs).status })
  Assert-AgentGateTest (($verdicts[0] -eq 'FAIL') -and ($verdicts[1] -eq 'FAIL')) 'permutations must preserve failure verdict'
  Assert-AgentGateTest (($verdicts[2] -eq 'PASS') -and ($verdicts[3] -eq 'PASS')) 'permutations must preserve success verdict'

  $missingTimestamp = New-AgentGateObservation -Started '' -Completed '' -RunId '900'
  $case10 = Resolve-AgentRequiredCheck -Observations @($missingTimestamp) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case10.status -eq 'AMBIGUOUS') 'missing timestamps must fail closed'

  $duplicate = New-AgentGateObservation -RunIdForCheck 'duplicate' -RunId '901'
  $duplicate2 = New-AgentGateObservation -RunIdForCheck 'duplicate' -RunId '902'
  $case11 = Resolve-AgentRequiredCheck -Observations @($duplicate, $duplicate2) -RequiredName 'security' @policyArgs
  Assert-AgentGateTest ($case11.status -eq 'AMBIGUOUS') 'duplicate check identities must fail closed'

  $zeroReview = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 0 -ObservedApprovalCount 0 -ThreadsRequired $true -ThreadsResolved $true -IndependentRequired $true -IndependentSatisfied $true -MergeAuthorized $true
  Assert-AgentGateTest ([bool]$zeroReview.github_approval_satisfied) 'zero GitHub approvals must satisfy the GitHub approval dimension'
  $oneReview = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 1 -ObservedApprovalCount 0 -ThreadsRequired $false -ThreadsResolved $true -IndependentRequired $false -IndependentSatisfied $false -MergeAuthorized $true
  Assert-AgentGateTest (-not [bool]$oneReview.github_approval_satisfied) 'one required GitHub approval must remain unsatisfied without approval'
  $unresolvedThreads = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 0 -ObservedApprovalCount 0 -ThreadsRequired $true -ThreadsResolved $false -IndependentRequired $false -IndependentSatisfied $true -MergeAuthorized $true
  Assert-AgentGateTest (-not [bool]$unresolvedThreads.review_threads_satisfied) 'unresolved review threads must remain a separate blocker'
  Assert-AgentGateTest ([bool]$zeroReview.independent_review_satisfied) 'independent review must remain a separate dimension'
  Assert-AgentGateTest ([bool]$zeroReview.merge_authority_satisfied) 'merge authority must remain a separate dimension'

  $receipt = [pscustomobject][ordered]@{
    schema_version = 1; kind = 'independent_review_receipt_v1'; repository = 'gthgomez/Babel'; pr_number = 118
    base_sha = $otherHead; head_sha = $head; reviewer_id = 'codex-reviewer'; reviewer_class = 'independent_readonly'
    review_mode = 'exact_head'; reviewed_at = '2026-08-28T10:05:00Z'; scope = @('scripts/agent-pr-gate.ps1')
    findings = @(); blocking_findings = @(); verdict = 'APPROVE'; artifact_hash = ''; builder_id = 'codex-implementation'
  }
  $receipt.artifact_hash = Get-AgentIndependentReviewReceiptHash -Receipt $receipt
  $validReceipt = Test-AgentIndependentReviewReceipt -Receipt $receipt -Repository 'gthgomez/Babel' -PR 118 -BaseSha $otherHead -HeadSha $head -BuilderIdentity 'codex-implementation'
  Assert-AgentGateTest ([bool]$validReceipt.valid) 'well-formed exact-head independent receipt must validate'
  $wrongHeadReceipt = $receipt | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $wrongHeadReceipt.head_sha = $otherHead
  $wrongHead = Test-AgentIndependentReviewReceipt -Receipt $wrongHeadReceipt -Repository 'gthgomez/Babel' -PR 118 -BaseSha $otherHead -HeadSha $head -BuilderIdentity 'codex-implementation'
  Assert-AgentGateTest (-not [bool]$wrongHead.valid) 'independent receipt for another head must be rejected'
  $builderReceipt = $receipt | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $builderReceipt.reviewer_id = 'codex-implementation'
  $builderReceipt.artifact_hash = Get-AgentIndependentReviewReceiptHash -Receipt $builderReceipt
  $builderReview = Test-AgentIndependentReviewReceipt -Receipt $builderReceipt -Repository 'gthgomez/Babel' -PR 118 -BaseSha $otherHead -HeadSha $head -BuilderIdentity 'codex-implementation'
  Assert-AgentGateTest (-not [bool]$builderReview.valid) 'builder-issued independent review must be rejected'

  Write-Output 'agent-pr-gate: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
