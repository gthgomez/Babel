import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';

test('applyUserSubmission isolates writeCount so prior task cannot satisfy later gate', () => {
  const engine = new ChatEngine({ task: 'fix parser', projectRoot: process.cwd() });
  engine.applyUserSubmission({ userInput: 'fix parser' });
  (engine as unknown as { writeCount: number }).writeCount = 7;
  (engine as unknown as { gateStrikes: number }).gateStrikes = 2;

  const next = engine.applyUserSubmission({
    userInput: 'document the public API in README only',
  });

  assert.equal(next.continuedTask, false);
  assert.equal(engine.getWriteCount(), 0);
  assert.equal(next.writeCount, 0);
  assert.equal(next.gateStrikes, 0);
  assert.equal(next.submissionIndex, 2);
  assert.ok(next.taskText.includes('README'));
});

test('applyUserSubmission continueTask preserves sticky counters and intent', () => {
  const engine = new ChatEngine({ task: 'implement feature', projectRoot: process.cwd() });
  engine.applyUserSubmission({ userInput: 'implement feature', taskIntent: 'execute' });
  (engine as unknown as { writeCount: number }).writeCount = 3;

  const cont = engine.applyUserSubmission({
    userInput: 'continue with the same change',
    continueTask: true,
  });

  assert.equal(cont.continuedTask, true);
  assert.equal(engine.getWriteCount(), 3);
  assert.equal(cont.taskIntent, 'execute');
  assert.equal(cont.stickyIntent, 'execute');
  assert.equal(cont.submissionIndex, 2);
});

test('getTurnRuntimeSnapshot reflects live writeCount after mutation', () => {
  const engine = new ChatEngine({ task: 't', projectRoot: process.cwd(), model: 'deepseek-v4-flash' });
  engine.applyUserSubmission({ userInput: 't' });
  (engine as unknown as { writeCount: number }).writeCount = 2;
  const snap = engine.getTurnRuntimeSnapshot();
  assert.ok(snap);
  assert.equal(snap!.writeCount, 2);
  assert.equal(snap!.model, 'deepseek-v4-flash');
  assert.equal(snap!.projectRoot, process.cwd());
});

test('resyncTurnStateAfterBranch zeros writeCount on runtime snapshot', () => {
  const engine = new ChatEngine({ task: 't', projectRoot: process.cwd() });
  engine.applyUserSubmission({ userInput: 't' });
  (engine as unknown as { writeCount: number }).writeCount = 4;
  engine.resyncTurnStateAfterBranch();
  assert.equal(engine.getWriteCount(), 0);
  assert.equal(engine.getTurnRuntimeSnapshot()?.writeCount, 0);
});
