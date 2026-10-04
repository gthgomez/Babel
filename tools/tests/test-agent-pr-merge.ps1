[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-MergeTest {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$mergeScript = Join-Path $PSScriptRoot '../../scripts/agent-pr-merge.ps1'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('babel-agent-pr-merge-' + [guid]::NewGuid().ToString('N'))
$repoRoot = Join-Path $tempRoot 'repo'
$scriptsDir = Join-Path $repoRoot 'scripts'
$ghShim = Join-Path $tempRoot 'gh-shim.ps1'
$ghBin = Join-Path $tempRoot 'bin'
$ghExecutable = Join-Path $ghBin $(if ($IsWindows) { 'gh.cmd' } else { 'gh' })
$priorPath = $env:PATH
$ghLog = Join-Path $tempRoot 'gh.log'
$launcherLog = Join-Path $tempRoot 'launcher.log'
$cleanupDriver = Join-Path $tempRoot 'cleanup-driver.ps1'
$head = 'a' * 40
$otherHead = 'b' * 40
$base = ''

$trustedGate = @'
param(
  [int]$PR, [string]$BaseSha, [string]$RepoRoot, [string]$ReviewedHeadSha,
  [string]$RiskTier, [string]$AutonomousReviewEvidencePath,
  [string]$BuilderIdentity, [string]$OutputFormat
)
Add-Content -LiteralPath $env:BABEL_MERGE_TEST_LAUNCHER_LOG -Value ("trusted_base=$BaseSha")
$innerGate = & git -C $RepoRoot show ("{0}:scripts/trusted-merge-gate.ps1" -f $BaseSha)
if (($innerGate -join "`n") -notmatch 'trusted_base=') { throw 'replace ref influenced the inner base gate' }
Write-Output $env:BABEL_MERGE_TEST_GATE_JSON
exit ([int]$env:BABEL_MERGE_TEST_GATE_EXIT)
'@
$candidateGate = @'
throw 'Candidate-controlled launcher must never execute.'
'@
$ghScript = @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GhArguments)
Add-Content -LiteralPath $env:BABEL_MERGE_TEST_GH_LOG -Value ($GhArguments -join ' ')
if ($GhArguments.Count -lt 3 -or $GhArguments -notcontains '--repo' -or $GhArguments -notcontains 'gthgomez/Babel') { exit 9 }
if ($GhArguments[0] -eq 'pr' -and $GhArguments[1] -eq 'view') {
  if ($GhArguments -contains 'baseRefOid' -and $GhArguments -notcontains 'state,headRefOid,baseRefOid,isDraft,mergeable,mergeStateStatus') {
    Write-Output ('{"baseRefOid":"' + $env:BABEL_MERGE_TEST_BASE + '"}')
  } else {
    Write-Output $env:BABEL_MERGE_TEST_PR_VIEW
  }
  exit 0
}
if ($GhArguments[0] -eq 'pr' -and $GhArguments[1] -eq 'merge') {
  exit ([int]$env:BABEL_MERGE_TEST_MERGE_EXIT)
}
exit 9
'@

function Invoke-MergeFixture {
  param(
    [string]$GateJson,
    [string]$ViewJson,
    [string]$SuppliedBase = '',
    [int]$GateExit = 0,
    [int]$MergeExit = 0,
    [string]$MergeMethod = 'squash',
    [switch]$CleanupFailure
  )
  Set-Content -LiteralPath $ghLog -Value '' -Encoding utf8NoBOM
  Set-Content -LiteralPath $launcherLog -Value '' -Encoding utf8NoBOM
  $env:BABEL_MERGE_TEST_BASE = $base
  $env:BABEL_MERGE_TEST_GATE_JSON = $GateJson
  $env:BABEL_MERGE_TEST_PR_VIEW = $ViewJson
  $env:BABEL_MERGE_TEST_GATE_EXIT = [string]$GateExit
  $env:BABEL_MERGE_TEST_MERGE_EXIT = [string]$MergeExit
  $env:BABEL_MERGE_TEST_GH_LOG = $ghLog
  $env:BABEL_MERGE_TEST_LAUNCHER_LOG = $launcherLog
  $arguments = @('-NoProfile', '-NonInteractive', '-File', $mergeScript, '-PR', '42',
    '-ReviewedHeadSha', $head, '-RepoRoot', $repoRoot,
    '-MergeMethod', $MergeMethod)
  if ($SuppliedBase) { $arguments += @('-BaseSha', $SuppliedBase) }
  if ($CleanupFailure) {
    # Inject failure only in this test process, without changing production
    # environment/configuration or adding a cleanup bypass to the executor.
    $driver = @'
$ErrorActionPreference = 'Stop'
$WarningPreference = 'Stop'
function Remove-Item {
  [CmdletBinding()]
  param([string]$LiteralPath, [switch]$Force)
  $ErrorActionPreference = 'Stop'
  throw 'Controlled temporary launcher cleanup failure.'
}
& $env:BABEL_MERGE_TEST_SCRIPT @args
exit $LASTEXITCODE
'@
    Set-Content -LiteralPath $cleanupDriver -Value $driver -Encoding utf8NoBOM
    $env:BABEL_MERGE_TEST_SCRIPT = $mergeScript
    $arguments[3] = $cleanupDriver
  }
  $output = & $pwshPath @arguments 2>&1
  $exitCode = $LASTEXITCODE
  $text = (@($output) | ForEach-Object { [string]$_ }) -join "`n"
  $json = $null
  foreach ($line in ($text -split '\r?\n')) {
    try { $parsed = $line | ConvertFrom-Json -ErrorAction Stop; if ($parsed.status) { $json = $parsed } } catch { }
  }
  return [pscustomobject]@{
    exitCode = $exitCode; json = $json; text = $text
    gh = (Get-Content -Raw -LiteralPath $ghLog)
    launcher = (Get-Content -Raw -LiteralPath $launcherLog)
  }
}

try {
  New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $ghBin -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $scriptsDir 'trusted-merge-gate.ps1') -Value $trustedGate -Encoding utf8NoBOM
  Set-Content -LiteralPath $ghShim -Value $ghScript -Encoding utf8NoBOM
  if ($IsWindows) {
    Set-Content -LiteralPath $ghExecutable -Value "@echo off`r`npwsh -NoProfile -NonInteractive -File `"$ghShim`" %*`r`nexit /b %ERRORLEVEL%`r`n" -Encoding ascii
  } else {
    Set-Content -LiteralPath $ghExecutable -Value "#!/bin/sh`nexec pwsh -NoProfile -NonInteractive -File '$ghShim' `"`$@`"`n" -Encoding utf8NoBOM
    & chmod +x $ghExecutable
  }
  $env:PATH = "$ghBin$([IO.Path]::PathSeparator)$priorPath"
  & git -C $repoRoot init --quiet
  & git -C $repoRoot config user.name 'Babel test'
  & git -C $repoRoot config user.email 'babel-test@example.invalid'
  & git -C $repoRoot add scripts/trusted-merge-gate.ps1
  & git -C $repoRoot commit --quiet -m 'trusted base launcher'
  $base = (& git -C $repoRoot rev-parse HEAD).Trim()
  Assert-MergeTest ($base -match '^[0-9a-f]{40}$') 'fixture base commit must exist'
  Set-Content -LiteralPath (Join-Path $scriptsDir 'trusted-merge-gate.ps1') -Value $candidateGate -Encoding utf8NoBOM
  $ready = @{ status = 'MERGE_READY'; mergeReady = $true; repository = 'gthgomez/Babel';
    pr = @{ number = 42 }; sha = @{ baseHead = $base; reviewedHead = $head; prHead = $head;
      remoteHead = $head; ciHead = $head } } | ConvertTo-Json -Compress -Depth 6
  $view = @{ state = 'OPEN'; baseRefOid = $base; headRefOid = $head; isDraft = $false;
    mergeable = 'MERGEABLE'; mergeStateStatus = 'CLEAN' } | ConvertTo-Json -Compress

  $happy = Invoke-MergeFixture -GateJson $ready -ViewJson $view -SuppliedBase $base
  Assert-MergeTest ($happy.exitCode -eq 0 -and $happy.json.status -eq 'MERGED') "exact-head merge must succeed: $($happy.text); gh: $($happy.gh)"
  Assert-MergeTest ($happy.launcher.Contains("trusted_base=$base")) 'gate launcher must come from trusted base commit'
  Assert-MergeTest ($happy.gh.Contains("pr merge 42 --repo gthgomez/Babel --match-head-commit $head --squash")) 'merge must bind repository and exact head'

  $cleanupAfterSuccess = Invoke-MergeFixture -GateJson $ready -ViewJson $view -CleanupFailure
  Assert-MergeTest ($cleanupAfterSuccess.exitCode -eq 0 -and $cleanupAfterSuccess.json.status -eq 'MERGED') "cleanup failure must not turn a successful merge into failure: exit=$($cleanupAfterSuccess.exitCode); $($cleanupAfterSuccess.text)"
  Assert-MergeTest ($cleanupAfterSuccess.text.Contains('merge_executor_cleanup_failed')) 'cleanup failure must remain visible separately'
  Assert-MergeTest (([regex]::Matches($cleanupAfterSuccess.gh, 'pr merge')).Count -eq 1) 'successful merge with cleanup failure must never retry'

  $cleanupAfterFailure = Invoke-MergeFixture -GateJson $ready -ViewJson $view -MergeExit 1 -CleanupFailure
  Assert-MergeTest ($cleanupAfterFailure.exitCode -ne 0 -and $cleanupAfterFailure.json.status -eq 'BLOCKED' -and @($cleanupAfterFailure.json.blockers) -contains 'merge_failed') 'cleanup must preserve a genuine merge failure'
  Assert-MergeTest ($cleanupAfterFailure.text.Contains('merge_executor_cleanup_failed')) 'blocked merge cleanup failure must remain visible separately'
  Assert-MergeTest (([regex]::Matches($cleanupAfterFailure.gh, 'pr merge')).Count -eq 1) 'failed merge with cleanup failure must never retry'

  $derived = Invoke-MergeFixture -GateJson $ready -ViewJson $view
  Assert-MergeTest ($derived.exitCode -eq 0) 'omitted base must derive from live PR'

  & git -C $repoRoot add scripts/trusted-merge-gate.ps1
  $replacementTree = (& git -C $repoRoot write-tree).Trim()
  $replacementCommit = ((& git -C $repoRoot commit-tree $replacementTree -p $base -m 'replacement tree') -join "`n").Trim()
  & git -C $repoRoot replace $base $replacementCommit
  try {
    $replaceAttack = Invoke-MergeFixture -GateJson $ready -ViewJson $view
    Assert-MergeTest ($replaceAttack.exitCode -eq 0 -and $replaceAttack.json.status -eq 'MERGED') 'local replace ref must not change trusted gate execution'
  } finally {
    & git -C $repoRoot replace -d $base | Out-Null
  }

  $wrongBase = Invoke-MergeFixture -GateJson $ready -ViewJson $view -SuppliedBase $otherHead
  Assert-MergeTest ($wrongBase.exitCode -ne 0 -and @($wrongBase.json.blockers) -contains 'merge_base_sha_mismatch') 'candidate supplied as base must block'
  Assert-MergeTest (-not $wrongBase.gh.Contains('pr merge')) 'wrong base must never merge'

  $wrongGate = $ready | ConvertFrom-Json
  $wrongGate.sha.ciHead = $otherHead
  $wrong = Invoke-MergeFixture -GateJson ($wrongGate | ConvertTo-Json -Compress -Depth 6) -ViewJson $view
  Assert-MergeTest ($wrong.exitCode -ne 0 -and @($wrong.json.blockers) -contains 'merge_gate_sha_mismatch') 'wrong CI head must block'

  $stale = $view | ConvertFrom-Json
  $stale.headRefOid = $otherHead
  $changed = Invoke-MergeFixture -GateJson $ready -ViewJson ($stale | ConvertTo-Json -Compress)
  Assert-MergeTest ($changed.exitCode -ne 0 -and @($changed.json.blockers) -contains 'pr_head_mismatch') 'moved PR head must block'
  $stale.headRefOid = $head
  $stale.baseRefOid = $otherHead
  $changedBase = Invoke-MergeFixture -GateJson $ready -ViewJson ($stale | ConvertTo-Json -Compress)
  Assert-MergeTest ($changedBase.exitCode -ne 0 -and @($changedBase.json.blockers) -contains 'pr_base_mismatch') 'moved PR base must block'

  foreach ($scenario in @(
      @{ Name = 'closed'; Change = @{ state = 'CLOSED' }; Blocker = 'pr_not_open' },
      @{ Name = 'draft'; Change = @{ isDraft = $true }; Blocker = 'pr_is_draft' },
      @{ Name = 'conflict'; Change = @{ mergeable = 'CONFLICTING' }; Blocker = 'pr_not_mergeable' },
      @{ Name = 'blocked state'; Change = @{ mergeStateStatus = 'BLOCKED' }; Blocker = 'pr_merge_state_not_clean' }
    )) {
    $scenarioView = $view | ConvertFrom-Json
    foreach ($property in $scenario.Change.Keys) { $scenarioView.$property = $scenario.Change[$property] }
    $result = Invoke-MergeFixture -GateJson $ready -ViewJson ($scenarioView | ConvertTo-Json -Compress)
    Assert-MergeTest ($result.exitCode -ne 0 -and @($result.json.blockers) -contains $scenario.Blocker) "$($scenario.Name) must block"
    Assert-MergeTest (-not $result.gh.Contains('pr merge')) "$($scenario.Name) must not reach GitHub merge"
  }

  $gateCrashed = Invoke-MergeFixture -GateJson $ready -ViewJson $view -GateExit 1
  Assert-MergeTest ($gateCrashed.exitCode -ne 0 -and -not $gateCrashed.gh.Contains('pr merge')) 'gate failure must block'

  $mergeFailed = Invoke-MergeFixture -GateJson $ready -ViewJson $view -MergeExit 1
  Assert-MergeTest ($mergeFailed.exitCode -ne 0 -and ([regex]::Matches($mergeFailed.gh, 'pr merge')).Count -eq 1) 'merge failure must never retry'

  $badMethod = Invoke-MergeFixture -GateJson $ready -ViewJson $view -MergeMethod 'invalid'
  Assert-MergeTest ($badMethod.exitCode -ne 0 -and @($badMethod.json.blockers) -contains 'merge_method_invalid') 'invalid merge method must block'
} finally {
  $env:PATH = $priorPath
  foreach ($name in @('BABEL_MERGE_TEST_BASE', 'BABEL_MERGE_TEST_GATE_JSON', 'BABEL_MERGE_TEST_PR_VIEW',
      'BABEL_MERGE_TEST_GATE_EXIT', 'BABEL_MERGE_TEST_MERGE_EXIT', 'BABEL_MERGE_TEST_GH_LOG',
      'BABEL_MERGE_TEST_LAUNCHER_LOG', 'BABEL_MERGE_TEST_SCRIPT')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output 'AGENT_PR_MERGE_TEST_PASS'
