import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export type OpenCodeInstallState = 'missing' | 'unverified' | 'verified';

export interface OpenCodeInstallProbe {
  state: OpenCodeInstallState;
  executable?: string;
  version?: string;
  rawVersion?: string;
}

export type OpenCodeVersionSpawnFn = (
  executable: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const POSIX_EXECUTABLE_CANDIDATES = ['opencode'] as const;
const WIN32_EXECUTABLE_CANDIDATES = ['opencode'] as const;

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

function reviewerEnvironment(pathEnv: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    if (process.env[name]) env[name] = process.env[name];
  }
  if (pathEnv) env.PATH = pathEnv;
  return env;
}

function pathDirectoryIsProjectLocal(directory: string): boolean {
  try {
    const canonicalDir = realpathSync(resolve(directory));
    const cwd = realpathSync(process.cwd());
    return canonicalDir === cwd || canonicalDir.startsWith(`${cwd}${sep}`);
  } catch {
    return true;
  }
}

/** Resolve an OpenCode CLI binary on PATH without granting it controller authority. */
export function resolveOpenCodeExecutable(pathEnv: string | undefined = process.env.PATH): string | undefined {
  if (process.platform === 'win32') {
    const pathValue = pathEnv ?? process.env.PATH ?? '';
    for (const directory of pathValue.split(';')) {
      if (!directory || directory === '.' || !isAbsolute(directory)) continue;
      if (pathDirectoryIsProjectLocal(directory)) continue;
      for (const name of WIN32_EXECUTABLE_CANDIDATES) {
        const candidate = resolve(directory, `${name}.exe`);
        try {
          const target = realpathSync(candidate);
          const stat = lstatSync(target);
          if (!stat.isFile()) continue;
          return target;
        } catch {
          const candidateNoExt = resolve(directory, name);
          try {
            const target = realpathSync(candidateNoExt);
            const stat = lstatSync(target);
            if (!stat.isFile()) continue;
            return target;
          } catch {
            /* try next */
          }
        }
      }
    }
    return undefined;
  }
  for (const directory of (pathEnv ?? '').split(':')) {
    if (!directory || directory === '.' || !isAbsolute(directory)) continue;
    if (pathDirectoryIsProjectLocal(directory)) continue;
    for (const name of POSIX_EXECUTABLE_CANDIDATES) {
      const candidate = resolve(directory, name);
      try {
        const target = realpathSync(candidate);
        const stat = lstatSync(target);
        if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
        return target;
      } catch {
        /* try next candidate */
      }
    }
  }
  return undefined;
}

function versionProbeLaunch(
  executable: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (executable.endsWith('.mjs') || executable.endsWith('.js')) {
    return { command: process.execPath, args: [executable, ...args] };
  }
  return { command: executable, args: [...args] };
}

function defaultVersionSpawn(
  executable: string,
  args: readonly string[],
  pathEnv: string | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const launch = versionProbeLaunch(executable, args);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(launch.command, launch.args, {
      env: reviewerEnvironment(pathEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8_192) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 512);
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

const SEMVER_RE = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/;

function parseVersion(stdout: string, stderr: string): string | undefined {
  const blob = `${stdout}\n${stderr}`;
  const match = blob.match(SEMVER_RE);
  return match?.[1];
}

/**
 * Probe local OpenCode CLI installation. Never performs paid/provider calls.
 * Tests inject probes via registry constructor options only.
 */
export async function probeOpenCodeInstallation(options?: {
  pathEnv?: string;
  spawnFn?: OpenCodeVersionSpawnFn;
}): Promise<OpenCodeInstallProbe> {
  const pathEnv = options?.pathEnv;

  const executable = resolveOpenCodeExecutable(pathEnv);
  if (!executable) return { state: 'missing' };

  const spawnFn =
    options?.spawnFn ??
    ((exe, args) => defaultVersionSpawn(exe, args, pathEnv));

  for (const args of [['--version'], ['version'], ['-V']] as const) {
    try {
      const outcome = await spawnFn(executable, args);
      const raw = `${outcome.stdout}${outcome.stderr}`.trim();
      const version = parseVersion(outcome.stdout, outcome.stderr);
      if (outcome.exitCode === 0 && version) {
        return { state: 'verified', executable, version, rawVersion: raw };
      }
      if (raw.length > 0) {
        return { state: 'unverified', executable, rawVersion: raw };
      }
    } catch {
      /* try next argv shape */
    }
  }
  return { state: 'unverified', executable };
}
