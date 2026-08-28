[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:GIT_ALLOW_PROTOCOL = 'file'

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$git = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
$tempRoot = Join-Path $repoRoot ('.tmp-agent-git-readiness-' + [Guid]::NewGuid().ToString('N'))
$fakeGh = Join-Path $tempRoot 'fake-gh.ps1'
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
  $mappedRemote = 'file:///' + ([IO.Path]::GetFullPath($remote)).Replace('\', '/')
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', "url.$mappedRemote.insteadOf", 'https://github.com/gthgomez/Babel.git') | Out-Null
  Invoke-TestGit -WorkingDirectory $fixture -Arguments @('config', "url.$mappedRemote.insteadOf", 'https://github.com/gthgomez/Babel') | Out-Null
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
  $rulesetDetail = '{"id":19597161,"name":"protect-main","enforcement":"active","rules":[{"type":"pull_request","parameters":{"required_approving_review_count":0,"required_review_thread_resolution":true,"require_code_owner_review":false,"allowed_merge_methods":["merge","squash","rebase"]}},{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false,"required_status_checks":[{"context":"security"},{"context":"public-content-policy"},{"context":"linux-validation"},{"context":"public-pr-metadata"},{"context":"windows-portability"}]}}],"bypass_actors":[]}'
  $graphqlJson = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[]}}}}}'
  $checkItems = @()
  $checkItems += '{"id":101,"name":"security","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"101","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"id":102,"name":"public-content-policy","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"102","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"id":103,"name":"linux-validation","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"103","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"id":104,"name":"public-pr-metadata","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request_target","workflow_name":"Public PR Metadata","workflow_id":"workflow-2","workflow_run_id":"104","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkItems += '{"id":105,"name":"windows-portability","status":"completed","conclusion":"success","head_sha":"' + $headSha + '","event":"pull_request","workflow_name":"Public Release Gate","workflow_id":"workflow-1","workflow_run_id":"105","started_at":"2026-08-28T10:00:00Z","completed_at":"2026-08-28T10:01:00Z"}'
  $checkJson = '{"check_runs":[' + ($checkItems -join ',') + ']}'
  @(
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)',
    'if ($Arguments.Count -gt 0 -and $Arguments[0] -eq "--version") { Write-Output "gh version 2.97.0"; exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "auth" -and $Arguments[1] -eq "status") { exit 0 }',
    'if ($Arguments.Count -gt 1 -and $Arguments[0] -eq "repo" -and $Arguments[1] -eq "view") { Write-Output ''{"nameWithOwner":"gthgomez/Babel","defaultBranchRef":{"name":"main"}}''; exit 0 }',
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
  $gateRun = Invoke-TestScript -Script $prGateScript -Arguments @(
    '-PR', '42',
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-GhPath', $fakeGh,
    '-ReviewedHeadSha', $headSha,
    '-RiskTier', 'LOW',
    '-MergeAuthorized'
  )
  Assert-AgentTest ($gateRun.exitCode -eq 0) "PR gate should pass: $($gateRun.text)"
  $gate = $gateRun.text | ConvertFrom-Json
  Assert-AgentTest ([string]$gate.status -eq 'MERGE_READY') 'PR gate should report MERGE_READY'
  Assert-AgentTest ([bool]$gate.checks.PR_HEAD_REVIEWED) 'PR gate should bind review to PR head'
  Assert-AgentTest ([bool]$gate.checks.REMOTE_HEAD_MATCH) 'PR gate should bind remote branch to PR head'
  Assert-AgentTest ([bool]$gate.checks.CI_HEAD_MATCH) 'PR gate should bind CI to PR head'
  Assert-AgentTest ([bool]$gate.checks.REQUIRED_CHECKS_GREEN) 'PR gate should require all configured checks'
  Assert-AgentTest ([bool]$gate.checks.BASE_NOT_INVALIDATED) 'PR gate should verify the base SHA'

  $zeroSha = [string]::new('0', 40)
  $blockedRun = Invoke-TestScript -Script $prGateScript -Arguments @(
    '-PR', '42',
    '-RepoRoot', $fixture,
    '-GitPath', $git,
    '-GhPath', $fakeGh,
    '-ReviewedHeadSha', $zeroSha,
    '-RiskTier', 'LOW',
    '-MergeAuthorized'
  )
  Assert-AgentTest ($blockedRun.exitCode -eq 1) 'PR gate should block a reviewed-head mismatch'
  $blocked = $blockedRun.text | ConvertFrom-Json
  Assert-AgentTest ([string]$blocked.status -eq 'BLOCKED') 'mismatched review should report BLOCKED'
  Assert-AgentTest (@($blocked.blockers) -contains 'reviewed_head_does_not_match_pr_head') 'mismatched review should identify its blocker'

  Write-Output 'agent-git-readiness: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
} finally {
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
