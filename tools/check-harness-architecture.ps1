<#
.SYNOPSIS
  Detect harness architecture package drift (harness-v1).

.DESCRIPTION
  Validates that the canonical harness architecture package remains coherent:
  normative spec, ADR, overview, golden fixtures, conformance tests, and
  startup document pointers. Does not run the full unit suite.

.PARAMETER RepoRoot
  Repository root (default: parent of tools/).

.PARAMETER OutputFormat
  human | json
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateSet('human', 'json')]
  [string]$OutputFormat = 'human'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$failures = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

function Add-Fail([string]$Message) { [void]$failures.Add($Message) }
function Add-Warn([string]$Message) { [void]$warnings.Add($Message) }

function Test-RepoFile([string]$RelativePath) {
  $full = Join-Path $RepoRoot ($RelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
  return (Test-Path -LiteralPath $full -PathType Leaf)
}

function Get-RepoText([string]$RelativePath) {
  $full = Join-Path $RepoRoot ($RelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
  return Get-Content -LiteralPath $full -Raw -ErrorAction Stop
}

# ── Required files ──────────────────────────────────────────────────────────
$required = @(
  'docs/architecture/HARNESS_ARCHITECTURE_V1.md',
  'docs/architecture/HARNESS_OVERVIEW.md',
  'docs/adr/ADR-012-canonical-harness-architecture-v1.md',
  'babel-cli/CLAUDE.md',
  'babel-cli/src/executor/architectureConformance.test.ts',
  'babel-cli/src/executor/contracts.ts',
  'babel-cli/src/executor/kernel.ts',
  'examples/golden-harness/README.md',
  'examples/golden-harness/fixture/task-contract.json',
  'examples/golden-harness/fixture/expected-events.jsonl',
  'examples/golden-harness/fixture/completion-decision.json',
  'examples/golden-harness/fixture/verifier-receipt.json',
  'examples/golden-harness/fixture/final-workspace-revision.json',
  'examples/golden-harness/fixture/initial-workspace.json',
  'examples/golden-harness/fixture/expected-patch.diff',
  'examples/golden-harness/negative/plan-mutation-denied.json',
  'examples/golden-harness/negative/stale-verifier-receipt.json',
  'examples/golden-harness/negative/narrow-verifier-vs-broad-required.json',
  'examples/golden-harness/negative/isolation-unavailable.json',
  'tools/check-harness-architecture.ps1'
)

foreach ($rel in $required) {
  if (-not (Test-RepoFile $rel)) { Add-Fail "Missing required file: $rel" }
}

# ── Spec metadata ───────────────────────────────────────────────────────────
if (Test-RepoFile 'docs/architecture/HARNESS_ARCHITECTURE_V1.md') {
  $spec = Get-RepoText 'docs/architecture/HARNESS_ARCHITECTURE_V1.md'
  if ($spec -notmatch 'authority:\s*normative') {
    Add-Fail 'HARNESS_ARCHITECTURE_V1.md missing authority: normative'
  }
  if ($spec -notmatch 'architecture_version:\s*harness-v1') {
    Add-Fail 'HARNESS_ARCHITECTURE_V1.md missing architecture_version: harness-v1'
  }
  if ($spec -notmatch 'status:\s*CANONICAL') {
    Add-Fail 'HARNESS_ARCHITECTURE_V1.md missing status: CANONICAL'
  }
}

# ── Single normative authority claim ────────────────────────────────────────
$archDir = Join-Path $RepoRoot 'docs/architecture'
if (Test-Path -LiteralPath $archDir) {
  Get-ChildItem -LiteralPath $archDir -Filter '*.md' | ForEach-Object {
    if ($_.Name -eq 'HARNESS_ARCHITECTURE_V1.md') { return }
    $text = Get-Content -LiteralPath $_.FullName -Raw
    if ($text -match '(?m)^authority:\s*normative\s*$') {
      Add-Fail "Non-canonical file claims authority: normative → docs/architecture/$($_.Name)"
    }
    if ($text -match 'primary (?:or )?canonical harness specification' -and $text -notmatch 'MUST NOT claim|must not claim|not the primary') {
      # Soft: overview may discuss the concept; only warn
      Add-Warn "Possible competing authority language in docs/architecture/$($_.Name)"
    }
  }
}

# ── Overview must defer ─────────────────────────────────────────────────────
if (Test-RepoFile 'docs/architecture/HARNESS_OVERVIEW.md') {
  $overview = Get-RepoText 'docs/architecture/HARNESS_OVERVIEW.md'
  if ($overview -notmatch 'HARNESS_ARCHITECTURE_V1') {
    Add-Fail 'HARNESS_OVERVIEW.md must reference HARNESS_ARCHITECTURE_V1.md'
  }
  if ($overview -notmatch 'explanatory') {
    Add-Fail 'HARNESS_OVERVIEW.md must state it is explanatory'
  }
}

# ── Index links ─────────────────────────────────────────────────────────────
foreach ($indexRel in @('docs/architecture/README.md', 'docs/README.md')) {
  if (-not (Test-RepoFile $indexRel)) {
    Add-Fail "Missing index: $indexRel"
    continue
  }
  $idx = Get-RepoText $indexRel
  if ($idx -notmatch 'HARNESS_ARCHITECTURE_V1') {
    Add-Fail "$indexRel must link HARNESS_ARCHITECTURE_V1"
  }
}

# ── Startup pointers ────────────────────────────────────────────────────────
foreach ($startRel in @('CLAUDE.md', 'babel-cli/CLAUDE.md', 'babel-cli/PROJECT_CONTEXT.md', 'babel-cli/AGENTS.md')) {
  if (-not (Test-RepoFile $startRel)) {
    Add-Fail "Missing startup file: $startRel"
    continue
  }
  $text = Get-RepoText $startRel
  if ($text -notmatch 'HARNESS_ARCHITECTURE_V1') {
    Add-Fail "$startRel must reference HARNESS_ARCHITECTURE_V1"
  }
}

# Root CLAUDE historically claimed babel-cli/CLAUDE.md — ensure it exists
if (-not (Test-RepoFile 'babel-cli/CLAUDE.md')) {
  Add-Fail 'babel-cli/CLAUDE.md missing (root CLAUDE.md package authority)'
}

# ── Source map ──────────────────────────────────────────────────────────────
$sourceMap = @(
  'babel-cli/src/agent/chatEngine.ts',
  'babel-cli/src/agent/completionGatePolicy.ts',
  'babel-cli/src/executor/kernel.ts',
  'babel-cli/src/executor/contracts.ts',
  'babel-cli/src/pipeline.ts',
  'babel-cli/src/sandbox.ts',
  'babel-cli/src/schemas/agentContracts.ts'
)
foreach ($rel in $sourceMap) {
  if (-not (Test-RepoFile $rel)) { Add-Fail "Source map path missing: $rel" }
}

# ── Conformance test registration ───────────────────────────────────────────
if (Test-RepoFile 'babel-cli/package.json') {
  $pkg = Get-RepoText 'babel-cli/package.json'
  if ($pkg -notmatch 'src/executor/\*\.test\.ts' -and $pkg -notmatch 'architectureConformance') {
    # test:unit must include executor tests for conformance to run in npm test
    if ($pkg -notmatch 'src/executor') {
      Add-Fail 'babel-cli/package.json test:unit does not include src/executor tests'
    }
  }
}

# ── Mode policy consistency (doc vs code tokens) ────────────────────────────
if (Test-RepoFile 'docs/architecture/HARNESS_ARCHITECTURE_V1.md') {
  $spec = Get-RepoText 'docs/architecture/HARNESS_ARCHITECTURE_V1.md'
  foreach ($token in @('read_only', 'governed', 'plan_artifact', 'proof_carrying', 'VERIFIED_COMPLETE')) {
    if ($spec -notmatch [regex]::Escape($token)) {
      Add-Warn "Spec may be missing expected token: $token"
    }
  }
}

# ── Architecture version on golden fixtures ─────────────────────────────────
$goldenJson = @(
  'examples/golden-harness/fixture/task-contract.json',
  'examples/golden-harness/fixture/completion-decision.json'
)
foreach ($rel in $goldenJson) {
  if (-not (Test-RepoFile $rel)) { continue }
  $j = Get-RepoText $rel
  if ($j -notmatch 'harness-v1') {
    Add-Fail "$rel missing architecture_version harness-v1"
  }
}

# ── Report ──────────────────────────────────────────────────────────────────
$result = [ordered]@{
  ok           = ($failures.Count -eq 0)
  failureCount = $failures.Count
  warningCount = $warnings.Count
  failures     = @($failures)
  warnings     = @($warnings)
  architecture_version = 'harness-v1'
  checker      = 'tools/check-harness-architecture.ps1'
}

if ($OutputFormat -eq 'json') {
  $result | ConvertTo-Json -Depth 5
} else {
  Write-Host "Harness architecture check (harness-v1)"
  Write-Host "RepoRoot: $RepoRoot"
  if ($failures.Count -eq 0) {
    Write-Host "PASS ($($warnings.Count) warning(s))"
  } else {
    Write-Host "FAIL ($($failures.Count) failure(s), $($warnings.Count) warning(s))"
  }
  foreach ($f in $failures) { Write-Host "  ERROR: $f" }
  foreach ($w in $warnings) { Write-Host "  WARN:  $w" }
}

if ($failures.Count -gt 0) { exit 1 }
exit 0
