[CmdletBinding()]
param([string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$launcher = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/trusted-merge-gate.ps1')
$bootstrap = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/bootstrap-trust-root.ps1')
if ($launcher -notmatch '-C \$resolvedRepo show') { throw 'Trusted launcher does not materialize from git objects.' }
foreach ($component in @('scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-git-common.psm1')) {
  if ($launcher -notmatch [regex]::Escape($component)) { throw "Trusted launcher omits $component" }
}
if ($launcher -notmatch 'agent-pr-gate\.ps1') { throw 'Trusted launcher does not invoke the base-rooted gate.' }
if ($launcher -notmatch '\$pwshCommand = Get-Command pwsh -ErrorAction Stop') { throw 'Trusted launcher uses a non-portable PowerShell path.' }
foreach ($unsupported in @('-TaskId', '-RunId', '-ContractHash')) {
  if ($launcher -match [regex]::Escape($unsupported)) { throw "Trusted launcher forwards unsupported gate parameter: $unsupported" }
}
$gate = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate.ps1')
if (-not $gate.Contains("[string]`$GitPath = ''")) { throw 'Base-rooted gate uses a platform-specific Git default.' }
foreach ($required in @('REVIEWED_HEAD_INPUT', 'reviewed_head_sha_required', 'Get-AgentProperty', 'status.*porcelain=v2')) {
  if ($gate -notmatch $required) { throw "Base-rooted gate is missing exact-head/property-safe readiness logic: $required" }
}
if ($launcher -match 'BootstrapRepairAuthorized') { throw 'Generic trusted gate exposes bootstrap bypass.' }
foreach ($required in @('reviewThreads\(first:100,after:\$after\)', 'pageInfo\{hasNextPage endCursor\}', 'review_threads_pagination_incomplete')) {
  if ($gate -notmatch $required) { throw "Base-rooted gate is missing full review-thread pagination: $required" }
}
foreach ($required in @('Get-AgentRulesetPolicy', 'RiskTier', 'IndependentReviewReceiptPath', 'ReviewChallengeLedgerPath', 'MergeAuthorized', 'AuditOnly', 'BootstrapRepairAuthorized', 'schemaVersion = 2', 'Invoke-AgentGh', '[object[]]$checkRuns', 'Wait-AgentRequiredChecksReady', 'MaxAttempts = 180', 'GITHUB_WORKFLOW', 'GITHUB_JOB', 'self_check_deferred_to_current_job_result', 'required_check_wait_timeout')) {
  if ($gate -notmatch [regex]::Escape($required)) { throw "Base-rooted gate is missing trusted capability: $required" }
}
$common = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate-common.psm1')
if ($common -notmatch 'function Resolve-AgentReviewThreadPages') { throw 'Common gate module is missing review-thread page resolver.' }
if ($common -notmatch 'Export-ModuleMember.*Resolve-AgentReviewThreadPages') { throw 'Common gate module does not export review-thread page resolver.' }
if ($gate -match '\$detail\.bypass_actors') { throw 'Trusted gate must not directly dereference optional ruleset bypass_actors.' }
foreach ($required in @('PR -ne 121', 'ApprovedHeadSha', 'BaseSha', 'unauthorized path', 'trust root exists')) {
  if ($bootstrap -notmatch [regex]::Escape($required)) { throw "Bootstrap boundary check missing: $required" }
}
Write-Output 'TRUST_ROOT_BOUNDARY_TEST_PASS'
