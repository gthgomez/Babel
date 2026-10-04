// License: Apache-2.0
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {basename, dirname, join, resolve, win32} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktop, '..');
const installScript = join(desktop, 'scripts', 'install-windows.ps1');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function gitOutput(args) {
  return execFileSync('git', ['-C', repoRoot, ...args], {encoding:'utf8', windowsHide:true}).trim();
}

function getCommittedInstallerSourceSha() {
  const gitRoot = resolve(gitOutput(['rev-parse', '--show-toplevel']));
  if (gitRoot !== repoRoot) throw new Error('Installer source is not under the expected Babel repository root');
  if (gitOutput(['status', '--porcelain=v1', '--untracked-files=all'])) {
    throw new Error('Commit or remove all worktree changes before building Setup.exe so its installer source can be recorded');
  }
  const sourceSha = gitOutput(['rev-parse', '--verify', 'HEAD']);
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error('Could not bind the installer to a committed Git source SHA');
  return sourceSha.toLowerCase();
}

export function parseSha256Manifest(text, expectedFilename) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error('expected exactly one checksum for the portable ZIP');
  const match = lines[0].match(/^([a-f0-9]{64})  (.+)$/i);
  if (!match) throw new Error('invalid SHA256 manifest line');
  if (match[2] !== expectedFilename) throw new Error('expected exactly one checksum for the portable ZIP');
  return match[1].toLowerCase();
}

export function renderIExpressSed({targetName, sourceDirectory, friendlyName}) {
  for (const [label, value] of Object.entries({targetName, sourceDirectory, friendlyName})) {
    if (typeof value !== 'string' || !value.trim() || /[\r\n%]/.test(value)) throw new Error(`${label} contains unsupported characters`);
  }
  if (!win32.isAbsolute(targetName) || !targetName.toLowerCase().endsWith('.exe')) throw new Error('targetName must be an absolute .exe path');
  if (!win32.isAbsolute(sourceDirectory)) throw new Error('sourceDirectory must be absolute');

  const installCommand = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1';
  return [
    '[Version]',
    'Class=IEXPRESS',
    'SEDVersion=3',
    '[Options]',
    'PackagePurpose=InstallApp',
    'ExtractOnly=0',
    'CheckAdminRights=0',
    'ShowInstallProgramWindow=1',
    'HideExtractAnimation=0',
    'UseLongFileName=1',
    'InsideCompressed=1',
    'CAB_FixedSize=0',
    'CAB_ResvCodeSigning=0',
    'RebootMode=N',
    `TargetName=${targetName}`,
    `FriendlyName=${friendlyName}`,
    `AppLaunched=${installCommand}`,
    `UserQuietInstCmd=${installCommand}`,
    'PostInstallCmd=<None>',
    'SourceFiles=SourceFiles',
    '[Strings]',
    'FILE0="Babel-Desktop-payload.zip"',
    'FILE1="payload.sha256"',
    'FILE2="install.ps1"',
    'FILE3="uninstall-windows.ps1"',
    '[SourceFiles]',
    `SourceFiles0=${sourceDirectory}`,
    '[SourceFiles0]',
    '%FILE0%=',
    '%FILE1%=',
    '%FILE2%=',
    '%FILE3%=',
    '',
  ].join('\r\n');
}

export function validatePayloadBuildMetadata(metadata) {
  if (!metadata || metadata.platform !== 'win32-x64' || metadata.signed !== false ||
      typeof metadata.sourceSha !== 'string' || !/^[0-9a-f]{40}$/i.test(metadata.sourceSha) ||
      typeof metadata.version !== 'string' || !/^\d+\.\d+\.\d+-preview\.\d{8}$/.test(metadata.version)) {
    throw new Error('portable ZIP metadata is not a supported, unsigned, source-bound Windows x64 build');
  }
  return metadata;
}

function readPayloadBuild(zipPath) {
  const entries = execFileSync('tar.exe', ['-tf', zipPath], {encoding:'utf8', windowsHide:true, timeout:300000, maxBuffer:64 * 1024 * 1024})
    .split(/\r?\n/).filter(Boolean);
  const buildFiles = entries.filter(entry => /\/BUILD\.json$/i.test(entry));
  if (buildFiles.length !== 1) throw new Error('portable ZIP must contain exactly one BUILD.json');
  const metadata = JSON.parse(execFileSync('tar.exe', ['-xOf', zipPath, buildFiles[0]], {encoding:'utf8', windowsHide:true, timeout:300000}));
  return validatePayloadBuildMetadata(metadata);
}

function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node package-windows-setup.mjs --zip=<portable-zip> --output=<setup.exe> [--checksums=<SHA256SUMS>]');
    return;
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Setup.exe packaging supports Windows x64 only');
  const zipPath = resolve(option('zip') || '');
  const outputPath = resolve(option('output') || '');
  const checksumPath = resolve(option('checksums') || join(dirname(zipPath), 'SHA256SUMS'));
  if (!existsSync(zipPath) || !statSync(zipPath).isFile()) throw new Error('Provide --zip=<existing portable ZIP>');
  if (!existsSync(checksumPath) || !statSync(checksumPath).isFile()) throw new Error('Provide the matching --checksums=<SHA256SUMS> file');
  if (!outputPath.toLowerCase().endsWith('.exe')) throw new Error('--output must name a .exe file');
  const checksumOutputPath = `${outputPath}.sha256`;
  const buildMetadataPath = `${outputPath}.build.json`;
  if (existsSync(outputPath) || existsSync(checksumOutputPath) || existsSync(buildMetadataPath)) {
    throw new Error('Output already exists; choose a new --output path to preserve prior artifacts');
  }

  const installerSourceSha = getCommittedInstallerSourceSha();
  const expected = parseSha256Manifest(readFileSync(checksumPath, 'utf8'), basename(zipPath));
  const actual = sha256(readFileSync(zipPath));
  if (actual !== expected) throw new Error('portable ZIP does not match its SHA256SUMS entry');
  const payload = readPayloadBuild(zipPath);

  mkdirSync(dirname(outputPath), {recursive:true});
  const staging = mkdtempSync(join(dirname(outputPath), '.babel-desktop-setup-'));
  try {
    copyFileSync(zipPath, join(staging, 'Babel-Desktop-payload.zip'));
    writeFileSync(join(staging, 'payload.sha256'), `${actual}\n`, 'utf8');
    copyFileSync(installScript, join(staging, 'install.ps1'));
    copyFileSync(join(desktop, 'scripts', 'uninstall-windows.ps1'), join(staging, 'uninstall-windows.ps1'));
    const sedPath = join(staging, 'installer.sed');
    writeFileSync(sedPath, renderIExpressSed({
      targetName: outputPath,
      sourceDirectory: staging,
      friendlyName: `Babel Desktop ${payload.version} Setup`,
    }), 'utf8');
    const iexpress = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'iexpress.exe');
    if (!existsSync(iexpress)) throw new Error('Windows IExpress is unavailable');
    execFileSync(iexpress, ['/N', '/Q', sedPath], {
      cwd:staging,
      env:{...process.env, TEMP:staging, TMP:staging},
      windowsHide:true,
      timeout:1200000,
    });
    if (!existsSync(outputPath) || statSync(outputPath).size === 0) throw new Error('IExpress did not create Setup.exe');
    const setupHash = sha256(readFileSync(outputPath));
    const buildMetadata = {
      setup:outputPath,
      setupSizeBytes:statSync(outputPath).size,
      sha256:setupHash,
      installerSourceSha,
      payloadSourceSha:payload.sourceSha,
      payloadVersion:payload.version,
      signed:false,
      installScope:'current-user',
    };
    writeFileSync(checksumOutputPath, `${setupHash}  ${basename(outputPath)}\n`, 'utf8');
    writeFileSync(buildMetadataPath, `${JSON.stringify(buildMetadata, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(buildMetadata, null, 2));
  } finally {
    rmSync(staging, {recursive:true, force:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
