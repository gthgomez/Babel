import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
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
  const secret = 'sk-or-test-NEVER-PRINT-MASKED-INPUT';

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


function requireSettlement<T>(read: Promise<T>): Promise<T> {
  return Promise.race([read, delay(300).then(() => { throw new Error('Masked prompt did not settle') })])
}

test('masked key input consumes successive chunks before Enter without echoing them', async () => {
  const terminal = new VirtualTerminal({ isTTY: true })
  const read = readMaskedLine(terminal.stdin, terminal.stderr)
  const parts = ['synthetic-', 'masked-input-canary']
  await terminal.waitForOutput('Paste API key (masked):', 2000)
  const running = requireSettlement(read)
  for (const chunk of [...parts, '\r']) terminal.stdin.emit('data', Buffer.from(chunk))
  assert.equal(await running === parts.join(''), true, 'The masked reader lost part of the fixture key')
  assert.equal(parts.some(part => terminal.getRawOutput().includes(part)), false)
  assert.equal(terminal.isRaw, false)
})

for (const end of ['Ctrl+D', 'EOF', 'close'] as const) {
  test(`masked key entry cancels on ${end} and releases terminal ownership`, async () => {
    const terminal = new VirtualTerminal({ isTTY: true })
    const stream = terminal.stdin
    const read = readMaskedLine(stream, terminal.stderr)
    await terminal.waitForOutput('Paste API key (masked):', 2000)
    const settled = assert.rejects(requireSettlement(read), /Credential setup cancelled/)
    terminal.sendInput('synthetic-interrupted-input')
    if (end === 'Ctrl+D') terminal.sendInput('\x04')
    else if (end === 'EOF') stream.push(null)
    else stream.destroy()
    await settled
    assert.equal(terminal.isRaw, false)
    assert.equal(stream.listenerCount('data'), 0)
    assert.equal(terminal.getRawOutput().includes('synthetic-interrupted-input'), false)
  })
}
