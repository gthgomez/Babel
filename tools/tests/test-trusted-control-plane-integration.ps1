# Offline integration test for the trusted control plane.
#
# Builds a fixture git repository whose BASE commit carries the full trust
# root (gate scripts, verifier, supervisor key registry), materializes the
# candidate as a detached isolated worktree exactly like the GitHub workflow
# does, and runs the real trusted-merge-gate launcher against a shim `gh`
# executable so no network access is needed.
#
# Coverage:
#   1. trust-root modification + valid supervisor-signed upgrade
#      authorization + autonomous review evidence -> audit passes
#   2. missing upgrade authorization -> protected_trust_root_modified blocker
#   3. authorization signed by an unregistered key -> protected_trust_root_modified blocker
#   4. trust-root change without review evidence -> independent_review_not_satisfied
#   5. dirty candidate worktree -> dirty_worktree blocker
#   6. detached head without RequireIsolatedWorktree -> detached_head blocker
[CmdletBinding()]
param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$DebugOutputDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$git = (Get-Command git -ErrorAction Stop).Source
$node = (Get-Command node -ErrorAction Stop).Source
$root = Join-Path ([IO.Path]::GetTempPath()) ('babel-tcp-integration-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$candidatePath = Join-Path $root 'candidate'
$failures = @()

function Invoke-Step {
  param([string]$Name, [scriptblock]$Action)
  try { & $Action; Write-Output "ok $Name" }
  catch { $script:failures += $Name; Write-Output "FAIL $Name : $($_.Exception.Message)" }
}

try {
  # ---- key material (throwaway, test-only) ----
  $keyArgs = @('-e', 'const {generateKeyPairSync}=require("node:crypto");const s=generateKeyPairSync("ed25519");const r=generateKeyPairSync("ed25519");require("node:fs").writeFileSync(process.argv[1],s.publicKey.export({type:"spki",format:"pem"}));require("node:fs").writeFileSync(process.argv[2],s.privateKey.export({type:"pkcs8",format:"pem"}));require("node:fs").writeFileSync(process.argv[3],r.publicKey.export({type:"spki",format:"pem"}));require("node:fs").writeFileSync(process.argv[4],r.privateKey.export({type:"pkcs8",format:"pem"}));', (Join-Path $root 'supervisor-public.pem'), (Join-Path $root 'supervisor-private.pem'), (Join-Path $root 'reviewer-public.pem'), (Join-Path $root 'reviewer-private.pem'))
  & $node @keyArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'key generation failed' }

  # ---- fixture remote (bare) + base commit ----
  # Forward slashes keep Get-AgentRemoteSlug's github.com/ pattern matching
  # working on Windows paths.
  $barePath = ($root + '/fake-github.com/gthgomez/Babel.git')
  New-Item -ItemType Directory -Path $barePath -Force | Out-Null
  & $git init --bare --initial-branch=main $barePath 2>&1 | Out-Null
  $seedPath = Join-Path $root 'seed'
  New-Item -ItemType Directory -Path $seedPath -Force | Out-Null
  & $git -C $seedPath init --initial-branch=main 2>&1 | Out-Null
  & $git -C $seedPath config user.email gate-test@example.com
  & $git -C $seedPath config user.name 'Gate Test'
  & $git -C $seedPath remote add origin $barePath
  foreach ($relative in @('scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-git-common.psm1', 'scripts/trusted-merge-gate.ps1', 'scripts/verify-trust-root-upgrade.mjs', 'scripts/verify-independent-review.mjs', 'scripts/bootstrap-trust-root.ps1', 'scripts/materialize-independent-review-receipt.ps1')) {
    $target = Join-Path $seedPath $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot $relative) -Destination $target -Force
  }
  New-Item -ItemType Directory -Path (Join-Path $seedPath 'config') -Force | Out-Null
  $registry = [ordered]@{ schema_version = 1; keys = [ordered]@{ 'integration-supervisor-v1' = (Get-Content -Raw (Join-Path $root 'supervisor-public.pem')) } }
  $registry | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $seedPath 'config/trusted-supervisor-keys.json') -Encoding utf8NoBOM
  $reviewRegistry = [ordered]@{ schema_version = 1; keys = [ordered]@{ 'integration-reviewer-v1' = (Get-Content -Raw (Join-Path $root 'reviewer-public.pem')) } }
  $reviewRegistry | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $seedPath 'config/independent-review-keys.json') -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $seedPath 'product.txt') -Value 'base product file' -Encoding utf8NoBOM
  & $git -C $seedPath add -A
  & $git -C $seedPath commit -m 'base with trust root' 2>&1 | Out-Null
  $baseSha = (& $git -C $seedPath rev-parse HEAD).Trim()
  & $git -C $seedPath push origin main 2>&1 | Out-Null
  & $git -C $seedPath update-ref refs/remotes/origin/main $baseSha

  # ---- candidate commit modifies the trust root (main stays at base) ----
  Add-Content -LiteralPath (Join-Path $seedPath 'scripts/agent-git-common.psm1') -Value '# candidate trust change' -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $seedPath 'feature.txt') -Value 'candidate feature' -Encoding utf8NoBOM
  & $git -C $seedPath add -A
  & $git -C $seedPath commit -m 'candidate trust change' 2>&1 | Out-Null
  $headSha = (& $git -C $seedPath rev-parse HEAD).Trim()
  & $git -C $seedPath branch candidate-head $headSha
  & $git -C $seedPath push origin candidate-head:refs/heads/candidate-head 2>&1 | Out-Null
  & $git -C $seedPath checkout --detach HEAD 2>&1 | Out-Null

  # ---- evidence computed against the fixture history ----
  $protectedChanged = @('scripts/agent-git-common.psm1')
  $digestLines = @()
  foreach ($path in $protectedChanged) {
    $blob = (& $git -C $seedPath rev-parse ('{0}:{1}' -f $headSha, $path)).Trim()
    $digestLines += ("{0}`t{1}" -f $path, $blob)
  }
  $canonical = (($digestLines | Sort-Object) -join "`n")
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $protectedDigest = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))) -replace '-', '').ToLowerInvariant()

  $numstat = @(& $git -C $seedPath diff --numstat ('{0}...{1}' -f $baseSha, $headSha) | ForEach-Object { [string]$_ })
  $numstatCanonical = (($numstat | Sort-Object) -join "`n")
  $numstatDigest = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($numstatCanonical))) -replace '-', '').ToLowerInvariant()

  $unsignedPath = Join-Path $root 'authorization-unsigned.json'
  $authorizationPath = Join-Path $root 'authorization.json'
  $foreignAuthorizationPath = Join-Path $root 'authorization-foreign.json'
  $evidencePath = Join-Path $root 'ai-review.json'
  $unsigned = [ordered]@{
    schema_version = 1
    kind = 'trust_root_upgrade_authorization_v1'
    intent = 'trust_root_upgrade'
    decision = 'AUTHORIZE_TRUST_ROOT_UPGRADE'
    repository = 'gthgomez/Babel'
    pr_number = 4242
    base_sha = $baseSha
    head_sha = $headSha
    protected_paths = $protectedChanged
    protected_diff_digest = $protectedDigest
    issued_at = '2026-09-01T00:00:00.000Z'
    expires_at = '2099-01-01T00:00:00.000Z'
    signature_key_id = 'integration-supervisor-v1'
  }
  $unsigned | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $unsignedPath -Encoding utf8NoBOM
  & $node (Join-Path $RepoRoot 'tools/tests/helpers/make-trust-upgrade-authorization.mjs') (Join-Path $root 'supervisor-private.pem') $unsignedPath | Set-Content -LiteralPath $authorizationPath -Encoding utf8NoBOM
  # Foreign key authorization: signed by a key that is not in the registry.
  & $node @('-e', 'const {generateKeyPairSync}=require("node:crypto");require("node:fs").writeFileSync(process.argv[1],generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}));', (Join-Path $root 'foreign-private.pem')) | Out-Null
  & $node (Join-Path $RepoRoot 'tools/tests/helpers/make-trust-upgrade-authorization.mjs') (Join-Path $root 'foreign-private.pem') $unsignedPath | Set-Content -LiteralPath $foreignAuthorizationPath -Encoding utf8NoBOM

  $evidence = [ordered]@{
    schema_version = 1
    kind = 'autonomous_review_evidence_v1'
    repository = 'gthgomez/Babel'
    pr_number = 4242
    base_sha = $baseSha
    head_sha = $headSha
    reviewer_id = 'isolated-ai-reviewer'
    reviewer_class = 'independent_readonly_ai'
    review_mode = 'exact_diff'
    reviewed_at = '2026-09-04T00:00:00.000Z'
    scope = @('scripts/agent-git-common.psm1', 'feature.txt')
    findings = @('example non-blocking finding')
    blocking_findings = @()
    verdict = 'APPROVE'
    builder_id = 'codex-implementation'
    diff_numstat_digest = $numstatDigest
  }
  $evidence | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $evidencePath -Encoding utf8NoBOM

  # ---- signed independent review receipt + supervisor challenge ledger ----
  $receiptUnsigned = [ordered]@{
    schema_version = 1
    kind = 'independent_review_receipt_v1'
    repository = 'gthgomez/Babel'
    pr_number = 4242
    base_sha = $baseSha
    head_sha = $headSha
    reviewer_id = 'isolated-reviewer-lane'
    reviewer_class = 'independent_readonly'
    review_mode = 'exact_diff'
    reviewed_at = '2026-09-04T00:00:00Z'
    scope = @('scripts/agent-git-common.psm1', 'feature.txt')
    findings = @('no blocking findings')
    blocking_findings = @()
    verdict = 'APPROVE'
    builder_id = 'codex-implementation'
    challenge_id = 'challenge-integration-0001'
    task_id = 'task-integration'
    run_id = 'run-integration'
    contract_hash = '0f' * 32
    authority_provenance = [ordered]@{ issuer = 'supervisor_review_lane'; key_id = 'integration-supervisor-v1' }
  }
  $payload = [ordered]@{}
  $fieldOrder = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'builder_id', 'challenge_id', 'task_id', 'run_id', 'contract_hash', 'authority_provenance')
  foreach ($fieldName in $fieldOrder) {
    if ($receiptUnsigned.Contains($fieldName)) {
      $fieldValue = $receiptUnsigned[$fieldName]
      if ($fieldName -in @('scope', 'findings', 'blocking_findings')) { $payload[$fieldName] = @($fieldValue) } else { $payload[$fieldName] = $fieldValue }
    }
  }
  $canonical = $payload | ConvertTo-Json -Depth 50 -Compress
  $artifactHash = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical))) -replace '-', '').ToLowerInvariant()
  $receiptWithHash = [ordered]@{}
  foreach ($key in $receiptUnsigned.Keys) { $receiptWithHash[$key] = $receiptUnsigned[$key] }
  $receiptWithHash['artifact_hash'] = $artifactHash
  $reviewSpec = [ordered]@{
    unsignedReceipt = $receiptWithHash
    reviewerPrivateKeyPem = (Get-Content -Raw (Join-Path $root 'reviewer-private.pem'))
    reviewerKeyId = 'integration-reviewer-v1'
    supervisorPrivateKeyPem = (Get-Content -Raw (Join-Path $root 'supervisor-private.pem'))
    supervisorKeyId = 'integration-supervisor-v1'
    challenge = [ordered]@{ challenge_id = 'challenge-integration-0001'; task_id = 'task-integration'; run_id = 'run-integration'; contract_hash = ('0f' * 32); issued_at = '2026-09-01T00:00:00.000Z'; expires_at = '2099-01-01T00:00:00.000Z' }
  }
  $reviewSpecPath = Join-Path $root 'review-spec.json'
  $reviewSpec | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $reviewSpecPath -Encoding utf8NoBOM
  $signedReceiptPath = Join-Path $root 'receipt.json'
  $signedLedgerPath = Join-Path $root 'ledger.json'
  & $node (Join-Path $RepoRoot 'tools/tests/helpers/make-independent-review-evidence.mjs') $reviewSpecPath $signedReceiptPath $signedLedgerPath | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $signedReceiptPath)) { throw 'review evidence signing helper failed' }
  if ($DebugOutputDirectory) {
    New-Item -ItemType Directory -Path $DebugOutputDirectory -Force | Out-Null
    Copy-Item -LiteralPath $signedReceiptPath -Destination (Join-Path $DebugOutputDirectory 'receipt.json') -Force
    Copy-Item -LiteralPath $signedLedgerPath -Destination (Join-Path $DebugOutputDirectory 'ledger.json') -Force
  }

  # ---- gh shim ----
  $shimDir = Join-Path $root 'shim'
  New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
  $rulesetDetail = [ordered]@{
    id = 19597161; name = 'protect-main'; enforcement = 'active'; bypass_actors = @()
    rules = @(
      [ordered]@{ type = 'pull_request'; parameters = [ordered]@{ required_approving_review_count = 0; required_review_thread_resolution = $true; require_code_owner_review = $false; allowed_merge_methods = @('merge'); } },
      [ordered]@{ type = 'required_status_checks'; parameters = [ordered]@{ strict_required_status_checks_policy = $false; required_status_checks = @([ordered]@{ context = 'security' }, [ordered]@{ context = 'public-content-policy' }, [ordered]@{ context = 'linux-validation' }, [ordered]@{ context = 'public-pr-metadata' }, [ordered]@{ context = 'windows-portability' }, [ordered]@{ context = 'trusted-control-plane' }) } }
    )
  }
  $checkRuns = @()
  $peerChecks = @(@('security', 'pull_request'), @('public-content-policy', 'pull_request'), @('linux-validation', 'pull_request'), @('windows-portability', 'pull_request'), @('public-pr-metadata', 'pull_request_target'))
  $runId = 5000
  foreach ($peer in $peerChecks) {
    $runId++
    $checkRuns += [ordered]@{
      name = $peer[0]; head_sha = $headSha; status = 'completed'; conclusion = 'success'; id = [string]$runId
      check_suite = [ordered]@{ id = [string]$runId }; started_at = '2026-09-04T00:00:00Z'; completed_at = '2026-09-04T00:05:00Z'
      event = $peer[1]
      workflow_name = if ($peer[1] -eq 'pull_request_target') { 'Public PR Metadata' } else { 'Public Release Gate' }
      workflow_id = [string]$runId; workflow_run_id = [string]$runId; workflow_run_attempt = 1
      details_url = "https://ci.example.test/runs/$runId"
      app = $null
    }
  }
  $runsJson = [ordered]@{ total_count = $checkRuns.Count; check_runs = $checkRuns }
  $runsJson | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $root 'check-runs.json') -Encoding utf8NoBOM
  $runsById = @()
  foreach ($peer in $peerChecks) {
    $runId++
    $runsById += [ordered]@{ id = $runId; name = $peer[0]; event = $peer[1]; workflow_name = if ($peer[1] -eq 'pull_request_target') { 'Public PR Metadata' } else { 'Public Release Gate' }; workflow_id = [string]$runId; workflow_run_id = [string]$runId; workflow_run_attempt = 1; head_sha = $headSha }
  }
  $runsById | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $root 'run-metadata.json') -Encoding utf8NoBOM

  $shimScript = @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GhArguments)
$ErrorActionPreference = 'Stop'
$root = $env:TCP_TEST_ROOT
$text = $GhArguments -join ' '
function Emit([string]$Value) { Write-Output $Value; exit 0 }
if ($text -match 'repos/gthgomez/Babel --jq') { Emit 'gthgomez/Babel' }
if ($text -match 'repos/gthgomez/Babel$') { Emit '{"full_name":"gthgomez/Babel"}' }
if ($text -match '^repo view') { Emit '{"nameWithOwner":"gthgomez/Babel","defaultBranchRef":{"name":"main"}}' }
if ($text -match '^pr view') { Emit (Get-Content -Raw (Join-Path $root 'pr-view.json')) }
if ($text -match 'rulesets\?per_page') { Emit '[{"name":"protect-main","enforcement":"active","id":19597161}]' }
if ($text -match 'rulesets/19597161') { Emit (Get-Content -Raw (Join-Path $root 'ruleset.json')) }
if ($text -match 'check-runs\?per_page') { Emit (Get-Content -Raw (Join-Path $root 'check-runs.json')) }
if ($text -match 'actions/runs/(\d+)') {
  $id = $Matches[1]
  $runs = Get-Content -Raw (Join-Path $root 'run-metadata.json') | ConvertFrom-Json
  $run = $runs | Where-Object { [string]$_.workflow_run_id -eq $id } | Select-Object -First 1
  if ($run) { Emit ($run | ConvertTo-Json -Depth 10 -Compress) }
  Emit '{}'
}
if ($text -match 'api graphql') {
  Emit '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
}
if ($text -match 'issues/4242/comments') { Emit '[]' }
Emit '{"message":"shim-default"}' | Out-Null
Write-Output '{"message":"shim-default"}'
exit 0
'@
  Set-Content -LiteralPath (Join-Path $shimDir 'gh.ps1') -Value $shimScript -Encoding utf8NoBOM
  # Batch wrapper so PATH resolution finds `gh` on Windows.
  Set-Content -LiteralPath (Join-Path $shimDir 'gh.cmd') -Value ('@echo off' + "`r`n" + 'pwsh -NoProfile -NonInteractive -File "%~dp0gh.ps1" %*') -Encoding ascii
  $prView = [ordered]@{
    number = 4242; url = 'https://github.com/gthgomez/Babel/pull/4242'; state = 'OPEN'; isDraft = $false
    baseRefName = 'main'; baseRefOid = $baseSha; headRefName = 'candidate-head'; headRefOid = $headSha
    mergeable = 'MERGEABLE'; mergeStateStatus = 'CLEAN'; reviewDecision = 'REVIEW_REQUIRED'
    reviews = @(); isCrossRepository = $false; headRepositoryOwner = [ordered]@{ login = 'gthgomez' }; headRepository = [ordered]@{ name = 'Babel' }
  }
  $prView | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath (Join-Path $root 'pr-view.json') -Encoding utf8NoBOM
  $rulesetDetail | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath (Join-Path $root 'ruleset.json') -Encoding utf8NoBOM

  # ---- candidate materialization (exactly like the workflow) ----
  & $git -C $seedPath fetch origin candidate-head 2>&1 | Out-Null
  & $git -C $seedPath worktree add --detach $candidatePath $headSha 2>&1 | Out-Null

  function Invoke-Gate {
    param([string]$Label, [hashtable]$Extra)
    $outputPath = Join-Path $root ("result-{0}.json" -f $Label)
    $argumentList = @(
      '-NoProfile', '-NonInteractive', '-File', (Join-Path $seedPath 'scripts/trusted-merge-gate.ps1'),
      '-PR', '4242', '-BaseSha', $baseSha, '-RepoRoot', $candidatePath, '-ReviewedHeadSha', $headSha,
      '-AuditOnly', '-RequireIsolatedWorktree', '-OutputFormat', 'json'
    )
    foreach ($key in $Extra.Keys) { $argumentList += $key; $argumentList += $Extra[$key] }
    $env:TCP_TEST_ROOT = $root
    $previousPath = $env:PATH
    $env:PATH = "$shimDir;$previousPath"
    # Mirror the trusted workflow environment so the gate's self-check
    # deferral for trusted-control-plane activates exactly as in CI.
    $env:GITHUB_ACTIONS = 'true'
    $env:GITHUB_EVENT_NAME = 'pull_request_target'
    $env:GITHUB_WORKFLOW = 'Trusted Control Plane'
    $env:GITHUB_JOB = 'trusted-control-plane'
    try {
      & pwsh @argumentList *> $outputPath
      $code = $LASTEXITCODE
    } finally {
      $env:PATH = $previousPath
      Remove-Item Env:TCP_TEST_ROOT -ErrorAction SilentlyContinue
      Remove-Item Env:GITHUB_ACTIONS -ErrorAction SilentlyContinue
      Remove-Item Env:GITHUB_EVENT_NAME -ErrorAction SilentlyContinue
      Remove-Item Env:GITHUB_WORKFLOW -ErrorAction SilentlyContinue
      Remove-Item Env:GITHUB_JOB -ErrorAction SilentlyContinue
    }
    $text = (Get-Content -Raw $outputPath)
    if ($DebugOutputDirectory) {
      New-Item -ItemType Directory -Path $DebugOutputDirectory -Force | Out-Null
      Copy-Item -LiteralPath $outputPath -Destination (Join-Path $DebugOutputDirectory ("{0}.txt" -f $Label)) -Force
    }
    $jsonStart = $text.IndexOf('{')
    $jsonEnd = $text.LastIndexOf('}')
    $result = if ($jsonStart -ge 0 -and $jsonEnd -gt $jsonStart) { $text.Substring($jsonStart, $jsonEnd - $jsonStart + 1) | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{ exitCode = $code; result = $result; raw = $text }
  }

  # 1. positive: signed receipt + supervisor-signed upgrade authorization
  Invoke-Step 'trust-upgrade-authorized-passes' {
    $run = Invoke-Gate -Label 'positive' -Extra @{
      '-IndependentReviewReceiptPath' = $signedReceiptPath
      '-ReviewChallengeLedgerPath' = $signedLedgerPath
      '-TrustRootUpgradeAuthorizationPath' = $authorizationPath
    }
    if ($run.exitCode -ne 0) { throw "exit=$($run.exitCode) blockers=$($run.result.blockers -join ',')" }
    if ($run.result.blockers.Count -ne 0) { throw "unexpected blockers: $($run.result.blockers -join ',')" }
    if ($run.result.trustRoot.upgradeAuthorization.valid -ne $true) { throw 'upgrade authorization not reported valid' }
    if ($run.result.reviewPolicy.independentReviewTier -ne 'CERTIFIED') { throw "unexpected tier: $($run.result.reviewPolicy.independentReviewTier)" }
  }

  # 1b. trust-root change with only autonomous evidence must stay blocked.
  Invoke-Step 'trust-change-autonomous-tier-blocked' {
    $run = Invoke-Gate -Label 'autonomous-on-trust' -Extra @{
      '-AutonomousReviewEvidencePath' = $evidencePath; '-TrustRootUpgradeAuthorizationPath' = $authorizationPath
    }
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'independent_review_not_satisfied') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  # 2. missing authorization
  Invoke-Step 'missing-authorization-blocked' {
    $run = Invoke-Gate -Label 'missing-auth' -Extra @{ '-AutonomousReviewEvidencePath' = $evidencePath }
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'protected_trust_root_modified') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  # 3. foreign-key authorization
  Invoke-Step 'foreign-authorization-blocked' {
    $run = Invoke-Gate -Label 'foreign-auth' -Extra @{
      '-AutonomousReviewEvidencePath' = $evidencePath; '-TrustRootUpgradeAuthorizationPath' = $foreignAuthorizationPath
    }
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'protected_trust_root_modified') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  # 4. trust-root change without any review evidence
  Invoke-Step 'trust-change-without-review-blocked' {
    $run = Invoke-Gate -Label 'no-review' -Extra @{ '-TrustRootUpgradeAuthorizationPath' = $authorizationPath }
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'independent_review_not_satisfied') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  # 5. dirty candidate worktree
  Invoke-Step 'dirty-candidate-blocked' {
    Set-Content -LiteralPath (Join-Path $candidatePath 'feature.txt') -Value 'tampered' -Encoding utf8NoBOM
    try {
      $run = Invoke-Gate -Label 'dirty' -Extra @{
        '-AutonomousReviewEvidencePath' = $evidencePath; '-TrustRootUpgradeAuthorizationPath' = $authorizationPath
      }
      if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
      if ($run.result.blockers -notcontains 'dirty_worktree') { throw "blockers=$($run.result.blockers -join ',')" }
    } finally {
      & $git -C $candidatePath checkout -- feature.txt 2>&1 | Out-Null
    }
  }

  Write-Output ''
  if ($failures.Count -gt 0) {
    Write-Output "TRUSTED_CONTROL_PLANE_INTEGRATION_FAIL failures=$($failures -join ',')"
    exit 1
  }
  Write-Output 'TRUSTED_CONTROL_PLANE_INTEGRATION_PASS'
  exit 0
} finally {
  if (Test-Path $root) {
    & $git worktree remove --force $candidatePath 2>$null
    try { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop } catch { Write-Output "warning: temp cleanup deferred ($($_.Exception.Message))" }
  }
}
