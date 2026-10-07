# License: Apache-2.0
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPathValue {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
  throw 'Babel Desktop Setup supports Windows x64 only.'
}
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or [string]::IsNullOrWhiteSpace($env:APPDATA)) {
  throw 'Windows user profile paths are unavailable; sign in to a Windows user account and retry.'
}

$payloadPath = Join-Path $PSScriptRoot 'Babel-Desktop-payload.zip'
$checksumPath = Join-Path $PSScriptRoot 'payload.sha256'
if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf) -or -not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
  throw 'Setup payload is incomplete. Download the complete Setup.exe again.'
}
$expectedSha = (Get-Content -LiteralPath $checksumPath -Raw).Trim().ToLowerInvariant()
if ($expectedSha -notmatch '^[0-9a-f]{64}$') { throw 'Setup payload checksum is malformed.' }
# Compute the digest via .NET directly: Get-FileHash lives in a module that
# auto-loading can miss when the parent process (e.g. a pwsh-spawned NSIS)
# injects a foreign PSModulePath into this Windows PowerShell process.
function Get-PayloadSha256 {
  param([Parameter(Mandatory = $true)][string]$Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $stream = [System.IO.File]::OpenRead($Path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose() }
  } finally { $sha.Dispose() }
}
$actualSha = Get-PayloadSha256 -Path $payloadPath
if ($actualSha -cne $expectedSha) { throw 'Setup payload checksum does not match; no files were installed.' }

$programsRoot = Join-Path $env:LOCALAPPDATA 'Programs'
$installRoot = Join-Path $programsRoot 'Babel Desktop'
$startMenuRoot = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$shortcutPath = Join-Path $startMenuRoot 'Babel Desktop.lnk'
$uninstallRegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Babel Desktop'
$executablePath = Join-Path $installRoot 'Babel Desktop.exe'
$stageRoot = Join-Path $programsRoot ('.Babel Desktop staging ' + [guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $programsRoot ('.Babel Desktop previous ' + [guid]::NewGuid().ToString('N'))
$shortcutBackup = Join-Path $programsRoot ('.Babel Desktop shortcut ' + [guid]::NewGuid().ToString('N') + '.lnk')
$registryBackup = Join-Path $programsRoot ('.Babel Desktop registry ' + [guid]::NewGuid().ToString('N') + '.json')
$process = Get-Process -Name 'Babel Desktop' -ErrorAction SilentlyContinue
if ($process) { throw 'Close Babel Desktop before installing or updating it.' }

New-Item -ItemType Directory -Path $programsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
$movedPreviousInstall = $false
$installedNewPayload = $false
$shortcutWasBackedUp = $false
$registryWasPresent = Test-Path -LiteralPath $uninstallRegistryPath
$registryValues = $null
$registrySnapshotComplete = $false
$startMenuCreated = $false
$installationCommitted = $false

try {
  if ($registryWasPresent) {
    $existingRegistration = Get-ItemProperty -LiteralPath $uninstallRegistryPath
    $existingInstallIdPath = Join-Path $installRoot '.babel-install-id'
    if ([string]::IsNullOrWhiteSpace([string]$existingRegistration.InstallLocation) -or
        (Get-FullPathValue ([string]$existingRegistration.InstallLocation)) -cne (Get-FullPathValue $installRoot) -or
        -not (Test-Path -LiteralPath $existingInstallIdPath -PathType Leaf) -or
        (Get-Content -LiteralPath $existingInstallIdPath -Raw).Trim() -cne [string]$existingRegistration.BabelInstallId) {
      throw 'A different product already owns the Babel Desktop uninstall entry; Setup made no changes.'
    }
    $registryValues = [ordered]@{}
    foreach ($property in $existingRegistration.PSObject.Properties) {
      if ($property.Name -notmatch '^PS') { $registryValues[$property.Name] = $property.Value }
    }
    $registryValues | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $registryBackup -Encoding utf8
    $registrySnapshotComplete = $true
  }

  if (Test-Path -LiteralPath $installRoot) {
    $oldBuildPath = Join-Path $installRoot 'BUILD.json'
    $oldExePath = Join-Path $installRoot 'Babel Desktop.exe'
    if (-not (Test-Path -LiteralPath $oldBuildPath -PathType Leaf) -or -not (Test-Path -LiteralPath $oldExePath -PathType Leaf)) {
      throw 'The install directory already contains unrecognized files; move it aside before installing.'
    }
    if (-not $registryWasPresent) {
      throw 'The install directory has no Babel Desktop uninstall registration; move it aside before installing.'
    }
  } elseif ($registryWasPresent) {
    throw 'The Babel Desktop uninstall entry points to a missing installation; remove that stale entry before retrying.'
  }

  if (Test-Path -LiteralPath $shortcutPath) {
    $existingShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    if ((Get-FullPathValue ([string]$existingShortcut.TargetPath)) -cne (Get-FullPathValue $executablePath)) {
      throw 'A different shortcut already uses the Babel Desktop Start Menu name; Setup made no changes.'
    }
    Copy-Item -LiteralPath $shortcutPath -Destination $shortcutBackup
    $shortcutWasBackedUp = $true
  }

  # tar.exe (Windows bsdtar) extracts ZIPs without the .NET zip path that
  # 32-bit Windows PowerShell cannot parse on some bsdtar-produced archives.
  # Pin the Windows system bsdtar: PATH may resolve a GNU tar (e.g. a Git Bash
  # install) that misreads drive-letter paths as remote hosts.
  $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tarExe -PathType Leaf)) { $tarExe = 'tar.exe' }
  & $tarExe -xf $payloadPath -C $stageRoot
  if ($LASTEXITCODE -ne 0) { throw 'Portable ZIP extraction failed.' }
  $bundleDirectories = @(Get-ChildItem -LiteralPath $stageRoot -Directory)
  if ($bundleDirectories.Count -ne 1) { throw 'Portable ZIP must contain exactly one Desktop bundle directory.' }
  $stagedBundle = $bundleDirectories[0].FullName
  $buildPath = Join-Path $stagedBundle 'BUILD.json'
  $stagedExe = Join-Path $stagedBundle 'Babel Desktop.exe'
  $stagedRuntime = Join-Path $stagedBundle 'resources\babel-runtime\node\node.exe'
  if (-not (Test-Path -LiteralPath $buildPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $stagedExe -PathType Leaf) -or
      -not (Test-Path -LiteralPath $stagedRuntime -PathType Leaf)) {
    throw 'Portable ZIP is missing required Desktop or bundled runtime files.'
  }
  $build = Get-Content -LiteralPath $buildPath -Raw | ConvertFrom-Json
  if ($build.platform -cne 'win32-x64' -or $build.signed -ne $false -or [string]$build.version -notmatch '^\d+\.\d+\.\d+(-preview\.\d{8})?$') {
    throw 'Portable ZIP metadata is not a supported unsigned Windows x64 Desktop build.'
  }
  $installId = [guid]::NewGuid().ToString('N')
  Set-Content -LiteralPath (Join-Path $stagedBundle '.babel-install-id') -Value $installId -NoNewline -Encoding ascii
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-windows.ps1') -Destination (Join-Path $stagedBundle 'uninstall-windows.ps1')

  if (Test-Path -LiteralPath $installRoot) {
    Move-Item -LiteralPath $installRoot -Destination $backupRoot
    $movedPreviousInstall = $true
  }
  Move-Item -LiteralPath $stagedBundle -Destination $installRoot
  $installedNewPayload = $true

  New-Item -ItemType Directory -Path $startMenuRoot -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $executablePath
  $shortcut.WorkingDirectory = $installRoot
  $shortcut.IconLocation = "$executablePath,0"
  $shortcut.Description = 'Babel Desktop — portable CLI runtime included'
  $shortcut.Save()
  $startMenuCreated = $true

  if (-not (Test-Path -LiteralPath $uninstallRegistryPath)) {
    New-Item -Path $uninstallRegistryPath -Force | Out-Null
  }
  $uninstallCommand = "`"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $installRoot 'uninstall-windows.ps1')`""
  $registryProperties = [ordered]@{
    DisplayName = 'Babel Desktop'
    DisplayVersion = [string]$build.version
    Publisher = 'Babel'
    InstallLocation = $installRoot
    DisplayIcon = "$executablePath,0"
    UninstallString = $uninstallCommand
    BabelInstallId = $installId
    NoModify = 1
    NoRepair = 1
  }
  foreach ($entry in $registryProperties.GetEnumerator()) {
    if ($entry.Value -is [string]) {
      New-ItemProperty -LiteralPath $uninstallRegistryPath -Name $entry.Key -Value $entry.Value -PropertyType String -Force | Out-Null
    } elseif ($entry.Value -is [int]) {
      New-ItemProperty -LiteralPath $uninstallRegistryPath -Name $entry.Key -Value $entry.Value -PropertyType DWord -Force | Out-Null
    }
  }

  $installationCommitted = $true
  if (Test-Path -LiteralPath $backupRoot) {
    try {
      Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop
    } catch {
      Write-Warning 'The new version is installed, but the previous-version backup could not be fully removed.'
    }
  }
  Write-Output "Babel Desktop $($build.version) installed for this Windows user."
  Write-Output "Start Menu shortcut: $shortcutPath"
  Write-Output 'User settings and project data are stored outside the install folder and are preserved by uninstall.'
} catch {
  if ($installationCommitted) { throw }
  if ($startMenuCreated -and (Test-Path -LiteralPath $shortcutPath)) { Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue }
  if ($shortcutWasBackedUp -and (Test-Path -LiteralPath $shortcutBackup)) { Move-Item -LiteralPath $shortcutBackup -Destination $shortcutPath -Force -ErrorAction SilentlyContinue }
  if ($registryWasPresent) {
    if ($registrySnapshotComplete -and (Test-Path -LiteralPath $registryBackup)) {
      $currentRegistration = Get-ItemProperty -LiteralPath $uninstallRegistryPath -ErrorAction SilentlyContinue
      if ($null -ne $currentRegistration) {
        foreach ($property in $currentRegistration.PSObject.Properties) {
          if ($property.Name -notmatch '^PS' -and @($registryValues.Keys) -notcontains $property.Name) {
            Remove-ItemProperty -LiteralPath $uninstallRegistryPath -Name $property.Name -ErrorAction SilentlyContinue
          }
        }
      }
      $oldProperties = Get-Content -LiteralPath $registryBackup -Raw | ConvertFrom-Json
      if (-not (Test-Path -LiteralPath $uninstallRegistryPath)) { New-Item -Path $uninstallRegistryPath -Force | Out-Null }
      foreach ($property in $oldProperties.PSObject.Properties) {
        if ($property.Value -is [int]) {
          New-ItemProperty -LiteralPath $uninstallRegistryPath -Name $property.Name -Value $property.Value -PropertyType DWord -Force | Out-Null
        } else {
          New-ItemProperty -LiteralPath $uninstallRegistryPath -Name $property.Name -Value ([string]$property.Value) -PropertyType String -Force | Out-Null
        }
      }
    }
  } elseif (Test-Path -LiteralPath $uninstallRegistryPath) {
    Remove-Item -LiteralPath $uninstallRegistryPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($installedNewPayload -and (Test-Path -LiteralPath $installRoot)) { Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if ($movedPreviousInstall -and (Test-Path -LiteralPath $backupRoot)) { Move-Item -LiteralPath $backupRoot -Destination $installRoot -Force -ErrorAction SilentlyContinue }
  throw
} finally {
  foreach ($path in @($stageRoot, $shortcutBackup, $registryBackup)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
