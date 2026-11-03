import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {resolvePackagedEngine} from './engine-manager.mjs';
import {DESKTOP_PROFILE_DIRECTORY, LEGACY_DESKTOP_PROFILE_DIRECTORY, migrateDesktopProfile} from './profile-migration.mjs';

export const OFFICIAL_CLI_LABEL = 'babel-cli/dist/index.js';
export {DESKTOP_PROFILE_DIRECTORY, LEGACY_DESKTOP_PROFILE_DIRECTORY};

/** Packaged Node file name. Windows builds ship node.exe; Linux builds ship node. */
export function bundledNodeFileName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/**
 * Parent of the Desktop settings directory.
 * Windows: %APPDATA% (USERPROFILE fallback). Linux: $XDG_CONFIG_HOME or ~/.config.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function desktopProfileParent(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const base = env.APPDATA || env.USERPROFILE;
    if (!base) throw new Error('Windows Desktop profile requires APPDATA or USERPROFILE');
    return base;
  }
  if (!env.HOME) throw new Error('Desktop profile requires HOME');
  return env.XDG_CONFIG_HOME || join(env.HOME, '.config');
}

/**
 * Settings directory used by this version. Electron's package name stays the
 * historical app id; callers set userData to this path explicitly.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {string}
 */
export function defaultDesktopProfile(env = process.env, platform = process.platform) {
  return join(desktopProfileParent(env, platform), DESKTOP_PROFILE_DIRECTORY);
}

/** Previous settings directory, kept after a verified copy. */
export function legacyDesktopProfile(env = process.env, platform = process.platform) {
  return join(desktopProfileParent(env, platform), LEGACY_DESKTOP_PROFILE_DIRECTORY);
}

/**
 * Settings directory to open. A failed copy keeps the old directory so
 * existing settings remain readable.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @returns {{profile: string, action: string, error?: string, filesCopied?: number, filesKept?: number}}
 */
export function resolveDesktopProfile(env = process.env, platform = process.platform) {
  const parent = desktopProfileParent(env, platform);
  try {
    return migrateDesktopProfile(parent);
  } catch (error) {
    return {profile: join(parent, LEGACY_DESKTOP_PROFILE_DIRECTORY), action: 'failed', error: error instanceof Error ? error.message : String(error)};
  }
}

/** Bundled fallback runtime inside a packaged Desktop install. */
export function resolveBundledCli(packageRoot, {resourcesPath, executable = process.execPath} = {}) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0) {
    throw new TypeError('packageRoot is required');
  }
  const path = resolve(resourcesPath, 'babel-runtime', 'cli', 'dist', 'index.js');
  const node = resolve(resourcesPath, 'babel-runtime', 'node', bundledNodeFileName());
  const isFile = value => existsSync(value) && statSync(value).isFile();
  return {
    path,
    label: 'Bundled Babel CLI',
    executable: node,
    source: 'bundled',
    ready: isFile(path) && isFile(node),
  };
}

/** Development runtime: the Babel CLI built beside this package. */
export function resolveOfficialCli(packageRoot, {isPackaged = false, resourcesPath, executable = process.execPath, userData = null} = {}) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0) {
    throw new TypeError('packageRoot is required');
  }
  if (isPackaged) {
    const bundled = resolveBundledCli(packageRoot, {resourcesPath, executable});
    if (!userData) return bundled;
    return resolvePackagedEngine({userData, resourcesPath, bundled});
  }
  const path = resolve(packageRoot, '..', 'babel-cli', 'dist', 'index.js');
  const node = executable;
  const isFile = value => existsSync(value) && statSync(value).isFile();
  return {
    path,
    label: OFFICIAL_CLI_LABEL,
    executable: node,
    source: 'official',
    ready: isFile(path) && isFile(node),
  };
}

/** Desktop owns these paths; environment credentials remain opt-in user configuration. */
export function bundledEnvironment(userData, inherited = process.env) {
  const env = {...inherited};
  for (const name of Object.keys(env)) {
    if (/^(?:NODE_OPTIONS|NODE_PATH|NODE_COMPILE_CACHE|ELECTRON_RUN_AS_NODE|BABEL_(?:ROOT|ENV_LOADED|CONFIG_DIR|STATE_DIR|CACHE_DIR|RUNS_DIR|PROJECT_ROOT))$/i.test(name)) delete env[name];
  }
  return {...env,
    BABEL_CONFIG_DIR: join(userData, 'engine', 'config'),
    BABEL_STATE_DIR: join(userData, 'engine', 'state'),
    BABEL_CACHE_DIR: join(userData, 'engine', 'cache'),
    BABEL_RUNS_DIR: join(userData, 'engine', 'state', 'runs'),
    NODE_COMPILE_CACHE: join(userData, 'engine', 'cache', 'node-compile-cache'),
  };
}
