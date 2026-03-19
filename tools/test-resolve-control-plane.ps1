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

$resolverPath = Join-Path $Root "tools\resolve-control-plane.ps1"
$casesPath = Join-Path $Root "tests\fixtures\resolve-control-plane-cases.json"
$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$shellPath = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
}

foreach ($requiredPath in @($resolverPath, $casesPath)) {
    if (-not (Test-Path $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
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

function Normalize-Sequence {
    param(
        [AllowNull()]
        [object[]]$Items
    )

    return @(
        @($Items) |
            ForEach-Object { [string]$_ } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
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

foreach ($case in @($caseSpec.cases)) {
    $caseName = [string]$case.name
    $expected = $case.expected
    $args = @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $resolverPath,
        "-RepoPath", $Root,
        "-Model", [string]$case.model,
        "-TaskMode", [string]$case.taskMode,
        "-ToolCanWriteFiles", ([string]$case.toolCanWriteFiles).ToLowerInvariant(),
        "-ApprovalMode", [string]$case.approvalMode,
        "-OutputFormat", "json"
    )

    $invocation = Invoke-Resolver -ShellPath $shellPath -ArgumentList $args
    if ($invocation.ExitCode -ne 0) {
        $stderr = if ([string]::IsNullOrWhiteSpace($invocation.Stderr)) { "(no stderr)" } else { $invocation.Stderr.Trim() }
        Add-Failure -Failures $failures -CaseName $caseName -Message "Resolver exited with code $($invocation.ExitCode). stderr: $stderr"
        Write-Host "[FAIL] $caseName" -ForegroundColor Red
        continue
    }

    $actual = $invocation.Stdout | ConvertFrom-Json

    $failureCountBefore = $failures.Count

    Test-EqualValue `
        -CaseName $caseName `
        -Label "guard_requested" `
        -Expected $expected.guardRequested `
        -Actual $actual.guard_requested `
        -Failures $failures

    Test-EqualValue `
        -CaseName $caseName `
        -Label "guard_suppressed" `
        -Expected $expected.guardSuppressed `
        -Actual $actual.guard_suppressed `
        -Failures $failures

    Test-EqualValue `
        -CaseName $caseName `
        -Label "guard_loaded" `
        -Expected $expected.guardLoaded `
        -Actual $actual.guard_loaded `
        -Failures $failures

    Test-ExactSequence `
        -CaseName $caseName `
        -Label "guard_reasons" `
        -Expected @($expected.guardReasons) `
        -Actual @($actual.guard_reasons) `
        -Failures $failures

    Test-PathSuffixes `
        -CaseName $caseName `
        -Label "effective_load_files" `
        -ExpectedSuffixes @($expected.effectiveLoadFileSuffixes) `
        -ActualPaths @($actual.effective_load_files) `
        -Failures $failures

    $currentCaseFailures = $failures.Count - $failureCountBefore
    if ($currentCaseFailures -eq 0) {
        $passed++
        Write-Host "[PASS] $caseName" -ForegroundColor Green
    } else {
        Write-Host "[FAIL] $caseName" -ForegroundColor Red
    }
}

if ($failures.Count -gt 0) {
    $message = @(
        "resolve-control-plane regression tests failed."
        ""
        $failures
    ) -join [Environment]::NewLine

    throw $message
}

Write-Host ""
Write-Host "resolve-control-plane regression tests passed. Cases: $passed" -ForegroundColor Cyan
