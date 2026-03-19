[CmdletBinding()]
param(
    [string]$Root = "",
    [string]$FixturePath = "",
    [ValidateSet("text", "json")]
    [string]$Format = "text"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
}

if ([string]::IsNullOrWhiteSpace($FixturePath)) {
    $FixturePath = Join-Path $Root "tests\fixtures\eval-quality\quality-fixtures.json"
}

if (-not [System.IO.Path]::IsPathRooted($FixturePath)) {
    $FixturePath = Join-Path $Root $FixturePath
}

if (-not (Test-Path -LiteralPath $FixturePath)) {
    throw "Fixture file not found at $FixturePath"
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

function Normalize-Ids {
    param(
        [AllowNull()]
        [object[]]$Values
    )

    return @(
        $Values |
            ForEach-Object { [string]$_ } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
            Sort-Object
    )
}

function Resolve-ResponsePath {
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

function Test-StringContains {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,

        [Parameter(Mandatory = $true)]
        [string]$Fragment,

        [Parameter(Mandatory = $true)]
        [bool]$CaseSensitive
    )

    if ($CaseSensitive) {
        return $Text.Contains($Fragment)
    }

    return $Text.IndexOf($Fragment, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-RegexMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text,

        [Parameter(Mandatory = $true)]
        [string]$Pattern,

        [Parameter(Mandatory = $true)]
        [bool]$CaseSensitive,

        [Parameter(Mandatory = $true)]
        [bool]$Multiline
    )

    $options = [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    if (-not $CaseSensitive) {
        $options = $options -bor [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    }

    if ($Multiline) {
        $options = $options -bor [System.Text.RegularExpressions.RegexOptions]::Multiline
    }

    return [System.Text.RegularExpressions.Regex]::IsMatch($Text, $Pattern, $options)
}

function Evaluate-Check {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Check,

        [Parameter(Mandatory = $true)]
        [string]$ResponseText
    )

    $checkId = [string](Get-PropertyValue -Object $Check -Name "id")
    $checkType = [string](Get-PropertyValue -Object $Check -Name "type")
    $checkValue = [string](Get-PropertyValue -Object $Check -Name "value")
    $description = [string](Get-PropertyValue -Object $Check -Name "description")
    $caseSensitive = Get-BoolProperty -Object $Check -Name "caseSensitive" -DefaultValue $false
    $multiline = Get-BoolProperty -Object $Check -Name "multiline" -DefaultValue $true

    if ([string]::IsNullOrWhiteSpace($checkId)) {
        throw "Fixture check is missing a non-empty 'id'."
    }

    if ([string]::IsNullOrWhiteSpace($checkType)) {
        throw "Fixture check '$checkId' is missing a non-empty 'type'."
    }

    if ([string]::IsNullOrWhiteSpace($checkValue)) {
        throw "Fixture check '$checkId' is missing a non-empty 'value'."
    }

    $normalizedType = $checkType.Trim().ToLowerInvariant()
    $rawMatch = $false

    switch ($normalizedType) {
        "contains" {
            $rawMatch = Test-StringContains -Text $ResponseText -Fragment $checkValue -CaseSensitive $caseSensitive
        }
        "not_contains" {
            $rawMatch = Test-StringContains -Text $ResponseText -Fragment $checkValue -CaseSensitive $caseSensitive
        }
        "regex" {
            $rawMatch = Test-RegexMatch -Text $ResponseText -Pattern $checkValue -CaseSensitive $caseSensitive -Multiline $multiline
        }
        "not_regex" {
            $rawMatch = Test-RegexMatch -Text $ResponseText -Pattern $checkValue -CaseSensitive $caseSensitive -Multiline $multiline
        }
        default {
            throw "Fixture check '$checkId' uses unsupported type '$checkType'. Supported types: contains, not_contains, regex, not_regex."
        }
    }

    $passed = switch ($normalizedType) {
        "contains" { $rawMatch }
        "regex" { $rawMatch }
        "not_contains" { -not $rawMatch }
        "not_regex" { -not $rawMatch }
    }

    return [PSCustomObject]@{
        Id = $checkId
        Description = $description
        Type = $normalizedType
        Value = $checkValue
        Passed = $passed
    }
}

$fixtureSpec = Get-Content -LiteralPath $FixturePath -Raw | ConvertFrom-Json
$fixtures = @((Get-PropertyValue -Object $fixtureSpec -Name "fixtures"))
if ($fixtures.Count -eq 0) {
    throw "Fixture file '$FixturePath' does not define any fixtures."
}

$results = New-Object System.Collections.Generic.List[object]
$expectationMismatches = New-Object System.Collections.Generic.List[string]

foreach ($fixture in $fixtures) {
    $fixtureId = [string](Get-PropertyValue -Object $fixture -Name "id")
    $category = [string](Get-PropertyValue -Object $fixture -Name "category")
    $responsePathRaw = [string](Get-PropertyValue -Object $fixture -Name "responsePath")
    $checks = @((Get-PropertyValue -Object $fixture -Name "checks"))

    if ([string]::IsNullOrWhiteSpace($fixtureId)) {
        throw "A fixture is missing a non-empty 'id'."
    }

    if ([string]::IsNullOrWhiteSpace($responsePathRaw)) {
        throw "Fixture '$fixtureId' is missing a non-empty 'responsePath'."
    }

    if ($checks.Count -eq 0) {
        throw "Fixture '$fixtureId' does not include any checks."
    }

    $responsePath = Resolve-ResponsePath -RepoRoot $Root -RawPath $responsePathRaw
    if (-not (Test-Path -LiteralPath $responsePath)) {
        throw "Fixture '$fixtureId' response file not found at $responsePath"
    }

    $responseText = Get-Content -LiteralPath $responsePath -Raw
    $checkResults = @(
        foreach ($check in $checks) {
            Evaluate-Check -Check $check -ResponseText $responseText
        }
    )

    $failedCheckIds = @(Normalize-Ids -Values @($checkResults | Where-Object { -not $_.Passed } | ForEach-Object { $_.Id }))
    $passed = $failedCheckIds.Count -eq 0

    $expected = Get-PropertyValue -Object $fixture -Name "expected"
    if ($null -eq $expected) {
        throw "Fixture '$fixtureId' is missing an 'expected' block."
    }

    if (-not (Test-HasProperty -Object $expected -Name "pass")) {
        throw "Fixture '$fixtureId' expected block is missing 'pass'."
    }

    if (-not (Test-HasProperty -Object $expected -Name "failedCheckIds")) {
        throw "Fixture '$fixtureId' expected block is missing 'failedCheckIds'."
    }

    $expectedPass = [bool](Get-PropertyValue -Object $expected -Name "pass")
    $expectedFailedCheckIds = @(Normalize-Ids -Values @((Get-PropertyValue -Object $expected -Name "failedCheckIds")))
    $expectationMatched = ($passed -eq $expectedPass) -and (($failedCheckIds -join "|") -eq ($expectedFailedCheckIds -join "|"))

    if (-not $expectationMatched) {
        $expectationMismatches.Add(
            "[$fixtureId] Expected pass=$expectedPass failedCheckIds=[$($expectedFailedCheckIds -join ', ')] but got pass=$passed failedCheckIds=[$($failedCheckIds -join ', ')]."
        )
    }

    $results.Add([PSCustomObject]@{
        Id = $fixtureId
        Category = $category
        ResponsePath = $responsePath
        CheckCount = $checkResults.Count
        PassedCheckCount = @($checkResults | Where-Object { $_.Passed }).Count
        FailedCheckIds = $failedCheckIds
        Passed = $passed
        ExpectedPass = $expectedPass
        ExpectedFailedCheckIds = $expectedFailedCheckIds
        ExpectationMatched = $expectationMatched
        Checks = $checkResults
    })
}

$resultObject = [PSCustomObject]@{
    FixturePath = $FixturePath
    FixtureCount = $results.Count
    ExpectationMismatchCount = $expectationMismatches.Count
    Results = $results
}

if ($Format -eq "json") {
    $resultObject | ConvertTo-Json -Depth 8
} else {
    Write-Host ""
    Write-Host "Phase 4 Eval Fixture Results" -ForegroundColor Cyan
    Write-Host "Fixture file: $FixturePath"
    Write-Host ""

    foreach ($result in $results) {
        if ($result.ExpectationMatched) {
            Write-Host "[PASS] $($result.Id) ($($result.Category)) checks $($result.PassedCheckCount)/$($result.CheckCount)" -ForegroundColor Green
        } else {
            Write-Host "[FAIL] $($result.Id) ($($result.Category)) checks $($result.PassedCheckCount)/$($result.CheckCount)" -ForegroundColor Red
            Write-Host "       expected failed checks: $($result.ExpectedFailedCheckIds -join ', ')" -ForegroundColor DarkRed
            Write-Host "       actual failed checks:   $($result.FailedCheckIds -join ', ')" -ForegroundColor DarkRed
        }
    }
}

if ($expectationMismatches.Count -gt 0) {
    $message = @(
        "Phase 4 eval fixture grading failed."
        ""
        $expectationMismatches
    ) -join [Environment]::NewLine

    throw $message
}

if ($Format -ne "json") {
    Write-Host ""
    Write-Host "Phase 4 eval fixture grading passed." -ForegroundColor Cyan
}
