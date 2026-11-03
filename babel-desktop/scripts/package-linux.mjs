// License: Apache-2.0
// Linux x64 AppImage builder. Mirrors package-windows.mjs: pinned official
// Node and Electron archives, the same CLI pack, and a file inventory.
// It does not build a .deb, sign the AppImage, or embed an update channel.
import {chmodSync, cpSync, existsSync, lutimesSync, mkdirSync, readFileSync, readlinkSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {assertAppImportsResolve} from './lib/verify-app-imports.mjs';
import {assertLinuxPackagingTools} from './lib/linux-package-preflight.mjs';
import {installCanvasPlatformBinding} from '../../babel-cli/scripts/research-v2-canvas-platform-binding.mjs';
import {isAllowlistedCanvasVendorNativeArtifact} from '../../babel-cli/scripts/research-v2-canvas-vendor-allowlist.mjs';
import {containsPersonalBuildPath} from './lib/linux-package-paths.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const desktopPackage = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const version = desktopPackage.version;
const nodeVersion = '24.13.1';
const nodeArchiveSha = '30215f90ea3cd04dfbc06e762c021393fa173a1d392974298bbc871a8e461089';
const electronVersion = '44.5.1';
const electronArchiveSha = '5bcd217611d6843ececd6c9e9c1fcd1da3ab066c43d8b1a9e4b44689a1fba6f5';
const appimageToolVersion = '1.9.1';
const appimageToolSha = 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0';
const appimageRuntimeTag = '20251108';
const appimageRuntimeSha = '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d';
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const archive = resolve(option('node-archive') || '');
const electronArchive = resolve(option('electron-archive') || '');
const appimageTool = resolve(option('appimage-tool') || '');
const appimageRuntime = resolve(option('runtime-archive') || '');
const output = resolve(option('output') || join(desktop, 'artifacts', 'linux'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  assertLinuxPackagingTools();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
// Clamp archive metadata so two builds from the same commit and pinned inputs match.
process.env.SOURCE_DATE_EPOCH = '0';
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This Linux builder supports linux x64 only');
if (process.versions.node !== nodeVersion) throw new Error(`Build with Node ${nodeVersion} for the pinned runtime`);
if (!existsSync(archive) || sha(readFileSync(archive)) !== nodeArchiveSha) throw new Error('Provide --node-archive=<official node-v24.13.1-linux-x64.tar.xz>; checksum must match the pinned value');
if (desktopPackage.devDependencies.electron !== electronVersion) throw new Error('Update the pinned Electron archive and checksum when changing the Electron dependency');
if (!existsSync(electronArchive) || !statSync(electronArchive).isFile() || sha(readFileSync(electronArchive)) !== electronArchiveSha) throw new Error('Provide --electron-archive=<official electron-v44.5.1-linux-x64.zip>; checksum must match the pinned value');
if (!existsSync(appimageTool) || !statSync(appimageTool).isFile() || sha(readFileSync(appimageTool)) !== appimageToolSha) throw new Error(`Provide --appimage-tool=<appimagetool ${appimageToolVersion} x86_64 AppImage>; checksum must match the pinned value`);
if (!existsSync(appimageRuntime) || !statSync(appimageRuntime).isFile() || sha(readFileSync(appimageRuntime)) !== appimageRuntimeSha) throw new Error(`Provide --runtime-archive=<type2-runtime ${appimageRuntimeTag} runtime-x86_64>; checksum must match the pinned value`);
const npmCli = option('npm-cli') || process.env.npm_execpath;
if (!npmCli || !existsSync(npmCli)) throw new Error('Provide --npm-cli=<npm/bin/npm-cli.js> or invoke through npm');
const command = (exe, args, cwd = repo, {capture = true, timeout = 300000, env} = {}) => execFileSync(exe, args, {
  cwd, env, encoding: capture ? 'utf8' : undefined, stdio: capture ? undefined : 'inherit', timeout, maxBuffer: 16 * 1024 * 1024,
});
const bundleName = `Babel-Desktop-${version}-linux-x64`;
const bundle = join(output, bundleName);
const appImage = join(output, `${bundleName}.AppImage`);
if (existsSync(bundle) || existsSync(appImage)) throw new Error('Output already exists; choose a new --output directory to retain prior builds');
mkdirSync(output, {recursive: true});
const sourceSha = command('git', ['rev-parse', 'HEAD']).trim();
const dirty = command('git', ['status', '--porcelain', '--untracked-files=normal']).trim();
if (dirty) throw new Error('Commit the candidate before packaging so source SHA identifies the complete build');
command(process.execPath, [join(desktop, 'scripts', 'build.mjs')], repo, {capture: false, timeout: 120000});
const cliSource = join(repo, 'babel-cli');
command(process.execPath, [npmCli, 'run', 'build'], cliSource, {capture: false, timeout: 600000});
command(process.execPath, [join(cliSource, 'scripts', 'stage_runtime_assets.mjs')], repo, {capture: false, timeout: 300000});
const pack = JSON.parse(command(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', output], cliSource))[0];
mkdirSync(bundle);
command('unzip', ['-q', electronArchive, '-d', bundle], repo, {capture: false, timeout: 300000});
if (readFileSync(join(bundle, 'version'), 'utf8').trim() !== electronVersion) throw new Error('Verified Electron archive has an unexpected runtime version');
if (!existsSync(join(bundle, 'electron'))) throw new Error('Electron archive did not contain the electron binary');
renameSync(join(bundle, 'electron'), join(bundle, 'babel-desktop'));
chmodSync(join(bundle, 'babel-desktop'), 0o755);
const app = join(bundle, 'resources', 'app');
mkdirSync(app, {recursive: true});
for (const name of ['native', 'src', 'dist', 'assets', 'LICENSE', 'NOTICE']) cpSync(join(desktop, name), join(app, name), {recursive: true});
// Keep this Electron app id. Settings are babel-desktop via setPath('userData'), not this name.
writeFileSync(join(app, 'package.json'), JSON.stringify({name: 'babel-north-star-desktop', version, main: 'native/main.mjs', type: 'module', private: true}, null, 2));
assertAppImportsResolve(app);
const runtime = join(bundle, 'resources', 'babel-runtime');
const cli = join(runtime, 'cli');
mkdirSync(cli, {recursive: true});
command('tar', ['-xzf', join(output, pack.filename), '-C', cli, '--strip-components=1'], repo, {capture: false, timeout: 300000});
cpSync(join(cliSource, 'package-lock.json'), join(cli, 'package-lock.json'));
command(process.execPath, [npmCli, 'ci', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], cli, {capture: false, timeout: 600000});
installCanvasPlatformBinding({cwd: cli, npmCli, nodeExec: process.execPath});
const nodeExtract = join(output, `node-${sourceSha.slice(0, 12)}`);
mkdirSync(nodeExtract);
command('tar', ['-xJf', archive, '-C', nodeExtract], repo, {capture: false, timeout: 300000});
const nodeSource = join(nodeExtract, `node-v${nodeVersion}-linux-x64`);
const nodeBin = join(runtime, 'node');
mkdirSync(nodeBin);
cpSync(join(nodeSource, 'bin', 'node'), join(nodeBin, 'node'));
chmodSync(join(nodeBin, 'node'), 0o755);
cpSync(join(nodeSource, 'LICENSE'), join(nodeBin, 'LICENSE'));
const npmSource = join(nodeSource, 'lib', 'node_modules', 'npm');
if (!existsSync(join(npmSource, 'bin', 'npm-cli.js'))) throw new Error('Pinned Node archive is missing npm-cli.js');
cpSync(npmSource, join(runtime, 'npm'), {recursive: true, dereference: true});
cpSync(join(desktop, 'scripts', 'cli-launch.mjs'), join(runtime, 'cli-launch.mjs'));
const cliLauncher = '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$ROOT/resources/babel-runtime/node/node" "$ROOT/resources/babel-runtime/cli-launch.mjs" "$@"\n';
writeFileSync(join(bundle, 'babel-harness'), cliLauncher, {mode: 0o755});
writeFileSync(join(bundle, 'babel-cli'), cliLauncher, {mode: 0o755});
const appRun = '#!/bin/sh\nset -eu\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexport APPDIR="$HERE"\nexec "$HERE/babel-desktop" "$@"\n';
writeFileSync(join(bundle, 'AppRun'), appRun, {mode: 0o755});
const desktopEntry = [
  '[Desktop Entry]',
  'Name=Babel Desktop',
  'Comment=Desktop workspace for the Babel coding-agent harness',
  'Exec=babel-desktop %U',
  'Icon=babel-desktop',
  'Type=Application',
  'Categories=Development;',
  'StartupWMClass=Babel Desktop',
  '',
].join('\n');
writeFileSync(join(bundle, 'babel-desktop.desktop'), desktopEntry, {mode: 0o644});
cpSync(join(desktop, 'assets', 'babel-mark.png'), join(bundle, 'babel-desktop.png'));
cpSync(join(desktop, 'docs', 'INSTALL-LINUX.md'), join(bundle, 'INSTALL.md'));
const metadata = {
  version, sourceSha, platform: 'linux-x64', electron: electronVersion, electronArchiveSha256: electronArchiveSha,
  node: nodeVersion, nodeArchiveSha256: nodeArchiveSha, cliVersion: pack.version,
  cliArchiveSha256: sha(readFileSync(join(output, pack.filename))),
  appimageTool: appimageToolVersion, appimageToolSha256: appimageToolSha,
  appimageRuntime: appimageRuntimeTag, appimageRuntimeSha256: appimageRuntimeSha, signed: false,
  updateChannel: null,
};
writeFileSync(join(bundle, 'BUILD.json'), JSON.stringify(metadata, null, 2) + '\n');
writeFileSync(join(output, `${bundleName}.build.json`), JSON.stringify(metadata, null, 2) + '\n');
chmodSync(appimageTool, 0o755);
clampTimestamps(bundle);
try {
  command(appimageTool, ['--no-appstream', '--runtime-file', appimageRuntime,
    '--mksquashfs-opt', '-reproducible',
    '--mksquashfs-opt', '-processors', '--mksquashfs-opt', '1',
    '--mksquashfs-opt', '-no-xattrs',
    bundle, appImage], output, {
    capture: false,
    timeout: 600000,
    env: {...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1', SOURCE_DATE_EPOCH: '0'},
  });
} catch (error) {
  const detail = String(error.stderr || error.stdout || error.message || '').split('\n').filter(Boolean).slice(-12).join('\n');
  console.error(`AppImage packaging failed.\n${detail}`);
  process.exit(1);
}
function clampTimestamps(dir) {
  const stamp = new Date(0);
  for (const item of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink()) {
      try { lutimesSync(path, stamp, stamp); } catch { /* Some filesystems reject link times. */ }
      continue;
    }
    if (item.isDirectory()) clampTimestamps(path);
    try { utimesSync(path, stamp, stamp); } catch { /* A refused timestamp must not hide a later checksum. */ }
  }
  try { utimesSync(dir, stamp, stamp); } catch { /* Root time is also clamped by mksquashfs -all-time. */ }
}
if (!existsSync(appImage)) throw new Error('appimagetool reported success but the AppImage is missing');
chmodSync(appImage, 0o755);
const files = [];
function inventory(dir, prefix = '') {
  for (const item of readdirSync(dir, {withFileTypes: true})) {
    const rel = prefix + item.name, path = join(dir, item.name);
    if (item.isSymbolicLink()) {
      const link = readlinkSync(path);
      const resolved = resolve(dir, link);
      const relToBundle = relative(bundle, resolved);
      if (isAbsolute(link) || relToBundle.startsWith('..') || isAbsolute(relToBundle)) throw new Error(`Link escapes package: ${rel}`);
      files.push({path: rel, link});
      continue;
    }
    if (item.isDirectory()) inventory(path, rel + '/');
    else {
      if (/(?:^|\/)(?:\.env(?:\..*)?|\.git|auth\.json|ui-connection\.json|transcript\.jsonl)$|\.(?:log|pem|key)$/i.test(rel)) throw new Error(`Forbidden package file: ${rel}`);
      const bytes = readFileSync(path);
      if (containsPersonalBuildPath(rel, bytes, {home: homedir(), repo, output, isCanvasPrebuild: isAllowlistedCanvasVendorNativeArtifact(rel, bytes)})) throw new Error(`Personal build path in package: ${rel}`);
      files.push({path: rel, bytes: statSync(path).size, sha256: sha(bytes)});
    }
  }
}
inventory(bundle);
writeFileSync(join(output, 'manifest.json'), JSON.stringify(files, null, 2) + '\n');
writeFileSync(join(output, 'SHA256SUMS'), `${sha(readFileSync(appImage))}  ${basename(appImage)}\n`);
console.log(JSON.stringify({...metadata, artifact: appImage, bytes: statSync(appImage).size, files: files.length}, null, 2));
