import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export type CommandCodeInstallState = 'missing' | 'unverified' | 'verified';

export interface CommandCodeInstallProbe {
  state: CommandCodeInstallState;
  executable?: string;
  version?: string;
  rawVersion?: string;
}

export type CommandCodeVersionSpawnFn = (
  executable: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const POSIX_EXECUTABLE_CANDIDATES = ['cmd', 'command-code'] as const;
const WIN32_EXECUTABLE_CANDIDATES = ['cmdc', 'cmd', 'command-code'] as const;

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

/** Resolve a Command Code CLI binary on PATH without granting it controller authority. */
export function resolveCommandCodeExecutable(pathEnv: string | undefined = process.env.PATH): string | undefined {
  const override = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE']?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    for (const name of WIN32_EXECUTABLE_CANDIDATES) {
      if (name) return name;
    }
    return undefined;
  }
  for (const directory of (pathEnv ?? '').split(':')) {
    if (!directory || !isAbsolute(directory)) continue;
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

function defaultVersionSpawn(
  executable: string,
  args: readonly string[],
  pathEnv: string | undefined,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
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
 * Probe local Command Code CLI installation. Never performs paid/provider calls.
 * When `BABEL_COMMAND_CODE_ACP_COMMAND` is set (tests), treat as verified if executable exists.
 */
export async function probeCommandCodeInstallation(options?: {
  pathEnv?: string;
  spawnFn?: CommandCodeVersionSpawnFn;
}): Promise<CommandCodeInstallProbe> {
  const pathEnv = options?.pathEnv;
  const testAcpCommand = process.env['BABEL_COMMAND_CODE_ACP_COMMAND']?.trim();
  if (testAcpCommand) {
    return {
      state: 'verified',
      executable: testAcpCommand,
      version: 'fixture-acp-peer',
    };
  }

  const executable = resolveCommandCodeExecutable(pathEnv);
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
