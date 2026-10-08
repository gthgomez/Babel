<#
.SYNOPSIS
Posts an independent exact-head review verdict as a controller review-evidence
comment on a pull request. Exists so the review-marker format lives in one
maintained place instead of tribal knowledge (the markers are read by
.github/workflows/trusted-control-plane.yml).

.DESCRIPTION
Builds a comment starting with the required marker (the trusted-control-plane
rerun-after-review job only reacts to comments from the repository owner that
start with one of the recognized markers) and posts it with gh. The comment
must include the reviewed head SHA so the audit trail binds evidence to an
exact commit.

.PARAMETER PR
Pull request number.

.PARAMETER HeadSha
The exact 40-character head SHA the review covers.

.PARAMETER Verdict
APPROVE or CHANGES_REQUESTED.

.PARAMETER Reviewer
Free-text reviewer identity (e.g. "fresh-context AI reviewer (ZCode agent)").

.PARAMETER Summary
One-paragraph verdict summary.

.PARAMETER FindingsFile
Optional path to a markdown fragment with numbered findings (P1/P2/P3).

.EXAMPLE
pwsh tools/post-ai-review.ps1 -PR 313 -HeadSha 2990bcf... -Verdict APPROVE -Reviewer "fresh-context AI reviewer" -Summary "All adversarial checks passed." -FindingsFile findings.md
#>
param(
  [Parameter(Mandatory = $true)][int]$PR,
  [Parameter(Mandatory = $true)][string]$HeadSha,
  [Parameter(Mandatory = $true)][ValidateSet('APPROVE', 'CHANGES_REQUESTED')][string]$Verdict,
  [Parameter(Mandatory = $true)][string]$Reviewer,
  [Parameter(Mandatory = $true)][string]$Summary,
  [string]$FindingsFile,
  [string]$Repository = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($HeadSha -notmatch '^[0-9a-f]{40}$') { throw "HeadSha must be a full 40-character SHA (got '$HeadSha')" }
$ghArgs = @()
if ($Repository) { $ghArgs = @('-R', $Repository) }

$marker = '<!-- babel-controller-ai-reviews-v2 -->'
$findings = ''
if ($FindingsFile) {
  if (-not (Test-Path -LiteralPath $FindingsFile -PathType Leaf)) { throw "FindingsFile not found: $FindingsFile" }
  $findings = "`n" + (Get-Content -LiteralPath $FindingsFile -Raw).TrimEnd() + "`n"
}

$body = @"
$marker
## Independent exact-head AI review (babel-controller-ai-reviews-v2)

**Reviewer:** $Reviewer
**Reviewed head:** $HeadSha
**Verdict: $Verdict**

$Summary
$findings
"@

$body | gh pr comment $PR @ghArgs --body-file -
if ($LASTEXITCODE -ne 0) { throw 'gh pr comment failed' }
Write-Host "Review comment posted on PR $PR ($Verdict, head $HeadSha)."
