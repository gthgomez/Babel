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
$commonModule = Join-Path $repoRoot 'tools/security/tracked-scan-common.ps1'
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
  Copy-Item -LiteralPath $commonModule -Destination (Join-Path $root 'tools/security/tracked-scan-common.ps1')
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

  # GPCGuard allowed-in-docs test: per OSS Foundation Q3, product names (e.g. GPCGuard)
  # may appear in public docs/examples but remain forbidden as dependency fingerprints.
  # Positive case: GPCGuard in prose documentation only
  $gpguardDocs = Initialize-Fixture 'gpguard-docs'
  Copy-Item -LiteralPath $scrubScript -Destination (Join-Path $gpguardDocs 'tools/check-public-scrub.ps1')
  Copy-Item -LiteralPath $scrubPolicy -Destination (Join-Path $gpguardDocs 'tools/security/policy.json')
  Set-Content -LiteralPath (Join-Path $gpguardDocs 'gpcguard-guide.md') -Value "# GPCGuard Integration`nBabel is used by GPCGuard for autonomous agent orchestration.`nRefer to the GPCGuard integration guide for setup steps.`n[GPCGuard docs](https://example.com)`n"
  Set-Content -LiteralPath (Join-Path $gpguardDocs 'package.json') -Value '{ "name": "fixture", "private": true }'
  & git -C $gpguardDocs add .
  $gpguardContent = Invoke-Gate (Join-Path $gpguardDocs 'tools/check-public-content-policy.ps1') $gpguardDocs
  Assert-True ($gpguardContent.ExitCode -eq 0) "GPCGuard in doc unexpectedly failed content-policy: $($gpguardContent.Text)"
  $gpguardCanonical = Invoke-Gate (Join-Path $gpguardDocs 'tools/check-canonical-independence.ps1') $gpguardDocs
  Assert-True ($gpguardCanonical.ExitCode -eq 0) "GPCGuard in doc unexpectedly failed canonical-independence: $($gpguardCanonical.Text)"
  $gpguardScrub = Invoke-Gate (Join-Path $gpguardDocs 'tools/check-public-scrub.ps1') $gpguardDocs
  Assert-True ($gpguardScrub.ExitCode -eq 0) "GPCGuard allowed in docs: scrub should pass (doc mention NOT a leak) but exit $($gpguardScrub.ExitCode): $($gpguardScrub.Text)"
  Assert-True ($gpguardScrub.Text -notmatch 'GPCGuard') 'GPCGuard in doc was flagged as a leak (scrub output exposed the project name)'

  # Negative case: GPCGuard as a file: dependency fingerprint in lockfile must be caught
  $gpguardLockfile = Initialize-Fixture 'gpguard-lockfile'
  Copy-Item -LiteralPath $scrubScript -Destination (Join-Path $gpguardLockfile 'tools/check-public-scrub.ps1')
  Copy-Item -LiteralPath $scrubPolicy -Destination (Join-Path $gpguardLockfile 'tools/security/policy.json')
  Set-Content -LiteralPath (Join-Path $gpguardLockfile 'package.json') -Value '{ "name": "fixture", "private": true }'
  Set-Content -LiteralPath (Join-Path $gpguardLockfile 'package-lock.json') -Value '{ "name": "fixture", "lockfileVersion": 3, "packages": { "node_modules/gpcguard": { "resolved": "file:../GPCGuard", "integrity": "sha512-fake" } } }'
  & git -C $gpguardLockfile add .
  $gpguardLockfileScrub = @(& $shell -NoProfile -File (Join-Path $gpguardLockfile 'tools/check-public-scrub.ps1') -RepoRoot $gpguardLockfile 2>&1)
  Assert-True ($LASTEXITCODE -eq 1) "GPCGuard in lockfile: scrub should FAIL on file: dependency fingerprint but exited 0"
  $gpguardLockfileText = $gpguardLockfileScrub -join "`n"
  Assert-True ($gpguardLockfileText -match 'local file dependency') "GPCGuard in lockfile: 'file:' pattern not reported"
  Assert-True ($gpguardLockfileText -match 'private dependency fingerprint') "GPCGuard in lockfile: forbidden dependency fingerprint not reported"

  # PCONT012: unprofessional tone is a warning, not a hard error.
  # Warnings are surfaced but do not block. -WarningsAsErrors promotes them.
  $vibe = Initialize-Fixture 'vibe'
  $vibeTerm = "vibe" + "coding"
  Set-Content -LiteralPath (Join-Path $vibe 'notes.md') -Value "# Design Notes`nWe adopted $vibeTerm practices during prototyping.`n"
  & git -C $vibe add .
  $vibeWarn = Invoke-Gate (Join-Path $vibe 'tools/check-public-content-policy.ps1') $vibe
  Assert-True ($vibeWarn.ExitCode -eq 0) "PCONT012 warning should exit 0 but got $($vibeWarn.ExitCode)"
  Assert-True (($vibeWarn.Text -join "`n") -match 'PCONT012') "PCONT012 warning not reported in output: $($vibeWarn.Text)"
  Assert-True (($vibeWarn.Text -join "`n") -match 'warn') 'PCONT012 output missing warning indicator'
  $vibeError = @(& $shell -NoProfile -File (Join-Path $vibe 'tools/check-public-content-policy.ps1') -RepoRoot $vibe -WarningsAsErrors -OutputFormat json 2>&1)
  Assert-True ($LASTEXITCODE -eq 1) 'PCONT012 -WarningsAsErrors should exit 1 but got 0'
  Assert-True (($vibeError -join "`n") -match 'PCONT012') 'PCONT012 not in -WarningsAsErrors findings'

  $negative = Initialize-Fixture 'negative'
  $machinePath = 'C:' + '\Users\someone\project'
  $privateParent = 'private ' + 'parent repo'
  Set-Content -LiteralPath (Join-Path $negative 'one.md') -Value @"
# Duplicate v1
Operator: named maintainer in a personal location
$machinePath
$privateParent
opencalw_manager
example_app_one
TODO: replace this stub
The incident caused a 37% regression.
This is production-ready and guarantees an always correct result.
[broken](missing.md)
"@
  Set-Content -LiteralPath (Join-Path $negative 'two.md') -Value "# Duplicate v1`n"
  Set-Content -LiteralPath (Join-Path $negative 'runtime.ts') -Value @'
const root = resolvePath(parent, 'ExampleSiblingWorkspace')
const manifest = 'tools/public-export/manifest.json'
const projectRoot = resolveProjectRoot(projectId, parent)
const inferred = join(workspaceRoot, family, projectFolderName)
'@
  New-Item -ItemType Directory -Path (Join-Path $negative '.github') -Force | Out-Null
  $escapedWorkspacePath = 'C:' + '\\Workspace\\hidden\\project'
  Set-Content -LiteralPath (Join-Path $negative '.github/private.yml') -Value "root: $escapedWorkspacePath"
  Set-Content -LiteralPath (Join-Path $negative '.gitignore') -Value 'ignored.jsonl'
  $escapedUserPath = 'C:' + '\\Users\\ignored\\project'
  Set-Content -LiteralPath (Join-Path $negative 'ignored.jsonl') -Value ('{"root":"' + $escapedUserPath + '"}')
  New-Item -ItemType Directory -Path (Join-Path $negative 'dist') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $negative 'dist/generated.json') -Value '{}'
  [IO.File]::WriteAllBytes((Join-Path $negative 'binary.dat'), [byte[]](0x41,0x00,0x42))
  [IO.File]::WriteAllBytes((Join-Path $negative 'invalid.txt'), [byte[]](0xC3,0x28))
  Set-Content -LiteralPath (Join-Path $negative 'large.txt') -Value ('x' * 1048577)
  Remove-Item -LiteralPath (Join-Path $negative 'BABEL_BIBLE.md')
  & git -C $negative add .
  & git -C $negative add -f ignored.jsonl
  $contentFail = Invoke-Gate (Join-Path $negative 'tools/check-public-content-policy.ps1') $negative
  Assert-True ($contentFail.ExitCode -eq 1) 'negative content fixture unexpectedly passed'
  $contentIds = @((ConvertFrom-Json $contentFail.Text).findings.id)
  foreach ($id in @('PCONT001','PCONT002','PCONT003','PCONT004','PCONT005','PCONT006','PCONT007','PCONT008','PCONT009')) {
    Assert-True ($contentIds -contains $id) "negative content fixture did not produce $id"
  }
  Assert-True ($contentIds -contains 'PCONT010') 'binary/invalid/large tracked files did not fail closed'
  Assert-True ($contentIds -contains 'PCONT011') 'tracked generated artifact did not fail closed'
  $contentFindings = @((ConvertFrom-Json $contentFail.Text).findings)
  Assert-True (@($contentFindings | Where-Object path -eq '.github/private.yml').Count -gt 0) 'hidden tracked file was not scanned'
  Assert-True (@($contentFindings | Where-Object path -eq 'ignored.jsonl').Count -gt 0) 'forced ignored JSONL file was not scanned'
  Assert-True (@($contentFindings | Where-Object id -eq 'PCONT004').Count -ge 2) 'malformed public identifier variants were not all detected'
  Assert-True ($contentFail.Text -notmatch 'someone') 'content finding output exposed source text'

  $canonicalFail = Invoke-Gate (Join-Path $negative 'tools/check-canonical-independence.ps1') $negative
  Assert-True ($canonicalFail.ExitCode -eq 1) 'negative canonical fixture unexpectedly passed'
  $canonicalIds = @((ConvertFrom-Json $canonicalFail.Text).findings.id)
  foreach ($id in @('CANON000','CANON001','CANON002','CANON003','CANON004')) {
    Assert-True ($canonicalIds -contains $id) "negative canonical fixture did not produce $id"
  }

  $scrubRoot = Join-Path $tempRoot 'scrub'
  New-Item -ItemType Directory -Path (Join-Path $scrubRoot 'tools/security') -Force | Out-Null
  Copy-Item -LiteralPath $scrubScript -Destination (Join-Path $scrubRoot 'tools/check-public-scrub.ps1')
  Copy-Item -LiteralPath $scrubPolicy -Destination (Join-Path $scrubRoot 'tools/security/policy.json')
  Copy-Item -LiteralPath $commonModule -Destination (Join-Path $scrubRoot 'tools/security/tracked-scan-common.ps1')
  Add-Content -LiteralPath (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -Value '# FixtureMarkerXYZ'
  New-Item -ItemType Directory -Path (Join-Path $scrubRoot '.github') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $scrubRoot '.github/hidden.yml') -Value 'value: FixtureMarkerXYZ'
  Set-Content -LiteralPath (Join-Path $scrubRoot '.gitignore') -Value 'ignored.txt'
  Set-Content -LiteralPath (Join-Path $scrubRoot 'ignored.txt') -Value 'FixtureMarkerXYZ'
  $supplemental = Join-Path $tempRoot 'supplemental.json'
  Set-Content -LiteralPath $supplemental -Value '{"forbidden_private_identifiers":["FixtureMarkerXYZ"],"forbidden_dependency_fingerprints":[]}'
  & git -C $scrubRoot init --quiet
  & git -C $scrubRoot config user.email 'fixture@example.invalid'
  & git -C $scrubRoot config user.name 'Fixture Runner'
  & git -C $scrubRoot add .
  & git -C $scrubRoot add -f ignored.txt
  $env:BABEL_PRIVATE_SCRUB_POLICY_PATH = (Join-Path $tempRoot 'missing.json')
  $scrubOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot -SupplementalPolicyPath $supplemental 2>&1)
  $scrubExit = $LASTEXITCODE
  Assert-True ($scrubExit -eq 1) 'supplemental scan did not inspect its own scanner file'
  Assert-True (($scrubOutput -join "`n") -notmatch 'FixtureMarkerXYZ') 'supplemental finding exposed the matched value'
  Assert-True (($scrubOutput -join "`n") -match 'identifier: tools/check-public-scrub.ps1:') 'supplemental finding omitted redacted path and line'
  Assert-True (($scrubOutput -join "`n") -match 'identifier: .github/hidden.yml:') 'supplemental scan skipped a hidden tracked file'
  Assert-True (($scrubOutput -join "`n") -match 'identifier: ignored.txt:') 'supplemental scan skipped a forced ignored tracked file'

  $missingOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot 2>&1)
  Assert-True ($LASTEXITCODE -ne 0) 'configured missing supplemental policy did not fail closed'
  Assert-True (($missingOutput -join "`n") -notmatch [regex]::Escape($env:BABEL_PRIVATE_SCRUB_POLICY_PATH)) 'missing supplemental failure exposed its configured path'
  Remove-Item Env:BABEL_PRIVATE_SCRUB_POLICY_PATH -ErrorAction SilentlyContinue
  $requiredMissingOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot -RequireSupplementalPolicy 2>&1)
  Assert-True ($LASTEXITCODE -ne 0) 'required supplemental policy absence did not fail closed'
  $malformedPolicy = Join-Path $tempRoot 'malformed-supplemental.json'
  Set-Content -LiteralPath $malformedPolicy -Value '{'
  $malformedOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot -SupplementalPolicyPath $malformedPolicy 2>&1)
  Assert-True ($LASTEXITCODE -ne 0) 'malformed supplemental policy did not fail closed'
  Assert-True (($malformedOutput -join "`n") -notmatch [regex]::Escape($malformedPolicy)) 'malformed supplemental failure exposed its configured path'
  $emptyPolicy = Join-Path $tempRoot 'empty-supplemental.json'
  Set-Content -LiteralPath $emptyPolicy -Value '{"forbidden_private_identifiers":[],"forbidden_dependency_fingerprints":[]}'
  $emptyOutput = @(& $shell -NoProfile -File (Join-Path $scrubRoot 'tools/check-public-scrub.ps1') -RepoRoot $scrubRoot -SupplementalPolicyPath $emptyPolicy -RequireSupplementalPolicy 2>&1)
  Assert-True ($LASTEXITCODE -ne 0) 'required empty supplemental policy did not fail closed'

  Write-Host 'Public prevention gate fixture tests passed.' -ForegroundColor Green
} finally {
  Remove-Item Env:BABEL_PRIVATE_SCRUB_POLICY_PATH -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
}
