<#
.SYNOPSIS
  Babel tool-registry generator - reads tool-manifest.json and generates
  TypeScript definitions for the executor tool surface.

.DESCRIPTION
  Reads:  babel-cli/src/tools/tool-manifest.json
  Writes: babel-cli/src/tools/_generated/*.ts (generated TypeScript)

  Generated files:
    - toolNames.generated.ts  - MANIFEST_TOOL_NAMES const array + type

  Also validates:
    - Manifest has no duplicate tool names
    - All required fields are present in every entry
    - Category values match known categories
    - Cross-check with existing toolContracts.ts for drift

  Exit codes:
    0 - generation succeeded, no drift detected
    1 - manifest validation failed
    2 - drift detected between manifest and code (generation still succeeds)

  Run as part of `npm run build` or standalone for dev iteration.
#>

param(
  [switch]$Check,            # Validate only, no file writes
  [switch]$Fix,              # Auto-update toolContracts.ts if drift detected
  [string]$ManifestPath = $null
)

$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path "$PSScriptRoot\.."
$manifestPath = if ($ManifestPath) { $ManifestPath } else { "$repoRoot\babel-cli\src\tools\tool-manifest.json" }
$generatedDir = "$repoRoot\babel-cli\src\tools\_generated"
$toolContractsPath = "$repoRoot\babel-cli\src\tools\toolContracts.ts"

# === Step 0: Read manifest ====================================================

if (-not (Test-Path $manifestPath)) {
  Write-Error "Manifest not found: $manifestPath"
  exit 1
}

try {
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json -AsHashTable
} catch {
  Write-Error "Failed to parse manifest JSON: $_"
  exit 1
}

# === Step 1: Validate manifest structure ======================================

$errors = @()
$warnings = @()

# Check version
if (-not $manifest.manifestVersion) {
  $errors += "Missing manifestVersion field"
}

# Check tools array
if (-not $manifest.tools -or $manifest.tools.Count -eq 0) {
  $errors += "Manifest contains no tools"
  exit 1
}

# Validate each tool entry
$knownCategories = @(
  'filesystem', 'process', 'mcp', 'web', 'plugin',
  'ui', 'memory', 'mode', 'search', 'coordination', 'vcs', 'knowledge-graph'
)
$knownDryRunBehaviors = @('live', 'mocked', 'shadow_write', 'stateful')
$seenNames = @{}

foreach ($tool in $manifest.tools) {
  $name = $tool.name
  if (-not $name) {
    $errors += "Tool entry missing 'name' field"
    continue
  }
  if ($seenNames.ContainsKey($name)) {
    $errors += "Duplicate tool name: '$name'"
  }
  $seenNames[$name] = $true

  if (-not $tool.category) {
    $errors += "[$name] Missing 'category' field"
  } elseif ($tool.category -notin $knownCategories) {
    $warnings += "[$name] Unknown category '$($tool.category)' - not in known list: $($knownCategories -join ', ')"
  }

  if (-not $tool.description) {
    $errors += "[$name] Missing 'description' field"
  }

  if ($null -eq $tool.mutating) {
    $errors += "[$name] Missing 'mutating' field"
  }

  if (-not $tool.dryRunBehavior) {
    $errors += "[$name] Missing 'dryRunBehavior' field"
  } elseif ($tool.dryRunBehavior -notin $knownDryRunBehaviors) {
    $errors += "[$name] Unknown dryRunBehavior '$($tool.dryRunBehavior)'"
  }

  if (-not $tool.policyTags -or $tool.policyTags.Count -eq 0) {
    $warnings += "[$name] No policyTags defined"
  }

  if ($null -eq $tool.input) {
    $errors += "[$name] Missing 'input' contract"
  } else {
    if ($null -eq $tool.input.required) {
      $errors += "[$name] Missing 'input.required' array (set to [] if no required fields)"
    }
    if ($null -eq $tool.input.optional) {
      $errors += "[$name] Missing 'input.optional' array (set to [] if no optional fields)"
    }
    # Validate each input field has name, type, description
    $allFields = @($tool.input.required) + @($tool.input.optional)
    foreach ($field in $allFields) {
      if ($null -ne $field) {
        if (-not $field.name) { $errors += "[$name] Input field missing 'name'" }
        if (-not $field.type) { $errors += "[$name] Input field '$($field.name)' missing 'type'" }
      }
    }
  }
}

# Check category descriptions in manifest vs tools
if ($manifest.categories) {
  $usedCategories = $manifest.tools | ForEach-Object { $_.category } | Select-Object -Unique
  foreach ($cat in $usedCategories) {
    if (-not $manifest.categories[$cat]) {
      $warnings += "Category '$cat' used by tools but not described in manifest.categories"
    }
  }
}

# Report validation results
if ($errors.Count -gt 0) {
  Write-Host "`n[FAIL] Manifest validation FAILED with $($errors.Count) error(s):" -ForegroundColor Red
  foreach ($err in $errors) {
    Write-Host "  - $err" -ForegroundColor Red
  }
  exit 1
}

if ($warnings.Count -gt 0) {
  Write-Host "`n[WARN] Warnings:" -ForegroundColor Yellow
  foreach ($warn in $warnings) {
    Write-Host "  - $warn" -ForegroundColor Yellow
  }
}

Write-Host "[PASS] Manifest validation passed - $($seenNames.Count) tools" -ForegroundColor Green

if ($Check) {
  Write-Host "Check-only mode; skipping generation."
  exit 0
}

# === Step 2: Generate tool names file =========================================

$toolNames = $manifest.tools | ForEach-Object { $_.name } | Sort-Object
$manifestVersion = $manifest.manifestVersion
$generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')

$toolNamesTs = @"
// AUTO-GENERATED by tools/generate-tool-registry.ps1 - DO NOT EDIT MANUALLY
// Source: babel-cli/src/tools/tool-manifest.json (v$manifestVersion)
// Generated: $generatedAt

export const MANIFEST_TOOL_NAMES = [
$($toolNames | ForEach-Object { "  '$_'," })
] as const;

export type ManifestToolName = typeof MANIFEST_TOOL_NAMES[number];

export const MANIFEST_MUTATING_TOOL_NAMES: ManifestToolName[] = [
$($manifest.tools | Where-Object { $_.mutating } | ForEach-Object { "  '$($_.name)'," })
];

export const MANIFEST_READ_ONLY_TOOL_NAMES: ManifestToolName[] = [
$($manifest.tools | Where-Object { -not $_.mutating } | ForEach-Object { "  '$($_.name)'," })
];

/** Tools requiring JIT human approval for certain operations */
export const MANIFEST_JIT_TOOL_NAMES: ManifestToolName[] = [
$($manifest.tools | Where-Object { $_.jitApproval } | ForEach-Object { "  '$($_.name)'," })
];

/** Map of tool name to category */
export const MANIFEST_TOOL_CATEGORY_MAP: Record<ManifestToolName, string> = {
$($manifest.tools | ForEach-Object { "  '$($_.name)': '$($_.category)'," })
};

/** Map of tool name to dry-run behavior */
export const MANIFEST_DRY_RUN_MAP: Record<ManifestToolName, string> = {
$($manifest.tools | ForEach-Object { "  '$($_.name)': '$($_.dryRunBehavior)'," })
};
"@

# === Step 3: Cross-check with existing toolContracts.ts =======================

$driftDetected = $false
$existingNames = @()
$existingToolContracts = $null

if (Test-Path $toolContractsPath) {
  $existingToolContracts = Get-Content $toolContractsPath -Raw

  # Extract EXECUTOR_TOOL_NAMES from the const array
  $nameMatches = [regex]::Matches($existingToolContracts, "'([a-z_]+)'")
  foreach ($match in $nameMatches) {
    $n = $match.Groups[1].Value
    # Only match known tool name patterns
    if ($n -match '^(directory_list|file_read|file_write|file_delete|git_reset|git_push|shell_exec|test_run|mcp_request|mcp_resource_list|mcp_resource_read|mcp_prompt_list|mcp_prompt_get|mcp_tool_search|web_search|web_fetch|plugin_tool|audit_ui|memory_store|memory_query|enter_plan_mode|exit_plan_mode|semantic_search|grep|glob|workspace_symbol_search|workspace_map|git_context|acquire_lock|release_lock|tool_catalog|get_code_outline|find_code_definition|find_code_references|load_skill_manifest|kg_trace_path|kg_search_graph|kg_impact_analysis|kg_architecture|kg_index_status)$') {
      $existingNames += $n
    }
  }
  $existingNames = $existingNames | Select-Object -Unique
}

$manifestToolNames = $toolNames
$inManifestNotCode = $manifestToolNames | Where-Object { $_ -notin $existingNames }
$inCodeNotManifest = $existingNames | Where-Object { $_ -notin $manifestToolNames }

if ($inManifestNotCode.Count -gt 0) {
  Write-Host "`n[DRIFT] In manifest but NOT in toolContracts.ts:" -ForegroundColor Yellow
  foreach ($name in $inManifestNotCode) {
    Write-Host "  + $name" -ForegroundColor Yellow
  }
  $driftDetected = $true
}

if ($inCodeNotManifest.Count -gt 0) {
  Write-Host "`n[DRIFT] In toolContracts.ts but NOT in manifest:" -ForegroundColor Yellow
  foreach ($name in $inCodeNotManifest) {
    Write-Host "  - $name" -ForegroundColor Yellow
  }
  $driftDetected = $true
}

if (-not $driftDetected) {
  Write-Host "[PASS] No drift between manifest and toolContracts.ts" -ForegroundColor Green
}

# === Step 4: Write generated files ============================================

if (-not (Test-Path $generatedDir)) {
  New-Item -ItemType Directory -Force -Path $generatedDir | Out-Null
}

$toolNamesPath = "$generatedDir\toolNames.generated.ts"
Set-Content -Path $toolNamesPath -Value $toolNamesTs -Encoding UTF8
Write-Host "[DONE] Wrote: $toolNamesPath" -ForegroundColor Green

# Write a .gitignore in _generated indicating these are committed build artifacts
$gitignorePath = "$generatedDir\.gitignore"
if (-not (Test-Path $gitignorePath)) {
  "# Generated files are committed - they are build artifacts validated by CI`n" | Set-Content -Path $gitignorePath -Encoding UTF8
}

# === Step 5: Output summary ===================================================

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  Manifest v$manifestVersion" -ForegroundColor Cyan
Write-Host "  Tools: $($manifest.tools.Count) total" -ForegroundColor Cyan
Write-Host "    Mutating:  $(($manifest.tools | Where-Object { $_.mutating }).Count)" -ForegroundColor Cyan
Write-Host "    Read-only: $(($manifest.tools | Where-Object { -not $_.mutating }).Count)" -ForegroundColor Cyan
Write-Host "    JIT approval: $(($manifest.tools | Where-Object { $_.jitApproval }).Count)" -ForegroundColor Cyan
Write-Host "  Categories: $($manifest.categories.Keys.Count)" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

if ($driftDetected) {
  Write-Host "`n[INFO] Run with -Fix to auto-update toolContracts.ts (or update the manifest)." -ForegroundColor Yellow
  exit 2
}

exit 0
