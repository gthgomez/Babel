Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '../../scripts/agent-pr-gate-evidence.psm1') -Force
function Assert-CI($Condition, $Message) { if (-not $Condition) { throw $Message } }
$head = 'a' * 40; $base = 'b' * 40
$policy = @([pscustomobject]@{ context = 'security'; integration_id = 15368 })
function Observation($Id, $Status = 'completed', $Conclusion = 'success', $Event = 'pull_request', $Time = '2026-10-07T12:00:00Z') {
  [pscustomobject]@{ name = 'security'; head_sha = $head; status = $Status; conclusion = $Conclusion;
    check_run_id = $Id; started_at = $Time; completed_at = $Time; event = $Event;
    workflow_name = 'Public Release Gate'; workflow_id = '7'; workflow_run_id = '8'; workflow_run_attempt = '1';
    app_id = '15368'; authority = '' }
}
function State($Observations, $Available = $true, $Workflows = @()) {
  Get-AgentCIState -Snapshot ([pscustomobject]@{ available = $Available; observations = @($Observations); workflows = @($Workflows); error = 'fixture_source_unavailable' }) -Policies $policy -TargetSha $head
}
Assert-CI ((State @((Observation '1'), (Observation '2' 'in_progress' '' 'workflow_dispatch'))).state -eq 'complete') 'Foreign pending check must not delay authoritative success'
Assert-CI ((State @((Observation '1' 'in_progress' '' 'pull_request' '2026-10-07T11:00:00Z'), (Observation '2'))).state -eq 'complete') 'Old pending duplicate must not delay latest success'
Assert-CI ((State @((Observation '1'), (Observation '2' 'queued' '' 'pull_request' '2026-10-07T13:00:00Z'))).state -eq 'queued') 'Newer pending authority must not be hidden by old success'
Assert-CI ((State @((Observation '1' 'completed' 'failure'))).state -eq 'failed') 'Authoritative failure must be terminal'
Assert-CI ((State @() $false).state -eq 'source_unavailable') 'Failed read must remain unavailable rather than missing'
Assert-CI ((State @()).state -eq 'workflow_not_observed') 'Complete absent snapshot must distinguish no workflow'
$waiting = [pscustomobject]@{ name = 'Public Release Gate'; event = 'pull_request'; head_sha = $head; status = 'waiting'; conclusion = ''; created_at = '2026-10-07T13:00:00Z'; id = 9 }
Assert-CI ((State @() $true @($waiting)).state -eq 'waiting') 'Waiting must not invent an approval decision'
$waiting.status = 'queued'
Assert-CI ((State @() $true @($waiting)).state -eq 'queued') 'Zero-job queued workflow must be visible'
$waiting | Add-Member -NotePropertyName run_attempt -NotePropertyValue 1
Assert-CI ((State @((Observation '1')) $true @($waiting)).state -eq 'queued') 'A newer zero-job run must not be concealed by old successful checks'
$waiting.id = 8; $waiting.run_attempt = 2; $waiting.created_at = '2026-10-07T11:00:00Z'
Assert-CI ((State @((Observation '1')) $true @($waiting)).state -eq 'queued') 'Later attempt of the same workflow must block old success even before jobs appear'
$waiting.run_attempt = 1
Assert-CI ((State @((Observation '1')) $true @($waiting)).state -eq 'complete') 'An older workflow must not hide newer successful checks'
$candidate = [pscustomobject]@{ state = 'OPEN'; isDraft = $false; headRefOid = $head; baseRefOid = $base; baseRefName = 'main'; mergeable = 'MERGEABLE'; isCrossRepository = $false }
Assert-CI ((Test-AgentCandidateIdentity -Candidate $candidate -HeadSha $head -BaseSha $base).valid) 'Current candidate should validate'
foreach ($change in @('base', 'head', 'closed', 'draft', 'conflict')) {
  $copy = $candidate.PSObject.Copy()
  switch ($change) { base { $copy.baseRefOid = 'c' * 40 }; head { $copy.headRefOid = 'c' * 40 }; closed { $copy.state = 'CLOSED' }; draft { $copy.isDraft = $true }; conflict { $copy.mergeable = 'CONFLICTING' } }
  Assert-CI (-not (Test-AgentCandidateIdentity -Candidate $copy -HeadSha $head -BaseSha $base).valid) "Invalid $change must stop"
}
# Page-two evidence and one metadata read per run, using real snapshot transport logic.
$counts = @{ metadata = 0; pages = 0 }
$raw = 1..140 | ForEach-Object { [pscustomobject]@{ id = $_; name = $(if ($_ -eq 140) { 'security' } else { 'matrix' }); head_sha = $head;
  status = 'completed'; conclusion = 'success'; started_at = '2026-10-07T12:00:00Z'; completed_at = '2026-10-07T12:01:00Z';
  details_url = 'https://github.com/test/repo/actions/runs/8/job/1'; app = [pscustomobject]@{ id = 15368 } } }
$read = {
  param($Endpoint)
  if ($Endpoint -like '*check-runs*') {
    $counts.pages++
    $rows = if ($Endpoint -match 'page=2$') { @($raw[100..139]) } else { @($raw[0..99]) }
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 140; check_runs = $rows }; error = '' }
  }
  if ($Endpoint -like '*/actions/runs/8') {
    $counts.metadata++
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ id = 8; workflow_id = 7; name = 'Public Release Gate'; event = 'pull_request'; head_sha = $head; run_attempt = 1; created_at = '2026-10-07T12:00:00Z' }; error = '' }
  }
  if ($Endpoint -like '*/actions/runs`?*') { return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 0; workflow_runs = @() }; error = '' } }
  throw "Unexpected fixture endpoint: $Endpoint"
}
$snapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $read
Assert-CI ($snapshot.available -and $snapshot.observations.Count -eq 140) 'All pages must be present'
Assert-CI ($counts.pages -eq 2 -and $counts.metadata -eq 1) 'Pagination and per-snapshot metadata cache must be bounded'
Assert-CI ((Get-AgentCIState -Snapshot $snapshot -Policies $policy -TargetSha $head).state -eq 'complete') 'Page-two required check must pass'
# Exercise paginated attempt enrichment: REST check rows omit their workflow attempt.
$rerunAttemptOne = $raw[139].PSObject.Copy()
$rerunAttemptOne.id = 140
$rerunAttemptOne.details_url = 'https://github.com/test/repo/actions/runs/8/job/1'
$rerunAttemptTwo = $raw[139].PSObject.Copy()
$rerunAttemptTwo.id = 141
$rerunAttemptTwo.started_at = '2026-10-07T12:02:00Z'
$rerunAttemptTwo.details_url = 'https://github.com/test/repo/actions/runs/8/job/2'
$rerunFixture = @{ status = 'queued'; checkAttempt = 1; jobRun = 8; jobTimeouts = 0; jobReads = 0; jobReadsByAttempt = @{ 1 = 0; 2 = 0 }; includeAttemptTwoCheck = $false }
$rerun = [pscustomobject]@{ id = 8; workflow_id = 7; name = 'Public Release Gate'; event = 'pull_request';
  head_sha = $head; run_attempt = 2; created_at = '2026-10-07T12:00:00Z'; status = 'queued' }
$rerunRead = {
  param($Endpoint)
  if ($Endpoint -like '*check-runs*') {
    $rows = if ($rerunFixture.includeAttemptTwoCheck) { @($rerunAttemptOne, $rerunAttemptTwo) } else { @($rerunAttemptOne) }
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = $rows.Count; check_runs = $rows }; error = '' }
  }
  if ($Endpoint -like '*/actions/runs`?*') { $rerun.status = $rerunFixture.status; return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 1; workflow_runs = @($rerun) }; error = '' } }
  if ($Endpoint -like '*/actions/runs/8') { return [pscustomobject]@{ available = $true; value = $rerun; error = '' } }
  if ($Endpoint -match '/actions/runs/8/attempts/(?<attempt>[12])/jobs\?per_page=100&page=1$') {
    $attempt = [int]$Matches.attempt
    $rerunFixture.jobReads++
    $rerunFixture.jobReadsByAttempt[$attempt]++
    if ($attempt -eq 2 -and $rerunFixture.jobTimeouts -gt 0) { $rerunFixture.jobTimeouts--; return [pscustomobject]@{ available = $false; value = $null; error = 'github_api_timeout' } }
    $jobs = if ($attempt -eq 1) {
      @([pscustomobject]@{ id = 1; run_id = $rerunFixture.jobRun; run_attempt = 1; head_sha = $head; check_run_url = 'https://api.github.com/repos/test/repo/check-runs/140' })
    } elseif ($rerunFixture.includeAttemptTwoCheck) {
      @([pscustomobject]@{ id = 2; run_id = $rerunFixture.jobRun; run_attempt = 2; head_sha = $head; check_run_url = 'https://api.github.com/repos/test/repo/check-runs/141' })
    } else {
      @([pscustomobject]@{ id = 2; run_id = $rerunFixture.jobRun; run_attempt = 2; head_sha = $head; check_run_url = 'https://api.github.com/repos/test/repo/check-runs/142' })
    }
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = $jobs.Count; jobs = $jobs }; error = '' }
  }
  throw 'Unexpected rerun fixture endpoint'
}
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
$rerunState = Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head
Assert-CI ($rerunSnapshot.available -and -not $rerunState.ready -and $rerunState.state -eq 'queued') 'Snapshot enrichment must not relabel an old success as a queued rerun attempt'
$rerunFixture.status = 'completed'
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI ((Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head).state -eq 'failed') 'A completed newer attempt without its required check must block old success'
$rerunFixture.checkAttempt = 2
$rerunFixture.includeAttemptTwoCheck = $true
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI ((Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head).ready) 'A successful check bound to the latest completed attempt must pass'
$readsBeforeRetry = $rerunFixture.jobReadsByAttempt[2]
$rerunFixture.jobTimeouts = 1
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI ($rerunSnapshot.available -and (Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head).ready) 'A single transient job metadata timeout may be recovered by the bounded retry'
Assert-CI ($rerunFixture.jobReadsByAttempt[2] -eq ($readsBeforeRetry + 2)) "Attempt job-list retry count must remain bounded to one retry ($readsBeforeRetry -> $($rerunFixture.jobReadsByAttempt[2]))"
$rerunFixture.jobTimeouts = 2
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI (-not $rerunSnapshot.available -and $rerunSnapshot.error -eq 'workflow_check_attempt_unavailable') 'Repeated job metadata timeouts must remain fail-closed'
$rerunFixture.jobRun = 99
$rerunFixture.jobTimeouts = 0
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI (-not $rerunSnapshot.available -and $rerunSnapshot.error -eq 'workflow_check_attempt_unavailable') 'Mismatched job lineage must fail closed with a safe diagnostic'
$batchChecks = @(); $batchJobs = @{ 1 = @(); 2 = @() }; $batchJobCount = 105
for ($attempt = 1; $attempt -le 2; $attempt++) {
  for ($index = 1; $index -le $batchJobCount; $index++) {
    $jobId = if ($attempt -eq 1) { $index } else { 1000 + $index }
    $checkId = 300000 + ($attempt * 1000) + $index
    $name = if ($index -eq 1) { 'security' } else { "batch-matrix-$index" }
    $startedAt = if ($attempt -eq 1) { '2026-10-07T12:00:00Z' } else { '2026-10-07T12:02:00Z' }
    $batchJobs[$attempt] += [pscustomobject]@{ id = $jobId; run_id = 90; run_attempt = $attempt; head_sha = $head;
      check_run_url = "https://api.github.com/repos/test/repo/check-runs/$checkId" }
    $batchChecks += [pscustomobject]@{ id = $checkId; name = $name; head_sha = $head; status = 'completed'; conclusion = 'success';
      started_at = $startedAt; completed_at = '2026-10-07T12:03:00Z'; details_url = "https://github.com/test/repo/actions/runs/90/job/$jobId";
      app = [pscustomobject]@{ id = 15368 }; check_suite = [pscustomobject]@{ id = 900 + $attempt } }
  }
}
$batchWorkflow = [pscustomobject]@{ id = 90; name = 'Public Release Gate'; event = 'pull_request'; workflow_id = 7; head_sha = $head;
  run_attempt = 2; status = 'completed'; conclusion = 'success'; created_at = '2026-10-07T12:00:00Z' }
$batchReadCounts = @{ calls = 0; checkPages = 0; workflowPages = 0; runReads = 0; jobPages = @{ 1 = 0; 2 = 0 }; individualJobReads = 0 }
$batchRead = {
  param($Endpoint)
  $batchReadCounts.calls++
  if ($Endpoint -like '*check-runs*') {
    $batchReadCounts.checkPages++
    $page = [int]([regex]::Match($Endpoint, 'page=(\d+)$').Groups[1].Value)
    $start = ($page - 1) * 100; $end = [Math]::Min($start + 99, $batchChecks.Count - 1)
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = $batchChecks.Count; check_runs = @($batchChecks[$start..$end]) }; error = '' }
  }
  if ($Endpoint -like '*/actions/runs`?*') {
    $batchReadCounts.workflowPages++
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 1; workflow_runs = @($batchWorkflow) }; error = '' }
  }
  if ($Endpoint -eq 'repos/test/repo/actions/runs/90') {
    $batchReadCounts.runReads++
    return [pscustomobject]@{ available = $true; value = $batchWorkflow; error = '' }
  }
  if ($Endpoint -match '/actions/runs/90/attempts/(?<attempt>[12])/jobs\?per_page=100&page=(?<page>\d+)$') {
    $attempt = [int]$Matches.attempt; $page = [int]$Matches.page
    $batchReadCounts.jobPages[$attempt]++
    $start = ($page - 1) * 100; $end = [Math]::Min($start + 99, $batchJobs[$attempt].Count - 1)
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = $batchJobs[$attempt].Count; jobs = @($batchJobs[$attempt][$start..$end]) }; error = '' }
  }
  if ($Endpoint -like '*/actions/jobs/*') { $batchReadCounts.individualJobReads++; throw 'Individual job endpoint must not be used by batch snapshot' }
  throw "Unexpected batch evidence endpoint: $Endpoint"
}
$batchSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $batchRead
$batchState = Get-AgentCIState -Snapshot $batchSnapshot -Policies $policy -TargetSha $head
Assert-CI ($batchSnapshot.available -and $batchSnapshot.observations.Count -eq 210) 'Batch snapshot must retain every check across two attempts'
Assert-CI ($batchSnapshot.apiCalls -eq 9 -and $batchReadCounts.calls -eq 9 -and $batchReadCounts.checkPages -eq 3 -and
  $batchReadCounts.workflowPages -eq 1 -and $batchReadCounts.runReads -eq 1 -and $batchReadCounts.jobPages[1] -eq 2 -and
  $batchReadCounts.jobPages[2] -eq 2 -and $batchReadCounts.individualJobReads -eq 0) '210 check rows must use complete 2-attempt paginated batches, not 210 individual job reads'
Assert-CI ($batchState.state -eq 'complete' -and $batchState.results[0].resolution.selected.check_run_id -eq '302001' -and
  $batchState.results[0].resolution.selected.workflow_run_attempt -eq '2') 'Latest exact-attempt success must remain authoritative after batching'
foreach ($batchFault in @('no_access','partial','duplicate','missing','foreign_run','wrong_attempt','foreign_sha','wrong_check_url','ambiguous')) {
  $faultJobs = @{
    1 = @($batchJobs[1] | ForEach-Object { $_.PSObject.Copy() })
    2 = @($batchJobs[2] | ForEach-Object { $_.PSObject.Copy() })
  }
  switch ($batchFault) {
    partial { }
    duplicate { $faultJobs[2][1].id = $faultJobs[2][0].id }
    missing { $faultJobs[2] = @($faultJobs[2] | Where-Object { $_.id -ne 1001 }) }
    foreign_run { $faultJobs[2][0].run_id = 99 }
    wrong_attempt { $faultJobs[2][0].run_attempt = 1 }
    foreign_sha { $faultJobs[2][0].head_sha = 'b' * 40 }
    wrong_check_url { $faultJobs[2][0].check_run_url = 'https://api.github.com/repos/test/repo/check-runs/999999' }
    ambiguous { $faultJobs[2][0].id = 1; $faultJobs[2][0].check_run_url = 'https://api.github.com/repos/test/repo/check-runs/302001' }
  }
  $faultRead = {
    param($Endpoint)
    if ($Endpoint -match '/actions/runs/90/attempts/2/jobs\?per_page=100&page=(?<page>\d+)$') {
      if ($batchFault -eq 'no_access') { return [pscustomobject]@{ available = $false; value = $null; error = 'github_api_forbidden' } }
      $page = [int]$Matches.page; $total = $faultJobs[2].Count
      if ($batchFault -eq 'partial') { $total++ }
      $start = ($page - 1) * 100; $end = [Math]::Min($start + 99, $faultJobs[2].Count - 1)
      $jobs = if ($faultJobs[2].Count -gt 0) { @($faultJobs[2][$start..$end]) } else { @() }
      return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = $total; jobs = $jobs }; error = '' }
    }
    & $batchRead $Endpoint
  }
  $faultSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $faultRead
  Assert-CI (-not $faultSnapshot.available) "$batchFault attempt job evidence must fail closed"
}
$foreign = $raw[139].PSObject.Copy()
$foreign.id = 141
$foreign.app = [pscustomobject]@{ id = 999 }
$foreign.details_url = 'https://github.com/test/repo/actions/runs/666/job/1'
$foreignSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson {
  param($Endpoint)
  if ($Endpoint -like '*check-runs*') { return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 2; check_runs = @($raw[139], $foreign) }; error = '' } }
  & $read $Endpoint
}
Assert-CI ($foreignSnapshot.available -and (Get-AgentCIState -Snapshot $foreignSnapshot -Policies $policy -TargetSha $head).ready) 'Foreign app detail URLs must not make authoritative evidence unavailable'
$duplicate = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson {
  param($Endpoint)
  if ($Endpoint -like '*check-runs*') { return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 2; check_runs = @($raw[139], $raw[139]) }; error = '' } }
  & $read $Endpoint
}
Assert-CI (-not $duplicate.available -and $duplicate.error -eq 'github_snapshot_duplicate_or_invalid_observation') 'Duplicate rows cannot certify complete retrieval'
$partial = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson { param($Endpoint) [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 3; check_runs = @() }; error = '' } }
Assert-CI (-not $partial.available) 'Incomplete fetch must never appear complete'
foreach ($reason in @('github_api_forbidden', 'github_api_rate_limited', 'github_api_server_error', 'github_api_timeout', 'github_json_malformed')) {
  $failure = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson { param($Endpoint) [pscustomobject]@{ available = $false; value = $null; error = $reason } }
  Assert-CI (-not $failure.available -and $failure.error -eq $reason) "Safe source reason $reason must survive final snapshot failure"
  Assert-CI ((Get-AgentCIState -Snapshot $failure -Policies $policy -TargetSha $head).state -eq 'source_unavailable') 'Successful earlier polling must not mask unavailable final evidence'
}
$failure = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson { throw 'github_private_synthetic_canary' }
Assert-CI ($failure.error -eq 'github_snapshot_invalid') 'Unexpected API exceptions must not expose their body'
# Fake wall clock: no sleeps, real waiting state machine and identity checks.
$clock = @{ now = [DateTimeOffset]::Parse('2026-10-07T12:00:00Z'); reads = 0 }
$pending = State @((Observation '2' 'in_progress' ''))
$wait = Wait-AgentCIState -ReadState { $clock.reads++; $pending } -ReadCandidate { [pscustomobject]@{ valid = $true; reason = '' } } -Now { $clock.now } -Sleep { param($Seconds) $clock.now = $clock.now.AddSeconds($Seconds) } -TimeoutSeconds 12 -DelaySeconds 5
Assert-CI (-not $wait.ready -and $wait.reason -eq 'required_check_wait_timeout' -and $clock.reads -eq 2) 'Backoff must reduce polls while honoring the wall-clock deadline'
$wait = Wait-AgentCIState -ReadState { throw 'must not poll superseded candidate' } -ReadCandidate { [pscustomobject]@{ valid = $false; reason = 'execution_base_superseded' } }
Assert-CI (-not $wait.ready -and $wait.reason -eq 'execution_base_superseded') 'Stale execution base must stop before polling'
$identityReads = @{ count = 0 }
$wait = Wait-AgentCIState -ReadState { State @((Observation '1')) } -ReadCandidate {
  $identityReads.count++
  [pscustomobject]@{ valid = $identityReads.count -eq 1; reason = 'execution_base_superseded' }
}
Assert-CI (-not $wait.ready) 'Base movement during final read must invalidate complete CI'
Import-Module (Join-Path $PSScriptRoot '../../scripts/agent-git-common.psm1') -Force
$request = Invoke-AgentGh -GhPath (Get-Command pwsh).Source -RepoRoot $PSScriptRoot -Arguments @('-NoProfile', '-Command', 'Start-Sleep -Seconds 10') -TimeoutSeconds 1
Assert-CI ($request.exitCode -eq 124 -and $request.text -eq 'agent_request_timeout') 'Owned API process must have a hard request deadline'
# Exercise the installed gate's actual admission/final-state statements with
# controlled API results, without invoking a network or copying its conditions.
$parseErrors = $null; $tokens = $null
$gateAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../scripts/agent-pr-gate.ps1'), [ref]$tokens, [ref]$parseErrors)
Assert-CI ($parseErrors.Count -eq 0) 'Gate must parse'
function Gate-Statement([string]$Pattern) {
  $nodes = @($gateAst.FindAll({ param($node) $node -is [Management.Automation.Language.StatementAst] -and $node.Extent.Text -match $Pattern }, $true) | ForEach-Object { $_.Extent.Text } | Select-Object -Unique)
  Assert-CI ($nodes.Count -eq 1) "Expected one gate statement: $Pattern"
  [scriptblock]::Create($nodes[0])
}
$deferStatement = Gate-Statement '^\$deferMergeState ='
$initialState = Gate-Statement '^if \(-not \$deferMergeState\)'
$waitStatement = Gate-Statement '^\$requiredChecksReady = if \(\$CheckWaitSeconds -eq 0\)'
$finalState = Gate-Statement '^if \(\$deferMergeState\)'
$refreshedState = Gate-Statement "^Add-AgentCheck -Name 'POST_WAIT_MERGE_STATE_CLEAN'"
$failedWait = Gate-Statement '^if \(\$deferMergeState -and -not'
function Test-GateWaitCase($Seconds, $Mergeable, $Initial, $Final, $OtherBlocker, $Ready, $ExpectedWait, $ExpectedPass) {
  $CheckWaitSeconds = $Seconds; $prAvailable = $true; $authOk = $true
  $prHead = 'a' * 40; $runningTrustedControlPlane = $false
  $prView = [pscustomobject]@{ mergeable = $Mergeable; mergeStateStatus = $Initial }
  $freshPR = [pscustomobject]@{ available = $true; value = [pscustomobject]@{ mergeable = $Mergeable; mergeStateStatus = $Final } }
  $rulesetPolicy = [pscustomobject]@{ available = $true }
  $blockers = @(); if ($OtherBlocker) { $blockers += 'fixture_blocker' }
  $mergeStateAcceptable = $Initial -eq 'CLEAN'; $observed = @{ waits = 0; passed = $null }
  function Test-AgentShaValue($Value) { $Value -match '^[a-f0-9]{40}$' }
  function Add-AgentCheck($Name, $Passed, $Blocker) { $observed.passed = $Passed; if (-not $Passed) { $script:unused = $Blocker } }
  function Wait-AgentRequiredChecksReady { $observed.waits++; [pscustomobject]@{ ready = $Ready; attempts = 1 } }
  . $deferStatement; . $initialState; . $waitStatement
  if ($requiredChecksReady.ready -and $requiredChecksReady.attempts -gt 0) { . $refreshedState; . $finalState }
  . $failedWait
  Assert-CI ($observed.waits -eq $ExpectedWait) "Wait admission: $Initial/$OtherBlocker/$Seconds"
  Assert-CI ($observed.passed -eq $ExpectedPass) "Final merge state: $Initial/$Final/$Ready"
}
Test-GateWaitCase 30 MERGEABLE BLOCKED CLEAN $false $true 1 $true
Test-GateWaitCase 30 MERGEABLE BLOCKED BLOCKED $false $true 1 $false
Test-GateWaitCase 30 MERGEABLE BLOCKED CLEAN $true $true 0 $false
Test-GateWaitCase 30 MERGEABLE BLOCKED CLEAN $false $false 1 $false
Test-GateWaitCase 0 MERGEABLE BLOCKED CLEAN $false $true 0 $false
Test-GateWaitCase 30 MERGEABLE CLEAN BLOCKED $false $true 1 $false

# Exercise the actual freshness predicate: recorded PR provenance is not the
# authenticated target, and cannot establish whether a fetch is current.
Import-Module (Join-Path $PSScriptRoot '../../scripts/agent-pr-gate-common.psm1') -Force
$baseCheck = Gate-Statement "^Add-AgentCheck -Name 'REMOTE_BASE_CURRENT'"
$prBase = 'b' * 40; $liveBaseSha = 'c' * 40; $originMain = $liveBaseSha
$liveTarget = [pscustomobject]@{ valid = $true; sha = $liveBaseSha }
$observedBase = @{ passed = $false }
function Add-AgentCheck($Name, $Passed, $Blocker) { $observedBase.passed = $Passed }
. $baseCheck
Assert-CI $observedBase.passed 'Old recorded base with fetched/live target equality must pass freshness'
$originMain = $prBase
. $baseCheck
Assert-CI (-not $observedBase.passed) 'A genuinely stale fetch must fail even when it equals recorded provenance'
$originMain = $liveBaseSha; $liveTarget.valid = $false
. $baseCheck
Assert-CI (-not $observedBase.passed) 'Unavailable authenticated ref must fail closed'
$liveTarget.valid = $true; $originMain = $liveBaseSha; $executionBaseValid = $true; $executionBase = $liveBaseSha
$trustedBinding = Gate-Statement '^\$trustedExecutionBaseBound ='
. $trustedBinding
Assert-CI $trustedExecutionBaseBound 'The actual evaluator must be pinned to the authenticated target'
$executionBase = $prBase
. $trustedBinding
Assert-CI (-not $trustedExecutionBaseBound) 'Old or candidate-selected evaluator source cannot qualify even under nonstrict policy'

$ref = [pscustomobject]@{ ref = 'refs/heads/main'; url = 'https://api.github.com/repos/test/repo/git/refs/heads/main'; object = [pscustomobject]@{ type = 'commit'; sha = $liveBaseSha } }
Assert-CI ((Resolve-AgentTargetRef -Ref $ref -Repository 'test/repo' -Branch 'main').valid) 'Authenticated repository/ref/commit identity must validate'
foreach ($bad in @(
    $null,
    [pscustomobject]@{ ref = 'refs/heads/other'; url = $ref.url; object = $ref.object },
    [pscustomobject]@{ ref = $ref.ref; url = 'https://api.github.com/repos/other/repo/git/refs/heads/main'; object = $ref.object },
    [pscustomobject]@{ ref = $ref.ref; url = $ref.url; object = [pscustomobject]@{ type = 'tag'; sha = $liveBaseSha } },
    [pscustomobject]@{ ref = $ref.ref; url = $ref.url; object = [pscustomobject]@{ type = 'commit'; sha = 'short' } }
  )) {
  Assert-CI (-not (Resolve-AgentTargetRef -Ref $bad -Repository 'test/repo' -Branch 'main').valid) 'Missing, wrong or malformed authenticated refs must reject'
}

# Run the real final-identity function with API reads replaced, including a
# live-target advance under nonstrict policy. No admission logic is copied.
$identityFunction = @($gateAst.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-AgentCurrentCandidateIdentity' }, $true))
Assert-CI ($identityFunction.Count -eq 1) 'Final identity function must exist'
. ([scriptblock]::Create($identityFunction[0].Extent.Text))
$PR = 42; $ExpectedRepository = 'test/repo'; $ExpectedBaseBranch = 'main'; $prFields = 'fixture'
$prHead = $head; $prBase = $base; $executionBase = $liveBaseSha
$api = @{ candidate = $candidate; target = $ref; available = $true }
function Get-AgentJsonFromGh {
  param($Deadline, $Arguments)
  if ($Arguments[0] -eq 'pr') { return [pscustomobject]@{ available = $true; value = $api.candidate } }
  Assert-CI ($Arguments[1] -eq 'repos/test/repo/git/ref/heads/main') 'Target read must use the exact authenticated repository/branch'
  return [pscustomobject]@{ available = $api.available; value = $api.target }
}
Assert-CI ((Get-AgentCurrentCandidateIdentity).valid) 'Unchanged recorded provenance and live tip must validate'
$api.target = [pscustomobject]@{ ref = $ref.ref; url = $ref.url; object = [pscustomobject]@{ type = 'commit'; sha = ('d' * 40) } }
Assert-CI (-not (Get-AgentCurrentCandidateIdentity).valid) 'Target advancement must reject even without strict ancestry policy'
$api.target = $ref; $api.available = $false
Assert-CI (-not (Get-AgentCurrentCandidateIdentity).valid) 'Deleted or unreadable target must reject final settlement'
$api.available = $true; $api.candidate = $candidate.PSObject.Copy(); $api.candidate.baseRefName = 'other'
Assert-CI (-not (Get-AgentCurrentCandidateIdentity).valid) 'Retargeting the PR must reject'
$api.candidate.baseRefName = 'main'; $api.candidate.headRefOid = 'd' * 40
Assert-CI (-not (Get-AgentCurrentCandidateIdentity).valid) 'Changed head must reject final settlement'
Write-Output 'AGENT_CI_EVIDENCE_TEST_PASS'
