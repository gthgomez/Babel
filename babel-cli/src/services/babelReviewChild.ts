import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BABEL_OPENCODE_GO_HELPER_ENV } from '../runners/openCodeGoCredential.js';

/** Construct a fresh child environment; never forward GitHub or ambient provider keys. */
export function babelReviewChildEnv(input: { source: string; trustedRoot: string; output: string; runs: string; model: string; purpose?: 'review' | 'repair_proposal' }, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']) {
    if (parent[key]) env[key] = parent[key];
  }
  // The documented credential-helper override is a filesystem path, not a
  // secret, so the child may see it. Without this the reviewer always resolved
  // the canonical helper and docs/BABEL_PR_REVIEW.md's override claim was false.
  const helperOverride = parent[BABEL_OPENCODE_GO_HELPER_ENV]?.trim();
  return { ...env,
    ...(helperOverride ? { [BABEL_OPENCODE_GO_HELPER_ENV]: helperOverride } : {}),
    BABEL_ROOT: input.trustedRoot, BABEL_PROJECT_ROOT: input.source, BABEL_RUNS_DIR: input.runs,
    BABEL_REVIEW_OUTPUT: input.output, BABEL_REVIEW_MODEL: input.model,
    BABEL_REVIEW_PURPOSE: input.purpose ?? 'review',
    BABEL_EXECUTION_PROFILE: 'read_only_audit', BABEL_READ_ONLY: 'true', BABEL_HEADLESS: '1',
    // Review sessions run under normal ChatEngine budget semantics unless overridden.
    ...(parent['BABEL_CHAT_MAX_COST'] ? { BABEL_CHAT_MAX_COST: parent['BABEL_CHAT_MAX_COST'] } : { BABEL_CHAT_MAX_COST: 'unlimited' }),
    ...(parent['BABEL_CHAT_MAX_WALL_MS'] ? { BABEL_CHAT_MAX_WALL_MS: parent['BABEL_CHAT_MAX_WALL_MS'] } : {}),
    ...(parent['BABEL_CHAT_MAX_TURNS'] ? { BABEL_CHAT_MAX_TURNS: parent['BABEL_CHAT_MAX_TURNS'] } : {}),
    ...(parent['BABEL_CHAT_STALL_TURNS'] ? { BABEL_CHAT_STALL_TURNS: parent['BABEL_CHAT_STALL_TURNS'] } : {}),
    BABEL_ALLOWED_TOOLS: JSON.stringify(['file_read', 'directory_list', 'grep', 'glob']),
    BABEL_DISALLOWED_TOOLS: JSON.stringify(['shell_exec', 'test_run', 'file_write', 'mcp_request', 'memory_query', 'memory_store', 'semantic_search']),
    BABEL_READ_ONLY_NO_INDEX_WRITE: '1',
    BABEL_TOOL_PROFILE: 'native',
    NO_COLOR: '1',
  };
}

/** One separate process per review. Private logs survive timeout and malformed output. */
export async function launchBabelReviewChild(input: { source: string; trustedRoot: string; output: string; runs: string; model: string; purpose?: 'review' | 'repair_proposal'; worker: string; tsx: string; timeoutMs?: number; onSpawn?: (pid: number) => void; onExit?: () => void }) {
  // tsx's CLI is a process wrapper. Import its package-exported loader in the
  // actual worker process so the lease PID and timeout target own inference.
  // A file URL also handles drive letters and spaces on Windows.
  const loader = pathToFileURL(join(dirname(input.tsx), 'loader.mjs')).href;
  const child = spawn(process.execPath, ['--import', loader, input.worker], {
    cwd: input.source, env: babelReviewChildEnv(input), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const log = input.output + '.log';
  if (child.pid) {
    try { input.onSpawn?.(child.pid); } catch (error) { child.kill(); throw error; }
  }
  // Host-private diagnostic data, never directly posted to GitHub.
  child.stdout.on('data', chunk => appendFileSync(log, chunk, { mode: 0o600 }));
  child.stderr.on('data', chunk => appendFileSync(log, chunk, { mode: 0o600 }));
  let timedOut = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    // SIGTERM is cooperative on POSIX. Do not leave an unresponsive review
    // child holding the lease forever; Windows already terminates it directly.
    forceKillTimer = setTimeout(() => { if (!child.exitCode) child.kill('SIGKILL'); }, 2000);
  }, input.timeoutMs ?? (input.purpose === 'repair_proposal' ? 3050000 : 780000));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  }).finally(() => { clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer); input.onExit?.(); });
  let artifact: Record<string, unknown> | null = null;
  try { artifact = JSON.parse(readFileSync(input.output, 'utf8')) as Record<string, unknown>; } catch { /* retained as failed process evidence */ }
  return { exitCode: code, timedOut, artifact };
}
