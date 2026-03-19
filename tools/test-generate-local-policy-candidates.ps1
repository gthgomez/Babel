[CmdletBinding()]
param(
    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

$normalizerPath = Join-Path $Root "tools\normalize-local-evidence.ps1"
$generatorPath = Join-Path $Root "tools\generate-local-policy-candidates.ps1"
$runFixtureRoot = Join-Path $Root "tests\fixtures\normalize-local-evidence\runs"
$sessionFixturePath = Join-Path $Root "tests\fixtures\local-learning\session-log.fixture.jsonl"
$comparisonFixturePath = Join-Path $Root "tests\fixtures\comparison-workflow\comparison-cases.json"
$policyFixturePath = Join-Path $Root "tests\fixtures\policy-candidates\normalized-events.fixture.jsonl"
$tempDir = Join-Path $Root "runs\local-learning-test\generate-local-policy-candidates"
$integrationNormalizedPath = Join-Path $tempDir "integration-normalized-events.jsonl"
$integrationCandidatesPath = Join-Path $tempDir "integration-policy-candidates.json"
$integrationAuditPath = Join-Path $tempDir "integration-policy-audit.jsonl"
$fixtureCandidatesPath = Join-Path $tempDir "fixture-policy-candidates.json"
$fixtureAuditPath = Join-Path $tempDir "fixture-policy-audit.jsonl"

foreach ($requiredPath in @($normalizerPath, $generatorPath, $runFixtureRoot, $sessionFixturePath, $comparisonFixturePath, $policyFixturePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required test input not found: $requiredPath"
    }
}

if (Test-Path -LiteralPath $tempDir) {
    Remove-Item -LiteralPath $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

$normalizeJson = powershell -ExecutionPolicy Bypass -File $normalizerPath `
    -Root $Root `
    -RunBundlesRoot $runFixtureRoot `
    -SessionLogPath $sessionFixturePath `
    -ComparisonInputPath $comparisonFixturePath `
    -OutputPath $integrationNormalizedPath `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "normalize-local-evidence.ps1 exited with code $LASTEXITCODE during candidate integration setup"
}

$integrationJson = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $integrationNormalizedPath `
    -OutputPath $integrationCandidatesPath `
    -AuditOutputPath $integrationAuditPath `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with code $LASTEXITCODE for integration fixtures"
}

$integrationSummary = $integrationJson | ConvertFrom-Json

$fixtureJson = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $policyFixturePath `
    -OutputPath $fixtureCandidatesPath `
    -AuditOutputPath $fixtureAuditPath `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with code $LASTEXITCODE for policy candidate fixture"
}

$fixtureSummary = $fixtureJson | ConvertFrom-Json

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Expected,

        [Parameter(Mandatory = $true)]
        [AllowNull()]
        [object]$Actual
    )

    if ([string]$Expected -ne [string]$Actual) {
        throw "$Label mismatch. Expected '$Expected' but got '$Actual'."
    }
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [bool]$Condition
    )

    if (-not $Condition) {
        throw "$Label was expected to be true."
    }
}

function Find-NamedCount {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Items,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return @($Items | Where-Object { $_.Name -eq $Name } | Select-Object -First 1)
}

function Find-Candidate {
    param(
        [Parameter(Mandatory = $true)]
        [object[]]$Candidates,

        [Parameter(Mandatory = $true)]
        [string]$PolicyId
    )

    return @($Candidates | Where-Object { $_.policy_id -eq $PolicyId } | Select-Object -First 1)
}

Assert-True -Label "integration candidate output exists" -Condition (Test-Path -LiteralPath $integrationCandidatesPath)
Assert-True -Label "integration audit output exists" -Condition (Test-Path -LiteralPath $integrationAuditPath)
Assert-True -Label "integration candidate count positive" -Condition ([int]$integrationSummary.CandidateCount -ge 2)

$integrationStateCandidate = Find-NamedCount -Items $integrationSummary.StateCounts -Name "candidate"
Assert-True -Label "integration candidate state count positive" -Condition ([int]$integrationStateCandidate.Count -ge 1)

$fixtureCandidateCount = [int]$fixtureSummary.CandidateCount
Assert-Equal -Label "fixture candidate count" -Expected 3 -Actual $fixtureCandidateCount

$shadowCount = Find-NamedCount -Items $fixtureSummary.StateCounts -Name "shadow"
Assert-Equal -Label "shadow count" -Expected 1 -Actual $shadowCount.Count

$candidateCount = Find-NamedCount -Items $fixtureSummary.StateCounts -Name "candidate"
Assert-Equal -Label "candidate count" -Expected 1 -Actual $candidateCount.Count

$humanReviewCount = Find-NamedCount -Items $fixtureSummary.StateCounts -Name "human_review"
Assert-Equal -Label "human review count" -Expected 1 -Actual $humanReviewCount.Count

$kickoffPolicy = Find-Candidate -Candidates $fixtureSummary.Candidates -PolicyId "local-client:codex_extension.codex:kickoff_prompt_preset:compact"
Assert-Equal -Label "kickoff policy state" -Expected "shadow" -Actual $kickoffPolicy.state
Assert-Equal -Label "kickoff policy target surface" -Expected "kickoff_prompt_preset" -Actual $kickoffPolicy.target_surface
Assert-Equal -Label "kickoff shadow eligibility" -Expected "True" -Actual $kickoffPolicy.shadow_decision.eligible
Assert-Equal -Label "kickoff would change phrasing" -Expected "True" -Actual $kickoffPolicy.shadow_decision.would_change_kickoff_phrasing

$verificationPolicy = Find-Candidate -Candidates $fixtureSummary.Candidates -PolicyId "repo:prismatix:verification_loop_hints:strict"
Assert-Equal -Label "verification policy state" -Expected "candidate" -Actual $verificationPolicy.state
Assert-Equal -Label "verification policy surface" -Expected "verification_loop_hints" -Actual $verificationPolicy.target_surface
Assert-Equal -Label "verification checklist root cause" -Expected "require_root_cause_line" -Actual (($verificationPolicy.proposed_change.checklist | Where-Object { $_ -eq "require_root_cause_line" } | Select-Object -First 1))

$resolverPolicy = Find-Candidate -Candidates $fixtureSummary.Candidates -PolicyId "local-client:claude_code.claude:resolver_ranking:adapter_claude"
Assert-Equal -Label "resolver policy state" -Expected "human_review" -Actual $resolverPolicy.state
Assert-Equal -Label "resolver requires human review" -Expected "True" -Actual $resolverPolicy.requires_human_review
Assert-Equal -Label "resolver hard fail linkage" -Expected "session:phase2-05" -Actual (($resolverPolicy.hard_fail_event_ids | Select-Object -First 1))

$fixtureAuditLines = @(
    Get-Content -LiteralPath $fixtureAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)

Assert-Equal -Label "fixture audit line count" -Expected 3 -Actual $fixtureAuditLines.Count

$fixtureJsonRepeat = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $policyFixturePath `
    -OutputPath $fixtureCandidatesPath `
    -AuditOutputPath $fixtureAuditPath `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with code $LASTEXITCODE on repeat run"
}

$fixtureAuditLinesRepeat = @(
    Get-Content -LiteralPath $fixtureAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)

Assert-Equal -Label "fixture audit append count" -Expected 6 -Actual $fixtureAuditLinesRepeat.Count

# --- Slice 4A: Global Candidate Derivation Tests ---

$globalFixtureRoot3Repos = Join-Path $Root "tests\fixtures\global-candidates\active-policies-3repos"
$globalFixtureRoot2Repos = Join-Path $Root "tests\fixtures\global-candidates\active-policies-2repos"
$globalFixtureRootContradiction = Join-Path $Root "tests\fixtures\global-candidates\active-policies-contradiction"
$globalFixtureRootLocalClientOnly = Join-Path $Root "tests\fixtures\global-candidates\active-policies-local-client-only"

foreach ($requiredGlobalFixture in @($globalFixtureRoot3Repos, $globalFixtureRoot2Repos, $globalFixtureRootContradiction, $globalFixtureRootLocalClientOnly)) {
    if (-not (Test-Path -LiteralPath $requiredGlobalFixture)) {
        throw "Required global candidate fixture not found: $requiredGlobalFixture"
    }
}

$global3ReposOutputPath = Join-Path $tempDir "global-3repos-candidates.json"
$global3ReposAuditPath = Join-Path $tempDir "global-3repos-audit.jsonl"
$global2ReposOutputPath = Join-Path $tempDir "global-2repos-candidates.json"
$global2ReposAuditPath = Join-Path $tempDir "global-2repos-audit.jsonl"
$globalContradictionOutputPath = Join-Path $tempDir "global-contradiction-candidates.json"
$globalContradictionAuditPath = Join-Path $tempDir "global-contradiction-audit.jsonl"
$globalLocalClientOnlyOutputPath = Join-Path $tempDir "global-localclientonly-candidates.json"
$globalLocalClientOnlyAuditPath = Join-Path $tempDir "global-localclientonly-audit.jsonl"

# Test: 3 repos with matching pattern -> global shadow candidate
$global3ReposJsonRaw = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $policyFixturePath `
    -OutputPath $global3ReposOutputPath `
    -AuditOutputPath $global3ReposAuditPath `
    -ActivePoliciesRoot $globalFixtureRoot3Repos `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with $LASTEXITCODE for 3-repo global scenario"
}

$global3ReposSummary = $global3ReposJsonRaw | ConvertFrom-Json
$globalCandidate3 = Find-Candidate -Candidates $global3ReposSummary.Candidates -PolicyId "global:verification_loop_hints:checklist:require_root_cause_line|categories:backend"

Assert-True -Label "3-repo global candidate exists" -Condition ($null -ne $globalCandidate3 -and @($globalCandidate3).Count -gt 0)
Assert-Equal -Label "3-repo global candidate state" -Expected "shadow" -Actual $globalCandidate3.state
Assert-Equal -Label "3-repo global scope_type" -Expected "global" -Actual $globalCandidate3.scope_type
Assert-Equal -Label "3-repo global scope_key" -Expected "global" -Actual $globalCandidate3.scope_key
Assert-Equal -Label "3-repo global conflict detection" -Expected "none" -Actual $globalCandidate3.conflict_detection_result
Assert-Equal -Label "3-repo global regression check" -Expected "pending_cross_repo_validation" -Actual $globalCandidate3.regression_check_result
Assert-True -Label "3-repo global supporting repos count" -Condition ([int]$globalCandidate3.supporting_repos.Count -eq 3)
Assert-True -Label "3-repo global source policy ids count" -Condition ([int]$globalCandidate3.source_scoped_policy_ids.Count -eq 3)
Assert-True -Label "3-repo global supporting event ids present" -Condition ($globalCandidate3.supporting_event_ids.Count -ge 3)

$global3ReposAuditLines = @(
    Get-Content -LiteralPath $global3ReposAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)
$globalAuditLine3 = @($global3ReposAuditLines | Where-Object { $_.scope_type -eq "global" } | Select-Object -First 1)
Assert-True -Label "3-repo global audit line present" -Condition ($globalAuditLine3.Count -gt 0)
Assert-Equal -Label "3-repo global audit decision" -Expected "shadow" -Actual $globalAuditLine3[0].decision
Assert-Equal -Label "3-repo global audit conflict field" -Expected "none" -Actual $globalAuditLine3[0].conflict_detection_result

# Test: Only 2 repos with matching pattern -> no global candidate, rejection audit line
$global2ReposJsonRaw = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $policyFixturePath `
    -OutputPath $global2ReposOutputPath `
    -AuditOutputPath $global2ReposAuditPath `
    -ActivePoliciesRoot $globalFixtureRoot2Repos `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with $LASTEXITCODE for 2-repo global scenario"
}

$global2ReposSummary = $global2ReposJsonRaw | ConvertFrom-Json
$globalCandidate2 = Find-Candidate -Candidates $global2ReposSummary.Candidates -PolicyId "global:verification_loop_hints:checklist:require_root_cause_line|categories:backend"

Assert-True -Label "2-repo global candidate absent" -Condition ($null -eq $globalCandidate2 -or @($globalCandidate2).Count -eq 0)

$global2ReposAuditLines = @(
    Get-Content -LiteralPath $global2ReposAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)
$globalRejectionAudit2 = @($global2ReposAuditLines | Where-Object { $_.scope_type -eq "global" -and $_.decision -eq "rejected" } | Select-Object -First 1)
Assert-True -Label "2-repo global rejection audit line present" -Condition ($globalRejectionAudit2.Count -gt 0)
Assert-Equal -Label "2-repo global rejection reason" -Expected "insufficient_source_repos" -Actual ($globalRejectionAudit2[0].reasons | Select-Object -First 1)
Assert-True -Label "2-repo global rejection supporting_event_ids present" -Condition ($globalRejectionAudit2[0].supporting_event_ids.Count -ge 1)

# Test: 3 repos with diverging affected_task_categories -> contradictory_source_patterns, no candidate
$globalContradictionJsonRaw = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $policyFixturePath `
    -OutputPath $globalContradictionOutputPath `
    -AuditOutputPath $globalContradictionAuditPath `
    -ActivePoliciesRoot $globalFixtureRootContradiction `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with $LASTEXITCODE for contradiction global scenario"
}

$globalContradictionSummary = $globalContradictionJsonRaw | ConvertFrom-Json
$globalContradictionGlobalCandidates = @($globalContradictionSummary.Candidates | Where-Object { $_.scope_type -eq "global" })

Assert-True -Label "contradiction: no global candidates produced" -Condition ($globalContradictionGlobalCandidates.Count -eq 0)

$globalContradictionAuditLines = @(
    Get-Content -LiteralPath $globalContradictionAuditPath |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_ | ConvertFrom-Json }
)
$globalContradictionRejections = @($globalContradictionAuditLines | Where-Object { $_.scope_type -eq "global" -and $_.decision -eq "rejected" })
Assert-True -Label "contradiction: rejection audit lines present" -Condition ($globalContradictionRejections.Count -gt 0)
Assert-True -Label "contradiction: at least one contradictory_source_patterns rejection" -Condition (
    @($globalContradictionRejections | Where-Object { @($_.reasons) -contains "contradictory_source_patterns" }).Count -gt 0
)

# Guardrail: local-client active policies alone must not satisfy the 3-repo global gate
$globalLocalClientOnlyJsonRaw = powershell -ExecutionPolicy Bypass -File $generatorPath `
    -Root $Root `
    -InputPath $policyFixturePath `
    -OutputPath $globalLocalClientOnlyOutputPath `
    -AuditOutputPath $globalLocalClientOnlyAuditPath `
    -ActivePoliciesRoot $globalFixtureRootLocalClientOnly `
    -Format json | Out-String

if ($LASTEXITCODE -ne 0) {
    throw "generate-local-policy-candidates.ps1 exited with $LASTEXITCODE for local-client-only global scenario"
}

$globalLocalClientOnlySummary = $globalLocalClientOnlyJsonRaw | ConvertFrom-Json
$globalLocalClientOnlyCandidates = @($globalLocalClientOnlySummary.Candidates | Where-Object { $_.scope_type -eq "global" })

Assert-True -Label "local-client-only: zero global candidates produced" -Condition ($globalLocalClientOnlyCandidates.Count -eq 0)

Write-Host "generate-local-policy-candidates regression tests passed." -ForegroundColor Cyan
