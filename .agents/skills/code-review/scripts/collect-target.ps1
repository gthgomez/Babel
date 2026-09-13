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
    [switch]$Json,
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

    if ($Json) {
        $cliScript = Join-Path $RepoRoot "babel-cli/src/services/candidateCollectorCli.ts"
        $tsxCli = Join-Path $RepoRoot "babel-cli/node_modules/tsx/dist/cli.mjs"
        if ((Test-Path -LiteralPath $cliScript) -and (Test-Path -LiteralPath $tsxCli)) {
            $cliArgs = @($tsxCli, $cliScript, "--json")
            if ($RepoRoot) { $cliArgs += @("--repo-root", $RepoRoot) }
            if ($Pr) { $cliArgs += @("--pr", $Pr) }
            if ($Range) { $cliArgs += @("--range", $Range) }
            if ($Staged) { $cliArgs += "--staged" }
            & node $cliArgs
            exit $LASTEXITCODE
        } else {
            throw "JSON candidate collection requested, but TypeScript CLI or tsx is unavailable at $cliScript"
        }
    }

    if ($Pr) {
        $mode = 'pr'
        $prJson = gh pr view $Pr --json number,baseRefOid,headRefOid 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $prJson) {
            Write-Report -Status 'ERROR' -Message "Failed to fetch PR $Pr metadata with gh."
            exit 2
        }
        $prObj = $prJson | ConvertFrom-Json
        $base = $prObj.baseRefOid
        $mergeBase = $prObj.baseRefOid
        $head = $prObj.headRefOid

        $hasBase = (git rev-parse --verify --quiet "$base^{commit}")
        $hasHead = (git rev-parse --verify --quiet "$head^{commit}")
        if (-not $hasHead -or -not $hasBase) {
            git fetch origin "pull/$Pr/head:refs/remotes/origin/pr/$Pr" 2>$null
            if (-not (git rev-parse --verify --quiet "$base^{commit}")) {
                git fetch origin $base 2>$null
            }
        }

        $diffText = git -c core.quotepath=false diff "$base...$head"
        if ($LASTEXITCODE -ne 0) {
            Write-Report -Status 'ERROR' -Message "Failed to compute diff for PR $Pr between $base and $head."
            exit 2
        }
        $names = @(git -c core.quotepath=false diff --name-only "$base...$head")
        foreach ($n in $names) { if ($n -and -not (Test-ExcludedPath $n)) { $files.Add($n) } }
    }
    elseif ($Staged) {
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
        $current = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
        $symbolicOriginHead = (git symbolic-ref --short refs/remotes/origin/HEAD 2>$null)
        if ($symbolicOriginHead -and (git rev-parse --verify --quiet $symbolicOriginHead)) {
            $base = $symbolicOriginHead.Trim()
        }
        else {
            $ghDefault = (gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>$null)
            if ($ghDefault -and (git rev-parse --verify --quiet "origin/$ghDefault")) {
                $base = "origin/$ghDefault"
            }
        }

        $onDefault = $false
        if ($base) {
            $baseShort = $base -replace '^refs/remotes/origin/', '' -replace '^origin/', ''
            if ($current -eq $baseShort) {
                $onDefault = $true
            }
        }
        elseif ($current -in @('main', 'master')) {
            $onDefault = $true
        }
        else {
            Write-Report -Status 'ERROR' -Message "UNABLE_TO_RESOLVE_CANDIDATE_BASE: Unable to resolve default base branch for candidate."
            exit 2
        }

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
