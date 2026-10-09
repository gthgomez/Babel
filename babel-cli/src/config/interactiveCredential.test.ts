import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { maybePromptForMissingProviderCredential, readMaskedLine } from './interactiveCredential.js';
import { VirtualTerminal } from '../interactive/testing/ptyHarness.js';

test('maybePromptForMissingProviderCredential is a no-op for machine output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-interactive-cred-'));
  const env: NodeJS.ProcessEnv = {
    BABEL_CONFIG_DIR: join(root, 'config'),
    OPENROUTER_API_KEY: '',
  };
  delete env.OPENROUTER_API_KEY;
  await maybePromptForMissingProviderCredential(env, ['node', 'babel', 'run', 'hello', '--json']);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  rmSync(root, { recursive: true, force: true });
});

test('interactive credential entry masks API key and restores terminal mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-interactive-cred-'));
  const env: NodeJS.ProcessEnv = {
    BABEL_CONFIG_DIR: join(root, 'config'),
    CI: '0',
  };
  const term = new VirtualTerminal({ isTTY: true });
  const secret = 'sk-or-v1-synthetic-test-key-never-echo-me-9876543210';

  const promptPromise = maybePromptForMissingProviderCredential(env, ['node', 'babel', 'run', 'hello'], {
    input: term.stdin,
    output: term.stderr,
  });

  // Wait for the variable prompt, then answer OPENROUTER_API_KEY
  await term.waitForOutput('Provider env variable to set', 2000);
  term.sendLine('OPENROUTER_API_KEY');

  // Wait for masked key prompt, then paste synthetic key
  await term.waitForOutput('Paste API key (masked):', 2000);
  term.sendLine(secret);

  await promptPromise;

  // The credential must be set in env
  assert.equal(env['OPENROUTER_API_KEY'], secret);

  // The raw output must NOT contain the secret API key anywhere
  const rawOutput = term.getRawOutput();
  assert.equal(rawOutput.includes(secret), false, 'Synthetic API key was echoed to terminal output!');

  // Terminal mode must be restored to not raw
  assert.equal(term.isRaw, false, 'Terminal was left in raw mode!');

  rmSync(root, { recursive: true, force: true });
});

test('readMaskedLine restores terminal mode on Ctrl+C cancellation', async () => {
  const term = new VirtualTerminal({ isTTY: true });
  const readPromise = readMaskedLine(term.stdin, term.stderr);

  await term.waitForOutput('Paste API key (masked):', 2000);
  assert.equal(term.isRaw, true);

  term.sendCtrlC();

  await assert.rejects(readPromise, /Credential setup cancelled/);
  assert.equal(term.isRaw, false, 'Terminal raw mode was not restored after cancellation!');
});

