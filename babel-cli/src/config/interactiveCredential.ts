import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';
import { once } from 'node:events';
import { listProviderSpecs } from '../runners/providerRegistry.js';
import { resolvePrivateCredentialEnvPath } from './envBootstrap.js';
import { appendPrivateCredential, isValidProviderKey } from './providerAccountKeys.js';

export interface InteractiveCredentialOptions {
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void; isRaw?: boolean };
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
  if (!isValidProviderKey(key)) {
    outStream.write('Credential was not saved: invalid token format.\n');
    return;
  }
  try {
    appendPrivateCredential(target, name, key);
    env[name] = key;
  } catch {
    outStream.write('Credential was not saved. Check your private credential file and try again.\n');
    return;
  }
  outStream.write('Credential saved to your private Babel profile.\n');
}
