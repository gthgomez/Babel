[CmdletBinding()]
param(
    [string]$Root = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function New-EntryObject {
    param(
        [string]$Id,
        [int]$Line
    )

    return [PSCustomObject]@{
        Id              = $Id
        Line            = $Line
        Layer           = $null
        Path            = $null
        PathLine        = $null
        Status          = $null
        HasTokenBudget  = $false
        TokenBudget     = $null
        TokenBudgetLine = $null
        Dependencies    = New-Object System.Collections.Generic.List[string]
        Conflicts       = New-Object System.Collections.Generic.List[string]
        DefaultSkillIds = New-Object System.Collections.Generic.List[string]
    }
}

function Add-Message {
    param(
        [System.Collections.Generic.List[string]]$Bucket,
        [string]$Message
    )

    $Bucket.Add($Message)
}

function Parse-InlineArray {
    param(
        [string]$Value
    )

    $trimmed = $Value.Trim()
    if (-not $trimmed.StartsWith('[') -or -not $trimmed.EndsWith(']')) {
        return $null
    }

    $inner = $trimmed.Substring(1, $trimmed.Length - 2).Trim()
    if ([string]::IsNullOrWhiteSpace($inner)) {
        return @()
    }

    return @(
        $inner.Split(',') |
            ForEach-Object { $_.Trim().Trim('"') } |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
}

function Add-ListValues {
    param(
        [System.Collections.Generic.List[string]]$Target,
        [object[]]$Values
    )

    foreach ($value in $Values) {
        $Target.Add([string]$value)
    }
}

function Parse-Catalog {
    param(
        [string]$CatalogPath
    )

    $lines = Get-Content -Path $CatalogPath
    $entries = New-Object System.Collections.Generic.List[object]
    $current = $null

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]

        if ($line -match '^\s*-\s+id:\s+(.+)$') {
            if ($null -ne $current) {
                $entries.Add($current)
            }

            $current = New-EntryObject -Id $matches[1].Trim() -Line ($i + 1)
            continue
        }

        if ($null -eq $current) {
            continue
        }

        if ($line -match '^\s+layer:\s+(.+)$') {
            $current.Layer = $matches[1].Trim()
            continue
        }

        if ($line -match '^\s+path:\s+(.+)$') {
            $current.Path = $matches[1].Trim().Trim('"')
            $current.PathLine = $i + 1
            continue
        }

        if ($line -match '^\s+status:\s+(.+)$') {
            $current.Status = $matches[1].Trim()
            continue
        }

        if ($line -match '^\s+token_budget:\s+(.+)$') {
            $rawBudget = $matches[1].Trim()
            $parsedBudget = 0
            if ([int]::TryParse($rawBudget, [ref]$parsedBudget)) {
                $current.TokenBudget = $parsedBudget
            } else {
                $current.TokenBudget = $null
            }
            $current.HasTokenBudget = $true
            $current.TokenBudgetLine = $i + 1
            continue
        }

        if ($line -match '^\s+(dependencies|conflicts|default_skill_ids):\s*(.*)$') {
            $field = $matches[1]
            $rawValue = $matches[2]
            $values = Parse-InlineArray -Value $rawValue

            if ($null -eq $values) {
                $values = @()
                while (($i + 1) -lt $lines.Count) {
                    $nextLine = $lines[$i + 1]
                    if ($nextLine -notmatch '^\s{6,}-\s+(.+)$') {
                        break
                    }

                    $values += $matches[1].Trim()
                    $i++
                }
            }

            switch ($field) {
                'dependencies'     { Add-ListValues -Target $current.Dependencies -Values $values }
                'conflicts'        { Add-ListValues -Target $current.Conflicts -Values $values }
                'default_skill_ids' { Add-ListValues -Target $current.DefaultSkillIds -Values $values }
            }

            continue
        }
    }

    if ($null -ne $current) {
        $entries.Add($current)
    }

    return ,$entries
}

function Test-SkillDependencyCycles {
    param(
        [hashtable]$EntryById,
        [System.Collections.Generic.List[string]]$Errors
    )

    $visitState = @{}
    $stack = New-Object System.Collections.Generic.List[string]

    function Visit-Skill {
        param(
            [string]$SkillId
        )

        $state = $visitState[$SkillId]
        if ($state -eq 1) {
            $cycleStart = $stack.IndexOf($SkillId)
            $cyclePath = @()

            if ($cycleStart -ge 0) {
                for ($index = $cycleStart; $index -lt $stack.Count; $index++) {
                    $cyclePath += $stack[$index]
                }
            } else {
                $cyclePath += $SkillId
            }

            $cyclePath += $SkillId
            Add-Message -Bucket $Errors -Message ("Skill dependency cycle detected: " + ($cyclePath -join ' -> '))
            return
        }

        if ($state -eq 2) {
            return
        }

        $visitState[$SkillId] = 1
        $stack.Add($SkillId) | Out-Null

        $entry = $EntryById[$SkillId]
        foreach ($dependencyId in $entry.Dependencies) {
            if (-not $EntryById.ContainsKey($dependencyId)) {
                continue
            }

            $dependencyEntry = $EntryById[$dependencyId]
            if ($dependencyEntry.Layer -ne 'skill') {
                continue
            }

            Visit-Skill -SkillId $dependencyId
        }

        if ($stack.Count -gt 0) {
            $stack.RemoveAt($stack.Count - 1)
        }
        $visitState[$SkillId] = 2
    }

    foreach ($entryId in $EntryById.Keys) {
        $entry = $EntryById[$entryId]
        if ($entry.Layer -ne 'skill') {
            continue
        }
        Visit-Skill -SkillId $entryId
    }
}

if ([string]::IsNullOrWhiteSpace($Root)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Path $PSCommandPath -Parent }
    $Root = (Resolve-Path (Join-Path $scriptDir "..")).Path
} else {
    $Root = (Resolve-Path $Root).Path
}

$catalogPath = Join-Path $Root "prompt_catalog.yaml"

if (-not (Test-Path $catalogPath)) {
    Write-Error "prompt_catalog.yaml not found at $catalogPath"
    exit 1
}

$entries = Parse-Catalog -CatalogPath $catalogPath
$errors = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$duplicateGroups = $entries |
    Group-Object -Property Id |
    Where-Object { $_.Count -gt 1 }

foreach ($group in $duplicateGroups) {
    $linesText = ($group.Group | ForEach-Object { $_.Line }) -join ", "
    Add-Message -Bucket $errors -Message "Duplicate ID '$($group.Name)' at lines $linesText"
}

$entryById = @{}
foreach ($entry in $entries) {
    if (-not $entryById.ContainsKey($entry.Id)) {
        $entryById[$entry.Id] = $entry
    }
}

foreach ($entry in $entries) {
    if ($entry.Path) {
        $fullPath = Join-Path $Root $entry.Path
        if (-not (Test-Path $fullPath)) {
            Add-Message -Bucket $errors -Message "Missing catalog path '$($entry.Path)' for ID '$($entry.Id)' (line $($entry.PathLine))"
        }
    }

    if (-not $entry.HasTokenBudget) {
        Add-Message -Bucket $warnings -Message "Missing token_budget for ID '$($entry.Id)'"
    }

    if ($entry.Layer -eq 'domain_architect' -and $entry.Dependencies.Count -gt 0) {
        Add-Message -Bucket $errors -Message "Domain '$($entry.Id)' must not declare dependencies; use default_skill_ids instead (line $($entry.Line))"
    }

    foreach ($dependencyId in $entry.Dependencies) {
        if (-not $entryById.ContainsKey($dependencyId)) {
            Add-Message -Bucket $errors -Message "Entry '$($entry.Id)' references missing dependency '$dependencyId' (line $($entry.Line))"
            continue
        }

        $dependencyEntry = $entryById[$dependencyId]
        if ($dependencyEntry.Layer -ne 'skill') {
            Add-Message -Bucket $errors -Message "Entry '$($entry.Id)' dependency '$dependencyId' must reference a skill, found layer '$($dependencyEntry.Layer)'"
        }

        if ($entry.Layer -eq 'skill' -and $dependencyEntry.Layer -eq 'domain_architect') {
            Add-Message -Bucket $errors -Message "Skill '$($entry.Id)' must not reference domain '$dependencyId' in dependencies"
        }
    }

    foreach ($conflictId in $entry.Conflicts) {
        if (-not $entryById.ContainsKey($conflictId)) {
            Add-Message -Bucket $errors -Message "Entry '$($entry.Id)' references missing conflict '$conflictId' (line $($entry.Line))"
            continue
        }

        $conflictEntry = $entryById[$conflictId]
        if ($conflictEntry.Layer -ne 'skill') {
            Add-Message -Bucket $errors -Message "Entry '$($entry.Id)' conflict '$conflictId' must reference a skill, found layer '$($conflictEntry.Layer)'"
        }

        if ($entry.Layer -eq 'skill' -and $conflictEntry.Layer -eq 'domain_architect') {
            Add-Message -Bucket $errors -Message "Skill '$($entry.Id)' must not reference domain '$conflictId' in conflicts"
        }
    }

    if ($entry.Layer -eq 'domain_architect') {
        foreach ($defaultSkillId in $entry.DefaultSkillIds) {
            if (-not $entryById.ContainsKey($defaultSkillId)) {
                Add-Message -Bucket $errors -Message "Domain '$($entry.Id)' references missing default skill '$defaultSkillId' (line $($entry.Line))"
                continue
            }

            $defaultSkillEntry = $entryById[$defaultSkillId]
            if ($defaultSkillEntry.Layer -ne 'skill') {
                Add-Message -Bucket $errors -Message "Domain '$($entry.Id)' default_skill_id '$defaultSkillId' must reference a skill, found layer '$($defaultSkillEntry.Layer)'"
            }
        }
    }
}

Test-SkillDependencyCycles -EntryById $entryById -Errors $errors

if ($errors.Count -gt 0) {
    Write-Host "Catalog validation errors:" -ForegroundColor Red
    foreach ($message in $errors) {
        Write-Host "  - $message" -ForegroundColor Red
    }
}

if ($warnings.Count -gt 0) {
    Write-Host "Catalog validation warnings:" -ForegroundColor Yellow
    foreach ($message in $warnings) {
        Write-Host "  - $message" -ForegroundColor Yellow
    }
}

$summaryColor = if ($errors.Count -gt 0) { 'Red' } elseif ($warnings.Count -gt 0) { 'Yellow' } else { 'Green' }
Write-Host "Catalog validation summary:" -ForegroundColor $summaryColor
Write-Host "  Total entries: $($entries.Count)"
Write-Host "  Warnings: $($warnings.Count)"
Write-Host "  Errors: $($errors.Count)"

if ($errors.Count -eq 0) {
    if ($warnings.Count -eq 0) {
        Write-Host "Catalog validation passed." -ForegroundColor Green
    } else {
        Write-Host "Catalog validation passed with warnings." -ForegroundColor Yellow
    }
    exit 0
}

exit 1
