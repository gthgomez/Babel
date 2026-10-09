// License: Apache-2.0 - see LICENSE
import {cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {execFile} from 'node:child_process';
import {EXPECTED_ORIGIN, EXPECTED_HOST} from './updater.mjs';
import {cliPackageRootForInstall, promoteStagedInstall, readInstallManifest, readActiveEngine, sha256File, stageDir, bundledInstallId} from './engine-manager.mjs';

const SHA = /^[a-f0-9]{40}$/;
const USER_AGENT = 'Babel-Desktop-Engine-Updater';

function capture(exe, args, options, limit = 600) {
  return new Promise(resolvePromise => {
    execFile(exe, args, {...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']}, (error, stdout, stderr) => {
      if (error) resolvePromise({ok: false, stdout: '', detail: String(stderr ?? error?.message ?? '').slice(0, limit)});
      else resolvePromise({ok: true, stdout: String(stdout)});
    });
  });
}

function tarExe() {
  return process.platform === 'win32' ? 'tar.exe' : 'tar';
}

async function extractArchive(archive, dest, extraArgs = []) {
  mkdirSync(dest, {recursive: true});
  return capture(tarExe(), ['-xf', archive, '-C', dest, ...extraArgs], {timeout: 900000});
}

async function githubJson(path, {timeoutMs = 12000} = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json'},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  return response.json();
}

async function downloadFile(url, dest, {timeoutMs = 600000, maxBytes = 256 * 1024 * 1024} = {}) {
  if (!url.startsWith(`https://${EXPECTED_HOST}/`) &&
      !url.startsWith('https://codeload.github.com/') &&
      !url.startsWith(`https://raw.githubusercontent.com/${EXPECTED_ORIGIN}/`)) {
    throw new Error('Refusing untrusted download host');
  }
  const response = await fetch(url, {headers: {'User-Agent': USER_AGENT}, signal: AbortSignal.timeout(timeoutMs)});
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  mkdirSync(dirname(dest), {recursive: true});
  const file = createWriteStream(dest, {flags: 'wx'});
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) {
      file.close();
      rmSync(dest, {force: true});
      throw new Error('Artifact exceeds the size limit');
    }
    file.write(chunk);
  }
  await new Promise((resolve, reject) => file.end(err => err ? reject(err) : resolve()));
}

function parsePackageVersion(cliRoot) {
  try { return JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

export function resolveBundledNpmCli(resourcesPath) {
  const candidate = join(resourcesPath, 'babel-runtime', 'npm', 'bin', 'npm-cli.js');
  return existsSync(candidate) ? candidate : null;
}

export async function ensureLockfileForCli({cliRoot, resourcesPath, sourceSha}) {
  const targetLock = join(cliRoot, 'package-lock.json');
  if (existsSync(targetLock)) return true;
  if (resourcesPath) {
    const candidate = join(resourcesPath, 'babel-runtime', 'cli', 'package-lock.json');
    if (existsSync(candidate)) {
      cpSync(candidate, targetLock);
      return true;
    }
  }
  if (sourceSha && SHA.test(sourceSha)) {
    const rawUrl = `https://raw.githubusercontent.com/${EXPECTED_ORIGIN}/${sourceSha}/babel-cli/package-lock.json`;
    try {
      await downloadFile(rawUrl, targetLock, {maxBytes: 10 * 1024 * 1024});
      if (existsSync(targetLock)) return true;
    } catch {
      try {
        const fileData = await githubJson(`/repos/${EXPECTED_ORIGIN}/contents/babel-cli/package-lock.json?ref=${sourceSha}`);
        if (fileData?.content && fileData?.encoding === 'base64') {
          const content = Buffer.from(fileData.content, 'base64').toString('utf8');
          writeFileSync(targetLock, content, 'utf8');
          return true;
        }
      } catch {
        // failed
      }
    }
  }
  return false;
}

async function runNpmCi({nodeExe, npmCli, cwd, omitDev = true, timeoutMs = 900000}) {
  const args = [npmCli, 'ci'];
  if (omitDev) args.push('--omit=dev');
  args.push('--ignore-scripts', '--no-audit', '--no-fund');
  return capture(nodeExe, args, {cwd, timeout: timeoutMs, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
}

async function validateCliBuild({nodeExe, cliRoot, env = {}}) {
  const entry = join(cliRoot, 'dist', 'index.js');
  if (!existsSync(entry)) return {ok: false, reason: 'missing_entry'};
  const expected = parsePackageVersion(cliRoot);
  const version = await capture(nodeExe, [entry, '--version'], {cwd: cliRoot, timeout: 60000, env: {...process.env, ...env, ELECTRON_RUN_AS_NODE: '1'}});
  if (!version.ok) return {ok: false, reason: 'version_check_failed', detail: version.detail};
  const reported = version.stdout.trim();
  if (!expected || reported !== expected) return {ok: false, reason: 'version_mismatch', detail: `expected ${expected ?? 'unknown'}, got ${reported}`};
  return {ok: true, version: reported};
}

function findBabelCliRoot(searchRoot) {
  for (const name of readdirSync(searchRoot)) {
    const candidate = join(searchRoot, name, 'babel-cli');
    if (existsSync(join(candidate, 'package.json'))) return join(searchRoot, name);
  }
  return null;
}

export function resolveCurrentSourceSha(userData, bundledSourceSha) {
  const active = readActiveEngine(userData);
  if (active && active.id !== bundledInstallId()) {
    const manifest = readInstallManifest(userData, active.id);
    if (SHA.test(String(manifest?.sourceSha))) return String(manifest.sourceSha);
  }
  return SHA.test(String(bundledSourceSha)) ? String(bundledSourceSha) : null;
}

export async function checkPackagedCliUpdate({userData, channel, bundledSourceSha}) {
  const currentSourceSha = resolveCurrentSourceSha(userData, bundledSourceSha);
  if (channel === 'preview') return resolvePreviewCandidate(currentSourceSha);
  return resolveStableReleaseCandidate(currentSourceSha);
}

export async function resolveStableReleaseCandidate(currentSourceSha) {
  const release = await githubJson(`/repos/${EXPECTED_ORIGIN}/releases/latest`);
  const tag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  const target = typeof release?.target_commitish === 'string' ? release.target_commitish : '';
  let sourceSha = SHA.test(target) ? target : null;
  if (!sourceSha && tag) {
    try {
      const commit = await githubJson(`/repos/${EXPECTED_ORIGIN}/commits/${encodeURIComponent(tag)}`);
      if (typeof commit?.sha === 'string' && SHA.test(commit.sha)) {
        sourceSha = commit.sha;
      }
    } catch {
      sourceSha = null;
    }
  }
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const tgz = assets.find(a => typeof a?.name === 'string' && /^babel-(cli|harness)-.+\.tgz$/i.test(a.name) && a.browser_download_url?.startsWith(`https://${EXPECTED_HOST}/`));
  if (!tag || !tgz || !sourceSha) {
    return {state: 'unsupported', channel: 'stable', detail: 'No qualified stable CLI archive was found on the latest release.'};
  }
  const state = sourceSha === currentSourceSha ? 'current' : 'available';
  return {
    state,
    channel: 'stable',
    currentSha: currentSourceSha,
    availableSha: sourceSha,
    detail: `Stable release ${tag} · ${sourceSha.slice(0, 12)}`,
    candidate: {tag, sourceSha, tgzUrl: tgz.browser_download_url, tgzName: tgz.name},
  };
}

export async function resolvePreviewCandidate(currentSourceSha) {
  const commit = await githubJson(`/repos/${EXPECTED_ORIGIN}/commits/main`);
  const sha = typeof commit?.sha === 'string' ? commit.sha : '';
  if (!SHA.test(sha)) return {state: 'error', channel: 'preview', detail: 'Could not resolve the development branch head.'};
  const checkRunsData = await githubJson(`/repos/${EXPECTED_ORIGIN}/commits/${sha}/check-runs`);
  const runs = Array.isArray(checkRunsData?.check_runs) ? checkRunsData.check_runs : [];
  if (runs.length === 0) {
    return {state: 'unsupported', channel: 'preview', detail: `Main is at ${sha.slice(0, 12)} but no CI check-runs were found.`};
  }
  const inProgress = runs.find(r => r.status !== 'completed');
  if (inProgress) {
    return {state: 'unsupported', channel: 'preview', detail: `Main is at ${sha.slice(0, 12)} but CI check "${inProgress.name ?? 'check'}" is in progress.`};
  }
  const failed = runs.find(r => r.conclusion !== 'success' && r.conclusion !== 'skipped');
  if (failed) {
    return {state: 'unsupported', channel: 'preview', detail: `Main is at ${sha.slice(0, 12)} but CI check "${failed.name ?? 'check'}" concluded with ${failed.conclusion ?? 'failure'}.`};
  }
  if (sha === currentSourceSha) {
    return {state: 'current', channel: 'preview', currentSha: sha, availableSha: sha, detail: 'Installed CLI already matches qualified main.'};
  }
  return {
    state: 'available',
    channel: 'preview',
    currentSha: currentSourceSha,
    availableSha: sha,
    detail: `Development preview ${sha.slice(0, 12)} · unsigned source build`,
    candidate: {sourceSha: sha, tarballUrl: `https://codeload.github.com/${EXPECTED_ORIGIN}/tar.gz/${sha}`},
  };
}

export async function installStableReleaseArchive({userData, nodeExe, npmCli, tgzUrl, sourceSha, resourcesPath, events = () => {}}) {
  const emit = (phase, status, detail = '') => events({phase, status, detail: String(detail).slice(0, 600)});
  const fail = (phase, reason, detail = '') => { emit(phase, 'failed', detail || reason); return {ok: false, phase, reason, detail}; };
  if (!SHA.test(String(sourceSha))) return fail('plan', 'invalid_source_sha');
  if (!npmCli) return fail('precheck', 'npm_unavailable');
  const staging = stageDir(userData, sourceSha);
  rmSync(staging, {recursive: true, force: true});
  mkdirSync(staging, {recursive: true});
  const archive = join(staging, 'package.tgz');
  emit('download', 'running');
  try { await downloadFile(tgzUrl, archive); } catch (error) { return fail('download', 'download_failed', error.message); }
  emit('download', 'complete');
  const digest = sha256File(archive);
  const cliRoot = cliPackageRootForInstall(staging);
  mkdirSync(cliRoot, {recursive: true});
  emit('extract', 'running');
  const extracted = await extractArchive(archive, cliRoot, ['--strip-components=1']);
  if (!extracted.ok) return fail('extract', 'extract_failed', extracted.detail);
  const hasLock = await ensureLockfileForCli({cliRoot, resourcesPath, sourceSha});
  if (!hasLock && !existsSync(join(cliRoot, 'package-lock.json'))) {
    return fail('install', 'missing_lockfile', 'The stable package archive lacks package-lock.json and it could not be resolved.');
  }
  emit('install', 'running');
  const installed = await runNpmCi({nodeExe, npmCli, cwd: cliRoot, omitDev: true});
  if (!installed.ok) return fail('install', 'dependency_install_failed', installed.detail);
  emit('validate', 'running');
  const validated = await validateCliBuild({nodeExe, cliRoot});
  if (!validated.ok) { rmSync(staging, {recursive: true, force: true}); return fail('validate', validated.reason, validated.detail); }
  try {
    const promoted = promoteStagedInstall({userData, sourceSha, channel: 'stable', cliVersion: validated.version, artifactSha256: digest, activate: true});
    emit('activate', 'complete', promoted.id);
    return {ok: true, engineId: promoted.id, sourceSha, version: validated.version};
  } catch (error) {
    return fail('activate', 'activation_failed', error.message);
  }
}

export async function installPreviewSourceBuild({userData, nodeExe, npmCli, sourceSha, tarballUrl, events = () => {}}) {
  const emit = (phase, status, detail = '') => events({phase, status, detail: String(detail).slice(0, 600)});
  const fail = (phase, reason, detail = '') => { emit(phase, 'failed', detail || reason); return {ok: false, phase, reason, detail}; };
  if (!SHA.test(sourceSha) || !npmCli) return fail('precheck', 'invalid_request');
  const staging = stageDir(userData, sourceSha);
  rmSync(staging, {recursive: true, force: true});
  mkdirSync(staging, {recursive: true});
  const archive = join(staging, 'source.tar.gz');
  emit('download', 'running');
  try { await downloadFile(tarballUrl, archive, {maxBytes: 96 * 1024 * 1024}); } catch (error) { return fail('download', 'download_failed', error.message); }
  emit('download', 'complete');
  const extractRoot = join(staging, 'src');
  const extracted = await extractArchive(archive, extractRoot);
  if (!extracted.ok) return fail('extract', 'extract_failed', extracted.detail);
  const repoDir = findBabelCliRoot(extractRoot);
  const cliDir = repoDir ? join(repoDir, 'babel-cli') : null;
  if (!cliDir || !existsSync(join(cliDir, 'package.json'))) return fail('extract', 'layout_failed');
  emit('install', 'running');
  const installed = await runNpmCi({nodeExe, npmCli, cwd: cliDir, omitDev: false});
  if (!installed.ok) return fail('install', 'dependency_install_failed', installed.detail);
  emit('build', 'running');
  const built = await capture(nodeExe, [npmCli, 'run', 'build'], {cwd: cliDir, timeout: 900000, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
  if (!built.ok) return fail('build', 'build_failed', built.detail);
  const builtCli = cliPackageRootForInstall(staging);
  rmSync(builtCli, {recursive: true, force: true});
  try { cpSync(cliDir, builtCli, {recursive: true}); } catch (error) { return fail('stage', 'stage_failed', error.message); }
  emit('validate', 'running');
  const validated = await validateCliBuild({nodeExe, cliRoot: builtCli});
  if (!validated.ok) { rmSync(staging, {recursive: true, force: true}); return fail('validate', validated.reason, validated.detail); }
  try {
    const promoted = promoteStagedInstall({userData, sourceSha, channel: 'preview', cliVersion: validated.version, artifactSha256: sha256File(archive), activate: true});
    emit('activate', 'complete', promoted.id);
    return {ok: true, engineId: promoted.id, sourceSha, version: validated.version};
  } catch (error) {
    return fail('activate', 'activation_failed', error.message);
  }
}
