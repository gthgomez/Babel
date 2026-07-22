[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$contentScript = Join-Path $repoRoot 'tools/check-public-content-policy.ps1'
$canonicalScript = Join-Path $repoRoot 'tools/check-canonical-independence.ps1'
$scrubScript = Join-Path $repoRoot 'tools/check-public-scrub.ps1'
$contentPolicy = Join-Path $repoRoot 'tools/security/public-content-policy.json'
$scrubPolicy = Join-Path $repoRoot 'tools/security/policy.json'
$shell = (Get-Command pwsh -ErrorAction Stop).Source
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("babel-public-gates-{0}" -f [guid]::NewGuid().ToString('N'))

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}
function Initialize-Fixture([string]$Name) {
  $root = Join-Path $tempRoot $Name
  New-Item -ItemType Directory -Path (Join-Path $root 'tools/security') -Force | Out-Null
  Copy-Item -LiteralPath $contentScript -Destination (Join-Path $root 'tools/check-public-content-policy.ps1')
  Copy-Item -LiteralPath $canonicalScript -Destination (Join-Path $root 'tools/check-canonical-independence.ps1')
  Copy-Item -LiteralPath $contentPolicy -Destination (Join-Path $root 'tools/security/public-content-policy.json')
  @('BABEL_BIBLE.md', 'PROJECT_CONTEXT.md', 'README.md', 'prompt_catalog.yaml') | ForEach-Object {
    Set-Content -LiteralPath (Join-Path $root $_) -Value ("# {0}`n" -f $_)
  }
  & git -C $root init --quiet
  & git -C $root config user.email 'fixture@example.invalid'
  & git -C $root config user.name 'Fixture Runner'
  return $root
}
function Invoke-Gate([string]$Script, [string]$Root) {
  $output = @(& $shell -NoProfile -File $Script -RepoRoot $Root -OutputFormat json 2>&1)
  return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Text = ($output -join "`n") }
}

try {
  $positive = Initialize-Fixture 'positive'
  Set-Content -LiteralPath (Join-Path $positive 'guide.md') -Value "# Valid Guide`n[Read the README](README.md)`nMeasured and verified guidance.`n"
  & git -C $positive add .
  $contentPass = Invoke-Gate (Join-Path $positive 'tools/check-public-content-policy.ps1') $positive
  Assert-True ($contentPass.ExitCode -eq 0) "positive content fixture failed: $($contentPass.Text)"
  $canonicalPass = Invoke-Gate (Join-Path $positive 'tools/check-canonical-independence.ps1') $positive
  Assert-True ($canonicalPass.ExitCode -eq 0) "positive canonical fixture failed: $($canonicalPass.Text)"
  $fixturePolicyPath = Join-Path $positive 'tools/security/public-content-policy.json'
  $invalidPolicy = Get-Content -Raw -LiteralPath $fixturePolicyPath | ConvertFrom-Json
  $invalidPolicy.temporary_exceptions = @($invalidPolicy.temporary_exceptions) + @([pscustomobject]@{ id = 'missing-metadata' })
  Set-Content -LiteralPath $fixturePolicyPath -Value ($invalidPolicy | ConvertTo-Json -Depth 20)
  $invalidConfig = Invoke-Gate (Join-Path $positive 'tools/check-public-content-policy.ps1') $positive
  Assert-True ($invalidConfig.ExitCode -eq 1) 'invalid temporary exception metadata unexpectedly passed'
  Assert-True (@((ConvertFrom-Json $invalidConfig.Text).findings.id) -contains 'PCFG001') 'invalid temporary exception did not produce PCFG001'
  Copy-Item -LiteralPath $contentPolicy -Destination $fixturePolicyPath -Force

  $negative = Initialize-Fixture 'negative'
  Set-Content -LiteralPath (Join-Path $negative 'one.md') -Value @'
# Duplicate v1
Operator: named maintainer in a personal location
C:\Users\someone\project
private parent repo
opencalw_manager
TODO: replace this stub
The incident caused a 37% regression.
This is production-ready and guarantees an always correct result.
[broken](missing.md)
'@
  Set-Content -LiteralPath (Join-Path $negative 'two.md') -Value "# Duplicate v1`n"
  Set-Content -LiteralPath (Join-Path $negative 'runtime.ts') -Value @'
const root = resolvePath(parent, 'ExampleSiblingWorkspace')
const manifest = 'tools/public-export/manifest.json'
const projectRoot = resolveProjectRoot(projectId, parent)
'@
  Remove-Item -LiteralPath (Join-Path $negative 'BABEL_BIBLE.md')
  & git -C $negative add .
  $contentFail = Invoke-Gate (Join-Path $negative 'tools/check-public-content-policy.ps1') $negative
  Assert-True ($contentFail.ExitCode -eq 1) 'negative content fixture unexpectedly passed'
  $contentIds = @((ConvertFrom-Json $contentFail.Text).findings.id)
  foreach ($id in @('PCONT001','PCONT002','PCONT003','PCONT004','PCONT005','PCONT006','PCONT007','PCONT008','PCONT009')) {
    Assert-True ($contentIds -contains $id) "negative content fixture did not produce $id"
  }
  Assert-True ($contentFail.Text -notmatch 'someone') 'content finding output exposed source text'

  $canonicalFail = Invoke-Gate (Join-Path $negative 'tools/check-canonical-independence.ps1') $negative
  Assert-True ($canonicalFail.ExitCode -eq 1) 'negative canonical fixture unexpectedly passed'
  $canonicalIds = @((ConvertFrom-Json $canonicalFail.Text).findings.id)
  foreach ($id in @('CANON000','CANON001','CANON002','CANON003')) {
    Assert-True ($canonicalIds -contains $id) "negative canonical fixture did not produce $id"
  }

  $scrubRoot = Join-Path $tempRoot 'scrub'
  New-Item -ItemType Directory -Path (Join-Path $scrubRoot 'tools/security') -Force | Out-Null
  Copy-Item -LiteralPath $scrubScript -Destination (Join-Path $scrubRoot 'tools/check-public-scrub.ps1')
  Copy-Item -LiteralPath $scrubPolicy -Destination (Join-Path $scrubRoot 'tools/security/policy.json')
  Add-Content -LiteralPath (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -Value '# FixtureMarkerXYZ'
  $supplemental = Join-Path $tempRoot 'supplemental.json'
  Set-Content -LiteralPath $supplemental -Value '{"forbidden_private_identifiers":["FixtureMarkerXYZ"],"forbidden_dependency_fingerprints":[]}'
  $env:BABEL_PRIVATE_SCRUB_POLICY_PATH = (Join-Path $tempRoot 'missing.json')
  $scrubOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot -SupplementalPolicyPath $supplemental 2>&1)
  $scrubExit = $LASTEXITCODE
  Assert-True ($scrubExit -eq 1) 'supplemental scan did not inspect its own scanner file'
  Assert-True (($scrubOutput -join "`n") -notmatch 'FixtureMarkerXYZ') 'supplemental finding exposed the matched value'
  Assert-True (($scrubOutput -join "`n") -match 'identifier: tools/check-public-scrub.ps1:') 'supplemental finding omitted redacted path and line'

  $missingOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot 2>&1)
  Assert-True ($LASTEXITCODE -ne 0) 'configured missing supplemental policy did not fail closed'
  Assert-True (($missingOutput -join "`n") -notmatch [regex]::Escape($env:BABEL_PRIVATE_SCRUB_POLICY_PATH)) 'missing supplemental failure exposed its configured path'
  Remove-Item Env:BABEL_PRIVATE_SCRUB_POLICY_PATH -ErrorAction SilentlyContinue
  $malformedPolicy = Join-Path $tempRoot 'malformed-supplemental.json'
  Set-Content -LiteralPath $malformedPolicy -Value '{'
  $malformedOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot -SupplementalPolicyPath $malformedPolicy 2>&1)
  Assert-True ($LASTEXITCODE -ne 0) 'malformed supplemental policy did not fail closed'
  Assert-True (($malformedOutput -join "`n") -notmatch [regex]::Escape($malformedPolicy)) 'malformed supplemental failure exposed its configured path'

  Write-Host 'Public prevention gate fixture tests passed.' -ForegroundColor Green
} finally {
  Remove-Item Env:BABEL_PRIVATE_SCRUB_POLICY_PATH -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
