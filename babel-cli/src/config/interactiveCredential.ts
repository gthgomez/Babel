import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listProviderSpecs } from '../runners/providerRegistry.js';
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js';

function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY && process.env['CI'] !== 'true' && process.env['CI'] !== '1');
}

function isMachineOutput(argv: string[]): boolean {
  return argv.includes('--json') || argv.some(arg => /^--output-format=(?:json|stream-json|jsonl|ndjson)$/.test(arg));
}

function safeApiKey(key: string): boolean {
  return key.length >= 8 && key.length <= 4096 && /^[A-Za-z0-9_./:+==-]+$/.test(key);
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

/**
 * When a human runs an interactive CLI command and a certified provider credential
 * is missing, offer a masked setup flow. Noninteractive invocations fail closed.
 */
export async function maybePromptForMissingProviderCredential(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv,
): Promise<void> {
  if (!isInteractive() || isMachineOutput(argv)) return;
  const missing = listProviderSpecs()
    .filter(spec => spec.authorityConformance === 'certified' && spec.credentialEnvVar)
    .map(spec => spec.credentialEnvVar!)
    .filter(name => !env[name]);
  if (missing.length === 0) return;
  const target = resolvePrivateCredentialEnvPath(env);
  output.write('\nBabel needs a provider credential for live model calls.\n');
  output.write(`Supported variables: ${missing.join(', ')}\n`);
  output.write(`Credentials are saved to your private profile: ${target}\n`);
  const rl = createInterface({ input, output, terminal: true });
  try {
    output.write('Provider env variable to set (blank to skip): ');
    const name = (await rl.question('')).trim();
    if (!name || !missing.includes(name)) {
      output.write('Credential setup skipped.\n');
      return;
    }
    output.write('Paste API key: ');
    const key = (await rl.question('')).trim();
    output.write('\n');
    if (!safeApiKey(key)) {
      output.write('Credential was not saved: invalid token format.\n');
      return;
    }
    appendCredential(resolve(target), name, key);
    env[name] = key;
    output.write('Credential saved to your private Babel profile.\n');
  } finally {
    rl.close();
  }
}
