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

$graderPath = Join-Path $Root "tools\test-eval-quality-fixtures.ps1"
if (-not (Test-Path -LiteralPath $graderPath)) {
    throw "Fixture grader script not found at $graderPath"
}

$preferredShell = Get-Command pwsh -ErrorAction SilentlyContinue
$shellPath = if ($null -ne $preferredShell) {
    $preferredShell.Source
} else {
    (Get-Command powershell -ErrorAction Stop).Source
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

function Invoke-JsonGrader {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ShellPath,

        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,

        [Parameter(Mandatory = $true)]
        [string]$RepoRoot
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $args = @(
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-File", $ScriptPath,
            "-Root", $RepoRoot,
            "-Format", "json"
        )

        $process = Start-Process `
            -FilePath $ShellPath `
            -ArgumentList $args `
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

$result = Invoke-JsonGrader -ShellPath $shellPath -ScriptPath $graderPath -RepoRoot $Root
Assert-Equal -Label "grader exit code" -Expected 0 -Actual $result.ExitCode

$stdout = $result.Stdout
Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($stdout)) -Message "Expected JSON output on stdout, but stdout was empty."
Assert-True `
    -Condition (-not $stdout.Contains("Phase 4 eval fixture grading passed.")) `
    -Message "JSON mode output included text-mode success content."

$trimmed = $stdout.TrimEnd()
Assert-True -Condition $trimmed.EndsWith("}", [System.StringComparison]::Ordinal) -Message "JSON mode output had trailing non-whitespace text."

try {
    $json = $stdout | ConvertFrom-Json
} catch {
    throw "JSON mode output was not parseable: $($_.Exception.Message)"
}

Assert-Equal -Label "ExpectationMismatchCount" -Expected 0 -Actual $json.ExpectationMismatchCount
Assert-Equal -Label "FixtureCount/Results count parity" -Expected $json.FixtureCount -Actual @($json.Results).Count
Assert-True -Condition ($json.FixtureCount -gt 0) -Message "Expected at least one fixture in JSON output."

Write-Host "eval-quality-fixtures JSON output regression test passed." -ForegroundColor Cyan
