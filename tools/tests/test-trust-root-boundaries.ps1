[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcher = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/trusted-merge-gate.ps1')
if ($launcher -notmatch '-C \$resolvedRepo show') { throw 'Trusted launcher does not materialize from git objects.' }
foreach ($component in @('scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-review-evidence.ps1', 'scripts/agent-git-common.psm1')) {
  if ($launcher -notmatch [regex]::Escape($component)) { throw "Trusted launcher omits $component" }
}
if ($launcher -notmatch 'agent-pr-gate\.ps1') { throw 'Trusted launcher does not invoke the base-rooted gate.' }
if ($launcher -notmatch '\$pwshCommand = Get-Command pwsh -ErrorAction Stop') { throw 'Trusted launcher uses a non-portable PowerShell path.' }
foreach ($unsupported in @('-TaskId', '-RunId', '-ContractHash')) {
  if ($launcher -match [regex]::Escape($unsupported)) { throw "Trusted launcher forwards unsupported gate parameter: $unsupported" }
}
foreach ($forwarded in @('AutonomousReviewEvidencePath')) {
  if ($launcher -notmatch [regex]::Escape($forwarded)) { throw "Trusted launcher does not forward $forwarded" }
}
$gate = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate.ps1')
if (-not $gate.Contains("[string]`$GitPath = ''")) { throw 'Base-rooted gate uses a platform-specific Git default.' }
foreach ($required in @('reviewThreads\(first:100,after:\$after\)', 'pageInfo\{hasNextPage endCursor\}', 'review_threads_pagination_incomplete')) {
  if ($gate -notmatch $required) { throw "Base-rooted gate is missing full review-thread pagination: $required" }
}
foreach ($required in @(
    'Get-AgentRulesetPolicy', 'RiskTier', 'AuditOnly', 'schemaVersion = 4', 'Invoke-AgentGh', '[object[]]$checkRuns',
    'Wait-AgentRequiredChecksReady', 'MaxAttempts = 180', 'GITHUB_WORKFLOW', 'GITHUB_JOB',
    'self_check_deferred_to_current_job_result', 'required_check_wait_timeout',
    'Get-AgentRiskLane', 'baseDerivedLane', 'effectiveLane', 'minimumReviewCount',
    'Read-AgentAutonomousReviewEvidence', 'Test-AgentControllerReviewEvidenceBundle', 'Get-AgentNumstatDigest',
    'materializedCandidate', 'REMOTE_HEAD_MATCH')) {
  if ($gate -notmatch [regex]::Escape($required) -and $gate -notmatch $required) { throw "Base-rooted gate is missing trusted capability: $required" }
}
if ($gate -match 'PR -ne 121') { throw 'Base-rooted gate must not carry the retired PR 121 hard-code.' }
if ($gate -match 'MergeAuthorized|explicit_merge_authority_missing') { throw 'Gate must not require redundant per-merge authorization.' }
$common = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate-common.psm1')
if ($common -notmatch 'function Resolve-AgentReviewThreadPages') { throw 'Common gate module is missing review-thread page resolver.' }
if ($common -notmatch 'agent-review-evidence\.ps1') { throw 'Common gate module does not load the immutable evidence validator.' }
if ($common -notmatch 'function Get-AgentRiskLane') { throw 'Common gate module is missing base-derived risk classification.' }
if ($common -notmatch 'function Get-AgentNumstatDigest') { throw 'Common gate module is missing numstat digest helper.' }
if ($common -notmatch 'Export-ModuleMember.*Test-AgentAutonomousReviewEvidence') { throw 'Common gate module does not export autonomous evidence validator.' }
$evidenceValidator = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-review-evidence.ps1')
foreach ($required in @('function Test-AgentAutonomousReviewEvidence', 'function Test-AgentControllerReviewEvidenceBundle', 'function Select-AgentHostReviewBundle', 'babel-controller-ai-reviews-v2')) {
  if ($evidenceValidator -notmatch [regex]::Escape($required)) { throw "Immutable evidence validator is missing: $required" }
}
if ($evidenceValidator -notmatch [regex]::Escape('diff_numstat_digest = $ExpectedNumstatDigest')) { throw 'Immutable evidence validator is missing numstat digest binding.' }
if ($launcher -match 'BootstrapRepairAuthorized|MergeAuthorized') { throw 'Generic trusted gate exposes a bypass or redundant merge authority switch.' }
if ($gate -match '\$detail\.bypass_actors') { throw 'Trusted gate must not directly dereference optional ruleset bypass_actors.' }
$materializer = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/materialize-independent-review-receipt.ps1')
if ($materializer -notmatch [regex]::Escape('per_page=100&page=')) { throw 'Evidence transport is missing full comment pagination.' }
foreach ($marker in @('owner.id', 'per_page=100&page=')) {
  if ($materializer -notmatch [regex]::Escape($marker)) { throw "Evidence transport is missing marker: $marker" }
}
foreach ($marker in @('babel-controller-ai-reviews-v2', 'github_host_review_bundle_v2')) {
  if ($evidenceValidator -notmatch [regex]::Escape($marker)) { throw "Immutable evidence validator is missing marker: $marker" }
}
$workflow = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot '.github/workflows/trusted-control-plane.yml')
if ($workflow -notmatch [regex]::Escape('materialize-independent-review-receipt.ps1')) { throw 'Trusted workflow is missing the evidence transport step.' }
if ($workflow -match 'BABEL_REVIEW_CONTROLLER_(LOGIN|APP_ID)') { throw 'Trusted workflow must not retain App-controller configuration.' }
if ($workflow -notmatch [regex]::Escape('github.event.repository.owner.id')) { throw 'Trusted workflow is missing owner-controller provenance binding.' }
if ($workflow -match [regex]::Escape('persist-credentials: true')) { throw 'Trusted workflow must not persist credentials.' }

# Execute the actual no-checkout refresh body with GitHub and sleep mocked.
# This keeps lifecycle regressions covered without credentials or API writes.
$refreshJob = ($workflow -split '(?m)^  rerun-after-review:\r?$')[1]
if ($refreshJob -match 'actions/checkout|workflow_dispatch|force-cancel|contents: write') { throw 'Review refresh must not check out code, change producers, force cancel, or gain contents write.' }
foreach ($required in @('trusted-control-plane-review-${{ github.event.issue.number }}', 'cancel-in-progress: false', 'actions: write', 'timeout-minutes: 10')) {
  if (-not $refreshJob.Contains($required)) { throw "Review refresh lacks its scoped concurrency/permission/time boundary: $required" }
}
$refreshMatch = [regex]::Match($refreshJob, '(?ms)^        run: \|\r?\n(?<script>(?:          [^\r\n]*(?:\r?\n|$)|\r?\n)+)')
if (-not $refreshMatch.Success) { throw 'Review refresh inline script unavailable.' }
$refreshScript = [scriptblock]::Create(($refreshMatch.Groups['script'].Value -replace '(?m)^ {10}', ''))

function Test-ReviewRefresh {
  param([string]$Scenario, [int]$CancelCount, [int]$RerunCount, [string]$ExpectedError = '')
  $state = @{ runReads = 0; prReads = 0; sleeps = 0; cancels = 0; reruns = 0 }
  function Start-Sleep {
    param([int]$Seconds)
    if ($Seconds -ne 5) { throw 'Unexpected wait interval.' }
    $state.sleeps++
  }
  function gh {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Arguments)
    $global:LASTEXITCODE = 0
    $uri = $Arguments[-1]
    if ($Arguments -contains 'POST') {
      if ($uri -ceq 'repos/test/repo/actions/runs/101/cancel') {
        $state.cancels++
        if ($Scenario -in @('completed-race', 'cancel-denied')) { $global:LASTEXITCODE = 1 }
      } elseif ($uri -ceq 'repos/test/repo/actions/runs/101/rerun') {
        $state.reruns++
        if ($Scenario -in @('rerun-race', 'rerun-failed')) { $global:LASTEXITCODE = 1 }
      } else { throw "Unexpected mutation target: $uri" }
      return
    }
    if ($uri -ceq 'repos/test/repo/pulls/42') {
      $state.prReads++
      $sha = if ($Scenario -in @('changed-before-cancel', 'changed-before-rerun') -and $state.prReads -gt 1) { 'b' * 40 } else { 'a' * 40 }
      @{ state = $(if ($Scenario -eq 'closed') { 'closed' } else { 'open' }); head = @{ sha = $sha } } | ConvertTo-Json -Depth 10 -Compress
      return
    }
    $run = @{ id = 101; workflow_id = 7; event = 'pull_request_target'; head_sha = ('a' * 40); pull_requests = @(@{ number = 42 }); status = 'completed'; run_attempt = 1 }
    if ($uri -like 'repos/test/repo/actions/workflows/trusted-control-plane.yml/runs?*') {
      $foreign = @(
        @{ id = 999; event = 'push'; head_sha = ('a' * 40); pull_requests = @(@{ number = 42 }) },
        @{ id = 998; event = 'pull_request_target'; head_sha = ('b' * 40); pull_requests = @(@{ number = 42 }) },
        @{ id = 997; event = 'pull_request_target'; head_sha = ('a' * 40); pull_requests = @(@{ number = 43 }) }
      )
      if ($Scenario -eq 'ambiguous-pr') { $run.pull_requests += @{ number = 43 } }
      @{ workflow_runs = $(if ($Scenario -eq 'no-match') { $foreign } else { @($run) + $foreign }) } | ConvertTo-Json -Depth 10 -Compress
      return
    }
    if ($uri -cne 'repos/test/repo/actions/runs/101') { throw "Unexpected read endpoint: $uri" }
    $state.runReads++
    if ($Scenario -in @('active', 'queued', 'completed-race', 'cancel-denied', 'stuck', 'changed-before-cancel', 'advanced-after-cancel', 'advanced-during-wait')) {
      $run.status = if ($Scenario -eq 'queued') { 'queued' } else { 'in_progress' }
      if ($state.cancels -gt 0 -and $Scenario -notin @('cancel-denied', 'stuck') -and ($state.runReads -gt 2 -or $Scenario -eq 'completed-race')) { $run.status = 'completed' }
    }
    if ($Scenario -eq 'wrong-head') { $run.head_sha = 'b' * 40 }
    if ($Scenario -eq 'wrong-workflow') { $run.workflow_id = 8 }
    if ($Scenario -eq 'wrong-event') { $run.event = 'push' }
    if ($Scenario -eq 'wrong-pr') { $run.pull_requests = @(@{ number = 43 }) }
    if ($Scenario -eq 'advanced-after-cancel' -and $state.cancels -gt 0) { $run.run_attempt = 2 }
    if (($Scenario -eq 'advanced-during-wait' -and $state.runReads -gt 2) -or
        ($Scenario -eq 'advanced-before-rerun' -and $state.runReads -gt 1) -or
        ($Scenario -eq 'rerun-race' -and $state.reruns -gt 0)) { $run.run_attempt = 2; $run.status = 'queued' }
    $run | ConvertTo-Json -Depth 10 -Compress
  }
  $failure = ''
  try { & $refreshScript | Out-Null } catch { $failure = $_.Exception.Message }
  if (($ExpectedError -and -not $failure.Contains($ExpectedError)) -or (-not $ExpectedError -and $failure)) { throw "Refresh ${Scenario}: unexpected error '$failure'" }
  if ($state.cancels -ne $CancelCount -or $state.reruns -ne $RerunCount) { throw "Refresh ${Scenario}: unexpected cancellation/rerun count." }
  if ($state.sleeps -gt 72 -or ($Scenario -eq 'stuck' -and $state.sleeps -ne 72)) { throw "Refresh ${Scenario}: wait is not bounded." }
}
$priorRepository = $env:GITHUB_REPOSITORY; $priorPr = $env:PR_NUMBER
$priorExitCode = Get-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
try {
  $env:GITHUB_REPOSITORY = 'test/repo'; $env:PR_NUMBER = '42'
  Test-ReviewRefresh completed 0 1
  Test-ReviewRefresh active 1 1
  Test-ReviewRefresh queued 1 1
  Test-ReviewRefresh completed-race 1 1
  Test-ReviewRefresh cancel-denied 1 0 'cancellation failed'
  Test-ReviewRefresh stuck 1 0 'bounded wait'
  Test-ReviewRefresh changed-before-cancel 0 0 'PR changed'
  Test-ReviewRefresh changed-before-rerun 0 0 'PR changed'
  Test-ReviewRefresh closed 0 0 'Open PR metadata unavailable'
  Test-ReviewRefresh no-match 0 0 'No audit run'
  Test-ReviewRefresh ambiguous-pr 0 0 'No audit run'
  foreach ($scenario in @('wrong-head', 'wrong-workflow', 'wrong-event', 'wrong-pr')) { Test-ReviewRefresh $scenario 0 0 'identity changed' }
  Test-ReviewRefresh advanced-after-cancel 1 1
  Test-ReviewRefresh advanced-during-wait 1 0
  Test-ReviewRefresh advanced-before-rerun 0 0
  Test-ReviewRefresh rerun-race 0 1
  Test-ReviewRefresh rerun-failed 0 1 'rerun request failed'
} finally {
  $env:GITHUB_REPOSITORY = $priorRepository; $env:PR_NUMBER = $priorPr
  if ($null -ne $priorExitCode) { $global:LASTEXITCODE = $priorExitCode.Value } else { Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue }
}
Write-Output 'TRUST_ROOT_BOUNDARY_TEST_PASS'
