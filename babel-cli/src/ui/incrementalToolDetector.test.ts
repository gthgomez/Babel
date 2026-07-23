import { test } from 'node:test';
import assert from 'node:assert';
import { Readable } from 'node:stream';
import {
  autoCloseJson,
  IncrementalToolDetector,
  JitDenialError,
} from './incrementalToolDetector.js';
import { captureRawKeypress } from './inputCoordinator.js';

test('autoCloseJson closes unclosed objects and strings', () => {
  assert.strictEqual(autoCloseJson('{"foo": "bar'), '{"foo": "bar"}');
  assert.strictEqual(autoCloseJson('{"foo": "ba\\'), '{"foo": "ba"}'); // Strips trailing backslash
  assert.strictEqual(autoCloseJson('{"foo": {"nested": [1, 2'), '{"foo": {"nested": [1, 2]}}');
});

test('IncrementalToolDetector detects tool intent inside fences', async () => {
  let detected: any = null;
  const detector = new IncrementalToolDetector(async (intent) => {
    detected = intent;
    return 'approve';
  });

  await detector.feed('Prose before fence.\n<|tool_start|>');
  await detector.feed('{"type": "tool_call", "tool": "file_read", "path": "src/index.ts"}');

  assert.ok(detected);
  assert.strictEqual(detected.tool, 'file_read');
  assert.strictEqual(detected.target, 'src/index.ts');

  await detector.feed('<|tool_end|>Prose after.');
});

test('IncrementalToolDetector throws JitDenialError when denied', async () => {
  const detector = new IncrementalToolDetector(async () => {
    return 'deny';
  });

  await detector.feed('<|tool_start|>');
  await assert.rejects(
    () => detector.feed('{"type": "tool_call", "tool": "shell_exec", "command": "npm test"}'),
    JitDenialError,
  );
});

test('IncrementalToolDetector split-payload property test', async () => {
  const payload =
    '<|tool_start|>{"type": "tool_call", "tool": "file_write", "path": "src/app.ts", "content": "const x = \\"hello\\\\\\"world\\"", "nested": [1, 2, [3, 4]]}<|tool_end|>';

  for (let splitIdx = 1; splitIdx < payload.length; splitIdx++) {
    let detected: any = null;
    const detector = new IncrementalToolDetector(async (intent) => {
      detected = intent;
      return 'approve';
    });

    const chunk1 = payload.slice(0, splitIdx);
    const chunk2 = payload.slice(splitIdx);

    try {
      await detector.feed(chunk1);
      await detector.feed(chunk2);
    } catch (err) {
      // Ignore intermediate timeout or formatting errors
    }

    assert.ok(detected, `Failed to detect tool intent when split at index ${splitIdx}`);
    assert.strictEqual(detected.tool, 'file_write');
    assert.strictEqual(detected.target, 'src/app.ts');
  }
});

test('captureRawKeypress fallback in non-TTY mode', async () => {
  const originalEnv = process.env['BABEL_TEST_FORCE_NON_TTY'];
  process.env['BABEL_TEST_FORCE_NON_TTY'] = 'true';

  const stdinMock = new Readable({
    read() {},
  });
  const originalStdin = process.stdin;
  Object.defineProperty(process, 'stdin', {
    value: stdinMock,
    configurable: true,
  });

  try {
    const promise = captureRawKeypress('Allow? [y/N]: ');

    // Simulate user typing 'y\n'
    stdinMock.push('y\n');
    stdinMock.push(null);

    const result = await promise;
    assert.strictEqual(result, true);
  } finally {
    Object.defineProperty(process, 'stdin', {
      value: originalStdin,
      configurable: true,
    });
    if (originalEnv !== undefined) {
      process.env['BABEL_TEST_FORCE_NON_TTY'] = originalEnv;
    } else {
      delete process.env['BABEL_TEST_FORCE_NON_TTY'];
    }
  }
});
