# Collect the review target: merge-base ∪ dirty ∪ untracked (Windows-safe).
# Prints a machine-readable report. Does not review and does not modify git state.
[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [switch]$Staged,
    [string]$Path = "",
    [string]$Range = "",
    [string]$Pr = "",
    [switch]$Structure,
    [int]$WarnBytes = 1048576,
    [int]$AbortBytes = 10485760
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Report {
    param(
        [Parameter(Mandatory = $true)][string]$Status,
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Mode = "",
        [string]$Base = "",
        [string]$MergeBase = "",
        [long]$Bytes = 0,
        [string[]]$Files = @(),
        [string[]]$Lenses = @("bugs"),
        [string[]]$Crosses1k = @(),
        [string[]]$SecretHints = @(),
        [bool]$CatalogPresent = $false,
        [bool]$CatalogInDiff = $false
    )
    Write-Output "STATUS: $Status"
    Write-Output "MESSAGE: $Message"
    if ($Mode) { Write-Output "MODE: $Mode" }
    if ($Base) { Write-Output "BASE: $Base" }
    if ($MergeBase) { Write-Output "MERGE_BASE: $MergeBase" }
    Write-Output "BYTES: $Bytes"
    Write-Output "CATALOG_PRESENT: $(if ($CatalogPresent) { 'true' } else { 'false' })"
    Write-Output "CATALOG_IN_DIFF: $(if ($CatalogInDiff) { 'true' } else { 'false' })"
    Write-Output "FILES:"
    foreach ($f in $Files) { Write-Output "- $f" }
    Write-Output "LENSES:"
    foreach ($l in $Lenses) { Write-Output "- $l" }
    Write-Output "CROSSES_1K:"
    foreach ($c in $Crosses1k) { Write-Output "- $c" }
    Write-Output "SECRET_HINTS:"
    foreach ($s in $SecretHints) { Write-Output "- $s" }
}

function Test-ExcludedPath([string]$Rel) {
    $n = $Rel -replace '\\', '/'
    if ($n -match '(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$') { return $true }
    if ($n -match '(^|/)(dist|node_modules|\.next|build|coverage|\.turbo)(/|$)') { return $true }
    if ($n -match '\.min\.(js|css)$') { return $true }
    return $false
}

function Test-SecurityPath([string]$Rel) {
    $n = ($Rel -replace '\\', '/').ToLowerInvariant()
    return $n -match '(^|/)(auth|oauth|session|secret|credential|login|passwd|password|rls)(/|\.|$)' -or
        $n -match '(^|/)(\.env|\.env\.[^/]+|[^/]+\.env)$' -or
        $n -match '(exec|spawn|shell|token|apikey|api-key|prompt.?inject)'
}

function Test-ControlPath([string]$Rel) {
    $n = $Rel -replace '\\', '/'
    return $n -eq 'prompt_catalog.yaml' -or
        $n -match '^(00_System_Router|01_Behavioral_OS|03_Model_Adapters|runtime|tools|babel-cli/src|\.agents/skills)(/|$)'
}

function Get-LineCount([string]$FilePath) {
    if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) { return 0 }
    return @(Get-Content -LiteralPath $FilePath -ErrorAction SilentlyContinue).Count
}

function Test-SecretHint([string]$Text) {
    if ([string]::IsNullOrEmpty($Text)) { return $false }
    return $Text -match '(?i)(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)\s*[:=]\s*\S+' -or
        $Text -match 'AKIA[0-9A-Z]{16}' -or
        $Text -match '-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----' -or
        $Text -match '(?i)sk-(live|test)-[A-Za-z0-9]+'
}

if (-not $RepoRoot) {
    $RepoRoot = (git rev-parse --show-toplevel 2>$null)
    if (-not $RepoRoot) { $RepoRoot = (Get-Location).Path }
}
$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git'))) {
    Write-Report -Status 'ERROR' -Message 'Not a git repository.'
    exit 2
}

Push-Location $RepoRoot
try {
    $catalogPresent = Test-Path -LiteralPath (Join-Path $RepoRoot 'prompt_catalog.yaml')
    $files = New-Object System.Collections.Generic.List[string]
    $mode = 'feature-union'
    $base = ''
    $mergeBase = ''
    $diffText = ''

    if ($Pr) {
        Write-Report -Status 'ERROR' -Message 'PR target is parsed by the skill. Fetch with gh only when asked; this collector does not post reviews. Pass a local range instead, or let the agent run gh pr diff.'
        exit 2
    }

    if ($Staged) {
        $mode = 'staged'
        $diffText = git -c core.quotepath=false diff --cached
        $names = @(git -c core.quotepath=false diff --cached --name-only)
        foreach ($n in $names) { if ($n -and -not (Test-ExcludedPath $n)) { $files.Add($n) } }
    }
    elseif ($Path) {
        $mode = 'path'
        $rel = $Path
        if ([System.IO.Path]::IsPathRooted($Path)) {
            $rel = [System.IO.Path]::GetRelativePath($RepoRoot, $Path)
        }
        $rel = $rel -replace '\\', '/'
        if (Test-ExcludedPath $rel) {
            Write-Report -Status 'EMPTY' -Message 'No changes to review.' -Mode $mode
            exit 0
        }
        if (Test-Path -LiteralPath (Join-Path $RepoRoot $rel)) {
            $tracked = git ls-files -- "$rel"
            if ($tracked) {
                $diffText = git -c core.quotepath=false diff HEAD -- "$rel"
                $unstaged = git -c core.quotepath=false diff --name-only HEAD -- "$rel"
                if ($unstaged) { $files.Add($rel) }
                else {
                    $status = git status --porcelain -- "$rel"
                    if ($status) { $files.Add($rel) }
                }
            }
            else {
                $files.Add($rel)
                $diffText = "untracked:$rel"
            }
        }
        else {
            Write-Report -Status 'ERROR' -Message "Path not found: $rel" -Mode $mode
            exit 2
        }
    }
    elseif ($Range) {
        $mode = 'range'
        $diffText = git -c core.quotepath=false diff $Range
        $names = @(git -c core.quotepath=false diff --name-only $Range)
        foreach ($n in $names) { if ($n -and -not (Test-ExcludedPath $n)) { $files.Add($n) } }
    }
    else {
        $current = (git rev-parse --abbrev-ref HEAD).Trim()
        if (git rev-parse --verify --quiet origin/main) { $base = 'origin/main' }
        elseif (git rev-parse --verify --quiet origin/master) { $base = 'origin/master' }
        elseif (git rev-parse --verify --quiet refs/heads/main) { $base = 'main' }
        elseif (git rev-parse --verify --quiet refs/heads/master) { $base = 'master' }

        $onDefault = $false
        if (-not $base) { $onDefault = $true }
        elseif ($current -in @('main', 'master')) { $onDefault = $true }
        elseif ($current -eq ($base -replace '^origin/', '')) { $onDefault = $true }

        if ($onDefault) {
            $mode = 'default-branch'
            if (git rev-parse --verify --quiet HEAD) {
                $diffText = git -c core.quotepath=false diff HEAD
                $names = @(git -c core.quotepath=false diff --name-only HEAD)
                foreach ($n in $names) { if ($n -and -not (Test-ExcludedPath $n)) { $files.Add($n) } }
            }
        }
        else {
            $mode = 'feature-union'
            $mergeBase = (git merge-base HEAD $base).Trim()
            $diffText = git -c core.quotepath=false diff $mergeBase
            $names = @(git -c core.quotepath=false diff --name-only $mergeBase)
            foreach ($n in $names) { if ($n -and -not (Test-ExcludedPath $n)) { $files.Add($n) } }
        }

        $untracked = @(git ls-files --others --exclude-standard)
        foreach ($u in $untracked) {
            if (-not $u) { continue }
            $u = $u -replace '\\', '/'
            if (Test-ExcludedPath $u) { continue }
            if (-not $files.Contains($u)) { $files.Add($u) }
            $full = Join-Path $RepoRoot $u
            if (Test-Path -LiteralPath $full -PathType Leaf) {
                $diffText += "`nuntracked:$u"
            }
        }
    }

    $unique = [System.Collections.Generic.List[string]]::new()
    foreach ($f in $files) {
        $norm = $f -replace '\\', '/'
        if (-not $unique.Contains($norm)) { $unique.Add($norm) }
    }
    $files = $unique

    $bytes = [long][System.Text.Encoding]::UTF8.GetByteCount(($diffText | Out-String))
    if ($bytes -ge $AbortBytes) {
        Write-Report -Status 'TOO_LARGE' -Message "Diff is $bytes bytes (> $AbortBytes). Narrow the target or ignore generated paths." -Mode $mode -Base $base -MergeBase $mergeBase -Bytes $bytes -Files @($files) -CatalogPresent $catalogPresent
        exit 3
    }

    if ($files.Count -eq 0) {
        Write-Report -Status 'EMPTY' -Message 'No changes to review.' -Mode $mode -Base $base -MergeBase $mergeBase -Bytes $bytes -CatalogPresent $catalogPresent
        exit 0
    }

    $lenses = New-Object System.Collections.Generic.List[string]
    $lenses.Add('bugs')
    $catalogInDiff = $false
    foreach ($f in $files) {
        if ($f -eq 'prompt_catalog.yaml') { $catalogInDiff = $true }
        if ((Test-SecurityPath $f) -and -not $lenses.Contains('security')) { $lenses.Add('security') }
        if ((Test-ControlPath $f) -and -not $lenses.Contains('control-plane')) { $lenses.Add('control-plane') }
    }

    $crosses = New-Object System.Collections.Generic.List[string]
    foreach ($f in $files) {
        $full = Join-Path $RepoRoot $f
        $newCount = Get-LineCount $full
        $oldCount = 0
        if (git rev-parse --verify --quiet HEAD) {
            $oldText = git show "HEAD:$f" 2>$null
            if ($LASTEXITCODE -eq 0 -and $oldText) {
                $oldCount = @($oldText -split "`n").Count
            }
        }
        if ($newCount -ge 1000 -and $oldCount -lt 1000) { $crosses.Add($f) }
    }
    if ($Structure -or $crosses.Count -gt 0) {
        if (-not $lenses.Contains('structure')) { $lenses.Add('structure') }
    }

    $secrets = New-Object System.Collections.Generic.List[string]
    foreach ($f in $files) {
        $full = Join-Path $RepoRoot $f
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $text = Get-Content -LiteralPath $full -Raw -ErrorAction SilentlyContinue
        if (Test-SecretHint $text) { $secrets.Add($f) }
    }

    $msg = if ($bytes -ge $WarnBytes) { "OK (diff $bytes bytes; confirm before a huge review)." } else { 'OK' }
    Write-Report -Status 'OK' -Message $msg -Mode $mode -Base $base -MergeBase $mergeBase -Bytes $bytes -Files @($files) -Lenses @($lenses) -Crosses1k @($crosses) -SecretHints @($secrets) -CatalogPresent $catalogPresent -CatalogInDiff $catalogInDiff
    exit 0
}
finally {
    Pop-Location
}
