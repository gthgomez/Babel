Set-StrictMode -Version Latest

function New-MergeAuditApplicability {
  param(
    [Parameter(Mandatory = $true)][ValidateSet('ELIGIBLE', 'NOT_APPLICABLE', 'SUPERSEDED', 'UNKNOWN')]
    [string]$State,
    [Parameter(Mandatory = $true)][string]$Reason,
    [Nullable[int]]$PrNumber = $null,
    [string]$HeadSha = '',
    [string]$BaseSha = '',
    [bool]$AuditExecuted = $false
  )
  return [pscustomobject][ordered]@{
    state = $State
    reason = $Reason
    prNumber = $PrNumber
    headSha = $HeadSha
    baseSha = $BaseSha
    auditExecuted = $AuditExecuted
  }
}

function Resolve-MergeAuditReleaseGateAssociation {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$PullRequests,
    [Parameter(Mandatory = $true)][string]$HeadSha,
    [Parameter(Mandatory = $true)][string]$Repository,
    [AllowNull()][object]$ApiError = $null
  )
  if ($null -ne $ApiError) {
    return New-MergeAuditApplicability -State UNKNOWN -Reason 'association_read_failed' -HeadSha $HeadSha
  }
  if ($HeadSha -notmatch '^[0-9a-f]{40}$') {
    return New-MergeAuditApplicability -State UNKNOWN -Reason 'release_gate_head_malformed' -HeadSha $HeadSha
  }
  $candidates = @($PullRequests | Where-Object {
      $null -ne $_ -and
      [string]$_.state -eq 'open' -and
      [string]$_.base.ref -eq 'main' -and
      [string]::Equals([string]$_.head.sha, $HeadSha, [StringComparison]::Ordinal) -and
      [string]::Equals([string]$_.head.repo.full_name, $Repository, [StringComparison]::Ordinal)
    })
  if ($candidates.Count -eq 0) {
    return New-MergeAuditApplicability -State NOT_APPLICABLE -Reason 'no_exact_open_main_pull_request' -HeadSha $HeadSha
  }
  if ($candidates.Count -gt 1) {
    return New-MergeAuditApplicability -State UNKNOWN -Reason 'ambiguous_exact_head_association' -HeadSha $HeadSha
  }
  $pr = $candidates[0]
  $number = if ($null -ne $pr.number) { [int]$pr.number } else { $null }
  if ($pr.PSObject.Properties['draft'] -and [bool]$pr.draft) {
    return New-MergeAuditApplicability -State NOT_APPLICABLE -Reason 'pr_is_draft' -PrNumber $number -HeadSha $HeadSha -BaseSha ([string]$pr.base.sha)
  }
  if ([string]$pr.head.sha -ne $HeadSha) {
    return New-MergeAuditApplicability -State SUPERSEDED -Reason 'pr_head_advanced_past_release_gate' -PrNumber $number -HeadSha $HeadSha -BaseSha ([string]$pr.base.sha)
  }
  if ([string]$pr.state -ne 'open') {
    return New-MergeAuditApplicability -State NOT_APPLICABLE -Reason 'pr_not_open' -PrNumber $number -HeadSha $HeadSha -BaseSha ([string]$pr.base.sha)
  }
  return New-MergeAuditApplicability -State ELIGIBLE -Reason 'exact_head_open_main_candidate' -PrNumber $number -HeadSha $HeadSha -BaseSha ([string]$pr.base.sha)
}

function Write-MergeAuditApplicabilityOutputs {
  param(
    [Parameter(Mandatory = $true)][object]$Applicability,
    [string]$SummaryPath = $env:GITHUB_STEP_SUMMARY,
    [string]$OutputPath = $env:GITHUB_OUTPUT
  )
  $note = "Merge audit applicability: state=$($Applicability.state); reason=$($Applicability.reason); auditExecuted=$($Applicability.auditExecuted.ToString().ToLowerInvariant())"
  if (-not [string]::IsNullOrWhiteSpace($SummaryPath)) { Add-Content -LiteralPath $SummaryPath -Value $note }
  Write-Output $note
  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    Add-Content -LiteralPath $OutputPath -Value "state=$($Applicability.state)"
    Add-Content -LiteralPath $OutputPath -Value "reason=$($Applicability.reason)"
    Add-Content -LiteralPath $OutputPath -Value "audit_executed=$($Applicability.auditExecuted.ToString().ToLowerInvariant())"
    if ($null -ne $Applicability.prNumber) { Add-Content -LiteralPath $OutputPath -Value "number=$($Applicability.prNumber)" }
    if (-not [string]::IsNullOrWhiteSpace([string]$Applicability.headSha)) { Add-Content -LiteralPath $OutputPath -Value "head_sha=$($Applicability.headSha)" }
    if (-not [string]::IsNullOrWhiteSpace([string]$Applicability.baseSha)) { Add-Content -LiteralPath $OutputPath -Value "base_sha=$($Applicability.baseSha)" }
  }
}

function Test-MergeAuditShouldRun {
  param([Parameter(Mandatory = $true)][object]$Applicability)
  return [string]$Applicability.state -eq 'ELIGIBLE'
}

function Test-MergeAuditTransportFailure {
  param([Parameter(Mandatory = $true)][object]$Applicability)
  return [string]$Applicability.state -eq 'UNKNOWN'
}

Export-ModuleMember -Function @(
  'New-MergeAuditApplicability',
  'Resolve-MergeAuditReleaseGateAssociation',
  'Write-MergeAuditApplicabilityOutputs',
  'Test-MergeAuditShouldRun',
  'Test-MergeAuditTransportFailure'
)
