/**
 * Minimum host environment for `spawn(..., { inheritEnv: false })` on Node children.
 * Mirrors Electron lifecycle / remoteHost diagnostic tests — not a credential surface.
 */

const SPAWN_ENV_FLOOR_NAMES = Object.freeze([
  'PATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'TEMP',
  'TMP',
  'LOCALAPPDATA',
  'APPDATA',
  'USERPROFILE',
  'HOME',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
]);

/**
 * @param {Record<string, string>} [overrides] Babel-owned keys (config, runs, IPC flags).
 * @returns {Record<string, string>}
 */
export function nodeChildSpawnEnvironment(overrides = {}) {
  const env = {};
  for (const name of SPAWN_ENV_FLOOR_NAMES) {
    const value = process.env[name];
    if (typeof value === 'string' && value.length > 0) env[name] = value;
  }
  return { ...env, ...overrides };
}

/** Spawn option contract shared by RemoteBridgeChild and SharedProtocolRun. */
export function documentedNodeChildSpawnOptions() {
  return {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
  };
}
