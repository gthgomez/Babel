[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\..\scripts\agent-pr-gate-common.psm1') -Force

function Assert-ClosureGate {
  param([Parameter(Mandatory = $true)][bool]$Condition, [Parameter(Mandatory = $true)][string]$Message)
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function New-ClosureObservation {
  param(
    [string]$Name,
    [string]$Head = ('a' * 40),
    [string]$Event = 'pull_request',
    [string]$WorkflowName = 'Public Release Gate',
    [string]$RunId = '100',
    [string]$AppId = '15368'
  )
  return [pscustomobject][ordered]@{
    name = $Name
    head_sha = $Head
    status = 'completed'
    conclusion = 'success'
    event = $Event
    workflow_name = $WorkflowName
    workflow_id = "workflow-$RunId"
    workflow_run_id = $RunId
    workflow_run_attempt = '1'
    check_suite_id = "suite-$RunId"
    check_run_id = "check-$RunId"
    started_at = '2026-09-06T10:00:00Z'
    completed_at = '2026-09-06T10:01:00Z'
    authority = ''
    app_id = $AppId
    app_slug = 'github-actions'
    app_name = 'GitHub Actions'
  }
}

$head = 'a' * 40
$base = 'b' * 40
$expectedDigest = 'd' * 64

try {
  $gateAst = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../../scripts/agent-pr-gate.ps1'), [ref]$null, [ref]$null)
  $floorAssignments = @($gateAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$minimumReviewCount' }, $true))
  Assert-ClosureGate ($floorAssignments.Count -eq 1 -and $floorAssignments[0].Right.Extent.Text -match 'Get-AgentMinimumReviewCount') 'merge gate must resolve reviewer count from the shared policy'
  Assert-ClosureGate ((Get-AgentMinimumReviewCount -Lane GREEN) -eq 1) 'normal changes require one reviewer'
  Assert-ClosureGate ((Get-AgentMinimumReviewCount -Lane YELLOW) -eq 2) 'elevated changes require two reviewers'
  Assert-ClosureGate ((Get-AgentMinimumReviewCount -Lane RED) -eq 2) 'critical changes require two reviewers'
  Assert-ClosureGate ((Get-AgentRiskLane -ChangedPaths @('tools/babel-pr-orchestrate.mts')) -eq 'RED') 'review control paths are critical in the installed gate'
  $trustedAuthority = Get-AgentRequiredCheckAuthority -RequiredName 'trusted-control-plane'
  Assert-ClosureGate ([bool]$trustedAuthority.configured) 'trusted-control-plane must have a configured producer'
  Assert-ClosureGate ($trustedAuthority.event -eq 'pull_request_target') 'trusted-control-plane must use pull_request_target'
  Assert-ClosureGate ($trustedAuthority.workflow_name -eq 'Trusted Control Plane') 'trusted-control-plane must use Trusted Control Plane'

  $trustedGood = New-ClosureObservation -Name 'trusted-control-plane' -Event 'pull_request_target' -WorkflowName 'Trusted Control Plane' -RunId '151-good'
  $trustedImpostor = New-ClosureObservation -Name 'trusted-control-plane' -RunId '151-impostor'
  $trustedArgs = @{
    Observations = @($trustedGood, $trustedImpostor)
    RequiredName = 'trusted-control-plane'
    TargetSha = $head
    AuthorityEvent = [string]$trustedAuthority.event
    AuthorityWorkflowName = [string]$trustedAuthority.workflow_name
    AuthorityAppId = [int64]15368
  }
  $trustedResolution = Resolve-AgentRequiredCheck @trustedArgs
  Assert-ClosureGate ($trustedResolution.status -eq 'PASS') 'authoritative trusted-control-plane check must pass'
  Assert-ClosureGate ($trustedResolution.selected.check_run_id -eq 'check-151-good') 'trusted resolver must select the authoritative producer'

  $impostorArgs = @{
    Observations = @($trustedImpostor)
    RequiredName = 'trusted-control-plane'
    TargetSha = $head
    AuthorityEvent = [string]$trustedAuthority.event
    AuthorityWorkflowName = [string]$trustedAuthority.workflow_name
    AuthorityAppId = [int64]15368
  }
  $impostorOnly = Resolve-AgentRequiredCheck @impostorArgs
  Assert-ClosureGate ($impostorOnly.status -eq 'AMBIGUOUS') 'same-name check from the wrong workflow/event must not satisfy trusted-control-plane'
  Assert-ClosureGate ($impostorOnly.reason -eq 'no_authoritative_producer_observation') 'producer mismatch must be explicit and fail closed'

  $wrongApp = New-ClosureObservation -Name 'trusted-control-plane' -Event 'pull_request_target' -WorkflowName 'Trusted Control Plane' -RunId '151-wrong-app' -AppId '99999'
  $wrongAppResolution = Resolve-AgentRequiredCheck -Observations @($wrongApp) -RequiredName 'trusted-control-plane' -TargetSha $head -AuthorityEvent 'pull_request_target' -AuthorityWorkflowName 'Trusted Control Plane' -AuthorityAppId ([int64]15368)
  Assert-ClosureGate ($wrongAppResolution.status -eq 'AMBIGUOUS') 'same producer name with the wrong GitHub app must not satisfy the requirement'

  $metadataAuthority = Get-AgentRequiredCheckAuthority -RequiredName 'public-pr-metadata'
  Assert-ClosureGate ($metadataAuthority.event -eq 'pull_request_target' -and $metadataAuthority.workflow_name -eq 'Public PR Metadata') 'public-pr-metadata producer binding must remain privileged and distinct'
  $metadataGood = New-ClosureObservation -Name 'public-pr-metadata' -Event 'pull_request_target' -WorkflowName 'Public PR Metadata' -RunId 'metadata-good'
  $metadataImpostor = New-ClosureObservation -Name 'public-pr-metadata' -Event 'pull_request_target' -WorkflowName 'Public Release Gate' -RunId 'metadata-impostor'
  $metadataResolution = Resolve-AgentRequiredCheck -Observations @($metadataGood, $metadataImpostor) -RequiredName 'public-pr-metadata' -TargetSha $head -AuthorityEvent 'pull_request_target' -AuthorityWorkflowName 'Public PR Metadata' -AuthorityAppId ([int64]15368)
  Assert-ClosureGate ($metadataResolution.status -eq 'PASS' -and $metadataResolution.selected.check_run_id -eq 'check-metadata-good') 'public-pr-metadata must reject a same-name wrong-workflow twin'

  $ordinary = New-ClosureObservation -Name 'security' -RunId 'ordinary-good'
  $ordinaryResolution = Resolve-AgentRequiredCheck -Observations @($ordinary) -RequiredName 'security' -TargetSha $head -AuthorityEvent 'pull_request' -AuthorityWorkflowName 'Public Release Gate' -AuthorityAppId ([int64]15368)
  Assert-ClosureGate ($ordinaryResolution.status -eq 'PASS') 'ordinary Public Release Gate checks must retain their producer binding'

  $validEvidence = [pscustomobject][ordered]@{
    schema_version = 2
    kind = 'autonomous_review_evidence_v2'
    repository = 'gthgomez/Babel'
    pr_number = 152
    base_sha = $base
    head_sha = $head
    task_id = 'task-152'
    task_hash = ('e' * 64)
    reviewer_id = 'codex-final-independent-review'
    reviewer_class = 'independent_readonly_ai'
    execution_id = 'execution-152-a'
    review_provider = 'opencode-go'
    reviewer_model = 'deepseek-v4-flash'
    review_mode = 'exact_diff'
    reviewed_at = [DateTimeOffset]::UtcNow.ToString('o')
    scope = @('scripts/agent-pr-gate.ps1')
    findings = @()
    blocking_findings = @()
    verdict = 'APPROVE'
    builder_id = 'codex-implementation'
    diff_numstat_digest = $expectedDigest
    isolation = [pscustomobject]@{ mode = 'text_only_no_tools'; candidate_write = $false; github_mutation = $false; merge = $false; controller_state_access = $false }
  }
  $validResult = Test-AgentAutonomousReviewEvidence -Evidence $validEvidence -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -TaskId 'task-152' -TaskHash ('e' * 64) -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate ([bool]$validResult.valid) 'well-formed evidence must remain valid'

  $bundle = [pscustomobject][ordered]@{
    schema_version = 2; kind = 'github_host_review_bundle_v2'
    repository = 'gthgomez/Babel'; pr_number = 152; base_sha = $base; head_sha = $head
    publisher_id = '91163862'; comment_id = '42'
    handoff = [pscustomobject]@{ schema_version = 2; kind = 'host_review_handoff_v2' }
  }
  $legacyResult = Test-AgentControllerReviewEvidenceBundle -Bundle $bundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 1 -PublisherId '91163862'
  Assert-ClosureGate (-not $legacyResult.valid -and @($legacyResult.errors) -contains 'legacy_v2_review_unsupported') 'V2 cannot satisfy the V3-only merge gate'

  $evidenceCases = @(
    @{ Name = 'null evidence'; Value = $null; Error = 'autonomous_evidence_malformed' }
    @{ Name = 'empty object'; Value = [pscustomobject]@{}; Error = 'autonomous_evidence_schema_version_mismatch' }
    @{ Name = 'unsupported schema'; Value = [pscustomobject]@{ schema_version = 3 }; Error = 'autonomous_evidence_schema_version_mismatch' }
    @{ Name = 'transport missing stub'; Value = [pscustomobject]@{ transport_error = 'autonomous_review_evidence_handoff_missing' }; Error = 'autonomous_review_evidence_missing' }
    @{ Name = 'transport ambiguous stub'; Value = [pscustomobject]@{ transport_error = 'autonomous_review_evidence_handoff_ambiguous' }; Error = 'autonomous_review_evidence_ambiguous' }
    @{ Name = 'JSON scalar'; Value = 'not-an-object'; Error = 'autonomous_evidence_malformed' }
    @{ Name = 'JSON array'; Value = @('not-an-object'); Error = 'autonomous_evidence_malformed' }
  )
  foreach ($case in $evidenceCases) {
    $transportError = Get-AgentEvidenceTransportError -Document $case.Value
    if ($case.Name -like 'transport *') {
      Assert-ClosureGate ($transportError -eq $case.Error) "$($case.Name) must map to a deterministic transport blocker"
    }
    try {
      $result = Test-AgentAutonomousReviewEvidence -Evidence $case.Value -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest
    } catch {
      throw "$($case.Name) threw instead of returning BLOCKED evidence: $($_.Exception.Message)"
    }
    Assert-ClosureGate (-not [bool]$result.valid) "$($case.Name) must be invalid"
    Assert-ClosureGate (@($result.errors) -contains $case.Error -or $case.Name -like 'transport *') "$($case.Name) must expose a deterministic validation reason"
  }

  # V3 Independent Agent Review Suite
  $candDigest = 'c' * 64
  $validV3Evidence = [pscustomobject][ordered]@{
    schema_version = 3
    kind = 'independent_agent_review_v3'
    provenance = 'TRUSTED_CONTROLLER_EVIDENCE'
    repository = 'gthgomez/Babel'
    pr_number = 152
    base_sha = $base
    head_sha = $head
    candidate_digest = $candDigest
    diff_numstat_digest = $expectedDigest
    task_id = 'task-152'
    task_hash = ('e' * 64)
    builder = [pscustomobject][ordered]@{
      kind = 'codex'
      principal_id = 'codex-builder-p1'
      execution_id = 'codex-builder-e1'
    }
    reviewer = [pscustomobject][ordered]@{
      kind = 'codex'
      principal_id = 'codex-reviewer-p2'
      execution_id = 'codex-reviewer-e2'
    }
    controller_run_id = 'run-152'
    challenge_id = 'challenge-152-a'
    runtime = [pscustomobject][ordered]@{
      agent_kind = 'codex'
      adapter_id = 'codex-subagent-v1'
      controller_execution_id = 'codex-reviewer-e2'
      execution_purpose = 'FINAL_CERTIFICATION'
      requested_provider = 'openai'
      observed_provider = 'openai'
      requested_model = 'gpt-5-codex'
      observed_model = 'gpt-5-codex'
      model_attribution = 'observed'
      provider_execution_id = 'codex-child-session-1'
      session_id = 'codex-child-session-1'
      parent_execution_id = 'codex-builder-e1'
      source_sha = $base
      fresh_context = $true
      read_only_enforced = $true
    }
    review_mode = 'exact_diff'
    execution_purpose = 'FINAL_CERTIFICATION'
    reviewed_at = [DateTimeOffset]::UtcNow.ToString('o')
    scope = @('scripts/agent-pr-gate.ps1')
    verdict = 'APPROVE'
    findings = @()
    blocking_findings = @()
    coverage = [pscustomobject][ordered]@{
      diff_consumed = $true
      diff_sha256 = ('f' * 64)
      diff_lines_total = 2
      diff_lines_read = 2
      changed_paths = 1
      source_paths_opened = @()
    }
    isolation = [pscustomobject][ordered]@{
      candidate_write = $false
      github_mutation = $false
      merge = $false
      controller_state_access = $false
    }
  }

  # Accept: same kind (Codex A -> Codex B) with distinct principal and execution
  $v3Result = Test-AgentIndependentReviewEvidenceV3 -Evidence $validV3Evidence -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest -ExpectedCandidateDigest $candDigest -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate ($v3Result.valid) 'V3 must accept same agent kind when principal and execution are distinct'

  $missingTrustedSource = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $missingTrustedSource.runtime.PSObject.Properties.Remove('source_sha')
  $missingSourceResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $missingTrustedSource -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $missingSourceResult.valid -and @($missingSourceResult.errors) -contains 'independent_evidence_trusted_source_required') 'V3 must require trusted controller source for Babel'

  $wrongLiveDiff = Test-AgentIndependentReviewEvidenceV3 -Evidence $validV3Evidence -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest -ExpectedDiffSha256 ('0' * 64) -ExpectedDiffLines 2
  Assert-ClosureGate (-not $wrongLiveDiff.valid -and @($wrongLiveDiff.errors) -contains 'independent_evidence_live_diff_mismatch') 'V3 must bind coverage to the live exact diff'

  $invalidCoverage = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $invalidCoverage.coverage.diff_lines_total = 'not-a-number'
  $invalidCoverageResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $invalidCoverage -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $invalidCoverageResult.valid -and @($invalidCoverageResult.errors) -contains 'independent_evidence_full_diff_coverage_required') 'V3 must reject malformed diff coverage without throwing'

  $staleContext = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $staleContext.runtime.fresh_context = $false
  $staleContextResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $staleContext -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $staleContextResult.valid -and @($staleContextResult.errors) -contains 'independent_evidence_fresh_readonly_required') 'V3 must require observed fresh context'

  # Accept: different kind (Codex -> Claude)
  $claudeV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $claudeV3.reviewer.kind = 'claude-code'
  $claudeV3.reviewer.principal_id = 'claude-p1'
  $claudeV3.runtime.agent_kind = 'claude-code'
  $claudeV3.runtime.adapter_id = 'claude-cli-v1'
  $claudeV3.runtime.observed_provider = 'anthropic'
  $claudeResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $claudeV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest -ExpectedCandidateDigest $candDigest
  Assert-ClosureGate ($claudeResult.valid) 'V3 must accept external Claude reviewer with authentic provider'

  # Accept: unavailable model attribution
  $unkModelV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $unkModelV3.runtime.observed_model = $null
  $unkModelV3.runtime.model_attribution = 'unavailable'
  $unkModelResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $unkModelV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate ($unkModelResult.valid) 'V3 must accept unavailable model attribution with valid controller execution'

  # Reject: same principal_id
  $samePrincipal = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $samePrincipal.reviewer.principal_id = $samePrincipal.builder.principal_id
  Assert-ClosureGate (-not (Test-AgentIndependentReviewEvidenceV3 -Evidence $samePrincipal -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest).valid) 'V3 must reject matching builder and reviewer principal'

  # Reject: same execution_id
  $sameExec = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $sameExec.reviewer.execution_id = $sameExec.builder.execution_id
  $sameExec.runtime.controller_execution_id = $sameExec.builder.execution_id
  Assert-ClosureGate (-not (Test-AgentIndependentReviewEvidenceV3 -Evidence $sameExec -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest).valid) 'V3 must reject matching builder and reviewer execution'

  # Reject: runtime execution mismatch
  $execMismatch = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $execMismatch.runtime.controller_execution_id = 'invented-exec-id'
  Assert-ClosureGate (-not (Test-AgentIndependentReviewEvidenceV3 -Evidence $execMismatch -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest).valid) 'V3 must reject runtime controller execution mismatch'

  # Reject: external agent claiming opencode-go
  $forgedProvider = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $forgedProvider.runtime.agent_kind = 'babel'
  Assert-ClosureGate (-not (Test-AgentIndependentReviewEvidenceV3 -Evidence $forgedProvider -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest).valid) 'V3 must reject runtime family mismatch'

  # Reject: APPROVE with blocking findings
  $blockApproval = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $blockApproval.blocking_findings = @('Unresolved security vulnerability')
  Assert-ClosureGate (-not (Test-AgentIndependentReviewEvidenceV3 -Evidence $blockApproval -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest).valid) 'V3 must reject APPROVE verdict with blocking findings'

  # Accept: FINAL_CERTIFICATION purpose
  Assert-ClosureGate ((Test-AgentIndependentReviewEvidenceV3 -Evidence $validV3Evidence -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest).valid) 'V3 must accept FINAL_CERTIFICATION execution purpose'

  # Reject: missing execution_purpose
  $missingPurposeV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $missingPurposeV3.PSObject.Properties.Remove('execution_purpose')
  $missingPurposeResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $missingPurposeV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $missingPurposeResult.valid -and @($missingPurposeResult.errors) -contains 'independent_evidence_non_certification_purpose') 'V3 must reject missing execution_purpose for merge gate authority'

  # Reject: purpose layer mismatch between runtime and evidence
  $mismatchPurposeV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $mismatchPurposeV3.runtime.execution_purpose = 'DOGFOOD_REVIEW'
  $mismatchPurposeResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $mismatchPurposeV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $mismatchPurposeResult.valid -and @($mismatchPurposeResult.errors) -contains 'independent_evidence_purpose_layer_mismatch') 'V3 must reject purpose layer mismatch between runtime and evidence'

  # Reject: DOGFOOD_REVIEW or REVIEW_REPAIR purpose at merge gate
  $dogfoodV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $dogfoodV3.execution_purpose = 'DOGFOOD_REVIEW'
  $dogfoodResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $dogfoodV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $dogfoodResult.valid -and @($dogfoodResult.errors) -contains 'independent_evidence_non_certification_purpose') 'V3 must reject DOGFOOD_REVIEW for merge gate authority'

  $repairV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $repairV3.execution_purpose = 'REVIEW_REPAIR'
  $repairResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $repairV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $repairResult.valid -and @($repairResult.errors) -contains 'independent_evidence_non_certification_purpose') 'V3 must reject REVIEW_REPAIR for merge gate authority'

  # V3 Bundle Test
  $v3Bundle = [pscustomobject][ordered]@{
    schema_version = 3; kind = 'github_host_review_bundle_v3'
    repository = 'gthgomez/Babel'; pr_number = 152; base_sha = $base; head_sha = $head
    candidate_digest = $candDigest; publisher_id = '91163862'; comment_id = '1001'
    handoff = [pscustomobject][ordered]@{
      schema_version = 3; kind = 'host_review_handoff_v3'
      provenance = 'TRUSTED_CONTROLLER_EVIDENCE'
      repository = 'gthgomez/Babel'; pr_number = 152; base_sha = $base; head_sha = $head
      candidate_digest = $candDigest; diff_numstat_digest = $expectedDigest
      task_id = 'task-152'; task_hash = ('e' * 64); controller_run_id = 'run-152'
      reviews = @($validV3Evidence)
    }
  }
  $bundleCheck = Test-AgentControllerReviewEvidenceBundle -Bundle $v3Bundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 1 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate ($bundleCheck.valid -and $bundleCheck.reviewCount -eq 1) 'V3 bundle must satisfy one-review floor'

  # Reject: LOCAL_UNAUTHENTICATED evidence
  $unauthV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $unauthV3.provenance = 'LOCAL_UNAUTHENTICATED'
  $unauthResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $unauthV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $unauthResult.valid -and @($unauthResult.errors) -contains 'independent_evidence_provenance_unauthenticated') 'V3 must reject LOCAL_UNAUTHENTICATED evidence'

  # Reject: invalid/traversal challenge_id
  $traversalV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $traversalV3.challenge_id = '../traversal'
  $traversalResult = Test-AgentIndependentReviewEvidenceV3 -Evidence $traversalV3 -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate (-not $traversalResult.valid -and @($traversalResult.errors) -contains 'independent_evidence_challenge_id_invalid') 'V3 must reject path traversal challenge_id'

  # Reject: LOCAL_UNAUTHENTICATED handoff
  $unauthBundle = $v3Bundle | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $unauthBundle.handoff.provenance = 'LOCAL_UNAUTHENTICATED'
  $unauthBundleResult = Test-AgentControllerReviewEvidenceBundle -Bundle $unauthBundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 1 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate (-not $unauthBundleResult.valid -and @($unauthBundleResult.errors) -contains 'controller_review_handoff_provenance_unauthenticated') 'V3 bundle must reject LOCAL_UNAUTHENTICATED handoff'

  # Two-review bundle escalation
  $secondV3 = $validV3Evidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $secondV3.reviewer.principal_id = 'claude-p2'
  $secondV3.reviewer.execution_id = 'claude-e2'
  $secondV3.reviewer.kind = 'claude-code'
  $secondV3.challenge_id = 'challenge-152-b'
  $secondV3.runtime.agent_kind = 'claude-code'
  $secondV3.runtime.adapter_id = 'claude-cli-v1'
  $secondV3.runtime.controller_execution_id = 'claude-e2'
  $secondV3.runtime.provider_execution_id = 'claude-child-session-2'
  $secondV3.runtime.session_id = 'claude-child-session-2'
  $secondV3.runtime.observed_provider = 'anthropic'
  $v3BundleEscalated = $v3Bundle | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $v3BundleEscalated.handoff.reviews += $secondV3
  $escalatedCheck = Test-AgentControllerReviewEvidenceBundle -Bundle $v3BundleEscalated -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 2 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate ($escalatedCheck.valid -and $escalatedCheck.reviewCount -eq 2) 'V3 bundle must satisfy 2-review escalation with distinct identities'

  # Reject duplicate principal in 2-review bundle
  $dupBundle = $v3BundleEscalated | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $dupBundle.handoff.reviews[1].reviewer.principal_id = $dupBundle.handoff.reviews[0].reviewer.principal_id
  Assert-ClosureGate (-not (Test-AgentControllerReviewEvidenceBundle -Bundle $dupBundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 2 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')).valid) 'V3 bundle must reject duplicate reviewer principal in 2-review escalation'
  $sameObserved = $v3BundleEscalated | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $sameObserved.handoff.reviews[1].runtime.provider_execution_id = $sameObserved.handoff.reviews[0].runtime.provider_execution_id
  Assert-ClosureGate (-not (Test-AgentControllerReviewEvidenceBundle -Bundle $sameObserved -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 2 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')).valid) 'V3 bundle must reject reused observed child execution'

  # Public comment handoff (provenance stripped per publicIndependentReviewHandoffV3)
  $publicHandoff = $v3Bundle.handoff | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $publicHandoff.PSObject.Properties.Remove('provenance')
  $publicHandoff.reviews[0].PSObject.Properties.Remove('provenance')
  $publicCommentBody = "<!-- babel-controller-independent-review-v3 -->`n" + ($publicHandoff | ConvertTo-Json -Depth 30)
  $commentObj = [pscustomobject]@{
    id = 1001
    user = [pscustomobject]@{ id = '91163862'; type = 'User' }
    body = $publicCommentBody
    issue_url = "https://api.github.com/repos/gthgomez/Babel/issues/152"
  }
  $selectedBundle = Select-AgentHostReviewBundle -Comments @($commentObj) -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -PublisherId '91163862'
  $selectedCheck = Test-AgentControllerReviewEvidenceBundle -Bundle $selectedBundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 1 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate ($selectedCheck.valid -and $selectedCheck.reviewCount -eq 1) 'Public owner-authenticated V3 comment must pass bundle validation'

  Write-Output 'agent-pr-gate-closure: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
