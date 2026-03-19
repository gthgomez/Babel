[CmdletBinding()]
param(
    [string]$InputPath = "",

    [ValidateSet("text", "json")]
    [string]$Format = "text",

    [switch]$CheckExpected,

    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

if ([string]::IsNullOrWhiteSpace($InputPath)) {
    $InputPath = Join-Path $Root "tests\fixtures\comparison-workflow\comparison-cases.json"
}

if (-not [System.IO.Path]::IsPathRooted($InputPath)) {
    $InputPath = Join-Path $Root $InputPath
}

if (-not (Test-Path -LiteralPath $InputPath)) {
    throw "Comparison case file not found at $InputPath"
}

function Test-HasProperty {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($null -eq $Object) {
        return $false
    }

    return $null -ne $Object.PSObject.Properties[$Name]
}

function Get-PropertyValue {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [AllowNull()]
        [object]$DefaultValue = $null
    )

    if (-not (Test-HasProperty -Object $Object -Name $Name)) {
        return $DefaultValue
    }

    return $Object.PSObject.Properties[$Name].Value
}

function Get-BoolProperty {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [bool]$DefaultValue
    )

    if (-not (Test-HasProperty -Object $Object -Name $Name)) {
        return $DefaultValue
    }

    return [bool](Get-PropertyValue -Object $Object -Name $Name)
}

function Resolve-InputPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$RawPath
    )

    if ([System.IO.Path]::IsPathRooted($RawPath)) {
        return $RawPath
    }

    return Join-Path $RepoRoot $RawPath
}

function Get-TopCounts {
    param(
        [AllowNull()]
        [object[]]$Items,

        [int]$Take = 5
    )

    $counts = @{}

    foreach ($item in @($Items)) {
        if ($null -eq $item) {
            continue
        }

        $text = [string]$item
        if ([string]::IsNullOrWhiteSpace($text)) {
            continue
        }

        if ($counts.ContainsKey($text)) {
            $counts[$text]++
        } else {
            $counts[$text] = 1
        }
    }

    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($key in $counts.Keys) {
        $rows.Add([PSCustomObject]@{
            Name = $key
            Count = [int]$counts[$key]
        })
    }

    return @(
        $rows |
            Sort-Object -Property Count, Name -Descending |
            Select-Object -First $Take
    )
}

function Get-IntProperty {
    param(
        [AllowNull()]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [int]$DefaultValue
    )

    if (-not (Test-HasProperty -Object $Object -Name $Name)) {
        return $DefaultValue
    }

    try {
        return [int](Get-PropertyValue -Object $Object -Name $Name)
    } catch {
        throw "Property '$Name' must be an integer."
    }
}

function Get-RequiredIntScore {
    param(
        [Parameter(Mandatory = $true)]
        [object]$ScoreObject,

        [Parameter(Mandatory = $true)]
        [string]$CriterionId,

        [Parameter(Mandatory = $true)]
        [int]$MinScore,

        [Parameter(Mandatory = $true)]
        [int]$MaxScore,

        [Parameter(Mandatory = $true)]
        [string]$CaseId,

        [Parameter(Mandatory = $true)]
        [string]$CandidateId
    )

    if (-not (Test-HasProperty -Object $ScoreObject -Name $CriterionId)) {
        throw "Case '$CaseId' candidate '$CandidateId' is missing score for criterion '$CriterionId'."
    }

    $rawValue = Get-PropertyValue -Object $ScoreObject -Name $CriterionId

    try {
        $score = [int]$rawValue
    } catch {
        throw "Case '$CaseId' candidate '$CandidateId' criterion '$CriterionId' score must be an integer."
    }

    if ($score -lt $MinScore -or $score -gt $MaxScore) {
        throw "Case '$CaseId' candidate '$CandidateId' criterion '$CriterionId' score '$score' is outside [$MinScore, $MaxScore]."
    }

    return $score
}

$spec = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json
$cases = @((Get-PropertyValue -Object $spec -Name "cases"))
if ($cases.Count -eq 0) {
    throw "Comparison case file '$InputPath' does not define any cases."
}

$results = New-Object System.Collections.Generic.List[object]
$expectationMismatches = New-Object System.Collections.Generic.List[string]
$winningModels = New-Object System.Collections.Generic.List[string]
$winningAdapters = New-Object System.Collections.Generic.List[string]
$winningStackIds = New-Object System.Collections.Generic.List[string]
$winningClientSurfaces = New-Object System.Collections.Generic.List[string]

foreach ($case in $cases) {
    $caseId = [string](Get-PropertyValue -Object $case -Name "id")
    if ([string]::IsNullOrWhiteSpace($caseId)) {
        throw "A comparison case is missing a non-empty 'id'."
    }

    $task = Get-PropertyValue -Object $case -Name "task"
    $rubric = Get-PropertyValue -Object $case -Name "rubric"
    $criteria = @((Get-PropertyValue -Object $rubric -Name "criteria"))
    $candidates = @((Get-PropertyValue -Object $case -Name "candidates"))
    $scoringRows = @((Get-PropertyValue -Object $case -Name "scoring"))

    if ($null -eq $rubric) {
        throw "Case '$caseId' is missing a 'rubric' block."
    }

    if ($criteria.Count -eq 0) {
        throw "Case '$caseId' rubric does not define any criteria."
    }

    if ($candidates.Count -ne 2) {
        throw "Case '$caseId' must define exactly two candidates for pairwise Best-of-2 comparison."
    }

    if ($scoringRows.Count -ne 2) {
        throw "Case '$caseId' must define scoring rows for exactly two candidates."
    }

    $scale = Get-PropertyValue -Object $rubric -Name "scoreScale"
    $minScore = Get-IntProperty -Object $scale -Name "min" -DefaultValue 0
    $maxScore = Get-IntProperty -Object $scale -Name "max" -DefaultValue 2
    $passThreshold = Get-IntProperty -Object $scale -Name "passThreshold" -DefaultValue 1

    if ($minScore -gt $maxScore) {
        throw "Case '$caseId' has invalid scoreScale. min cannot be greater than max."
    }

    if ($passThreshold -lt $minScore -or $passThreshold -gt $maxScore) {
        throw "Case '$caseId' has passThreshold outside the score scale range."
    }

    $criteriaById = @{}
    $criteriaOrdered = New-Object System.Collections.Generic.List[object]
    foreach ($criterion in $criteria) {
        $criterionId = [string](Get-PropertyValue -Object $criterion -Name "id")
        if ([string]::IsNullOrWhiteSpace($criterionId)) {
            throw "Case '$caseId' contains a criterion with an empty 'id'."
        }

        if ($criteriaById.ContainsKey($criterionId)) {
            throw "Case '$caseId' has duplicate criterion id '$criterionId'."
        }

        $weight = Get-IntProperty -Object $criterion -Name "weight" -DefaultValue -1
        if ($weight -lt 1) {
            throw "Case '$caseId' criterion '$criterionId' must have integer weight >= 1."
        }

        $criterionMeta = [PSCustomObject]@{
            Id = $criterionId
            Weight = $weight
            Critical = Get-BoolProperty -Object $criterion -Name "critical" -DefaultValue $false
            Description = [string](Get-PropertyValue -Object $criterion -Name "description")
        }

        $criteriaById[$criterionId] = $criterionMeta
        $criteriaOrdered.Add($criterionMeta)
    }

    $candidateById = @{}
    foreach ($candidate in $candidates) {
        $candidateId = [string](Get-PropertyValue -Object $candidate -Name "id")
        if ([string]::IsNullOrWhiteSpace($candidateId)) {
            throw "Case '$caseId' contains a candidate with an empty 'id'."
        }

        if ($candidateById.ContainsKey($candidateId)) {
            throw "Case '$caseId' has duplicate candidate id '$candidateId'."
        }

        $responsePathRaw = [string](Get-PropertyValue -Object $candidate -Name "responsePath")
        if ([string]::IsNullOrWhiteSpace($responsePathRaw)) {
            throw "Case '$caseId' candidate '$candidateId' is missing 'responsePath'."
        }

        $resolvedResponsePath = Resolve-InputPath -RepoRoot $Root -RawPath $responsePathRaw
        if (-not (Test-Path -LiteralPath $resolvedResponsePath)) {
            throw "Case '$caseId' candidate '$candidateId' response file not found at $resolvedResponsePath"
        }

        $candidateById[$candidateId] = [PSCustomObject]@{
            CandidateId = $candidateId
            Label = [string](Get-PropertyValue -Object $candidate -Name "label")
            Model = [string](Get-PropertyValue -Object $candidate -Name "model")
            Adapter = [string](Get-PropertyValue -Object $candidate -Name "adapter")
            ClientSurface = [string](Get-PropertyValue -Object $candidate -Name "clientSurface")
            SessionId = [string](Get-PropertyValue -Object $candidate -Name "sessionId")
            SelectedStackIds = @((Get-PropertyValue -Object $candidate -Name "selectedStackIds"))
            ResponsePath = $resolvedResponsePath
        }
    }

    $scoreByCandidate = @{}
    foreach ($scoringRow in $scoringRows) {
        $candidateId = [string](Get-PropertyValue -Object $scoringRow -Name "candidateId")
        $criterionScores = Get-PropertyValue -Object $scoringRow -Name "criterionScores"
        if ([string]::IsNullOrWhiteSpace($candidateId)) {
            throw "Case '$caseId' includes a scoring row with empty candidateId."
        }

        if (-not $candidateById.ContainsKey($candidateId)) {
            throw "Case '$caseId' scoring row references unknown candidate '$candidateId'."
        }

        if ($scoreByCandidate.ContainsKey($candidateId)) {
            throw "Case '$caseId' has duplicate scoring rows for candidate '$candidateId'."
        }

        if ($null -eq $criterionScores) {
            throw "Case '$caseId' candidate '$candidateId' is missing 'criterionScores'."
        }

        $weightedTotal = 0
        $criticalPassCount = 0
        $verificationQualityScore = -1
        $criterionBreakdown = New-Object System.Collections.Generic.List[object]

        foreach ($criterionMeta in $criteriaOrdered) {
            $criterionId = $criterionMeta.Id
            $score = Get-RequiredIntScore `
                -ScoreObject $criterionScores `
                -CriterionId $criterionId `
                -MinScore $minScore `
                -MaxScore $maxScore `
                -CaseId $caseId `
                -CandidateId $candidateId

            $weightedScore = $score * $criterionMeta.Weight
            $weightedTotal += $weightedScore

            if ($criterionMeta.Critical -and $score -ge $passThreshold) {
                $criticalPassCount++
            }

            if ($criterionId -eq "verification_quality") {
                $verificationQualityScore = $score
            }

            $criterionBreakdown.Add([PSCustomObject]@{
                CriterionId = $criterionId
                Description = $criterionMeta.Description
                Critical = $criterionMeta.Critical
                Weight = $criterionMeta.Weight
                Score = $score
                WeightedScore = $weightedScore
                PassedThreshold = ($score -ge $passThreshold)
            })
        }

        $metadata = $candidateById[$candidateId]
        $selectedStackIds = @(
            @($metadata.SelectedStackIds) |
                ForEach-Object { [string]$_ } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
        $criteriaSnapshot = @($criterionBreakdown.ToArray())

        $scoreByCandidate[$candidateId] = [PSCustomObject]@{
            CandidateId = $candidateId
            Label = $metadata.Label
            Model = $metadata.Model
            Adapter = $metadata.Adapter
            ClientSurface = $metadata.ClientSurface
            SessionId = $metadata.SessionId
            SelectedStackIds = $selectedStackIds
            ResponsePath = $metadata.ResponsePath
            WeightedTotal = $weightedTotal
            CriticalPassCount = $criticalPassCount
            VerificationQualityScore = $verificationQualityScore
            Criteria = $criteriaSnapshot
        }
    }

    $rankedCandidates = @(
        $scoreByCandidate.Values |
            Sort-Object `
                -Property `
                    @{ Expression = { $_.WeightedTotal }; Descending = $true }, `
                    @{ Expression = { $_.CriticalPassCount }; Descending = $true }, `
                    @{ Expression = { $_.VerificationQualityScore }; Descending = $true }, `
                    @{ Expression = { $_.CandidateId }; Descending = $false }
    )

    $winner = $rankedCandidates[0]
    $runnerUp = $rankedCandidates[1]

    $decisionRule = if ($winner.WeightedTotal -ne $runnerUp.WeightedTotal) {
        "weighted_total"
    } elseif ($winner.CriticalPassCount -ne $runnerUp.CriticalPassCount) {
        "critical_criteria_pass_count"
    } elseif ($winner.VerificationQualityScore -ne $runnerUp.VerificationQualityScore) {
        "verification_quality_score"
    } else {
        "candidate_id_asc"
    }

    $weightedTotals = [PSCustomObject]@{}
    $criticalPassCounts = [PSCustomObject]@{}
    foreach ($candidate in $rankedCandidates) {
        $weightedTotals | Add-Member -MemberType NoteProperty -Name $candidate.CandidateId -Value $candidate.WeightedTotal
        $criticalPassCounts | Add-Member -MemberType NoteProperty -Name $candidate.CandidateId -Value $candidate.CriticalPassCount
    }

    $expected = Get-PropertyValue -Object $case -Name "expected"
    $expectationMatched = $true

    if ($CheckExpected) {
        if ($null -eq $expected) {
            $expectationMatched = $false
            $expectationMismatches.Add("[$caseId] Missing expected block while -CheckExpected is enabled.")
        } else {
            $expectedWinner = [string](Get-PropertyValue -Object $expected -Name "winnerId")
            $expectedRule = [string](Get-PropertyValue -Object $expected -Name "decisionRule")
            $expectedTotals = Get-PropertyValue -Object $expected -Name "weightedTotals"
            $expectedCriticalCounts = Get-PropertyValue -Object $expected -Name "criticalPassCounts"

            if ($winner.CandidateId -ne $expectedWinner) {
                $expectationMatched = $false
                $expectationMismatches.Add("[$caseId] Expected winner '$expectedWinner' but got '$($winner.CandidateId)'.")
            }

            if ($decisionRule -ne $expectedRule) {
                $expectationMatched = $false
                $expectationMismatches.Add("[$caseId] Expected decision rule '$expectedRule' but got '$decisionRule'.")
            }

            foreach ($candidate in $rankedCandidates) {
                $candidateId = $candidate.CandidateId
                $expectedTotal = Get-PropertyValue -Object $expectedTotals -Name $candidateId -DefaultValue $null
                $expectedCritical = Get-PropertyValue -Object $expectedCriticalCounts -Name $candidateId -DefaultValue $null

                if ($null -eq $expectedTotal -or [int]$expectedTotal -ne [int]$candidate.WeightedTotal) {
                    $expectationMatched = $false
                    $expectationMismatches.Add("[$caseId] Weighted total mismatch for '$candidateId'. Expected '$expectedTotal' but got '$($candidate.WeightedTotal)'.")
                }

                if ($null -eq $expectedCritical -or [int]$expectedCritical -ne [int]$candidate.CriticalPassCount) {
                    $expectationMatched = $false
                    $expectationMismatches.Add("[$caseId] Critical pass count mismatch for '$candidateId'. Expected '$expectedCritical' but got '$($candidate.CriticalPassCount)'.")
                }
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($winner.Model)) {
        $winningModels.Add($winner.Model)
    }

    if (-not [string]::IsNullOrWhiteSpace($winner.Adapter)) {
        $winningAdapters.Add($winner.Adapter)
    }

    if (-not [string]::IsNullOrWhiteSpace($winner.ClientSurface)) {
        $winningClientSurfaces.Add($winner.ClientSurface)
    }

    foreach ($stackId in @($winner.SelectedStackIds)) {
        if (-not [string]::IsNullOrWhiteSpace([string]$stackId)) {
            $winningStackIds.Add([string]$stackId)
        }
    }

    $results.Add([PSCustomObject]@{
        Id = $caseId
        Project = [string](Get-PropertyValue -Object $task -Name "project")
        TaskCategory = [string](Get-PropertyValue -Object $task -Name "taskCategory")
        Objective = [string](Get-PropertyValue -Object $task -Name "objective")
        CandidateCount = $rankedCandidates.Count
        MinScore = $minScore
        MaxScore = $maxScore
        PassThreshold = $passThreshold
        WinnerId = $winner.CandidateId
        DecisionRule = $decisionRule
        WeightedTotals = $weightedTotals
        CriticalPassCounts = $criticalPassCounts
        RankedCandidates = $rankedCandidates
        ExpectationMatched = $expectationMatched
    })
}

$summary = [PSCustomObject]@{
    SchemaVersion = 1
    InputPath = $InputPath
    CaseCount = $results.Count
    ExpectationMismatchCount = $expectationMismatches.Count
    Results = $results
    RecommendationSignals = [PSCustomObject]@{
        TopWinningModels = @(Get-TopCounts -Items $winningModels.ToArray() -Take 5)
        TopWinningAdapters = @(Get-TopCounts -Items $winningAdapters.ToArray() -Take 5)
        TopWinningClientSurfaces = @(Get-TopCounts -Items $winningClientSurfaces.ToArray() -Take 5)
        TopWinningStackIds = @(Get-TopCounts -Items $winningStackIds.ToArray() -Take 8)
    }
}

if ($expectationMismatches.Count -gt 0) {
    $message = @(
        "Comparison workflow scoring failed expected checks."
        ""
        $expectationMismatches
    ) -join [Environment]::NewLine

    throw $message
}

if ($Format -eq "json") {
    $summary | ConvertTo-Json -Depth 10
    exit 0
}

Write-Host ""
Write-Host "Phase 5 Comparison Workflow Results" -ForegroundColor Cyan
Write-Host "Input file: $InputPath"
Write-Host ""

foreach ($result in $results) {
    Write-Host "[PASS] $($result.Id) winner=$($result.WinnerId) via $($result.DecisionRule)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Top winning adapters:" -ForegroundColor Yellow
if (@($summary.RecommendationSignals.TopWinningAdapters).Count -eq 0) {
    Write-Host "  None."
} else {
    foreach ($item in $summary.RecommendationSignals.TopWinningAdapters) {
        Write-Host "  - $($item.Name): $($item.Count)"
    }
}

Write-Host ""
Write-Host "Phase 5 comparison workflow scoring passed." -ForegroundColor Cyan
