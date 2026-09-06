#!/usr/bin/env pwsh
# Regression suite for scripts/agent-pr-evidence.ps1.
#
# Hermetic: no gh calls, no network. Builds a fixture git repository, drives
# the tool through its offline build/validate path (-WhatIfOnly), and checks
# the produced evidence against the merge gate's own module — the same
# validator and numstat-digest function the trusted-control-plane gate runs.
# Negative cases assert the tool fails closed before any transport.

[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:passed = 0
$script:failed = 0

function Assert-AgentEvidence {
  param([string]$Name, [bool]$Condition, [string]$Detail = '')
  if ($Condition) {
    $script:passed++
    Write-Output "ok - $Name"
  } else {
    $script:failed++
    Write-Output "NOT OK - $Name $Detail"
  }
}

$tool = Join-Path $RepoRoot 'scripts/agent-pr-evidence.ps1'
$gateModule = Join-Path $RepoRoot 'scripts/agent-pr-gate-common.psm1'
Assert-AgentEvidence 'tool script exists' (Test-Path $tool)
Assert-AgentEvidence 'gate module exists' (Test-Path $gateModule)

Import-Module $gateModule -Force -DisableNameChecking

# --- Fixture repository ------------------------------------------------------

$fixture = Join-Path ([IO.Path]::GetTempPath()) ("agent-pr-evidence-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  & git -C $fixture init -q -b main
  & git -C $fixture config user.email 'test@example.invalid'
  & git -C $fixture config user.name 'Evidence Test'
  Set-Content -LiteralPath (Join-Path $fixture 'a.txt') -Value "alpha`n" -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $fixture 'b.txt') -Value "bravo`n" -Encoding utf8NoBOM
  & git -C $fixture add .
  & git -C $fixture commit -q -m 'base'
  $baseSha = [string](& git -C $fixture rev-parse HEAD)

  Set-Content -LiteralPath (Join-Path $fixture 'a.txt') -Value "alpha changed`n" -Encoding utf8NoBOM
  Set-Content -LiteralPath (Join-Path $fixture 'c.txt') -Value "charlie`n" -Encoding utf8NoBOM
  & git -C $fixture add .
  & git -C $fixture commit -q -m 'head 1'
  $head1 = [string](& git -C $fixture rev-parse HEAD)

  Set-Content -LiteralPath (Join-Path $fixture 'b.txt') -Value "bravo changed`n" -Encoding utf8NoBOM
  & git -C $fixture add .
  & git -C $fixture commit -q -m 'head 2'
  $head2 = [string](& git -C $fixture rev-parse HEAD)

  # --- Happy path: build + gate-identical validation -------------------------

  $outFile = Join-Path $fixture 'evidence-body.txt'
  $output = & pwsh -NoProfile -File $tool `
    -PR 42 -ReviewerId 'isolated-reviewer-test' -Repository 'test/fixture' `
    -BaseSha $baseSha -HeadSha $head1 -RepoRoot $fixture `
    -Scope @('Fixture diff for evidence tool test') -Findings @('none') `
    -WhatIfOnly -OutFile $outFile 2>&1
  $exitOk = ($LASTEXITCODE -eq 0)
  Assert-AgentEvidence 'what-if build exits 0' $exitOk ($output | Out-String)

  $result = (($output | Out-String) | ConvertFrom-Json)
  Assert-AgentEvidence 'what-if result ok' ([bool]$result.ok)
  Assert-AgentEvidence 'what-if does not post' (-not [bool]$result.posted)
  Assert-AgentEvidence 'digest reported' ($result.diff_numstat_digest -match '^[0-9a-f]{64}$')

  $body = Get-Content -LiteralPath $outFile -Raw
  $marker = '<!-- babel-autonomous-review-evidence-v1 -->'
  Assert-AgentEvidence 'body carries transport marker' ($body.StartsWith($marker))
  $jsonText = $body.Substring($marker.Length).Trim()
  $doc = $jsonText | ConvertFrom-Json
  Assert-AgentEvidence 'schema_version pinned' ([string]$doc.schema_version -eq '1')
  Assert-AgentEvidence 'kind pinned' ([string]$doc.kind -eq 'autonomous_review_evidence_v1')
  Assert-AgentEvidence 'repository bound' ([string]$doc.repository -eq 'test/fixture')
  Assert-AgentEvidence 'pr bound' ([string]$doc.pr_number -eq '42')
  Assert-AgentEvidence 'base bound' ([string]$doc.base_sha -eq $baseSha)
  Assert-AgentEvidence 'head bound' ([string]$doc.head_sha -eq $head1)
  Assert-AgentEvidence 'blocking findings empty' (@($doc.blocking_findings).Count -eq 0)
  Assert-AgentEvidence 'verdict approve' ([string]$doc.verdict -eq 'APPROVE')

  # Gate-identical oracle: same module call the base-rooted gate performs.
  $numstat = @(& git -C $fixture diff --numstat "$baseSha...$head1")
  $expectedDigest = Get-AgentNumstatDigest -NumstatLines $numstat
  Assert-AgentEvidence 'numstat digest parity with gate module' ([string]$doc.diff_numstat_digest -eq $expectedDigest)

  $gateValidation = Test-AgentAutonomousReviewEvidence -Evidence $doc -Repository 'test/fixture' -PR 42 `
    -BaseSha $baseSha -HeadSha $head1 -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $expectedDigest
  Assert-AgentEvidence 'gate validator accepts built evidence' ([bool]$gateValidation.valid) (@($gateValidation.errors) -join ',')

  # --- Binding sensitivity: digest changes with the diff ---------------------

  $outFile2 = Join-Path $fixture 'evidence-body-2.txt'
  & pwsh -NoProfile -File $tool `
    -PR 42 -ReviewerId 'isolated-reviewer-test' -Repository 'test/fixture' `
    -BaseSha $baseSha -HeadSha $head2 -RepoRoot $fixture `
    -Scope @('Fixture diff 2') -WhatIfOnly -OutFile $outFile2 2>&1 | Out-Null
  $doc2 = ((Get-Content -LiteralPath $outFile2 -Raw).Substring($marker.Length).Trim() | ConvertFrom-Json)
  Assert-AgentEvidence 'digest binds to exact diff' ([string]$doc2.diff_numstat_digest -ne [string]$doc.diff_numstat_digest)
  Assert-AgentEvidence 'head rebinds' ([string]$doc2.head_sha -eq $head2)

  $staleDigest = Get-AgentNumstatDigest -NumstatLines @(& git -C $fixture diff --numstat "$baseSha...$head2")
  $staleValidation = Test-AgentAutonomousReviewEvidence -Evidence $doc -Repository 'test/fixture' -PR 42 `
    -BaseSha $baseSha -HeadSha $head1 -BuilderIdentity 'codex-implementation' -ExpectedNumstatDigest $staleDigest
  Assert-AgentEvidence 'stale digest rejected by gate validator' (-not [bool]$staleValidation.valid)

  # --- Negative paths: fail closed before transport --------------------------

  $negOut = Join-Path $fixture 'neg.txt'
  $run = & pwsh -NoProfile -File $tool -PR 42 -ReviewerId 'isolated-reviewer-test' -Repository 'test/fixture' `
    -BaseSha $baseSha -HeadSha $head1 -RepoRoot $fixture -Scope @('x') `
    -BlockingFindings @('something real') -WhatIfOnly -OutFile $negOut 2>&1
  Assert-AgentEvidence 'blocking findings refuse transport' ($LASTEXITCODE -ne 0)
  Assert-AgentEvidence 'blocking-findings refusal mentions cause' (((($run | Out-String)) -match 'blocking_findings_must_be_empty'))
  Assert-AgentEvidence 'refusal wrote no body file' (-not (Test-Path $negOut))

  $run = & pwsh -NoProfile -File $tool -PR 42 -ReviewerId 'codex-implementation' -Repository 'test/fixture' `
    -BaseSha $baseSha -HeadSha $head1 -RepoRoot $fixture -Scope @('x') -WhatIfOnly 2>&1
  Assert-AgentEvidence 'builder-as-reviewer refuses' ($LASTEXITCODE -ne 0)
  Assert-AgentEvidence 'independence refusal mentions cause' (((($run | Out-String)) -match 'reviewer_must_differ_from_builder_identity'))

  $run = & pwsh -NoProfile -File $tool -PR 42 -ReviewerId 'isolated-reviewer-test' -Repository 'test/fixture' `
    -BaseSha $baseSha -HeadSha $head1 -RepoRoot $fixture -Scope @('   ') -WhatIfOnly 2>&1
  Assert-AgentEvidence 'empty scope refuses' ($LASTEXITCODE -ne 0)

  $run = & pwsh -NoProfile -File $tool -PR 42 -ReviewerId 'isolated-reviewer-test' -Repository 'test/fixture' `
    -BaseSha $baseSha -HeadSha $head1 -RepoRoot $fixture -Scope @('x') -Verdict 'REQUEST_CHANGES' -WhatIfOnly 2>&1
  Assert-AgentEvidence 'non-approve verdict rejected by parameter validation' ($LASTEXITCODE -ne 0)
} finally {
  # .git object files are read-only on Windows; best-effort cleanup is fine —
  # the fixture lives under the OS temp directory either way.
  try {
    & attrib -R (Join-Path $fixture '*') /S /D 2>$null
    Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
  } catch { }
}

Write-Output ''
Write-Output "agent-pr-evidence suite: $script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
exit 0
