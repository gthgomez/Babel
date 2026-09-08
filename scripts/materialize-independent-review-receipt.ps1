[CmdletBinding()]
param(
  [Parameter(Mandatory)][int]$PR, [Parameter(Mandatory)][string]$Repository,
  [Parameter(Mandatory)][string]$BaseSha, [Parameter(Mandatory)][string]$HeadSha,
  [Parameter(Mandatory)][string]$EvidenceDirectory
)
# Trusted-base transport: GitHub authenticates the owner-host publisher; models
# review in the existing host harness. No GitHub AI service or new App is used.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'agent-pr-gate-common.psm1') -Force
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $PR -lt 1 -or $BaseSha -notmatch '^[0-9a-f]{40}$' -or $HeadSha -notmatch '^[0-9a-f]{40}$') {
  throw 'Evidence transport requires repository, PR and exact base/head SHAs.'
}
$gh = (Get-Command gh -ErrorAction Stop).Source
$metadata = & $gh api "repos/$Repository" | ConvertFrom-Json -ErrorAction Stop
if ($LASTEXITCODE -ne 0 -or $metadata.full_name -ine $Repository -or $metadata.owner.type -cne 'User' -or [string]$metadata.owner.id -notmatch '^[1-9][0-9]*$') {
  throw 'Authenticated repository owner identity unavailable.'
}
$comments = @()
$page = 1
while ($true) {
  $raw = @(& $gh api "repos/$Repository/issues/$PR/comments?per_page=100&page=$page")
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read PR evidence comments.' }
  $pageComments = ($raw -join [Environment]::NewLine) | ConvertFrom-Json -Depth 40 -ErrorAction Stop
  $comments += @($pageComments)
  if (@($pageComments).Count -lt 100) { break }
  $page++
}
# Selects the latest entire round, including BLOCK; never mixes old approvals.
$bundle = Select-AgentHostReviewBundle -Comments $comments -Repository $Repository -PR $PR -BaseSha $BaseSha -HeadSha $HeadSha -PublisherId ([string]$metadata.owner.id)
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$bundle | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'ai-reviews.json') -Encoding utf8NoBOM
Write-Output "HOST_AI_REVIEW_TRANSPORT_STAGED pr=$PR base=$BaseSha head=$HeadSha"
