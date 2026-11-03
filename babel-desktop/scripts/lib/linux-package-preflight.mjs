// License: Apache-2.0
import {spawnSync} from 'node:child_process';

const TOOLS = [
  ['file', 'appimagetool uses it to identify binaries'],
  ['unzip', 'the packager extracts the Electron archive with it'],
  ['tar', 'the packager extracts the Node archive and the CLI pack with it'],
];

function defaultWhich(name) {
  const result = spawnSync('sh', ['-c', `command -v ${name}`], {encoding: 'utf8'});
  return result.status === 0 && Boolean(result.stdout.trim());
}

/**
 * Fail before the long install when a host tool the Linux packager needs is absent.
 * @param {{which?: (name: string) => boolean, platform?: string}} [options]
 */
export function assertLinuxPackagingTools({which = defaultWhich, platform = process.platform} = {}) {
  if (platform !== 'linux') return;
  const missing = TOOLS.filter(([name]) => !which(name));
  if (missing.length === 0) return;
  const names = missing.map(([name]) => name).join(', ');
  const why = missing.map(([name, reason]) => `${name}: ${reason}`).join('; ');
  throw new Error(`Missing required tool: ${names}. ${why}. Install the missing package and retry (Debian/Ubuntu: sudo apt-get install ${names.replaceAll(', ', ' ')}; Fedora: sudo dnf install ${names.replaceAll(', ', ' ')}).`);
}
