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
  # Expected SHA-256 values come from JavaScript .sort().join('\n') in the worker.
  $mixedCaseNumstat = @("1`t0`tZ.ts", "1`t0`ta.ts")
  Assert-AgentGateTest ((Get-AgentNumstatDigest $mixedCaseNumstat) -ceq 'e4b6c598e11f6ff1acc0f3c719385aa1e121381fab46faa7b4810c59b28c4df2') 'numstat ordering must match JavaScript for mixed-case paths'
  $unicodeNumstat = @(
    "1`t0`t$([char]0xE000).ts", "1`t0`t$([char]::ConvertFromUtf32(0x1F600)).ts",
    "1`t0`t$([char]0x00E9).ts", "1`t0`tZ.ts", "1`t0`ta.ts", "1`t0`t-a.ts", "1`t0`t_a.ts", "1`t0`tZ.ts"
  )
  $originalNumstat = $unicodeNumstat -join "`n"
  $originalCulture = [Threading.Thread]::CurrentThread.CurrentCulture
  try {
    foreach ($culture in @('en-US', 'tr-TR', 'sv-SE')) {
      [Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo($culture)
      Assert-AgentGateTest ((Get-AgentNumstatDigest $unicodeNumstat) -ceq 'c583b00c618bd8e81be35339f39ef8b2789b4c1f123c8f708d06bdeb0644fc8c') "numstat digest must retain duplicate lines and ordinal UTF-16 ordering under $culture"
      Assert-AgentGateTest (($unicodeNumstat -join "`n") -ceq $originalNumstat) 'numstat hashing must not mutate the caller input'
    }
  } finally {
    [Threading.Thread]::CurrentThread.CurrentCulture = $originalCulture
  }

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

  $threadPages = @(
    [pscustomobject]@{
      nodes = @([pscustomobject]@{ isResolved = $true }, [pscustomobject]@{ isResolved = $true })
      pageInfo = [pscustomobject]@{ hasNextPage = $true; endCursor = 'cursor-1' }
    },
    [pscustomobject]@{
      nodes = @([pscustomobject]@{ isResolved = $true })
      pageInfo = [pscustomobject]@{ hasNextPage = $false; endCursor = $null }
    }
  )
  $resolvedThreads = Resolve-AgentReviewThreadPages -Pages $threadPages
  Assert-AgentGateTest ([bool]$resolvedThreads.available -and [bool]$resolvedThreads.resolved -and $resolvedThreads.count -eq 3 -and $resolvedThreads.unresolved -eq 0) 'paginated resolved review threads must remain available and resolved'
  $malformedThreads = Resolve-AgentReviewThreadPages -Pages @([pscustomobject]@{ nodes = @(); pageInfo = [pscustomobject]@{ hasNextPage = $true; endCursor = '' } })
  Assert-AgentGateTest (-not [bool]$malformedThreads.available -and $malformedThreads.error -eq 'review_threads_pagination_incomplete') 'incomplete review-thread pagination must fail closed'

  $zeroReview = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 0 -ObservedApprovalCount 0 -ThreadsRequired $true -ThreadsResolved $true -IndependentRequired $true -IndependentSatisfied $true
  Assert-AgentGateTest ([bool]$zeroReview.github_approval_satisfied) 'zero GitHub approvals must satisfy the GitHub approval dimension'
  $oneReview = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 1 -ObservedApprovalCount 0 -ThreadsRequired $false -ThreadsResolved $true -IndependentRequired $false -IndependentSatisfied $false
  Assert-AgentGateTest (-not [bool]$oneReview.github_approval_satisfied) 'one required GitHub approval must remain unsatisfied without approval'
  $unresolvedThreads = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 0 -ObservedApprovalCount 0 -ThreadsRequired $true -ThreadsResolved $false -IndependentRequired $false -IndependentSatisfied $true
  Assert-AgentGateTest (-not [bool]$unresolvedThreads.review_threads_satisfied) 'unresolved review threads must remain a separate blocker'
  Assert-AgentGateTest ([bool]$zeroReview.independent_review_satisfied) 'independent review must remain a separate dimension'
  Assert-AgentGateTest (-not ($zeroReview.PSObject.Properties.Name -contains 'merge_authority_satisfied')) 'task authority must not require a separate merge switch'

  Assert-AgentGateTest ((Get-AgentRiskLane -ChangedPaths @('src/example.ts')) -eq 'GREEN') 'ordinary paths must remain GREEN'
  Assert-AgentGateTest ((Get-AgentRiskLane -ChangedPaths @('babel-cli/src/services/provider.ts')) -eq 'YELLOW') 'service paths must require YELLOW evidence'
  Assert-AgentGateTest ((Get-AgentRiskLane -ChangedPaths @('tools/agent-host-review.ps1')) -eq 'RED') 'owner-host review launcher must be base-derived RED'
  Assert-AgentGateTest ((Get-AgentRiskLane -ChangedPaths @('tools/host-review-worker.mts')) -eq 'RED') 'owner-host review worker must be base-derived RED'
  Assert-AgentGateTest ((Get-AgentRiskLane -ChangedPaths @('babel-cli/src/runners/openCodeGoApi.ts')) -eq 'RED') 'OpenCode-Go review adapter must be base-derived RED'
  Assert-AgentGateTest ((Get-AgentRiskLane -ChangedPaths @('scripts/agent-pr-gate.ps1')) -eq 'RED') 'merge-control paths must be base-derived RED'

  Write-Output 'agent-pr-gate: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
