[CmdletBinding()]
param(
    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-DomainDefaultSkillMap {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CatalogPath
    )

    $lines = Get-Content -Path $CatalogPath
    $map = @{}
    $currentDomain = $null
    $inDefaults = $false

    foreach ($line in $lines) {
        if ($line -match '^\s*-\s+id:\s+(domain_\S+)') {
            $currentDomain = $matches[1].Trim()
            $inDefaults = $false
            continue
        }

        if ($null -eq $currentDomain) {
            continue
        }

        if ($line -match '^\s+default_skill_ids:\s*$') {
            $inDefaults = $true
            $map[$currentDomain] = New-Object System.Collections.Generic.List[string]
            continue
        }

        if ($inDefaults -and $line -match '^\s+-\s+(skill_\S+)') {
            $map[$currentDomain].Add($matches[1].Trim())
            continue
        }

        if ($inDefaults -and $line -match '^\s+\w') {
            $inDefaults = $false
        }
    }

    return $map
}

function Assert-NotContains {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,

        [Parameter(Mandatory = $true)]
        [string[]]$Values,

        [Parameter(Mandatory = $true)]
        [string]$Forbidden
    )

    if ($Values -contains $Forbidden) {
        throw "$Label must not include $Forbidden"
    }
}

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

$catalogPath = Join-Path $Root "prompt_catalog.yaml"
if (-not (Test-Path -LiteralPath $catalogPath)) {
    throw "prompt_catalog.yaml not found at $catalogPath"
}

$defaults = Get-DomainDefaultSkillMap -CatalogPath $catalogPath
$allDefaultSkills = @($defaults.Values | ForEach-Object { $_ } | Select-Object -Unique)

foreach ($skillId in $allDefaultSkills) {
    if ($skillId -like 'skill_x_*') {
        throw "X marketing skill must not appear in domain default_skill_ids: $skillId"
    }
}

$android = $defaults['domain_android_kotlin']
if ($null -eq $android) {
    throw 'domain_android_kotlin default_skill_ids missing'
}

foreach ($forbidden in @(
    'skill_android_testing_strategy',
    'skill_android_unit_testing',
    'skill_android_screenshot_testing',
    'skill_android_instrumented_testing',
    'skill_android_test_enforcement_deep'
)) {
    Assert-NotContains -Label 'domain_android_kotlin defaults' -Values $android -Forbidden $forbidden
}

if ($android -notcontains 'skill_android_testing_obligation') {
    throw 'domain_android_kotlin must default skill_android_testing_obligation'
}

$llmRouter = $defaults['domain_llm_router']
Assert-NotContains -Label 'domain_llm_router defaults' -Values $llmRouter -Forbidden 'skill_sse_streaming'
Assert-NotContains -Label 'domain_llm_router defaults' -Values $llmRouter -Forbidden 'skill_deno_edge_functions'

$research = $defaults['domain_research']
Assert-NotContains -Label 'domain_research defaults' -Values $research -Forbidden 'skill_product_reality_audit'

$python = $defaults['domain_python_backend']
Assert-NotContains -Label 'domain_python_backend defaults' -Values $python -Forbidden 'skill_ops_observability'

$godot = $defaults['domain_godot_game_dev']
Assert-NotContains -Label 'domain_godot_game_dev defaults' -Values $godot -Forbidden 'skill_godot_ui_theme'
Assert-NotContains -Label 'domain_godot_game_dev defaults' -Values $godot -Forbidden 'skill_godot_data_resources'

Write-Host "Domain default policy regression tests passed." -ForegroundColor Cyan
