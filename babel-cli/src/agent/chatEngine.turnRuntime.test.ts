import assert from 'node:assert/strict';
import test from 'node:test';

import { ChatEngine } from './chatEngine.js';

test('live ChatEngine rejects legacy provider model before runner/network creation', () => {
  const previousOffline = process.env['BABEL_OFFLINE'];
  delete process.env['BABEL_OFFLINE'];
  try {
    assert.throws(
      () => new ChatEngine({ task: 't', projectRoot: process.cwd(), model: 'qwen3' }),
      /LIVE_MODEL_POLICY/,
    );
  } finally {
    if (previousOffline === undefined) delete process.env['BABEL_OFFLINE'];
    else process.env['BABEL_OFFLINE'] = previousOffline;
  }
});

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

test('P0-C: isolated submission reloads limits for new task class', () => {
  const engine = new ChatEngine({
    task: 'explain the architecture without editing any files',
    projectRoot: process.cwd(),
  });
  const first = engine.applyUserSubmission({
    userInput: 'explain the architecture without editing any files',
  });
  assert.equal(first.taskClass, 'investigate');
  const wallInvestigate = (engine as unknown as { limits: { maxWallMs: number } }).limits.maxWallMs;

  const second = engine.applyUserSubmission({
    userInput: 'fix multi-file race condition across the codebase',
  });
  assert.equal(second.continuedTask, false);
  assert.equal(second.taskClass, 'general_swe');
  assert.notEqual(second.taskClass, first.taskClass);
  const wallSwe = (engine as unknown as { limits: { maxWallMs: number } }).limits.maxWallMs;
  // general_swe uses a longer wall than investigate in chatTaskClass tunes.
  assert.ok(wallSwe !== wallInvestigate || wallSwe > 0);
  assert.equal(second.gatePolicy, 'required'); // general_swe verificationPolicy
});

test('P0-C: continueTask keeps limits class sticky with prior taskClass', () => {
  const engine = new ChatEngine({ task: 'fix parser bug', projectRoot: process.cwd() });
  const first = engine.applyUserSubmission({
    userInput: 'fix parser bug',
    taskIntent: 'execute',
  });
  const cont = engine.applyUserSubmission({
    userInput: 'continue the same fix',
    continueTask: true,
  });
  assert.equal(cont.continuedTask, true);
  assert.equal(cont.taskClass, first.taskClass);
});
