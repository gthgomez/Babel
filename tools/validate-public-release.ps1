[CmdletBinding()]
param(
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

$cliRoot = Join-Path $Root "babel-cli"
if (-not (Test-Path -LiteralPath $cliRoot)) {
    throw "babel-cli directory not found at $cliRoot"
}

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string]$Workdir
    )

    Write-Host ""
    Write-Host "==> $Label" -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -Command $Command
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode"
    }
}

Invoke-Step -Label "Public scrub check" -Command "& '$Root\\tools\\check-public-scrub.ps1' -RepoRoot '$Root'" -Workdir $Root
Invoke-Step -Label "Catalog validation" -Command "& '$Root\\tools\\validate-catalog.ps1'" -Workdir $Root
Invoke-Step -Label "TypeScript typecheck" -Command "Set-Location '$cliRoot'; npm run typecheck" -Workdir $cliRoot
Invoke-Step -Label "Resolver regression tests" -Command "Set-Location '$cliRoot'; npm run test:resolver" -Workdir $cliRoot
Invoke-Step -Label "Manifest preview regression tests" -Command "Set-Location '$cliRoot'; npm run test:manifest-preview" -Workdir $cliRoot
Invoke-Step -Label "Orchestrator routing regression tests" -Command "Set-Location '$cliRoot'; npm run test:orchestrator-routing" -Workdir $cliRoot
Invoke-Step -Label "MCP adapter regression tests" -Command "Set-Location '$cliRoot'; npm run test:mcp-adapter" -Workdir $cliRoot
Invoke-Step -Label "Backend wrapper preview smoke test" -Command "& '$Root\\tools\\resolve-local-stack.ps1' -TaskCategory backend -Project example_saas_backend -Model codex -PipelineMode verified -Format json | Out-Null" -Workdir $Root
Invoke-Step -Label "Android wrapper preview smoke test" -Command "& '$Root\\tools\\resolve-local-stack.ps1' -TaskCategory mobile -Project example_mobile_suite -Model codex -SkillIds skill_android_pdf_processing -Format json | Out-Null" -Workdir $Root

Write-Host ""
Write-Host "Public release validation passed." -ForegroundColor Green
