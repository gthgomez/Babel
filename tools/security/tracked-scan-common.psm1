Set-StrictMode -Version Latest

$gitCandidate = 'C:\Program Files\Git\cmd\git.exe'
$script:GitExecutable = if (Test-Path -LiteralPath $gitCandidate -PathType Leaf) { $gitCandidate } else { (Get-Command git -ErrorAction Stop).Source }

function Get-TrackedPathList {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $raw = & $script:GitExecutable -C $RepoRoot -c core.quotepath=false ls-files -z --cached
  if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed; prevention gates require a Git worktree.' }
  return @(([string]$raw).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Replace('\', '/') })
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Test-ByteSequenceEqual {
  param(
    [object[]]$Left,
    [object[]]$Right,
    [int]$RightOffset = 0
  )
  if ($null -eq $Left) { $Left = @() }
  if ($null -eq $Right) { $Right = @() }
  if ($RightOffset -lt 0 -or $RightOffset -gt $Right.Count -or $Left.Count -ne ($Right.Count - $RightOffset)) { return $false }
  for ($index = 0; $index -lt $Left.Count; $index++) {
    if ([int]$Left[$index] -ne [int]$Right[$index + $RightOffset]) { return $false }
  }
  return $true
}

function Get-TrackedScanInventory {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [object[]]$BinaryAllowlist = @(),
    [int64]$MaxFileBytes = 20971520,
    [int]$MaxLineCharacters = 1048576
  )
  $records = @()
  $issues = @()
  $trackedPaths = @(Get-TrackedPathList -RepoRoot $RepoRoot)
  foreach ($relative in $trackedPaths) {
    $full = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $issues += [pscustomobject]@{ path = $relative; reason = 'missing-worktree-file' }
      continue
    }
    $item = Get-Item -Force -LiteralPath $full
    if ($item.Length -gt $MaxFileBytes) {
      $issues += [pscustomobject]@{ path = $relative; reason = 'file-size-limit' }
      continue
    }
    try {
      $bytes = [byte[]](Get-Content -LiteralPath $item.FullName -AsByteStream -Raw)
      if ($null -eq $bytes) { $bytes = [byte[]]@() }
    } catch {
      $issues += [pscustomobject]@{ path = $relative; reason = 'unreadable-file' }
      continue
    }
    $isBinary = $false
    foreach ($byte in $bytes) {
      if ([int]$byte -eq 0) { $isBinary = $true; break }
    }
    $text = $null
    $decodeReason = ''
    if (-not $isBinary) {
      try {
        if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
          $text = [Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
        } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
          $text = [Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
        } else {
          $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
          $text = [Text.Encoding]::UTF8.GetString($bytes, $offset, $bytes.Length - $offset)
          $roundTrip = [byte[]][Text.Encoding]::UTF8.GetBytes($text)
          if (-not (Test-ByteSequenceEqual -Left $roundTrip -Right $bytes -RightOffset $offset)) { throw 'invalid UTF-8 byte sequence' }
        }
      } catch { $decodeReason = 'invalid-text-encoding' }
    }
    if ($isBinary -or $decodeReason) {
      $hash = Get-FileSha256 -Path $item.FullName
      $allowed = @($BinaryAllowlist | Where-Object {
        $_.path -eq $relative -and $_.sha256 -eq $hash -and -not [string]::IsNullOrWhiteSpace([string]$_.rationale)
      }).Count -gt 0
      if (-not $allowed) {
        $issues += [pscustomobject]@{ path = $relative; reason = $(if ($isBinary) { 'binary-file' } else { $decodeReason }) }
      }
      continue
    }
    $lines = @($text -split "`r?`n")
    $oversized = $false
    foreach ($line in $lines) { if ($line.Length -gt $MaxLineCharacters) { $oversized = $true; break } }
    if ($oversized) {
      $issues += [pscustomobject]@{ path = $relative; reason = 'line-size-limit' }
      continue
    }
    $records += [pscustomobject]@{
      path = $relative
      full_path = $item.FullName
      extension = [IO.Path]::GetExtension($relative).ToLowerInvariant()
      lines = $lines
    }
  }
  return [pscustomobject]@{ records = @($records); issues = @($issues); tracked_count = $trackedPaths.Count }
}

function Test-PolicyException {
  param(
    [object[]]$Exceptions,
    [string]$RuleId,
    [string]$Path,
    [string]$Line
  )
  foreach ($entry in @($Exceptions)) {
    if ([string]$entry.rule_id -eq $RuleId -and $Path -like [string]$entry.path -and $Line -match [string]$entry.pattern) { return $true }
  }
  return $false
}

Export-ModuleMember -Function Get-TrackedPathList, Get-FileSha256, Get-TrackedScanInventory, Test-PolicyException
