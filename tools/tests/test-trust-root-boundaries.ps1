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
foreach ($forwarded in @('AutonomousReviewEvidencePath', 'TrustRootUpgradeAuthorizationPath')) {
  if ($launcher -notmatch [regex]::Escape($forwarded)) { throw "Trusted launcher does not forward $forwarded" }
}
$gate = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate.ps1')
if (-not $gate.Contains("[string]`$GitPath = ''")) { throw 'Base-rooted gate uses a platform-specific Git default.' }
foreach ($required in @('reviewThreads\(first:100,after:\$after\)', 'pageInfo\{hasNextPage endCursor\}', 'review_threads_pagination_incomplete')) {
  if ($gate -notmatch $required) { throw "Base-rooted gate is missing full review-thread pagination: $required" }
}
foreach ($required in @(
    'Get-AgentRulesetPolicy', 'RiskTier', 'IndependentReviewReceiptPath', 'ReviewChallengeLedgerPath',
    'MergeAuthorized', 'AuditOnly', 'BootstrapRepairAuthorized', 'schemaVersion = 3', 'Invoke-AgentGh', '[object[]]$checkRuns',
    'Wait-AgentRequiredChecksReady', 'MaxAttempts = 180', 'GITHUB_WORKFLOW', 'GITHUB_JOB',
    'self_check_deferred_to_current_job_result', 'required_check_wait_timeout',
    'TrustRootUpgradeV1', 'Test-AgentTrustRootUpgradeAuthorization', 'Get-AgentProtectedDiffDigest',
    'verify-trust-root-upgrade\.mjs', 'protected_diff_digest', 'trust_root_upgrade_authorization_missing',
    'signedReviewRequired', 'BABEL_REQUIRE_SIGNED_REVIEW', 'Read-AgentAutonomousReviewEvidence',
    'Test-AgentAutonomousReviewEvidence', 'Get-AgentNumstatDigest',
    'materializedCandidate', 'REMOTE_HEAD_MATCH')) {
  if ($gate -notmatch [regex]::Escape($required) -and $gate -notmatch $required) { throw "Base-rooted gate is missing trusted capability: $required" }
}
if ($gate -match 'PR -ne 121') { throw 'Base-rooted gate must not carry the retired PR 121 hard-code.' }
if ($gate -match 'candidate.*verify-trust-root-upgrade|materializ.*candidate.*verifier') { throw 'Gate must never materialize the verifier from the candidate.' }
if ($gate -match '(?s)trustedRootChanged[^=]*=[^;]*false') { throw 'Gate must not allow trust-root detection to be disabled.' }

# The autonomous review tier must never satisfy a trust-root modification.
if ($gate -notmatch [regex]::Escape('elseif (-not $signedReviewRequired -and $autonomousEvidenceResult.valid)')) { throw 'Autonomous review tier is not gated behind signed-review-required.' }
$signedIndex = $gate.IndexOf('$signedReviewRequired = $trustRootChanged', [StringComparison]::Ordinal)
if ($signedIndex -lt 0) { throw 'Gate is missing the signed-review-required escalation for trust-root changes.' }
$common = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/agent-pr-gate-common.psm1')
if ($common -notmatch 'function Resolve-AgentReviewThreadPages') { throw 'Common gate module is missing review-thread page resolver.' }
if ($common -notmatch 'function Test-AgentAutonomousReviewEvidence') { throw 'Common gate module is missing autonomous evidence validator.' }
if ($common -notmatch 'function Get-AgentNumstatDigest') { throw 'Common gate module is missing numstat digest helper.' }
if ($common -notmatch 'autonomous_evidence_diff_numstat_digest_mismatch') { throw 'Common gate module is missing numstat digest binding error.' }
if ($common -notmatch 'Export-ModuleMember.*Test-AgentAutonomousReviewEvidence') { throw 'Common gate module does not export autonomous evidence validator.' }
if ($launcher -match 'BootstrapRepairAuthorized') { throw 'Generic trusted gate exposes bootstrap bypass.' }
if ($gate -match '\$detail\.bypass_actors') { throw 'Trusted gate must not directly dereference optional ruleset bypass_actors.' }
foreach ($required in @('PR -ne 121', 'ApprovedHeadSha', 'BaseSha', 'unauthorized path', 'trust root exists')) {
  if ($bootstrap -notmatch [regex]::Escape($required)) { throw "Bootstrap boundary check missing: $required" }
}
$verifier = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/verify-trust-root-upgrade.mjs')
foreach ($required in @('trust_root_upgrade_authorization_v1', 'trust_root_upgrade', 'AUTHORIZE_TRUST_ROOT_UPGRADE', 'ed25519', 'authorization_supervisor_key_not_authorized', 'authorization_expired', 'authorization_protected_diff_digest_mismatch', 'authorization_repository_mismatch', 'authorization_pr_mismatch', 'authorization_${field}_mismatch')) {
  if ($verifier -notmatch [regex]::Escape($required)) { throw "Trust-root upgrade verifier is missing binding: $required" }
}
$materializer = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot 'scripts/materialize-independent-review-receipt.ps1')
if ($materializer -notmatch [regex]::Escape('per_page=100&page=')) { throw 'Evidence transport is missing full comment pagination.' }
foreach ($marker in @('babel-independent-review-receipt-v2', 'babel-independent-review-challenge-ledger-v1', 'babel-autonomous-review-evidence-v1', 'babel-trust-root-upgrade-authorization-v1')) {
  if ($materializer -notmatch [regex]::Escape($marker)) { throw "Evidence transport is missing marker: $marker" }
}
$workflow = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot '.github/workflows/trusted-control-plane.yml')
if ($workflow -notmatch [regex]::Escape('materialize-independent-review-receipt.ps1')) { throw 'Trusted workflow is missing the evidence transport step.' }
if ($workflow -notmatch [regex]::Escape('BABEL_REQUIRE_SIGNED_REVIEW')) { throw 'Trusted workflow is missing the signed-review escalation variable.' }
if ($workflow -match [regex]::Escape('persist-credentials: true')) { throw 'Trusted workflow must not persist credentials.' }

# ── Canonical trust-root inventory (campaign Phases 2-4) ─────────────────────
$inventoryPath = Join-Path $RepoRoot 'config/trust-root-paths.json'
if (-not (Test-Path -LiteralPath $inventoryPath -PathType Leaf)) { throw 'Canonical trust-root inventory is missing.' }
try { $inventory = Get-Content -Raw -LiteralPath $inventoryPath | ConvertFrom-Json } catch { throw 'Canonical trust-root inventory is malformed JSON.' }
if ([string]$inventory.schema_version -ne '1') { throw 'Trust-root inventory schema_version invalid.' }
if ([string]$inventory.kind -ne 'babel_trust_root_inventory_v1') { throw 'Trust-root inventory kind invalid.' }
$inventoryPaths = @($inventory.protected_paths | ForEach-Object { [string]$_ })
if ($inventoryPaths.Count -eq 0) { throw 'Trust-root inventory protected_paths is empty.' }
if (@($inventoryPaths | Select-Object -Unique).Count -ne $inventoryPaths.Count) { throw 'Trust-root inventory contains duplicate paths.' }
if ($inventoryPaths -notcontains 'config/trust-root-paths.json') { throw 'Trust-root inventory must protect itself.' }

# Every authority-bearing component must be protected. Required members are
# explicit: the trusted workflow, the workflows that produce required checks,
# the base-materialized gate scripts, the transport, both verifiers plus the
# activation/recovery verifiers, bootstrap, both key registries, and the two
# trusted workflow test suites.
$requiredProtected = @(
  '.github/workflows/trusted-control-plane.yml',
  '.github/workflows/typecheck.yml',
  '.github/workflows/public-pr-metadata.yml',
  'scripts/agent-pr-gate.ps1',
  'scripts/agent-pr-gate-common.psm1',
  'scripts/agent-git-common.psm1',
  'scripts/trusted-merge-gate.ps1',
  'scripts/materialize-independent-review-receipt.ps1',
  'scripts/verify-independent-review.mjs',
  'scripts/verify-trust-root-upgrade.mjs',
  'scripts/verify-authority-activation.mjs',
  'scripts/verify-recovery-scope.ps1',
  'scripts/bootstrap-trust-root.ps1',
  'config/independent-review-keys.json',
  'config/trusted-supervisor-keys.json',
  'config/trust-root-paths.json',
  'tools/tests/test-trust-root-boundaries.ps1',
  'tools/tests/test-trust-root-upgrade.mjs'
)
foreach ($required in $requiredProtected) {
  if ($inventoryPaths -notcontains $required) { throw "Trust-root inventory omits authority-bearing path: $required" }
}

# Phase 29 mandatory regression: modifying ONLY the trusted workflow must
# classify the candidate as a trust-root modification. That holds exactly when
# the workflow file is a protected path, so pin it explicitly here too.
if ($inventoryPaths -notcontains '.github/workflows/trusted-control-plane.yml') { throw 'Trusted workflow itself is not a protected trust-root path.' }

# Execution-closure completeness: every repository-local file invoked by the
# trusted workflow must be protected or explicitly allowlisted as
# non-authoritative. Extract script/tool path tokens mechanically from the
# workflow YAML so a newly invoked helper cannot silently appear outside the
# inventory.
$allowlistPaths = @($inventory.non_authoritative_allowlist | ForEach-Object { [string]$_.path })
foreach ($entry in @($inventory.non_authoritative_allowlist)) {
  if ([string]::IsNullOrWhiteSpace([string]$entry.reason)) { throw "Non-authoritative allowlist entry missing reason: $($entry.path)" }
}
$tokenMatches = [regex]::Matches($workflow, '(?:scripts|tools)/[A-Za-z0-9_\-./]+')
foreach ($match in $tokenMatches) {
  $token = $match.Value.TrimEnd('.', '/')
  $isProtected = $inventoryPaths -contains $token
  $isAllowlisted = $allowlistPaths -contains $token
  if (-not $isProtected -and -not $isAllowlisted) { throw "Trusted workflow invokes unclassified local path: $token" }
}

# The gate must load the inventory from the base commit and fail closed when
# it is unavailable, malformed, or schema-invalid.
foreach ($required in @('config/trust-root-paths.json', 'trust_root_inventory_unavailable', 'trust_root_inventory_malformed', 'trust_root_inventory_schema_invalid', 'Get-AgentProtectedTrustRootInventory', 'TRUST_ROOT_INVENTORY_READABLE')) {
  if ($gate -notmatch [regex]::Escape($required)) { throw "Gate is missing inventory enforcement: $required" }
}
# The launcher must forward its materialization base to the gate so inventory
# and gate logic come from one immutable revision.
if ($launcher -notmatch [regex]::Escape("'-BaseSha', `$BaseSha")) { throw 'Trusted launcher does not forward BaseSha to the gate.' }
Write-Output 'TRUST_ROOT_BOUNDARY_TEST_PASS'
