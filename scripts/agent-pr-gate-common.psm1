Set-StrictMode -Version Latest

function Get-AgentPropertyValue {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $null }
  return $Object.PSObject.Properties[$Name].Value
}

function Get-AgentPropertyNames {
  param([AllowNull()][object]$Object)
  if ($null -eq $Object) { return @() }
  $names = New-Object System.Collections.Generic.List[string]
  foreach ($property in $Object.PSObject.Properties) { [void]$names.Add([string]$property.Name) }
  return $names.ToArray()
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
    app_id = [string](& $get 'app_id')
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
    [Parameter(Mandatory = $true)][string]$AuthorityWorkflowName,
    [Nullable[int64]]$AuthorityAppId = $null
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
    $producerMatches = $null -eq $AuthorityAppId -or
      ($AuthorityAppId -gt 0 -and [string]$observation.app_id -eq [string]$AuthorityAppId)
    $explicitlyNonAuthoritative = [string]::Equals([string]$observation.authority, 'non_authoritative', [StringComparison]::OrdinalIgnoreCase)
    if ($eventMatches -and $workflowMatches -and $producerMatches -and -not $explicitlyNonAuthoritative) { $eligible += $observation } else { $ignored += $observation }
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
  $reviewerClass = Get-AgentPropertyValue -Object $Receipt -Name 'reviewer_class'
  $reviewMode = Get-AgentPropertyValue -Object $Receipt -Name 'review_mode'
  $reviewedAt = Get-AgentPropertyValue -Object $Receipt -Name 'reviewed_at'
  $verdict = Get-AgentPropertyValue -Object $Receipt -Name 'verdict'
  $reviewedScope = Get-AgentPropertyValue -Object $Receipt -Name 'reviewed_scope'
  $blockingFindingsProperty = $Receipt.PSObject.Properties['blocking_findings']
  $blockingFindings = $null
  if ($null -ne $blockingFindingsProperty) { $blockingFindings = $blockingFindingsProperty.Value }
  $builderId = Get-AgentPropertyValue -Object $Receipt -Name 'builder_id'
  $challengeId = Get-AgentPropertyValue -Object $Receipt -Name 'challenge_id'
  $taskId = Get-AgentPropertyValue -Object $Receipt -Name 'task_id'
  $runId = Get-AgentPropertyValue -Object $Receipt -Name 'run_id'
  $contractHash = Get-AgentPropertyValue -Object $Receipt -Name 'contract_hash'
  $authority = Get-AgentPropertyValue -Object $Receipt -Name 'authority_provenance'
  $signature = Get-AgentPropertyValue -Object $Receipt -Name 'signature'
  if ([string]$schemaVersion -ne '2') { $errors += 'receipt_schema_version_invalid' }
  if (-not [string]::Equals([string]$kind, 'independent_review_receipt_v2', [StringComparison]::Ordinal)) { $errors += 'receipt_kind_invalid' }
  if (-not [string]::Equals([string]$repositoryValue, $Repository, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_repository_mismatch' }
  if ([string]$prNumber -ne [string]$PR) { $errors += 'receipt_pr_mismatch' }
  if (-not [string]::Equals([string]$baseValue, $BaseSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_base_mismatch' }
  if (-not [string]::Equals([string]$headValue, $HeadSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_head_mismatch' }
  if ([string]::IsNullOrWhiteSpace([string]$reviewerId) -or [string]::Equals([string]$reviewerId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'reviewer_not_independent_from_builder' }
  if ([string]$reviewerClass -notin @('independent_readonly', 'independent_breaker')) { $errors += 'independent_review_reviewer_class_invalid' }
  if ([string]$reviewMode -notin @('exact_head', 'exact_revision')) { $errors += 'independent_review_mode_invalid' }
  if ($null -eq ([string]$reviewedAt -as [datetimeoffset])) { $errors += 'independent_review_timestamp_invalid' }
  if (-not [string]::Equals([string]$verdict, 'APPROVE', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_not_approved' }
  if ($null -eq $blockingFindings -or $blockingFindings -isnot [array]) { $errors += 'independent_review_blocking_findings_invalid' }
  elseif (@($blockingFindings).Count -gt 0) { $errors += 'independent_review_has_blocking_findings' }
  if (-not [string]::Equals([string]$builderId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_builder_mismatch' }
  foreach ($binding in @(
      @{ Name = 'challenge_id'; Value = $challengeId },
      @{ Name = 'task_id'; Value = $taskId },
      @{ Name = 'run_id'; Value = $runId },
      @{ Name = 'contract_hash'; Value = $contractHash }
    )) {
    if ([string]::IsNullOrWhiteSpace([string]$binding.Value)) { $errors += "independent_review_$($binding.Name)_missing" }
  }

  $scopeKind = Get-AgentPropertyValue -Object $reviewedScope -Name 'kind'
  if ([string]$scopeKind -eq 'repository') {
    $scopeAllowed = @('kind')
  } elseif ([string]$scopeKind -eq 'files') {
    $scopeAllowed = @('kind', 'paths')
    $scopePathProperty = $reviewedScope.PSObject.Properties['paths']
    $scopePathValue = $null
    if ($null -ne $scopePathProperty) { $scopePathValue = $scopePathProperty.Value }
    $scopePaths = @($scopePathValue)
    if ($scopePathValue -isnot [array]) { $errors += 'independent_review_scope_paths_invalid' }
    elseif ($scopePaths.Count -eq 0) { $errors += 'independent_review_scope_empty' }
    $normalizedPaths = @($scopePaths | ForEach-Object { ([string]$_).Replace('\\', '/') })
    if (@($normalizedPaths | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_.StartsWith('/') -or $_ -match '^[A-Za-z]:' -or $_ -eq '..' -or $_.StartsWith('../') }).Count -gt 0) { $errors += 'independent_review_scope_path_invalid' }
    if (@($normalizedPaths | Sort-Object -Unique).Count -ne $normalizedPaths.Count) { $errors += 'independent_review_scope_duplicate_path' }
  } else {
    $scopeAllowed = @()
    $errors += 'independent_review_scope_invalid'
  }
  foreach ($property in @(Get-AgentPropertyNames -Object $reviewedScope)) {
    if ($scopeAllowed -notcontains [string]$property) { $errors += "independent_review_scope_unknown_field:$property" }
  }

  $authorityIssuer = Get-AgentPropertyValue -Object $authority -Name 'issuer'
  $authorityKeyId = Get-AgentPropertyValue -Object $authority -Name 'key_id'
  $authorityChallengeId = Get-AgentPropertyValue -Object $authority -Name 'challenge_id'
  if (-not [string]::Equals([string]$authorityIssuer, 'supervisor_review_lane', [StringComparison]::Ordinal)) { $errors += 'independent_review_authority_issuer_invalid' }
  if ([string]::IsNullOrWhiteSpace([string]$authorityKeyId)) { $errors += 'independent_review_authority_key_missing' }
  if (-not [string]::Equals([string]$authorityChallengeId, [string]$challengeId, [StringComparison]::Ordinal)) { $errors += 'independent_review_authority_challenge_mismatch' }
  foreach ($property in @(Get-AgentPropertyNames -Object $authority)) {
    if (@('issuer', 'key_id', 'challenge_id') -notcontains [string]$property) { $errors += "independent_review_authority_unknown_field:$property" }
  }

  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $signature -Name 'algorithm'), 'ed25519', [StringComparison]::Ordinal)) { $errors += 'independent_review_signature_algorithm_invalid' }
  if ([string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue -Object $signature -Name 'key_id'))) { $errors += 'independent_review_signature_key_missing' }
  if ([string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue -Object $signature -Name 'value'))) { $errors += 'independent_review_signature_missing' }
  foreach ($property in @(Get-AgentPropertyNames -Object $signature)) {
    if (@('algorithm', 'key_id', 'value') -notcontains [string]$property) { $errors += "independent_review_signature_unknown_field:$property" }
  }

  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'task_id', 'run_id', 'contract_hash', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'challenge_id', 'builder_id', 'reviewed_scope', 'verdict', 'blocking_findings', 'authority_provenance', 'signature')
  $receiptPropertyNames = @(Get-AgentPropertyNames -Object $Receipt)
  foreach ($required in $allowed) {
    if ($receiptPropertyNames -notcontains $required) { $errors += "receipt_required_field_missing:$required" }
  }
  foreach ($property in $receiptPropertyNames) {
    if ($allowed -notcontains [string]$property) { $errors += "receipt_unknown_field:$property" }
  }
  return [pscustomobject][ordered]@{ valid = $errors.Count -eq 0; errors = @($errors) }
}

function Get-AgentNumstatDigest {
  param(
    [Parameter(Mandatory = $true)][string[]]$NumstatLines
  )
  $canonical = (@($NumstatLines) | Sort-Object) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
}

function Test-AgentAutonomousReviewEvidence {
  param(
    [Parameter(Mandatory = $true)][object]$Evidence,
    [Parameter(Mandatory = $true)][string]$Repository,
    [Parameter(Mandatory = $true)][int]$PR,
    [Parameter(Mandatory = $true)][string]$BaseSha,
    [Parameter(Mandatory = $true)][string]$HeadSha,
    [Parameter(Mandatory = $true)][string]$BuilderIdentity,
    [Parameter(Mandatory = $true)][string]$ExpectedNumstatDigest
  )

  # Autonomous review evidence is analysis provenance, not a signed
  # certification. It is accepted only for candidates that do not modify the
  # protected trust root; trust-root changes always require a signed receipt
  # and a supervisor-signed upgrade authorization.
  $errors = @()
  if ([string]$Evidence.schema_version -ne '1') { $errors += 'autonomous_evidence_schema_version_invalid' }
  if (-not [string]::Equals([string]$Evidence.kind, 'autonomous_review_evidence_v1', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_kind_invalid' }
  if (-not [string]::Equals([string]$Evidence.repository, $Repository, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_repository_mismatch' }
  if ([string]$Evidence.pr_number -ne [string]$PR) { $errors += 'autonomous_evidence_pr_mismatch' }
  if (-not [string]::Equals([string]$Evidence.base_sha, $BaseSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_base_mismatch' }
  if (-not [string]::Equals([string]$Evidence.head_sha, $HeadSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_head_mismatch' }
  $reviewerId = [string]$Evidence.reviewer_id
  if ([string]::IsNullOrWhiteSpace($reviewerId) -or [string]::Equals($reviewerId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_reviewer_not_independent_from_builder' }
  if ([string]::IsNullOrWhiteSpace([string]$Evidence.reviewer_class)) { $errors += 'autonomous_evidence_reviewer_class_missing' }
  if (-not [string]::Equals([string]$Evidence.verdict, 'APPROVE', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_not_approved' }
  if (@($Evidence.scope).Count -eq 0) { $errors += 'autonomous_evidence_scope_empty' }
  if (@($Evidence.blocking_findings).Count -gt 0) { $errors += 'autonomous_evidence_has_blocking_findings' }
  $parsedReviewedAt = [DateTimeOffset]::MinValue
  if ([string]::IsNullOrWhiteSpace([string]$Evidence.reviewed_at) -or -not [DateTimeOffset]::TryParse([string]$Evidence.reviewed_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedReviewedAt)) { $errors += 'autonomous_evidence_reviewed_at_invalid' }
  if (-not [string]::Equals([string]$Evidence.diff_numstat_digest, $ExpectedNumstatDigest, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_diff_numstat_digest_mismatch' }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'builder_id', 'diff_numstat_digest')
  foreach ($property in @($Evidence.PSObject.Properties.Name)) {
    if ($allowed -notcontains [string]$property) { $errors += "autonomous_evidence_unknown_field:$property" }
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
    [Parameter(Mandatory = $true)][bool]$IndependentSatisfied
  )
  return [pscustomobject][ordered]@{
    github_approval_satisfied = $ObservedApprovalCount -ge $RequiredApprovalCount
    review_threads_satisfied = (-not $ThreadsRequired) -or $ThreadsResolved
    independent_review_satisfied = (-not $IndependentRequired) -or $IndependentSatisfied
  }
}

Export-ModuleMember -Function ConvertTo-AgentCheckObservation, Get-AgentObservationTimestamp, Resolve-AgentRequiredCheck, Resolve-AgentReviewThreadPages, Test-AgentIndependentReviewReceipt, Get-AgentReviewPolicyVerdict, Test-AgentShaValue, Get-AgentNumstatDigest, Test-AgentAutonomousReviewEvidence
