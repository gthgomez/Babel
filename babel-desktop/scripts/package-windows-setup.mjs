// License: Apache-2.0
// Builds the per-user Babel Desktop Setup.exe by wrapping a checksum-verified
// portable ZIP in a pinned NSIS 3.x package. The NSIS layer only extracts the
// payload files and runs install-windows.ps1 (SHA verification, staged
// upgrade/rollback, Start Menu shortcut, HKCU uninstall registration all live
// there). Replaces the IExpress approach abandoned in PR #308, whose silent
// probes could not produce a working install.
//
// Output (per run, refuses existing files):
//   Babel-Desktop-Setup-<version>-win-x64.exe
//   Babel-Desktop-Setup-<version>-win-x64.exe.sha256
//   Babel-Desktop-Setup-<version>-win-x64.build.json
import {cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const desktopPackage = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const nsisVersion = '3.11';
const nsisSha = 'c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1';

// Pure helpers (unit-tested in test/package-windows-setup.test.mjs).
export function validatePayloadBuild(build) {
  if (build.platform !== 'win32-x64') throw new Error(`Payload platform must be win32-x64 (got ${build.platform})`);
  if (build.signed !== false) throw new Error('This builder produces unsigned installers only; a signed payload needs the signing workflow');
  if (!/^\d+\.\d+\.\d+(-preview\.\d{8})?$/.test(String(build.version))) {
    throw new Error(`Payload version '${build.version}' is not a supported x.y.z or x.y.z-preview.YYYYMMDD form`);
  }
  return String(build.version);
}

export function parseSha256Sums(text, zipName) {
  const line = text.split(/\r?\n/).find(l => l.trim().endsWith(zipName));
  if (!line) throw new Error(`SHA256SUMS has no entry for ${zipName}`);
  return line.trim().split(/\s+/)[0].replace(/^\*/, '').toLowerCase();
}

export function compileNsis({makensis, script, useArchive, nsisExtract}, runCommand, recordArtifacts, removeDirectory = rmSync) {
  let primaryError;
  try {
    runCommand(makensis, ['-V2', script]);
    return recordArtifacts();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (useArchive) {
      try {
        removeDirectory(nsisExtract, {recursive: true, force: true});
      } catch (cleanupError) {
        // A locked extract directory (e.g. Windows EBUSY) must not mask the
        // build error; a cleanup failure with no primary error still fails.
        if (!primaryError) throw cleanupError;
      }
    }
  }
}

export function renderNsis({version, stagedPayload, stagedSha, stagedInstall, stagedUninstall, stagedBootstrap, outFile}) {
  const fw = p => '"' + p + '"'; // NSIS File wants backslash paths, quoted when they contain spaces
  return `
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SilentInstall normal

!define PRODUCT_NAME "Babel Desktop"
!define PRODUCT_VERSION "${version}"

Name "\${PRODUCT_NAME} \${PRODUCT_VERSION} Setup"
OutFile ${fw(outFile)}
InstallDir "$TEMP\\BabelDesktopSetup"
ShowInstDetails show

Page instfiles

Section "Install"
  ; Deterministic staging: wipe any prior staging dir, then extract with
  ; unconditional overwrite (NSIS's default "ifnewer" can leave stale files
  ; behind because File preserves the compiled-in source mtimes).
  RMDir /r "$TEMP\\BabelDesktopSetup"
  SetOutPath "$TEMP\\BabelDesktopSetup"
  SetOverwrite on
  File /oname=Babel-Desktop-payload.zip ${fw(stagedPayload)}
  File /oname=payload.sha256 ${fw(stagedSha)}
  File /oname=install-windows.ps1 ${fw(stagedInstall)}
  File /oname=uninstall-windows.ps1 ${fw(stagedUninstall)}
  File /oname=run-install.cmd ${fw(stagedBootstrap)}
  DetailPrint "Installing \${PRODUCT_NAME} \${PRODUCT_VERSION} for the current Windows user..."
  ; A 32-bit installer process resolves $SYSDIR into SysWOW64, whose 32-bit
  ; Windows PowerShell mishandles some ZIP archives. The bootstrap cmd file
  ; selects the 64-bit Windows PowerShell via the $WINDIR\Sysnative alias
  ; (the WOW64 view of the real System32, which only exists from 32-bit
  ; processes) and captures the transcript for diagnosability.
  ExecWait '"$TEMP\\BabelDesktopSetup\\run-install.cmd"' $R0
  ; If the bootstrap could not launch, ExecWait sets the error flag while $R0
  ; stays 0 - fail loudly instead of reporting a false success.
  IfErrors 0 +3
    DetailPrint "Failed to launch the installer bootstrap."
    SetErrorLevel 98
    Return
  IntCmp $R0 0 setup_ok
    DetailPrint "Installation failed (exit code $R0). See install-log.txt. No changes were kept."
    SetErrorLevel $R0
    Return
  setup_ok:
  DetailPrint "Installation complete. Use the Babel Desktop Start Menu shortcut to launch."
  SetErrorLevel 0
SectionEnd
`.trimStart();
}

// --- Main (only when invoked directly) -----------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {

const payloadZip = resolve(option('payload-zip') || '');
const payloadChecksums = resolve(option('payload-sha256s') || join(payloadZip, '..', 'SHA256SUMS'));
const nsisArchiveArg = option('nsis-archive');
const nsisArchive = nsisArchiveArg ? resolve(nsisArchiveArg) : '';
const makensisArg = option('makensis');
const makensisPath = makensisArg ? resolve(makensisArg) : '';
const output = resolve(option('output') || join(desktop, 'artifacts', 'windows-setup'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This installer builder supports Windows x64 only');
if (!existsSync(payloadZip)) throw new Error('Provide --payload-zip=<portable ZIP from package-windows.mjs>');
if (!existsSync(payloadChecksums)) throw new Error('Payload SHA256SUMS not found next to the ZIP; pass --payload-sha256s=');
// NSIS toolchain comes from exactly one of:
//  - --nsis-archive=<official nsis zip>, SHA256-pinned (hermetic local builds), or
//  - --makensis=<path to Bin/makensis.exe> from an externally installed NSIS
//    (CI/Chocolatey; the recorded provenance is the compiler's own -VERSION).
const useArchive = nsisArchiveArg !== undefined;
if (!useArchive && !makensisPath) {
  throw new Error(`Provide --nsis-archive=<official nsis-${nsisVersion}.zip> (checksum-pinned) or --makensis=<Bin/makensis.exe>`);
}
if (useArchive) {
  if (!existsSync(nsisArchive) || !statSync(nsisArchive).isFile()) {
    throw new Error(`--nsis-archive does not point at a file: ${nsisArchive}`);
  }
  if (sha(readFileSync(nsisArchive)) !== nsisSha) {
    throw new Error(`NSIS archive checksum does not match the pinned nsis-${nsisVersion} value`);
  }
}
if (existsSync(output)) throw new Error('Output already exists; choose a new --output directory to retain prior builds');

const command = (exe, args, cwd = repo) => execFileSync(exe, args, {cwd, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024});
// Prefer the Windows system bsdtar: in Git Bash environments PATH resolves
// 'tar(.exe)' to GNU tar, which misreads drive-letter paths as remote hosts.
const windowsTar = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const tarExe = existsSync(windowsTar) ? windowsTar : 'tar.exe';
const sourceSha = command('git', ['rev-parse', 'HEAD']).trim();
const dirty = command('git', ['status', '--porcelain', '--untracked-files=normal']).trim();
if (dirty) throw new Error('Commit the candidate before packaging so source SHA identifies the complete build');

// --- Payload verification ----------------------------------------------------
// The installer refuses any payload whose bytes do not match the SHA256SUMS
// shipped beside it; the builder enforces the same check so a bad payload
// never reaches a Setup.exe.
const sumsLine = parseSha256Sums(readFileSync(payloadChecksums, 'utf8'), basename(payloadZip));
const expectedPayloadSha = sumsLine;
const actualPayloadSha = sha(readFileSync(payloadZip));
if (actualPayloadSha !== expectedPayloadSha) throw new Error('Payload ZIP does not match its SHA256SUMS entry');

const listing = command(tarExe, ['-tf', payloadZip]);
const bundleDir = listing.split(/\r?\n/).map(l => l.replace(/\/$/, '').trim()).find(l => l && !l.includes('/'));
if (!bundleDir) throw new Error('Portable ZIP must contain exactly one top-level bundle directory');
const buildJsonText = command(tarExe, ['-xOf', payloadZip, `${bundleDir}/BUILD.json`]);
const payloadBuildParsed = JSON.parse(buildJsonText);
const version = validatePayloadBuild(payloadBuildParsed);
const payloadBuildSourceSha = String(payloadBuildParsed.sourceSha || '');
const setupName = `Babel-Desktop-Setup-${version}-win-x64`;

// --- NSIS toolchain ------------------------------------------------------------
let makensis;
let nsisProvenance;
let nsisExtract;
if (useArchive) {
  nsisExtract = join(output, `nsis-${sourceSha.slice(0, 12)}`);
  mkdirSync(nsisExtract, {recursive: true});
  command(tarExe, ['-xf', nsisArchive, '-C', nsisExtract]);
  makensis = join(nsisExtract, `nsis-${nsisVersion}`, 'Bin', 'makensis.exe');
  if (!existsSync(makensis)) throw new Error(`Pinned NSIS archive has unexpected layout (missing nsis-${nsisVersion}/Bin/makensis.exe)`);
  nsisProvenance = {nsis: nsisVersion, nsisArchiveSha256: nsisSha};
} else {
  makensis = makensisPath;
  if (!existsSync(makensis)) throw new Error(`--makensis points at a missing file: ${makensis}`);
  const reported = command(makensis, ['-VERSION']).trim(); // e.g. v3.11
  nsisProvenance = {nsis: reported.replace(/^v/, ''), nsisSource: 'external'};
}

// --- Staging -------------------------------------------------------------------
const stage = join(output, 'setup-stage');
mkdirSync(stage, {recursive: true});
const stagedPayload = join(stage, 'Babel-Desktop-payload.zip');
cpSync(payloadZip, stagedPayload);
writeFileSync(join(stage, 'payload.sha256'), actualPayloadSha + '\n', 'utf8');
cpSync(join(desktop, 'scripts', 'install-windows.ps1'), join(stage, 'install-windows.ps1'));
cpSync(join(desktop, 'scripts', 'uninstall-windows.ps1'), join(stage, 'uninstall-windows.ps1'));

// Bootstrap cmd file: baked-in absolute paths mean the NSIS layer runs a
// single unambiguous ExecWait with no nested quoting. 64-bit Windows
// PowerShell is selected via the Sysnative alias (the WOW64 view of the real
// System32, visible only from 32-bit processes) because 32-bit Windows
// PowerShell mishandles some bsdtar-produced ZIP archives.
const runInstallCmd = [
  '@echo off',
  'set "POWERSHELL=%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'if not exist "%POWERSHELL%" set "POWERSHELL=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1" > "%~dp0install-log.txt" 2>&1',
  'exit /b %errorlevel%',
  '',
].join('\r\n');
writeFileSync(join(stage, 'run-install.cmd'), runInstallCmd, 'utf8');

// Privacy scan on everything that goes inside the installer (same policy as
// package-windows.mjs: no personal build-machine paths, no secret-shaped files).
const home = resolve(process.env.USERPROFILE || process.env.HOME || '/');
for (const name of ['payload.sha256', 'install-windows.ps1', 'uninstall-windows.ps1', 'run-install.cmd']) {
  const bytes = readFileSync(join(stage, name));
  if (bytes.includes(home)) throw new Error(`${name} contains the build machine home path`);
  if (/\.(env|pem|key|log)$/i.test(name)) throw new Error(`${name} must not be packaged`);
}

// --- NSIS script ----------------------------------------------------------------
// The NSIS layer is deliberately thin: extract the payload plus bootstrap to a
// temp dir and run the bootstrap (which runs install-windows.ps1 and
// propagates its exit code). /S gives silent installs; all install logic and
// rollback live in the PowerShell scripts and are lifecycle-qualified there.
const nsi = renderNsis({
  version,
  stagedPayload,
  stagedSha: join(stage, 'payload.sha256'),
  stagedInstall: join(stage, 'install-windows.ps1'),
  stagedUninstall: join(stage, 'uninstall-windows.ps1'),
  stagedBootstrap: join(stage, 'run-install.cmd'),
  outFile: join(output, setupName + '.exe'),
});
writeFileSync(join(stage, 'setup.nsi'), nsi.endsWith('\n') ? nsi : nsi + '\n', 'utf8');

// --- Build ------------------------------------------------------------------------
const setupExe = join(output, setupName + '.exe');
const installerSha = compileNsis(
  {makensis, script: join(stage, 'setup.nsi'), useArchive, nsisExtract},
  command,
  () => {
    if (!existsSync(setupExe)) throw new Error('makensis reported success but the Setup executable is missing');
    const artifactSha = sha(readFileSync(setupExe));
    writeFileSync(setupExe + '.sha256', artifactSha + '\n', 'utf8');
    const installerMetadata = {
      installerSourceSha: sourceSha,
      payloadSourceSha: payloadBuildSourceSha,
      payloadSha256: actualPayloadSha,
      payloadVersion: version,
      platform: 'win32-x64',
      ...nsisProvenance,
      signed: false,
    };
    writeFileSync(join(output, setupName + '.build.json'), JSON.stringify(installerMetadata, null, 2) + '\n', 'utf8');
    return artifactSha;
  },
);

console.log(JSON.stringify({setup: setupName + '.exe', sha256: installerSha, payloadVersion: version, signed: false}, null, 2));
}
