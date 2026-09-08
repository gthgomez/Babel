# Dot-sourced only by the immutable-base gate module. No candidate code executes.
function Select-AgentHostReviewBundle {
  param([AllowEmptyCollection()][object[]]$Comments, [string]$Repository, [int]$PR, [string]$BaseSha, [string]$HeadSha, [string]$PublisherId)
  $marker = '<!-- babel-controller-ai-reviews-v2 -->'
  if ($PublisherId -notmatch '^[1-9][0-9]*$') { return [pscustomobject]@{ transport_error = 'host_review_publisher_unavailable' } }
  foreach ($comment in @($Comments | Sort-Object { [long](Get-AgentPropertyValue $_ 'id') } -Descending)) {
    $user = Get-AgentPropertyValue $comment 'user'
    if ([string](Get-AgentPropertyValue $user 'id') -ne $PublisherId -or [string](Get-AgentPropertyValue $user 'type') -cne 'User') { continue }
    $body = [string](Get-AgentPropertyValue $comment 'body')
    if (-not $body.StartsWith($marker, [StringComparison]::Ordinal)) { continue }
    # A malformed latest owner handoff blocks reuse of an older approval.
    # Other authors cannot poison the owner's review round.
    try { $handoff = $body.Substring($marker.Length).Trim() | ConvertFrom-Json -Depth 40 -ErrorAction Stop }
    catch { return [pscustomobject]@{ transport_error = 'host_review_handoff_malformed' } }
    if ($handoff -isnot [pscustomobject]) { return [pscustomobject]@{ transport_error = 'host_review_handoff_malformed' } }
    foreach ($field in @('repository', 'pr_number', 'base_sha', 'head_sha')) {
      if ($null -eq (Get-AgentPropertyValue $handoff $field)) { return [pscustomobject]@{ transport_error = 'host_review_handoff_malformed' } }
    }
    if ([string](Get-AgentPropertyValue $handoff 'repository') -ine $Repository -or
        [string](Get-AgentPropertyValue $handoff 'pr_number') -ne [string]$PR -or
        [string](Get-AgentPropertyValue $handoff 'base_sha') -ine $BaseSha -or
        [string](Get-AgentPropertyValue $handoff 'head_sha') -ine $HeadSha) { continue }
    if ([string](Get-AgentPropertyValue $comment 'issue_url') -ine "https://api.github.com/repos/$Repository/issues/$PR") {
      return [pscustomobject]@{ transport_error = 'host_review_comment_pr_mismatch' }
    }
    return [pscustomobject][ordered]@{
      schema_version = 2; kind = 'github_host_review_bundle_v2'
      repository = $Repository; pr_number = $PR; base_sha = $BaseSha; head_sha = $HeadSha
      publisher_id = $PublisherId; comment_id = [string](Get-AgentPropertyValue $comment 'id')
      handoff = $handoff
    }
  }
  return [pscustomobject]@{ transport_error = 'independent_ai_review_handoff_missing' }
}

function Test-AgentAutonomousReviewEvidence {
  param(
    [Parameter(Mandatory)][AllowNull()][object]$Evidence,
    [Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][int]$PR,
    [Parameter(Mandatory)][string]$BaseSha, [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$BuilderIdentity, [Parameter(Mandatory)][string]$ExpectedNumstatDigest,
    [string]$TaskId = '', [string]$TaskHash = '', [string[]]$ExpectedScope = @()
  )
  $errors = @()
  if ($Evidence -isnot [pscustomobject]) { return [pscustomobject]@{ valid = $false; errors = @('autonomous_evidence_malformed') } }
  $expected = @{
    schema_version = '2'; kind = 'autonomous_review_evidence_v2'; repository = $Repository
    pr_number = [string]$PR; base_sha = $BaseSha; head_sha = $HeadSha
    builder_id = $BuilderIdentity; diff_numstat_digest = $ExpectedNumstatDigest
    reviewer_class = 'independent_readonly_ai'; review_mode = 'exact_diff'; verdict = 'APPROVE'
    task_id = $TaskId; task_hash = $TaskHash
  }
  foreach ($field in $expected.Keys) {
    if ([string](Get-AgentPropertyValue $Evidence $field) -cne $expected[$field]) { $errors += ('autonomous_evidence_' + $field + '_mismatch') }
  }
  $reviewer = [string](Get-AgentPropertyValue $Evidence 'reviewer_id')
  if ([string]::IsNullOrWhiteSpace($reviewer) -or $reviewer -ieq $BuilderIdentity) { $errors += 'autonomous_evidence_reviewer_not_independent_from_builder' }
  foreach ($field in @('execution_id', 'review_provider', 'reviewer_model')) {
    $value = [string](Get-AgentPropertyValue $Evidence $field)
    if ([string]::IsNullOrWhiteSpace($value) -or $value.Trim() -ieq 'UNKNOWN') { $errors += ('autonomous_evidence_' + $field + '_invalid') }
  }
  foreach ($field in @('scope', 'findings', 'blocking_findings')) {
    $value = Get-AgentPropertyValue $Evidence $field
    if ($null -eq $Evidence.PSObject.Properties[$field] -or $Evidence.PSObject.Properties[$field].Value -isnot [array] -or
        @($value | Where-Object { $_ -isnot [string] }).Count -gt 0) { $errors += ('autonomous_evidence_' + $field + '_invalid') }
  }
  $scope = @((Get-AgentPropertyValue $Evidence 'scope'))
  if ($scope.Count -eq 0 -or @($scope | Select-Object -Unique).Count -ne $scope.Count -or
      @($scope | Where-Object { $_ -match '\\|^/|^[A-Za-z]:|(^|/)\.\.?(/|$)|//' -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    $errors += 'autonomous_evidence_scope_invalid'
  }
  if ($ExpectedScope.Count -gt 0 -and (($scope | Sort-Object) -join "\n") -cne (($ExpectedScope | Sort-Object) -join "\n")) { $errors += 'autonomous_evidence_scope_mismatch' }
  if (@((Get-AgentPropertyValue $Evidence 'blocking_findings')).Count -gt 0) { $errors += 'autonomous_evidence_has_blocking_findings' }
  $reviewedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string](Get-AgentPropertyValue $Evidence 'reviewed_at'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$reviewedAt) -or
      $reviewedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or $reviewedAt -lt [DateTimeOffset]::UtcNow.AddDays(-1)) { $errors += 'autonomous_evidence_reviewed_at_invalid_or_stale' }
  $isolation = Get-AgentPropertyValue $Evidence 'isolation'
  if (@('text_only_no_tools', 'readonly_sandbox') -cnotcontains [string](Get-AgentPropertyValue $isolation 'mode')) { $errors += 'autonomous_evidence_isolation_invalid' }
  foreach ($field in @('candidate_write', 'github_mutation', 'merge', 'controller_state_access')) {
    $value = Get-AgentPropertyValue $isolation $field
    if ($value -isnot [bool] -or $value -ne $false) { $errors += "autonomous_evidence_isolation_$field" }
  }
  $usage = Get-AgentPropertyValue $Evidence 'usage'
  if ($null -ne $usage) {
    foreach ($field in @(Get-AgentPropertyNames $usage)) {
      $value = Get-AgentPropertyValue $usage $field
      if (@('prompt_tokens', 'completion_tokens', 'total_tokens', 'latency_ms') -cnotcontains $field -or
          ($null -ne $value -and ($value -is [string] -or $value -is [bool] -or $value -isnot [ValueType] -or [double]$value -lt 0 -or -not [double]::IsFinite([double]$value)))) {
        $errors += 'autonomous_evidence_usage_invalid'
      }
    }
  }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash', 'builder_id', 'diff_numstat_digest', 'reviewer_id', 'reviewer_class', 'execution_id', 'review_provider', 'reviewer_model', 'review_mode', 'reviewed_at', 'scope', 'verdict', 'findings', 'blocking_findings', 'isolation', 'usage')
  foreach ($field in @(Get-AgentPropertyNames $Evidence)) {
    if ($allowed -cnotcontains $field) { $errors += "autonomous_evidence_unknown_field:$field" }
  }
  return [pscustomobject]@{ valid = $errors.Count -eq 0; errors = @($errors) }
}

function Test-AgentControllerReviewEvidenceBundle {
  param(
    [Parameter(Mandatory)][AllowNull()][object]$Bundle,
    [Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][int]$PR,
    [Parameter(Mandatory)][string]$BaseSha, [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$BuilderIdentity, [Parameter(Mandatory)][string]$ExpectedNumstatDigest,
    [Parameter(Mandatory)][int]$MinimumReviewCount, [Parameter(Mandatory)][string]$PublisherId,
    [string[]]$ExpectedScope = @()
  )
  $errors = @()
  if ($Bundle -isnot [pscustomobject]) { return [pscustomobject]@{ valid = $false; errors = @('controller_review_bundle_malformed'); reviewCount = 0 } }
  $expected = @{ schema_version = '2'; kind = 'github_host_review_bundle_v2'; repository = $Repository; pr_number = [string]$PR; base_sha = $BaseSha; head_sha = $HeadSha; publisher_id = $PublisherId }
  foreach ($field in $expected.Keys) {
    if ([string](Get-AgentPropertyValue $Bundle $field) -cne $expected[$field]) { $errors += ('controller_review_bundle_' + $field + '_mismatch') }
  }
  if ([string](Get-AgentPropertyValue $Bundle 'comment_id') -notmatch '^[1-9][0-9]*$' -or $PublisherId -notmatch '^[1-9][0-9]*$') { $errors += 'controller_review_bundle_provenance_invalid' }
  $handoff = Get-AgentPropertyValue $Bundle 'handoff'
  $taskId = [string](Get-AgentPropertyValue $handoff 'task_id')
  $taskHash = [string](Get-AgentPropertyValue $handoff 'task_hash')
  if ([string]::IsNullOrWhiteSpace($taskId) -or $taskHash -cnotmatch '^[0-9a-f]{64}$' -or
      [string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue $handoff 'controller_run_id'))) { $errors += 'controller_review_handoff_task_or_run_invalid' }
  $handoffExpected = @{ schema_version = '2'; kind = 'host_review_handoff_v2'; repository = $Repository; pr_number = [string]$PR; base_sha = $BaseSha; head_sha = $HeadSha }
  foreach ($field in $handoffExpected.Keys) {
    if ([string](Get-AgentPropertyValue $handoff $field) -cne $handoffExpected[$field]) { $errors += ('controller_review_handoff_' + $field + '_mismatch') }
  }
  $reviews = @((Get-AgentPropertyValue $handoff 'reviews'))
  if ($reviews.Count -lt $MinimumReviewCount -or $reviews.Count -gt 2) { $errors += 'controller_review_bundle_insufficient_or_excess_reviews' }
  $reviewers = @{}; $executions = @{}
  foreach ($review in $reviews) {
    $validation = Test-AgentAutonomousReviewEvidence -Evidence $review -Repository $Repository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -BuilderIdentity $BuilderIdentity -ExpectedNumstatDigest $ExpectedNumstatDigest -TaskId $taskId -TaskHash $taskHash -ExpectedScope $ExpectedScope
    $errors += @($validation.errors)
    $reviewerId = [string](Get-AgentPropertyValue $review 'reviewer_id')
    $executionId = [string](Get-AgentPropertyValue $review 'execution_id')
    if ($reviewers.ContainsKey($reviewerId) -or $executions.ContainsKey($executionId)) { $errors += 'controller_review_bundle_reviewer_or_execution_not_distinct' }
    $reviewers[$reviewerId] = $true; $executions[$executionId] = $true
  }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'publisher_id', 'comment_id', 'handoff')
  foreach ($field in @(Get-AgentPropertyNames $Bundle)) {
    if ($allowed -cnotcontains $field) { $errors += "controller_review_bundle_unknown_field:$field" }
  }
  foreach ($field in @(Get-AgentPropertyNames $handoff)) {
    if (@('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash', 'controller_run_id', 'reviews') -cnotcontains $field) { $errors += "controller_review_handoff_unknown_field:$field" }
  }
  return [pscustomobject]@{ valid = $errors.Count -eq 0; errors = @($errors | Select-Object -Unique); reviewCount = $reviews.Count }
}
