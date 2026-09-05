# Canonical ordering parity test: PowerShell side (campaign Phase 30).
#
# Verifies Get-AgentCanonicalSortedUtf8 in scripts/agent-pr-gate-common.psm1
# against the shared fixture tools/tests/fixtures/canonical-ordering-vectors.json.
# The Node twin is tools/tests/test-canonical-ordering.mjs; both must agree so
# protected-diff and numstat digests stay byte-identical across the gate and
# ceremony tooling.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[System.Globalization.CultureInfo]::CurrentCulture = [System.Globalization.CultureInfo]::InvariantCulture

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath))
Import-Module (Join-Path $repoRoot 'scripts/agent-pr-gate-common.psm1') -Force

$fixturePath = Join-Path $PSScriptRoot 'fixtures/canonical-ordering-vectors.json'
$fixture = Get-Content -Raw -LiteralPath $fixturePath | ConvertFrom-Json
if ([string]$fixture.kind -ne 'babel_canonical_ordering_vectors_v1') { throw 'Fixture kind invalid' }

$failures = @()
foreach ($case in @($fixture.cases)) {
  $inputValues = @($case.input | ForEach-Object { [string]$_ })
  $expectedValues = @($case.expected | ForEach-Object { [string]$_ })
  # Plain assignment unwraps the single-element collection emitted by the
  # comma-protected return, yielding the sorted array itself.
  $actual = Get-AgentCanonicalSortedUtf8 -Values $inputValues
  $expectedJson = $expectedValues -join '|'
  $actualJson = $actual -join '|'
  if ($expectedJson -cne $actualJson) {
    $failures += "$($case.name): expected [$expectedJson], got [$actualJson]"
    Write-Output "FAIL $($case.name)"
  } else {
    Write-Output "ok $($case.name)"
  }
}

# The digest functions themselves must not use culture-sensitive Sort-Object:
# extract each function body and inspect only those.
$common = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts/agent-pr-gate-common.psm1')
$gate = Get-Content -Raw -LiteralPath (Join-Path $repoRoot 'scripts/agent-pr-gate.ps1')
function Test-FunctionBodyFreeOfSortObject {
  param([Parameter(Mandatory = $true)][string]$Text, [Parameter(Mandatory = $true)][string]$FunctionName, [Parameter(Mandatory = $true)][string]$Label)
  $start = $Text.IndexOf("function $FunctionName", [StringComparison]::Ordinal)
  if ($start -lt 0) { return "digest function not found: $FunctionName" }
  $next = $Text.IndexOf("`nfunction ", $start + 1)
  $end = if ($next -gt 0) { $next } else { $Text.Length }
  $body = $Text.Substring($start, $end - $start)
  if ($body -match 'Sort-Object') { return "$Label uses culture-sensitive Sort-Object in $FunctionName" }
  if ($body -notmatch 'Get-AgentCanonicalSortedUtf8') { return "$Label does not use canonical ordering in $FunctionName" }
  return $null
}
foreach ($pair in @(@('common', $common), @('gate', $gate))) {
  foreach ($functionName in @('Get-AgentNumstatDigest', 'Get-AgentProtectedDiffDigest')) {
    $problem = Test-FunctionBodyFreeOfSortObject -Text $pair[1] -FunctionName $functionName -Label $pair[0]
    # Get-AgentNumstatDigest lives in the common module only; a not-found there
    # for the gate is expected and must not be reported as a failure.
    if ($null -ne $problem -and $problem -notmatch 'not found: Get-AgentProtectedDiffDigest' -and $problem -notmatch 'not found: Get-AgentNumstatDigest') {
      $failures += $problem
      Write-Output "FAIL $problem"
    } elseif ($null -eq $problem) {
      Write-Output "ok $($pair[0])/$functionName canonical"
    }
  }
}

if ($failures.Count -gt 0) {
  Write-Output ''
  Write-Output "CANONICAL_ORDERING_TEST_FAIL ($($failures.Count) failure(s)):"
  foreach ($failure in $failures) { Write-Output "  - $failure" }
  exit 1
}
Write-Output ''
Write-Output 'CANONICAL_ORDERING_TEST_PASS'
