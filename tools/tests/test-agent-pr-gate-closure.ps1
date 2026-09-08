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
    handoff = [pscustomobject][ordered]@{
      schema_version = 2; kind = 'host_review_handoff_v2'; repository = 'gthgomez/Babel'; pr_number = 152; base_sha = $base; head_sha = $head
      task_id = 'task-152'; task_hash = ('e' * 64); controller_run_id = 'controller-run-152'; reviews = @($validEvidence)
    }
  }
  $bundleResult = Test-AgentControllerReviewEvidenceBundle -Bundle $bundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 1 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate ([bool]$bundleResult.valid -and $bundleResult.reviewCount -eq 1) 'YELLOW review must require controller-owned exact-head evidence'
  $redBundle = Test-AgentControllerReviewEvidenceBundle -Bundle $bundle -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest -MinimumReviewCount 2 -PublisherId '91163862' -ExpectedScope @('scripts/agent-pr-gate.ps1')
  Assert-ClosureGate (-not [bool]$redBundle.valid -and @($redBundle.errors) -contains 'controller_review_bundle_insufficient_or_excess_reviews') 'RED review must require two independent perspectives'

  $chatArgs = @{ Repository = 'gthgomez/Babel'; PR = 152; BaseSha = $base; HeadSha = $head; BuilderIdentity = 'codex-implementation'; ExpectedNumstatDigest = $expectedDigest; MinimumReviewCount = 1; PublisherId = '91163862'; ExpectedScope = @('scripts/agent-pr-gate.ps1'); RequireBabelChat = $true }
  $noChat = Test-AgentControllerReviewEvidenceBundle -Bundle $bundle @chatArgs
  Assert-ClosureGate (-not $noChat.valid -and $noChat.errors -contains 'controller_review_bundle_babel_chat_required') 'legacy text-only review cannot satisfy the new chat gate'
  $chatBundle = $bundle | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $chatBundle.handoff.reviews[0].isolation.mode = 'readonly_sandbox'
  $chatBundle.handoff.reviews[0] | Add-Member harness ([pscustomobject]@{ name = 'babel'; mode = 'chat'; version = ('f' * 64); source_sha = $base; execution_id = 'execution-152-a' })
  $chatResult = Test-AgentControllerReviewEvidenceBundle -Bundle $chatBundle @chatArgs
  Assert-ClosureGate ($chatResult.valid -and $chatResult.babelChatReviewCount -eq 1) 'one valid Babel chat review must satisfy the ordinary PR floor'
  foreach ($mutation in @(
      @{ Field = 'mode'; Value = 'deep' }, @{ Field = 'name'; Value = 'direct-api' },
      @{ Field = 'version'; Value = 'UNKNOWN' }, @{ Field = 'source_sha'; Value = 'main' },
      @{ Field = 'source_sha'; Value = $head },
      @{ Field = 'execution_id'; Value = 'another-execution' }, @{ Field = 'invented'; Value = 'field' }
    )) {
    $invalid = $chatBundle | ConvertTo-Json -Depth 30 | ConvertFrom-Json
    $invalid.handoff.reviews[0].harness | Add-Member -Force $mutation.Field $mutation.Value
    $invalidResult = Test-AgentControllerReviewEvidenceBundle -Bundle $invalid @chatArgs
    Assert-ClosureGate (-not $invalidResult.valid -and $invalidResult.babelChatReviewCount -eq 0) "invalid harness $($mutation.Field) must not count as chat evidence"
  }
  $invalidIsolation = $chatBundle | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $invalidIsolation.handoff.reviews[0].isolation.mode = 'text_only_no_tools'
  Assert-ClosureGate (-not (Test-AgentControllerReviewEvidenceBundle -Bundle $invalidIsolation @chatArgs).valid) 'text-only isolation cannot claim a chat harness run'
  $missing = $chatBundle | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $missing.handoff.reviews = @()
  Assert-ClosureGate (-not (Test-AgentControllerReviewEvidenceBundle -Bundle $missing @chatArgs).valid) 'zero reviews must fail even for ordinary GREEN PRs'
  $second = $validEvidence | ConvertTo-Json -Depth 30 | ConvertFrom-Json
  $second.execution_id = 'execution-152-b'; $second.reviewer_id = 'second-independent-perspective'
  $chatBundle.handoff.reviews += $second
  $chatArgs.MinimumReviewCount = 2
  Assert-ClosureGate ((Test-AgentControllerReviewEvidenceBundle -Bundle $chatBundle @chatArgs).valid) 'RED may combine one Babel chat review with a distinct independent perspective'

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

  Write-Output 'agent-pr-gate-closure: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
