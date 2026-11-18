import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createShellHost } from './shellHost.js';
import type { ShellFrameRenderer } from './shellFrameRenderer.js';
import type { ShellFrameInput } from './shellTypes.js';
import {
  capturesShellCommandOutput,
  publishShellCommandOutput,
} from './shellCommandOutput.js';

function countingRenderer(): { renderer: ShellFrameRenderer; renders: () => number } {
  let renders = 0;
  return {
    renderer: {
      render: () => {
        renders += 1;
        return { rows: [], changedRows: [], wroteFrame: true };
      },
      invalidate: () => {},
      committedRows: () => null,
      displayWidthOfRow: () => 0,
    },
    renders: () => renders,
  };
}

describe('shellCommandOutput', () => {
  it('publishes captured output and repaints without a following keypress', () => {
    const { renderer, renders } = countingRenderer();
    let scheduled: (() => void) | null = null;
    const host = createShellHost({
      componentId: 'w10-command-output',
      frameSource: () => ({}) as ShellFrameInput,
      frameRenderer: renderer,
      scheduler: {
        register: (_id, callback) => {
          scheduled = callback;
          return () => {
            scheduled = null;
          };
        },
        request: () => scheduled?.(),
      },
      output: {
        beginFrame: () => {},
        endFrame: () => {},
        write: () => {},
        moveCursor: () => {},
        setCursorVisibility: () => {},
      },
    });
    const notices: string[] = [];
    host.mount();
    assert.equal(renders(), 1, 'mount paints once');

    // The capture window holds repaints so the frame cannot overwrite output
    // mid-command; invalidate alone is a no-op while the hold is active.
    host.holdRepaint();
    host.invalidate('command-output');
    assert.equal(renders(), 1, 'a held host ignores invalidate');

    publishShellCommandOutput({ appendNotice: (text) => notices.push(text) }, host, 'Session State');
    assert.deepEqual(notices, ['Session State']);
    assert.equal(renders(), 2, 'captured output paints immediately, before any keypress');
    assert.equal(host.releaseRepaintHold(), false, 'the publish released the hold');
  });

  it('releases the hold before invalidating', () => {
    const calls: string[] = [];
    publishShellCommandOutput(
      { appendNotice: () => calls.push('notice') },
      {
        releaseRepaintHold: () => {
          calls.push('release');
          return true;
        },
        invalidate: () => calls.push('invalidate'),
      },
      'output',
    );
    assert.deepEqual(calls, ['notice', 'release', 'invalidate']);
  });

  it('tolerates a runtime without a host and a host without a runtime', () => {
    const calls: string[] = [];
    publishShellCommandOutput(undefined, { invalidate: () => calls.push('invalidate') }, 'x');
    assert.deepEqual(calls, ['invalidate']);
    publishShellCommandOutput({ appendNotice: () => calls.push('notice') }, undefined, 'x');
    assert.deepEqual(calls, ['invalidate', 'notice']);
  });

  it('only claims print-only slash commands', () => {
    for (const command of [
      'status',
      'help',
      'cost',
      'stats',
      'permissions',
      'runs',
      'chain',
      'agents',
      'target',
      'evidence',
      'thinking',
    ]) {
      assert.equal(capturesShellCommandOutput(command), true, command);
    }
    // `model`, `m` and `provider` open interactive pickers; capturing them
    // would hide the picker and stall the session.
    for (const command of ['model', 'm', 'provider', 'scrollback', 'theme', 'palette', 'keymap', 'setup', 'diff', 'exit']) {
      assert.equal(capturesShellCommandOutput(command), false, command);
    }
  });
});
