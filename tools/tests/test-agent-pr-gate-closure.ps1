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
    schema_version = 1
    kind = 'autonomous_review_evidence_v1'
    repository = 'gthgomez/Babel'
    pr_number = 152
    base_sha = $base
    head_sha = $head
    reviewer_id = 'codex-final-independent-review'
    reviewer_class = 'independent_readonly'
    review_mode = 'exact_head'
    reviewed_at = '2026-09-06T10:05:00Z'
    scope = @('protected merge-control repair')
    findings = @()
    blocking_findings = @()
    verdict = 'APPROVE'
    builder_id = 'codex-implementation'
    diff_numstat_digest = $expectedDigest
  }
  $validResult = Test-AgentAutonomousReviewEvidence -Evidence $validEvidence -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest
  Assert-ClosureGate ([bool]$validResult.valid) 'well-formed evidence must remain valid'

  $evidenceCases = @(
    @{ Name = 'null evidence'; Value = $null; Error = 'autonomous_evidence_malformed' }
    @{ Name = 'empty object'; Value = [pscustomobject]@{}; Error = 'autonomous_evidence_schema_version_invalid' }
    @{ Name = 'unsupported schema'; Value = [pscustomobject]@{ schema_version = 2 }; Error = 'autonomous_evidence_schema_version_invalid' }
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

  $emptyReceipt = Test-AgentIndependentReviewReceipt -Receipt ([pscustomobject]@{}) -Repository 'gthgomez/Babel' -PR 152 -BaseSha $base -HeadSha $head -BuilderIdentity 'codex-implementation'
  Assert-ClosureGate (-not [bool]$emptyReceipt.valid) 'empty receipt must be rejected'
  Assert-ClosureGate (@($emptyReceipt.errors) -contains 'receipt_schema_version_invalid') 'empty receipt must return validation errors rather than throw'

  Write-Output 'agent-pr-gate-closure: PASS'
  exit 0
} catch {
  Write-Error $_
  exit 1
}
