Set-StrictMode -Version Latest

function Get-AgentPropertyValue {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($null -eq $Object) { return $null }
  if ($Object -is [System.Collections.IDictionary] -and $Object.Contains($Name)) { return $Object[$Name] }
  if ($null -eq $Object.PSObject.Properties[$Name]) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Test-AgentShaValue {
  param([AllowNull()][object]$Value)
  return $null -ne $Value -and [string]$Value -match '^[0-9a-fA-F]{40}$'
}

function ConvertTo-AgentCheckObservation {
  param(
    [Parameter(Mandatory = $true)][object]$Raw,
    [hashtable]$WorkflowMetadata = @{}
  )

  $get = { param([string]$Name)
    $rawValue = Get-AgentPropertyValue -Object $Raw -Name $Name
    if ($null -ne $rawValue -and -not [string]::IsNullOrWhiteSpace([string]$rawValue)) { return $rawValue }
    if ($WorkflowMetadata.ContainsKey($Name)) { return $WorkflowMetadata[$Name] }
    return $null
  }

  return [pscustomobject][ordered]@{
    name = [string](& $get 'name')
    head_sha = [string](& $get 'head_sha')
    status = [string](& $get 'status')
    conclusion = [string](& $get 'conclusion')
    workflow_id = [string](& $get 'workflow_id')
    workflow_name = [string](& $get 'workflow_name')
    workflow_run_id = [string](& $get 'workflow_run_id')
    workflow_run_attempt = [string](& $get 'workflow_run_attempt')
    event = [string](& $get 'event')
    check_suite_id = [string](& $get 'check_suite_id')
    check_run_id = [string](& $get 'check_run_id')
    started_at = [string](& $get 'started_at')
    completed_at = [string](& $get 'completed_at')
    authority = [string](& $get 'authority')
  }
}

function Get-AgentObservationTimestamp {
  param([Parameter(Mandatory = $true)][object]$Observation)
  $value = if (-not [string]::IsNullOrWhiteSpace([string]$Observation.started_at)) { [string]$Observation.started_at } else { [string]$Observation.completed_at }
  $parsed = [DateTimeOffset]::MinValue
  if ([string]::IsNullOrWhiteSpace($value) -or -not [DateTimeOffset]::TryParse($value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsed)) {
    return $null
  }
  return $parsed
}

function Get-AgentNumericIdentity {
  param([AllowNull()][object]$Value)
  $text = [string]$Value
  if ($text -match '(?<!\d)(\d+)$') { return [int64]$Matches[1] }
  return [int64]0
}

function Test-AgentIntentionalDetachedCandidate {
  param(
    [Parameter(Mandatory = $true)][bool]$IsDetached,
    [Parameter(Mandatory = $true)][bool]$AllowIntentionalDetachedCandidate,
    [Parameter(Mandatory = $true)][bool]$RequireIsolatedWorktree,
    [Parameter(Mandatory = $true)][string]$LocalHead,
    [Parameter(Mandatory = $true)][string]$ReviewedHead
  )
  if (-not $AllowIntentionalDetachedCandidate) { return [pscustomobject]@{ accepted = $false; reason = 'detached_candidate_opt_in_missing' } }
  if (-not $IsDetached) { return [pscustomobject]@{ accepted = $false; reason = 'candidate_is_not_detached' } }
  if (-not $RequireIsolatedWorktree) { return [pscustomobject]@{ accepted = $false; reason = 'detached_candidate_not_isolated' } }
  if (-not (Test-AgentShaValue -Value $LocalHead) -or -not (Test-AgentShaValue -Value $ReviewedHead)) { return [pscustomobject]@{ accepted = $false; reason = 'detached_candidate_sha_invalid' } }
  if (-not [string]::Equals($LocalHead, $ReviewedHead, [StringComparison]::OrdinalIgnoreCase)) { return [pscustomobject]@{ accepted = $false; reason = 'detached_candidate_sha_mismatch' } }
  return [pscustomobject]@{ accepted = $true; reason = 'intentional_exact_sha_candidate' }
}

function Resolve-AgentTrustedMergeState {
  param(
    [Parameter(Mandatory = $true)][bool]$RunningTrustedSelfCheck,
    [Parameter(Mandatory = $true)][string]$MergeStateStatus,
    [Parameter(Mandatory = $true)][string]$Mergeable
  )
  if ([string]::Equals($MergeStateStatus, 'CLEAN', [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ accepted = $true; reason = 'merge_state_clean' }
  }
  if ($RunningTrustedSelfCheck -and
      [string]::Equals($MergeStateStatus, 'BLOCKED', [StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals($Mergeable, 'MERGEABLE', [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ accepted = $true; reason = 'trusted_self_check_pending_is_deferred' }
  }
  return [pscustomobject]@{ accepted = $false; reason = 'merge_state_not_clean' }
}

function Resolve-AgentRequiredCheck {
  param(
    [Parameter(Mandatory = $true)][object[]]$Observations,
    [Parameter(Mandatory = $true)][string]$RequiredName,
    [Parameter(Mandatory = $true)][string]$TargetSha,
    [Parameter(Mandatory = $true)][string]$AuthorityEvent,
    [Parameter(Mandatory = $true)][string]$AuthorityWorkflowName
  )

  $matching = @($Observations | Where-Object {
      $name = [string]$_.name
      [string]::Equals($name, $RequiredName, [StringComparison]::OrdinalIgnoreCase) -or
        $name.StartsWith("$RequiredName /", [StringComparison]::OrdinalIgnoreCase) -or
        $name.StartsWith("${RequiredName}:", [StringComparison]::OrdinalIgnoreCase)
    })
  $exactHead = @($matching | Where-Object { [string]::Equals([string]$_.head_sha, $TargetSha, [StringComparison]::OrdinalIgnoreCase) })
  if ($exactHead.Count -eq 0) {
    return [pscustomobject][ordered]@{ status = 'FAIL'; reason = 'required_check_missing_for_exact_head'; required = $RequiredName; selected = $null; candidates = @(); ignored = @() }
  }

  $eligible = @()
  $ignored = @()
  foreach ($observation in $exactHead) {
    $eventMatches = [string]::Equals([string]$observation.event, $AuthorityEvent, [StringComparison]::OrdinalIgnoreCase)
    $workflowMatches = [string]::Equals([string]$observation.workflow_name, $AuthorityWorkflowName, [StringComparison]::OrdinalIgnoreCase)
    $explicitlyNonAuthoritative = [string]::Equals([string]$observation.authority, 'non_authoritative', [StringComparison]::OrdinalIgnoreCase)
    if ($eventMatches -and $workflowMatches -and -not $explicitlyNonAuthoritative) { $eligible += $observation } else { $ignored += $observation }
  }
  if ($eligible.Count -eq 0) {
    return [pscustomobject][ordered]@{ status = 'AMBIGUOUS'; reason = 'no_authoritative_workflow_observation'; required = $RequiredName; selected = $null; candidates = @($exactHead | ForEach-Object { $_.check_run_id }); ignored = @($ignored | ForEach-Object { $_.check_run_id }) }
  }

  $seenIds = @{}
  foreach ($observation in $eligible) {
    if ([string]::IsNullOrWhiteSpace([string]$observation.check_run_id)) {
      return [pscustomobject][ordered]@{ status = 'AMBIGUOUS'; reason = 'check_run_id_missing'; required = $RequiredName; selected = $null; candidates = @($eligible | ForEach-Object { $_.check_run_id }); ignored = @($ignored | ForEach-Object { $_.check_run_id }) }
    }
    if ($seenIds.ContainsKey([string]$observation.check_run_id)) {
      return [pscustomobject][ordered]@{ status = 'AMBIGUOUS'; reason = 'duplicate_check_run_id'; required = $RequiredName; selected = $null; candidates = @($eligible | ForEach-Object { $_.check_run_id }); ignored = @($ignored | ForEach-Object { $_.check_run_id }) }
    }
    $seenIds[[string]$observation.check_run_id] = $true
    if ($null -eq (Get-AgentObservationTimestamp -Observation $observation)) {
      return [pscustomobject][ordered]@{ status = 'AMBIGUOUS'; reason = 'check_timestamp_missing_or_malformed'; required = $RequiredName; selected = $null; candidates = @($eligible | ForEach-Object { $_.check_run_id }); ignored = @($ignored | ForEach-Object { $_.check_run_id }) }
    }
    if ([string]::IsNullOrWhiteSpace([string]$observation.workflow_id) -and [string]::IsNullOrWhiteSpace([string]$observation.workflow_run_id) -and [string]::IsNullOrWhiteSpace([string]$observation.check_suite_id)) {
      return [pscustomobject][ordered]@{ status = 'AMBIGUOUS'; reason = 'workflow_lineage_missing'; required = $RequiredName; selected = $null; candidates = @($eligible | ForEach-Object { $_.check_run_id }); ignored = @($ignored | ForEach-Object { $_.check_run_id }) }
    }
  }

  $ordered = @($eligible | Sort-Object `
      @{ Expression = { Get-AgentObservationTimestamp -Observation $_ }; Descending = $true }, `
      @{ Expression = { [int64]($(if ([string]$_.workflow_run_attempt -match '^\d+$') { $_.workflow_run_attempt } else { 0 })) }; Descending = $true }, `
      @{ Expression = { Get-AgentNumericIdentity -Value $_.workflow_run_id }; Descending = $true }, `
      @{ Expression = { Get-AgentNumericIdentity -Value $_.check_run_id }; Descending = $true }, `
      @{ Expression = { [string]$_.workflow_run_id }; Descending = $true }, `
      @{ Expression = { [string]$_.check_run_id }; Descending = $true })
  $selected = $ordered[0]
  $status = [string]$selected.status
  $conclusion = [string]$selected.conclusion
  $result = 'FAIL'
  $reason = 'required_check_failed'
  if ([string]::Equals($status, 'completed', [StringComparison]::OrdinalIgnoreCase)) {
    if ([string]::Equals($conclusion, 'success', [StringComparison]::OrdinalIgnoreCase)) { $result = 'PASS'; $reason = 'latest_authoritative_completed_success' }
  } elseif ($status -in @('queued', 'in_progress', 'pending', 'waiting', 'requested')) {
    $result = 'BLOCKED'; $reason = 'latest_authoritative_check_pending'
  } elseif ([string]::Equals($conclusion, 'skipped', [StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($conclusion, 'cancelled', [StringComparison]::OrdinalIgnoreCase)) {
    $result = 'FAIL'; $reason = 'only_authoritative_result_skipped_or_cancelled'
  }

  return [pscustomobject][ordered]@{
    status = $result
    reason = $reason
    required = $RequiredName
    selected = $selected
    candidates = @($ordered | ForEach-Object { $_.check_run_id })
    ignored = @($ignored | ForEach-Object { $_.check_run_id })
  }
}

function Resolve-AgentReviewThreadPages {
  param([Parameter(Mandatory = $true)][object[]]$Pages)
  $count = 0
  $unresolved = 0
  foreach ($page in $Pages) {
    $nodesProperty = if ($null -ne $page) { $page.PSObject.Properties['nodes'] } else { $null }
    $pageInfo = Get-AgentPropertyValue -Object $page -Name 'pageInfo'
    if ($null -eq $nodesProperty -or $null -eq $pageInfo) {
      return [pscustomobject]@{ available = $false; resolved = $false; count = $count; unresolved = $unresolved; error = 'review_threads_shape_invalid' }
    }
    $nodes = @($nodesProperty.Value)
    $count += $nodes.Count
    $unresolved += @($nodes | Where-Object { -not [bool]$_.isResolved }).Count
    $hasNext = [bool](Get-AgentPropertyValue -Object $pageInfo -Name 'hasNextPage')
    $cursor = [string](Get-AgentPropertyValue -Object $pageInfo -Name 'endCursor')
    if ($hasNext -and [string]::IsNullOrWhiteSpace($cursor)) {
      return [pscustomobject]@{ available = $false; resolved = $false; count = $count; unresolved = $unresolved; error = 'review_threads_pagination_incomplete' }
    }
  }
  return [pscustomobject]@{ available = $true; resolved = $unresolved -eq 0; count = $count; unresolved = $unresolved; error = '' }
}

function Test-AgentIndependentReviewReceipt {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][int]$PR,
    [Parameter(Mandatory = $true)][string]$BaseSha,
    [Parameter(Mandatory = $true)][string]$HeadSha,
    [Parameter(Mandatory = $true)][string]$BuilderIdentity,
    [string]$TaskId = '', [string]$RunId = '', [string]$ContractHash = ''
  )

  $errors = @()
  $schemaVersion = Get-AgentPropertyValue -Object $Receipt -Name 'schema_version'
  $kind = Get-AgentPropertyValue -Object $Receipt -Name 'kind'
  $repositoryValue = Get-AgentPropertyValue -Object $Receipt -Name 'repository'
  $prNumber = Get-AgentPropertyValue -Object $Receipt -Name 'pr_number'
  $baseValue = Get-AgentPropertyValue -Object $Receipt -Name 'base_sha'
  $headValue = Get-AgentPropertyValue -Object $Receipt -Name 'head_sha'
  $reviewerId = Get-AgentPropertyValue -Object $Receipt -Name 'reviewer_id'
  $verdict = Get-AgentPropertyValue -Object $Receipt -Name 'verdict'
  $scope = Get-AgentPropertyValue -Object $Receipt -Name 'scope'
  $blockingFindings = Get-AgentPropertyValue -Object $Receipt -Name 'blocking_findings'
  $receiptTaskId = Get-AgentPropertyValue -Object $Receipt -Name 'task_id'
  $receiptRunId = Get-AgentPropertyValue -Object $Receipt -Name 'run_id'
  $receiptContractHash = Get-AgentPropertyValue -Object $Receipt -Name 'contract_hash'
  $builderId = Get-AgentPropertyValue -Object $Receipt -Name 'builder_id'
  $reviewerClass = Get-AgentPropertyValue -Object $Receipt -Name 'reviewer_class'
  $reviewMode = Get-AgentPropertyValue -Object $Receipt -Name 'review_mode'
  $reviewedAt = Get-AgentPropertyValue -Object $Receipt -Name 'reviewed_at'
  $challengeId = Get-AgentPropertyValue -Object $Receipt -Name 'challenge_id'
  $authority = Get-AgentPropertyValue -Object $Receipt -Name 'authority_provenance'
  $reviewedScope = Get-AgentPropertyValue -Object $Receipt -Name 'reviewed_scope'
  $signature = Get-AgentPropertyValue -Object $Receipt -Name 'signature'
  if ([string]$schemaVersion -ne '2') { $errors += 'receipt_schema_version_invalid' }
  if (-not [string]::Equals([string]$kind, 'independent_review_receipt_v2', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_kind_invalid' }
  if (-not [string]::Equals([string]$repositoryValue, $Repository, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_repository_mismatch' }
  if ([string]$prNumber -ne [string]$PR) { $errors += 'receipt_pr_mismatch' }
  if (-not [string]::Equals([string]$baseValue, $BaseSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_base_mismatch' }
  if (-not [string]::Equals([string]$headValue, $HeadSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_head_mismatch' }
  if ([string]::IsNullOrWhiteSpace([string]$receiptTaskId)) { $errors += 'receipt_task_missing' }
  if ([string]::IsNullOrWhiteSpace([string]$receiptRunId)) { $errors += 'receipt_run_missing' }
  if ([string]::IsNullOrWhiteSpace([string]$receiptContractHash)) { $errors += 'receipt_contract_missing' }
  elseif ([string]$receiptContractHash -notmatch '^[0-9a-fA-F]{64}$') { $errors += 'receipt_contract_invalid' }
  if (-not [string]::Equals([string]$builderId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_builder_mismatch' }
  if (-not [string]::IsNullOrWhiteSpace($TaskId) -and $receiptTaskId -ne $TaskId) { $errors += 'receipt_task_mismatch' }
  if (-not [string]::IsNullOrWhiteSpace($RunId) -and $receiptRunId -ne $RunId) { $errors += 'receipt_run_mismatch' }
  if (-not [string]::IsNullOrWhiteSpace($ContractHash) -and $receiptContractHash -ne $ContractHash) { $errors += 'receipt_contract_mismatch' }
  if ([string]::IsNullOrWhiteSpace([string]$reviewerId) -or [string]::Equals([string]$reviewerId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'reviewer_not_independent_from_builder' }
  if ([string]$reviewerClass -notin @('independent_readonly', 'independent_breaker')) { $errors += 'reviewer_class_invalid' }
  if ([string]$reviewMode -notin @('exact_head', 'exact_revision')) { $errors += 'review_mode_invalid' }
  $reviewedAtParsed = [DateTimeOffset]::MinValue
  if ([string]::IsNullOrWhiteSpace([string]$reviewedAt) -or -not [DateTimeOffset]::TryParse([string]$reviewedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$reviewedAtParsed)) { $errors += 'reviewed_at_invalid' }
  elseif ($reviewedAtParsed -gt [DateTimeOffset]::UtcNow.AddMinutes(5) -or $reviewedAtParsed -lt [DateTimeOffset]::UtcNow.AddDays(-1)) { $errors += 'reviewed_at_stale_or_future' }
  $scopeKindValue = Get-AgentPropertyValue -Object $reviewedScope -Name 'kind'
  if ($null -eq $reviewedScope -or [string]::IsNullOrWhiteSpace([string]$scopeKindValue)) { $errors += 'reviewed_scope_invalid' }
  else {
    $scopeKind = [string]$scopeKindValue
    if ($scopeKind -eq 'files') {
      $scopePaths = @(Get-AgentPropertyValue -Object $reviewedScope -Name 'paths')
      if ($scopePaths.Count -eq 0) { $errors += 'reviewed_scope_empty' }
      $normalizedScope = @($scopePaths | ForEach-Object { ([string]$_).Replace('\', '/') })
      if ((@($normalizedScope | Sort-Object -Unique).Count) -ne $normalizedScope.Count) { $errors += 'reviewed_scope_duplicate' }
      if (@($normalizedScope | Where-Object { $_ -match '^(?:/|[A-Za-z]:)|(^|/)\.\.(?:/|$)' }).Count -gt 0) { $errors += 'reviewed_scope_unsafe_path' }
    } elseif ($scopeKind -ne 'repository') { $errors += 'reviewed_scope_kind_invalid' }
  }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $authority -Name 'issuer'), 'supervisor_review_lane', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'authority_provenance_invalid' }
  if ([string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue -Object $authority -Name 'key_id')) -or [string]::IsNullOrWhiteSpace([string]$challengeId) -or [string](Get-AgentPropertyValue -Object $authority -Name 'challenge_id') -ne [string]$challengeId) { $errors += 'authority_provenance_missing_challenge_or_key' }
  if (-not [string]::Equals([string]$verdict, 'APPROVE', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_not_approved' }
  if (@($blockingFindings).Count -gt 0) { $errors += 'independent_review_has_blocking_findings' }
  if ($null -eq $signature -or [string]$signature.algorithm -ne 'ed25519' -or [string]::IsNullOrWhiteSpace([string]$signature.key_id) -or [string]$signature.value -notmatch '^[A-Za-z0-9_-]{40,}$') { $errors += 'independent_review_signature_missing_or_invalid' }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'task_id', 'run_id', 'contract_hash', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'challenge_id', 'builder_id', 'reviewed_scope', 'verdict', 'blocking_findings', 'authority_provenance', 'signature')
  foreach ($property in @($Receipt.PSObject.Properties | ForEach-Object { [string]$_.Name })) {
    if ($allowed -notcontains [string]$property) { $errors += "receipt_unknown_field:$property" }
  }
  return [pscustomobject][ordered]@{ valid = $errors.Count -eq 0; errors = @($errors) }
}

function Get-AgentReviewPolicyVerdict {
  param(
    [Parameter(Mandatory = $true)][int]$RequiredApprovalCount,
    [Parameter(Mandatory = $true)][int]$ObservedApprovalCount,
    [Parameter(Mandatory = $true)][bool]$ThreadsRequired,
    [Parameter(Mandatory = $true)][bool]$ThreadsResolved,
    [Parameter(Mandatory = $true)][bool]$IndependentRequired,
    [Parameter(Mandatory = $true)][bool]$IndependentSatisfied,
    [Parameter(Mandatory = $true)][bool]$MergeAuthorized
  )
  return [pscustomobject][ordered]@{
    github_approval_satisfied = $ObservedApprovalCount -ge $RequiredApprovalCount
    review_threads_satisfied = (-not $ThreadsRequired) -or $ThreadsResolved
    independent_review_satisfied = (-not $IndependentRequired) -or $IndependentSatisfied
    merge_authority_satisfied = $MergeAuthorized
  }
}

Export-ModuleMember -Function ConvertTo-AgentCheckObservation, Get-AgentObservationTimestamp, Get-AgentNumericIdentity, Test-AgentIntentionalDetachedCandidate, Resolve-AgentTrustedMergeState, Resolve-AgentRequiredCheck, Resolve-AgentReviewThreadPages, Test-AgentIndependentReviewReceipt, Get-AgentReviewPolicyVerdict, Test-AgentShaValue
