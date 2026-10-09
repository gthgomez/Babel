import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {resolvePackagedEngine} from './engine-manager.mjs';

export const OFFICIAL_CLI_LABEL = 'babel-cli/dist/index.js';

/** Bundled fallback runtime inside a packaged Desktop install. */
export function resolveBundledCli(packageRoot, {resourcesPath, executable = process.execPath} = {}) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0) {
    throw new TypeError('packageRoot is required');
  }
  const path = resolve(resourcesPath, 'babel-runtime', 'cli', 'dist', 'index.js');
  const node = resolve(resourcesPath, 'babel-runtime', 'node', 'node.exe');
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
