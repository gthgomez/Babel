Set-StrictMode -Version Latest

function Get-AgentPropertyValue {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $null }
  # Unary comma prevents the pipeline from enumerating returned arrays: a
  # single-element JSON array must arrive as an array, not a scalar, and an
  # empty array must arrive as an array, not $null.
  return ,($Object.PSObject.Properties[$Name].Value)
}

function Test-AgentShaValue {
  param([AllowNull()][object]$Value)
  return $null -ne $Value -and [string]$Value -match '^[0-9a-fA-F]{40}$'
}

function Test-AgentJsonArrayShape {
  # True only for JSON array shapes. PowerShell strings implement IEnumerable
  # and PSCustomObject is enumerable-ish to the eye; both must be rejected so
  # that scalar/object intrusions into array-typed evidence fields fail closed
  # instead of surviving @() wrapping.
  param([AllowNull()][object]$Value)
  if ($null -eq $Value) { return $false }
  if ($Value -is [string]) { return $false }
  if ($Value -is [System.Management.Automation.PSCustomObject]) { return $false }
  if ($Value -is [bool] -or $Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return $false }
  return $Value -is [System.Collections.IEnumerable]
}

function Get-AgentCanonicalOrderUtf8 {
  # Canonical ordering for trust digests: ordinal bytewise UTF-8 comparison.
  # Shared semantics with tools/trust-ceremony.mjs (compareUtf8) and pinned by
  # tools/tests/fixtures/canonical-ordering-vectors.json; never replace this
  # with Sort-Object (culture-sensitive) or Node's default sort (UTF-16 code
  # units, which mis-orders astral characters against U+E000..U+FFFF).
  param([AllowNull()][string]$Left, [AllowNull()][string]$Right)
  $leftBytes = [Text.Encoding]::UTF8.GetBytes([string]$Left)
  $rightBytes = [Text.Encoding]::UTF8.GetBytes([string]$Right)
  $shared = [Math]::Min($leftBytes.Length, $rightBytes.Length)
  for ($index = 0; $index -lt $shared; $index++) {
    if ($leftBytes[$index] -ne $rightBytes[$index]) {
      return $(if ($leftBytes[$index] -lt $rightBytes[$index]) { -1 } else { 1 })
    }
  }
  if ($leftBytes.Length -eq $rightBytes.Length) { return 0 }
  return $(if ($leftBytes.Length -lt $rightBytes.Length) { -1 } else { 1 })
}

function Get-AgentCanonicalSortedUtf8 {
  param([AllowNull()][string[]]$Values)
  $list = [System.Collections.Generic.List[string]]::new()
  foreach ($value in @($Values)) { $list.Add([string]$value) }
  $list.Sort([Comparison[string]] { param($left, $right) Get-AgentCanonicalOrderUtf8 -Left $left -Right $right })
  return ,($list.ToArray())
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

function Get-AgentIndependentReviewReceiptHash {
  param([Parameter(Mandatory = $true)][object]$Receipt)
  $payload = [ordered]@{}
  $fieldOrder = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'builder_id', 'challenge_id', 'task_id', 'run_id', 'contract_hash', 'authority_provenance')
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
  $findings = Get-AgentPropertyValue -Object $Receipt -Name 'findings'
  $reviewerClass = Get-AgentPropertyValue -Object $Receipt -Name 'reviewer_class'
  $reviewedAt = Get-AgentPropertyValue -Object $Receipt -Name 'reviewed_at'
  $artifactHash = Get-AgentPropertyValue -Object $Receipt -Name 'artifact_hash'
  if ([string]$schemaVersion -ne '1') { $errors += 'receipt_schema_version_invalid' }
  if (-not [string]::Equals([string]$kind, 'independent_review_receipt_v1', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_kind_invalid' }
  if (-not [string]::Equals([string]$repositoryValue, $Repository, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_repository_mismatch' }
  if ([string]$prNumber -ne [string]$PR) { $errors += 'receipt_pr_mismatch' }
  if (-not [string]::Equals([string]$baseValue, $BaseSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_base_mismatch' }
  if (-not [string]::Equals([string]$headValue, $HeadSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'receipt_head_mismatch' }
  if ([string]::IsNullOrWhiteSpace([string]$reviewerId) -or [string]::Equals([string]$reviewerId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'reviewer_not_independent_from_builder' }
  if ([string]::IsNullOrWhiteSpace([string]$reviewerClass)) { $errors += 'independent_review_reviewer_class_missing' }
  if (-not [string]::Equals([string]$verdict, 'APPROVE', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_not_approved' }
  $parsedReviewedAt = [DateTimeOffset]::MinValue
  if ([string]::IsNullOrWhiteSpace([string]$reviewedAt) -or -not [DateTimeOffset]::TryParse([string]$reviewedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedReviewedAt)) { $errors += 'independent_review_reviewed_at_invalid' }
  # Assurance fields are REQUIRED with an explicit array shape: absence, null,
  # scalars, and objects are distinct fail-closed errors — unknown can never
  # silently become empty.
  if ($null -eq $scope) { $errors += 'independent_review_scope_required' }
  elseif (-not (Test-AgentJsonArrayShape -Value $scope)) { $errors += 'independent_review_scope_not_array' }
  elseif (@($scope).Count -eq 0) { $errors += 'independent_review_scope_empty' }
  if ($null -eq $blockingFindings) { $errors += 'independent_review_blocking_findings_required' }
  elseif (-not (Test-AgentJsonArrayShape -Value $blockingFindings)) { $errors += 'independent_review_blocking_findings_not_array' }
  elseif (@($blockingFindings).Count -gt 0) { $errors += 'independent_review_has_blocking_findings' }
  if ($null -ne $findings -and -not (Test-AgentJsonArrayShape -Value $findings)) { $errors += 'independent_review_findings_not_array' }
  if ([string]$artifactHash -notmatch '^[0-9a-fA-F]{64}$') { $errors += 'independent_review_artifact_hash_invalid' }
  if ([string]$artifactHash -match '^[0-9a-fA-F]{64}$') {
    $expectedHash = Get-AgentIndependentReviewReceiptHash -Receipt $Receipt
    if (-not [string]::Equals([string]$artifactHash, $expectedHash, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'independent_review_artifact_hash_mismatch' }
  }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'artifact_hash', 'builder_id', 'challenge_id', 'task_id', 'run_id', 'contract_hash', 'authority_provenance', 'signature')
  # Enumerate names via the pipeline: member enumeration of `.Name` throws
  # under strict mode when the property collection is empty ({} receipts).
  foreach ($property in @($Receipt.PSObject.Properties | ForEach-Object { $_.Name })) {
    if ($allowed -notcontains [string]$property) { $errors += "receipt_unknown_field:$property" }
  }
  return [pscustomobject][ordered]@{ valid = $errors.Count -eq 0; errors = @($errors) }
}

function Get-AgentNumstatDigest {
  param(
    [Parameter(Mandatory = $true)][string[]]$NumstatLines
  )
  $canonical = (Get-AgentCanonicalSortedUtf8 -Values @($NumstatLines)) -join "`n"
  $bytes = [Text.Encoding]::UTF8.GetBytes($canonical)
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
}

function Test-AgentEvidenceTransportStub {
  param([AllowNull()][object]$Document)

  # The evidence transport writes a transport_error stub document when no
  # (or an ambiguous) bound evidence comment exists. Such a stub is untrusted
  # input describing transport state, never review evidence: callers must map
  # it to a deterministic BLOCKED reason instead of validating it.
  if ($null -eq $Document -or $Document -isnot [System.Management.Automation.PSCustomObject]) { return $null }
  $transportError = Get-AgentPropertyValue -Object $Document -Name 'transport_error'
  if ($null -eq $transportError) { return $null }
  $value = [string]$transportError
  if ($value -like '*_handoff_ambiguous') { return 'ambiguous' }
  return 'missing'
}

function Test-AgentAutonomousReviewEvidence {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][object]$Evidence,
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
  #
  # The evidence document is untrusted input: every property is read through
  # the null-safe accessor so that missing, malformed, or wrong-shape
  # documents produce deterministic BLOCKED errors and never an unhandled
  # strict-mode exception.
  $errors = @()
  $evidenceObject = if ($null -ne $Evidence -and $Evidence -is [System.Management.Automation.PSCustomObject]) { $Evidence } else { $null }
  if ($null -eq $evidenceObject) { $errors += 'autonomous_evidence_malformed' }
  if ([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'schema_version') -ne '1') { $errors += 'autonomous_evidence_schema_version_invalid' }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'kind'), 'autonomous_review_evidence_v1', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_kind_invalid' }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'repository'), $Repository, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_repository_mismatch' }
  if ([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'pr_number') -ne [string]$PR) { $errors += 'autonomous_evidence_pr_mismatch' }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'base_sha'), $BaseSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_base_mismatch' }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'head_sha'), $HeadSha, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_head_mismatch' }
  $reviewerId = [string](Get-AgentPropertyValue -Object $evidenceObject -Name 'reviewer_id')
  if ([string]::IsNullOrWhiteSpace($reviewerId) -or [string]::Equals($reviewerId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_reviewer_not_independent_from_builder' }
  if ([string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'reviewer_class'))) { $errors += 'autonomous_evidence_reviewer_class_missing' }
  $builderId = Get-AgentPropertyValue -Object $evidenceObject -Name 'builder_id'
  if ([string]::IsNullOrWhiteSpace([string]$builderId)) { $errors += 'autonomous_evidence_builder_id_missing' }
  elseif (-not [string]::Equals([string]$builderId, $BuilderIdentity, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_builder_id_mismatch' }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'verdict'), 'APPROVE', [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_not_approved' }
  # Assurance fields are REQUIRED with an explicit array shape: a missing
  # blocking_findings can never silently behave like an attested zero-blocker
  # review; the reviewer must explicitly present "blocking_findings": [].
  $scope = Get-AgentPropertyValue -Object $evidenceObject -Name 'scope'
  if ($null -eq $scope) { $errors += 'autonomous_evidence_scope_required' }
  elseif (-not (Test-AgentJsonArrayShape -Value $scope)) { $errors += 'autonomous_evidence_scope_not_array' }
  elseif (@($scope).Count -eq 0) { $errors += 'autonomous_evidence_scope_empty' }
  $blockingFindings = Get-AgentPropertyValue -Object $evidenceObject -Name 'blocking_findings'
  if ($null -eq $blockingFindings) { $errors += 'autonomous_evidence_blocking_findings_required' }
  elseif (-not (Test-AgentJsonArrayShape -Value $blockingFindings)) { $errors += 'autonomous_evidence_blocking_findings_not_array' }
  elseif (@($blockingFindings).Count -gt 0) { $errors += 'autonomous_evidence_has_blocking_findings' }
  $findings = Get-AgentPropertyValue -Object $evidenceObject -Name 'findings'
  if ($null -ne $findings -and -not (Test-AgentJsonArrayShape -Value $findings)) { $errors += 'autonomous_evidence_findings_not_array' }
  $parsedReviewedAt = [DateTimeOffset]::MinValue
  $reviewedAt = [string](Get-AgentPropertyValue -Object $evidenceObject -Name 'reviewed_at')
  if ([string]::IsNullOrWhiteSpace($reviewedAt) -or -not [DateTimeOffset]::TryParse($reviewedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$parsedReviewedAt)) { $errors += 'autonomous_evidence_reviewed_at_invalid' }
  if (-not [string]::Equals([string](Get-AgentPropertyValue -Object $evidenceObject -Name 'diff_numstat_digest'), $ExpectedNumstatDigest, [StringComparison]::OrdinalIgnoreCase)) { $errors += 'autonomous_evidence_diff_numstat_digest_mismatch' }
  if ($null -ne $evidenceObject) {
    $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'reviewer_id', 'reviewer_class', 'review_mode', 'reviewed_at', 'scope', 'findings', 'blocking_findings', 'verdict', 'builder_id', 'diff_numstat_digest')
    # Enumerate names via the pipeline: member enumeration of `.Name` throws
    # under strict mode when the property collection is empty ({} documents).
    foreach ($property in @($evidenceObject.PSObject.Properties | ForEach-Object { $_.Name })) {
      if ($allowed -notcontains [string]$property) { $errors += "autonomous_evidence_unknown_field:$property" }
    }
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

Export-ModuleMember -Function ConvertTo-AgentCheckObservation, Get-AgentObservationTimestamp, Resolve-AgentRequiredCheck, Resolve-AgentReviewThreadPages, Test-AgentIndependentReviewReceipt, Get-AgentIndependentReviewReceiptHash, Get-AgentReviewPolicyVerdict, Test-AgentShaValue, Get-AgentNumstatDigest, Test-AgentAutonomousReviewEvidence, Test-AgentEvidenceTransportStub, Test-AgentJsonArrayShape, Get-AgentCanonicalOrderUtf8, Get-AgentCanonicalSortedUtf8
