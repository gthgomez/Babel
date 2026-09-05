# Regression matrix for the trusted-control-plane review-evidence path.
#
# Every untrusted or incomplete evidence shape must produce a deterministic
# fail-closed result from Test-AgentAutonomousReviewEvidence and the evidence
# transport-stub detector — never an unhandled strict-mode exception
# (the pre-fix failure mode was pr_gate_exception on missing evidence).
#
# Runs on any host with PowerShell 7; no repository state required.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[System.Globalization.CultureInfo]::CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
$modulePath = Join-Path $repoRoot 'scripts/agent-pr-gate-common.psm1'
Import-Module $modulePath -Force

$script:failures = @()

function Assert-EvidenceCase {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][AllowNull()][object]$Evidence,
    [AllowNull()][string[]]$ExpectErrors = @(),
    # When $true the case must validate; when $false it must fail closed.
    [switch]$ExpectValid
  )
  $threw = $null
  try {
    $result = Test-AgentAutonomousReviewEvidence -Evidence $Evidence `
      -Repository 'gthgomez/Babel' -PR 142 `
      -BaseSha '1111111111111111111111111111111111111111' `
      -HeadSha '2222222222222222222222222222222222222222' `
      -BuilderIdentity 'codex-implementation' `
      -ExpectedNumstatDigest 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    if ($ExpectValid) {
      if (-not [bool]$result.valid) { $threw = "expected valid, got errors: $($result.errors -join ';')" }
    } else {
      if ([bool]$result.valid) { $threw = 'expected fail-closed but evidence validated' }
      foreach ($expected in $ExpectErrors) {
        if (@($result.errors) -notcontains $expected) { $threw = "missing expected error '$expected'; got: $($result.errors -join ';')"; break }
      }
    }
  } catch {
    $threw = "UNHANDLED EXCEPTION (regression of the strict-mode crash): $($_.Exception.GetType().FullName): $($_.Exception.Message)"
  }
  if ($null -ne $threw) {
    $script:failures += "$Name => $threw"
    Write-Output "FAIL $Name"
  } else {
    Write-Output "ok $Name"
  }
}

function New-ValidEvidence {
  $doc = [ordered]@{
    schema_version = '1'
    kind = 'autonomous_review_evidence_v1'
    repository = 'gthgomez/Babel'
    pr_number = 142
    base_sha = '1111111111111111111111111111111111111111'
    head_sha = '2222222222222222222222222222222222222222'
    reviewer_id = 'isolated-readonly-reviewer-a'
    reviewer_class = 'isolated_readonly_ai_reviewer'
    review_mode = 'diff_audit'
    reviewed_at = '2026-09-05T06:00:00.000Z'
    scope = @('some/file.ts')
    findings = @('no blocking findings')
    blocking_findings = @()
    verdict = 'APPROVE'
    builder_id = 'codex-implementation'
    diff_numstat_digest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }
  return [pscustomobject]$doc
}

function ConvertFrom-JsonText {
  param([Parameter(Mandatory = $true)][string]$Text)
  return $Text | ConvertFrom-Json
}

# ── Deterministic pass path ───────────────────────────────────────────────────
Assert-EvidenceCase -Name 'valid AUTONOMOUS ordinary review validates' -Evidence (New-ValidEvidence) -ExpectValid

# ── Missing / shape-broken evidence: fail closed, never throw ────────────────
Assert-EvidenceCase -Name 'no evidence (null)' -Evidence $null -ExpectErrors @('autonomous_evidence_malformed', 'autonomous_evidence_schema_version_invalid')
Assert-EvidenceCase -Name 'empty object {}' -Evidence (ConvertFrom-JsonText '{}') -ExpectErrors @('autonomous_evidence_schema_version_invalid', 'autonomous_evidence_kind_invalid', 'autonomous_evidence_reviewer_not_independent_from_builder')
Assert-EvidenceCase -Name 'missing schema_version' -Evidence (ConvertFrom-JsonText '{"kind":"autonomous_review_evidence_v1"}') -ExpectErrors @('autonomous_evidence_schema_version_invalid')
Assert-EvidenceCase -Name 'unsupported schema_version' -Evidence (ConvertFrom-JsonText '{"schema_version":2,"kind":"autonomous_review_evidence_v1"}') -ExpectErrors @('autonomous_evidence_schema_version_invalid')
Assert-EvidenceCase -Name 'JSON string document' -Evidence (ConvertFrom-JsonText '"just a string"') -ExpectErrors @('autonomous_evidence_malformed')
Assert-EvidenceCase -Name 'JSON array document' -Evidence (ConvertFrom-JsonText '[1,2,3]') -ExpectErrors @('autonomous_evidence_malformed')
Assert-EvidenceCase -Name 'JSON null document' -Evidence (ConvertFrom-JsonText 'null') -ExpectErrors @('autonomous_evidence_malformed')

# ── Binding mismatches: exact repository/PR/base/head/digest ─────────────────
$mismatch = New-ValidEvidence; $mismatch.repository = 'other/repo'
Assert-EvidenceCase -Name 'wrong repository' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_repository_mismatch')
$mismatch = New-ValidEvidence; $mismatch.pr_number = 999
Assert-EvidenceCase -Name 'wrong PR' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_pr_mismatch')
$mismatch = New-ValidEvidence; $mismatch.base_sha = '3333333333333333333333333333333333333333'
Assert-EvidenceCase -Name 'wrong base SHA' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_base_mismatch')
$mismatch = New-ValidEvidence; $mismatch.head_sha = '4444444444444444444444444444444444444444'
Assert-EvidenceCase -Name 'wrong head SHA' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_head_mismatch')
$mismatch = New-ValidEvidence; $mismatch.diff_numstat_digest = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
Assert-EvidenceCase -Name 'wrong diff numstat digest' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_diff_numstat_digest_mismatch')

# ── Authority and verdict constraints ────────────────────────────────────────
$mismatch = New-ValidEvidence; $mismatch.reviewer_id = 'codex-implementation'
Assert-EvidenceCase -Name 'builder == reviewer' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_reviewer_not_independent_from_builder')
$mismatch = New-ValidEvidence; $mismatch.blocking_findings = @('something must change')
Assert-EvidenceCase -Name 'blocking findings present' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_has_blocking_findings')
$mismatch = New-ValidEvidence; $mismatch.verdict = 'REQUEST_CHANGES'
Assert-EvidenceCase -Name 'non-APPROVE verdict' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_not_approved')
$mismatch = New-ValidEvidence; $mismatch.scope = @()
Assert-EvidenceCase -Name 'empty scope' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_scope_empty')
$mismatch = New-ValidEvidence; $mismatch.reviewed_at = 'not-a-timestamp'
Assert-EvidenceCase -Name 'malformed reviewed_at' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_reviewed_at_invalid')
$mismatch = New-ValidEvidence
$mismatch | Add-Member -NotePropertyName 'unauthorized_field' -NotePropertyValue 'injected'
Assert-EvidenceCase -Name 'unknown field rejected' -Evidence $mismatch -ExpectErrors @('autonomous_evidence_unknown_field:unauthorized_field')

# ── Transport-error stub detection (missing evidence comment path) ───────────
$stubMissing = ConvertFrom-JsonText '{"transport_error":"autonomous-review_handoff_missing","repository":"gthgomez/Babel","pr_number":142,"base_sha":"1111111111111111111111111111111111111111","head_sha":"2222222222222222222222222222222222222222","bound_documents_observed":0,"distinct_documents_observed":0}'
$stubAmbiguous = ConvertFrom-JsonText '{"transport_error":"autonomous-review_handoff_ambiguous","bound_documents_observed":2,"distinct_documents_observed":2}'
try {
  $ok = $true
  if ((Test-AgentEvidenceTransportStub -Document $stubMissing) -ne 'missing') { $ok = $false; $script:failures += 'stub missing not detected' }
  if ((Test-AgentEvidenceTransportStub -Document $stubAmbiguous) -ne 'ambiguous') { $ok = $false; $script:failures += 'stub ambiguous not detected' }
  if ($null -ne (Test-AgentEvidenceTransportStub -Document (New-ValidEvidence))) { $ok = $false; $script:failures += 'valid evidence misdetected as stub' }
  if ($null -ne (Test-AgentEvidenceTransportStub -Document $null)) { $ok = $false; $script:failures += 'null misdetected as stub' }
  if ($ok) { Write-Output 'ok transport stub detection maps missing/ambiguous and ignores real evidence' }
} catch {
  $script:failures += "transport stub detection threw: $($_.Exception.Message)"
  Write-Output 'FAIL transport stub detection'
}

# The stub document itself must also fail closed if it ever reaches the
# validator (defense in depth: the reader maps it first).
Assert-EvidenceCase -Name 'transport stub document fails validation' -Evidence $stubMissing -ExpectErrors @('autonomous_evidence_schema_version_invalid', 'autonomous_evidence_kind_invalid')

if ($script:failures.Count -gt 0) {
  Write-Output ''
  Write-Output "EVIDENCE_REGRESSION_MATRIX_FAIL ($($script:failures.Count) failure(s)):"
  foreach ($failure in $script:failures) { Write-Output "  - $failure" }
  exit 1
}
Write-Output ''
Write-Output 'EVIDENCE_REGRESSION_MATRIX_PASS'
