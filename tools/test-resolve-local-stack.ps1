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

$resolverPath = Join-Path $Root "tools\resolve-local-stack.ps1"
$casesPath = Join-Path $Root "tests\fixtures\resolve-local-stack-cases.json"
$fixtureProjectsRoot = Join-Path $Root "tests\fixtures\projects"
$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$pwshCommand = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
}

if (-not (Test-Path $resolverPath)) {
    throw "Resolver script not found at $resolverPath"
}

if (-not (Test-Path $casesPath)) {
    throw "Resolver fixture file not found at $casesPath"
}

function Add-Failure {
    param(
        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$Failures,

        [Parameter(Mandatory = $true)]
        [string]$CaseName,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $Failures.Add("[$CaseName] $Message")
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
        [string]$Name
    )

    if (-not (Test-HasProperty -Object $Object -Name $Name)) {
        return $null
    }

    return $Object.PSObject.Properties[$Name].Value
}

function Normalize-Sequence {
    param(
        [AllowNull()]
        [object[]]$Items
    )

    return @($Items | ForEach-Object { [string]$_ })
}

function Test-ExactSequence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CaseName,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object[]]$Expected,

        [AllowNull()]
        [object[]]$Actual,

        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$Failures
    )

    $expectedNormalized = Normalize-Sequence -Items $Expected
    $actualNormalized = Normalize-Sequence -Items $Actual

    if (($expectedNormalized -join " || ") -ne ($actualNormalized -join " || ")) {
        Add-Failure -Failures $Failures -CaseName $CaseName -Message (
            "$Label mismatch.`nExpected: $($expectedNormalized -join ', ')`nActual: $($actualNormalized -join ', ')"
        )
    }
}

function Test-EqualValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CaseName,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object]$Expected,

        [AllowNull()]
        [object]$Actual,

        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$Failures
    )

    if ([string]$Expected -ne [string]$Actual) {
        Add-Failure -Failures $Failures -CaseName $CaseName -Message (
            "$Label mismatch. Expected '$Expected' but got '$Actual'."
        )
    }
}

function Test-PathSuffixes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CaseName,

        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object[]]$ExpectedSuffixes,

        [AllowNull()]
        [object[]]$ActualPaths,

        [AllowEmptyCollection()]
        [Parameter(Mandatory = $true)]
        [System.Collections.Generic.List[string]]$Failures
    )

    $expectedNormalized = Normalize-Sequence -Items $ExpectedSuffixes
    $actualNormalized = Normalize-Sequence -Items $ActualPaths

    foreach ($suffix in $expectedNormalized) {
        $matched = $false
        foreach ($actualPath in $actualNormalized) {
            if ($actualPath.Replace("/", "\").EndsWith($suffix.Replace("/", "\"), [System.StringComparison]::OrdinalIgnoreCase)) {
                $matched = $true
                break
            }
        }

        if (-not $matched) {
            Add-Failure -Failures $Failures -CaseName $CaseName -Message (
                "$Label missing suffix '$suffix'. Actual paths: $($actualNormalized -join ', ')"
            )
        }
    }
}

function Invoke-Resolver {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShellPath,

        [Parameter(Mandatory = $true)]
        [string[]]$ArgumentList
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $process = Start-Process `
            -FilePath $ShellPath `
            -ArgumentList $ArgumentList `
            -Wait `
            -PassThru `
            -NoNewWindow `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = if (Test-Path $stdoutPath) { Get-Content -Path $stdoutPath -Raw } else { "" }
            Stderr = if (Test-Path $stderrPath) { Get-Content -Path $stderrPath -Raw } else { "" }
        }
    } finally {
        Remove-Item -Path $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

$caseSpec = Get-Content -Path $casesPath -Raw | ConvertFrom-Json
$failures = New-Object System.Collections.Generic.List[string]
$passed = 0

foreach ($case in @(Get-PropertyValue -Object $caseSpec -Name "cases")) {
    $caseName = [string](Get-PropertyValue -Object $case -Name "name")
    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $resolverPath,
        "-Root", $Root,
        "-TaskCategory", [string](Get-PropertyValue -Object $case -Name "taskCategory"),
        "-Project", [string](Get-PropertyValue -Object $case -Name "project"),
        "-Model", [string](Get-PropertyValue -Object $case -Name "model"),
        "-PipelineMode", [string](Get-PropertyValue -Object $case -Name "pipelineMode"),
        "-Format", "json"
    )

    if (Test-HasProperty -Object $case -Name "projectPathFixture") {
        $projectPath = Join-Path $fixtureProjectsRoot ([string](Get-PropertyValue -Object $case -Name "projectPathFixture"))
        if (-not (Test-Path $projectPath)) {
            Add-Failure -Failures $failures -CaseName $caseName -Message "Fixture project path not found: $projectPath"
            continue
        }

        $args += @("-ProjectPath", $projectPath)
    }

    if (Test-HasProperty -Object $case -Name "codexAdapter") {
        $args += @("-CodexAdapter", [string](Get-PropertyValue -Object $case -Name "codexAdapter"))
    }

    if ((Test-HasProperty -Object $case -Name "disableRecommendedTaskOverlays") -and [bool](Get-PropertyValue -Object $case -Name "disableRecommendedTaskOverlays")) {
        $args += "-DisableRecommendedTaskOverlays"
    }

    if (Test-HasProperty -Object $case -Name "taskOverlayIds") {
        $overlayIds = @(
            (Get-PropertyValue -Object $case -Name "taskOverlayIds") |
                ForEach-Object { [string]$_ }
        )
        if ($overlayIds.Count -gt 0) {
            $args += "-TaskOverlayIds"
            $args += $overlayIds
        }
    }

    $invocation = Invoke-Resolver -ShellPath $pwshCommand -ArgumentList $args
    if ($invocation.ExitCode -ne 0) {
        $stderr = if ([string]::IsNullOrWhiteSpace($invocation.Stderr)) { "(no stderr)" } else { $invocation.Stderr.Trim() }
        Add-Failure -Failures $failures -CaseName $caseName -Message "Resolver exited with code $($invocation.ExitCode). stderr: $stderr"
        continue
    }

    $actual = $invocation.Stdout | ConvertFrom-Json
    $expected = Get-PropertyValue -Object $case -Name "expected"

    Test-ExactSequence `
        -CaseName $caseName `
        -Label "SelectedStack IDs" `
        -Expected @((Get-PropertyValue -Object $expected -Name "selectedStackIds")) `
        -Actual @((Get-PropertyValue -Object $actual -Name "SelectedStack") | ForEach-Object { Get-PropertyValue -Object $_ -Name "Id" }) `
        -Failures $failures

    Test-ExactSequence `
        -CaseName $caseName `
        -Label "RecommendedTaskOverlayIds" `
        -Expected @((Get-PropertyValue -Object $expected -Name "recommendedTaskOverlayIds")) `
        -Actual @((Get-PropertyValue -Object $actual -Name "RecommendedTaskOverlayIds")) `
        -Failures $failures

    Test-EqualValue `
        -CaseName $caseName `
        -Label "RepoLocalSystemPresent" `
        -Expected (Get-PropertyValue -Object $expected -Name "repoLocalSystemPresent") `
        -Actual (Get-PropertyValue -Object $actual -Name "RepoLocalSystemPresent") `
        -Failures $failures

    Test-EqualValue `
        -CaseName $caseName `
        -Label "RepoContextFiles count" `
        -Expected (Get-PropertyValue -Object $expected -Name "repoContextFilesCount") `
        -Actual @((Get-PropertyValue -Object $actual -Name "RepoContextFiles")).Count `
        -Failures $failures

    if (Test-HasProperty -Object $expected -Name "selectedCodexAdapter") {
        Test-EqualValue `
            -CaseName $caseName `
            -Label "SelectedCodexAdapter" `
            -Expected (Get-PropertyValue -Object $expected -Name "selectedCodexAdapter") `
            -Actual (Get-PropertyValue -Object $actual -Name "SelectedCodexAdapter") `
            -Failures $failures
    }

    if (Test-HasProperty -Object $expected -Name "projectPathResolvedSuffix") {
        $resolvedProjectPath = [string](Get-PropertyValue -Object $actual -Name "ProjectPath")
        $expectedSuffix = [string](Get-PropertyValue -Object $expected -Name "projectPathResolvedSuffix")
        if (-not $resolvedProjectPath.Replace("/", "\").EndsWith($expectedSuffix.Replace("/", "\"), [System.StringComparison]::OrdinalIgnoreCase)) {
            Add-Failure -Failures $failures -CaseName $caseName -Message (
                "ProjectPath suffix mismatch. Expected suffix '$expectedSuffix' but got '$resolvedProjectPath'."
            )
        }
    }

    if (Test-HasProperty -Object $expected -Name "repoContextFileSuffixes") {
        Test-PathSuffixes `
            -CaseName $caseName `
            -Label "RepoContextFiles" `
            -ExpectedSuffixes @((Get-PropertyValue -Object $expected -Name "repoContextFileSuffixes")) `
            -ActualPaths @((Get-PropertyValue -Object $actual -Name "RepoContextFiles")) `
            -Failures $failures
    }

    if (Test-HasProperty -Object $expected -Name "kickoffPrompt") {
        Test-EqualValue `
            -CaseName $caseName `
            -Label "KickoffPrompt" `
            -Expected (Get-PropertyValue -Object $expected -Name "kickoffPrompt") `
            -Actual (Get-PropertyValue -Object $actual -Name "KickoffPrompt") `
            -Failures $failures
    }

    if ($failures.Count -eq 0) {
        $passed++
        Write-Host "[PASS] $caseName" -ForegroundColor Green
    } else {
        $caseFailureCount = @($failures | Where-Object { $_ -like "[$caseName]*" }).Count
        if ($caseFailureCount -eq 0) {
            $passed++
            Write-Host "[PASS] $caseName" -ForegroundColor Green
        } else {
            Write-Host "[FAIL] $caseName" -ForegroundColor Red
        }
    }
}

if ($failures.Count -gt 0) {
    $message = @(
        "resolve-local-stack regression tests failed."
        ""
        $failures
    ) -join [Environment]::NewLine

    throw $message
}

Write-Host ""
Write-Host "resolve-local-stack regression tests passed. Cases: $passed" -ForegroundColor Cyan
