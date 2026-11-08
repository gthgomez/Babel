// License: Apache-2.0

/** Canonical npm command. `babel` and `babel-agent` remain compatible aliases. */
export const CLI_COMMAND = 'babel-harness';

const CLI_NAMES = new Set(['babel', 'babel-agent', 'babel-harness']);

/**
 * Report the executable the user actually invoked so `babel --help` and
 * `babel-agent --help` identify themselves correctly, and a conflicting
 * `babel` on PATH is diagnosable from the usage line.
 */
export function invokedCliName(executable: string | undefined = process.argv[1]): string {
  const base = (executable ?? '')
    .split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.(?:js|mjs|cjs|cmd|exe|bat)$/, '') ?? '';
  return CLI_NAMES.has(base) ? base : CLI_COMMAND;
}
