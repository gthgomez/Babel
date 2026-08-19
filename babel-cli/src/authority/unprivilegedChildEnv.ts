/**
 * unprivilegedChildEnv.ts — isolate local-command children from external privilege.
 *
 * Arbitrary `run_local_command` scripts must not inherit GitHub/cloud tokens
 * or a usable gh/git credential store. Privileged effects (merge, force-push,
 * deploy) stay on the PDP path and do not use this env.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSafeEnv } from '../utils/safeEnv.js';

let emptyHooksDir: string | undefined;

export function babelEmptyHooksDir(): string {
  if (!emptyHooksDir) {
    emptyHooksDir = mkdtempSync(join(tmpdir(), 'babel-empty-hooks-'));
    mkdirSync(emptyHooksDir, { recursive: true });
  }
  return emptyHooksDir;
}

const unprivilegedAls = new AsyncLocalStorage<true>();

export function runWithUnprivilegedChildEnv<T>(fn: () => T): T {
  return unprivilegedAls.run(true, fn);
}

export function isUnprivilegedChildEnvActive(): boolean {
  return unprivilegedAls.getStore() === true;
}

/** Bind-mount target so container Git sees the empty hooks dir. */
export const BABEL_CONTAINER_EMPTY_HOOKS_DIR = '/babel-empty-hooks';
export const BABEL_CONTAINER_NO_EDITOR = `${BABEL_CONTAINER_EMPTY_HOOKS_DIR}/no-editor`;

export function gitHostConfigOverrides(opts?: {
  hooksDir?: string;
  editorPath?: string;
}): NodeJS.ProcessEnv {
  const hooksDir = opts?.hooksDir ?? babelEmptyHooksDir();
  const noEditor = opts?.editorPath ?? join(hooksDir, 'no-editor');
  return {
    GIT_TERMINAL_PROMPT: '0',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_EDITOR: noEditor,
    GIT_SEQUENCE_EDITOR: noEditor,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksDir,
    GIT_CONFIG_KEY_1: 'commit.gpgSign',
    GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'tag.gpgSign',
    GIT_CONFIG_VALUE_2: 'false',
  };
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
    GH_PROMPT_DISABLED: '1',
    ...gitHostConfigOverrides(),
  };
}

export function childEnvForSandbox(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return isUnprivilegedChildEnvActive() ? buildUnprivilegedChildEnv(env) : getSafeEnv(env);
}

/**
 * Git host hardening is independent of the unprivileged-local capability
 * wrapper. Publication/gated git (`commit`, `push`, `merge`, `tag`) must
 * still be unable to execute repo or user hooks or implicit signers.
 * HOME and credential helpers stay intact so legitimate publication auth
 * still works; execution-bearing Git config writes are denied separately.
 */
export function hardenGitHostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    ...gitHostConfigOverrides(),
  };
}
