Set-StrictMode -Version Latest

function Get-TrackedPathList {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)
  $raw = & git -C $RepoRoot -c core.quotepath=false ls-files -z --cached
  if ($LASTEXITCODE -ne 0) { throw 'git ls-files failed; prevention gates require a Git worktree.' }
  return @(([string]$raw).Split([char]0, [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Replace('\', '/') })
}

function Get-FileSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Get-TrackedScanInventory {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [object[]]$BinaryAllowlist = @(),
    [int64]$MaxFileBytes = 20971520,
    [int]$MaxLineCharacters = 1048576
  )
  $records = [Collections.Generic.List[object]]::new()
  $issues = [Collections.Generic.List[object]]::new()
  $trackedPaths = @(Get-TrackedPathList -RepoRoot $RepoRoot)
  foreach ($relative in $trackedPaths) {
    $full = Join-Path $RepoRoot $relative
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $issues.Add([pscustomobject]@{ path = $relative; reason = 'missing-worktree-file' })
      continue
    }
    $item = Get-Item -LiteralPath $full
    if ($item.Length -gt $MaxFileBytes) {
      $issues.Add([pscustomobject]@{ path = $relative; reason = 'file-size-limit' })
      continue
    }
    $bytes = [IO.File]::ReadAllBytes($item.FullName)
    $isBinary = $bytes -contains 0
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
          $strictUtf8 = [Text.UTF8Encoding]::new($false, $true)
          $text = $strictUtf8.GetString($bytes, $offset, $bytes.Length - $offset)
        }
      } catch { $decodeReason = 'invalid-text-encoding' }
    }
    if ($isBinary -or $decodeReason) {
      $hash = Get-FileSha256 -Path $item.FullName
      $allowed = @($BinaryAllowlist | Where-Object {
        $_.path -eq $relative -and $_.sha256 -eq $hash -and -not [string]::IsNullOrWhiteSpace([string]$_.rationale)
      }).Count -gt 0
      if (-not $allowed) {
        $issues.Add([pscustomobject]@{ path = $relative; reason = $(if ($isBinary) { 'binary-file' } else { $decodeReason }) })
      }
      continue
    }
    $lines = @($text -split "`r?`n")
    $oversized = $false
    foreach ($line in $lines) { if ($line.Length -gt $MaxLineCharacters) { $oversized = $true; break } }
    if ($oversized) {
      $issues.Add([pscustomobject]@{ path = $relative; reason = 'line-size-limit' })
      continue
    }
    $records.Add([pscustomobject]@{
      path = $relative
      full_path = $item.FullName
      extension = [IO.Path]::GetExtension($relative).ToLowerInvariant()
      lines = $lines
    })
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
