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
Write-Output 'TRUST_ROOT_BOUNDARY_TEST_PASS'
