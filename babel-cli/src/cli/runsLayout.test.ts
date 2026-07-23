import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chatSessionsDir, resolveBabelRunsDir, transcriptPath } from './runsLayout.js';

test('transcriptPath honours runtime BABEL_RUNS_DIR override', () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-runs-layout-'));
  const prev = process.env['BABEL_RUNS_DIR'];
  process.env['BABEL_RUNS_DIR'] = root;
  try {
    assert.equal(resolveBabelRunsDir(), root);
    assert.equal(transcriptPath('chat-abc'), join(root, 'chat-sessions', 'chat-abc', 'transcript.jsonl'));
    assert.equal(chatSessionsDir(), join(root, 'chat-sessions'));
  } finally {
    if (prev === undefined) delete process.env['BABEL_RUNS_DIR'];
    else process.env['BABEL_RUNS_DIR'] = prev;
    rmSync(root, { recursive: true, force: true });
  }
});