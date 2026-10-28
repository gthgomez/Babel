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
  [string]$BuilderIdentity, [string]$OutputFormat, [int]$CheckWaitSeconds = 0
)
Add-Content -LiteralPath $env:BABEL_MERGE_TEST_LAUNCHER_LOG -Value ("trusted_base=$BaseSha; check_wait_seconds=$CheckWaitSeconds")
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
if ($GhArguments[0] -eq 'api' -and $GhArguments[1] -eq 'repos/gthgomez/Babel/git/ref/heads/main') {
  $reads = ([regex]::Matches((Get-Content -Raw -LiteralPath $env:BABEL_MERGE_TEST_GH_LOG), 'git/ref/heads/main')).Count
  $tip = if ($reads -gt 1 -and $env:BABEL_MERGE_TEST_NEXT_TIP) { $env:BABEL_MERGE_TEST_NEXT_TIP } else { $env:BABEL_MERGE_TEST_LIVE_TIP }
  if ($env:BABEL_MERGE_TEST_REF_FAILURE -eq 'missing') { exit 1 }
  $ref = 'refs/heads/main'; $url = 'https://api.github.com/repos/gthgomez/Babel/git/refs/heads/main'
  if ($env:BABEL_MERGE_TEST_REF_FAILURE -eq 'branch') { $ref = 'refs/heads/other' }
  if ($env:BABEL_MERGE_TEST_REF_FAILURE -eq 'repository') { $url = 'https://api.github.com/repos/other/repo/git/refs/heads/main' }
  @{ ref = $ref; url = $url; object = @{ type = 'commit'; sha = $tip } } | ConvertTo-Json -Compress
  exit 0
}
if ($GhArguments[0] -eq 'api' -and $env:BABEL_MERGE_TEST_NONSTRICT -eq '1') {
  if ($GhArguments[1] -like '*rulesets?*') { Write-Output '[{"id":1,"name":"protect-main","enforcement":"active"}]' }
  else { Write-Output '{"rules":[{"type":"required_status_checks","parameters":{"strict_required_status_checks_policy":false}}]}' }
  exit 0
}
if ($GhArguments.Count -lt 3 -or $GhArguments -notcontains '--repo' -or $GhArguments -notcontains 'gthgomez/Babel') { exit 9 }
if ($GhArguments[0] -eq 'pr' -and $GhArguments[1] -eq 'view') {
  if ($GhArguments -contains 'baseRefOid' -or $GhArguments -contains 'baseRefOid,baseRefName') {
    @{ baseRefOid = $env:BABEL_MERGE_TEST_RECORDED; baseRefName = 'main' } | ConvertTo-Json -Compress
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
    [string]$RecordedBase = '',
    [string]$LiveTip = '',
    [string]$NextLiveTip = '',
    [string]$RefFailure = '',
    [int]$WaitSeconds = 0,
    [switch]$CleanupFailure
  )
  Set-Content -LiteralPath $ghLog -Value '' -Encoding utf8NoBOM
  Set-Content -LiteralPath $launcherLog -Value '' -Encoding utf8NoBOM
  $env:BABEL_MERGE_TEST_BASE = $base
  $env:BABEL_MERGE_TEST_RECORDED = if ($RecordedBase) { $RecordedBase } else { $base }
  $env:BABEL_MERGE_TEST_LIVE_TIP = if ($LiveTip) { $LiveTip } else { $base }
  $env:BABEL_MERGE_TEST_NEXT_TIP = $NextLiveTip
  $env:BABEL_MERGE_TEST_REF_FAILURE = $RefFailure
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
  if ($PSBoundParameters.ContainsKey('WaitSeconds')) { $arguments += @('-CheckWaitSeconds', [string]$WaitSeconds) }
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
  $ready = @{ status = 'MERGE_READY'; mergeReady = $true; repository = 'gthgomez/Babel'; repositoryPolicy = @{ strictRequiredStatusChecksPolicy = $true };
    pr = @{ number = 42 }; sha = @{ baseHead = $base; reviewedHead = $head; prHead = $head;
    remoteHead = $head; ciHead = $head; liveTargetHead = $base; fetchedTargetHead = $base; trustedPolicySha = $base } } | ConvertTo-Json -Compress -Depth 6
  $view = @{ state = 'OPEN'; baseRefOid = $base; baseRefName = 'main'; headRefOid = $head; isDraft = $false;
    mergeable = 'MERGEABLE'; mergeStateStatus = 'CLEAN' } | ConvertTo-Json -Compress

  $happy = Invoke-MergeFixture -GateJson $ready -ViewJson $view -SuppliedBase $base
  Assert-MergeTest ($happy.exitCode -eq 0 -and $happy.json.status -eq 'MERGED') "exact-head merge must succeed: $($happy.text); gh: $($happy.gh)"
  Assert-MergeTest ($happy.launcher.Contains("trusted_base=$base")) 'gate launcher must come from trusted base commit'
  Assert-MergeTest ($happy.gh.Contains("pr merge 42 --repo gthgomez/Babel --match-head-commit $head --squash")) 'merge must bind repository and exact head'

  Assert-MergeTest ($happy.launcher.Contains('check_wait_seconds=0')) 'omitted wait must preserve zero default'
  $waited = Invoke-MergeFixture -GateJson $ready -ViewJson $view -WaitSeconds 180
  Assert-MergeTest ($waited.exitCode -eq 0 -and $waited.launcher.Contains('check_wait_seconds=180')) "explicit wait must reach trusted base launcher: $($waited.text)"
  Assert-MergeTest ($waited.gh.Contains("--match-head-commit $head")) 'waiting must retain exact-head merge binding'
  foreach ($invalidWait in @(-1, 1801)) {
    $invalid = Invoke-MergeFixture -GateJson $ready -ViewJson $view -WaitSeconds $invalidWait
    Assert-MergeTest ($invalid.exitCode -ne 0 -and -not $invalid.launcher.Trim() -and -not $invalid.gh.Trim()) 'invalid wait must reject before gate or GitHub commands'
  }
  $wrongWaitBase = Invoke-MergeFixture -GateJson $ready -ViewJson $view -SuppliedBase $otherHead -WaitSeconds 180
  Assert-MergeTest ($wrongWaitBase.exitCode -ne 0 -and @($wrongWaitBase.json.blockers) -contains 'merge_base_sha_mismatch' -and -not $wrongWaitBase.gh.Contains('pr merge')) 'wait must not bypass a wrong supplied base'
  $waitWrongGate = $ready | ConvertFrom-Json; $waitWrongGate.sha.ciHead = $otherHead
  $wrongWaitHead = Invoke-MergeFixture -GateJson ($waitWrongGate | ConvertTo-Json -Depth 6 -Compress) -ViewJson $view -WaitSeconds 180
  Assert-MergeTest ($wrongWaitHead.exitCode -ne 0 -and @($wrongWaitHead.json.blockers) -contains 'merge_gate_sha_mismatch' -and -not $wrongWaitHead.gh.Contains('pr merge')) 'wait must not bypass wrong qualified head'

  $oldRecorded = $ready | ConvertFrom-Json; $oldRecorded.sha.baseHead = $otherHead
  $oldView = $view | ConvertFrom-Json; $oldView.baseRefOid = $otherHead
  try {
    $env:BABEL_MERGE_TEST_NONSTRICT = '1'
    $disjoint = Invoke-MergeFixture -GateJson ($oldRecorded | ConvertTo-Json -Compress -Depth 6) -ViewJson ($oldView | ConvertTo-Json -Compress) -RecordedBase $otherHead
    Assert-MergeTest ($disjoint.exitCode -eq 0 -and $disjoint.launcher.Contains("trusted_base=$base")) 'old recorded provenance must not select the evaluator or block qualified live-base merge'
    $movedTarget = Invoke-MergeFixture -GateJson $ready -ViewJson $view -NextLiveTip $otherHead
    Assert-MergeTest ($movedTarget.exitCode -ne 0 -and @($movedTarget.json.blockers) -contains 'live_target_changed') 'target advancement after nonstrict qualification must block'
    Assert-MergeTest (-not $movedTarget.gh.Contains('pr merge')) 'target advancement must never reach merge'
  } finally { Remove-Item Env:BABEL_MERGE_TEST_NONSTRICT -ErrorAction SilentlyContinue }
  foreach ($failure in @('missing', 'branch', 'repository')) {
    $badRef = Invoke-MergeFixture -GateJson $ready -ViewJson $view -RefFailure $failure
    Assert-MergeTest ($badRef.exitCode -ne 0 -and -not $badRef.gh.Contains('pr merge')) "invalid target $failure must stop before merge"
  }
  $badRef = Invoke-MergeFixture -GateJson $ready -ViewJson $view -LiveTip 'short'
  Assert-MergeTest ($badRef.exitCode -ne 0 -and -not $badRef.gh.Contains('pr merge')) 'malformed target SHA must stop before merge'

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

  foreach ($field in @('liveTargetHead', 'fetchedTargetHead', 'trustedPolicySha')) {
    $wrongBinding = $ready | ConvertFrom-Json
    $wrongBinding.sha.$field = $otherHead
    $wrong = Invoke-MergeFixture -GateJson ($wrongBinding | ConvertTo-Json -Compress -Depth 6) -ViewJson $view
    Assert-MergeTest ($wrong.exitCode -ne 0 -and @($wrong.json.blockers) -contains 'merge_gate_base_mismatch' -and -not $wrong.gh.Contains('pr merge')) "wrong $field must not reach merge"
  }
  $oldPolicy = $ready | ConvertFrom-Json
  $oldPolicy.repositoryPolicy.strictRequiredStatusChecksPolicy = $false
  $tightened = Invoke-MergeFixture -GateJson ($oldPolicy | ConvertTo-Json -Compress -Depth 6) -ViewJson $view
  Assert-MergeTest ($tightened.exitCode -ne 0 -and @($tightened.json.blockers) -contains 'merge_gate_freshness_policy_changed') 'strict policy tightening after gate must require requalification'

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
  try {
    $env:BABEL_MERGE_TEST_NONSTRICT = '1'
    $changedNonstrictBase = Invoke-MergeFixture -GateJson $ready -ViewJson ($stale | ConvertTo-Json -Compress)
    Assert-MergeTest ($changedNonstrictBase.exitCode -ne 0 -and @($changedNonstrictBase.json.blockers) -contains 'pr_base_mismatch') 'base movement after nonstrict qualification must require requalification'
    Assert-MergeTest (-not $changedNonstrictBase.gh.Contains('pr merge')) 'stale nonstrict qualification must never reach merge'
  } finally { Remove-Item Env:BABEL_MERGE_TEST_NONSTRICT -ErrorAction SilentlyContinue }

  foreach ($scenario in @(
      @{ Name = 'closed'; Change = @{ state = 'CLOSED' }; Blocker = 'pr_not_open' },
      @{ Name = 'draft'; Change = @{ isDraft = $true }; Blocker = 'pr_is_draft' },
      @{ Name = 'conflict'; Change = @{ mergeable = 'CONFLICTING' }; Blocker = 'pr_not_mergeable' },
      @{ Name = 'blocked state'; Change = @{ mergeStateStatus = 'BLOCKED' }; Blocker = 'pr_merge_state_not_clean' }
      @{ Name = 'unstable state'; Change = @{ mergeStateStatus = 'UNSTABLE' }; Blocker = 'pr_merge_state_not_clean' },
      @{ Name = 'retargeted'; Change = @{ baseRefName = 'other' }; Blocker = 'unexpected_pr_base_branch' }
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

  # The candidate wrapper may run before this option exists in the immutable
  # base launcher. Zero/default remains compatible; nonzero never falls back.
  $originalBase = $base
  $oldGate = "[CmdletBinding()]`n" + $trustedGate.Replace(', [int]$CheckWaitSeconds = 0', '').Replace('; check_wait_seconds=$CheckWaitSeconds', '')
  Set-Content -LiteralPath (Join-Path $scriptsDir 'trusted-merge-gate.ps1') -Value $oldGate -Encoding utf8NoBOM
  & git -C $repoRoot add scripts/trusted-merge-gate.ps1
  & git -C $repoRoot commit --quiet -m 'legacy advanced launcher fixture'
  $base = (& git -C $repoRoot rev-parse HEAD).Trim()
  $legacyReady = $ready | ConvertFrom-Json
  foreach ($field in @('baseHead', 'liveTargetHead', 'fetchedTargetHead', 'trustedPolicySha')) { $legacyReady.sha.$field = $base }
  $legacyView = $view | ConvertFrom-Json; $legacyView.baseRefOid = $base
  try {
    $legacy = Invoke-MergeFixture -GateJson ($legacyReady | ConvertTo-Json -Depth 6 -Compress) -ViewJson ($legacyView | ConvertTo-Json -Compress)
    Assert-MergeTest ($legacy.exitCode -eq 0 -and $legacy.json.status -eq 'MERGED') "default must remain compatible with an old immutable advanced launcher: $($legacy.text)"
    $legacyZero = Invoke-MergeFixture -GateJson ($legacyReady | ConvertTo-Json -Depth 6 -Compress) -ViewJson ($legacyView | ConvertTo-Json -Compress) -WaitSeconds 0
    Assert-MergeTest ($legacyZero.exitCode -eq 0 -and $legacyZero.json.status -eq 'MERGED') 'explicit zero must preserve old-base default semantics'
    $legacyWait = Invoke-MergeFixture -GateJson ($legacyReady | ConvertTo-Json -Depth 6 -Compress) -ViewJson ($legacyView | ConvertTo-Json -Compress) -WaitSeconds 180
    Assert-MergeTest ($legacyWait.exitCode -ne 0 -and -not $legacyWait.gh.Contains('pr merge')) 'unsupported nonzero wait must fail closed without a silent default fallback'
  } finally { $base = $originalBase }

  $badMethod = Invoke-MergeFixture -GateJson $ready -ViewJson $view -MergeMethod 'invalid'
  Assert-MergeTest ($badMethod.exitCode -ne 0 -and @($badMethod.json.blockers) -contains 'merge_method_invalid') 'invalid merge method must block'
} finally {
  $env:PATH = $priorPath
  foreach ($name in @('BABEL_MERGE_TEST_BASE', 'BABEL_MERGE_TEST_GATE_JSON', 'BABEL_MERGE_TEST_PR_VIEW',
      'BABEL_MERGE_TEST_GATE_EXIT', 'BABEL_MERGE_TEST_MERGE_EXIT', 'BABEL_MERGE_TEST_GH_LOG',
      'BABEL_MERGE_TEST_LAUNCHER_LOG', 'BABEL_MERGE_TEST_SCRIPT', 'BABEL_MERGE_TEST_RECORDED',
      'BABEL_MERGE_TEST_LIVE_TIP', 'BABEL_MERGE_TEST_NEXT_TIP', 'BABEL_MERGE_TEST_REF_FAILURE')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}

# Keep both forwarding seams in the existing mandatory CI fixture entrypoint.
& $pwshPath -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'test-trusted-merge-gate-forwarding.ps1')
Assert-MergeTest ($LASTEXITCODE -eq 0) 'trusted launcher forwarding fixture must pass'

Write-Output 'AGENT_PR_MERGE_TEST_PASS'
