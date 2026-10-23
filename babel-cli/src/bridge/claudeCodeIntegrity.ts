import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadClaudeAgentSdkPin } from './claudeCodeSdkPin.js';

export type ClaudeSdkIntegrityState = 'missing' | 'unverified' | 'verified';

export interface ClaudeSdkIntegrityProbe {
  state: ClaudeSdkIntegrityState;
  sdkVersion?: string;
  cliVersion?: string;
  executablePath?: string;
  detail?: string;
}

const SEMVER_RE = /\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/;

function parseCliVersion(stdout: string, stderr: string): string | undefined {
  const blob = `${stdout}\n${stderr}`;
  const match = blob.match(SEMVER_RE);
  return match?.[1];
}

function platformPackageName(): string {
  const { platform, arch } = process;
  if (platform === 'linux' && arch === 'x64') return '@anthropic-ai/claude-agent-sdk-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return '@anthropic-ai/claude-agent-sdk-linux-arm64';
  if (platform === 'darwin' && arch === 'arm64') return '@anthropic-ai/claude-agent-sdk-darwin-arm64';
  if (platform === 'darwin' && arch === 'x64') return '@anthropic-ai/claude-agent-sdk-darwin-x64';
  if (platform === 'win32' && arch === 'x64') return '@anthropic-ai/claude-agent-sdk-win32-x64';
  return '';
}

function resolveBundledExecutable(): string | undefined {
  const pkg = platformPackageName();
  if (!pkg) return undefined;
  const pin = loadClaudeAgentSdkPin();
  try {
    const require = createRequire(import.meta.url);
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const candidate = join(dirname(pkgJsonPath), binName);
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash('sha256').update(buf).digest('hex');
}

export type ClaudeVersionSpawnFn = (
  executable: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

function defaultVersionSpawn(executable: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
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

/**
 * Verify pinned SDK package presence and bundled CLI identity. No query(), no credentials.
 */
export async function probeClaudeSdkIntegrity(options?: {
  spawnFn?: ClaudeVersionSpawnFn;
}): Promise<ClaudeSdkIntegrityProbe> {
  const pin = loadClaudeAgentSdkPin();
  const require = createRequire(import.meta.url);
  let sdkVersion: string | undefined;
  try {
    const sdkPkg = require.resolve(`${pin.sdkPackage}/package.json`);
    const sdkJson = JSON.parse(readFileSync(sdkPkg, 'utf8')) as { version?: string };
    sdkVersion = sdkJson.version;
  } catch {
    return { state: 'missing', detail: 'claude-agent-sdk package not installed' };
  }
  if (sdkVersion !== pin.sdkVersion) {
    return {
      state: 'unverified',
      ...(sdkVersion ? { sdkVersion } : {}),
      detail: `Expected SDK ${pin.sdkVersion}, found ${sdkVersion ?? 'unknown'}`,
    };
  }

  const executable = resolveBundledExecutable();
  if (!executable) {
    return { state: 'missing', sdkVersion, detail: 'Platform CLI binary package not installed' };
  }

  const spawnFn = options?.spawnFn ?? defaultVersionSpawn;
  try {
    const outcome = await spawnFn(executable);
    const cliVersion = parseCliVersion(outcome.stdout, outcome.stderr);
    if (outcome.exitCode !== 0 || !cliVersion) {
      return {
        state: 'unverified',
        sdkVersion,
        executablePath: executable,
        detail: 'CLI --version failed',
      };
    }
    if (cliVersion !== pin.cliVersion) {
      return {
        state: 'unverified',
        sdkVersion,
        cliVersion,
        executablePath: executable,
        detail: `Expected CLI ${pin.cliVersion}, found ${cliVersion}`,
      };
    }
    const digest = sha256File(executable);
    void digest;
    return {
      state: 'verified',
      sdkVersion,
      cliVersion,
      executablePath: executable,
    };
  } catch (error) {
    return {
      state: 'unverified',
      sdkVersion,
      executablePath: executable,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
