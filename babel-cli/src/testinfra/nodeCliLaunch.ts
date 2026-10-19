import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Same bootstrap flags used by `cliEntryDispatch.integration.test.ts` and Desktop IPC children. */
export const BABEL_NODE_WASM_ARGS = ['--experimental-wasm-modules'] as const;

export function resolveProductionCliEntry(): string {
  const distIndex = join(packageRoot, 'dist', 'index.js');
  if (existsSync(distIndex)) return distIndex;
  const binEntry = join(packageRoot, 'bin', 'babel.js');
  if (existsSync(binEntry)) return binEntry;
  throw new Error('Production CLI entry missing: build babel-cli (dist/index.js or bin/babel.js)');
}

export function productionNodeCliArgv(entry: string, cliArgs: string[]): string[] {
  return [...BABEL_NODE_WASM_ARGS, entry, ...cliArgs];
}
