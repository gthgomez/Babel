import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';

test('ChatEngine.assignRunId sets engine run id', () => {
  const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
  engine.assignRunId('chat-fixed-id');
  assert.equal(engine.getEngineRunId(), 'chat-fixed-id');
});

test('ChatEngine.replaceConversation replaces messages', () => {
  const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
  engine.replaceConversation([{ role: 'user', content: 'hello' }]);
  assert.equal(engine.getConversation().length, 1);
});

test('ChatEngine.resyncTurnStateAfterBranch resets token counter', () => {
  const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
  (engine as unknown as { apiTokenCount: number }).apiTokenCount = 99;
  engine.resyncTurnStateAfterBranch();
  assert.equal((engine as unknown as { apiTokenCount: number }).apiTokenCount, 0);
});