import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ClaudeCodeLaunchPolicySpec } from './claudeCodePolicyEvidence.js';

export interface IsolatedResolveSettingsPayload {
  /** query() options.cwd */
  cwd: string;
  /** query() options.projectConfigRoot (bound in admission digest; resolveSettings uses cwd only). */
  projectConfigRoot: string;
  childEnv: Record<string, string>;
  launchSpec: ClaudeCodeLaunchPolicySpec;
}

export interface IsolatedResolveSettingsResult {
  filtered: Record<string, unknown>;
  sources: Array<{ source: string; settings: Record<string, unknown>; path?: string }>;
}

function workerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'claudeCodeIsolatedResolveWorker.mjs'),
    join(here, '..', '..', 'src', 'bridge', 'claudeCodeIsolatedResolveWorker.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('claudeCodeIsolatedResolveWorker.mjs not found');
}

/**
 * Run SDK resolveSettings in a child with full env replace (matches query childEnv).
 * Parent process.env is not mutated.
 */
export async function resolveSettingsInIsolatedChildEnv(
  payload: IsolatedResolveSettingsPayload,
): Promise<IsolatedResolveSettingsResult> {
  const script = workerPath();
  const stdin = JSON.stringify({
    cwd: payload.cwd,
    projectConfigRoot: payload.projectConfigRoot,
    settingSources: payload.launchSpec.settingSources,
    managedSettings: payload.launchSpec.managedSettings,
    serverManagedSettings: undefined,
    childEnv: payload.childEnv,
  });

  return await new Promise((resolvePromise, reject) => {
    const spawnEnv = { ...payload.childEnv };
    if (!spawnEnv.PATH) {
      spawnEnv.PATH = process.env.PATH ?? '/usr/bin:/bin';
    }
    const child = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: spawnEnv,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 2048);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr || `isolated resolveSettings exited ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as {
          ok: boolean;
          filtered: Record<string, unknown>;
          sources: IsolatedResolveSettingsResult['sources'];
        };
        resolvePromise({ filtered: parsed.filtered, sources: parsed.sources });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(stdin);
  });
}
