// License: Apache-2.0 - see LICENSE
// Installed Desktop engine profiles: bundled fallback plus versioned installs under
// the user profile. Activation is explicit; failed installs never replace the active build.
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, cpSync, lstatSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

const SHA = /^[a-f0-9]{40}$/;
const BUILD_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function engineRoot(userData) {
  return join(userData, 'engine');
}

export function installsDir(userData) {
  return join(engineRoot(userData), 'installs');
}

export function activeEnginePath(userData) {
  return join(engineRoot(userData), 'active-engine.json');
}

export function bundledInstallId() {
  return 'bundled';
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), {recursive: true});
  const next = `${path}.next`;
  writeFileSync(next, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  renameSync(next, path);
}

/** @returns {{id:string, channelPreference:'stable'|'preview'}|null} */
export function readActiveEngine(userData) {
  const raw = readJson(activeEnginePath(userData));
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' && BUILD_ID.test(raw.id) ? raw.id : bundledInstallId();
  const channelPreference = raw.channelPreference === 'preview' ? 'preview' : 'stable';
  return {id, channelPreference};
}

export function writeActiveEngine(userData, record) {
  const id = typeof record?.id === 'string' && BUILD_ID.test(record.id) ? record.id : bundledInstallId();
  const channelPreference = record?.channelPreference === 'preview' ? 'preview' : 'stable';
  writeJsonAtomic(activeEnginePath(userData), {id, channelPreference});
  return {id, channelPreference};
}

export function installDir(userData, id) {
  if (id === bundledInstallId()) return null;
  if (!BUILD_ID.test(id)) throw new TypeError('Invalid engine id');
  return join(installsDir(userData), id);
}

export function manifestPath(userData, id) {
  const dir = installDir(userData, id);
  return dir ? join(dir, 'manifest.json') : null;
}

/** @returns {object|null} */
export function readInstallManifest(userData, id) {
  const path = manifestPath(userData, id);
  if (!path || !existsSync(path)) return null;
  const value = readJson(path);
  if (!value || typeof value !== 'object') return null;
  return value;
}

export function buildInstallId(sourceSha) {
  if (!SHA.test(String(sourceSha))) throw new TypeError('sourceSha must be a git SHA');
  return `build-${String(sourceSha).slice(0, 12)}`;
}

export function stageDir(userData, sourceSha) {
  if (!SHA.test(String(sourceSha))) throw new TypeError('sourceSha must be a git SHA');
  return join(engineRoot(userData), 'staging', String(sourceSha).slice(0, 12));
}

export function rollbackDir(userData) {
  return join(engineRoot(userData), 'rollback');
}

/** Layout inside an install: cli/dist/index.js beside packaged runtime node.exe path from caller. */
export function cliEntryForInstall(installRoot) {
  return join(installRoot, 'cli', 'dist', 'index.js');
}

export function cliPackageRootForInstall(installRoot) {
  return join(installRoot, 'cli');
}

/**
 * Resolve the active CLI entry and node executable for packaged Desktop.
 * @param {object} input
 * @param {string} input.userData
 * @param {string} input.resourcesPath
 * @param {{path:string, executable:string, ready:boolean}} input.bundled
 */
export function resolvePackagedEngine(input) {
  const {userData, resourcesPath, bundled} = input;
  const active = readActiveEngine(userData) ?? {id: bundledInstallId(), channelPreference: 'stable'};
  if (active.id === bundledInstallId()) {
    return {
      ...bundled,
      engineId: bundledInstallId(),
      channelPreference: active.channelPreference,
      installRoot: null,
      manifest: null,
      source: bundled.ready ? 'bundled' : 'missing',
    };
  }
  const root = installDir(userData, active.id);
  const entry = root ? cliEntryForInstall(root) : null;
  const manifest = readInstallManifest(userData, active.id);
  const node = bundled.executable;
  const ready = Boolean(entry && existsSync(entry) && lstatSync(entry).isFile() && bundled.executable && existsSync(node));
  if (!ready) {
    return {
      path: bundled.path,
      label: bundled.label,
      executable: bundled.executable,
      engineId: bundledInstallId(),
      channelPreference: active.channelPreference,
      installRoot: null,
      manifest,
      source: bundled.ready ? 'bundled' : 'missing',
      fallbackFrom: active.id,
    };
  }
  return {
    path: entry,
    label: `Installed CLI (${active.id})`,
    executable: node,
    engineId: active.id,
    channelPreference: active.channelPreference,
    installRoot: root,
    manifest,
    source: 'installed',
  };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Promote a validated staging directory to a versioned install and optionally activate it.
 * @param {object} input
 */
export function promoteStagedInstall({userData, sourceSha, channel, cliVersion, artifactSha256, activate = true}) {
  if (!SHA.test(sourceSha)) throw new TypeError('Invalid sourceSha');
  const id = buildInstallId(sourceSha);
  const staging = stageDir(userData, sourceSha);
  const target = installDir(userData, id);
  if (!existsSync(join(staging, 'cli', 'dist', 'index.js'))) {
    throw new Error('Staged CLI entry is missing');
  }
  mkdirSync(installsDir(userData), {recursive: true});
  rmSync(target, {recursive: true, force: true});
  cpSync(staging, target, {recursive: true});
  writeJsonAtomic(join(target, 'manifest.json'), {
    id,
    channel,
    sourceSha,
    cliVersion: typeof cliVersion === 'string' ? cliVersion : null,
    artifactSha256: typeof artifactSha256 === 'string' ? artifactSha256 : null,
    installedAt: new Date().toISOString(),
  });
  rmSync(staging, {recursive: true, force: true});
  if (activate) {
    const active = readActiveEngine(userData) ?? {id: bundledInstallId(), channelPreference: channel === 'preview' ? 'preview' : 'stable'};
    writeActiveEngine(userData, {id, channelPreference: active.channelPreference});
  }
  return {id, sourceSha, cliVersion};
}
