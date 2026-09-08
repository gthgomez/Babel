# Offline integration test for the trusted control plane.
#
# Builds a fixture git repository whose BASE commit carries the base-rooted
# gate, materializes the
# candidate as a detached isolated worktree exactly like the GitHub workflow
# does, and runs the real trusted-merge-gate launcher against a shim `gh`
# executable so no network access is needed.
#
# Coverage:
#   1. RED control-plane change + two controller-owned reviews -> audit passes
#   2. one review cannot satisfy RED evidence
#   3. missing review evidence blocks deterministically
#   4. dirty candidate worktree blocks
[CmdletBinding()]
param(
  [string]$RepoRoot = (Join-Path $PSScriptRoot '..\..'),
  [string]$DebugOutputDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$git = (Get-Command git -ErrorAction Stop).Source
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
  foreach ($relative in @('scripts/agent-pr-gate.ps1', 'scripts/agent-pr-gate-common.psm1', 'scripts/agent-review-evidence.ps1', 'scripts/agent-git-common.psm1', 'scripts/trusted-merge-gate.ps1', 'scripts/materialize-independent-review-receipt.ps1')) {
    $target = Join-Path $seedPath $relative
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $RepoRoot $relative) -Destination $target -Force
  }
  Set-Content -LiteralPath (Join-Path $seedPath 'product.txt') -Value 'base product file' -Encoding utf8NoBOM
  & $git -C $seedPath add -A
  & $git -C $seedPath commit -m 'base with merge gate' 2>&1 | Out-Null
  $baseSha = (& $git -C $seedPath rev-parse HEAD).Trim()
  & $git -C $seedPath push origin main 2>&1 | Out-Null
  & $git -C $seedPath update-ref refs/remotes/origin/main $baseSha

  # ---- candidate commit changes the RED control plane (main stays at base) ----
  Add-Content -LiteralPath (Join-Path $seedPath 'scripts/agent-git-common.psm1') -Value '# candidate control-plane change' -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $seedPath 'feature.txt') -Value 'candidate feature' -Encoding utf8NoBOM
  & $git -C $seedPath add -A
  & $git -C $seedPath commit -m 'candidate control-plane change' 2>&1 | Out-Null
  $headSha = (& $git -C $seedPath rev-parse HEAD).Trim()
  & $git -C $seedPath branch candidate-head $headSha
  & $git -C $seedPath push origin candidate-head:refs/heads/candidate-head 2>&1 | Out-Null
  & $git -C $seedPath checkout --detach HEAD 2>&1 | Out-Null

  # ---- controller review evidence computed against the fixture history ----
  $sha256 = [System.Security.Cryptography.SHA256]::Create()

  $numstat = @(& $git -C $seedPath diff --numstat ('{0}...{1}' -f $baseSha, $headSha) | ForEach-Object { [string]$_ })
  $numstatCanonical = (($numstat | Sort-Object) -join "`n")
  $numstatDigest = ([BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($numstatCanonical))) -replace '-', '').ToLowerInvariant()

  $evidencePath = Join-Path $root 'ai-reviews.json'

  $taskHash = 'a' * 64
  $reviewedAt = [DateTimeOffset]::UtcNow.ToString('o')
  $evidence = [ordered]@{
    schema_version = 2
    kind = 'autonomous_review_evidence_v2'
    repository = 'gthgomez/Babel'
    pr_number = 4242
    base_sha = $baseSha
    head_sha = $headSha
    task_id = 'task-4242'
    task_hash = $taskHash
    reviewer_id = 'isolated-ai-reviewer'
    reviewer_class = 'independent_readonly_ai'
    review_mode = 'exact_diff'
    execution_id = 'execution-101'
    review_provider = 'opencode-go'
    reviewer_model = 'deepseek-v4-flash'
    reviewed_at = $reviewedAt
    scope = @('scripts/agent-git-common.psm1', 'feature.txt')
    findings = @('example non-blocking finding')
    blocking_findings = @()
    verdict = 'APPROVE'
    builder_id = 'codex-implementation'
    diff_numstat_digest = $numstatDigest
    isolation = [ordered]@{ mode = 'text_only_no_tools'; candidate_write = $false; github_mutation = $false; merge = $false; controller_state_access = $false }
  }
  $secondEvidence = $evidence | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $secondEvidence.reviewer_id = 'isolated-adversarial-reviewer'
  $secondEvidence.execution_id = 'execution-102'
  $handoff = [ordered]@{
    schema_version = 2; kind = 'host_review_handoff_v2'
    repository = 'gthgomez/Babel'; pr_number = 4242; base_sha = $baseSha; head_sha = $headSha
    task_id = 'task-4242'; task_hash = $taskHash; controller_run_id = 'controller-run-4242'
    reviews = @($evidence, $secondEvidence)
  }
  $bundle = [ordered]@{
    schema_version = 2; kind = 'github_host_review_bundle_v2'
    repository = 'gthgomez/Babel'; pr_number = 4242; base_sha = $baseSha; head_sha = $headSha
    publisher_id = '91163862'; comment_id = '102'; handoff = $handoff
  }
  $bundle | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $evidencePath -Encoding utf8NoBOM
  @{ id = 102; user = @{ id = 91163862; login = 'gthgomez'; type = 'User' }
     issue_url = 'https://api.github.com/repos/gthgomez/Babel/issues/4242'
     body = '<!-- babel-controller-ai-reviews-v2 -->' + ($handoff | ConvertTo-Json -Depth 20 -Compress)
  } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $root 'comment-102.json') -Encoding utf8NoBOM

  # ---- gh shim ----
  $shimDir = Join-Path $root 'shim'
  New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
  $rulesetDetail = [ordered]@{
    id = 19597161; name = 'protect-main'; enforcement = 'active'; bypass_actors = @()
    rules = @(
      [ordered]@{ type = 'pull_request'; parameters = [ordered]@{ required_approving_review_count = 0; required_review_thread_resolution = $true; require_code_owner_review = $false; allowed_merge_methods = @('merge'); } },
      [ordered]@{ type = 'required_status_checks'; parameters = [ordered]@{ strict_required_status_checks_policy = $true; required_status_checks = @([ordered]@{ context = 'security'; integration_id = 15368 }, [ordered]@{ context = 'public-content-policy'; integration_id = 15368 }, [ordered]@{ context = 'linux-validation'; integration_id = 15368 }, [ordered]@{ context = 'public-pr-metadata'; integration_id = 15368 }, [ordered]@{ context = 'windows-portability'; integration_id = 15368 }, [ordered]@{ context = 'trusted-control-plane'; integration_id = 15368 }) } }
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
      app = [ordered]@{ id = 15368; slug = 'github-actions'; name = 'GitHub Actions' }
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
if ($text -match 'repos/gthgomez/Babel$') { Emit '{"full_name":"gthgomez/Babel","owner":{"id":91163862,"type":"User"}}' }
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
if ($text -match 'issues/comments/(\d+)') { Emit (Get-Content -Raw (Join-Path $root ("comment-{0}.json" -f $Matches[1]))) }
if ($text -match 'issues/4242/comments') { Emit (Get-Content -Raw (Join-Path $root 'comments.json')) }
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
    param([string]$Label, [hashtable]$Extra, [string]$EventName = 'pull_request_target')
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
    $env:GITHUB_EVENT_NAME = $EventName
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

  function Invoke-Transport {
    $previousPath = $env:PATH
    $previousTestRoot = $env:TCP_TEST_ROOT
    $env:PATH = "$shimDir;$previousPath"
    $env:TCP_TEST_ROOT = $root
    try {
      $transportDirectory = Join-Path $root 'transport'
      & pwsh -NoProfile -NonInteractive -File (Join-Path $seedPath 'scripts/materialize-independent-review-receipt.ps1') `
        -PR 4242 -Repository gthgomez/Babel -BaseSha $baseSha -HeadSha $headSha `
        -EvidenceDirectory $transportDirectory | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Review transport failed.' }
      return Join-Path $transportDirectory 'ai-reviews.json'
    } finally {
      $env:PATH = $previousPath
      $env:TCP_TEST_ROOT = $previousTestRoot
    }
  }

  Invoke-Step 'transport-filters-untrusted-comments-and-passes-gate' {
    $validComment = Get-Content -Raw (Join-Path $root 'comment-102.json') | ConvertFrom-Json
    $spoof = $validComment | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $spoof.id = 103
    $spoof.user = @{ id = 15368; login = 'github-actions[bot]'; type = 'Bot' }
    $malformed = $validComment | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $malformed.id = 104
    $malformed.user = @{ id = 15368; login = 'github-actions[bot]'; type = 'Bot' }
    $malformed.body = '<!-- babel-controller-ai-reviews-v2 -->{"head_sha":"missing-base"}'
    $stale = $validComment | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $stale.id = 105
    $stale.body = $stale.body.Replace($headSha, ('0' * 40))
    @($validComment, $spoof, $malformed, $stale) | ConvertTo-Json -Depth 30 |
      Set-Content -LiteralPath (Join-Path $root 'comments.json') -Encoding utf8NoBOM
    $transportPath = Invoke-Transport
    $transported = Get-Content -Raw $transportPath | ConvertFrom-Json
    if ($transported.handoff.reviews.Count -ne 2 -or $transported.publisher_id -ne '91163862') { throw 'Transport accepted untrusted comments or lost the owner handoff.' }
    $run = Invoke-Gate -Label 'transport-positive' -Extra @{ '-AutonomousReviewEvidencePath' = $transportPath }
    if ($run.exitCode -ne 0) { throw "Transported evidence did not pass gate: $($run.result.blockers -join ',')" }
  }

  # 1. positive: base-derived RED change with two controller-owned reviews.
  Invoke-Step 'red-controller-reviews-pass' {
    $run = Invoke-Gate -Label 'positive' -Extra @{ '-AutonomousReviewEvidencePath' = $evidencePath }
    if ($run.exitCode -ne 0) { throw "exit=$($run.exitCode) blockers=$($run.result.blockers -join ',')" }
    if ($run.result.blockers.Count -ne 0) { throw "unexpected blockers: $($run.result.blockers -join ',')" }
    if ($run.result.reviewPolicy.effectiveRiskLane -ne 'RED') { throw "unexpected lane: $($run.result.reviewPolicy.effectiveRiskLane)" }
    if ($run.result.reviewPolicy.observedIndependentReviewCount -ne 2) { throw 'two independent reviews were not observed' }
  }

  Invoke-Step 'non-strict-required-check-policy-blocked' {
    $rulesetDetail.rules[1].parameters.strict_required_status_checks_policy = $false
    $rulesetDetail | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath (Join-Path $root 'ruleset.json') -Encoding utf8NoBOM
    try {
      $run = Invoke-Gate -Label 'non-strict-policy' -Extra @{ '-AutonomousReviewEvidencePath' = $evidencePath }
    } finally {
      $rulesetDetail.rules[1].parameters.strict_required_status_checks_policy = $true
      $rulesetDetail | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath (Join-Path $root 'ruleset.json') -Encoding utf8NoBOM
    }
    if ($run.exitCode -eq 0 -or $run.result.blockers -notcontains 'required_status_checks_not_strict') { throw 'Non-strict required checks unexpectedly certified exact-base evidence.' }
  }

  # A comment event cannot represent the required PR check. The separate
  # comment job requests a rerun of the original pull_request_target audit.
  Invoke-Step 'issue-comment-cannot-satisfy-pr-check' {
    $run = Invoke-Gate -Label 'issue-comment' -Extra @{ '-AutonomousReviewEvidencePath' = $evidencePath } -EventName 'issue_comment'
    if ($run.exitCode -eq 0) { throw 'Comment event unexpectedly satisfied the PR check.' }
  }

  # 2. A RED change cannot self-downgrade to one review.
  Invoke-Step 'red-one-review-blocked' {
    $oneReviewPath = Join-Path $root 'ai-review-one.json'
    $oneReviewBundle = $bundle | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $oneReviewBundle.comment_id = '106'
    $oneReviewBundle.handoff.reviews = @($oneReviewBundle.handoff.reviews[0])
    $oneReviewBundle | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $oneReviewPath -Encoding utf8NoBOM
    @{ id = 106; user = @{ id = 91163862; login = 'gthgomez'; type = 'User' }
       issue_url = 'https://api.github.com/repos/gthgomez/Babel/issues/4242'
       body = '<!-- babel-controller-ai-reviews-v2 -->' + ($oneReviewBundle.handoff | ConvertTo-Json -Depth 20 -Compress)
    } | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $root 'comments.json') -Encoding utf8NoBOM
    try {
      $run = Invoke-Gate -Label 'one-review' -Extra @{ '-AutonomousReviewEvidencePath' = $oneReviewPath }
    } finally {
      Get-Content -Raw (Join-Path $root 'comment-102.json') | Set-Content -LiteralPath (Join-Path $root 'comments.json') -Encoding utf8NoBOM
    }
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'independent_review_not_satisfied') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  # 3. A local bundle from a different owner cannot impersonate the live owner handoff.
  Invoke-Step 'wrong-owner-bundle-blocked' {
    $wrongControllerPath = Join-Path $root 'ai-review-wrong-controller.json'
    $wrongControllerBundle = $bundle | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $wrongControllerBundle.publisher_id = '15368'
    $wrongControllerBundle | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $wrongControllerPath -Encoding utf8NoBOM
    $run = Invoke-Gate -Label 'wrong-controller' -Extra @{ '-AutonomousReviewEvidencePath' = $wrongControllerPath }
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'independent_review_not_satisfied') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  Invoke-Step 'forged-local-review-body-blocked' {
    $forgedPath = Join-Path $root 'forged-reviews.json'
    $forged = $bundle | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $forged.handoff.reviews[0].scope = @('forged local scope')
    $forged | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $forgedPath -Encoding utf8NoBOM
    $run = Invoke-Gate -Label 'forged-body' -Extra @{ '-AutonomousReviewEvidencePath' = $forgedPath }
    if ($run.exitCode -eq 0 -or $run.result.reviewPolicy.independentReviewEvidenceErrors -notcontains 'controller_review_live_provenance_mismatch') { throw 'Forged review body was not rejected by live provenance validation.' }
  }

  # 4. Missing controller evidence fails closed.
  Invoke-Step 'missing-review-blocked' {
    $run = Invoke-Gate -Label 'missing-review' -Extra @{}
    if ($run.exitCode -eq 0) { throw 'audit unexpectedly passed' }
    if ($run.result.blockers -notcontains 'independent_review_not_satisfied') { throw "blockers=$($run.result.blockers -join ',')" }
  }

  # 5. dirty candidate worktree
  Invoke-Step 'dirty-candidate-blocked' {
    Set-Content -LiteralPath (Join-Path $candidatePath 'feature.txt') -Value 'tampered' -Encoding utf8NoBOM
    try {
      $run = Invoke-Gate -Label 'dirty' -Extra @{ '-AutonomousReviewEvidencePath' = $evidencePath }
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
