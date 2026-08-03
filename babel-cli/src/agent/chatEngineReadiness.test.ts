import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';

test('ChatEngine blocks the first provider request when readiness is required but absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'babel-chat-readiness-'));
  const engine = new ChatEngine({
    task: 'fix the fixture',
    projectRoot: root,
    requireWorkspaceReadiness: true,
  });

  const events = [] as Array<{ type: string; error?: string }>;
  for await (const event of engine.submitMessageStream('fix the fixture', 'execute')) {
    if (event.type === 'failed') events.push(event);
  }

  assert.equal(events.length, 1);
  assert.match(events[0]!.error ?? '', /readiness.*receipt_missing/i);
});

