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
$candidate = [pscustomobject]@{ state = 'OPEN'; isDraft = $false; headRefOid = $head; baseRefOid = $base; mergeable = 'MERGEABLE'; isCrossRepository = $false }
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
    return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ id = 8; workflow_id = 7; name = 'Public Release Gate'; event = 'pull_request'; run_attempt = 1; created_at = '2026-10-07T12:00:00Z' }; error = '' }
  }
  if ($Endpoint -like '*/actions/runs`?*') { return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 0; workflow_runs = @() }; error = '' } }
  throw "Unexpected fixture endpoint: $Endpoint"
}
$snapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $read
Assert-CI ($snapshot.available -and $snapshot.observations.Count -eq 140) 'All pages must be present'
Assert-CI ($counts.pages -eq 2 -and $counts.metadata -eq 1) 'Pagination and per-snapshot metadata cache must be bounded'
Assert-CI ((Get-AgentCIState -Snapshot $snapshot -Policies $policy -TargetSha $head).state -eq 'complete') 'Page-two required check must pass'
# Exercise real enrichment: REST check rows omit their workflow attempt.
$rerunFixture = @{ status = 'queued'; checkAttempt = 1; jobRun = 8 }
$rerun = [pscustomobject]@{ id = 8; workflow_id = 7; name = 'Public Release Gate'; event = 'pull_request';
  head_sha = $head; run_attempt = 2; created_at = '2026-10-07T12:00:00Z'; status = 'queued' }
$rerunRead = {
  param($Endpoint)
  if ($Endpoint -like '*check-runs*') { return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 1; check_runs = @($raw[139]) }; error = '' } }
  if ($Endpoint -like '*/actions/runs`?*') { $rerun.status = $rerunFixture.status; return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ total_count = 1; workflow_runs = @($rerun) }; error = '' } }
  if ($Endpoint -like '*/actions/runs/8') { return [pscustomobject]@{ available = $true; value = $rerun; error = '' } }
  if ($Endpoint -like '*/actions/jobs/1') { return [pscustomobject]@{ available = $true; value = [pscustomobject]@{ run_id = $rerunFixture.jobRun; run_attempt = $rerunFixture.checkAttempt; check_run_url = 'https://api.github.com/repos/test/repo/check-runs/140' }; error = '' } }
  throw 'Unexpected rerun fixture endpoint'
}
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
$rerunState = Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head
Assert-CI ($rerunSnapshot.available -and -not $rerunState.ready -and $rerunState.state -eq 'queued') 'Snapshot enrichment must not relabel an old success as a queued rerun attempt'
$rerunFixture.status = 'completed'
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI ((Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head).state -eq 'failed') 'A completed newer attempt without its required check must block old success'
$rerunFixture.checkAttempt = 2
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI ((Get-AgentCIState -Snapshot $rerunSnapshot -Policies $policy -TargetSha $head).ready) 'A successful check bound to the latest completed attempt must pass'
$rerunFixture.jobRun = 99
$rerunSnapshot = Get-AgentCISnapshot -Repository 'test/repo' -TargetSha $head -ReadJson $rerunRead
Assert-CI (-not $rerunSnapshot.available -and $rerunSnapshot.error -eq 'workflow_check_attempt_unavailable') 'Mismatched job lineage must fail closed with a safe diagnostic'
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
Assert-CI (-not $wait.ready -and $wait.reason -eq 'required_check_wait_timeout' -and $clock.reads -eq 3) 'Wait must honor wall-clock deadline'
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
Write-Output 'AGENT_CI_EVIDENCE_TEST_PASS'
