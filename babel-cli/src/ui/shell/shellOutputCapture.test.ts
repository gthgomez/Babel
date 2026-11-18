import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { beginShellOutputCapture } from './shellOutputCapture.js';
import { capturesShellCommandOutput } from './shellCommandOutput.js';

describe('shellOutputCapture', () => {
  it('captures stdout and restores the previous writer', () => {
    const original = process.stdout.write;
    const capture = beginShellOutputCapture();
    process.stdout.write('Session State:\n');
    console.log('Mode       work');
    const captured = capture.stop();

    assert.equal(process.stdout.write, original, 'writer restored');
    assert.match(captured, /Session State:\n/);
    assert.match(captured, /Mode\s+work/);
  });

  it('stops capturing once stopped and is safe to stop twice', () => {
    const original = process.stdout.write;
    const capture = beginShellOutputCapture();
    process.stdout.write('first\n');
    assert.equal(capture.stop(), 'first\n');
    assert.equal(capture.stop(), 'first\n');
    assert.equal(process.stdout.write, original);
  });

  it('only captures print-only slash commands', () => {
    for (const command of ['status', 'help', 'cost', 'stats', 'permissions', 'runs', 'chain', 'agents', 'target', 'evidence', 'thinking']) {
      assert.equal(capturesShellCommandOutput(command), true, command);
    }
    // Interactive pickers and terminal-owning commands stay uncaptured.
    for (const command of ['model', 'm', 'provider', 'scrollback', 'theme', 'palette', 'keymap', 'setup', 'diff', 'exit']) {
      assert.equal(capturesShellCommandOutput(command), false, command);
    }
  });
});
