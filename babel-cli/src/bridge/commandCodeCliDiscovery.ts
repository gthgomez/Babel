import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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

function pathDirectoryIsProjectLocal(directory: string): boolean {
  try {
    const canonicalDir = realpathSync(resolve(directory));
    const cwd = realpathSync(process.cwd());
    return canonicalDir === cwd || canonicalDir.startsWith(`${cwd}${sep}`);
  } catch {
    return true;
  }
}

function isWindowsCommandInterpreter(path: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    const actual = realpathSync(path).toLowerCase();
    const systemRoot = process.env['SystemRoot'] ?? process.env['WINDIR'];
    const candidates = [process.env['COMSPEC'], ...(systemRoot ? [resolve(systemRoot, 'System32', 'cmd.exe'), resolve(systemRoot, 'SysWOW64', 'cmd.exe')] : [])];
    return candidates.some(candidate => {
      if (!candidate) return false;
      try { return realpathSync(candidate).toLowerCase() === actual; } catch { return false; }
    });
  } catch { return false; }
}

/** Resolve npm's Windows shims to their declared Node entry, without running a shell. */
function resolveWindowsNpmEntry(directory: string): string | undefined {
  try {
    if (!['cmdc.cmd', 'cmdc.ps1', 'command-code.cmd', 'command-code.ps1'].some(name => existsSync(resolve(directory, name)))) return undefined;
    const base = realpathSync(resolve(directory, 'node_modules', 'command-code'));
    const expectedBase = resolve(realpathSync(directory), 'node_modules', 'command-code');
    if (base.toLowerCase() !== expectedBase.toLowerCase()) return undefined;
    const metadataPath = resolve(base, 'package.json'); const metadataInfo = lstatSync(metadataPath);
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.nlink !== 1 || metadataInfo.size > 128 * 1024) return undefined;
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { name?: unknown; bin?: unknown };
    if (metadata.name !== 'command-code' || !metadata.bin || typeof metadata.bin !== 'object' || Array.isArray(metadata.bin)) return undefined;
    const bin = metadata.bin as Record<string, unknown>;
    const declared = typeof bin['cmdc'] === 'string' ? bin['cmdc'] : bin['command-code'];
    if (typeof declared !== 'string' || isAbsolute(declared) || !/\.(?:mjs|js)$/i.test(declared)) return undefined;
    const entry = realpathSync(resolve(base, declared)); const rel = relative(base, entry);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    const info = lstatSync(entry);
    return info.isFile() && info.nlink === 1 ? entry : undefined;
  } catch { return undefined; }
}

/** Resolve a Command Code CLI binary on PATH without granting it controller authority. */
export function resolveCommandCodeExecutable(pathEnv: string | undefined = process.env.PATH): string | undefined {
  const override = process.env['BABEL_COMMAND_CODE_CLI_EXECUTABLE']?.trim();
  if (override) return isWindowsCommandInterpreter(override) ? undefined : override;

  if (process.platform === 'win32') {
    const pathValue = pathEnv ?? process.env.PATH ?? '';
    for (const directory of pathValue.split(';')) {
      if (!directory || directory === '.' || !isAbsolute(directory)) continue;
      if (pathDirectoryIsProjectLocal(directory)) continue;
      const npmEntry = resolveWindowsNpmEntry(directory);
      if (npmEntry) return npmEntry;
      for (const name of WIN32_EXECUTABLE_CANDIDATES) {
        const candidate = resolve(directory, `${name}.exe`);
        try {
          const target = realpathSync(candidate);
          const stat = lstatSync(target);
          if (!stat.isFile() || isWindowsCommandInterpreter(target)) continue;
          return target;
        } catch {
          const candidateNoExt = resolve(directory, name);
          try {
            const target = realpathSync(candidateNoExt);
            const stat = lstatSync(target);
            if (!stat.isFile() || isWindowsCommandInterpreter(target)) continue;
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
 * Probe local Command Code CLI installation. Never performs paid/provider calls.
 */
export async function probeCommandCodeInstallation(options?: {
  pathEnv?: string;
  spawnFn?: CommandCodeVersionSpawnFn;
}): Promise<CommandCodeInstallProbe> {
  const pathEnv = options?.pathEnv;

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
