[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$chatReviewController = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '..\babel-pr-review.mts')
if ($chatReviewController -notmatch [regex]::Escape("gitAt(trustedRoot, ['merge-base', '--is-ancestor', trustedSha, baseSha])") -or
    $chatReviewController -notmatch 'TRUSTED_REVIEW_SOURCE_NOT_IN_BASE_HISTORY') {
  throw 'Babel review controller must reject a trusted installation that is not in the PR base history before cache or provider use.'
}
$env:GIT_ALLOW_PROTOCOL = 'file'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$gitCandidate = 'C:\Program Files\Git\cmd\git.exe'
$git = if (Test-Path -LiteralPath $gitCandidate -PathType Leaf) { $gitCandidate } else { (Get-Command git -ErrorAction Stop).Source }
$tempRoot = Join-Path $repoRoot ('.tmp-agent-git-readiness-' + [Guid]::NewGuid().ToString('N'))
$fakeGh = Join-Path $tempRoot 'fake-gh.ps1'
$fakeGhAuthFailure = Join-Path $tempRoot 'fake-gh-auth-failure.ps1'
$remote = Join-Path $tempRoot 'remote.git'
$fixture = Join-Path $tempRoot 'fixture'
$worktrees = Join-Path $tempRoot 'worktrees'

function Assert-AgentTest {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Invoke-TestGit {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string[]]$Arguments,
    [switch]$IgnoreFailure
  )
  Push-Location -LiteralPath $WorkingDirectory
  try {
    $output = @(& $git @Arguments 2>&1 | ForEach-Object { [string]$_ })
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($exitCode -ne 0 -and -not $IgnoreFailure) { throw "git failed ($exitCode) [$($Arguments -join ' ')]: $($output -join ' ')" }
  return (($output -join "`n").Trim())
}

function Invoke-TestScript {
  param([Parameter(Mandatory = $true)][string]$Script, [Parameter(Mandatory = $true)][string[]]$Arguments)
  $quotedArguments = @($Arguments | ForEach-Object {
      if ([string]$_ -match '^-[A-Za-z]') { [string]$_ } else { "'$(($_ -replace "'", "''"))'" }
    }) -join ' '
  $command = "& '$($Script -replace "'", "''")' $quotedArguments"
  $output = @(& $pwsh -NoLogo -NoProfile -Command $command 2>&1 | ForEach-Object { [string]$_ })
  return [pscustomobject]@{
    exitCode = $LASTEXITCODE
    text = ($output -join "`n")
  }
}

function Get-FixtureExactDiffCoverage {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$BaseSha,
    [Parameter(Mandatory = $true)][string]$HeadSha
  )
  # Mirror the hash/line computation in scripts/agent-pr-gate-common.psm1
  # Get-AgentExactDiffCoverage so the fixture's claimed coverage matches the
  # gate's live diff. Unlike production, this fixture copy omits the 100MB
  # EXACT_DIFF_TOO_LARGE size guard; the byte hashing and line counting match.
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $git
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($arg in @('diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', "$BaseSha...$HeadSha")) {
    [void]$start.ArgumentList.Add($arg)
  }
  $process = [Diagnostics.Process]::Start($start)
  try {
    $stderr = $process.StandardError.ReadToEndAsync()
    $buffer = [IO.MemoryStream]::new()
    try {
      $process.StandardOutput.BaseStream.CopyTo($buffer)
      $process.WaitForExit()
      if ($process.ExitCode -ne 0) { throw "EXACT_DIFF_UNAVAILABLE: $($stderr.GetAwaiter().GetResult())" }
      $bytes = $buffer.ToArray()
      $hash = [Security.Cryptography.SHA256]::HashData($bytes)
      $lines = 0
      foreach ($byte in $bytes) { if ($byte -eq 10) { $lines++ } }
      if ($bytes.Length -gt 0 -and $bytes[$bytes.Length - 1] -ne 10) { $lines++ }
      return [pscustomobject]@{
        sha256 = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
        lines = $lines
      }
    } finally { $buffer.Dispose() }
  } finally { $process.Dispose() }
}

try {
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Invoke-TestGit -WorkingDirectory $tempRoot -Arguments @('init', '--bare', '--initial-branch=main', $remote) | Out-Null
  New-Item -ItemType Directory -Path $fixture -Force | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('init', '--initial-branch=main') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', 'user.name', 'Babel Agent Readiness Test') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', 'user.email', 'agent-readiness@example.invalid') | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'README.md') -Value '# fixture' -Encoding utf8
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('add', 'README.md') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('commit', '-m', 'fixture base') | Out-Null
  $mainSha = Invoke-TestGit -WorkingDirectory $fixture -Arguments @('rev-parse', 'HEAD')
  Copy-Item -Path (Join-Path $fixture '.git\objects\*') -Destination (Join-Path $remote 'objects') -Recurse -Force
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('remote', 'add', 'origin', 'https://github.com/gthgomez/Babel.git') | Out-Null
  $mappedRemote = if ($IsWindows) { 'file:///' + ([IO.Path]::GetFullPath($remote)).Replace('\', '/') } else { 'file://' + [IO.Path]::GetFullPath($remote) }
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', "url.$mappedRemote.insteadOf", 'https://github.com/gthgomez/Babel.git') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', '--add', "url.$mappedRemote.insteadOf", 'https://github.com/gthgomez/Babel') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', 'protocol.file.allow', 'always') | Out-Null
  Invoke-TestGit -WorkingDirectory $remote -Arguments @('update-ref', 'refs/heads/main', $mainSha) | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('switch', '-c', 'agent/fixture') | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'change.txt') -Value 'change' -Encoding utf8
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('add', 'change.txt') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('commit', '-m', 'fixture change') | Out-Null
  $headSha = Invoke-TestGit -WorkingDirectory $fixture -Arguments @('rev-parse', 'HEAD')
  Copy-Item -Path (Join-Path $fixture '.git\objects\*') -Destination (Join-Path $remote 'objects') -Recurse -Force
  Invoke-TestGit -WorkingDirectory $remote -Arguments @('update-ref', 'refs/heads/agent/fixture', $headSha) | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', '--local', '--unset-all', 'credential.helper') -IgnoreFailure | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', '--local', '--add', 'credential.helper', '') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', '--local', '--add', 'credential.helper', '!gh auth git-credential') | Out-Null

  @(
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)',
    'if ($Arguments.Count -gt 0 -and $Arguments[0] -eq "--version") { Write-Output "gh version 2.97.0"; exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "auth" -and $Arguments[1] -eq "status") { exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "repo" -and $Arguments[1] -eq "view") { Write-Output ''{"nameWithOwner":"gthgomez/Babel","defaultBranchRef":{"name":"main"}}''; exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "api" -and $Arguments[1] -eq "repos/gthgomez/Babel") { Write-Output "gthgomez/Babel"; exit 0 }',
    'exit 1') | Set-Content -LiteralPath $fakeGh -Encoding utf8

  $preflightScript = Join-Path $repoRoot 'scripts\agent-preflight.ps1'
  $preflightRun = Invoke-TestScript -Script $preflightScript -Arguments @(
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-GhPath', $fakeGh,
    '-ExpectedBranch', 'agent/fixture',
    '-ExpectedHeadSha', $headSha,
    '-ExpectedBaseSha', $mainSha
  )
  Assert-AgentTest ($preflightRun.exitCode -eq 0) "preflight should pass: $($preflightRun.text)"
  $preflight = $preflightRun.text | ConvertFrom-Json
  Assert-AgentTest ([bool]$preflight.ok) 'preflight result should be ok'
  Assert-AgentTest ([bool]$preflight.pushReady) 'preflight should be push-ready'
  Assert-AgentTest ([bool]$preflight.checks.AUTH_OK) 'preflight should verify GitHub auth'
  Assert-AgentTest ([bool]$preflight.checks.REMOTE_OK) 'preflight should verify the remote repository'
  Assert-AgentTest ([bool]$preflight.checks.REMOTE_CREDENTIAL_FREE) 'preflight should reject credential-bearing remotes'
  Assert-AgentTest ([bool]$preflight.checks.CREDENTIAL_PROVIDER_GH) 'preflight should verify repo-local gh credentials'
  Assert-AgentTest ([string]$preflight.head -eq $headSha) 'preflight should report local HEAD'

  Set-Content -LiteralPath (Join-Path $fixture 'dirty.txt') -Value 'dirty' -Encoding utf8
  $statusScript = Join-Path $repoRoot 'scripts\agent-git-status.ps1'
  $statusRun = Invoke-TestScript -Script $statusScript -Arguments @('-RepoRoot', $fixture, '-GitPath', $git, '-ExpectedRepository', 'gthgomez/Babel')
  Assert-AgentTest ($statusRun.exitCode -eq 0) "status should report successfully: $($statusRun.text)"
  $status = $statusRun.text | ConvertFrom-Json
  Assert-AgentTest (-not [bool]$status.worktree.clean) 'status should identify a dirty worktree'
  Assert-AgentTest (@($status.worktree.dirtyPaths) -contains 'dirty.txt') 'status should report the dirty path'
  Remove-Item -LiteralPath (Join-Path $fixture 'dirty.txt') -Force

  $worktreeScript = Join-Path $repoRoot 'scripts\agent-worktree.ps1'
  $worktreeRun = Invoke-TestScript -Script $worktreeScript -Arguments @(
    '-Action', 'create',
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-ExpectedRepository', 'gthgomez/Babel',
    '-WorktreeRoot', $worktrees,
    '-Name', 'fixture-isolated'
  )
  Assert-AgentTest ($worktreeRun.exitCode -eq 0) "worktree create should pass: $($worktreeRun.text)"
  $worktree = $worktreeRun.text | ConvertFrom-Json
  Assert-AgentTest ([bool]$worktree.ok) 'worktree create should be ok'
  Assert-AgentTest ([bool]$worktree.isolated) 'created worktree should be isolated'
  Assert-AgentTest (Test-Path -LiteralPath $worktree.path -PathType Container) 'created worktree path should exist'
  $isolatedPreflightRun = Invoke-TestScript -Script $preflightScript -Arguments @(
    '-RepoRoot', $worktree.path,
    '-GitPath', $git,
    '-GhPath', $fakeGh,
    '-ExpectedBranch', 'agent/fixture-isolated',
    '-ExpectedHeadSha', $worktree.head,
    '-ExpectedBaseSha', $mainSha
  )
  Assert-AgentTest ($isolatedPreflightRun.exitCode -eq 0) "isolated preflight should pass: $($isolatedPreflightRun.text)"
  $isolatedPreflight = $isolatedPreflightRun.text | ConvertFrom-Json
  Assert-AgentTest ([bool]$isolatedPreflight.checks.WORKTREE_ISOLATED) 'isolated preflight should identify linked worktree'
  Assert-AgentTest ([bool]$isolatedPreflight.checks.CREDENTIAL_PROVIDER_GH) 'isolated preflight should inherit repo-local gh credentials'
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('worktree', 'remove', $worktree.path) | Out-Null

  $prJson = '{"number":42,"url":"https://github.com/gthgomez/Babel/pull/42","state":"OPEN","isDraft":false,"baseRefName":"main","baseRefOid":"' + $mainSha + '","headRefName":"agent/fixture","headRefOid":"' + $headSha + '","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","reviews":[],"isCrossRepository":false,"headRepositoryOwner":{"login":"gthgomez"},"headRepository":{"nameWithOwner":"gthgomez/Babel"}}'
  $rulesetList = '[{"id":19597161,"name":"protect-main","enforcement":"active"}]'
  $rulesetDetail = '{"id":19597161,"name":"protect-main","enforcement":"active","rules":[{"type":"pull_request","parameters":{"required_approving_review_count":0,"required_review_thread_resolution":true,"require_code_owner_review":false,"allowed_merge_methods":["merge","squash","rebase"]}},{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":true,"required_status_checks":[{"context":"security","integration_id":15368},{"context":"public-content-policy","integration_id":15368},{"context":"linux-validation","integration_id":15368},{"context":"public-pr-metadata","integration_id":15368},{"context":"windows-portability","integration_id":15368}]}}],"bypass_actors":[]}'
  $graphqlJson = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}'
  $checkItems = @()
  $checkItems += '{"app":{"id":15368,"slug":"github-actions","name":"GitHub Actions"},"id":101,"name":"security","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"101","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"app":{"id":15368,"slug":"github-actions","name":"GitHub Actions"},"id":102,"name":"public-content-policy","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"102","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"app":{"id":15368,"slug":"github-actions","name":"GitHub Actions"},"id":103,"name":"linux-validation","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"103","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"app":{"id":15368,"slug":"github-actions","name":"GitHub Actions"},"id":104,"name":"public-pr-metadata","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request_target","workflow_name":"Public PR Metadata","workflow_id":"workflow-2","workflow_run_id":"104","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"app":{"id":15368,"slug":"github-actions","name":"GitHub Actions"},"id":105,"name":"windows-portability","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"105","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkJson = '{"check_runs":[' + ($checkItems -join ',') + ']}'
  # GREEN candidates now need real-shaped owner-controller chat evidence too.
  # Keep it outside the candidate, bind its actual diff, and use the fixture's
  # merged base as the independently installed reviewer source.
  $numstat = Invoke-TestGit -WorkingDirectory $fixture -Arguments @('diff', '--no-ext-diff', '--no-textconv', '--numstat', "$mainSha...$headSha")
  $canonicalNumstat = (($numstat -split '\r?\n' | Sort-Object) -join "`n")
  $numstatDigest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonicalNumstat))).ToLowerInvariant()
  # V3 independent-agent review evidence. The owner-authenticated host handoff
  # wraps one independent_agent_review_v3 that binds the exact diff, and the
  # cached bundle must byte-match what Select-AgentHostReviewBundle reconstructs
  # from the live owner comment.
  $candidateDigest = ('c' * 64)
  $exactDiff = Get-FixtureExactDiffCoverage -WorkingDirectory $fixture -BaseSha $mainSha -HeadSha $headSha
  $review = [ordered]@{
    schema_version = 3; kind = 'independent_agent_review_v3'
    provenance = 'OWNER_AUTHENTICATED_GITHUB_EVIDENCE'
    repository = 'gthgomez/Babel'; pr_number = 42; base_sha = $mainSha; head_sha = $headSha
    candidate_digest = $candidateDigest; diff_numstat_digest = $numstatDigest
    task_id = 'fixture-task-42'; task_hash = ('a' * 64)
    builder = [ordered]@{ kind = 'codex'; principal_id = 'codex-builder-p1'; execution_id = 'codex-builder-e1' }
    reviewer = [ordered]@{ kind = 'codex'; principal_id = 'codex-reviewer-p2'; execution_id = 'codex-reviewer-e2' }
    controller_run_id = 'fixture-controller-42'; challenge_id = 'challenge-42-a'
    runtime = [ordered]@{
      agent_kind = 'codex'; adapter_id = 'codex-subagent-v1'
      controller_execution_id = 'codex-reviewer-e2'; execution_purpose = 'FINAL_CERTIFICATION'
      requested_provider = 'openai'; observed_provider = 'openai'
      requested_model = 'gpt-5-codex'; observed_model = 'gpt-5-codex'; model_attribution = 'observed'
      provider_execution_id = 'codex-child-session-1'; session_id = 'codex-child-session-1'
      parent_execution_id = 'codex-builder-e1'; source_sha = $mainSha
      fresh_context = $true; fresh_process = $true; read_only_enforced = $true
    }
    review_mode = 'exact_diff'; execution_purpose = 'FINAL_CERTIFICATION'
    reviewed_at = [DateTimeOffset]::UtcNow.ToString('o'); scope = @('change.txt')
    verdict = 'APPROVE'; findings = @(); blocking_findings = @()
    coverage = [ordered]@{
      diff_consumed = $true; diff_sha256 = $exactDiff.sha256
      diff_lines_total = $exactDiff.lines; diff_lines_read = $exactDiff.lines
      changed_paths = 1; source_paths_opened = @()
    }
    isolation = [ordered]@{ candidate_write = $false; github_mutation = $false; merge = $false; controller_state_access = $false }
  }
  $handoff = [ordered]@{
    schema_version = 3; kind = 'host_review_handoff_v3'
    provenance = 'OWNER_AUTHENTICATED_GITHUB_EVIDENCE'
    repository = 'gthgomez/Babel'; pr_number = 42; base_sha = $mainSha; head_sha = $headSha
    candidate_digest = $candidateDigest; diff_numstat_digest = $numstatDigest
    task_id = 'fixture-task-42'; task_hash = ('a' * 64)
    controller_run_id = 'fixture-controller-42'; reviews = @($review)
  }
  $evidencePath = Join-Path $tempRoot 'pr-42.ai-reviews.json'
  [ordered]@{
    schema_version = 3; kind = 'github_host_review_bundle_v3'
    repository = 'gthgomez/Babel'; pr_number = 42; base_sha = $mainSha; head_sha = $headSha
    candidate_digest = $candidateDigest; publisher_id = '91163862'; comment_id = '4242'
    provenance = 'OWNER_AUTHENTICATED_GITHUB_EVIDENCE'; handoff = $handoff
  } | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $evidencePath -Encoding utf8
  $reviewComment = [ordered]@{
    id = 4242; user = [ordered]@{ id = 91163862; type = 'User'; login = 'gthgomez' }
    issue_url = 'https://api.github.com/repos/gthgomez/Babel/issues/42'
    body = '<!-- babel-controller-independent-review-v3 -->' + ($handoff | ConvertTo-Json -Depth 40 -Compress)
  }
  $commentsPath = Join-Path $tempRoot 'pr-42-comments.json'
  ConvertTo-Json -InputObject @($reviewComment) -Depth 40 | Set-Content -LiteralPath $commentsPath -Encoding utf8
  @(
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)',
    'if ($Arguments.Count -gt 0 -and $Arguments[0] -eq "--version") { Write-Output "gh version 2.97.0"; exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "auth" -and $Arguments[1] -eq "status") { exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "repo" -and $Arguments[1] -eq "view") { Write-Output ''{"nameWithOwner":"gthgomez/Babel","defaultBranchRef":{"name":"main"}}''; exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "api" -and $Arguments[1] -eq "repos/gthgomez/Babel") { if ($Arguments -contains "--jq") { Write-Output "gthgomez/Babel" } else { Write-Output ''{"full_name":"gthgomez/Babel","owner":{"id":91163862,"type":"User"}}'' }; exit 0 }',
    "if (`$Arguments.Count -gt 1 -and `$Arguments[0] -eq 'api' -and `$Arguments[1] -like 'repos/gthgomez/Babel/issues/42/comments?per_page=*') { Get-Content -Raw -LiteralPath '$($commentsPath -replace "'", "''")'; exit 0 }",
    "if (`$Arguments.Count -gt 1 -and `$Arguments[0] -eq 'pr' -and `$Arguments[1] -eq 'view') { Write-Output '$prJson'; exit 0 }",
    "if (`$Arguments.Count -gt 1 -and `$Arguments[0] -eq 'api' -and `$Arguments[1] -eq 'graphql') { Write-Output '$graphqlJson'; exit 0 }",
    "if (`$Arguments.Count -gt 1 -and `$Arguments[0] -eq 'api' -and `$Arguments[1] -like '*rulesets/19597161') { Write-Output '$rulesetDetail'; exit 0 }",
    "if (`$Arguments.Count -gt 1 -and `$Arguments[0] -eq 'api' -and `$Arguments[1] -like '*rulesets?per_page=*') { Write-Output '$rulesetList'; exit 0 }",
    "if (`$Arguments.Count -gt 0 -and `$Arguments[0] -eq 'api') { Write-Output '$checkJson'; exit 0 }",
    'exit 1') | Set-Content -LiteralPath $fakeGh -Encoding utf8

  $prGateScript = Join-Path $repoRoot 'scripts\agent-pr-gate.ps1'
  $fakeCheckRun = Invoke-TestScript -Script $fakeGh -Arguments @('api', 'fixture')
  Assert-AgentTest ($fakeCheckRun.exitCode -eq 0) "fake gh api should pass: $($fakeCheckRun.text)"
  Assert-AgentTest ($null -ne ($fakeCheckRun.text | ConvertFrom-Json).check_runs) 'fake gh api should return check runs'
  $gateArguments = @(
    '-PR', '42',
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-GhPath', $fakeGh,
    '-ReviewedHeadSha', $headSha,
    '-RiskTier', 'LOW'
  )
  $gateRun = Invoke-TestScript -Script $prGateScript -Arguments ($gateArguments + @('-AutonomousReviewEvidencePath', $evidencePath))
  Assert-AgentTest ($gateRun.exitCode -eq 0) "PR gate should pass: $($gateRun.text)"
  $gate = $gateRun.text | ConvertFrom-Json
  Assert-AgentTest ([string]$gate.status -eq 'MERGE_READY') 'PR gate should report MERGE_READY'
  Assert-AgentTest ([bool]$gate.checks.PR_HEAD_REVIEWED) 'PR gate should bind review to PR head'
  Assert-AgentTest ([bool]$gate.checks.REMOTE_HEAD_MATCH) 'PR gate should bind remote branch to PR head'
  Assert-AgentTest ([bool]$gate.checks.CI_HEAD_MATCH) 'PR gate should bind CI to PR head'
  Assert-AgentTest ([bool]$gate.checks.REQUIRED_CHECKS_GREEN) 'PR gate should require all configured checks'
  Assert-AgentTest ([bool]$gate.checks.BASE_NOT_INVALIDATED) 'PR gate should verify the base SHA'
  Assert-AgentTest (-not [bool]$gate.reviewPolicy.independentReviewRequired -and $gate.reviewPolicy.minimumIndependentReviewCount -eq 1) 'custom review evidence is advisory; its validator retains one-review floor'
  Assert-AgentTest ([bool]$gate.reviewPolicy.independentReviewSatisfied -and $gate.reviewPolicy.observedIndependentReviewCount -eq 1) 'PR gate should accept the owner-provenance chat fixture'

  $missingEvidenceRun = Invoke-TestScript -Script $prGateScript -Arguments $gateArguments
  Assert-AgentTest ($missingEvidenceRun.exitCode -eq 0) 'a green exact-head PR without custom evidence must be ready'
  $missingEvidence = $missingEvidenceRun.text | ConvertFrom-Json
  Assert-AgentTest ($missingEvidence.status -eq 'MERGE_READY' -and -not [bool]$missingEvidence.reviewPolicy.independentReviewSatisfied) 'missing advisory evidence stays invalid without blocking readiness'
  Assert-AgentTest (@($missingEvidence.reviewPolicy.independentReviewEvidenceErrors) -contains 'autonomous_review_evidence_missing') 'missing evidence diagnostic must remain visible'

  $fakeGhHealthy = Get-Content -Raw -LiteralPath $fakeGh
  try {
    $fakeGhHealthy.Replace('"conclusion":"success"', '"conclusion":"failure"') | Set-Content -LiteralPath $fakeGh -Encoding utf8
    $failedCiRun = Invoke-TestScript -Script $prGateScript -Arguments $gateArguments
    $failedCi = $failedCiRun.text | ConvertFrom-Json
    Assert-AgentTest ($failedCiRun.exitCode -eq 1 -and $failedCi.status -eq 'BLOCKED') 'failed required CI remains blocking without custom evidence'
    Assert-AgentTest (-not [bool]$failedCi.checks.REQUIRED_CHECKS_GREEN) 'failed CI cannot be reported green'
  } finally { $fakeGhHealthy | Set-Content -LiteralPath $fakeGh -Encoding utf8 }
  # A draft audit must never read peer check runs, even when they happen to be
  # green. Keep the fake API observable so a false PASS or polling regression
  # fails without waiting for the production timeout.
  $checkReadLog = Join-Path $tempRoot 'check-reads.txt'
  $draftGh = $fakeGhHealthy.Replace('"isDraft":false', '"isDraft":true')
  $draftGh = $draftGh.Replace("Write-Output '$checkJson'", "Add-Content -LiteralPath '$($checkReadLog -replace "'", "''")' -Value 'read'; Write-Output '$checkJson'")
  try {
    $draftGh | Set-Content -LiteralPath $fakeGh -Encoding utf8
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $draftRun = Invoke-TestScript -Script $prGateScript -Arguments ($gateArguments + @('-AuditOnly'))
    $clock.Stop()
    $draft = $draftRun.text | ConvertFrom-Json
    Assert-AgentTest ($draftRun.exitCode -eq 1 -and $draft.status -eq 'BLOCKED' -and -not $draft.mergeReady) 'draft audit must return BLOCKED'
    Assert-AgentTest (@($draft.blockers) -contains 'pr_is_draft') 'draft audit must explain the draft blocker'
    Assert-AgentTest (-not (Test-Path -LiteralPath $checkReadLog)) 'draft audit must not poll or read check runs'
    Assert-AgentTest (@($draft.requiredChecks).Count -eq 0 -and $null -eq $draft.sha.ciHead) 'unobserved checks must not be reported PASS or bound to CI'
    Assert-AgentTest (-not ($draft.checks.PSObject.Properties.Name -contains 'REQUIRED_CHECKS_READY')) 'draft audit must not invent readiness'
    Assert-AgentTest (@($draft.blockers) -notcontains 'required_check_wait_timeout') 'draft audit must not invent a timeout'
    Assert-AgentTest ($draft.checks.PR_HEAD_REVIEWED -and $draft.checks.REMOTE_HEAD_MATCH -and $draft.checks.BASE_NOT_INVALIDATED) 'draft audit must first bind authoritative metadata and heads'
    Write-Output ("draft-audit elapsed: {0:N3}s; peer check reads: 0" -f $clock.Elapsed.TotalSeconds)
    foreach ($case in @(
      @{ Text = $draftGh.Replace('"headRefOid":"' + $headSha + '"', '"headRefOid":"' + $mainSha + '"'); Blocker = 'reviewed_head_does_not_match_pr_head' },
      @{ Text = $draftGh.Replace('"baseRefOid":"' + $mainSha + '"', '"baseRefOid":"' + $headSha + '"'); Blocker = 'pr_base_sha_is_stale' },
      @{ Text = $draftGh.Replace('"state":"OPEN"', '"state":"CLOSED"'); Blocker = 'pr_not_open' }
    )) {
      $case.Text | Set-Content -LiteralPath $fakeGh -Encoding utf8
      $caseRun = Invoke-TestScript -Script $prGateScript -Arguments ($gateArguments + @('-AuditOnly'))
      $caseResult = $caseRun.text | ConvertFrom-Json
      Assert-AgentTest ($caseRun.exitCode -eq 1 -and -not $caseResult.mergeReady -and @($caseResult.blockers) -contains $case.Blocker) "draft shortcut must preserve $($case.Blocker)"
      Assert-AgentTest (-not (Test-Path -LiteralPath $checkReadLog) -and $null -eq $caseResult.sha.ciHead) 'draft metadata failure must not read or certify CI'
    }
    $draftGh | Set-Content -LiteralPath $fakeGh -Encoding utf8
    $draftMergeRun = Invoke-TestScript -Script $prGateScript -Arguments $gateArguments
    $draftMerge = $draftMergeRun.text | ConvertFrom-Json
    Assert-AgentTest ($draftMergeRun.exitCode -eq 1 -and -not $draftMerge.mergeReady -and (Test-Path -LiteralPath $checkReadLog)) 'non-audit draft gate must retain full checks and still block'
  } finally { $fakeGhHealthy | Set-Content -LiteralPath $fakeGh -Encoding utf8 }

  foreach ($auditMode in @($false, $true)) {
    $auditArgs = @()
    if ($auditMode) { $auditArgs = @('-AuditOnly') }
    foreach ($case in @(
      @{ Text = $fakeGhHealthy.Replace('"conclusion":"success"', '"conclusion":"failure"'); Blocker = 'required_checks_not_green' },
      @{ Text = $fakeGhHealthy.Replace('"id":15368', '"id":99999'); Blocker = 'required_checks_not_green' },
      @{ Text = $fakeGhHealthy.Replace('"state":"OPEN"', '"state":"CLOSED"'); Blocker = 'pr_not_open' },
      @{ Text = $fakeGhHealthy.Replace('"mergeable":"MERGEABLE"', '"mergeable":"CONFLICTING"'); Blocker = 'pr_not_mergeable' },
      @{ Text = $fakeGhHealthy.Replace('"baseRefOid":"' + $mainSha + '"', '"baseRefOid":"' + $headSha + '"'); Blocker = 'pr_base_sha_is_stale' }
    )) {
      try {
        $case.Text | Set-Content -LiteralPath $fakeGh -Encoding utf8
        $caseRun = Invoke-TestScript -Script $prGateScript -Arguments ($gateArguments + $auditArgs)
        $caseResult = $caseRun.text | ConvertFrom-Json
        Assert-AgentTest ($caseRun.exitCode -eq 1 -and -not $caseResult.mergeReady -and @($caseResult.blockers) -contains $case.Blocker) "audit/merge must retain $($case.Blocker)"
      } finally { $fakeGhHealthy | Set-Content -LiteralPath $fakeGh -Encoding utf8 }
    }
  }
  $malformedPath = Join-Path $tempRoot 'malformed-review.json'
  '{malformed' | Set-Content -LiteralPath $malformedPath -Encoding utf8
  $malformedRun = Invoke-TestScript -Script $prGateScript -Arguments ($gateArguments + @('-AutonomousReviewEvidencePath', $malformedPath))
  $malformed = $malformedRun.text | ConvertFrom-Json
  Assert-AgentTest ($malformedRun.exitCode -eq 0 -and -not [bool]$malformed.reviewPolicy.independentReviewSatisfied) 'malformed advisory evidence stays invalid without blocking green readiness'

  $zeroSha = [string]::new('0', 40)
  $blockedRun = Invoke-TestScript -Script $prGateScript -Arguments @(
    '-PR', '42',
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-GhPath', $fakeGh,
    '-ReviewedHeadSha', $zeroSha,
    '-AutonomousReviewEvidencePath', $evidencePath,
    '-RiskTier', 'LOW'
  )
  Assert-AgentTest ($blockedRun.exitCode -eq 1) 'PR gate should block a reviewed-head mismatch'
  $blocked = $blockedRun.text | ConvertFrom-Json
  Assert-AgentTest ([string]$blocked.status -eq 'BLOCKED') 'mismatched review should report BLOCKED'
  Assert-AgentTest (@($blocked.blockers) -contains 'reviewed_head_does_not_match_pr_head') 'mismatched review should identify its blocker'

  @(
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)',
    'if ($Arguments.Count -gt 0 -and $Arguments[0] -eq "--version") { Write-Output "gh version 2.97.0"; exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "auth" -and $Arguments[1] -eq "status") { exit 1 }',
    'exit 1') | Set-Content -LiteralPath $fakeGhAuthFailure -Encoding utf8
  $authFailureRun = Invoke-TestScript -Script $prGateScript -Arguments @(
    '-PR', '42',
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-GhPath', $fakeGhAuthFailure,
    '-ReviewedHeadSha', $headSha
  )
  Assert-AgentTest ($authFailureRun.exitCode -eq 1) 'PR gate should block a GitHub authentication failure'
  $authFailure = $authFailureRun.text | ConvertFrom-Json
  Assert-AgentTest ([string]$authFailure.status -eq 'BLOCKED') 'auth failure should report BLOCKED'
  Assert-AgentTest (-not [bool]$authFailure.mergeReady) 'auth failure must not report mergeReady'
  Assert-AgentTest (@($authFailure.blockers) -contains 'github_auth_failed') 'auth failure should identify github_auth_failed'
  Assert-AgentTest ($authFailureRun.text -notmatch 'PropertyNotFound') 'auth failure must not produce a secondary property exception'

  # Review-size advice must not become a publication/staging gate. Exercise the
  # real planner with a tracked 1,544-line delta and 31 files, independently
  # crossing each threshold. Unknown-path disposition remains a separate guard.
  $planFixture = Join-Path $tempRoot 'plan-fixture'
  New-Item -ItemType Directory -Path (Join-Path $planFixture 'tools') -Force | Out-Null
  Invoke-TestGit -WorkingDirectory $planFixture -Arguments @('init', '--initial-branch=main') | Out-Null
  Invoke-TestGit -WorkingDirectory $planFixture -Arguments @('config', 'user.email', 'plan-test@example.com') | Out-Null
  Invoke-TestGit -WorkingDirectory $planFixture -Arguments @('config', 'user.name', 'Plan Test') | Out-Null
  foreach ($index in 1..31) {
    Set-Content -LiteralPath (Join-Path $planFixture "tools/file-$index.txt") -Value 'base' -Encoding utf8
  }
  Invoke-TestGit -WorkingDirectory $planFixture -Arguments @('add', '--', 'tools') | Out-Null
  Invoke-TestGit -WorkingDirectory $planFixture -Arguments @('commit', '-m', 'planner base') | Out-Null
  foreach ($index in 1..31) {
    Add-Content -LiteralPath (Join-Path $planFixture "tools/file-$index.txt") -Value 'changed' -Encoding utf8
  }
  Add-Content -LiteralPath (Join-Path $planFixture 'tools/file-1.txt') -Value (1..1513 | ForEach-Object { "line $_" }) -Encoding utf8
  $planner = Join-Path $repoRoot 'tools/plan-public-commit.ps1'
  foreach ($thresholds in @(@('-MaxFiles', '30', '-MaxChangedLines', '9999'), @('-MaxFiles', '99', '-MaxChangedLines', '1500'), @())) {
    $planRun = Invoke-TestScript -Script $planner -Arguments (@('-RepoRoot', $planFixture, '-Json') + $thresholds)
    $plan = $planRun.text | ConvertFrom-Json
    Assert-AgentTest ($planRun.exitCode -eq 0 -and $plan.safeToStage) 'size alone must not block a classified ship slice'
    Assert-AgentTest ($plan.budgets.mode -eq 'advisory' -and @($plan.batches).Count -eq 1 -and -not $plan.batches[0].withinBudget) 'above-threshold size must remain visible advisory evidence'
    Assert-AgentTest ($plan.batches[0].files -eq 31 -and $plan.batches[0].changedLines -eq 1544) 'planner must retain exact review counts'
  }
  $planTextRun = Invoke-TestScript -Script $planner -Arguments @('-RepoRoot', $planFixture)
  Assert-AgentTest ($planTextRun.exitCode -eq 0 -and $planTextRun.text -match 'above review guidance' -and $planTextRun.text -notmatch 'SPLIT REQUIRED') 'text advice must describe reviewability without demanding a split'
  Set-Content -LiteralPath (Join-Path $planFixture 'unclassified.txt') -Value 'unknown' -Encoding utf8
  $unknownPlanRun = Invoke-TestScript -Script $planner -Arguments @('-RepoRoot', $planFixture, '-Json')
  $unknownPlan = $unknownPlanRun.text | ConvertFrom-Json
  Assert-AgentTest (-not $unknownPlan.safeToStage -and $unknownPlan.nextAction -match 'resolve investigate/vault') 'unknown-path staging guard must remain independent of size guidance'

  Write-Output 'agent-git-readiness: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    $resolvedTempRoot = [IO.Path]::GetFullPath($tempRoot)
    if ([IO.Path]::GetDirectoryName($resolvedTempRoot) -ne [IO.Path]::GetFullPath($repoRoot) -or [IO.Path]::GetFileName($resolvedTempRoot) -notmatch '^\.tmp-agent-git-readiness-[0-9a-f]{32}$') { throw 'Refusing unexpected readiness fixture cleanup target.' }
    Remove-Item -LiteralPath $resolvedTempRoot -Recurse -Force
  }
}
