// License: Apache-2.0
// The pinned image matches babel-desktop/native/sandbox-setup.mjs RECOMMENDED_IMAGE.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js';
import { probeInstalledSandboxImage } from './installedSandbox.js';
import { dockerCheckMessage, sandboxImageGuidance } from '../cli/firstRunText.js';
import { CLI_COMMAND } from '../cli/commandName.js';

export const RECOMMENDED_SANDBOX_IMAGE = 'docker.io/library/node:24-bookworm@sha256:9af606de2e947cfb3f276633b7c5130c4cd22365aa10f5a647b7675d5cfce0c0';
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const DOCKER_ENV_KEYS = ['PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'] as const;

export interface DockerRunResult { status: number | null; stdout?: string }
export type DockerExecute = (args: string[], timeout: number, env: NodeJS.ProcessEnv) => DockerRunResult;

export interface SandboxPrepareResult {
  status: 'ready' | 'prepared' | 'fail';
  message: string;
  envFile: string;
  pulled: boolean;
}

function dockerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of DOCKER_ENV_KEYS) if (source[name] !== undefined) env[name] = source[name];
  return env;
}

function defaultExecute(): DockerExecute {
  return (args, timeout, env) => {
    const result = spawnSync('docker', args, {
      timeout, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 256 * 1024, env,
    });
    return { status: result.status, stdout: typeof result.stdout === 'string' ? result.stdout : '' };
  };
}

/** Store only a verified image digest. Existing credential lines are preserved and never logged. */
export function writeSandboxImageId(envFile: string, imageId: string): void {
  if (!IMAGE_ID.test(imageId)) throw new Error('Refusing to store a sandbox image id that is not a sha256 digest.');
  const name = 'BABEL_BENCHMARK_DOCKER_IMAGE';
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  let existing = '';
  if (existsSync(envFile)) {
    const info = lstatSync(envFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Existing private config file is unsafe to update.');
    existing = readFileSync(envFile, 'utf8');
  }
  const line = `${name}=${imageId}`;
  const has = new RegExp(`^[ \\t]*${name}=`, 'm').test(existing);
  const next = has
    ? existing.replace(new RegExp(`^[ \\t]*${name}=.*$`, 'gm'), line)
    : `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
  const temp = `${envFile}.${randomUUID()}.tmp`;
  writeFileSync(temp, next, { flag: 'wx', mode: 0o600 });
  renameSync(temp, envFile);
  if (process.platform !== 'win32') chmodSync(envFile, 0o600);
}

/**
 * Download the pinned sandbox image when the current one is missing or unusable.
 * A working image is left unchanged. Credential values are not read or printed.
 */
export function prepareRecommendedSandbox(options: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  envFile?: string;
  execute?: DockerExecute;
  probe?: (image: string, env: NodeJS.ProcessEnv) => boolean;
} = {}): SandboxPrepareResult {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const envFile = options.envFile ?? resolvePrivateCredentialEnvPath(env);
  const narrowed = dockerEnv(env);
  const execute = options.execute ?? defaultExecute();
  const probe = options.probe ?? ((image: string) => probeInstalledSandboxImage(image, {
    env,
    execute: (_binary, args, settings) => execute(args, settings.timeout, narrowed),
  }));
  const current = env['BABEL_BENCHMARK_DOCKER_IMAGE']?.trim() ?? '';
  if (current && probe(current, narrowed)) {
    return {
      status: 'ready',
      pulled: false,
      envFile,
      message: `A sandbox image is already configured and passed the shell and Git check. It was left unchanged. Next: ${CLI_COMMAND} doctor`,
    };
  }
  const info = execute(['info', '--format', '{{.ServerVersion}}'], 3000, narrowed);
  if (info.status !== 0) {
    return { status: 'fail', pulled: false, envFile, message: dockerCheckMessage(false, platform) };
  }
  const pull = execute(['pull', '--platform=linux/amd64', RECOMMENDED_SANDBOX_IMAGE], 300_000, narrowed);
  if (pull.status !== 0) {
    return {
      status: 'fail',
      pulled: false,
      envFile,
      message: `Docker could not download the sandbox image. ${sandboxImageGuidance(platform)}`,
    };
  }
  const inspected = execute(['image', 'inspect', '--format', '{{json .}}', '--', RECOMMENDED_SANDBOX_IMAGE], 5000, narrowed);
  let imageId = '';
  try {
    const record = JSON.parse(String(inspected.stdout ?? '')) as { Id?: unknown };
    if (typeof record.Id === 'string') imageId = record.Id;
  } catch { imageId = ''; }
  if (inspected.status !== 0 || !IMAGE_ID.test(imageId) || !probe(imageId, narrowed)) {
    return {
      status: 'fail',
      pulled: true,
      envFile,
      message: 'The downloaded image did not pass the Linux amd64 shell and Git check, so it was not saved. Include a shell and Git in the image your project commands use.',
    };
  }
  try { writeSandboxImageId(envFile, imageId); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'The private config file could not be updated.';
    return { status: 'fail', pulled: true, envFile, message: reason };
  }
  return {
    status: 'prepared',
    pulled: true,
    envFile,
    message: `Sandbox image saved for this user in ${envFile} as BABEL_BENCHMARK_DOCKER_IMAGE. The file keeps owner-only permissions on macOS and Linux. Credential values were not printed. Next: ${CLI_COMMAND} doctor`,
  };
}
