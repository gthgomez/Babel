// License: Apache-2.0
// Keep this predicate aligned with supportsInstalledNode in src/installedDoctor.ts.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const suppressedEmitters = new WeakSet();

/** True for Node ^22.19.0 or ^24.13.1. */
export function nodeEngineSupported(version) {
  const [major = 0, minor = 0, patch = 0] = String(version).replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 19) || (major === 24 && (minor > 13 || (minor === 13 && patch >= 1)));
}

/**
 * @param {string} version
 * @param {'install' | 'command'} phase
 */
export function formatNodeEngineError(version, phase = 'command') {
  const shown = String(version).startsWith('v') ? String(version) : `v${version}`;
  const stopped = phase === 'install'
    ? 'npm stopped installing babel-harness.'
    : 'babel-harness stopped before running a command.';
  return [
    'babel-harness needs Node.js ^22.19.0 or ^24.13.1.',
    `This program is running Node.js ${shown}.`,
    '',
    'Install Node.js 22.19.0 or a newer 22.x release, or Node.js 24.13.1 or a newer 24.x release.',
    'Check the version you will use:',
    '  node --version',
    '',
    'Installers: https://nodejs.org/en/download',
    '  nvm install 22',
    '  fnm install 22',
    '',
    stopped,
    'babel-agent is the same program and needs the same Node.js.',
  ].join('\n');
}

/**
 * Hide ExperimentalWarning in this process. DeprecationWarning and other
 * warnings still emit. This does not start another process, so the command
 * keeps the process id that diagnostics and tests record.
 * @param {NodeJS.Process} [proc]
 */
export function suppressExperimentalWarnings(proc = process) {
  const show = proc.env?.BABEL_SHOW_NODE_WARNINGS;
  if (show === '1' || show === 'true') return false;
  const traced = [...(proc.execArgv ?? []), proc.env?.NODE_OPTIONS ?? ''].join(' ');
  if (/(?:^|\s)--trace-warnings(?:\s|=|$)/.test(` ${traced} `)) return false;
  if (suppressedEmitters.has(proc)) return true;
  const emit = proc.emit.bind(proc);
  proc.emit = function (event, warning, ...rest) {
    if (event === 'warning' && warning && typeof warning === 'object' && warning.name === 'ExperimentalWarning') return false;
    return emit(event, warning, ...rest);
  };
  suppressedEmitters.add(proc);
  return true;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly() && !nodeEngineSupported(process.versions.node)) {
  console.error(formatNodeEngineError(process.versions.node, 'install'));
  process.exit(1);
}
