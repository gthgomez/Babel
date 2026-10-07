<#
.SYNOPSIS
Render or post a human-readable independent exact-head review summary.
.DESCRIPTION
This summary is ordinary review prose. Structured V3 certification uses the
canonical hostReviewV3Publication producer and is validated separately.
#>
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$HeadSha,
  [Parameter(Mandatory = $true)][ValidateSet('APPROVE', 'CHANGES_REQUESTED', 'BLOCK')][string]$Verdict,
  [Parameter(Mandatory = $true)][string]$Reviewer,
  [Parameter(Mandatory = $true)][string]$Summary,
  [string]$FindingsFile,
  [string]$Repository = '',
  [string]$OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($HeadSha -notmatch '^[0-9a-f]{40}$') { throw "HeadSha must be a full 40-character SHA (got '$HeadSha')" }
$ghArgs = @()
if ($Repository) { $ghArgs = @('-R', $Repository) }

$findings = ''
if ($FindingsFile) {
  if (-not (Test-Path -LiteralPath $FindingsFile -PathType Leaf)) { throw "FindingsFile not found: $FindingsFile" }
  $findings = "`n" + (Get-Content -LiteralPath $FindingsFile -Raw).TrimEnd() + "`n"
}

$body = @"
## Independent exact-head AI review

This is a human-readable review summary; structured certification is separate.

**Reviewer:** $Reviewer
**Reviewed head:** $HeadSha
**Verdict: $Verdict**

$Summary
$findings
"@

if ($OutputPath) { Set-Content -LiteralPath $OutputPath -Value $body -Encoding utf8NoBOM; return }
$body | gh pr comment $PR @ghArgs --body-file -
if ($LASTEXITCODE -ne 0) { throw 'gh pr comment failed' }
Write-Host "Review comment posted on PR $PR ($Verdict, head $HeadSha)."
