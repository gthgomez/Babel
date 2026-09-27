[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-MergeTest {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

$pwshPath = (Get-Command pwsh -ErrorAction Stop).Source
$mergeScript = Join-Path $PSScriptRoot '..\..\scripts\agent-pr-merge.ps1'
$isWindowsHost = [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('babel-agent-pr-merge-' + [guid]::NewGuid().ToString('N'))
$repoRoot = Join-Path $tempRoot 'repo'
$scriptsDir = Join-Path $repoRoot 'scripts'
$runDir = Join-Path $tempRoot 'run'
$logPath = Join-Path $tempRoot 'gh-calls.log'
$gateLogPath = Join-Path $tempRoot 'gate-calls.log'
$fakeGate = Join-Path $scriptsDir 'fake-gate.ps1'
$outsideGate = Join-Path $tempRoot 'outside-gate.ps1'
$ghShim = Join-Path $tempRoot 'gh-shim.ps1'
$caseScriptsDir = Join-Path $repoRoot 'SCRIPTS'
$caseGate = Join-Path $caseScriptsDir 'case-gate.ps1'
$linkTarget = Join-Path $tempRoot 'link-target.ps1'
$linkGate = Join-Path $scriptsDir 'link-gate.ps1'
$symlinkReady = $false

$head = 'a' * 40
$otherHead = 'b' * 40
$base = 'c' * 40

# Fake gate runner: records the arguments the wrapper forwards (it requires
# -BaseSha exactly as the trusted launcher does) and echoes crafted gate JSON.
$gateScript = @'
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$BaseSha,
  [string]$RepoRoot = '',
  [string]$ReviewedHeadSha = '',
  [string]$RiskTier = 'GREEN',
  [string]$AutonomousReviewEvidencePath = '',
  [string]$BuilderIdentity = '',
  [ValidateSet('json', 'text')][string]$OutputFormat = 'json'
)
Add-Content -LiteralPath $env:BABEL_MERGE_TEST_GATE_LOG -Value ("pr=$PR base=$BaseSha head=$ReviewedHeadSha risk=$RiskTier")
$payload = $env:BABEL_MERGE_TEST_GATE_JSON
if ([string]::IsNullOrWhiteSpace($payload)) { $payload = '{"status":"BLOCKED","mergeReady":false,"sha":{}}' }
Write-Output $payload
if (-not [string]::IsNullOrWhiteSpace($env:BABEL_MERGE_TEST_GATE_EXIT)) { exit ([int]$env:BABEL_MERGE_TEST_GATE_EXIT) }
exit 0
'@

# gh shim: records argv, answers `pr view` with the supplied JSON and
# `pr merge` with the supplied exit code. It never touches the network.
$ghScript = @'
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GhArguments)
Add-Content -LiteralPath $env:BABEL_MERGE_TEST_LOG -Value ($GhArguments -join ' ')
if ($GhArguments.Count -ge 2 -and $GhArguments[0] -eq 'pr' -and $GhArguments[1] -eq 'view') {
  Write-Output $env:BABEL_MERGE_TEST_PR_VIEW
  exit 0
}
if ($GhArguments.Count -ge 2 -and $GhArguments[0] -eq 'pr' -and $GhArguments[1] -eq 'merge') {
  $code = 0
  if (-not [string]::IsNullOrWhiteSpace($env:BABEL_MERGE_TEST_MERGE_EXIT)) { $code = [int]$env:BABEL_MERGE_TEST_MERGE_EXIT }
  Write-Output '{"merged":true}'
  exit $code
}
Write-Error "unexpected gh invocation: $($GhArguments -join ' ')"
exit 1
'@

function Invoke-MergeExecutor {
  param(
    [Parameter(Mandatory = $true)][string]$GateJson,
    [Parameter(Mandatory = $true)][string]$ViewJson,
    [string]$BaseSha = '',
    [int]$MergeExit = 0,
    [int]$GateExit = 0,
    [string]$MergeMethod = '',
    [string]$GateRunner = $fakeGate
  )
  Set-Content -LiteralPath $logPath -Value '' -Encoding utf8NoBOM
  Set-Content -LiteralPath $gateLogPath -Value '' -Encoding utf8NoBOM
  $env:BABEL_MERGE_TEST_GATE_JSON = $GateJson
  $env:BABEL_MERGE_TEST_PR_VIEW = $ViewJson
  $env:BABEL_MERGE_TEST_LOG = $logPath
  $env:BABEL_MERGE_TEST_GATE_LOG = $gateLogPath
  $env:BABEL_MERGE_TEST_MERGE_EXIT = [string]$MergeExit
  $env:BABEL_MERGE_TEST_GATE_EXIT = [string]$GateExit
  $stdoutPath = Join-Path $runDir 'stdout.txt'
  $stderrPath = Join-Path $runDir 'stderr.txt'
  $argumentList = @(
    '-NoProfile', '-NonInteractive', '-File', $mergeScript,
    '-PR', '42', '-ReviewedHeadSha', $head, '-RepoRoot', $repoRoot,
    '-GhPath', $ghShim, '-GateRunner', $GateRunner
  )
  if (-not [string]::IsNullOrWhiteSpace($BaseSha)) { $argumentList += @('-BaseSha', $BaseSha) }
  if (-not [string]::IsNullOrWhiteSpace($MergeMethod)) { $argumentList += @('-MergeMethod', $MergeMethod) }
  & $pwshPath @argumentList 1>$stdoutPath 2>$stderrPath
  $exitCode = $LASTEXITCODE
  $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -Raw -LiteralPath $stdoutPath } else { '' }
  $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }
  $json = $null
  if (-not [string]::IsNullOrWhiteSpace($stdout)) { try { $json = $stdout | ConvertFrom-Json } catch { $json = $null } }
  $log = if (Test-Path -LiteralPath $logPath) { (Get-Content -Raw -LiteralPath $logPath) } else { '' }
  $gateLog = if (Test-Path -LiteralPath $gateLogPath) { (Get-Content -Raw -LiteralPath $gateLogPath) } else { '' }
  return [pscustomobject]@{ exitCode = $exitCode; stdout = $stdout; stderr = $stderr; json = $json; log = $log; gateLog = $gateLog }
}

try {
  New-Item -ItemType Directory -Path $scriptsDir -Force | Out-Null
  New-Item -ItemType Directory -Path $runDir -Force | Out-Null
  Set-Content -LiteralPath $fakeGate -Value $gateScript -Encoding utf8NoBOM
  Set-Content -LiteralPath $outsideGate -Value $gateScript -Encoding utf8NoBOM
  Set-Content -LiteralPath $ghShim -Value $ghScript -Encoding utf8NoBOM

  # Case-variant sibling directory (only meaningful on case-sensitive filesystems).
  if (-not $isWindowsHost) {
    New-Item -ItemType Directory -Path $caseScriptsDir -Force | Out-Null
    Set-Content -LiteralPath $caseGate -Value $gateScript -Encoding utf8NoBOM
  }

  # Symlinked gate runner inside scripts/ that targets a file outside scripts/.
  Set-Content -LiteralPath $linkTarget -Value $gateScript -Encoding utf8NoBOM
  try {
    New-Item -ItemType SymbolicLink -Path $linkGate -Target $linkTarget -ErrorAction Stop | Out-Null
    $symlinkReady = $true
  } catch {
    $symlinkReady = $false
  }

  $readyGate = @{ status = 'MERGE_READY'; mergeReady = $true; sha = @{ reviewedHead = $head; prHead = $head; remoteHead = $head; ciHead = $head } } | ConvertTo-Json -Compress -Depth 6
  $blockedGate = @{ status = 'BLOCKED'; mergeReady = $false; sha = @{ reviewedHead = $head; prHead = $head; remoteHead = $head; ciHead = $head } } | ConvertTo-Json -Compress -Depth 6
  $mismatchedGate = @{ status = 'MERGE_READY'; mergeReady = $true; sha = @{ reviewedHead = $head; prHead = $head; remoteHead = $otherHead; ciHead = $head } } | ConvertTo-Json -Compress -Depth 6
  $notMergeReadyGate = @{ status = 'MERGE_READY'; mergeReady = $false; sha = @{ reviewedHead = $head; prHead = $head; remoteHead = $head; ciHead = $head } } | ConvertTo-Json -Compress -Depth 6

  $okView = @{ headRefOid = $head; baseRefOid = $base; isDraft = $false; mergeable = 'MERGEABLE'; mergeStateStatus = 'CLEAN' } | ConvertTo-Json -Compress
  $wrongHeadView = @{ headRefOid = $otherHead; baseRefOid = $base; isDraft = $false; mergeable = 'MERGEABLE'; mergeStateStatus = 'CLEAN' } | ConvertTo-Json -Compress
  $draftView = @{ headRefOid = $head; baseRefOid = $base; isDraft = $true; mergeable = 'MERGEABLE'; mergeStateStatus = 'BLOCKED' } | ConvertTo-Json -Compress
  $conflictingView = @{ headRefOid = $head; baseRefOid = $base; isDraft = $false; mergeable = 'CONFLICTING'; mergeStateStatus = 'DIRTY' } | ConvertTo-Json -Compress
  $missingBaseView = @{ headRefOid = $head; isDraft = $false; mergeable = 'MERGEABLE'; mergeStateStatus = 'CLEAN' } | ConvertTo-Json -Compress

  # 1. Happy path: exact-head certified, supplied base forwarded, live state
  # agrees, merge is invoked.
  $happy = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base
  Assert-MergeTest ($happy.exitCode -eq 0) "happy path must exit 0 (stdout=$($happy.stdout) stderr=$($happy.stderr))"
  Assert-MergeTest ($null -ne $happy.json -and [string]$happy.json.status -eq 'MERGED') "happy path must report MERGED (stdout=$($happy.stdout))"
  Assert-MergeTest ([int]$happy.json.pr -eq 42) 'happy path must report the PR number'
  Assert-MergeTest ([string]$happy.json.head_sha -ieq $head) 'happy path must report the exact reviewed head'
  Assert-MergeTest ($happy.gateLog.Contains("base=$base")) "happy path must forward the supplied -BaseSha to the gate (gateLog=$($happy.gateLog))"
  $expectedMerge = "pr merge 42 --match-head-commit $head --squash"
  Assert-MergeTest ($happy.log.Contains($expectedMerge)) "happy path must invoke: $expectedMerge (log=$($happy.log))"
  Assert-MergeTest ($happy.log.Contains('pr view 42')) "happy path must re-read live PR state first (log=$($happy.log))"

  # 1b. The requested merge method is honoured and --match-head-commit is always bound.
  $rebase = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -MergeMethod 'rebase'
  Assert-MergeTest ($rebase.exitCode -eq 0) 'rebase merge method must succeed'
  Assert-MergeTest ($rebase.log.Contains("pr merge 42 --match-head-commit $head --rebase")) "rebase must be forwarded with the exact head (log=$($rebase.log))"

  # 1c. Omitting -BaseSha derives it from the PR baseRefOid and forwards it.
  $derived = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView
  Assert-MergeTest ($derived.exitCode -eq 0) "derived base must succeed (stdout=$($derived.stdout))"
  Assert-MergeTest ($derived.gateLog.Contains("base=$base")) "derived base must be forwarded to the gate (gateLog=$($derived.gateLog))"
  Assert-MergeTest ($derived.log.Contains($expectedMerge)) "derived base must still merge the exact head (log=$($derived.log))"

  # 1d. An undeterminable base fails closed before the gate runs and before any merge.
  $noBase = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $missingBaseView
  Assert-MergeTest ($noBase.exitCode -ne 0) 'missing base must exit non-zero'
  Assert-MergeTest ($null -ne $noBase.json -and [string]$noBase.json.status -eq 'BLOCKED') 'missing base must report BLOCKED'
  Assert-MergeTest (@($noBase.json.blockers) -contains 'merge_base_sha_unavailable') "missing base must report merge_base_sha_unavailable (stdout=$($noBase.stdout))"
  Assert-MergeTest ([string]::IsNullOrWhiteSpace($noBase.gateLog.Trim())) 'missing base must not invoke the gate'
  Assert-MergeTest (-not $noBase.log.Contains('pr merge')) 'missing base must not invoke pr merge'

  # 2. Gate not ready: no gh call at all.
  foreach ($scenario in @(
      @{ Name = 'blocked status'; Gate = $blockedGate },
      @{ Name = 'mergeReady=false'; Gate = $notMergeReadyGate },
      @{ Name = 'mismatched gate sha'; Gate = $mismatchedGate }
    )) {
    $run = Invoke-MergeExecutor -GateJson $scenario.Gate -ViewJson $okView -BaseSha $base
    Assert-MergeTest ($run.exitCode -ne 0) "$($scenario.Name): gate failure must exit non-zero"
    Assert-MergeTest ($null -ne $run.json -and [string]$run.json.status -eq 'BLOCKED') "$($scenario.Name): must report BLOCKED (stdout=$($run.stdout))"
    Assert-MergeTest ([string]::IsNullOrWhiteSpace($run.log.Trim())) "$($scenario.Name): gate failure must not invoke gh (log=$($run.log))"
  }

  # 2b. A gate that prints MERGE_READY but exits non-zero is still untrusted.
  $gateCrashed = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -GateExit 1
  Assert-MergeTest ($gateCrashed.exitCode -ne 0) 'gate non-zero exit must block'
  Assert-MergeTest ($null -ne $gateCrashed.json -and [string]$gateCrashed.json.status -eq 'BLOCKED') 'gate non-zero exit must report BLOCKED'
  Assert-MergeTest ([string]::IsNullOrWhiteSpace($gateCrashed.log.Trim())) 'gate non-zero exit must not invoke gh'

  # 3. Live-state disagreement: pr view is read, pr merge is never invoked.
  foreach ($scenario in @(
      @{ Name = 'live head mismatch'; View = $wrongHeadView },
      @{ Name = 'draft pr'; View = $draftView },
      @{ Name = 'non-mergeable pr'; View = $conflictingView }
    )) {
    $run = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $scenario.View -BaseSha $base
    Assert-MergeTest ($run.exitCode -ne 0) "$($scenario.Name): must exit non-zero"
    Assert-MergeTest ($null -ne $run.json -and [string]$run.json.status -eq 'BLOCKED') "$($scenario.Name): must report BLOCKED (stdout=$($run.stdout))"
    Assert-MergeTest (-not $run.log.Contains('pr merge')) "$($scenario.Name): must not invoke pr merge (log=$($run.log))"
  }

  # 4. Merge command failure is blocked and never retried with another SHA.
  $mergeFailure = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -MergeExit 1
  Assert-MergeTest ($mergeFailure.exitCode -ne 0) 'merge failure must exit non-zero'
  Assert-MergeTest ($null -ne $mergeFailure.json -and [string]$mergeFailure.json.status -eq 'BLOCKED') 'merge failure must report BLOCKED'
  Assert-MergeTest (([regex]::Matches($mergeFailure.log, 'pr merge')).Count -eq 1) "merge failure must not retry (log=$($mergeFailure.log))"

  # 5. Gate runner outside $RepoRoot/scripts is rejected before any gate or gh call.
  $outside = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -GateRunner $outsideGate
  Assert-MergeTest ($outside.exitCode -ne 0) 'gate runner outside scripts must exit non-zero'
  Assert-MergeTest ($null -ne $outside.json -and [string]$outside.json.status -eq 'BLOCKED') 'gate runner outside scripts must report BLOCKED'
  Assert-MergeTest (@($outside.json.blockers) -contains 'merge_gate_runner_invalid') "gate runner outside scripts must report merge_gate_runner_invalid (stdout=$($outside.stdout))"
  Assert-MergeTest ([string]::IsNullOrWhiteSpace($outside.log.Trim())) 'gate runner outside scripts must not invoke gh'

  # 5b. A case-variant sibling directory must not be treated as scripts/ on a
  # case-sensitive filesystem.
  if (-not $isWindowsHost) {
    $caseVariant = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -GateRunner $caseGate
    Assert-MergeTest ($caseVariant.exitCode -ne 0) 'case-variant scripts dir must exit non-zero'
    Assert-MergeTest ($null -ne $caseVariant.json -and [string]$caseVariant.json.status -eq 'BLOCKED') 'case-variant scripts dir must report BLOCKED'
    Assert-MergeTest (@($caseVariant.json.blockers) -contains 'merge_gate_runner_invalid') "case-variant scripts dir must report merge_gate_runner_invalid (stdout=$($caseVariant.stdout))"
    Assert-MergeTest ([string]::IsNullOrWhiteSpace($caseVariant.gateLog.Trim())) 'case-variant scripts dir must not invoke the gate'
  }

  # 5c. A symlinked gate runner inside scripts/ that targets outside scripts/ is
  # rejected (Resolve-Path does not dereference links on Unix).
  if ($symlinkReady) {
    $symlinked = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -GateRunner $linkGate
    Assert-MergeTest ($symlinked.exitCode -ne 0) 'symlinked gate runner must exit non-zero'
    Assert-MergeTest ($null -ne $symlinked.json -and [string]$symlinked.json.status -eq 'BLOCKED') 'symlinked gate runner must report BLOCKED'
    Assert-MergeTest (@($symlinked.json.blockers) -contains 'merge_gate_runner_invalid') "symlinked gate runner must report merge_gate_runner_invalid (stdout=$($symlinked.stdout))"
    Assert-MergeTest ([string]::IsNullOrWhiteSpace($symlinked.gateLog.Trim())) 'symlinked gate runner must not invoke the gate'
  }

  # 6. An invalid merge method emits the BLOCKED JSON contract, not a raw binder error.
  $badMethod = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha $base -MergeMethod 'fast-forward'
  Assert-MergeTest ($badMethod.exitCode -ne 0) 'invalid merge method must exit non-zero'
  Assert-MergeTest ($null -ne $badMethod.json -and [string]$badMethod.json.status -eq 'BLOCKED') "invalid merge method must emit BLOCKED JSON (stdout=$($badMethod.stdout))"
  Assert-MergeTest (@($badMethod.json.blockers) -contains 'merge_method_invalid') 'invalid merge method must report merge_method_invalid'
  Assert-MergeTest ([string]::IsNullOrWhiteSpace($badMethod.gateLog.Trim())) 'invalid merge method must not invoke the gate'

  # 7. A supplied but malformed -BaseSha is distinct from an underivable one.
  $badBase = Invoke-MergeExecutor -GateJson $readyGate -ViewJson $okView -BaseSha 'not-a-sha'
  Assert-MergeTest ($badBase.exitCode -ne 0) 'malformed supplied base must exit non-zero'
  Assert-MergeTest (@($badBase.json.blockers) -contains 'merge_base_sha_invalid') "malformed supplied base must report merge_base_sha_invalid (stdout=$($badBase.stdout))"
  Assert-MergeTest (@($badBase.json.blockers) -notcontains 'merge_base_sha_unavailable') 'malformed supplied base must not report merge_base_sha_unavailable'
  Assert-MergeTest ([string]::IsNullOrWhiteSpace($badBase.gateLog.Trim())) 'malformed supplied base must not invoke the gate'
} finally {
  foreach ($name in @('BABEL_MERGE_TEST_GATE_JSON', 'BABEL_MERGE_TEST_PR_VIEW', 'BABEL_MERGE_TEST_LOG', 'BABEL_MERGE_TEST_GATE_LOG', 'BABEL_MERGE_TEST_MERGE_EXIT', 'BABEL_MERGE_TEST_GATE_EXIT')) {
    Remove-Item -Path ("Env:$name") -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Output 'AGENT_PR_MERGE_TEST_PASS'
