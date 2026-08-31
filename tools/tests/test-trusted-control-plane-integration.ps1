[CmdletBinding()]
param()

# Behavioral trust-plane contract test. This uses a real temporary Git
# repository and linked detached worktree, then drives the same resolver and
# policy functions used by agent-pr-gate.ps1 through adversarial scenarios.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$git = (Get-Command git -ErrorAction Stop).Source
$tempRoot = Join-Path $repoRoot ('.tmp-babel-trust-plane-' + [Guid]::NewGuid().ToString('N'))
$fixture = Join-Path $tempRoot 'fixture'
$candidate = Join-Path $tempRoot 'candidate'
$worktrees = Join-Path $tempRoot 'worktrees'
Import-Module (Join-Path $repoRoot 'scripts\agent-git-common.psm1') -Force
Import-Module (Join-Path $repoRoot 'scripts\agent-pr-gate-common.psm1') -Force

function Assert-TrustTest {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Invoke-TrustGit {
  param([Parameter(Mandatory = $true)][string]$WorkingDirectory, [Parameter(Mandatory = $true)][string[]]$Arguments)
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = @(& $git @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
  } finally { Pop-Location }
  if ($exitCode -ne 0) { throw "git failed ($exitCode) [$($Arguments -join ' ')]: $($output -join ' ')" }
  return ($output -join "`n").Trim()
}

function New-TrustObservation {
  param(
    [string]$Name = 'security', [string]$Head, [string]$Status = 'completed', [string]$Conclusion = 'success',
    [string]$Event = 'pull_request', [string]$WorkflowName = 'Public Release Gate', [string]$RunId = '100'
  )
  return [pscustomobject]@{
    name = $Name; head_sha = $Head; status = $Status; conclusion = $Conclusion; event = $Event
    workflow_name = $WorkflowName; workflow_id = 'workflow-1'; workflow_run_id = $RunId; workflow_run_attempt = '1'
    check_suite_id = "suite-$RunId"; check_run_id = "check-$RunId"; started_at = '2026-08-30T10:00:00Z'; completed_at = '2026-08-30T10:01:00Z'; authority = ''
  }
}

try {
  New-Item -ItemType Directory -Path $fixture, $worktrees -Force | Out-Null
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('init', '--initial-branch=main') | Out-Null
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('config', 'user.name', 'Babel Trust Plane Test') | Out-Null
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('config', 'user.email', 'trust-plane@example.invalid') | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'README.md') -Value '# trust fixture' -Encoding utf8
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('add', 'README.md') | Out-Null
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('commit', '-m', 'fixture base') | Out-Null
  $baseSha = Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('rev-parse', 'HEAD')
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('switch', '-c', 'candidate') | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'change.txt') -Value 'candidate' -Encoding utf8
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('add', 'change.txt') | Out-Null
  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('commit', '-m', 'fixture candidate') | Out-Null
  $headSha = Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('rev-parse', 'HEAD')

  Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('worktree', 'add', '--detach', $candidate, $headSha) | Out-Null
  $candidateStatus = Get-AgentStatusSnapshot -GitPath $git -RepoRoot $candidate
  $candidateTopology = Get-AgentWorktreeTopology -GitPath $git -RepoRoot $candidate
  Assert-TrustTest ($candidateStatus.commandOk -and $candidateStatus.clean) 'fresh exact-SHA candidate must be clean'
  Assert-TrustTest ([bool]$candidateStatus.detached) 'candidate fixture must model detached execution'
  Assert-TrustTest ($candidateTopology.available -and $candidateTopology.isolated) 'candidate must be an isolated linked worktree'
  Assert-TrustTest ((Invoke-TrustGit -WorkingDirectory $candidate -Arguments @('rev-parse', 'HEAD')) -eq $headSha) 'candidate HEAD must equal exact reviewed SHA'

  $required = @('security', 'public-content-policy', 'linux-validation', 'public-pr-metadata', 'windows-portability')
  $observations = @($required | ForEach-Object {
      $event = if ($_ -eq 'public-pr-metadata') { 'pull_request_target' } else { 'pull_request' }
      $workflow = if ($_ -eq 'public-pr-metadata') { 'Public PR Metadata' } else { 'Public Release Gate' }
      New-TrustObservation -Name $_ -Head $headSha -Event $event -WorkflowName $workflow -RunId ([string]([array]::IndexOf($required, $_) + 100))
    })
  $happyResults = @()
  foreach ($requiredName in $required) {
    $event = if ($requiredName -eq 'public-pr-metadata') { 'pull_request_target' } else { 'pull_request' }
    $workflow = if ($requiredName -eq 'public-pr-metadata') { 'Public PR Metadata' } else { 'Public Release Gate' }
    $happyResults += Resolve-AgentRequiredCheck -Observations $observations -RequiredName $requiredName -TargetSha $headSha -AuthorityEvent $event -AuthorityWorkflowName $workflow
  }
  Assert-TrustTest (@($happyResults | Where-Object status -ne 'PASS').Count -eq 0) 'happy-path required checks must all pass'
  $happyPolicy = Get-AgentReviewPolicyVerdict -RequiredApprovalCount 0 -ObservedApprovalCount 0 -ThreadsRequired $true -ThreadsResolved $true -IndependentRequired $true -IndependentSatisfied $true -MergeAuthorized $true
  Assert-TrustTest ((@($happyResults | Where-Object status -ne 'PASS').Count -eq 0) -and $happyPolicy.github_approval_satisfied -and $happyPolicy.review_threads_satisfied -and $happyPolicy.independent_review_satisfied -and $happyPolicy.merge_authority_satisfied) 'happy-path final decision must pass'

  $pending = Resolve-AgentRequiredCheck -Observations @(New-TrustObservation -Head $headSha -Status 'in_progress' -Conclusion '') -RequiredName 'security' -TargetSha $headSha -AuthorityEvent 'pull_request' -AuthorityWorkflowName 'Public Release Gate'
  Assert-TrustTest ($pending.status -eq 'BLOCKED') 'pending peer check must block'
  $failed = Resolve-AgentRequiredCheck -Observations @(New-TrustObservation -Head $headSha -Conclusion 'failure') -RequiredName 'security' -TargetSha $headSha -AuthorityEvent 'pull_request' -AuthorityWorkflowName 'Public Release Gate'
  Assert-TrustTest ($failed.status -eq 'FAIL') 'failed peer check must block'
  $wrongHead = Resolve-AgentRequiredCheck -Observations @(New-TrustObservation -Head $baseSha) -RequiredName 'security' -TargetSha $headSha -AuthorityEvent 'pull_request' -AuthorityWorkflowName 'Public Release Gate'
  Assert-TrustTest ($wrongHead.status -eq 'FAIL') 'wrong-head check must block'
  $unauthorized = Resolve-AgentRequiredCheck -Observations @(New-TrustObservation -Head $headSha -WorkflowName 'Untrusted Workflow') -RequiredName 'security' -TargetSha $headSha -AuthorityEvent 'pull_request' -AuthorityWorkflowName 'Public Release Gate'
  Assert-TrustTest ($unauthorized.status -eq 'AMBIGUOUS') 'unauthorized workflow must block'

  $unresolved = Resolve-AgentReviewThreadPages -Pages @([pscustomobject]@{ nodes = @([pscustomobject]@{ isResolved = $false }); pageInfo = [pscustomobject]@{ hasNextPage = $false; endCursor = $null } })
  Assert-TrustTest (-not [bool]$unresolved.resolved) 'unresolved review thread must block'
  $missingReceipt = Test-AgentIndependentReviewReceipt -Receipt ([pscustomobject]@{}) -Repository 'gthgomez/Babel' -PR 133 -BaseSha $baseSha -HeadSha $headSha -BuilderIdentity 'codex-implementation'
  Assert-TrustTest (-not [bool]$missingReceipt.valid) 'missing receipt fields must block'
  $receipt = [pscustomobject][ordered]@{
    schema_version = 2; kind = 'independent_review_receipt_v2'; repository = 'gthgomez/Babel'; pr_number = 133
    task_id = 'task-133'; run_id = 'run-133'; contract_hash = ('c' * 64); base_sha = $baseSha; head_sha = $headSha
    reviewer_id = 'independent-reviewer'; reviewer_class = 'independent_readonly'; review_mode = 'exact_head'
    reviewed_at = (Get-Date).ToUniversalTime().ToString('o'); challenge_id = 'challenge-133'; builder_id = 'codex-implementation'
    reviewed_scope = @{ kind = 'repository' }; verdict = 'APPROVE'; blocking_findings = @()
    authority_provenance = @{ issuer = 'supervisor_review_lane'; key_id = 'trusted-supervisor-ed25519-v1'; challenge_id = 'challenge-133' }
    signature = @{ algorithm = 'ed25519'; key_id = 'trusted-reviewer-ed25519-v2'; value = ('s' * 64) }
  }
  $forged = $receipt | ConvertTo-Json -Depth 20 | ConvertFrom-Json
  $forged.head_sha = $baseSha
  $forgedResult = Test-AgentIndependentReviewReceipt -Receipt $forged -Repository 'gthgomez/Babel' -PR 133 -BaseSha $baseSha -HeadSha $headSha -BuilderIdentity 'codex-implementation'
  Assert-TrustTest (-not [bool]$forgedResult.valid) 'forged or wrong-head receipt must block'

  $conflict = Resolve-AgentTrustedMergeState -RunningTrustedSelfCheck $false -MergeStateStatus 'DIRTY' -Mergeable 'CONFLICTING'
  Assert-TrustTest (-not [bool]$conflict.accepted) 'genuine merge conflict must block'
  $selfPending = Resolve-AgentTrustedMergeState -RunningTrustedSelfCheck $true -MergeStateStatus 'BLOCKED' -Mergeable 'MERGEABLE'
  Assert-TrustTest ([bool]$selfPending.accepted) 'trusted self-check must not self-deadlock'
  $detached = Test-AgentIntentionalDetachedCandidate -IsDetached $true -AllowIntentionalDetachedCandidate $true -RequireIsolatedWorktree $true -LocalHead $headSha -ReviewedHead $headSha
  Assert-TrustTest ([bool]$detached.accepted) 'intentional exact detached candidate must pass'
  $operatorDetached = Test-AgentIntentionalDetachedCandidate -IsDetached $true -AllowIntentionalDetachedCandidate $false -RequireIsolatedWorktree $true -LocalHead $headSha -ReviewedHead $headSha
  Assert-TrustTest (-not [bool]$operatorDetached.accepted) 'operator detached candidate must block'
  Set-Content -LiteralPath (Join-Path $candidate 'unexpected.txt') -Value 'dirty' -Encoding utf8
  $dirtyStatus = Get-AgentStatusSnapshot -GitPath $git -RepoRoot $candidate
  Assert-TrustTest (-not [bool]$dirtyStatus.clean) 'unexpectedly dirty candidate must block'

  Write-Output 'trusted-control-plane-integration: PASS'
  exit 0
} catch {
  Write-Error ("$($_.Exception.Message) at $($_.InvocationInfo.PositionMessage)`n$($_.ScriptStackTrace)")
  exit 1
} finally {
  if (Test-Path -LiteralPath $candidate) { Invoke-TrustGit -WorkingDirectory $fixture -Arguments @('worktree', 'remove', '--force', $candidate) | Out-Null }
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
