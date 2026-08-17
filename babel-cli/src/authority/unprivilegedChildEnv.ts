/**
 * unprivilegedChildEnv.ts — isolate local-command children from external privilege.
 *
 * Arbitrary `run_local_command` scripts must not inherit GitHub/cloud tokens
 * or a usable gh/git credential store. Privileged effects (merge, force-push,
 * deploy) stay on the PDP path and do not use this env.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSafeEnv } from '../utils/safeEnv.js';

const unprivilegedAls = new AsyncLocalStorage<true>();

export function runWithUnprivilegedChildEnv<T>(fn: () => T): T {
  return unprivilegedAls.run(true, fn);
}

export function isUnprivilegedChildEnvActive(): boolean {
  return unprivilegedAls.getStore() === true;
}

export function buildUnprivilegedChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const safe = getSafeEnv(env);
  const isolated = mkdtempSync(join(tmpdir(), 'babel-unpriv-gh-'));
  const emptyGitConfig = join(isolated, 'gitconfig.empty');
  return {
    ...safe,
    GH_CONFIG_DIR: isolated,
    GH_HOST: '',
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
  };
}

export function childEnvForSandbox(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return isUnprivilegedChildEnvActive() ? buildUnprivilegedChildEnv(env) : getSafeEnv(env);
}
