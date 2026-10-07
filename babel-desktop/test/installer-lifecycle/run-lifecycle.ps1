# License: Apache-2.0
# Installer lifecycle qualification for Babel Desktop Setup.exe.
#
# This is the acceptance gate the IExpress approach (PR #308) failed and the
# NSIS pivot must pass: silent install, install-state assertions, bundled CLI
# smoke launch, upgrade with install-id rotation, failed-upgrade rollback,
# ownership-checked uninstall, and reinstall - all on a pristine user profile
# (the CI runner IS the clean user).
#
# Fail-closed: refuses to run on a machine that already has a Babel Desktop
# per-user install, and always attempts to leave the machine clean.
#
# Usage:
#   pwsh -File run-lifecycle.ps1 -PayloadZip <zip> -Sha256Sums <sums> `
#        -MakensisPath <Bin\makensis.exe> [-SkipCliSmoke]
param(
  [Parameter(Mandatory = $true)][string]$PayloadZip,
  [Parameter(Mandatory = $true)][string]$Sha256Sums,
  [Parameter(Mandatory = $true)][string]$MakensisPath,
  [switch]$SkipCliSmoke
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktop = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$repo = (Resolve-Path (Join-Path $desktop '..')).Path
$workRoot = Join-Path ([IO.Path]::GetTempPath()) ("babel-lifecycle-" + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $env:LOCALAPPDATA 'Programs\Babel Desktop'
$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Babel Desktop.lnk'
$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Babel Desktop'

$script:failures = New-Object System.Collections.Generic.List[string]
function Assert-That {
  param([Parameter(Mandatory = $true)][string]$Description, [Parameter(Mandatory = $true)][scriptblock]$Condition)
  $ok = & $Condition
  if ($ok) { Write-Host "  [PASS] $Description" }
  else { Write-Host "  [FAIL] $Description"; $script:failures.Add($Description) }
}

function Wait-For {
  param([Parameter(Mandatory = $true)][scriptblock]$Condition, [int]$TimeoutSeconds = 120, [string]$What = 'condition')
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return (& $Condition)
}

function Invoke-SilentInstall {
  param([Parameter(Mandatory = $true)][string]$SetupPath)
  $proc = Start-Process -FilePath $SetupPath -ArgumentList '/S' -Wait -PassThru
  return $proc.ExitCode
}

function Get-InstallState {
  $state = [ordered]@{
    Dir = Test-Path -LiteralPath $installRoot
    Registry = $null
    Shortcut = $null
    InstallIdFile = $null
  }
  $entry = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
  if ($entry) {
    $state.Registry = [ordered]@{ Version = [string]$entry.DisplayVersion; Location = [string]$entry.InstallLocation; Id = [string]$entry.BabelInstallId }
  }
  if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    $state.Shortcut = [string]$link.TargetPath
  }
  $idPath = Join-Path $installRoot '.babel-install-id'
  if (Test-Path -LiteralPath $idPath -PathType Leaf) { $state.InstallIdFile = (Get-Content -LiteralPath $idPath -Raw).Trim() }
  return $state
}

function Invoke-Cleanup {
  # Best-effort return of the machine to its pre-harness state.
  if (Test-Path -LiteralPath (Join-Path $installRoot 'uninstall-windows.ps1') -PathType Leaf) {
    try { & (Join-Path $installRoot 'uninstall-windows.ps1') | Out-Null } catch { }
  } elseif (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue }
  }
  Wait-For -What 'cleanup' -TimeoutSeconds 60 -Condition { -not (Test-Path -LiteralPath $registryPath) }
}

Write-Host "== Installer lifecycle qualification =="
foreach ($file in @($PayloadZip, $Sha256Sums, $MakensisPath)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required input missing: $file" }
}
if (Test-Path -LiteralPath $registryPath) { throw 'A Babel Desktop per-user install already exists on this machine; run on a clean user only.' }
if (Test-Path -LiteralPath $installRoot) { throw 'An install directory already exists; run on a clean user only.' }

New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
try {
  # --- 1. Build Setup v1 -------------------------------------------------------
  Write-Host "[1/8] Building Setup.exe from the qualified payload"
  $out1 = Join-Path $workRoot 'setup-v1'
  node (Join-Path $desktop 'scripts/package-windows-setup.mjs') --payload-zip="$PayloadZip" --payload-sha256s="$Sha256Sums" --makensis="$MakensisPath" --output="$out1" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "setup build failed with exit $LASTEXITCODE" }
  $setupV1 = Get-ChildItem -Path $out1 -Filter '*.exe' | Select-Object -First 1 -ExpandProperty FullName
  if (-not $setupV1) { throw 'no Setup.exe produced' }

  # --- 2. Silent install ---------------------------------------------------------
  Write-Host "[2/8] Silent install (/S)"
  $exitCode = Invoke-SilentInstall -SetupPath $setupV1
  $done = Wait-For -What 'install completion' -TimeoutSeconds 120 -Condition { Test-Path -LiteralPath (Join-Path $installRoot 'BUILD.json') -PathType Leaf }
  Assert-That 'silent install exits 0' { $exitCode -eq 0 }
  Assert-That 'install directory and BUILD.json exist' { $done }

  # --- 3. Install-state assertions --------------------------------------------------
  Write-Host "[3/8] Install-state assertions"
  $state1 = Get-InstallState
  Assert-That 'HKCU uninstall entry exists' { $null -ne $state1.Registry }
  Assert-That 'Start Menu shortcut targets the installed exe' {
    $shortcutTarget = $state1.Shortcut
    if (-not $shortcutTarget) { return $false }
    $resolvedLink = Resolve-Path -LiteralPath $shortcutTarget -ErrorAction SilentlyContinue
    $resolvedExe = Resolve-Path -LiteralPath (Join-Path $installRoot 'Babel Desktop.exe') -ErrorAction SilentlyContinue
    $resolvedLink -and $resolvedExe -and ($resolvedLink.Path -eq $resolvedExe.Path)
  }
  Assert-That 'install-id marker matches the registry' { $state1.Registry -and $state1.InstallIdFile -and ($state1.Registry.Id -eq $state1.InstallIdFile) }
  Assert-That 'uninstall registration points at the install root' { $state1.Registry -and ([IO.Path]::GetFullPath($state1.Registry.Location).TrimEnd('\') -eq [IO.Path]::GetFullPath($installRoot).TrimEnd('\')) }
  $v1 = $state1.Registry.Version

  # --- 4. Bundled CLI smoke ----------------------------------------------------------
  if (-not $SkipCliSmoke) {
    Write-Host "[4/8] Bundled CLI smoke launch"
    $harnessCmd = Join-Path $installRoot 'Babel Harness.cmd'
    $smoke = Start-Process -FilePath $harnessCmd -ArgumentList '--version' -Wait -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $workRoot 'smoke.out') -RedirectStandardError (Join-Path $workRoot 'smoke.err')
    Assert-That 'bundled CLI responds to --version with exit 0' { $smoke.ExitCode -eq 0 }
  } else {
    Write-Host "[4/8] Bundled CLI smoke skipped (-SkipCliSmoke)"
  }

  # --- 5. Upgrade (v1 -> v2) -----------------------------------------------------------
  Write-Host "[5/8] Upgrade to a bumped payload version"
  Push-Location $repo
  try {
    $pkg = Get-Content (Join-Path $repo 'babel-desktop/package.json') -Raw | ConvertFrom-Json
    $parts = [version]$pkg.version.Split('-')[0]
    $v2 = '{0}.{1}.{2}' -f $parts.Major, $parts.Minor, ($parts.Build + 1)
    $raw = Get-Content (Join-Path $repo 'babel-desktop/package.json') -Raw
    $raw = $raw -replace [regex]::Escape('"version": "' + $pkg.version + '"'), ('"version": "' + $v2 + '"')
    Set-Content (Join-Path $repo 'babel-desktop/package.json') -Value $raw -NoNewline -Encoding utf8
    git -C $repo add babel-desktop/package.json
    git -C $repo commit -m "test: bump desktop version to $v2 for lifecycle upgrade fixture" | Out-Null
    $out2 = Join-Path $workRoot 'payload-v2'
    # package-windows.mjs shells out to npm; invoked via node directly there is
    # no npm_execpath, so resolve npm's cli js from the npm on PATH.
    $npmCmd = (Get-Command npm.cmd -ErrorAction Stop).Source
    $npmCli = Join-Path (Split-Path $npmCmd -Parent) 'node_modules\npm\bin\npm-cli.js'
    node (Join-Path $repo 'babel-desktop/scripts/package-windows.mjs') --node-archive="$env:LIFECYCLE_NODE_ARCHIVE" --electron-archive="$env:LIFECYCLE_ELECTRON_ARCHIVE" --output="$out2" --npm-cli="$npmCli" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "payload v2 build failed" }
    $setupV2Out = Join-Path $workRoot 'setup-v2'
    node (Join-Path $desktop 'scripts/package-windows-setup.mjs') --payload-zip="$out2/Babel-Desktop-$v2-win-x64.zip" --payload-sha256s="$out2/SHA256SUMS" --makensis="$MakensisPath" --output="$setupV2Out" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "setup v2 build failed" }
    $setupV2 = Get-ChildItem -Path $setupV2Out -Filter '*.exe' | Select-Object -First 1 -ExpandProperty FullName
  } finally { Pop-Location }

  $exitCode2 = Invoke-SilentInstall -SetupPath $setupV2
  $null = Wait-For -What 'upgrade completion' -TimeoutSeconds 120 -Condition {
    $s = Get-InstallState
    $s.Registry -and $s.Registry.Version -eq $v2
  }
  $state2 = Get-InstallState
  Assert-That 'upgrade exits 0' { $exitCode2 -eq 0 }
  Assert-That 'registry reports the new version' { $state2.Registry -and $state2.Registry.Version -eq $v2 }
  Assert-That 'install-id rotated across the upgrade' { $state2.Registry -and $state1.Registry -and ($state2.Registry.Id -ne $state1.Registry.Id) }
  Assert-That 'no leftover backup directories' { -not (Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Programs') -Directory -Filter '.Babel Desktop *' -ErrorAction SilentlyContinue) }

  # --- 6. Failed-upgrade rollback --------------------------------------------------------
  Write-Host "[6/8] Failed-upgrade rollback (payload missing BUILD.json)"
  $corruptDir = Join-Path $workRoot 'corrupt-payload'
  New-Item -ItemType Directory -Path $corruptDir -Force | Out-Null
  Expand-Archive -LiteralPath (Get-ChildItem -Path $out2 -Filter '*.zip' | Select-Object -First 1 -ExpandProperty FullName) -DestinationPath $corruptDir
  $bundle = Get-ChildItem -LiteralPath $corruptDir -Directory | Select-Object -First 1
  Remove-Item -LiteralPath (Join-Path $bundle.FullName 'BUILD.json') -Force
  $corruptZip = Join-Path $workRoot 'corrupt.zip'
  Compress-Archive -Path (Join-Path $corruptDir '*') -DestinationPath $corruptZip -Force
  $corruptSha = (Get-FileHash -LiteralPath $corruptZip -Algorithm SHA256).Hash.ToLowerInvariant()
  $corruptStage = Join-Path $workRoot 'corrupt-stage'
  New-Item -ItemType Directory -Path $corruptStage -Force | Out-Null
  Copy-Item -LiteralPath $corruptZip -Destination (Join-Path $corruptStage 'Babel-Desktop-payload.zip')
  Set-Content -LiteralPath (Join-Path $corruptStage 'payload.sha256') -Value "$corruptSha" -Encoding ascii
  Copy-Item -LiteralPath (Join-Path $desktop 'scripts/install-windows.ps1') -Destination (Join-Path $corruptStage 'install-windows.ps1')
  Copy-Item -LiteralPath (Join-Path $desktop 'scripts/uninstall-windows.ps1') -Destination (Join-Path $corruptStage 'uninstall-windows.ps1')

  $rollbackThrew = $false
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $corruptStage 'install-windows.ps1') | Out-Null
  } catch { $rollbackThrew = $true }
  $null = Wait-For -What 'rollback completion' -TimeoutSeconds 60 -Condition {
    $s = Get-InstallState
    $s.Registry -and $s.Registry.Version -eq $v2 -and $s.Registry.Id -eq $state2.Registry.Id
  }
  $state3 = Get-InstallState
  Assert-That 'corrupt upgrade is rejected' { $rollbackThrew -or $LASTEXITCODE -ne 0 }
  Assert-That 'v2 install survives the failed upgrade' { $state3.Registry -and $state3.Registry.Version -eq $v2 -and $state3.Registry.Id -eq $state2.Registry.Id }

  # --- 7. Ownership-checked uninstall ------------------------------------------------------
  Write-Host "[7/8] Uninstall"
  & (Join-Path $installRoot 'uninstall-windows.ps1') | Out-Null
  $uninstalled = Wait-For -What 'uninstall completion' -TimeoutSeconds 90 -Condition { -not (Test-Path -LiteralPath $registryPath) -and -not (Test-Path -LiteralPath $installRoot) }
  Assert-That 'uninstall removes registry entry and install directory' { $uninstalled }
  Assert-That 'uninstall removes the Start Menu shortcut' { -not (Test-Path -LiteralPath $shortcutPath -PathType Leaf) }

  # --- 8. Reinstall ---------------------------------------------------------------------------
  Write-Host "[8/8] Reinstall from the v1 Setup"
  $exitCode3 = Invoke-SilentInstall -SetupPath $setupV1
  $reinstalled = Wait-For -What 'reinstall completion' -TimeoutSeconds 120 -Condition {
    $s = Get-InstallState
    $s.Registry -and $s.InstallIdFile -and ($s.Registry.Id -eq $s.InstallIdFile)
  }
  Assert-That 'reinstall exits 0 and produces a consistent install' { ($exitCode3 -eq 0) -and $reinstalled }
} finally {
  Write-Host "== Cleanup =="
  Invoke-Cleanup
  Remove-Item -LiteralPath $workRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures.Count -gt 0) {
  Write-Host ""
  Write-Host ("LIFECYCLE QUALIFICATION FAILED ({0} assertions):" -f $script:failures.Count)
  foreach ($f in $script:failures) { Write-Host ("  - " + $f) }
  exit 1
}
Write-Host ""
Write-Host "LIFECYCLE QUALIFICATION PASSED (install, state, smoke, upgrade, rollback, uninstall, reinstall)."
exit 0
