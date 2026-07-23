import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  registerReadlineInterface,
  stdinCoordinatorPauseForRun,
  stdinCoordinatorResumeAfterRun,
  stdinCoordinatorRunDepth,
} from './inputCoordinator.js';
import { DEC_2026_END } from './terminalEscapeSequences.js';

function mockReadline(): {
  rl: { pause: () => void; resume: () => void };
  isPaused: () => boolean;
} {
  let paused = false;
  const rl = {
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
  };
  return { rl, isPaused: () => paused };
}

test('stdin coordinator reference-counts readline pause and resume', () => {
  const mock = mockReadline();
  registerReadlineInterface(mock.rl as never);

  stdinCoordinatorPauseForRun(mock.rl as never);
  assert.equal(mock.isPaused(), true);
  assert.equal(stdinCoordinatorRunDepth(), 1);

  stdinCoordinatorPauseForRun(mock.rl as never);
  assert.equal(stdinCoordinatorRunDepth(), 2);

  stdinCoordinatorResumeAfterRun(mock.rl as never);
  assert.equal(mock.isPaused(), true);
  assert.equal(stdinCoordinatorRunDepth(), 1);

  stdinCoordinatorResumeAfterRun(mock.rl as never);
  assert.equal(mock.isPaused(), false);
  assert.equal(stdinCoordinatorRunDepth(), 0);
});

test('withPausedStdin no-ops when no readline is registered', async () => {
  const { withPausedStdin } = await import('./inputCoordinator.js');
  const prior = mockReadline();
  registerReadlineInterface(prior.rl as never);
  // Explicit null argument exercises the no-registered-rl branch
  const result = await withPausedStdin(async () => 'ok-no-rl', null);
  assert.equal(result, 'ok-no-rl');
  // Prior registration unchanged (null arg does not pause)
  assert.equal(prior.isPaused(), false);
});

test('withPausedStdin pauses and resumes a registered readline', async () => {
  const { withPausedStdin } = await import('./inputCoordinator.js');
  const mock = mockReadline();
  registerReadlineInterface(mock.rl as never);

  let sawPaused = false;
  const result = await withPausedStdin(async () => {
    sawPaused = mock.isPaused();
    return 42;
  }, mock.rl as never);

  assert.equal(result, 42);
  assert.equal(sawPaused, true);
  assert.equal(mock.isPaused(), false);
});

test('drainStdinResiduals is safe to call when stdin has no buffered data', async () => {
  const { drainStdinResiduals } = await import('./inputCoordinator.js');
  // Must not throw even when stdin is not a TTY / has nothing to read
  drainStdinResiduals();
});

test('withRawStdinPrompt restores prior raw mode when stdin is not a TTY', async () => {
  const { withRawStdinPrompt } = await import('./inputCoordinator.js');
  const result = await withRawStdinPrompt(async () => 'ok');
  assert.equal(result, 'ok');
});

test('InputCoordinator buffers stdout and caps at 64KB with warning', async () => {
  const { InputCoordinator } = await import('./inputCoordinator.js');
  const coordinator = InputCoordinator.getInstance();
  coordinator.startBuffering();

  process.stdout.write('hello');

  const hugeChunk = 'x'.repeat(100 * 1024);
  process.stdout.write(hugeChunk);

  const flushed = coordinator.stopBuffering();
  assert.ok(flushed.includes('STDOUT BUFFER TRUNCATED'));
  assert.ok(Buffer.byteLength(flushed, 'utf8') <= 64 * 1024 + 1024);
});

test('emergencyRestore() writes DEC 2026 END before restoring stdout.write', async () => {
  const { InputCoordinator } = await import('./inputCoordinator.js');

  // Capture raw stdout writes during emergencyRestore
  const writes: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
    const str = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    writes.push(str);
    return true;
  });

  try {
    const coordinator = InputCoordinator.getInstance();
    coordinator.emergencyRestore();

    // DEC 2026 END must appear in the raw stdout writes
    assert.ok(
      writes.some((w) => w === DEC_2026_END),
      `emergencyRestore() must write DEC 2026 END (\\x1b[?2026l). Got writes: ${JSON.stringify(writes)}`,
    );
  } finally {
    mock.restoreAll();
  }
});
