Set-StrictMode -Version Latest

function Get-AgentPropertyValue {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $null }
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

function Get-AgentIndependentReviewReceiptHash {
  param([Parameter(Mandatory = $true)][object]$Receipt)
  $payload = [ordered]@{}
  $fieldOrder = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'builder_id')
  foreach ($field in $fieldOrder) {
    $property = $Receipt.PSObject.Properties[$field]
    if ($null -ne $property) {
      if ($field -in @('scope', 'findings', 'blocking_findings')) { $payload[$field] = @($property.Value) } else { $payload[$field] = $property.Value }
    }
  }
  $canonical = $payload | ConvertTo-Json -Depth 50 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
}

function Test-AgentIndependentReviewReceipt {
  param(
    [Parameter(Mandatory = $true)][object]$Receipt,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][int]$PR,
    [Parameter(Mandatory = $true)][string]$BaseSha,
    [Parameter(Mandatory = $true)][string]$HeadSha,
    [Parameter(Mandatory = $true)][string]$BuilderIdentity
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
  $artifactHash = Get-AgentPropertyValue -Object $Receipt -Name 'artifact_hash'
  if ([string]$schemaVersion -ne '1') { $errors += 'receipt_schema_version_invalid' }
  if (-not [string]::Equals([string]$kind, 'independent_review_receipt_v1', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_kind_invalid' }
  if (-not [string]::Equals([string]$repositoryValue, $Repository, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_repository_mismatch' }
  if ([string]$prNumber -ne [string]$PR) { $errors += 'receipt_pr_mismatch' }
  if (-not [string]::Equals([string]$baseValue, $BaseSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_base_mismatch' }
  if (-not [string]::Equals([string]$headValue, $HeadSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_head_mismatch' }
  if ([string]::IsNullOrWhiteSpace([string]$reviewerId) -or [string]::Equals([string]$reviewerId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'reviewer_not_independent_from_builder' }
  if (-not [string]::Equals([string]$verdict, 'APPROVE', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_not_approved' }
  if (@($scope).Count -eq 0) { $errors += 'independent_review_scope_empty' }
  if (@($blockingFindings).Count -gt 0) { $errors += 'independent_review_has_blocking_findings' }
  if ([string]$artifactHash -notmatch '^[0-9a-fA-F]{64}$') { $errors += 'independent_review_artifact_hash_invalid' }
  if ([string]$artifactHash -match '^[0-9a-fA-F]{64}$') {
    $expectedHash = Get-AgentIndependentReviewReceiptHash -Receipt $Receipt
    if (-not [string]::Equals([string]$artifactHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_artifact_hash_mismatch' }
  }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'artifact_hash', 'builder_id')
  foreach ($property in @($Receipt.PSObject.Properties.Name)) {
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

Export-ModuleMember -Function ConvertTo-AgentCheckObservation, Resolve-AgentRequiredCheck, Test-AgentIndependentReviewReceipt, Get-AgentIndependentReviewReceiptHash, Get-AgentReviewPolicyVerdict, Test-AgentShaValue
