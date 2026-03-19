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

$launchScriptPath = Join-Path $Root "tools\launch-babel-local.ps1"
$fixturePath = Join-Path $Root "tests\fixtures\launch-babel-local\launch-cases.json"

foreach ($requiredPath in @($launchScriptPath, $fixturePath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required file not found: $requiredPath"
    }
}

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$shellPath = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object]$Expected,

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
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Test-ExactSequence {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [AllowNull()]
        [object[]]$Expected,

        [AllowNull()]
        [object[]]$Actual
    )

    $expectedNormalized = @($Expected | ForEach-Object { [string]$_ })
    $actualNormalized = @($Actual | ForEach-Object { [string]$_ })

    if (($expectedNormalized -join " || ") -ne ($actualNormalized -join " || ")) {
        throw "$Label mismatch.`nExpected: $($expectedNormalized -join ', ')`nActual: $($actualNormalized -join ', ')"
    }
}

function Get-OptionalStringField {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $null -eq $property.Value) {
        return ""
    }

    return [string]$property.Value
}

function Invoke-Launch {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShellPath,

        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot,

        [Parameter(Mandatory = $true)]
        [string]$OutputRoot,

        [Parameter(Mandatory = $true)]
        [object]$ParamsObject
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $args = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $ScriptPath,
            "-Root", $RepoRoot,
            "-OutputRoot", $OutputRoot,
            "-TaskCategory", [string]$ParamsObject.taskCategory,
            "-Project", [string]$ParamsObject.project,
            "-Model", [string]$ParamsObject.model,
            "-WorkMode", [string]$ParamsObject.workMode,
            "-TaskPrompt", [string]$ParamsObject.taskPrompt,
            "-Format", "json"
        )

        $providedSessionId = Get-OptionalStringField -Object $ParamsObject -Name "sessionId"
        if (-not [string]::IsNullOrWhiteSpace($providedSessionId)) {
            $args += @("-SessionId", $providedSessionId)
        }

        $quotedArgs = @(
            $args |
                ForEach-Object {
                    $text = [string]$_
                    if ($text -match '[\s"`]') {
                        '"' + ($text.Replace('"', '\"')) + '"'
                    } else {
                        $text
                    }
                }
        ) -join " "

        $process = Start-Process `
            -FilePath $ShellPath `
            -ArgumentList $quotedArgs `
            -Wait `
            -PassThru `
            -NoNewWindow `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            Stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
            Stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
        }
    } finally {
        Remove-Item -Path $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Convert-ToDeterministicSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Result
    )

    return [PSCustomObject]@{
        ClientSurface = [string]$Result.ClientSurface
        WorkMode = [string]$Result.WorkMode
        SessionId = [string]$Result.SessionId
        SelectedCodexAdapter = [string]$Result.SelectedCodexAdapter
        RecommendedStackIds = @($Result.RecommendedStackIds | ForEach-Object { [string]$_ })
        WorkModeDirective = [string]$Result.WorkModeDirective
        LaunchPrompt = [string]$Result.LaunchPrompt
        EndSuccess = [string]$Result.EndSessionCommands.Success
        EndFailed = [string]$Result.EndSessionCommands.Failed
        EndAbandoned = [string]$Result.EndSessionCommands.Abandoned
    }
}

$fixtureSpec = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
$cases = @($fixtureSpec.cases)
if ($cases.Count -eq 0) {
    throw "Fixture file '$fixturePath' does not define any launch cases."
}

$outputRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("babel-launch-test-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null

try {
    foreach ($case in $cases) {
        $caseName = [string]$case.name
        $paramsObject = $case.params
        $expected = $case.expected

        $firstRun = Invoke-Launch `
            -ShellPath $shellPath `
            -ScriptPath $launchScriptPath `
            -RepoRoot $Root `
            -OutputRoot $outputRoot `
            -ParamsObject $paramsObject

        if ($firstRun.ExitCode -ne 0) {
            $stderr = if ([string]::IsNullOrWhiteSpace($firstRun.Stderr)) { "(no stderr)" } else { $firstRun.Stderr.Trim() }
            throw "$caseName exit code (first run) mismatch. Expected 0 but got $($firstRun.ExitCode). stderr: $stderr"
        }
        $firstResult = $firstRun.Stdout | ConvertFrom-Json

        $secondRun = Invoke-Launch `
            -ShellPath $shellPath `
            -ScriptPath $launchScriptPath `
            -RepoRoot $Root `
            -OutputRoot $outputRoot `
            -ParamsObject $paramsObject

        if ($secondRun.ExitCode -ne 0) {
            $stderr = if ([string]::IsNullOrWhiteSpace($secondRun.Stderr)) { "(no stderr)" } else { $secondRun.Stderr.Trim() }
            throw "$caseName exit code (second run) mismatch. Expected 0 but got $($secondRun.ExitCode). stderr: $stderr"
        }
        $secondResult = $secondRun.Stdout | ConvertFrom-Json

        Assert-Equal -Label "$caseName client surface" -Expected $expected.clientSurface -Actual $firstResult.ClientSurface
        Assert-Equal -Label "$caseName work mode" -Expected $expected.workMode -Actual $firstResult.WorkMode
        Assert-Equal -Label "$caseName selected codex adapter" -Expected $expected.selectedCodexAdapter -Actual $firstResult.SelectedCodexAdapter

        Test-ExactSequence `
            -Label "$caseName recommended stack IDs" `
            -Expected @($expected.recommendedStackIds) `
            -Actual @($firstResult.RecommendedStackIds)

        $modeDirectiveFragment = [string]$expected.workModeDirectiveContains
        Assert-True `
            -Condition ([string]$firstResult.WorkModeDirective).Contains($modeDirectiveFragment) `
            -Message "$caseName work mode directive did not include '$modeDirectiveFragment'."

        foreach ($fragment in @($expected.launchPromptContains)) {
            Assert-True `
                -Condition ([string]$firstResult.LaunchPrompt).Contains([string]$fragment) `
                -Message "$caseName launch prompt did not include '$fragment'."
        }

        $providedSessionId = Get-OptionalStringField -Object $paramsObject -Name "sessionId"
        $expectedSessionId = Get-OptionalStringField -Object $expected -Name "sessionId"
        $expectedSessionIdPrefix = Get-OptionalStringField -Object $expected -Name "sessionIdPrefix"
        if ([string]::IsNullOrWhiteSpace($expectedSessionId) -and -not [string]::IsNullOrWhiteSpace($providedSessionId)) {
            $expectedSessionId = $providedSessionId
        }

        if (-not [string]::IsNullOrWhiteSpace($expectedSessionId)) {
            Assert-Equal -Label "$caseName session ID" -Expected $expectedSessionId -Actual $firstResult.SessionId
        } else {
            Assert-True `
                -Condition (-not [string]::IsNullOrWhiteSpace([string]$firstResult.SessionId)) `
                -Message "$caseName session ID was unexpectedly empty."
        }

        $resolvedSessionId = [string]$firstResult.SessionId
        if (-not [string]::IsNullOrWhiteSpace($expectedSessionIdPrefix)) {
            Assert-True `
                -Condition $resolvedSessionId.StartsWith($expectedSessionIdPrefix) `
                -Message "$caseName session ID did not start with '$expectedSessionIdPrefix'."
        }

        $expectedCommandFragment = "-SessionId $resolvedSessionId"
        Assert-True `
            -Condition ([string]$firstResult.EndSessionCommands.Success).Contains($expectedCommandFragment) `
            -Message "$caseName end-session success command did not include expected session ID."

        Assert-Equal -Label "$caseName raw bundle env session ID" -Expected $resolvedSessionId -Actual $firstResult.RawBundleEnvironment.SessionId
        Assert-True `
            -Condition (-not [string]::IsNullOrWhiteSpace([string]$firstResult.RawBundleEnvironment.SessionStartPath)) `
            -Message "$caseName raw bundle session start path was unexpectedly empty."
        Assert-Equal -Label "$caseName raw bundle local learning root" -Expected $outputRoot -Actual $firstResult.RawBundleEnvironment.LocalLearningRoot
        Assert-True `
            -Condition ([string]$firstResult.RawBundleEnvironment.PowerShellCommands.SessionId).Contains("BABEL_SESSION_ID") `
            -Message "$caseName raw bundle SessionId env command was missing."
        Assert-True `
            -Condition ([string]$firstResult.RawBundleEnvironment.PowerShellCommands.SessionStartPath).Contains("BABEL_SESSION_START_PATH") `
            -Message "$caseName raw bundle session-start env command was missing."
        Assert-True `
            -Condition ([string]$firstResult.RawBundleEnvironment.PowerShellCommands.LocalLearningRoot).Contains("BABEL_LOCAL_LEARNING_ROOT") `
            -Message "$caseName raw bundle local-root env command was missing."

        $sessionStartMatch = @(
            Get-ChildItem -Path (Join-Path $outputRoot "session-starts") -Recurse -File -Filter ($resolvedSessionId + ".json") |
                Select-Object -First 1
        )
        Assert-True -Condition ($null -ne $sessionStartMatch) -Message "$caseName session-start artifact was not created."

        $firstSnapshot = Convert-ToDeterministicSnapshot -Result $firstResult
        $secondSnapshot = Convert-ToDeterministicSnapshot -Result $secondResult
        $firstSnapshotJson = $firstSnapshot | ConvertTo-Json -Depth 6 -Compress
        $secondSnapshotJson = $secondSnapshot | ConvertTo-Json -Depth 6 -Compress
        Assert-Equal -Label "$caseName deterministic repeat output" -Expected $firstSnapshotJson -Actual $secondSnapshotJson
    }

    Write-Host "launch-babel-local regression tests passed." -ForegroundColor Cyan
} finally {
    Remove-Item -Path $outputRoot -Recurse -Force -ErrorAction SilentlyContinue
}
