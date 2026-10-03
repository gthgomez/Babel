import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chatStreamToRunEvent } from './chatStreamNdjson.js';

test('chat tool events keep their tool identity on the stream', () => {
  const started = chatStreamToRunEvent({
    type: 'tool_start',
    toolCallId: 'call-1',
    tool: 'file_read',
    target: 'src/app.ts',
  });
  assert.equal(started.type, 'tool.started');
  assert.deepEqual(started.item, { id: 'call-1', tool: 'file_read', target: 'src/app.ts' });

  const failed = chatStreamToRunEvent({
    type: 'tool_failed',
    tool: 'shell_exec',
    target: 'npm test',
    error: 'exit 1',
    exitCode: 1,
  });
  assert.equal(failed.type, 'tool.failed');
  assert.equal((failed.item as { exit_code?: number }).exit_code, 1);
});

test('file changes and answer text stay separate events', () => {
  const changed = chatStreamToRunEvent({
    type: 'file_changed',
    path: 'src/app.ts',
    additions: 3,
    deletions: 1,
  });
  assert.equal(changed.type, 'file.changed');
  assert.deepEqual(changed.item, { path: 'src/app.ts', additions: 3, deletions: 1 });
  assert.equal(chatStreamToRunEvent({ type: 'assistant_chunk', chunk: 'Done' }).type, 'assistant_chunk');
});
