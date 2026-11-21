import assert from 'node:assert/strict';
import test from 'node:test';

import { renderErrorBox } from './rendererSupport.js';
import { stripAnsi } from './theme.js';

test('renderErrorBox survives a 44-column terminal', () => {
  // UX-02 regression: a wrapped message of exactly width-4 cells made the pad
  // arithmetic negative, so `.repeat(-1)` threw "Invalid count value: -1" and
  // the whole 44x16 session failed instead of printing an error.
  const message = 'The provider request failed after several attempts because the upstream host closed the connection unexpectedly.';
  const lines = renderErrorBox(message, undefined, 44);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.doesNotMatch(line, /Invalid count value/);
  }
  const text = stripAnsi(lines.join('\n'));
  assert.match(text, /Error/);
  assert.match(text, /upstream/);
});

test('renderErrorBox tolerates very narrow widths and exit codes', () => {
  for (const width of [1, 5, 11, 20, 30]) {
    assert.doesNotThrow(() => renderErrorBox('boom', { exitCode: 127, stderr: 'stderr text' }, width));
  }
  const lines = renderErrorBox('Command failed with exit code 127', { exitCode: 127 }, 30);
  assert.match(stripAnsi(lines.join('\n')), /Exit code:.*127/);
});
