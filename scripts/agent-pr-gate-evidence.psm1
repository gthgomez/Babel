Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'agent-pr-gate-common.psm1')

function Get-CIProperty($Object, [string]$Name) {
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Get-AgentCISnapshot {
  param([string]$Repository, [string]$TargetSha, [scriptblock]$ReadJson, [DateTimeOffset]$Deadline = ([DateTimeOffset]::UtcNow.AddSeconds(120)), [int64[]]$AuthorityAppIds = @(15368))
  $observations = @(); $workflows = @(); $cache = @{}; $apiCalls = 0
  try {
    foreach ($kind in @('checks', 'workflows')) {
      $rows = @(); $expected = $null
      for ($page = 1; $page -le 100; $page++) {
        $endpoint = if ($kind -eq 'checks') { "repos/$Repository/commits/$TargetSha/check-runs?filter=all&per_page=100&page=$page" }
          else { "repos/$Repository/actions/runs?head_sha=$TargetSha&per_page=100&page=$page" }
        if ([DateTimeOffset]::UtcNow -ge $Deadline) { throw 'github_snapshot_deadline_exceeded' }
        $apiCalls++
        $result = & $ReadJson $endpoint
        if (-not $result.available) {
          $reason = [string](Get-CIProperty $result 'error')
          if ($reason -notmatch '^github_(api_(timeout|forbidden|rate_limited|server_error|unavailable)|json_malformed)$') { $reason = 'github_source_unavailable' }
          throw $reason
        }
        $total = Get-CIProperty $result.value 'total_count'
        $field = if ($kind -eq 'checks') { 'check_runs' } else { 'workflow_runs' }
        $property = $result.value.PSObject.Properties[$field]
        $values = if ($null -ne $property) { @($property.Value) } else { $null }
        if ($null -eq $total -or [string]$total -notmatch '^\d+$' -or $null -eq $property -or $null -eq $property.Value) { throw 'github_snapshot_shape_invalid' }
        if ($null -eq $expected) { $expected = [int]$total }
        if ($expected -ne [int]$total) { throw 'github_snapshot_changed_during_pagination' }
        $rows += @($values)
        if ($rows.Count -eq $expected) { break }
        if ($rows.Count -gt $expected -or @($values).Count -ne 100 -or $page -eq 100) { throw 'github_snapshot_incomplete' }
      }
      $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
      foreach ($row in $rows) {
        $rowId = [string](Get-CIProperty $row 'id')
        if ($rowId -notmatch '^[1-9]\d*$' -or -not $seen.Add($rowId)) { throw 'github_snapshot_duplicate_or_invalid_observation' }
      }
      if ($kind -eq 'checks') { $checks = @($rows) } else { $workflows = @($rows) }
    }
    foreach ($check in $checks) {
      $metadata = @{}
      $url = [string](Get-CIProperty $check 'details_url')
      $appId = [string](Get-CIProperty (Get-CIProperty $check 'app') 'id')
      $runPattern = '^https://github\.com/' + [regex]::Escape($Repository) + '/actions/runs/(?<id>\d+)(?:[/?]|$)'
      if ($appId -match '^\d+$' -and [int64]$appId -in $AuthorityAppIds -and $url -match $runPattern) {
        $id = $Matches.id
        if (-not $cache.ContainsKey($id)) {
          if ([DateTimeOffset]::UtcNow -ge $Deadline) { throw 'github_snapshot_deadline_exceeded' }
          $apiCalls++; $result = & $ReadJson "repos/$Repository/actions/runs/$id"
          if (-not $result.available) {
            $reason = [string](Get-CIProperty $result 'error')
            if ($reason -notmatch '^github_(api_(timeout|forbidden|rate_limited|server_error|unavailable)|json_malformed)$') { $reason = 'workflow_metadata_unavailable' }
            throw $reason
          }
          $cache[$id] = $result.value
        }
        $run = $cache[$id]
        foreach ($pair in @(@('event', 'event'), @('workflow_id', 'workflow_id'), @('workflow_name', 'name'),
          @('workflow_run_id', 'id'), @('workflow_run_attempt', 'run_attempt'), @('started_at', 'created_at'))) {
          $metadata[$pair[0]] = [string](Get-CIProperty $run $pair[1])
        }
        # The run endpoint describes its latest attempt, not this check's
        # attempt. Reruns retain old checks; bind each to its own Actions job.
        if ([string](Get-CIProperty $run 'run_attempt') -match '^[1-9]\d*$' -and [int64](Get-CIProperty $run 'run_attempt') -gt 1) {
          $jobPattern = '^https://github\.com/' + [regex]::Escape($Repository) + '/actions/runs/' + $id + '/job/(?<jobId>[1-9]\d*)(?:[/?]|$)'
          if ($url -notmatch $jobPattern) { throw 'workflow_check_attempt_unavailable' }
          $jobId = $Matches.jobId
          if ([DateTimeOffset]::UtcNow -ge $Deadline) { throw 'github_snapshot_deadline_exceeded' }
          $apiCalls++; $jobResult = & $ReadJson "repos/$Repository/actions/jobs/$jobId"
          if (-not $jobResult.available) { throw 'workflow_check_attempt_unavailable' }
          $job = $jobResult.value
          $jobAttempt = [string](Get-CIProperty $job 'run_attempt')
          $checkUrl = 'https://api.github.com/repos/' + $Repository + '/check-runs/' + [string](Get-CIProperty $check 'id')
          if ([string](Get-CIProperty $job 'run_id') -ne $id -or
              [string](Get-CIProperty $job 'check_run_url') -ne $checkUrl -or
              $jobAttempt -notmatch '^[1-9]\d*$' -or [int64]$jobAttempt -gt [int64](Get-CIProperty $run 'run_attempt')) { throw 'workflow_check_attempt_unavailable' }
          $metadata['workflow_run_attempt'] = $jobAttempt
        }
      }
      $raw = [pscustomobject]@{}
      foreach ($name in @('name', 'head_sha', 'status', 'conclusion', 'started_at', 'completed_at', 'event',
        'workflow_id', 'workflow_name', 'workflow_run_id', 'workflow_run_attempt', 'authority')) {
        $raw | Add-Member -NotePropertyName $name -NotePropertyValue ([string](Get-CIProperty $check $name))
      }
      $raw | Add-Member -NotePropertyName 'check_run_id' -NotePropertyValue ([string](Get-CIProperty $check 'id'))
      $raw | Add-Member -NotePropertyName 'check_suite_id' -NotePropertyValue ([string](Get-CIProperty (Get-CIProperty $check 'check_suite') 'id'))
      foreach ($name in @('id', 'slug', 'name')) {
        $raw | Add-Member -NotePropertyName "app_$name" -NotePropertyValue ([string](Get-CIProperty (Get-CIProperty $check 'app') $name))
      }
      $observations += ConvertTo-AgentCheckObservation -Raw $raw -WorkflowMetadata $metadata
    }
    return [pscustomobject]@{ available = $true; observations = @($observations); workflows = @($workflows); error = ''; apiCalls = $apiCalls }
  } catch {
    # No raw API error/body is retained: it may contain private diagnostics.
    $reason = if ($_.Exception.Message -match '^(github_(api_(timeout|forbidden|rate_limited|server_error|unavailable)|json_malformed|source_unavailable|snapshot_(deadline_exceeded|shape_invalid|changed_during_pagination|incomplete|duplicate_or_invalid_observation))|workflow_metadata_unavailable|workflow_check_attempt_unavailable)$') { $_.Exception.Message } else { 'github_snapshot_invalid' }
    return [pscustomobject]@{ available = $false; observations = @(); workflows = @(); error = $reason; apiCalls = $apiCalls }
  }
}

function Get-AgentCIState {
  param([object]$Snapshot, [object[]]$Policies, [string]$TargetSha)
  $results = @()
  if (-not $Snapshot.available) { return [pscustomobject]@{ state = 'source_unavailable'; ready = $false; terminal = $false; results = @(); reason = $Snapshot.error } }
  foreach ($policy in $Policies) {
    $authority = Get-AgentRequiredCheckAuthority -RequiredName $policy.context
    if (-not $authority.configured) {
      $resolution = [pscustomobject]@{ status = 'AMBIGUOUS'; reason = 'required_check_authority_unconfigured'; selected = $null; candidates = @(); ignored = @() }
    } else {
      $app = if ($null -ne $policy.integration_id) { [int64]$policy.integration_id } else { [int64]0 }
      $resolution = Resolve-AgentRequiredCheck -Observations @($Snapshot.observations) -RequiredName $policy.context -TargetSha $TargetSha -AuthorityEvent $authority.event -AuthorityWorkflowName $authority.workflow_name -AuthorityAppId $app
    }
    $state = if ($resolution.status -eq 'PASS') { 'complete' }
      elseif ($null -ne $resolution.selected -and $resolution.status -eq 'FAIL') { 'failed' }
      elseif ($null -ne $resolution.selected) { if ($resolution.selected.status -eq 'queued') { 'queued' } else { 'running' } }
      elseif ($resolution.status -eq 'AMBIGUOUS') { 'unknown' }
      else { 'workflow_not_observed' }
    if ($null -eq $resolution.selected -and $authority.configured) {
      $eligible = @($Snapshot.workflows | Where-Object { $_.head_sha -eq $TargetSha -and $_.event -eq $authority.event -and $_.name -eq $authority.workflow_name } | Sort-Object created_at -Descending)
      if ($eligible.Count -gt 0) {
        $latest = $eligible[0]
        $state = switch ([string]$latest.status) {
          'queued' { 'queued' }; 'requested' { 'queued' }; 'pending' { 'queued' }
          'in_progress' { 'running' }; 'waiting' { 'waiting' }
          'completed' { 'failed' }; default { 'unknown' }
        }
      }
    }
    # A later eligible run may still have zero jobs. Keep the resolver's
    # selected check, but do not certify an older success over that run.
    if ($resolution.status -eq 'PASS' -and $authority.configured) {
      $eligible = @($Snapshot.workflows | Where-Object { $_.head_sha -eq $TargetSha -and $_.event -eq $authority.event -and $_.name -eq $authority.workflow_name } | Sort-Object created_at -Descending)
      if ($eligible.Count -gt 0) {
        $latest = $eligible[0]; $selected = $resolution.selected
        $sameRun = [string](Get-CIProperty $latest 'id') -eq [string]$selected.workflow_run_id
        $attempt = [string](Get-CIProperty $latest 'run_attempt')
        $created = [DateTimeOffset]::MinValue
        $hasTime = [DateTimeOffset]::TryParse([string](Get-CIProperty $latest 'created_at'), [ref]$created)
        $newer = ($sameRun -and $attempt -match '^\d+$' -and [int]$attempt -gt [int]$selected.workflow_run_attempt) -or
          (-not $sameRun -and $hasTime -and $created -gt (Get-AgentObservationTimestamp -Observation $selected))
        if ($newer) {
          $state = switch ([string]$latest.status) {
            'queued' { 'queued' }; 'requested' { 'queued' }; 'pending' { 'queued' }
            'in_progress' { 'running' }; 'waiting' { 'waiting' }
            'completed' { 'failed' }; default { 'unknown' }
          }
          $resolution.status = if ($state -eq 'failed') { 'FAIL' } else { 'BLOCKED' }
          $resolution.reason = 'newer_authoritative_workflow_without_current_check'
        }
      }
    }
    $results += [pscustomobject]@{ name = $policy.context; state = $state; resolution = $resolution }
  }
  $state = if ($results.Count -eq 0) { 'unknown' }
    elseif (@($results | Where-Object state -eq 'failed').Count -gt 0) { 'failed' }
    elseif (@($results | Where-Object state -ne 'complete').Count -eq 0) { 'complete' }
    else { [string](@($results | Where-Object state -ne 'complete')[0].state) }
  return [pscustomobject]@{ state = $state; ready = $state -eq 'complete'; terminal = $state -in @('complete', 'failed'); results = @($results); reason = $state }
}

function Test-AgentCandidateIdentity {
  param([AllowNull()][object]$Candidate, [string]$HeadSha, [string]$BaseSha)
  $reason = if ($null -eq $Candidate) { 'candidate_source_unavailable' }
    elseif ([string]$Candidate.headRefOid -ne $HeadSha) { 'candidate_head_superseded' }
    elseif ([string]$Candidate.baseRefOid -ne $BaseSha) { 'execution_base_superseded' }
    elseif ([string]$Candidate.state -ne 'OPEN') { 'pr_not_open' }
    elseif ([bool]$Candidate.isDraft) { 'pr_is_draft' }
    elseif ([bool]$Candidate.isCrossRepository) { 'cross_repository_pr' }
    elseif ([string]$Candidate.mergeable -ne 'MERGEABLE') { 'pr_not_mergeable' }
    else { '' }
  return [pscustomobject]@{ valid = [string]::IsNullOrEmpty($reason); reason = $reason }
}

function Wait-AgentCIState {
  param([scriptblock]$ReadState, [scriptblock]$ReadCandidate,
    [scriptblock]$Now = { [DateTimeOffset]::UtcNow }, [scriptblock]$Sleep = { param($Seconds) Start-Sleep -Seconds $Seconds },
    [ValidateRange(0, 3600)][int]$TimeoutSeconds = 120, [ValidateRange(1, 60)][int]$DelaySeconds = 5)
  $deadline = (& $Now).AddSeconds($TimeoutSeconds); $attempts = 0; $last = $null
  while ($true) {
    if ((& $Now) -ge $deadline) { break }
    $identity = & $ReadCandidate $deadline
    if (-not $identity.valid) { return [pscustomobject]@{ ready = $false; attempts = $attempts; reason = $identity.reason; last = $last } }
    if ((& $Now) -ge $deadline) { break }
    $last = & $ReadState $deadline; $attempts++
    if ($last.terminal -or $last.state -in @('workflow_not_observed', 'waiting', 'unknown')) {
      # Bind readiness again after evidence retrieval, including zero-work waits.
      $identity = & $ReadCandidate $deadline
      return [pscustomobject]@{ ready = $last.ready -and $identity.valid; attempts = $attempts; reason = $(if ($identity.valid) { $last.reason } else { $identity.reason }); last = $last }
    }
    $remaining = ($deadline - (& $Now)).TotalSeconds
    if ($remaining -le 0) { break }
    & $Sleep ([Math]::Min($DelaySeconds, $remaining))
  }
  return [pscustomobject]@{ ready = $false; attempts = $attempts; reason = $(if ($null -ne $last -and $last.state -eq 'source_unavailable') { $last.reason } else { 'required_check_wait_timeout' }); last = $last }
}

Export-ModuleMember -Function Get-AgentCISnapshot, Get-AgentCIState, Test-AgentCandidateIdentity, Wait-AgentCIState
