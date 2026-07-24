[CmdletBinding()]
param(
    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-RelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return ($Path -replace '\\', '/').TrimStart('./')
}

function Get-SkillLayerPathsFromCatalog {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CatalogPath
    )

    $lines = Get-Content -Path $CatalogPath
    $paths = New-Object System.Collections.Generic.List[string]
    $currentLayer = $null

    foreach ($line in $lines) {
        if ($line -match '^\s+layer:\s+(.+)$') {
            $currentLayer = $matches[1].Trim()
            continue
        }

        if ($line -match '^\s+path:\s+(.+)$') {
            if ($currentLayer -eq 'skill') {
                $paths.Add((Normalize-RelativePath -Path $matches[1].Trim().Trim('"')))
            }
            continue
        }

        if ($line -match '^\s*-\s+id:\s+') {
            $currentLayer = $null
        }
    }

    return [string[]]$paths.ToArray()
}

function Get-ActivePromptSkillPathsOnDisk {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SkillsRoot
    )

    $results = New-Object System.Collections.Generic.List[string]
    $skillsRootFull = (Resolve-Path -LiteralPath $SkillsRoot).Path

    foreach ($file in Get-ChildItem -LiteralPath $skillsRootFull -Recurse -File -Filter "*.md") {
        if ($file.Name -eq "README.md") {
            continue
        }

        $relative = Normalize-RelativePath -Path ("02_Skills/" + $file.FullName.Substring($skillsRootFull.Length).TrimStart('\', '/'))
        $results.Add($relative)
    }

    return [string[]]$results.ToArray()
}

function Add-Message {
    param(
        [System.Collections.Generic.List[string]]$Bucket,
        [string]$Message
    )

    $Bucket.Add($Message)
}

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

$catalogPath = Join-Path $Root "prompt_catalog.yaml"
$skillsRoot = Join-Path $Root "02_Skills"

if (-not (Test-Path -LiteralPath $catalogPath)) {
    Write-Error "prompt_catalog.yaml not found at $catalogPath"
    exit 1
}

if (-not (Test-Path -LiteralPath $skillsRoot)) {
    Write-Error "02_Skills directory not found at $skillsRoot"
    exit 1
}

$catalogSkillPaths = [string[]](Get-SkillLayerPathsFromCatalog -CatalogPath $catalogPath)
$catalogSet = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($path in $catalogSkillPaths) {
    [void]$catalogSet.Add($path)
}

$diskSkillPaths = [string[]](Get-ActivePromptSkillPathsOnDisk -SkillsRoot $skillsRoot)
$errors = New-Object System.Collections.Generic.List[string]

foreach ($diskPath in $diskSkillPaths) {
    if (-not $catalogSet.Contains($diskPath)) {
        Add-Message -Bucket $errors -Message "Unregistered prompt-layer skill on disk (not in prompt_catalog.yaml layer: skill): $diskPath"
    }
}

foreach ($catalogPath in $catalogSkillPaths) {
    $fullPath = Join-Path $Root $catalogPath
    if (-not (Test-Path -LiteralPath $fullPath)) {
        Add-Message -Bucket $errors -Message "Cataloged skill missing on disk under 02_Skills: $catalogPath"
    }
}

if ($errors.Count -gt 0) {
    Write-Host "Skill disk drift errors:" -ForegroundColor Red
    foreach ($message in $errors) {
        Write-Host "  - $message" -ForegroundColor Red
    }
}

$summaryColor = if ($errors.Count -gt 0) { 'Red' } else { 'Green' }
Write-Host "Skill disk drift summary:" -ForegroundColor $summaryColor
Write-Host "  Catalog skill paths: $($catalogSkillPaths.Count)"
Write-Host "  Active disk skill files: $($diskSkillPaths.Count)"
Write-Host "  Errors: $($errors.Count)"

if ($errors.Count -eq 0) {
    Write-Host "Skill disk drift audit passed." -ForegroundColor Green
    exit 0
}

exit 1
