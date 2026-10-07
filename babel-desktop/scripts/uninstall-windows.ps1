# License: Apache-2.0
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-FullPathValue {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-PowerShellLiteral {
  param([Parameter(Mandatory = $true)][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

$installRoot = Get-FullPathValue $PSScriptRoot
$expectedInstallRoot = Get-FullPathValue (Join-Path $env:LOCALAPPDATA 'Programs\Babel Desktop')
if ($installRoot -cne $expectedInstallRoot) { throw 'Uninstall stopped because the app is outside this user''s Babel Desktop install folder.' }
$buildPath = Join-Path $installRoot 'BUILD.json'
if (-not (Test-Path -LiteralPath $buildPath -PathType Leaf)) { throw 'Uninstall stopped because the install marker is missing.' }
$build = Get-Content -LiteralPath $buildPath -Raw | ConvertFrom-Json
if ($build.platform -cne 'win32-x64') { throw 'Uninstall stopped because the install marker does not identify Babel Desktop.' }
$installIdPath = Join-Path $installRoot '.babel-install-id'
if (-not (Test-Path -LiteralPath $installIdPath -PathType Leaf)) { throw 'Uninstall stopped because this install has no ownership marker.' }
$installId = (Get-Content -LiteralPath $installIdPath -Raw).Trim()
if ($installId -notmatch '^[0-9a-f]{32}$') { throw 'Uninstall stopped because this install ownership marker is malformed.' }

$registryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Babel Desktop'
$registration = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
if ($null -eq $registration -or
    (Get-FullPathValue ([string]$registration.InstallLocation)) -cne $installRoot -or
    [string]$registration.BabelInstallId -cne $installId) {
  throw 'Uninstall stopped because this installation does not own its per-user uninstall entry.'
}
if (Get-Process -Name 'Babel Desktop' -ErrorAction SilentlyContinue) {
  throw 'Close Babel Desktop before uninstalling it.'
}

$shortcutPath = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Babel Desktop.lnk'
$quotedInstallRoot = Get-PowerShellLiteral $installRoot
$quotedInstallId = Get-PowerShellLiteral $installId
$quotedRegistryPath = Get-PowerShellLiteral $registryPath
$quotedShortcutPath = Get-PowerShellLiteral $shortcutPath
$cleanup = @"
`$ErrorActionPreference = 'Stop'
Start-Sleep -Seconds 2
`$installRoot = $quotedInstallRoot
`$installId = $quotedInstallId
`$expected = [IO.Path]::GetFullPath((Join-Path `$env:LOCALAPPDATA 'Programs\Babel Desktop')).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
if ([IO.Path]::GetFullPath(`$installRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -cne `$expected) { exit 2 }
if (Get-Process -Name 'Babel Desktop' -ErrorAction SilentlyContinue) { exit 3 }
`$buildPath = Join-Path `$installRoot 'BUILD.json'
if (-not (Test-Path -LiteralPath `$buildPath -PathType Leaf)) { exit 4 }
`$marker = Get-Content -LiteralPath `$buildPath -Raw | ConvertFrom-Json
if (`$marker.platform -cne 'win32-x64') { exit 5 }
`$registryPath = $quotedRegistryPath
`$entry = Get-ItemProperty -LiteralPath `$registryPath -ErrorAction SilentlyContinue
`$installIdPath = Join-Path `$installRoot '.babel-install-id'
if (-not (Test-Path -LiteralPath `$installIdPath -PathType Leaf) -or (Get-Content -LiteralPath `$installIdPath -Raw).Trim() -cne `$installId) { exit 6 }
if (`$null -eq `$entry -or
    [IO.Path]::GetFullPath([string]`$entry.InstallLocation).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) -cne `$installRoot -or
    [string]`$entry.BabelInstallId -cne `$installId) { exit 7 }
Remove-Item -LiteralPath `$registryPath -Recurse -Force
if ((Test-Path -LiteralPath `$installIdPath -PathType Leaf) -and (Get-Content -LiteralPath `$installIdPath -Raw).Trim() -cne `$installId) { exit 8 }
if (Test-Path -LiteralPath `$registryPath) { exit 9 }
`$shortcutPath = $quotedShortcutPath
if (Test-Path -LiteralPath `$shortcutPath -PathType Leaf) {
  try {
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(`$shortcutPath)
    if ([IO.Path]::GetFullPath([string]`$link.TargetPath) -ceq (Join-Path `$installRoot 'Babel Desktop.exe')) { Remove-Item -LiteralPath `$shortcutPath -Force }
  } catch { Write-Warning 'The Start Menu shortcut could not be removed.' }
}
if (-not (Test-Path -LiteralPath `$installIdPath -PathType Leaf) -or (Get-Content -LiteralPath `$installIdPath -Raw).Trim() -cne `$installId -or (Test-Path -LiteralPath `$registryPath)) { exit 10 }
Remove-Item -LiteralPath `$installRoot -Recurse -Force
"@
$encodedCleanup = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cleanup))
# Pin the system Windows PowerShell: $PSHOME would resolve to PowerShell 7
# when this script is invoked from pwsh, and powershell.exe does not exist there.
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Start-Process -FilePath $powerShellExe -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCleanup) -WorkingDirectory $env:TEMP -WindowStyle Hidden | Out-Null
Write-Output 'Uninstall started. Babel Desktop files will be removed; user settings and project data are preserved.'
