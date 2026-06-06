import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function getGitCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['BABEL_GIT_PATH']?.trim();
  if (configured) {
    return configured;
  }

  if (process.platform !== 'win32') {
    return 'git';
  }

  for (const root of [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] ? join(env['LOCALAPPDATA'], 'Programs') : undefined,
    'C:\\Program Files',
  ]) {
    if (!root) {
      continue;
    }
    const candidate = join(root, 'Git', 'cmd', 'git.exe');
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return 'git';
}

export function buildGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  const pathValue = next['PATH'] ?? next['Path'];
  if (pathValue) {
    next['PATH'] = pathValue;
    next['Path'] = pathValue;
  }
  return next;
}

export function runGitCommand(args: string[], cwd: string, options: {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
} = {}): GitCommandResult {
  const env = buildGitEnv(options.env);
  const result = spawnSync(getGitCommand(env), args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 15_000,
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}
