// License: Apache-2.0
// Credential writes live in the trusted Electron main process, never the renderer.
import {closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {isAbsolute, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

const PROVIDERS = Object.freeze({
  deepseek: 'DEEPSEEK_API_KEY',
  deepinfra: 'DEEPINFRA_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
});
const FILE_LIMIT = 256 * 1024;

export function credentialProviders() {
  return Object.keys(PROVIDERS);
}

function safeApiKey(key) {
  // A conservative single-line dotenv value; never interpolate arbitrary user text.
  return typeof key === 'string' && key.length >= 8 && key.length <= 4096 &&
    /^[A-Za-z0-9_./:+==-]+$/.test(key);
}

function gitOk(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 4096,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

/** Only an expressly selected project with an ignored, untracked .env may receive secrets. */
export function verifyProjectCredentialTarget(projectRoot, git = gitOk) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) {
    throw new Error('Select an absolute project directory first.');
  }
  const root = resolve(projectRoot);
  let rootInfo;
  try { rootInfo = lstatSync(root); } catch { throw new Error('Selected project is unavailable.'); }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error('Project credential storage requires a real directory, not a link.');
  }
  if (!git(root, ['rev-parse', '--is-inside-work-tree'])) {
    throw new Error('Project-local credentials require a Git repository with .env ignored.');
  }
  if (git(root, ['ls-files', '--error-unmatch', '--', '.env'])) {
    throw new Error('Project .env is tracked by Git. Use private Babel storage instead.');
  }
  if (!git(root, ['check-ignore', '-q', '--', '.env'])) {
    throw new Error('Project .env is not Git-ignored. Add .env to .gitignore first, or use private Babel storage.');
  }
  const target = join(root, '.env');
  let info;
  try { info = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info) {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
      throw new Error('Project .env is not a regular, unlinked file.');
    }
  }
  return target;
}

function privateTarget(configDirectory) {
  if (typeof configDirectory !== 'string' || configDirectory.length === 0) {
    throw new Error('Private Babel configuration directory is unavailable.');
  }
  if (!isAbsolute(configDirectory)) {
    throw new Error('Private Babel configuration directory must be an absolute path.');
  }
  const dir = resolve(configDirectory);
  mkdirSync(dir, {recursive:true, mode:0o700});
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Babel configuration directory cannot be a link.');
  }
  return join(dir, '.env');
}

function safelyAddKey(target, name, key) {
  // Exclusive lock avoids clobbering simultaneous credential setup attempts.
  const lock = target + '.babel-lock';
  let lockFd;
  try { lockFd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Credential setup is already running or the storage directory is not writable.'); }
  let temp = null;
  try {
    let existing = '';
    let info;
    try { info = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > FILE_LIMIT) {
        throw new Error('Existing credential file is unsafe or too large. No changes were made.');
      }
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        throw new Error('Credential file permissions are too broad. Secure it before continuing.');
      }
      existing = readFileSync(target, 'utf8');
      if (existing.includes('\0')) throw new Error('Existing credential file is invalid.');
      if (new RegExp('(?:^|\\n)\\s*' + name + '\\s*=', 'm').test(existing)) {
        throw new Error('This provider already has a setting. Existing credentials are never overwritten automatically.');
      }
    }
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    const next = existing + separator + name + '=' + key + '\n';
    temp = target + '.' + randomUUID() + '.tmp';
    writeFileSync(temp, next, {flag:'wx', mode:0o600, encoding:'utf8'});
    renameSync(temp, target);
    temp = null;
  } finally {
    if (temp) rmSync(temp, {force:true});
    if (lockFd !== undefined) closeSync(lockFd);
    rmSync(lock, {force:true});
  }
}

/** Never return the key or the resulting credential-file contents. */
export function saveProviderCredential({provider, apiKey, scope = 'private', configDirectory, projectRoot} = {}) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, provider)) {
    throw new Error('Select a supported, authority-qualified cloud provider.');
  }
  if (!safeApiKey(apiKey)) {
    throw new Error('API key must be one nonempty, single-line provider token.');
  }
  if (scope !== 'private' && scope !== 'project') {
    throw new Error('Credential destination must be private or explicitly project-local.');
  }
  const target = scope === 'private'
    ? privateTarget(configDirectory)
    : verifyProjectCredentialTarget(projectRoot);
  safelyAddKey(target, PROVIDERS[provider], apiKey);
  return {provider, scope, configured:true};
}
