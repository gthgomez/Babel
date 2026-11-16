import { stdin as input, stderr as output } from 'node:process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProviderSpec, isApprovedProductProvider } from '../runners/providerRegistry.js';
import { resolveEffectiveSettings } from './userSettings.js';
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js';
import { isOfflineRequested } from './offlineMode.js';
import { platformSharedCredentialStore } from './sharedCredentialStore.js';

export interface InteractiveCredentialOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
  /** False keeps the credential only in this process. */
  persist?: boolean;
  /** Explicit repair may replace an already-present process credential. */
  replaceExisting?: boolean;
  /** Resolve project-scoped preferences against the already selected target. */
  projectRoot?: string;
  /** A connection explicitly selected by this invocation takes precedence. */
  connectionId?: string;
}

function isInteractive(
  inStream: { isTTY?: boolean } = input,
  outStream: { isTTY?: boolean } = output,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(inStream.isTTY && outStream.isTTY && !['1', 'true'].includes(env['CI'] ?? '') && !['1', 'true'].includes(env['BABEL_HEADLESS'] ?? ''));
}

function isMachineOutput(argv: string[]): boolean {
  return argv.includes('--json') || argv.includes('--headless') || argv.some((arg, index) =>
    /^--output-format=(?:json|stream-json|jsonl|ndjson)$/.test(arg) ||
    (arg === '--output-format' && /^(?:json|stream-json|jsonl|ndjson)$/.test(argv[index + 1] ?? '')));
}

function safeApiKey(key: string): boolean {
  return key.length >= 8 && key.length <= 4096 && /^[A-Za-z0-9_./:+==-]+$/.test(key);
}

export async function readMaskedLine(
  inStream: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean } = input,
  outStream: NodeJS.WritableStream & { isTTY?: boolean } = output,
): Promise<string> {
  if (!inStream.isTTY) return '';
  outStream.write('Paste API key (masked): ');
  const canSetRaw = typeof inStream.setRawMode === 'function';
  const prevRaw = Boolean(inStream.isRaw);
  if (canSetRaw) {
    inStream.setRawMode!(true);
  }
  if (typeof (inStream as any).resume === 'function') {
    (inStream as any).resume();
  }
  if (typeof (inStream as any).setEncoding === 'function') {
    (inStream as any).setEncoding('utf8');
  }
  let value = '';
  try {
    while (true) {
      const [chunk] = (await once(inStream, 'data')) as [string | Buffer];
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          outStream.write('\n');
          return value;
        }
        if (char === '\u0003') {
          throw new Error('Credential setup cancelled.');
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    }
  } finally {
    if (canSetRaw) {
      try {
        inStream.setRawMode!(prevRaw);
      } catch {
        // Stream may have ended or closed
      }
    }
  }
}

function appendCredential(envFile: string, name: string, key: string): void {
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  let existing = '';
  if (existsSync(envFile)) {
    const info = lstatSync(envFile);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 256 * 1024) {
      throw new Error('Existing credential file is unsafe.');
    }
    existing = readFileSync(envFile, 'utf8');
    if (new RegExp(`(?:^|\\n)\\s*${name}\\s*=`, 'm').test(existing)) throw new Error('An existing credential entry was preserved. Update it explicitly before saving another key.');
  }
  const temp = `${envFile}.${randomUUID()}.tmp`;
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(temp, `${existing}${separator}${name}=${key}\n`, { flag: 'wx', mode: 0o600 });
  renameSync(temp, envFile);
}

/** Prompt only for the explicitly selected connection's credential. */
export async function promptForProviderCredential(name: string, env: NodeJS.ProcessEnv = process.env,
  options: InteractiveCredentialOptions = {}): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Invalid credential environment variable name.')
  if (env[name]?.trim() && options.replaceExisting !== true) return true
  const inStream = options.input ?? input
  const outStream = options.output ?? output
  if (!isInteractive(inStream, outStream, env)) return false
  const key = (await readMaskedLine(inStream, outStream)).trim()
  if (!safeApiKey(key)) throw new Error('Credential was not saved: invalid token format.')
  if (options.persist !== false) appendCredential(resolvePrivateCredentialEnvPath(env), name, key)
  env[name] = key
  outStream.write(options.persist === false ? 'Credential kept for this process only.\n' : 'Credential saved as plaintext in your private Babel profile.\n')
  return true
}

/** The key is sent directly to the OS store and never added to the environment. */
export async function promptForProtectedCredential(env: NodeJS.ProcessEnv = process.env, options: InteractiveCredentialOptions = {}): Promise<string | null> {
  const inStream = options.input ?? input;
  const outStream = options.output ?? output;
  if (!isInteractive(inStream, outStream, env)) return null;
  const key = (await readMaskedLine(inStream, outStream)).trim();
  if (!safeApiKey(key)) throw new Error('Credential was not saved: invalid token format.');
  const reference = platformSharedCredentialStore().save(key);
  outStream.write('Credential saved in OS-protected storage. Provider access is unverified.\n');
  return reference;
}

/**
 * When a human runs an interactive CLI command and a certified provider credential
 * is missing, offer a masked setup flow. Noninteractive invocations fail closed.
 */
export async function maybePromptForMissingProviderCredential(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
  options?: InteractiveCredentialOptions,
): Promise<void> {
  const inStream = options?.input ?? input;
  const outStream = options?.output ?? output;
  if (!isInteractive(inStream, outStream, env) || isMachineOutput(argv) || argv.includes('--offline') || isOfflineRequested(env)) return;
  const connection = resolveEffectiveSettings({ env, ...(options?.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options?.connectionId ? { invocation: { connection: options.connectionId } } : {}) }).connection.value;
  if (!connection || !isApprovedProductProvider(connection.provider)) return;
  if (connection.credentialRef) return; // Unlock only when the selected task starts.
  const spec = getProviderSpec(connection.provider);
  const name = connection.apiKeyEnvVar ?? spec.credentialEnvVar;
  if (!spec.requiresCredential || !name || env[name]?.trim()) return;
  outStream.write(`\nThe selected ${connection.provider} connection needs ${name}. The key will be kept only for this process.\n`);
  await promptForProviderCredential(name, env, { ...options, persist: false });
}
