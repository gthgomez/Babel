import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listProviderSpecs } from '../runners/providerRegistry.js';
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js';

type CredentialInput = NodeJS.ReadableStream & {
  isTTY?: boolean
  isRaw?: boolean
  setRawMode?: (mode: boolean) => void
  readableEnded?: boolean
  destroyed?: boolean
}

export interface InteractiveCredentialOptions {
  input?: CredentialInput;
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

function isInteractive(
  inStream: { isTTY?: boolean } = input,
  outStream: { isTTY?: boolean } = output,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(inStream.isTTY && outStream.isTTY && env['CI'] !== 'true' && env['CI'] !== '1');
}

function isMachineOutput(argv: string[]): boolean {
  return argv.includes('--json') || argv.some(arg => /^--output-format=(?:json|stream-json|jsonl|ndjson)$/.test(arg));
}

function safeApiKey(key: string): boolean {
  return key.length >= 8 && key.length <= 4096 && /^[A-Za-z0-9_./:+==-]+$/.test(key);
}

/** Read one masked credential while holding terminal input through completion or cancellation. */
export async function readMaskedLine(
  inStream: CredentialInput = input,
  outStream: NodeJS.WritableStream & { isTTY?: boolean } = output,
): Promise<string> {
  if (!inStream.isTTY) return ''
  const wasRaw = Boolean(inStream.isRaw)
  const wasPaused = inStream.isPaused()
  let detach = (): void => {}
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = ''
      let settled = false
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const cancel = (): void => fail(new Error('Credential setup cancelled. Run setup again to retry.'))
      const onData = (chunk: Buffer | string): void => {
        if (settled) return
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') {
            settled = true
            outStream.write('\n')
            resolve(value)
            return
          }
          if (char === '\x03' || char === '\x04') {
            outStream.write('\n')
            cancel()
            return
          }
          value = char === '\x7f' || char === '\b' ? value.slice(0, -1) : value + char
        }
      }
      detach = () => {
        inStream.removeListener('data', onData)
        inStream.removeListener('end', cancel)
        inStream.removeListener('close', cancel)
        inStream.removeListener('error', fail)
      }
      if (inStream.readableEnded || inStream.destroyed) {
        cancel()
        return
      }
      inStream.setRawMode?.(true)
      inStream.on('end', cancel).on('close', cancel).on('error', fail).on('data', onData)
      outStream.write('Ctrl+C or Ctrl+D cancels key entry.\nPaste API key (masked): ')
      inStream.resume()
    })
  } finally {
    detach()
    if (wasPaused) inStream.pause()
    try {
      inStream.setRawMode?.(wasRaw)
    } catch {
      // The terminal may have closed before its original mode could be restored.
    }
  }
}

function appendCredential(envFile: string, name: string, key: string): void {
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  let existing = '';
  if (existsSync(envFile)) {
    const info = lstatSync(envFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) {
      throw new Error('Existing credential file is unsafe.');
    }
    existing = readFileSync(envFile, 'utf8');
    if (new RegExp(`(?:^|\\n)\\s*${name}\\s*=`, 'm').test(existing)) return;
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
  if (env[name]?.trim()) return true
  const inStream = options.input ?? input
  const outStream = options.output ?? output
  if (!isInteractive(inStream, outStream, env)) return false
  const key = (await readMaskedLine(inStream, outStream)).trim()
  if (!safeApiKey(key)) throw new Error('Credential was not saved: invalid token format.')
  appendCredential(resolvePrivateCredentialEnvPath(env), name, key)
  env[name] = key
  outStream.write('Credential saved to your private Babel profile.\n')
  return true
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
  if (!isInteractive(inStream, outStream, env) || isMachineOutput(argv)) return;
  const missing = listProviderSpecs()
    .filter(spec => spec.authorityConformance === 'certified' && spec.credentialEnvVar)
    .map(spec => spec.credentialEnvVar!)
    .filter(name => !env[name]);
  if (missing.length === 0) return;
  const target = resolvePrivateCredentialEnvPath(env);
  outStream.write('\nBabel needs a provider credential for live model calls.\n');
  outStream.write(`Supported variables: ${missing.join(', ')}\n`);
  outStream.write(`Credentials are saved to your private profile: ${target}\n`);
  let name = '';
  const rl = createInterface({ input: inStream, output: outStream, terminal: true });
  try {
    outStream.write('Provider env variable to set (blank to skip): ');
    name = (await rl.question('')).trim();
  } finally {
    rl.close();
  }
  if (!name || !missing.includes(name)) {
    outStream.write('Credential setup skipped.\n');
    return;
  }
  const key = (await readMaskedLine(inStream, outStream)).trim();
  if (!safeApiKey(key)) {
    outStream.write('Credential was not saved: invalid token format.\n');
    return;
  }
  appendCredential(resolve(target), name, key);
  env[name] = key;
  outStream.write('Credential saved to your private Babel profile.\n');
}
