<# .SYNOPSIS
Babel docs integrity checker — ADR index completeness, active-vs-archive lifecycle,
removed-command teaching scan, and authority-reference integrity.

.DESCRIPTION
Covers the documentation-integrity requirements not enforced by the existing
public-content / scrub / harness checkers:

  1. ADR index completeness   — every docs/adr/ADR-*.md appears exactly once in
     docs/adr/README.md; index title/status/date match the ADR file; no broken links.
  2. Active-vs-archive lifecycle — archived docs must carry HISTORICAL/SUPERSEDED
     status (not CANONICAL/ACTIVE/EXPERIMENTAL); archived docs must not claim current
     normative authority without a historical note; archive links must not appear
     under "Live"/"Active" index sections.
  3. Removed-command teaching — active user-facing docs must not teach removed CLI
     surfaces (bl, babel-lite, babel lite, babel l, babel full, babel daily, or
     Lite-era verb commands ask/do/fix/propose/patch/review) except in explicit
     removed/historical context.
  4. Authority-reference integrity — the canonical authority files exist and the
     root docs index links them.

Markdown link resolution and absolute-path hygiene are covered by
check-public-content-policy.ps1 and check-public-scrub.ps1 respectively; this
checker deliberately does not duplicate them.

.PARAMETER RepoRoot
Repository root (defaults to the parent of tools/).

.PARAMETER OutputFormat
human (default) or json.

.EXAMPLE
pwsh tools/check-docs-integrity.ps1
# Runs all four checks; exits 1 on any error-severity finding.

.EXAMPLE
pwsh tools/check-docs-integrity.ps1 -OutputFormat json
# Machine-readable findings.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [ValidateSet('human', 'json')]
  [string]$OutputFormat = 'human'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

$findings = @()

function Add-Finding {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][string]$Category,
    [Parameter(Mandatory)][ValidateSet('error', 'warn')][string]$Severity,
    [string]$Path = '',
    [int]$Line = 0,
    [Parameter(Mandatory)][string]$Message
  )
  $script:findings += [PSCustomObject]@{
    id = $Id
    category = $Category
    severity = $Severity
    path = $Path
    line = $Line
    message = $Message
  }
}

function Get-RelativePath {
  param([string]$Path)
  # String-based relativization (platform-independent): [Uri]::MakeRelativeUri throws on
  # Linux for scheme-less absolute paths, which silently defeated the archive-README skip.
  $rootNormalized = ($RepoRoot.TrimEnd('\', '/')).Replace('\', '/') + '/'
  $pathNormalized = $Path.Replace('\', '/')
  if ($pathNormalized.StartsWith($rootNormalized, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $pathNormalized.Substring($rootNormalized.Length)
  }
  return $pathNormalized
}

function Normalize-Text {
  param([string]$Text)
  # Lowercase, collapse whitespace, drop punctuation that differs stylistically.
  return (($Text -replace '\s+', ' ').Trim() -replace '[`_*#]', '').ToLowerInvariant()
}

function Get-StatusFromFile {
  param([string]$Content)
  if ($Content -match '(?m)^\s*status:\s*([A-Za-z_]+)') { return $Matches[1].ToUpperInvariant() }
  return ''
}

function Get-FirstLine {
  param([string]$Pattern, [string]$Content)
  $m = [regex]::Match($Content, $Pattern)
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return ''
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 1: ADR index completeness
# ─────────────────────────────────────────────────────────────────────────────
$adrDir = Join-Path $RepoRoot 'docs/adr'
$adrReadme = Join-Path $adrDir 'README.md'
$adrFiles = @(Get-ChildItem -LiteralPath $adrDir -Filter 'ADR-*.md' -File | Sort-Object Name)
$adrReadmeContent = if (Test-Path -LiteralPath $adrReadme) { Get-Content -Raw -LiteralPath $adrReadme } else { '' }

# Extract index table rows: link target, title, status, date (4-column table).
$indexEntries = @()
if ($adrReadmeContent) {
  foreach ($line in ($adrReadmeContent -split "`r?`n")) {
    if ($line -notmatch '^\s*\|') { continue }
    $cells = @($line -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($cells.Count -lt 4) { continue }
    # After filtering empty cells, the link cell is first (index 0), then title/status/date.
    $linkCell = $cells[0]
    if ($linkCell -notmatch '\[([^\]]+)\]\(([^)]+\.md)\)') { continue }
    $indexEntries += [PSCustomObject]@{
      FileName = ([IO.Path]::GetFileName($Matches[2]))
      Title = $cells[1]
      Status = $cells[2]
      Date = $cells[3]
      Line = $line
    }
  }
}

foreach ($adrFile in $adrFiles) {
  $fileName = $adrFile.Name
  $rel = Get-RelativePath -Path $adrFile.FullName
  $content = Get-Content -Raw -LiteralPath $adrFile.FullName

  $entry = $indexEntries | Where-Object { $_.FileName -eq $fileName }
  $entryCount = @($entry).Count
  if ($entryCount -eq 0) {
    Add-Finding -Id 'adr-missing-from-index' -Category 'adr-index' -Severity 'error' -Path $rel -Message "ADR file is not listed in docs/adr/README.md"
    continue
  }
  if ($entryCount -gt 1) {
    Add-Finding -Id 'adr-duplicate-index-entry' -Category 'adr-index' -Severity 'error' -Path $rel -Message "ADR file appears $entryCount times in docs/adr/README.md (must appear exactly once)"
  }

  # Title match (normalized containment, either direction).
  $h1 = Get-FirstLine -Pattern '(?m)^#\s+(.+)$' -Content $content
  $normH1 = Normalize-Text -Text ($h1 -replace '^ADR-\d+:?\s*', '')
  $normIndexTitle = Normalize-Text -Text ($entry[0].Title -replace '^ADR-\d+:?\s*', '')
  if ($normH1 -and $normIndexTitle -and $normH1 -ne $normIndexTitle) {
    $containsEither = $normH1.Contains($normIndexTitle) -or $normIndexTitle.Contains($normH1)
    if (-not $containsEither) {
      Add-Finding -Id 'adr-title-mismatch' -Category 'adr-index' -Severity 'error' -Path $rel -Message "Index title '$($entry[0].Title)' does not match file title '$h1'"
    }
  }

  # Status match: index status must be a prefix of the file status (files may qualify).
  $fileStatus = Get-FirstLine -Pattern '(?m)\*\*\s*Status\s*\*\*\s*[:：]?\s*([^\n]+)' -Content $content
  if (-not $fileStatus) {
    $fileStatus = Get-FirstLine -Pattern '(?m)> \*\*\s*Status\s*\*\*\s*[:：]?\s*([^\n]+)' -Content $content
  }
  $normFileStatus = Normalize-Text -Text $fileStatus
  $normIndexStatus = Normalize-Text -Text $entry[0].Status
  if ($normFileStatus -and $normIndexStatus) {
    $statusPrefixOk = $normFileStatus.StartsWith($normIndexStatus) -or $normIndexStatus.StartsWith($normFileStatus)
    if (-not $statusPrefixOk) {
      Add-Finding -Id 'adr-status-mismatch' -Category 'adr-index' -Severity 'error' -Path $rel -Message "Index status '$($entry[0].Status)' does not match file status '$fileStatus'"
    }
  }

  # Date match: index date must equal the file's authoritative date.
  $fileDate = Get-FirstLine -Pattern '(?m)\*\*\s*Date\s*\*\*\s*[:：]?\s*(\d{4}-\d{2}-\d{2})' -Content $content
  if (-not $fileDate) {
    $fileDate = Get-FirstLine -Pattern '(?m)> \*\*\s*Date\s*\*\*\s*[:：]?\s*(\d{4}-\d{2}-\d{2})' -Content $content
  }
  if (-not $fileDate) {
    $fileDate = Get-FirstLine -Pattern '(?m)^- \*\*\s*Date\s*\*\*\s*[:：]?\s*(\d{4}-\d{2}-\d{2})' -Content $content
  }
  if ($fileDate -and $entry[0].Date -and $fileDate -ne $entry[0].Date) {
    Add-Finding -Id 'adr-date-mismatch' -Category 'adr-index' -Severity 'error' -Path $rel -Message "Index date '$($entry[0].Date)' does not match file date '$fileDate'"
  }
}

# Index link targets must resolve.
foreach ($entry in $indexEntries) {
  $target = Join-Path $adrDir $entry.FileName
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    Add-Finding -Id 'adr-index-broken-link' -Category 'adr-index' -Severity 'error' -Path 'docs/adr/README.md' -Message "Index links to missing file: $($entry.FileName)"
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 2: active-vs-archive lifecycle
# ─────────────────────────────────────────────────────────────────────────────
$archiveDir = Join-Path $RepoRoot 'docs/archive'
if (Test-Path -LiteralPath $archiveDir) {
  foreach ($file in Get-ChildItem -LiteralPath $archiveDir -Recurse -Filter '*.md' -File) {
    $rel = Get-RelativePath -Path $file.FullName
    $content = Get-Content -Raw -LiteralPath $file.FullName
    if ($rel -like 'docs/archive/README.md') { continue }  # the archive index is intentionally ACTIVE

    $status = Get-StatusFromFile -Content $content
    if ($status -in @('CANONICAL', 'ACTIVE', 'EXPERIMENTAL')) {
      Add-Finding -Id 'archive-active-status' -Category 'lifecycle' -Severity 'error' -Path $rel -Message "Archived document has lifecycle status '$status'; archived docs must be HISTORICAL or SUPERSEDED"
    }

    # Archived docs must not claim current normative authority without a historical note.
    if ($content -match 'authority:\s*normative' -or $content -match '\bCANONICAL\b') {
      $head = $content.Substring(0, [Math]::Min(2000, $content.Length))
      if ($head -notmatch '(?i)archived|historical|superseded') {
        Add-Finding -Id 'archive-normative-claim' -Category 'lifecycle' -Severity 'error' -Path $rel -Message "Archived document claims normative/canonical authority without an archival note"
      }
    }
  }
}

# Archive links must not sit under "Live"/"Active" index sections.
$indexFiles = @(
  (Join-Path $RepoRoot 'docs/README.md'),
  (Join-Path $RepoRoot 'docs/architecture/README.md'),
  (Join-Path $RepoRoot 'docs/release/README.md')
)
foreach ($indexPath in $indexFiles) {
  if (-not (Test-Path -LiteralPath $indexPath)) { continue }
  $lines = Get-Content -LiteralPath $indexPath
  $currentSection = ''
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match '^#{1,3}\s+(.+)$') { $currentSection = $Matches[1] }
    if ($line -match '\]\(\.\.?/archive/') {
      $relIndex = Get-RelativePath -Path $indexPath
      if ($currentSection -match '(?i)live|active') {
        Add-Finding -Id 'archive-under-live-section' -Category 'lifecycle' -Severity 'error' -Path $relIndex -Line ($i + 1) -Message "Archive link under section '$currentSection' (sections named Live/Active must not list archived documents): $($line.Trim())"
      }
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 3: removed-command teaching scan (active user-facing docs only)
# ─────────────────────────────────────────────────────────────────────────────
$commandScanDirs = @(
  (Join-Path $RepoRoot 'docs'),
  (Join-Path $RepoRoot 'docs/guides'),
  (Join-Path $RepoRoot 'docs/architecture'),
  (Join-Path $RepoRoot 'docs/release')
)
$scanFiles = @()
foreach ($dir in $commandScanDirs) {
  if (-not (Test-Path -LiteralPath $dir)) { continue }
  $scanFiles += Get-ChildItem -LiteralPath $dir -Filter '*.md' -File
}
# Explicitly skip archived/status/adr trees and the archive index.
$scanFiles = @($scanFiles | Where-Object {
  $rel = Get-RelativePath -Path $_.FullName
  $rel -notlike 'docs/archive/*' -and $rel -notlike 'docs/status/*' -and $rel -notlike 'docs/adr/*'
})

# Removed surfaces as command starters (in fenced code blocks) or inline code spans.
$removedSurfaces = 'bl|babel-lite|babel lite|babel l|babel full|babel daily'
$liteVerbCommand = 'babel\s+(ask|do|fix|propose|patch|review)\s'

foreach ($file in $scanFiles) {
  $rel = Get-RelativePath -Path $file.FullName
  $lines = Get-Content -LiteralPath $file.FullName
  $inFence = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    if ($line -match '^\s*(```|~~~)') { $inFence = -not $inFence; continue }

    $isContextual = $false
    $contextStart = [Math]::Max(0, $i - 2)
    $contextEnd = [Math]::Min($lines.Count - 1, $i + 2)
    for ($j = $contextStart; $j -le $contextEnd; $j++) {
      if ($lines[$j] -match '(?i)removed|historical|history|superseded|archiv|deprecat|not (a |an )?command|no longer') { $isContextual = $true; break }
    }

    if ($isContextual) { continue }

    # Fenced block: lines starting with a removed surface.
    if ($inFence -and $line -match "^\s*(?:$removedSurfaces)\b") {
      Add-Finding -Id 'removed-command-taught' -Category 'removed-commands' -Severity 'error' -Path $rel -Line ($i + 1) -Message "Code block teaches removed CLI surface: $($line.Trim())"
    }
    # Fenced block: `babel <lite-verb> ` command shapes.
    if ($inFence -and $line -match "(?i)^\s*$liteVerbCommand") {
      Add-Finding -Id 'lite-verb-command-taught' -Category 'removed-commands' -Severity 'warn' -Path $rel -Line ($i + 1) -Message "Code block teaches Lite-era verb command shape: $($line.Trim())"
    }
    # Inline code spans teaching removed surfaces.
    if ($line -match '`(bl|babel-lite|babel lite|babel l|babel full|babel daily)(\s|`)') {
      Add-Finding -Id 'removed-surface-inline' -Category 'removed-commands' -Severity 'warn' -Path $rel -Line ($i + 1) -Message "Inline code mentions removed CLI surface: $($line.Trim())"
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Check 4: authority-reference integrity
# ─────────────────────────────────────────────────────────────────────────────
$authorityFiles = @(
  (Join-Path $RepoRoot 'docs/architecture/HARNESS_ARCHITECTURE_V1.md'),
  (Join-Path $RepoRoot 'docs/architecture/HARNESS_HARDENING_ROADMAP_V1.md'),
  (Join-Path $RepoRoot 'docs/architecture/ARCHITECTURE.md'),
  (Join-Path $RepoRoot 'docs/CLI_COMMAND_CONTRACT.md'),
  (Join-Path $RepoRoot 'docs/CHAT_MODE.md')
)
foreach ($file in $authorityFiles) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    Add-Finding -Id 'authority-file-missing' -Category 'authority-refs' -Severity 'error' -Path (Get-RelativePath -Path $file) -Message "Authority document is missing"
  }
}

$rootDocsReadme = Join-Path $RepoRoot 'docs/README.md'
if (Test-Path -LiteralPath $rootDocsReadme) {
  $readmeContent = Get-Content -Raw -LiteralPath $rootDocsReadme
  $requiredLinks = @(
    'CLI_COMMAND_CONTRACT.md',
    'CHAT_MODE.md',
    'HARNESS_ARCHITECTURE_V1.md'
  )
  foreach ($link in $requiredLinks) {
    if ($readmeContent -notmatch [regex]::Escape($link)) {
      Add-Finding -Id 'authority-link-missing' -Category 'authority-refs' -Severity 'error' -Path 'docs/README.md' -Message "docs/README.md must link the canonical authority file: $link"
    }
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# Output + exit
# ─────────────────────────────────────────────────────────────────────────────
$errors = @($findings | Where-Object { $_.severity -eq 'error' })
$warns = @($findings | Where-Object { $_.severity -eq 'warn' })

if ($OutputFormat -eq 'json') {
  $result = [PSCustomObject]@{
    status = if ($errors.Count -eq 0) { 'pass' } else { 'fail' }
    errors = $errors.Count
    warnings = $warns.Count
    findings = $findings
  }
  $result | ConvertTo-Json -Depth 5
} else {
  if ($findings.Count -eq 0) {
    Write-Host "Docs integrity check passed (ADR index, lifecycle, removed commands, authority refs)."
  } else {
    foreach ($f in $findings) {
      $location = if ($f.path) { " [$($f.path)]" } else { '' }
      if ($f.line -gt 0) { $location += ":$($f.line)" }
      Write-Host "[$($f.severity)] $($f.id)$location — $($f.message)"
    }
    Write-Host ""
    Write-Host "Summary: $($errors.Count) error(s), $($warns.Count) warning(s)."
  }
}

exit $errors.Count
