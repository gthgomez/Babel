import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const OFFICIAL_CLI_LABEL = 'babel-cli/dist/index.js';

/** Development runtime: the Babel CLI built beside this package. */
export function resolveOfficialCli(packageRoot) {
  if (typeof packageRoot !== 'string' || packageRoot.length === 0) {
    throw new TypeError('packageRoot is required');
  }
  const path = resolve(packageRoot, '..', 'babel-cli', 'dist', 'index.js');
  return {
    path,
    label: OFFICIAL_CLI_LABEL,
    ready: existsSync(path),
  };
}
