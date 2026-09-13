# Dot-sourced only by the immutable-base gate module. No candidate code executes.
function Select-AgentHostReviewBundle {
  param([AllowEmptyCollection()][object[]]$Comments, [string]$Repository, [int]$PR, [string]$BaseSha, [string]$HeadSha, [string]$PublisherId)
  $markerV3 = '<!-- babel-controller-independent-review-v3 -->'
  $markerV2 = '<!-- babel-controller-ai-reviews-v2 -->'
  if ($PublisherId -notmatch '^[1-9][0-9]*$') { return [pscustomobject]@{ transport_error = 'host_review_publisher_unavailable' } }
  foreach ($comment in @($Comments | Sort-Object { [long](Get-AgentPropertyValue $_ 'id') } -Descending)) {
    $user = Get-AgentPropertyValue $comment 'user'
    if ([string](Get-AgentPropertyValue $user 'id') -ne $PublisherId -or [string](Get-AgentPropertyValue $user 'type') -cne 'User') { continue }
    $body = [string](Get-AgentPropertyValue $comment 'body')
    $marker = $null
    $version = 0
    if ($body.StartsWith($markerV3, [StringComparison]::Ordinal)) { $marker = $markerV3; $version = 3 }
    elseif ($body.StartsWith($markerV2, [StringComparison]::Ordinal)) { $marker = $markerV2; $version = 2 }
    else { continue }
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
    if ($version -eq 3) {
      return [pscustomobject][ordered]@{
        schema_version = 3; kind = 'github_host_review_bundle_v3'
        repository = $Repository; pr_number = $PR; base_sha = $BaseSha; head_sha = $HeadSha
        candidate_digest = [string](Get-AgentPropertyValue $handoff 'candidate_digest')
        publisher_id = $PublisherId; comment_id = [string](Get-AgentPropertyValue $comment 'id')
        handoff = $handoff
      }
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
  # Optional for legacy v2 transport, mandatory at the current merge gate.
  # These fields are controller assertions authenticated by live owner-comment
  # provenance, not a candidate-authored claim or cryptographic sandbox proof.
  $harness = Get-AgentPropertyValue $Evidence 'harness'
  if ($null -ne $Evidence.PSObject.Properties['harness']) {
    # A claimed Babel chat harness is only credible when the Babel-native
    # OpenCode Go transport produced the review. Pin it here, at the low-level
    # validator, so a claude-code (or any other provider) review cannot borrow
    # the harness block to satisfy the current chat gate. The pin is conditional
    # on a harness being present because this validator deliberately retains
    # compatibility with legacy/bootstrap v2 receipts that predate the harness;
    # the merge gate separately requires a harness via -RequireBabelChat.
    if ([string](Get-AgentPropertyValue $Evidence 'review_provider') -cne 'opencode-go') { $errors += 'autonomous_evidence_review_provider_not_babel' }
    if ($harness -isnot [pscustomobject]) { $errors += 'autonomous_evidence_harness_invalid' }
    else {
      $harnessExpected = @{ name = 'babel'; mode = 'chat'; execution_id = [string](Get-AgentPropertyValue $Evidence 'execution_id') }
      foreach ($field in $harnessExpected.Keys) {
        if ([string](Get-AgentPropertyValue $harness $field) -cne $harnessExpected[$field]) { $errors += "autonomous_evidence_harness_${field}_mismatch" }
      }
      if ([string](Get-AgentPropertyValue $harness 'version') -cnotmatch '^[0-9a-f]{64}$' -or
          [string](Get-AgentPropertyValue $harness 'source_sha') -cnotmatch '^[0-9a-f]{40}$') { $errors += 'autonomous_evidence_harness_version_invalid' }
      if ([string](Get-AgentPropertyValue $harness 'source_sha') -ceq $HeadSha) { $errors += 'autonomous_evidence_harness_candidate_self_review' }
      if ([string](Get-AgentPropertyValue $isolation 'mode') -cne 'readonly_sandbox') { $errors += 'autonomous_evidence_harness_isolation_invalid' }
      foreach ($field in @(Get-AgentPropertyNames $harness)) {
        if (@('name', 'mode', 'version', 'source_sha', 'execution_id') -cnotcontains $field) { $errors += "autonomous_evidence_harness_unknown_field:$field" }
      }
    }
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
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash', 'builder_id', 'diff_numstat_digest', 'reviewer_id', 'reviewer_class', 'execution_id', 'review_provider', 'reviewer_model', 'review_mode', 'reviewed_at', 'scope', 'verdict', 'findings', 'blocking_findings', 'isolation', 'usage', 'harness')
  foreach ($field in @(Get-AgentPropertyNames $Evidence)) {
    if ($allowed -cnotcontains $field) { $errors += "autonomous_evidence_unknown_field:$field" }
  }
  return [pscustomobject]@{ valid = $errors.Count -eq 0; errors = @($errors) }
}

function Test-AgentIndependentReviewEvidenceV3 {
  param(
    [Parameter(Mandatory)][AllowNull()][object]$Evidence,
    [Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][int]$PR,
    [Parameter(Mandatory)][string]$BaseSha, [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$ExpectedNumstatDigest,
    [string]$ExpectedCandidateDigest = '',
    [string]$TaskId = '', [string]$TaskHash = '', [string[]]$ExpectedScope = @(),
    [string]$BuilderIdentity = ''
  )
  $errors = @()
  if ($Evidence -isnot [pscustomobject]) { return [pscustomobject]@{ valid = $false; errors = @('independent_evidence_malformed') } }
  $expected = @{
    schema_version = '3'; kind = 'independent_agent_review_v3'; repository = $Repository
    pr_number = [string]$PR; base_sha = $BaseSha; head_sha = $HeadSha
    diff_numstat_digest = $ExpectedNumstatDigest
    review_mode = 'exact_diff'; verdict = 'APPROVE'
  }
  foreach ($field in $expected.Keys) {
    if ([string](Get-AgentPropertyValue $Evidence $field) -cne $expected[$field]) { $errors += ('independent_evidence_' + $field + '_mismatch') }
  }
  if ($ExpectedCandidateDigest -and [string](Get-AgentPropertyValue $Evidence 'candidate_digest') -cne $ExpectedCandidateDigest) {
    $errors += 'independent_evidence_candidate_digest_mismatch'
  }
  if ($TaskId -and [string](Get-AgentPropertyValue $Evidence 'task_id') -cne $TaskId) {
    $errors += 'independent_evidence_task_id_mismatch'
  }
  if ($TaskHash -and [string](Get-AgentPropertyValue $Evidence 'task_hash') -cne $TaskHash) {
    $errors += 'independent_evidence_task_hash_mismatch'
  }
  if ([string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue $Evidence 'challenge_id'))) {
    $errors += 'independent_evidence_challenge_id_missing'
  }
  if ([string]::IsNullOrWhiteSpace([string](Get-AgentPropertyValue $Evidence 'controller_run_id'))) {
    $errors += 'independent_evidence_controller_run_id_missing'
  }

  $builder = Get-AgentPropertyValue $Evidence 'builder'
  $reviewer = Get-AgentPropertyValue $Evidence 'reviewer'
  if ($builder -isnot [pscustomobject] -or $reviewer -isnot [pscustomobject]) {
    $errors += 'independent_evidence_actor_identity_invalid'
  } else {
    foreach ($actor in @($builder, $reviewer)) {
      foreach ($f in @('kind', 'principal_id', 'execution_id')) {
        $val = [string](Get-AgentPropertyValue $actor $f)
        if ([string]::IsNullOrWhiteSpace($val) -or $val.Trim() -ieq 'UNKNOWN') {
          $errors += "independent_evidence_actor_${f}_invalid"
        }
      }
    }
    $builderPrincipal = [string](Get-AgentPropertyValue $builder 'principal_id')
    $reviewerPrincipal = [string](Get-AgentPropertyValue $reviewer 'principal_id')
    $builderExec = [string](Get-AgentPropertyValue $builder 'execution_id')
    $reviewerExec = [string](Get-AgentPropertyValue $reviewer 'execution_id')
    if ($builderPrincipal -and $reviewerPrincipal -and $builderPrincipal.ToLowerInvariant() -eq $reviewerPrincipal.ToLowerInvariant()) {
      $errors += 'independent_evidence_reviewer_principal_not_independent'
    }
    if ($builderExec -and $reviewerExec -and $builderExec.ToLowerInvariant() -eq $reviewerExec.ToLowerInvariant()) {
      $errors += 'independent_evidence_reviewer_execution_not_distinct'
    }
    if ($BuilderIdentity -and $reviewerPrincipal -and $reviewerPrincipal.ToLowerInvariant() -eq $BuilderIdentity.ToLowerInvariant()) {
      $errors += 'independent_evidence_reviewer_principal_not_independent'
    }
  }

  $runtime = Get-AgentPropertyValue $Evidence 'runtime'
  if ($runtime -isnot [pscustomobject]) {
    $errors += 'independent_evidence_runtime_invalid'
  } else {
    $agentKind = [string](Get-AgentPropertyValue $runtime 'agent_kind')
    $adapterId = [string](Get-AgentPropertyValue $runtime 'adapter_id')
    $ctrlExecId = [string](Get-AgentPropertyValue $runtime 'controller_execution_id')
    if ([string]::IsNullOrWhiteSpace($agentKind) -or $agentKind.Trim() -ieq 'UNKNOWN') { $errors += 'independent_evidence_runtime_agent_kind_invalid' }
    if ([string]::IsNullOrWhiteSpace($adapterId) -or $adapterId.Trim() -ieq 'UNKNOWN') { $errors += 'independent_evidence_runtime_adapter_id_invalid' }
    if ([string]::IsNullOrWhiteSpace($ctrlExecId) -or $ctrlExecId -ne [string](Get-AgentPropertyValue $reviewer 'execution_id')) {
      $errors += 'independent_evidence_runtime_execution_mismatch'
    }

    $provider = [string](Get-AgentPropertyValue $runtime 'observed_provider')
    if ([string]::IsNullOrWhiteSpace($provider)) { $provider = [string](Get-AgentPropertyValue $runtime 'requested_provider') }

    if ($agentKind -ieq 'babel') {
      if ($provider -cne 'opencode-go') { $errors += 'independent_evidence_babel_must_use_opencode_go' }
      $rtVersion = [string](Get-AgentPropertyValue $runtime 'runtime_version')
      if ($rtVersion -cnotmatch '^[0-9a-f]{64}$') { $errors += 'independent_evidence_babel_version_invalid' }
    } else {
      if ($provider -ieq 'opencode-go') { $errors += 'independent_evidence_external_cannot_claim_opencode_go' }
      if ($adapterId -imatch '^babel-') { $errors += 'independent_evidence_external_cannot_claim_babel_adapter' }
    }
  }

  foreach ($field in @('scope', 'findings', 'blocking_findings')) {
    $value = Get-AgentPropertyValue $Evidence $field
    if ($null -eq $Evidence.PSObject.Properties[$field] -or $Evidence.PSObject.Properties[$field].Value -isnot [array] -or
        @($value | Where-Object { $_ -isnot [string] }).Count -gt 0) { $errors += ('independent_evidence_' + $field + '_invalid') }
  }
  $scope = @((Get-AgentPropertyValue $Evidence 'scope'))
  if ($scope.Count -eq 0 -or @($scope | Select-Object -Unique).Count -ne $scope.Count -or
      @($scope | Where-Object { $_ -match '\\|^/|^[A-Za-z]:|(^|/)\.\.?(/|$)|//' -or [string]::IsNullOrWhiteSpace($_) }).Count -gt 0) {
    $errors += 'independent_evidence_scope_invalid'
  }
  if ($ExpectedScope.Count -gt 0 -and (($scope | Sort-Object) -join "`n") -cne (($ExpectedScope | Sort-Object) -join "`n")) {
    $errors += 'independent_evidence_scope_mismatch'
  }
  if (@((Get-AgentPropertyValue $Evidence 'blocking_findings')).Count -gt 0) {
    $errors += 'independent_evidence_has_blocking_findings'
  }

  $reviewedAt = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParse([string](Get-AgentPropertyValue $Evidence 'reviewed_at'), [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$reviewedAt) -or
      $reviewedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or $reviewedAt -lt [DateTimeOffset]::UtcNow.AddDays(-1)) {
    $errors += 'independent_evidence_reviewed_at_invalid_or_stale'
  }

  $isolation = Get-AgentPropertyValue $Evidence 'isolation'
  if ($isolation -isnot [pscustomobject]) {
    $errors += 'independent_evidence_isolation_invalid'
  } else {
    foreach ($field in @('candidate_write', 'github_mutation', 'merge', 'controller_state_access')) {
      $value = Get-AgentPropertyValue $isolation $field
      if ($value -isnot [bool] -or $value -ne $false) { $errors += "independent_evidence_isolation_$field" }
    }
  }

  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'candidate_digest', 'diff_numstat_digest', 'task_id', 'task_hash', 'builder', 'reviewer', 'controller_run_id', 'challenge_id', 'runtime', 'review_mode', 'reviewed_at', 'scope', 'verdict', 'findings', 'blocking_findings', 'isolation', 'usage', 'provenance')
  foreach ($field in @(Get-AgentPropertyNames $Evidence)) {
    if ($allowed -cnotcontains $field) { $errors += "independent_evidence_unknown_field:$field" }
  }

  return [pscustomobject]@{ valid = ($errors.Count -eq 0); errors = @($errors) }
}

function Test-AgentHostReviewBundleV3 {
  param(
    [Parameter(Mandatory)][AllowNull()][object]$Bundle,
    [Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][int]$PR,
    [Parameter(Mandatory)][string]$BaseSha, [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$ExpectedNumstatDigest,
    [Parameter(Mandatory)][int]$MinimumReviewCount, [Parameter(Mandatory)][string]$PublisherId,
    [string]$ExpectedCandidateDigest = '',
    [string[]]$ExpectedScope = @(),
    [string]$BuilderIdentity = ''
  )
  $errors = @()
  if ($Bundle -isnot [pscustomobject]) { return [pscustomobject]@{ valid = $false; errors = @('controller_review_bundle_malformed'); reviewCount = 0 } }
  $expected = @{ schema_version = '3'; kind = 'github_host_review_bundle_v3'; repository = $Repository; pr_number = [string]$PR; base_sha = $BaseSha; head_sha = $HeadSha; publisher_id = $PublisherId }
  foreach ($field in $expected.Keys) {
    if ([string](Get-AgentPropertyValue $Bundle $field) -cne $expected[$field]) { $errors += ('controller_review_bundle_' + $field + '_mismatch') }
  }
  if ([string](Get-AgentPropertyValue $Bundle 'comment_id') -notmatch '^[1-9][0-9]*$' -or $PublisherId -notmatch '^[1-9][0-9]*$') {
    $errors += 'controller_review_bundle_provenance_invalid'
  }
  $handoff = Get-AgentPropertyValue $Bundle 'handoff'
  if ($handoff -isnot [pscustomobject]) { return [pscustomobject]@{ valid = $false; errors = @('controller_review_handoff_malformed'); reviewCount = 0 } }
  $handoffExpected = @{ schema_version = '3'; kind = 'host_review_handoff_v3'; repository = $Repository; pr_number = [string]$PR; base_sha = $BaseSha; head_sha = $HeadSha }
  foreach ($field in $handoffExpected.Keys) {
    if ([string](Get-AgentPropertyValue $handoff $field) -cne $handoffExpected[$field]) { $errors += ('controller_review_handoff_' + $field + '_mismatch') }
  }
  $taskId = [string](Get-AgentPropertyValue $handoff 'task_id')
  $taskHash = [string](Get-AgentPropertyValue $handoff 'task_hash')
  $candidateDigest = [string](Get-AgentPropertyValue $handoff 'candidate_digest')
  $controllerRunId = [string](Get-AgentPropertyValue $handoff 'controller_run_id')
  if ([string]::IsNullOrWhiteSpace($taskId) -or $taskHash -cnotmatch '^[0-9a-f]{64}$' -or [string]::IsNullOrWhiteSpace($controllerRunId)) {
    $errors += 'controller_review_handoff_task_or_run_invalid'
  }
  if ($ExpectedCandidateDigest -and $candidateDigest -ne $ExpectedCandidateDigest) {
    $errors += 'controller_review_handoff_candidate_digest_mismatch'
  }

  $reviews = @((Get-AgentPropertyValue $handoff 'reviews'))
  if ($reviews.Count -lt $MinimumReviewCount -or $reviews.Count -gt 2) {
    $errors += 'controller_review_bundle_insufficient_or_excess_reviews'
  }

  $principals = @{}; $executions = @{}; $challenges = @{}
  foreach ($review in $reviews) {
    $validation = Test-AgentIndependentReviewEvidenceV3 -Evidence $review -Repository $Repository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -ExpectedNumstatDigest $ExpectedNumstatDigest -ExpectedCandidateDigest $candidateDigest -TaskId $taskId -TaskHash $taskHash -ExpectedScope $ExpectedScope -BuilderIdentity $BuilderIdentity
    $errors += @($validation.errors)
    $reviewer = Get-AgentPropertyValue $review 'reviewer'
    $principalId = [string](Get-AgentPropertyValue $reviewer 'principal_id')
    $executionId = [string](Get-AgentPropertyValue $reviewer 'execution_id')
    $challengeId = [string](Get-AgentPropertyValue $review 'challenge_id')
    if ($principals.ContainsKey($principalId) -or $executions.ContainsKey($executionId)) {
      $errors += 'controller_review_bundle_reviewer_or_execution_not_distinct'
    }
    if ($challengeId -and $challenges.ContainsKey($challengeId)) {
      $errors += 'controller_review_bundle_challenge_not_distinct'
    }
    if ($principalId) { $principals[$principalId] = $true }
    if ($executionId) { $executions[$executionId] = $true }
    if ($challengeId) { $challenges[$challengeId] = $true }
  }

  $allowedBundle = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'candidate_digest', 'publisher_id', 'comment_id', 'handoff')
  foreach ($field in @(Get-AgentPropertyNames $Bundle)) {
    if ($allowedBundle -cnotcontains $field) { $errors += "controller_review_bundle_unknown_field:$field" }
  }
  $allowedHandoff = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'candidate_digest', 'diff_numstat_digest', 'task_id', 'task_hash', 'controller_run_id', 'reviews')
  foreach ($field in @(Get-AgentPropertyNames $handoff)) {
    if ($allowedHandoff -cnotcontains $field) { $errors += "controller_review_handoff_unknown_field:$field" }
  }

  return [pscustomobject]@{ valid = ($errors.Count -eq 0); errors = @($errors | Select-Object -Unique); reviewCount = $reviews.Count }
}

function Test-AgentControllerReviewEvidenceBundle {
  param(
    [Parameter(Mandatory)][AllowNull()][object]$Bundle,
    [Parameter(Mandatory)][string]$Repository, [Parameter(Mandatory)][int]$PR,
    [Parameter(Mandatory)][string]$BaseSha, [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$BuilderIdentity, [Parameter(Mandatory)][string]$ExpectedNumstatDigest,
    [Parameter(Mandatory)][int]$MinimumReviewCount, [Parameter(Mandatory)][string]$PublisherId,
    [string[]]$ExpectedScope = @(), [switch]$RequireBabelChat, [string]$ExpectedCandidateDigest = ''
  )
  if ($null -ne $Bundle) {
    $sv = [string](Get-AgentPropertyValue $Bundle 'schema_version')
    $kind = [string](Get-AgentPropertyValue $Bundle 'kind')
    if ($sv -eq '3' -or $kind -eq 'github_host_review_bundle_v3') {
      return Test-AgentHostReviewBundleV3 -Bundle $Bundle -Repository $Repository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -ExpectedNumstatDigest $ExpectedNumstatDigest -MinimumReviewCount $MinimumReviewCount -PublisherId $PublisherId -ExpectedCandidateDigest $ExpectedCandidateDigest -ExpectedScope $ExpectedScope -BuilderIdentity $BuilderIdentity
    }
  }

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
  $reviewers = @{}; $executions = @{}; $babelChatReviewCount = 0
  foreach ($review in $reviews) {
    $validation = Test-AgentAutonomousReviewEvidence -Evidence $review -Repository $Repository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -BuilderIdentity $BuilderIdentity -ExpectedNumstatDigest $ExpectedNumstatDigest -TaskId $taskId -TaskHash $taskHash -ExpectedScope $ExpectedScope
    $errors += @($validation.errors)
    if ($validation.valid -and $null -ne (Get-AgentPropertyValue $review 'harness')) { $babelChatReviewCount++ }
    $reviewerId = [string](Get-AgentPropertyValue $review 'reviewer_id')
    $executionId = [string](Get-AgentPropertyValue $review 'execution_id')
    if ($reviewers.ContainsKey($reviewerId) -or $executions.ContainsKey($executionId)) { $errors += 'controller_review_bundle_reviewer_or_execution_not_distinct' }
    $reviewers[$reviewerId] = $true; $executions[$executionId] = $true
  }
  if ($RequireBabelChat -and $babelChatReviewCount -lt 1) { $errors += 'controller_review_bundle_babel_chat_required' }
  $allowed = @('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'publisher_id', 'comment_id', 'handoff')
  foreach ($field in @(Get-AgentPropertyNames $Bundle)) {
    if ($allowed -cnotcontains $field) { $errors += "controller_review_bundle_unknown_field:$field" }
  }
  foreach ($field in @(Get-AgentPropertyNames $handoff)) {
    if (@('schema_version', 'kind', 'repository', 'pr_number', 'base_sha', 'head_sha', 'task_id', 'task_hash', 'controller_run_id', 'reviews') -cnotcontains $field) { $errors += "controller_review_handoff_unknown_field:$field" }
  }
  return [pscustomobject]@{ valid = $errors.Count -eq 0; errors = @($errors | Select-Object -Unique); reviewCount = $reviews.Count; babelChatReviewCount = $babelChatReviewCount }
}
